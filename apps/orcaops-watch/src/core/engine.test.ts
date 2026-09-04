import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { clearCommonDirCache, commonConfigLocation, Repo } from '@orcaops/core';
import { openAllProjects, PROJECT_ID_CONFIG_KEY } from '@orcaops/project-scope';
import { ArtifactStore, getDefaultConfig, indexRoot, projectIndexMetaPath } from '@orcaops/storage';
import { createLinkedWorktree, createTempRepo } from '@orcaops/test-harness';

import { AgentActivityReader } from './agent-activity.js';
import { SnapshotEngine } from './engine.js';
import { FsWatch } from './fs-watch.js';
import { collectFromScope } from './snapshot.js';
import type { WatchSnapshot, WatchThread } from './types.js';
import { makeArchiveFixture, seedArtifact } from '../../tests/support/fixture-archive.js';

const ARTX = '01999999-9999-7000-8000-0000000000e0';
const ARTY = '01999999-9999-7000-8000-0000000000f0';
const PROJECT_A = '019fc200-0000-7000-8000-00000000aaa1';
const PROJECT_B = '019fc200-0000-7000-8000-00000000aaa2';
// Far future so the fixtures' real-wall-clock writes are deterministically old.
const NOW = Date.parse('2030-01-01T00:00:00.000Z');

function findAgent(s: WatchSnapshot, id: string): WatchThread | undefined {
  for (const p of s.projects) for (const a of p.threads) if (a.artifactId === id) return a;
  return undefined;
}

