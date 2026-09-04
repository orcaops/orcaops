import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Repo } from '@orcaops/core';
import {
  archiveArtifactPaths,
  archiveLocksDir,
  ArchiveMirror,
  archiveProjectDir,
  artifactPathsFor,
  ArtifactStore,
  getDefaultConfig,
  indexRoot,
  projectIndexDbPath,
  projectIndexMetaPath,
  type Registry,
} from '@orcaops/storage';
import { createLinkedWorktree, createTempRepo, writeProjectConfig } from '@orcaops/test-harness';

import { archiveLastWriteMs, hotLastWriteMs, resolveArtifactSource } from './artifact-source.js';
import {
  ensureProjectId,
  InvalidProjectIdentityError,
  PROJECT_ID_CONFIG_KEY,
  ProjectIdentityReadError,
  readProjectId,
} from './project-identity.js';
import {
  openAllProjects,
  openCurrentProjectArchive,
  projectIdentityRecoveryGuidance,
} from './project-scope.js';

// readProjectId now enforces canonical UUIDv7 (stored ids become archive
// path segments), so the git-config-backed hot project uses a real one.
const PROJ_HOT = '019fc100-0000-7000-8000-00000000aaaa';
const PROJ_A = '019fc100-0000-7000-8000-00000000aaa1';
const PROJ_B = '019fc100-0000-7000-8000-00000000aaa2';

/**
 * The cross-project seam. Fixtures are REAL lifecycles: an ArtifactStore with
 * a write-through ArchiveMirror, so the archive contains exactly what
 * production mirroring produces — the same fixture approach as
 * `@orcaops/storage`'s `archive/global-index.test.ts`.
 */

const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
const ART_HOT = '01999999-9999-7000-8000-000000000010';
const ART_A = '01999999-9999-7000-8000-0000000000a0';
const ART_B = '01999999-9999-7000-8000-0000000000b0';
const ART_SIB = '01999999-9999-7000-8000-0000000000c0';

let base: string;
let dataRoot: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'orcaops-ps-'));
  dataRoot = path.join(base, 'archive');
  cleanups.length = 0;
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await rm(base, { recursive: true, force: true });
});

// Self-contained env: index root resolves under <dataRoot>/index-cache (no XDG
// override), and ORCAOPS_DATA_DIR points the archive at our temp tree, so no
// ambient ~/.orcaops is ever touched.
function env(): NodeJS.ProcessEnv {
  return { ORCAOPS_DATA_DIR: dataRoot } as NodeJS.ProcessEnv;
}

