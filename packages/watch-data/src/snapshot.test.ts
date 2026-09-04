import { execFile as execFileCallback, spawn } from 'node:child_process';
import { statSync, utimesSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { openAllProjects } from '@orcaops/project-scope';

import { AgentActivityReader, type AgentActivityReaderLike } from './agent-activity.js';
import { collectFromScope, collectSnapshot } from './snapshot.js';
import { makeArchiveFixture } from '../tests/support/fixture-archive.js';

// readProjectId enforces canonical UUIDv7 for git-config-stored project ids.
const PROJ_HOT = '019fc100-0000-7000-8000-00000000bbbb';
const PROJ_ARCHIVE = '019fc200-0000-7000-8000-00000000bbb1';

// A fixed far-future clock so every seeded artifact's real-wall-clock activity is
// deterministically outside the 24h window (proving the status query, not the
// window, is what keeps active artifacts reachable), and "ago" never goes negative.
const NOW = Date.parse('2030-01-01T00:00:00.000Z');

const ARTA = '01999999-9999-7000-8000-0000000000a0';
const ARTB = '01999999-9999-7000-8000-0000000000b0';
const ARTC = '01999999-9999-7000-8000-0000000000c0';
const ARTX = '01999999-9999-7000-8000-0000000000e0';
const ARTY = '01999999-9999-7000-8000-0000000000f0';
const execFile = promisify(execFileCallback);

describe('collectSnapshot — projects, steps, tokens', () => {
  it(
    'two projects: steps, open cp, and a session spanning two artifacts counted once',
    { timeout: 30_000 },
    async () => {
      const fx = await makeArchiveFixture();
      try {
        // Current checkout: an archive-off repo (hot-served, no merge ambiguity).
        const cur = await fx.unidentifiedRepo();
        await cur.seed({
          artifactId: ARTA,
          branch: 'feat/a',
          stepCount: 5,
          closedSteps: 2,
          openCp: true,
          sessions: [
            { session_id: 'sess-1', tokens: 1000 },
            { session_id: 'sess-2', tokens: 500 },
          ],
        });
        await cur.seed({
          artifactId: ARTB,
          branch: 'feat/b',
          stepCount: 3,
          closedSteps: 1,
          // sess-1 ALSO touches ARTB → the header must still count it once.
          sessions: [{ session_id: 'sess-1', tokens: 1000 }],
        });
        // A second, archived project.
        const other = await fx.archiveProject(PROJ_ARCHIVE);
        await other.seed({ artifactId: ARTC, branch: 'feat/c', stepCount: 3, closedSteps: 1 });

        const snap = await collectSnapshot({ cwd: cur.repoPath, env: fx.env, nowMs: NOW });

        expect(snap.projects.length).toBe(2);
        const curProj = snap.projects.find((p) => p.projectId === null);
        const bProj = snap.projects.find((p) => p.projectId === PROJ_ARCHIVE);
        expect(curProj).toBeDefined();
        expect(bProj).toBeDefined();

        const a = curProj?.threads.find((x) => x.artifactId === ARTA);
        expect(a?.steps).toEqual({ completed: 2, total: 5 });
        expect(a?.openCheckpoints).toBe(1);
        expect(a?.source).toBe('hot');
        expect(a?.sessions.reduce((n, s) => n + s.tokens, 0)).toBe(1500);

        const c = bProj?.threads.find((x) => x.artifactId === ARTC);
        expect(c?.source).toBe('archive');
        expect(c?.steps).toEqual({ completed: 1, total: 3 });

        // sess-1 spans ARTA + ARTB → deduped to one; total = 1000 + 500, NOT 2500.
        expect(snap.totals.sessionTokens).toBe(1500);
        expect(snap.totals.openCheckpoints).toBe(1);
        expect(snap.totals.activeThreads).toBe(3);
      } finally {
        await fx.cleanup();
      }
    }
  );

  it('an active artifact with all activity >24h old still appears (status-query path)', async () => {
    const fx = await makeArchiveFixture();
    try {
      const cur = await fx.unidentifiedRepo();
      await cur.seed({
        artifactId: ARTX,
        stepCount: 2,
        closedSteps: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      // NOW is years later, so the 24h window excludes it — only the active-status
      // query keeps it a candidate.
      const snap = await collectSnapshot({ cwd: cur.repoPath, env: fx.env, nowMs: NOW });
      const proj = snap.projects.find((p) => p.projectId === null);
      expect(proj?.threads.some((a) => a.artifactId === ARTX)).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });
});

describe('collectSnapshot — hot+archive merge', () => {
  it('an archive-only sibling artifact appears as source archive with its open cp visible', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJ_HOT);
      await hot.seed({ artifactId: ARTX, branch: 'main', stepCount: 3, closedSteps: 1 });
      // A sibling worktree of the SAME project mirrors a DIFFERENT artifact into the
      // shared archive — its events never enter this checkout's hot store.
      const sib = await fx.sibling(PROJ_HOT);
      await sib.seed({
        artifactId: ARTY,
        branch: 'sibling-wt',
        stepCount: 3,
        closedSteps: 1,
        openCp: true,
      });

      const snap = await collectSnapshot({ cwd: hot.repoPath, env: fx.env, nowMs: NOW });
      const proj = snap.projects.find((p) => p.projectId === PROJ_HOT);
      const y = proj?.threads.find((a) => a.artifactId === ARTY);
      expect(y?.source).toBe('archive');
      expect(y?.openCheckpoints).toBe(1);
      expect(y?.branch).toBe('sibling-wt');
      // This checkout's own artifact is still present.
      expect(proj?.threads.some((a) => a.artifactId === ARTX)).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it('freshest-projection-wins: a strictly-newer archive mtime routes the row to archive', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJ_HOT);
      await hot.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });
      const hotMs = statSync(hot.hotEventsPath(ARTX)).mtimeMs;
      // Archive strictly newer than hot (the sibling-continued handoff shape).
      const newer = new Date(hotMs + 5000);
      utimesSync(hot.archiveEventsPath(ARTX), newer, newer);

      const snap = await collectSnapshot({ cwd: hot.repoPath, env: fx.env, nowMs: NOW });
      const x = snap.projects
        .find((p) => p.projectId === PROJ_HOT)
        ?.threads.find((a) => a.artifactId === ARTX);
      expect(x?.source).toBe('archive');
    } finally {
      await fx.cleanup();
    }
  });

  it('freshest-projection-wins: an older archive mtime (mirror lag) keeps the row hot', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJ_HOT);
      await hot.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });
      const hotMs = statSync(hot.hotEventsPath(ARTX)).mtimeMs;
      const older = new Date(hotMs - 5000);
      utimesSync(hot.archiveEventsPath(ARTX), older, older);

      const snap = await collectSnapshot({ cwd: hot.repoPath, env: fx.env, nowMs: NOW });
      const x = snap.projects
        .find((p) => p.projectId === PROJ_HOT)
        ?.threads.find((a) => a.artifactId === ARTX);
      expect(x?.source).toBe('hot');
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects a redirected hot artifact instead of falling back to its archive twin', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJ_HOT);
      await hot.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });
      const redirected = hot.hotEventsPath(ARTX);
      const external = path.join(fx.base, 'redirected-hot-events.ndjson');
      await writeFile(external, await readFile(redirected));
      await unlink(redirected);
      await symlink(external, redirected);

      await expect(collectSnapshot({ cwd: hot.repoPath, env: fx.env, nowMs: NOW })).rejects.toThrow(
        /must not contain symlinks/
      );
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects an unreadable hot log instead of falling back to its archive twin', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJ_HOT);
      await hot.seed({ artifactId: ARTX, stepCount: 2, closedSteps: 1 });
      const eventsPath = hot.hotEventsPath(ARTX);
      await unlink(eventsPath);
      await mkdir(eventsPath);
      const recent = new Date(NOW);
      utimesSync(eventsPath, recent, recent);

      await expect(collectSnapshot({ cwd: hot.repoPath, env: fx.env, nowMs: NOW })).rejects.toThrow(
        /not a regular file/
      );
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects a hot log FIFO without blocking the snapshot', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJ_HOT);
      await hot.seed({ artifactId: ARTX, stepCount: 1 });
      const eventsPath = hot.hotEventsPath(ARTX);
      await unlink(eventsPath);
      await execFile('mkfifo', [eventsPath]);

      let failure: unknown;
      const collecting = collectSnapshot({ cwd: hot.repoPath, env: fx.env, nowMs: NOW }).then(
        () => 'resolved' as const,
        (error: unknown) => {
          failure = error;
          return 'rejected' as const;
        }
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        collecting,
        new Promise<'blocked'>((resolve) => {
          timeout = setTimeout(() => resolve('blocked'), 1_000);
        }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
      if (outcome === 'blocked') {
        const writer = spawn('sh', ['-c', ': > "$1"', 'sh', eventsPath], { stdio: 'ignore' });
        const writerExited = new Promise<void>((resolve, reject) => {
          writer.once('error', reject);
          writer.once('exit', () => resolve());
        });
        await collecting;
        if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
        await writerExited;
      }

      expect(outcome).toBe('rejected');
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('not a regular file');
    } finally {
      await fx.cleanup();
    }
  });

  it('applies the selected hot projection visibility after a stale archive refresh', async () => {
    const fx = await makeArchiveFixture();
    try {
      const hot = await fx.hotProject(PROJ_HOT);
      await hot.seed({
        artifactId: ARTX,
        stepCount: 2,
        closedSteps: 1,
        openCp: true,
        startedAt: '2020-01-01T00:00:00.000Z',
      });
      const scope = await openAllProjects({
        cwd: hot.repoPath,
        env: fx.env,
        includeArchiveForHot: true,
        allowUnidentifiedHot: true,
      });
      try {
        await hot.closeOpenCp(ARTX);
        await hot.store.writeSummary(
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
          { idempotencyKey: 'summary-completed-hot' }
        );

        const snap = await collectFromScope(scope, { env: fx.env, nowMs: NOW });
        const project = snap.projects.find((candidate) => candidate.projectId === PROJ_HOT);
        expect(project?.threads.some((thread) => thread.artifactId === ARTX)).toBe(false);
        expect(snap.totals.activeThreads).toBe(0);
        expect(snap.totals.openCheckpoints).toBe(0);
        expect(snap.ticker).toEqual([]);
      } finally {
        scope.close();
      }
    } finally {
      await fx.cleanup();
    }
  });
});