describe('SnapshotEngine', () => {
  it('observes the first capture made after starting from an empty personal worktree', async () => {
    clearCommonDirCache();
    const main = await createTempRepo({ initialBranch: 'main' });
    const linked = await createLinkedWorktree(main.path);
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-watch-empty-'));
    const config = getDefaultConfig();
    config.install.scope = 'personal';
    config.archive.enabled = false;
    let engine: SnapshotEngine | undefined;
    try {
      const shared = await commonConfigLocation(main.path);
      await mkdir(path.dirname(shared.configPath), { recursive: true });
      await writeFile(shared.configPath, JSON.stringify(config), 'utf8');
      await new Repo(main.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, PROJECT_A);

      const snapshots: WatchSnapshot[] = [];
      engine = new SnapshotEngine({
        cwd: linked.path,
        env: { ORCAOPS_DATA_DIR: dataRoot },
      });
      engine.on('snapshot', (snapshot: WatchSnapshot) => snapshots.push(snapshot));
      await engine.start();
      await expect(access(path.join(linked.path, '.orcaops'))).rejects.toThrow();
      expect(findAgent(snapshots.at(-1) as WatchSnapshot, ARTX)).toBeUndefined();

      const writer = new ArtifactStore({ repoRoot: linked.path, config });
      await seedArtifact(writer, { artifactId: ARTX });
      writer.close();
      await engine.tick(NOW);

      expect(findAgent(snapshots.at(-1) as WatchSnapshot, ARTX)).toBeDefined();
    } finally {
      engine?.close();
      await rm(dataRoot, { recursive: true, force: true });
      await linked.cleanup();
      await main.cleanup();
      clearCommonDirCache();
    }
  });

  it('retains one provider instance across ticks', async () => {
    const fx = await makeArchiveFixture();
    try {
      const project = await fx.unidentifiedRepo();
      await project.seed({
        artifactId: ARTX,
        sessions: [{ agent: 'codex', session_id: 'codex-session', tokens: 10 }],
      });
      const readLastActivity = vi.fn(async () => new Map<string, number>());
      const resolveSource = vi.fn((agent: string) => ({ agent, readLastActivity }));
      const activityReader = new AgentActivityReader({}, resolveSource);
      const engine = new SnapshotEngine({ cwd: project.repoPath, env: fx.env, activityReader });

      await engine.start();
      await engine.tick(NOW);

      expect(resolveSource).toHaveBeenCalledTimes(1);
      expect(readLastActivity).toHaveBeenCalledTimes(2);
      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('a tick re-collects + re-classifies after a new archived event; other artifacts are untouched', async () => {
    const fx = await makeArchiveFixture();
    try {
      const proj = await fx.archiveProject(PROJECT_A);
      await proj.seed({ artifactId: ARTX, stepCount: 3, closedSteps: 1, openCp: true });
      await proj.seed({ artifactId: ARTY, stepCount: 2, closedSteps: 1 });

      const engine = new SnapshotEngine({ cwd: fx.base, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (s: WatchSnapshot) => snapshots.push(s));

      await engine.start();
      await engine.tick(NOW);
      const before = findAgent(snapshots.at(-1) as WatchSnapshot, ARTX);
      expect(before?.openCheckpoints).toBe(1);
      // Open cp + a (far) old last write → stalled.
      expect(before?.state).toBe('stalled');
      const yBefore = findAgent(snapshots.at(-1) as WatchSnapshot, ARTY);
      expect(yBefore?.state).toBe('idle');

      // Close ARTX's open cp WITH uncertainty → the archive log grows.
      await proj.closeOpenCp(ARTX, { uncertainty: ['a lingering risk'] });
      await engine.tick(NOW);

      const after = findAgent(snapshots.at(-1) as WatchSnapshot, ARTX);
      expect(after?.openCheckpoints).toBe(0);
      // No open cp + still active + an uncertainty close → ready (age-independent).
      expect(after?.state).toBe('ready');
      // ARTY (untouched) is unchanged — only ARTX re-ingested.
      expect(findAgent(snapshots.at(-1) as WatchSnapshot, ARTY)?.state).toBe('idle');

      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('reopens the scope when a new archived project appears', async () => {
    const fx = await makeArchiveFixture();
    try {
      const a = await fx.archiveProject(PROJECT_A);
      await a.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });

      const engine = new SnapshotEngine({ cwd: fx.base, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (s: WatchSnapshot) => snapshots.push(s));

      await engine.start();
      expect((snapshots.at(-1) as WatchSnapshot).projects.map((p) => p.projectId)).toEqual([
        PROJECT_A,
      ]);

      const b = await fx.archiveProject(PROJECT_B);
      await b.seed({ artifactId: ARTY, stepCount: 2, closedSteps: 1 });
      await engine.tick(NOW);

      expect((snapshots.at(-1) as WatchSnapshot).projects.map((p) => p.projectId).sort()).toEqual([
        PROJECT_A,
        PROJECT_B,
      ]);

      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('discloses a hot projection that becomes incomplete between ticks', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJECT_A);
      await hot.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });
      const engine = new SnapshotEngine({ cwd: hot.repoPath, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (snapshot: WatchSnapshot) => snapshots.push(snapshot));
      await engine.start();
      expect((snapshots.at(-1) as WatchSnapshot).archiveIssues).toEqual([]);

      await rm(hot.hotEventsPath(ARTX));
      hot.store.store.setProjectionHealth('rebuild_pending');
      await engine.tick(NOW);

      const degraded = snapshots.at(-1) as WatchSnapshot;
      expect(findAgent(degraded, ARTX)).toBeDefined();
      expect(degraded.archiveIssues).toEqual([
        expect.objectContaining({
          kind: 'hot_projection_incomplete',
          project_id: PROJECT_A,
          health: 'degraded',
          message: expect.stringContaining('1 durable artifact(s) were skipped'),
        }),
      ]);
      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('starts with healthy artifacts and a partial-data issue when one archive thread is incomplete', async () => {
    const fx = await makeArchiveFixture();
    try {
      const project = await fx.archiveProject(PROJECT_A);
      await project.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });
      await project.seed({ artifactId: ARTY, stepCount: 2, closedSteps: 1 });
      const badLog = project.archiveEventsPath(ARTX);
      const filtered = (await readFile(badLog, 'utf8'))
        .trimEnd()
        .split('\n')
        .filter((line) => (JSON.parse(line) as { type: string }).type !== 'checkpoint_opened')
        .join('\n');
      await writeFile(badLog, `${filtered}\n`, 'utf8');

      const engine = new SnapshotEngine({ cwd: fx.base, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (snapshot: WatchSnapshot) => snapshots.push(snapshot));
      await expect(engine.start()).resolves.toBeUndefined();

      const snapshot = snapshots.at(-1) as WatchSnapshot;
      expect(findAgent(snapshot, ARTY)).toBeDefined();
      expect(findAgent(snapshot, ARTX)).toBeUndefined();
      expect(snapshot.archiveIssues).toEqual([
        expect.objectContaining({
          kind: 'artifact_unavailable',
          project_id: PROJECT_A,
          artifact_id: ARTX,
          message: expect.stringContaining('no matching prior checkpoint_opened'),
        }),
      ]);
      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('stays live with an invalid hot identity and recovers after it is repaired', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.unidentifiedRepo();
      await hot.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });
      await new Repo(hot.repoPath).setLocalConfig(PROJECT_ID_CONFIG_KEY, 'not-a-uuid');

      const engine = new SnapshotEngine({ cwd: hot.repoPath, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (snapshot: WatchSnapshot) => snapshots.push(snapshot));
      await expect(engine.start()).resolves.toBeUndefined();

      const invalid = snapshots.at(-1) as WatchSnapshot;
      expect(invalid.projects).toEqual([
        expect.objectContaining({
          projectId: null,
          threads: [expect.objectContaining({ artifactId: ARTX })],
        }),
      ]);
      expect(invalid.archiveIssues).toEqual([
        expect.objectContaining({
          kind: 'project_identity_unavailable',
          source: 'hot',
          message: expect.stringContaining('not a canonical UUIDv7'),
        }),
      ]);

      await new Repo(hot.repoPath).setLocalConfig(PROJECT_ID_CONFIG_KEY, PROJECT_A);
      await engine.tick(NOW);
      const repaired = snapshots.at(-1) as WatchSnapshot;
      expect(repaired.projects).toEqual([
        expect.objectContaining({
          projectId: PROJECT_A,
          threads: [expect.objectContaining({ artifactId: ARTX })],
        }),
      ]);
      expect(repaired.archiveIssues).toEqual([]);
      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('does not duplicate a hot artifact from its archive mirror when identity is invalid', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJECT_A);
      await hot.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1, openCp: true });
      await new Repo(hot.repoPath).setLocalConfig(PROJECT_ID_CONFIG_KEY, 'not-a-uuid');

      const engine = new SnapshotEngine({ cwd: hot.repoPath, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (snapshot: WatchSnapshot) => snapshots.push(snapshot));
      await expect(engine.start()).resolves.toBeUndefined();

      const snapshot = snapshots.at(-1) as WatchSnapshot;
      const copies = snapshot.projects.flatMap((project) =>
        project.threads.filter((thread) => thread.artifactId === ARTX)
      );
      expect(copies).toEqual([expect.objectContaining({ source: 'hot' })]);
      expect(snapshot.totals.activeThreads).toBe(1);
      expect(snapshot.totals.openCheckpoints).toBe(1);

      await new Repo(hot.repoPath).setLocalConfig(PROJECT_ID_CONFIG_KEY, PROJECT_B);
      await engine.tick(NOW);
      const repaired = snapshots.at(-1) as WatchSnapshot;
      const repairedCopies = repaired.projects.flatMap((project) =>
        project.threads.filter((thread) => thread.artifactId === ARTX)
      );
      expect(repairedCopies).toEqual([expect.objectContaining({ source: 'hot' })]);
      expect(repaired.totals.activeThreads).toBe(1);
      expect(repaired.totals.openCheckpoints).toBe(1);
      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('serves an archive-only duplicate from the freshest project despite stale index meta', async () => {
    const fx = await makeArchiveFixture();
    try {
      const olderArchive = await fx.archiveProject(PROJECT_A);
      await olderArchive.seed({
        artifactId: ARTX,
        task: 'stale archive projection',
        stepCount: 2,
        closedSteps: 1,
        openCp: true,
      });
      const newerArchive = await fx.archiveProject(PROJECT_B);
      await newerArchive.seed({
        artifactId: ARTX,
        task: 'fresh archive projection',
        stepCount: 2,
        closedSteps: 2,
      });
      const newerMtime = new Date(Date.now() + 60_000);
      await utimes(newerArchive.archiveEventsPath(ARTX), newerMtime, newerMtime);
      const scope = await openAllProjects({
        cwd: fx.base,
        env: fx.env,
        includeArchiveForHot: true,
        allowUnidentifiedHot: true,
      });
      try {
        const staleMeta = (mtimeMs: number): string =>
          JSON.stringify({
            schema_version: 1,
            artifacts: { [ARTX]: { size: 1, mtime_ms: mtimeMs } },
            artifact_issues: {},
            usage: null,
          });
        const idxRoot = indexRoot(fx.env);
        await writeFile(projectIndexMetaPath(idxRoot, PROJECT_A), staleMeta(200));
        await writeFile(projectIndexMetaPath(idxRoot, PROJECT_B), staleMeta(100));

        const archiveSnapshot = await collectFromScope(scope, { env: fx.env });
        const archiveProjects = archiveSnapshot.projects.filter((project) =>
          project.threads.some((thread) => thread.artifactId === ARTX)
        );
        expect(archiveProjects).toEqual([
          expect.objectContaining({
            projectId: PROJECT_B,
            threads: [expect.objectContaining({ title: 'fresh archive projection' })],
          }),
        ]);
        expect(archiveSnapshot.totals.openCheckpoints).toBe(0);
        expect(archiveSnapshot.ticker.length).toBe(
          archiveProjects[0]!.threads[0]!.recentEvents.length
        );
        expect(archiveSnapshot.ticker.length).toBeGreaterThan(0);
      } finally {
        scope.close();
      }
    } finally {
      await fx.cleanup();
    }
  });

  it('does not resurrect a stale active archive when the newer duplicate is outside the window', async () => {
    const fx = await makeArchiveFixture();
    try {
      const staleArchive = await fx.archiveProject(PROJECT_A);
      await staleArchive.seed({
        artifactId: ARTX,
        task: 'stale active projection',
        stepCount: 2,
        closedSteps: 1,
        openCp: true,
      });
      const canonicalArchive = await fx.archiveProject(PROJECT_B);
      await canonicalArchive.seed({
        artifactId: ARTX,
        task: 'old completed projection',
        stepCount: 2,
        closedSteps: 2,
        startedAt: '2020-01-01T00:00:00.000Z',
      });
      await canonicalArchive.store.writeSummary(
        {
          schema_version: 1,
          artifact_id: ARTX,
          outcome: 'completed long ago',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          head_sha: 'feedface',
          ts: '2020-01-02T00:00:00.000Z',
        },
        { idempotencyKey: 'summary-old-canonical' }
      );
      const canonicalMtime = new Date(Date.now() + 60_000);
      await utimes(canonicalArchive.archiveEventsPath(ARTX), canonicalMtime, canonicalMtime);

      const engine = new SnapshotEngine({ cwd: fx.base, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (value: WatchSnapshot) => snapshots.push(value));
      await expect(engine.start()).resolves.toBeUndefined();
      await engine.tick(NOW);

      const snapshot = snapshots.at(-1) as WatchSnapshot;
      expect(findAgent(snapshot, ARTX)).toBeUndefined();
      expect(snapshot.totals.activeThreads).toBe(0);
      expect(snapshot.totals.openCheckpoints).toBe(0);
      expect(snapshot.ticker).toEqual([]);
      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('does not resurrect an archive copy when the current checkout is outside the window', async () => {
    const fx = await makeArchiveFixture();
    try {
      const staleArchive = await fx.archiveProject(PROJECT_A);
      await staleArchive.seed({
        artifactId: ARTX,
        task: 'stale active archive',
        stepCount: 2,
        closedSteps: 1,
        openCp: true,
      });
      const currentCheckout = await fx.hotProject(PROJECT_B);
      await currentCheckout.seed({
        artifactId: ARTX,
        task: 'completed current checkout',
        stepCount: 2,
        closedSteps: 2,
        startedAt: '2020-01-01T00:00:00.000Z',
      });
      await currentCheckout.store.writeSummary(
        {
          schema_version: 1,
          artifact_id: ARTX,
          outcome: 'completed long ago',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          head_sha: 'feedface',
          ts: '2020-01-02T00:00:00.000Z',
        },
        { idempotencyKey: 'summary-old-current-checkout' }
      );

      const engine = new SnapshotEngine({ cwd: currentCheckout.repoPath, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (value: WatchSnapshot) => snapshots.push(value));
      await expect(engine.start()).resolves.toBeUndefined();
      await engine.tick(NOW);

      const snapshot = snapshots.at(-1) as WatchSnapshot;
      expect(findAgent(snapshot, ARTX)).toBeUndefined();
      expect(snapshot.totals.activeThreads).toBe(0);
      expect(snapshot.totals.openCheckpoints).toBe(0);
      expect(snapshot.ticker).toEqual([]);
      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('recovers from unreadable Git metadata discovered from a subdirectory', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.unidentifiedRepo();
      await hot.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });
      await new Repo(hot.repoPath).setLocalConfig(PROJECT_ID_CONFIG_KEY, PROJECT_A);
      const configPath = path.join(hot.repoPath, '.git', 'config');
      const healthyConfig = await readFile(configPath);
      await writeFile(configPath, '[broken\n', 'utf8');
      const nested = path.join(hot.repoPath, 'nested');
      await mkdir(nested);

      const engine = new SnapshotEngine({ cwd: nested, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (snapshot: WatchSnapshot) => snapshots.push(snapshot));
      await expect(engine.start()).resolves.toBeUndefined();

      const unreadable = snapshots.at(-1) as WatchSnapshot;
      expect(unreadable.projects).toEqual([
        expect.objectContaining({
          projectId: null,
          threads: [expect.objectContaining({ artifactId: ARTX })],
        }),
      ]);
      expect(unreadable.archiveIssues).toEqual([
        expect.objectContaining({
          kind: 'project_identity_unavailable',
          source: 'hot',
          message: expect.stringContaining('could not read git config orcaops.projectid'),
        }),
      ]);

      await writeFile(configPath, healthyConfig);
      await engine.tick(NOW);
      const repaired = snapshots.at(-1) as WatchSnapshot;
      expect(repaired.projects).toEqual([
        expect.objectContaining({
          projectId: PROJECT_A,
          threads: [expect.objectContaining({ artifactId: ARTX })],
        }),
      ]);
      expect(repaired.archiveIssues).toEqual([]);
      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects a tick when the hot artifacts root becomes a symlink', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJECT_A);
      await hot.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });

      const engine = new SnapshotEngine({ cwd: hot.repoPath, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (snapshot: WatchSnapshot) => snapshots.push(snapshot));
      await engine.start();
      const before = snapshots.length;

      const artifactsDir = path.join(hot.repoPath, '.orcaops', 'artifacts');
      await rename(artifactsDir, path.join(hot.repoPath, '.orcaops', 'artifacts-original'));
      const external = path.join(fx.base, 'external-artifacts');
      await mkdir(external);
      await symlink(external, artifactsDir);

      await expect(engine.tick(NOW)).rejects.toThrow(/config artifacts\.path/);
      expect(snapshots).toHaveLength(before);
      engine.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('an fs.watch push drives a fresh snapshot with no interval tick', async () => {
    const fx = await makeArchiveFixture();
    try {
      const proj = await fx.archiveProject(PROJECT_A);
      await proj.seed({ artifactId: ARTX, stepCount: 3, closedSteps: 1, openCp: true });

      const engine = new SnapshotEngine({ cwd: fx.base, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (s: WatchSnapshot) => snapshots.push(s));
      await engine.start();
      const before = snapshots.length;

      // Wire fs.watch → engine.tick(), NO setInterval.
      const fsw = new FsWatch({
        roots: engine.getWatchRoots(),
        debounceMs: 40,
        onTick: () => void engine.tick(),
      });
      expect(fsw.start()).toBe(true);
      try {
        // Append an event to the artifact's archive log (via the mirror).
        await proj.closeOpenCp(ARTX, { uncertainty: ['a risk'] });
        await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(before), {
          timeout: 3_000,
          interval: 25,
        });
      } finally {
        fsw.close();
        engine.close();
      }
    } finally {
      await fx.cleanup();
    }
  });

  it('closes safely while a tick is between asynchronous scope reads', async () => {
    const fx = await makeArchiveFixture();
    try {
      const proj = await fx.archiveProject(PROJECT_A);
      await proj.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });

      const engine = new SnapshotEngine({ cwd: fx.base, env: fx.env });
      const snapshots: WatchSnapshot[] = [];
      engine.on('snapshot', (snapshot: WatchSnapshot) => snapshots.push(snapshot));
      await engine.start();
      const before = snapshots.length;

      const pending = engine.tick(NOW);
      await Promise.resolve();
      engine.close();

      await expect(pending).resolves.toBeUndefined();
      await expect(engine.tick(NOW)).resolves.toBeUndefined();
      expect(snapshots).toHaveLength(before);
    } finally {
      await fx.cleanup();
    }
  });
});