async function seedArtifact(store: ArtifactStore, artifactId: string, task: string): Promise<void> {
  await store.writePlan(
    {
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'feat/x',
      base_sha: 'abc123',
      agent: 'claude-code',
      agent_session_id: null,
      task,
      label: `label ${task}`.slice(0, 60),
      plan_steps: [{ step_id: STEP_ID, text: `do ${task}`, label: 's1', acceptance_criteria: [] }],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: '2026-07-02T12:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    },
    { idempotencyKey: `plan-${artifactId}` }
  );
  await store.writeCheckpointOpened(
    { artifact_id: artifactId, declared_step_ids: [STEP_ID] },
    { idempotencyKey: `open-${artifactId}`, headSha: 'cafef00d' }
  );
  await store.writeCheckpointClosed(
    {
      artifact_id: artifactId,
      n: 1,
      summary: `finished ${task}`,
      files_changed: ['src/x.ts'],
      decisions: [],
      uncertainty: ['some risk'],
      done_criteria: [],
      verification: [{ command: 'fixture verification', exit_code: 0 }],
      completed_step_ids: [STEP_ID],
      head_sha: 'cafef00d',
    },
    { idempotencyKey: `close-${artifactId}` }
  );
}

async function writeSummary(store: ArtifactStore, artifactId: string): Promise<void> {
  await store.writeSummary(
    {
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'done and dusted',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'sha-final',
      ts: '2026-07-02T13:00:00.000Z',
    },
    { idempotencyKey: `sum-${artifactId}` }
  );
}

async function withoutCheckpointOpen(projectDir: string, artifactId: string): Promise<string> {
  const logPath = archiveArtifactPaths(projectDir, artifactId).eventsNdjson;
  const original = await readFile(logPath, 'utf8');
  const filtered = original
    .trimEnd()
    .split('\n')
    .filter((line) => (JSON.parse(line) as { type: string }).type !== 'checkpoint_opened')
    .join('\n');
  await writeFile(logPath, `${filtered}\n`, 'utf8');
  return original;
}

interface Seeded {
  repo: { path: string; cleanup: () => Promise<void> };
  store: ArtifactStore;
  projectId: string;
  projectDir: string;
}

/** A pure archive project: a temp repo whose events mirror into the shared
 *  archive tree and are then served from the disposable index only. */
async function makeArchiveProject(
  projectId: string,
  task: string,
  artifactId: string
): Promise<Seeded> {
  const repo = await createTempRepo({ initialBranch: 'main' });
  const projectDir = archiveProjectDir(dataRoot, projectId);
  const mirror = new ArchiveMirror({
    projectDir,
    locksDir: archiveLocksDir(indexRoot(env()), projectId),
    redactSecrets: false,
  });
  const store = new ArtifactStore({
    repoRoot: repo.path,
    config: getDefaultConfig(),
    archive: mirror,
  });
  await seedArtifact(store, artifactId, task);
  cleanups.push(() => store.close());
  cleanups.push(() => repo.cleanup());
  return { repo, store, projectId, projectDir };
}

/** A hot repo with a minted project id, mirroring into its own archive dir. */
async function makeHotProject(
  projectId: string,
  task: string,
  artifactId: string
): Promise<Seeded> {
  const repo = await createTempRepo({ initialBranch: 'main' });
  // Governed by a project config: data alone never counts as an install.
  await writeProjectConfig(repo.path);
  await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, projectId);
  const projectDir = archiveProjectDir(dataRoot, projectId);
  const mirror = new ArchiveMirror({
    projectDir,
    locksDir: archiveLocksDir(indexRoot(env()), projectId),
    redactSecrets: false,
  });
  const store = new ArtifactStore({
    repoRoot: repo.path,
    config: getDefaultConfig(),
    archive: mirror,
  });
  await seedArtifact(store, artifactId, task);
  cleanups.push(() => store.close());
  cleanups.push(() => repo.cleanup());
  return { repo, store, projectId, projectDir };
}