describe('empty state', () => {
  it('an empty archive reports not-enabled with zero projects and totals', async () => {
    const fx = await makeArchiveFixture();
    try {
      // Non-repo cwd + empty archive → no projects, archive not enabled.
      const snap = await collectSnapshot({ cwd: fx.base, env: fx.env, nowMs: NOW });
      expect(snap.archiveEnabled).toBe(false);
      expect(snap.projects).toEqual([]);
      expect(snap.totals.activeThreads).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });
});

describe('collectSnapshot — event tail (sparklines + ticker)', () => {
  it('classifies from the newest provider activity and tails only event-log data', async () => {
    const fx = await makeArchiveFixture();
    try {
      const cur = await fx.unidentifiedRepo();
      await cur.seed({
        artifactId: ARTX,
        branch: 'feat/provider-activity',
        stepCount: 2,
        closedSteps: 1,
        openCp: true,
        sessions: [
          { agent: 'codex', session_id: 'codex-session', tokens: 321 },
          { agent: 'claude-code', session_id: 'claude-session', tokens: 100 },
        ],
      });
      const eventsPath = cur.hotEventsPath(ARTX);
      const raw = await readFile(eventsPath, 'utf8');
      const events = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { ts: string; type: string });
      const newestEvent = Math.max(...events.map((event) => Date.parse(event.ts)));
      const eventMtime = newestEvent - 2 * 60 * 60_000;
      await utimes(eventsPath, new Date(eventMtime), new Date(eventMtime));
      const nowMs = newestEvent + 1_000;
      const thresholds = { workingMaxMs: 1_000, quietMaxMs: 5_000, wrapWindowMs: 1_000 };
      const scope = await openAllProjects({
        cwd: cur.repoPath,
        env: fx.env,
        includeArchiveForHot: true,
        allowUnidentifiedHot: true,
      });
      try {
        const absent: AgentActivityReaderLike = {
          readLastActivity: async () => new Map(),
        };
        const baseline = await collectFromScope(scope, {
          env: fx.env,
          nowMs,
          thresholds,
          activityReader: absent,
        });
        const baselineThread = baseline.projects[0]?.threads[0];
        expect(baselineThread?.state).toBe('stalled');
        expect(baselineThread?.lastWriteMs).toBeCloseTo(eventMtime, 0);
        expect(baseline.ticker).toEqual([]);

        const failedProvider = new AgentActivityReader({}, (agent) => ({
          agent,
          readLastActivity: async () => {
            throw new Error('provider unavailable');
          },
        }));
        const failureFallback = await collectFromScope(scope, {
          env: fx.env,
          nowMs,
          thresholds,
          activityReader: failedProvider,
        });
        expect(failureFallback.projects[0]?.threads[0]?.lastWriteMs).toBe(
          baselineThread?.lastWriteMs
        );
        expect(failureFallback.totals.sessionTokens).toBe(baseline.totals.sessionTokens);
        expect(failureFallback.ticker).toEqual([]);

        const olderProvider: AgentActivityReaderLike = {
          readLastActivity: async () =>
            new Map([['codex', new Map([['codex-session', eventMtime - 1_000]])]]),
        };
        const eventWins = await collectFromScope(scope, {
          env: fx.env,
          nowMs,
          thresholds,
          activityReader: olderProvider,
        });
        expect(eventWins.projects[0]?.threads[0]?.lastWriteMs).toBe(baselineThread?.lastWriteMs);

        const providerActivityMs = nowMs - 100;
        const activeReader: AgentActivityReaderLike = {
          readLastActivity: async () =>
            new Map([
              ['codex', new Map([['codex-session', nowMs - 500]])],
              ['claude-code', new Map([['claude-session', providerActivityMs]])],
            ]),
        };
        const active = await collectFromScope(scope, {
          env: fx.env,
          nowMs,
          thresholds,
          activityReader: activeReader,
        });
        const activeThread = active.projects[0]?.threads[0];
        expect(activeThread?.lastWriteMs).toBe(providerActivityMs);
        expect(activeThread?.state).toBe('working');
        expect(active.totals.sessionTokens).toBe(421);
        expect(active.totals.sessionTokens).toBe(baseline.totals.sessionTokens);
        expect(activeThread?.recentEvents.length).toBeGreaterThan(0);
        expect(
          (activeThread?.sparkline ?? []).reduce((sum, count) => sum + count, 0)
        ).toBeGreaterThan(0);
        expect(active.ticker.map((event) => event.type)).toEqual(
          expect.arrayContaining(events.map((event) => event.type))
        );
        expect(activeThread?.checkpoints.map((checkpoint) => checkpoint.linesAdded)).toEqual(
          baselineThread?.checkpoints.map((checkpoint) => checkpoint.linesAdded)
        );

        const quiet = await collectFromScope(scope, {
          env: fx.env,
          nowMs: providerActivityMs + 2_000,
          thresholds,
          activityReader: activeReader,
        });
        const stalled = await collectFromScope(scope, {
          env: fx.env,
          nowMs: providerActivityMs + 6_000,
          thresholds,
          activityReader: activeReader,
        });
        expect(quiet.projects[0]?.threads[0]?.state).toBe('quiet');
        expect(stalled.projects[0]?.threads[0]?.state).toBe('stalled');
      } finally {
        scope.close();
      }
    } finally {
      await fx.cleanup();
    }
  });

  it('populates sparkline + recentEvents + ticker for a recently-active artifact', async () => {
    const fx = await makeArchiveFixture();
    try {
      const cur = await fx.unidentifiedRepo();
      await cur.seed({ artifactId: ARTX, branch: 'feat/tail', stepCount: 2, closedSteps: 1 });
      // Anchor `now` to the newest event so the tail lands inside the 60m window.
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(cur.hotEventsPath(ARTX), 'utf8');
      const tsMax = Math.max(
        ...raw
          .trim()
          .split('\n')
          .map((l) => Date.parse((JSON.parse(l) as { ts: string }).ts))
      );

      const snap = await collectSnapshot({ cwd: cur.repoPath, env: fx.env, nowMs: tsMax + 100 });
      const agent = snap.projects
        .find((p) => p.projectId === null)
        ?.threads.find((a) => a.artifactId === ARTX);
      expect(agent?.sparkline.length).toBe(20);
      expect((agent?.sparkline ?? []).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
      expect(agent?.recentEvents.length).toBeGreaterThan(0);
      expect(snap.ticker.length).toBeGreaterThan(0);
      expect(snap.ticker[0].branch).toBe('feat/tail');
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects a redirected hot artifact instead of presenting a partial snapshot', async () => {
    const fx = await makeArchiveFixture();
    try {
      const cur = await fx.unidentifiedRepo();
      await cur.seed({ artifactId: ARTX, branch: 'feat/unsafe', stepCount: 1 });
      await cur.seed({ artifactId: ARTY, branch: 'feat/safe', stepCount: 1 });
      const redirected = cur.hotEventsPath(ARTX);
      const external = path.join(fx.base, 'external-events.ndjson');
      await writeFile(external, await readFile(redirected));
      await unlink(redirected);
      await symlink(external, redirected);

      await expect(collectSnapshot({ cwd: cur.repoPath, env: fx.env, nowMs: NOW })).rejects.toThrow(
        /must not contain symlinks/
      );
    } finally {
      await fx.cleanup();
    }
  });

  it('refuses a redirected hot artifact root instead of rendering an empty project', async () => {
    const fx = await makeArchiveFixture();
    try {
      const cur = await fx.unidentifiedRepo();
      await cur.seed({ artifactId: ARTX, branch: 'feat/unsafe-root', stepCount: 1 });
      const artifactsDir = path.join(cur.repoPath, '.orcaops', 'artifacts');
      const outside = path.join(fx.base, 'external-artifacts');
      await mkdir(outside);
      await rm(artifactsDir, { recursive: true });
      await symlink(outside, artifactsDir);

      await expect(collectSnapshot({ cwd: cur.repoPath, env: fx.env, nowMs: NOW })).rejects.toThrow(
        /must not contain symlinks/
      );
    } finally {
      await fx.cleanup();
    }
  });
});