describe('openAllProjects — defaults (byte-compatible with --all-projects)', () => {
  it('opens a schema-4 hot project through the read-only config contract', async () => {
    const hot = await makeHotProject(PROJ_HOT, 'legacy hot work', ART_HOT);
    await writeFile(
      path.join(hot.repo.path, '.orcaops', 'config.json'),
      JSON.stringify({
        schema_version: 4,
        llm: { default_timeout_ms: 30_000 },
        artifacts: { path: '.orcaops/artifacts', gitignore: true },
        cache: { path: '.orcaops/cache/orcaops.db' },
      }),
      'utf8'
    );

    const scope = await openAllProjects({
      cwd: hot.repo.path,
      env: env(),
      throwOnHotOpenError: true,
    });
    try {
      const hotProject = scope.projects.find((project) => project.projectId === PROJ_HOT);
      expect(hotProject?.store).toBeDefined();
      expect(hotProject?.store.getArtifact(ART_HOT)?.task).toBe('legacy hot work');
    } finally {
      scope.close();
    }
  });

  it(
    'fans out the hot project + archived projects, each served by the right store',
    { timeout: 30_000 },
    async () => {
      const hot = await makeHotProject(PROJ_HOT, 'hot work', ART_HOT);
      await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
      await makeArchiveProject(PROJ_B, 'schema migration', ART_B);

      const scope = await openAllProjects({ cwd: hot.repo.path, env: env() });
      try {
        expect(scope.projects.map((p) => p.projectId).sort()).toEqual(
          [PROJ_A, PROJ_B, PROJ_HOT].sort()
        );

        const hotHandle = scope.projects.find((p) => p.projectId === PROJ_HOT);
        expect(hotHandle?.hot).toBe(true);
        expect(hotHandle?.hotStore).toBeDefined();
        expect(hotHandle?.store.getArtifact(ART_HOT)?.status).toBe('active');
        // Default: hot handle carries NO archive index and needs NO refresh
        // (the hot store is written live). This is the "hot project's archive
        // index skipped" invariant that keeps `--all-projects` output limited
        // to the hot store's own rows.
        expect(hotHandle?.archiveStore).toBeUndefined();
        expect(hotHandle?.refresh).toBeUndefined();

        const aHandle = scope.projects.find((p) => p.projectId === PROJ_A);
        expect(aHandle?.hot).toBe(false);
        expect(aHandle?.store.getArtifact(ART_A)?.status).toBe('active');
        expect(aHandle?.refresh).toBeDefined();
      } finally {
        scope.close();
      }
    }
  );

  it('an index handle refresh picks up an event appended after the scope opened', async () => {
    const a = await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
    // cwd is a non-repo dir → no hot project, just the archived one.
    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      const aHandle = scope.projects.find((p) => p.projectId === PROJ_A);
      expect(aHandle?.store.getArtifact(ART_A)?.status).toBe('active');
      await writeSummary(a.store, ART_A);
      expect(aHandle?.store.getArtifact(ART_A)?.status).toBe('active'); // not yet refreshed
      await aHandle?.refresh?.();
      expect(aHandle?.store.getArtifact(ART_A)?.status).toBe('complete');
    } finally {
      scope.close();
    }
  });

  it('an empty archive + non-repo cwd yields no projects and no unidentifiedHot', async () => {
    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      expect(scope.projects).toEqual([]);
      expect(scope.unidentifiedHot).toBeUndefined();
    } finally {
      scope.close();
    }
  });

  it('surfaces per-artifact archive issues without dropping the healthy project', async () => {
    const a = await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
    const completeLog = await withoutCheckpointOpen(a.projectDir, ART_A);

    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      const handle = scope.projects.find((p) => p.projectId === PROJ_A);
      expect(handle).toBeDefined();
      expect(handle?.store.getArtifact(ART_A)).toBeNull();
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'artifact_unavailable',
          project_id: PROJ_A,
          project: handle?.displayName,
          artifact_id: ART_A,
          message: expect.stringContaining('no matching prior checkpoint_opened'),
        }),
      ]);

      await writeFile(archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson, completeLog, 'utf8');
      await handle?.refresh?.();
      expect(handle?.store.getArtifact(ART_A)).not.toBeNull();
      expect(scope.issues).toEqual([]);
    } finally {
      scope.close();
    }
  });

  it('surfaces a non-fatal archive index metadata failure', async () => {
    await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
    const metaPath = projectIndexMetaPath(indexRoot(env()), PROJ_A);
    await mkdir(metaPath, { recursive: true });

    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      expect(scope.projects.find((project) => project.projectId === PROJ_A)).toBeDefined();
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'project_index_degraded',
          project_id: PROJ_A,
          message: expect.stringContaining(
            'Could not update the disposable archive index metadata'
          ),
        }),
      ]);
    } finally {
      scope.close();
    }
  });

  it('quarantines only the archive artifact whose high-water becomes unreadable', async () => {
    const a = await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
    const initial = await openAllProjects({ cwd: base, env: env() });
    initial.close();

    const logPath = archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson;
    await rm(logPath);
    await symlink(logPath, logPath);

    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      const handle = scope.projects.find((project) => project.projectId === PROJ_A);
      expect(handle?.store.getArtifact(ART_A)).toBeNull();
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'artifact_unavailable',
          project_id: PROJ_A,
          artifact_id: ART_A,
        }),
      ]);
    } finally {
      scope.close();
    }
  });

  it('publishes an artifact issue when metadata must be recovered before an unreadable log', async () => {
    const a = await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      const handle = scope.projects.find((project) => project.projectId === PROJ_A);
      const generation = handle?.archiveMeta?.generation;
      expect(generation).toBeGreaterThan(0);
      await rm(projectIndexMetaPath(indexRoot(env()), PROJ_A));

      const logPath = archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson;
      await rm(logPath);
      await symlink(logPath, logPath);
      await handle?.refresh?.();

      expect(handle?.archiveMeta?.generation).toBe((generation ?? 0) + 1);
      expect(handle?.store.getArtifact(ART_A)).toBeNull();
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'artifact_unavailable',
          project_id: PROJ_A,
          artifact_id: ART_A,
        }),
      ]);
    } finally {
      scope.close();
    }
  });

  it('does not publish a sidecar generation that is not aligned with SQLite', async () => {
    const a = await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
    const initial = await openAllProjects({ cwd: base, env: env() });
    initial.close();

    const metaPath = projectIndexMetaPath(indexRoot(env()), PROJ_A);
    const forgedMeta = JSON.parse(await readFile(metaPath, 'utf8')) as { generation: number };
    forgedMeta.generation = 100;
    await writeFile(metaPath, `${JSON.stringify(forgedMeta)}\n`, 'utf8');

    const logPath = archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson;
    const originalLog = await readFile(logPath, 'utf8');
    await rm(logPath);
    await symlink(logPath, logPath);

    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      const handle = scope.projects.find((project) => project.projectId === PROJ_A);
      expect(handle?.store.getArtifact(ART_A)).toBeNull();
      const quarantinedGeneration = handle?.archiveMeta?.generation ?? 0;
      expect(quarantinedGeneration).toBeGreaterThan(0);
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'artifact_unavailable',
          project_id: PROJ_A,
          artifact_id: ART_A,
        }),
      ]);

      await rm(logPath);
      await writeFile(logPath, originalLog, 'utf8');
      await handle?.refresh?.();

      expect(handle?.archiveMeta?.generation).toBe(quarantinedGeneration + 1);
      expect(handle?.store.getArtifact(ART_A)?.status).toBe('active');
      expect(scope.issues).toEqual([]);
    } finally {
      scope.close();
    }
  });

  it('recovers an in-memory fallback after an initial archive refresh failure', async () => {
    const a = await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
    const initial = await openAllProjects({ cwd: base, env: env() });
    initial.close();

    const logPath = archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson;
    const originalLog = await readFile(logPath, 'utf8');
    await rm(logPath);
    await symlink(logPath, logPath);
    const dbPath = projectIndexDbPath(indexRoot(env()), PROJ_A);
    await rm(dbPath, { force: true });
    await mkdir(dbPath);

    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      const handle = scope.projects.find((project) => project.projectId === PROJ_A);
      expect(handle?.archiveMeta?.generation).toBe(1);
      expect(handle?.store.getArtifact(ART_A)).toBeNull();
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'artifact_unavailable',
          project_id: PROJ_A,
          artifact_id: ART_A,
        }),
      ]);

      await rm(logPath);
      await writeFile(logPath, originalLog, 'utf8');
      await handle?.refresh?.();

      expect(handle?.archiveMeta?.generation).toBe(2);
      expect(handle?.store.getArtifact(ART_A)?.status).toBe('active');
      expect(scope.issues).toEqual([]);
    } finally {
      scope.close();
    }
  });

  it('publishes same-generation index warnings from a no-op refresh', async () => {
    await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      const handle = scope.projects.find((project) => project.projectId === PROJ_A);
      const generation = handle?.archiveMeta?.generation;
      const metaPath = projectIndexMetaPath(indexRoot(env()), PROJ_A);
      await rm(metaPath, { force: true });
      await mkdir(metaPath);

      await handle?.refresh?.();

      expect(handle?.archiveMeta?.generation).toBe(generation);
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'project_index_degraded',
          project_id: PROJ_A,
          message: expect.stringContaining(
            'Could not update the disposable archive index metadata'
          ),
        }),
      ]);
    } finally {
      scope.close();
    }
  });

  it('discloses a hot projection that becomes incomplete while the scope remains open', async () => {
    const hot = await makeHotProject(PROJ_HOT, 'hot work', ART_HOT);
    const scope = await openAllProjects({ cwd: hot.repo.path, env: env() });
    try {
      expect(scope.issues).toEqual([]);
      expect(scope.projects[0]?.store.getArtifact(ART_HOT)).not.toBeNull();

      await rm(artifactPathsFor(hot.repo.path, getDefaultConfig(), ART_HOT).eventsNdjson);
      hot.store.store.setProjectionHealth('rebuild_pending');
      await scope.prepareHotStoresForRead();

      expect(scope.projects[0]?.store.getArtifact(ART_HOT)).toBeNull();
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'hot_projection_incomplete',
          project_id: PROJ_HOT,
          project: expect.any(String),
          health: 'degraded',
          message: expect.stringContaining('1 durable artifact(s) were skipped'),
        }),
      ]);
    } finally {
      scope.close();
    }
  });
});

describe('openAllProjects — includeArchiveForHot (sibling worktrees)', () => {
  it('the hot handle serves sibling-worktree archive rows, and refresh picks up new events', async () => {
    const hot = await makeHotProject(PROJ_HOT, 'hot work', ART_HOT);

    // A sibling worktree of the SAME project id, mirroring into the hot
    // project's archive dir — its artifact never enters this checkout's hot store.
    const sibling = await createTempRepo({ initialBranch: 'main' });
    cleanups.push(() => sibling.cleanup());
    const siblingStore = new ArtifactStore({
      repoRoot: sibling.path,
      config: getDefaultConfig(),
      archive: new ArchiveMirror({
        projectDir: hot.projectDir,
        locksDir: archiveLocksDir(indexRoot(env()), PROJ_HOT),
        redactSecrets: false,
      }),
    });
    cleanups.push(() => siblingStore.close());
    await seedArtifact(siblingStore, ART_SIB, 'sibling worktree work');

    const scope = await openAllProjects({
      cwd: hot.repo.path,
      env: env(),
      includeArchiveForHot: true,
    });
    try {
      const hotHandle = scope.projects.find((p) => p.projectId === PROJ_HOT);
      expect(hotHandle?.archiveStore).toBeDefined();
      expect(hotHandle?.refresh).toBeDefined();
      const initialArchiveSize = hotHandle?.archiveMeta?.artifacts[ART_SIB]?.size;
      expect(initialArchiveSize).toBeGreaterThan(0);

      // The sibling artifact is present in the archive index but NOT the hot store.
      expect(hotHandle?.archiveStore?.getArtifact(ART_SIB)?.status).toBe('active');
      expect(hotHandle?.store.getArtifact(ART_SIB)).toBeNull();
      // The hot store still serves its own artifact.
      expect(hotHandle?.store.getArtifact(ART_HOT)?.status).toBe('active');

      const hotLog = artifactPathsFor(hot.repo.path, getDefaultConfig(), ART_HOT).eventsNdjson;
      const archiveLog = archiveArtifactPaths(hot.projectDir, ART_HOT).eventsNdjson;
      const hotOlder = new Date('2026-01-01T00:00:00.000Z');
      const archiveNewer = new Date('2026-01-02T00:00:00.000Z');
      await utimes(hotLog, hotOlder, hotOlder);
      await utimes(archiveLog, archiveNewer, archiveNewer);
      await hotHandle?.refresh?.();
      expect(
        resolveArtifactSource({
          hotPresent: true,
          archivePresent: true,
          hotLastWriteMs: await hotLastWriteMs(hotHandle!.hotStore!, ART_HOT),
          archiveLastWriteMs: archiveLastWriteMs(hotHandle!.archiveMeta!, ART_HOT),
        })
      ).toEqual({ source: 'archive', lastWriteMs: archiveNewer.getTime() });

      const hotNewer = new Date('2026-01-03T00:00:00.000Z');
      await utimes(hotLog, hotNewer, hotNewer);
      expect(
        resolveArtifactSource({
          hotPresent: true,
          archivePresent: true,
          hotLastWriteMs: await hotLastWriteMs(hotHandle!.hotStore!, ART_HOT),
          archiveLastWriteMs: archiveLastWriteMs(hotHandle!.archiveMeta!, ART_HOT),
        })
      ).toEqual({ source: 'hot', lastWriteMs: hotNewer.getTime() });

      // Append a new event (summary) to the sibling AFTER the scope opened.
      await writeSummary(siblingStore, ART_SIB);
      expect(hotHandle?.archiveStore?.getArtifact(ART_SIB)?.status).toBe('active'); // stale until refresh
      await hotHandle?.refresh?.();
      expect(hotHandle?.archiveStore?.getArtifact(ART_SIB)?.status).toBe('complete');
      expect(hotHandle?.archiveMeta?.artifacts[ART_SIB]?.size).toBeGreaterThan(
        initialArchiveSize ?? 0
      );
    } finally {
      scope.close();
    }
  });

  it('finds retained history from an empty linked worktree hot store', async () => {
    const hot = await makeHotProject(PROJ_HOT, 'main worktree work', ART_HOT);
    const linked = await createLinkedWorktree(hot.repo.path, { branch: 'feature-linked' });
    cleanups.push(() => linked.cleanup());
    // Governed, with no data of its own: an empty hot source.
    await writeProjectConfig(linked.path);

    const scope = await openAllProjects({
      cwd: linked.path,
      env: env(),
      includeArchiveForHot: true,
    });
    try {
      const handle = scope.projects.find((project) => project.projectId === PROJ_HOT);
      expect(handle?.hot).toBe(true);
      expect(handle?.store.getArtifact(ART_HOT)).toBeNull();
      expect(handle?.archiveStore?.getArtifact(ART_HOT)).not.toBeNull();
    } finally {
      scope.close();
    }
  });
});

describe('openCurrentProjectArchive', () => {
  it('does not mint identity for an unminted project', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    cleanups.push(() => repo.cleanup());
    const git = new Repo(repo.path);

    expect(
      await openCurrentProjectArchive({ repo: git, repoRoot: repo.path, env: env() })
    ).toBeNull();
    expect(await git.getLocalConfig(PROJECT_ID_CONFIG_KEY)).toBeNull();
  });

  it('opens an empty retained projection for an identified project without archive data', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    cleanups.push(() => repo.cleanup());
    const git = new Repo(repo.path);
    await git.setLocalConfig(PROJECT_ID_CONFIG_KEY, PROJ_HOT);

    const archive = await openCurrentProjectArchive({
      repo: git,
      repoRoot: repo.path,
      env: env(),
    });
    try {
      expect(archive?.projectId).toBe(PROJ_HOT);
      expect(archive?.store.listArtifacts({})).toEqual([]);
    } finally {
      archive?.close();
    }
  });
});

describe('openAllProjects — allowUnidentifiedHot', () => {
  it('surfaces an unreadable hot metadata path to strict consumers', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    cleanups.push(() => repo.cleanup());
    await symlink('.orcaops', path.join(repo.path, '.orcaops'));

    const tolerant = await openAllProjects({
      cwd: repo.path,
      env: env(),
      allowUnidentifiedHot: true,
    });
    try {
      expect(tolerant.unidentifiedHot).toBeUndefined();
    } finally {
      tolerant.close();
    }

    await expect(
      openAllProjects({
        cwd: repo.path,
        env: env(),
        allowUnidentifiedHot: true,
        throwOnHotOpenError: true,
      })
      // The config resolver refuses the symlinked metadata dir before any
      // loop is followed; either way the strict consumer sees the failure.
    ).rejects.toThrow(/orcaops configuration|ELOOP/);
  });

  it('can surface an initialized hot checkout configuration failure to strict consumers', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    cleanups.push(() => repo.cleanup());
    await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
    await writeFile(path.join(repo.path, '.orcaops', 'config.json'), '{ invalid json', 'utf8');

    const tolerant = await openAllProjects({
      cwd: repo.path,
      env: env(),
      allowUnidentifiedHot: true,
    });
    try {
      expect(tolerant.unidentifiedHot).toBeUndefined();
    } finally {
      tolerant.close();
    }

    await expect(
      openAllProjects({
        cwd: repo.path,
        env: env(),
        allowUnidentifiedHot: true,
        throwOnHotOpenError: true,
      })
    ).rejects.toThrow(/is not valid JSON/);
  });

  it('surfaces a .orcaops repo with no minted id as unidentifiedHot, leaves projects[] untouched, and never writes git config', async () => {
    // A governed repo with hot data but NO minted id.
    const repo = await createTempRepo({ initialBranch: 'main' });
    cleanups.push(() => repo.cleanup());
    await writeProjectConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config: getDefaultConfig() });
    await seedArtifact(store, ART_HOT, 'unarchived local work');
    cleanups.push(() => store.close());
    await access(path.join(repo.path, '.orcaops'));

    // An unrelated archived project, to prove projects[] is unaffected.
    await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);

    // Default (flag off): no unidentifiedHot, the repo is not a project, and
    // the drop is disclosed — an unminted repo has no archive dir, so no
    // other tier serves its rows.
    const off = await openAllProjects({ cwd: repo.path, env: env() });
    try {
      expect(off.unidentifiedHot).toBeUndefined();
      expect(off.projects.map((p) => p.projectId)).toEqual([PROJ_A]);
      expect(off.issues).toEqual([
        expect.objectContaining({
          kind: 'project_identity_unavailable',
          source: 'hot',
          project_id: null,
          project: path.basename(repo.path),
          message: expect.stringContaining('no minted orcaops project id'),
        }),
      ]);
    } finally {
      off.close();
    }

    // With the flag: unidentifiedHot populated, projects[] still only
    // archived, and NO identity issue — Watch runs with the flag on, and an
    // issue here would make its identity-retry loop re-open the scope every
    // tick.
    const on = await openAllProjects({ cwd: repo.path, env: env(), allowUnidentifiedHot: true });
    try {
      expect(on.unidentifiedHot).toBeDefined();
      expect(on.unidentifiedHot?.projectId).toBeNull();
      expect(on.unidentifiedHot?.displayName).toBe(path.basename(repo.path));
      expect(on.unidentifiedHot?.store.getArtifact(ART_HOT)?.status).toBe('active');
      expect(on.projects.map((p) => p.projectId)).toEqual([PROJ_A]);
      expect(on.issues).toEqual([]);
    } finally {
      on.close();
    }

    // Strictly read-only: watch never mints, so the repo still has no id.
    expect(await new Repo(repo.path).getLocalConfig(PROJECT_ID_CONFIG_KEY)).toBeNull();
  });

  it('keeps a readable hot store available while its project identity is invalid', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    cleanups.push(() => repo.cleanup());
    await writeProjectConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config: getDefaultConfig() });
    await seedArtifact(store, ART_HOT, 'local work under repair');
    cleanups.push(() => store.close());
    await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, 'not-a-uuid');

    const scope = await openAllProjects({
      cwd: repo.path,
      env: env(),
      allowUnidentifiedHot: true,
    });
    try {
      expect(scope.unidentifiedHot?.store.getArtifact(ART_HOT)?.status).toBe('active');
      expect(scope.unidentifiedHot?.projectId).toBeNull();
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'project_identity_unavailable',
          source: 'hot',
          message: expect.stringContaining('not a canonical UUIDv7'),
        }),
      ]);
    } finally {
      scope.close();
    }
  });
});

describe('readProjectId containment', () => {
  it('derives restore guidance only from unambiguous registry evidence', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const git = new Repo(repo.path);
      const [rootCommit] = await git.getRootCommitShas();
      const project = (rootCommits: string[]): Registry['projects'][string] => ({
        display_name: 'fixture',
        last_seen_paths: [],
        remotes: [],
        root_commit_shas: rootCommits,
        last_seen_at: '2026-08-08T00:00:00.000Z',
      });
      const unique: Registry = {
        schema_version: 1,
        projects: { [PROJ_A]: project([rootCommit]) },
      };
      expect(await projectIdentityRecoveryGuidance(git, unique)).toContain(
        `git config --local ${PROJECT_ID_CONFIG_KEY} ${PROJ_A}`
      );

      const ambiguous: Registry = {
        schema_version: 1,
        projects: {
          [PROJ_A]: project([rootCommit]),
          [PROJ_B]: project([rootCommit]),
        },
      };
      const guidance = await projectIdentityRecoveryGuidance(git, ambiguous);
      expect(guidance).toContain(PROJ_A);
      expect(guidance).toContain(PROJ_B);
      expect(guidance).toContain(`${PROJECT_ID_CONFIG_KEY} <id>`);
      expect(await git.getLocalConfig(PROJECT_ID_CONFIG_KEY)).toBeNull();
      expect(
        await projectIdentityRecoveryGuidance(git, { schema_version: 1, projects: {} })
      ).toContain('genuinely new repository');
    } finally {
      await repo.cleanup();
    }
  });

  it('serializes first-use minting across independent repository handles', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    let initialReads = 0;
    let writes = 0;
    let releaseInitialReads!: () => void;
    const initialReadsComplete = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });

    class RacingRepo extends Repo {
      override async getLocalConfig(key: string): Promise<string | null> {
        if (initialReads < 2) {
          initialReads += 1;
          if (initialReads === 2) releaseInitialReads();
          await initialReadsComplete;
          return null;
        }
        return super.getLocalConfig(key);
      }

      override async setLocalConfig(key: string, value: string): Promise<void> {
        writes += 1;
        await super.setLocalConfig(key, value);
      }
    }

    try {
      const results = await Promise.all([
        ensureProjectId(new RacingRepo(repo.path)),
        ensureProjectId(new RacingRepo(repo.path)),
      ]);
      expect(new Set(results.map((result) => result.projectId)).size).toBe(1);
      expect(results.map((result) => result.minted).sort()).toEqual([false, true]);
      expect(writes).toBe(1);
      expect(await readProjectId(new Repo(repo.path))).toBe(results[0]?.projectId);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses malformed, empty, or traversing stored identity instead of treating it as missing', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, '../../victim');
      await expect(readProjectId(new Repo(repo.path))).rejects.toBeInstanceOf(
        InvalidProjectIdentityError
      );
      await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, 'not-a-uuid');
      await expect(readProjectId(new Repo(repo.path))).rejects.toThrow(/not a canonical UUIDv7/);
      await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, '');
      await expect(readProjectId(new Repo(repo.path))).rejects.toThrow(/not a canonical UUIDv7/);
      await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, '   ');
      await expect(readProjectId(new Repo(repo.path))).rejects.toThrow(/not a canonical UUIDv7/);
    } finally {
      await repo.cleanup();
    }
  });

  it('surfaces empty, whitespace-only, and malformed identity through the multi-project reader', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    await writeProjectConfig(repo.path);
    try {
      await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
      for (const stored of ['', '   ', 'not-a-uuid']) {
        await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, stored);
        const scope = await openAllProjects({ cwd: repo.path, env: env() });
        try {
          expect(scope.projects).toEqual([]);
          expect(scope.issues).toEqual([
            expect.objectContaining({
              kind: 'project_identity_unavailable',
              source: 'hot',
              project_id: null,
              message: expect.stringContaining('not a canonical UUIDv7'),
            }),
          ]);
        } finally {
          scope.close();
        }
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('turns a config read failure into a typed error without minting', async () => {
    let wrote = false;
    const repo = {
      getLocalConfig: async () => {
        throw new Error('git failed');
      },
      setLocalConfig: async () => {
        wrote = true;
      },
    } as unknown as Repo;
    await expect(ensureProjectId(repo)).rejects.toBeInstanceOf(ProjectIdentityReadError);
    expect(wrote).toBe(false);
  });

  it('quarantines a noncanonical archive directory before opening an index', async () => {
    await makeArchiveProject(PROJ_A, 'rate limiting', ART_A);
    await mkdir(path.join(dataRoot, 'projects', 'not-a-uuid'), { recursive: true });

    const scope = await openAllProjects({ cwd: base, env: env() });
    try {
      expect(scope.projects.map((project) => project.projectId)).toEqual([PROJ_A]);
      expect(scope.issues).toEqual([
        expect.objectContaining({
          kind: 'project_identity_unavailable',
          source: 'archive',
          project_id: null,
          project: 'not-a-uuid',
          message: expect.stringContaining('not named with a canonical UUIDv7'),
        }),
      ]);
      await expect(access(projectIndexDbPath(indexRoot(env()), 'not-a-uuid'))).rejects.toThrow();
    } finally {
      scope.close();
    }
  });
});

describe('openCurrentProject — an enabled worktree with no data is an empty source', () => {
  it('serves the current project from memory and creates nothing on disk', async () => {
    const { clearCommonDirCache, commonConfigLocation } = await import('@orcaops/core');
    clearCommonDirCache();
    const main = await createTempRepo({ initialBranch: 'main' });
    const linked = await createLinkedWorktree(main.path);
    try {
      const shared = await commonConfigLocation(main.path);
      await mkdir(path.dirname(shared.configPath), { recursive: true });
      await writeFile(
        shared.configPath,
        JSON.stringify({
          schema_version: 6,
          install: { agents: ['claude-code'], scope: 'personal' },
        }),
        'utf8'
      );
      await new Repo(main.path).setLocalConfig(
        'orcaops.projectid',
        '019f0000-cccc-7000-8000-000000000003'
      );

      const scope = await openAllProjects({ cwd: linked.path, env: env() });
      try {
        const hot = scope.projects.find((project) => project.hot);
        expect(hot).toBeDefined();
        expect(hot?.store.listArtifacts().length).toBe(0);
      } finally {
        scope.close();
      }
      await expect(access(path.join(linked.path, '.orcaops'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await linked.cleanup();
      await main.cleanup();
      clearCommonDirCache();
    }
  });

  it('promotes the empty source after the worktree receives its first capture', async () => {
    const { clearCommonDirCache, commonConfigLocation } = await import('@orcaops/core');
    clearCommonDirCache();
    const main = await createTempRepo({ initialBranch: 'main' });
    const linked = await createLinkedWorktree(main.path);
    try {
      const shared = await commonConfigLocation(main.path);
      await mkdir(path.dirname(shared.configPath), { recursive: true });
      await writeFile(
        shared.configPath,
        JSON.stringify({
          schema_version: 6,
          install: { agents: ['claude-code'], scope: 'personal' },
          archive: { enabled: false },
        }),
        'utf8'
      );
      await new Repo(main.path).setLocalConfig(
        'orcaops.projectid',
        '019f0000-cccc-7000-8000-000000000004'
      );

      const scope = await openAllProjects({ cwd: linked.path, env: env() });
      try {
        const hot = scope.projects.find((project) => project.hot);
        expect(hot).toBeDefined();
        const closeEmpty = vi.spyOn(hot!.store, 'close');

        const writer = new ArtifactStore({
          repoRoot: linked.path,
          config: getDefaultConfig(),
        });
        await seedArtifact(writer, ART_HOT, 'first local capture');
        writer.close();

        await scope.prepareHotStoresForRead();
        expect(hot?.store.getArtifact(ART_HOT)?.task).toBe('first local capture');
        expect(closeEmpty).toHaveBeenCalledTimes(1);
      } finally {
        scope.close();
      }
    } finally {
      await linked.cleanup();
      await main.cleanup();
      clearCommonDirCache();
    }
  });
});
