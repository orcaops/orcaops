import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { ArchiveMirror, reviewEventIdentity } from './mirror.js';
import { archiveArtifactPaths, archiveProjectDir, archiveReviewPaths } from './paths.js';
import {
  ArchiveRestoreConcurrentChangeError,
  ArchiveRestoreDivergenceError,
  ArchiveRestoreNonPrefixError,
  ArchiveRestoreNotInFlightError,
  ArchiveRestoreSourceInvalidError,
  inspectArchivedArtifactAvailability,
  replaceHotArtifactFromArchive,
  restoreArtifactFromArchive,
  restoreReviewLogsFromArchive,
  type ReviewLogRestoreOptions,
} from './restore.js';
import { artifactPathsFor } from '../artifacts/paths.js';
import { ArtifactStore } from '../artifacts/store.js';
import { readEventLog } from '../events/event-log.js';
import { getDefaultConfig } from '../schema/config.js';

const restoreFaults = vi.hoisted(() => ({
  failStagingCleanup: false,
  stagingCleanupFailureCount: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (target: string | URL, options?: Parameters<typeof actual.rm>[1]) => {
      if (
        restoreFaults.failStagingCleanup &&
        String(target).includes('.archive-restore-staging-')
      ) {
        restoreFaults.stagingCleanupFailureCount += 1;
        throw new Error('staging cleanup failure');
      }
      return actual.rm(target, options);
    },
  };
});

/**
 * The reverse mirror. Worktree A captures (mirrored);
 * worktree B restores cold, continues the thread; a diverged hot log
 * refuses.
 */

const ARTIFACT_ID = '01999999-9999-7000-8000-00000000000c';
const STEP_1 = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
const STEP_2 = '01HX0K8N6ZQF8M5R2V8DZ7T3LY';

describe('restoreArtifactFromArchive', () => {
  let repoA: TempRepo;
  let repoB: TempRepo;
  let storeA: ArtifactStore;
  let storeB: ArtifactStore;
  let mirror: ArchiveMirror;
  let projectDir: string;

  beforeEach(async () => {
    repoA = await createTempRepo({ initialBranch: 'main' });
    repoB = await createTempRepo({ initialBranch: 'main' });
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-restore-'));
    projectDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    mirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(base, 'locks'),
      redactSecrets: false,
    });
    storeA = new ArtifactStore({
      repoRoot: repoA.path,
      config: getDefaultConfig(),
      archive: mirror,
    });
    // Worktree B has NO mirror (simulates a fresh clone before wiring).
    storeB = new ArtifactStore({ repoRoot: repoB.path, config: getDefaultConfig() });

    await storeA.writePlan(
      {
        schema_version: 4,
        artifact_id: ARTIFACT_ID,
        branch: 'feat/x',
        base_sha: 'abc123',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'handoff fixture',
        label: 'handoff fixture',
        plan_steps: [
          { step_id: STEP_1, text: 'step 1', label: 's1', acceptance_criteria: [] },
          { step_id: STEP_2, text: 'step 2', label: 's2', acceptance_criteria: [] },
        ],
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
      { idempotencyKey: 'plan-1' }
    );
    await storeA.writeCheckpointOpened(
      { artifact_id: ARTIFACT_ID, declared_step_ids: [STEP_1] },
      { idempotencyKey: 'open-1', headSha: 'cafef00d' }
    );
    await storeA.writeCheckpointClosed(
      {
        artifact_id: ARTIFACT_ID,
        n: 1,
        summary: 'step 1 done in worktree A',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_1],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: 'close-1' }
    );
  });

  afterEach(async () => {
    storeA.close();
    storeB.close();
    await repoA.cleanup();
    await repoB.cleanup();
  });

  it('cold-starts a fresh worktree: events copied, cache rows present, thread continues', async () => {
    const r = await restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });
    expect(r.events_copied).toBeGreaterThanOrEqual(3);
    expect(r.indexed).toBe(true);
    expect(storeB.store.projectionHealth).toBe('rebuild_pending');

    // Hot log byte-identical to the archive log.
    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    const archiveLog = await readFile(
      archiveArtifactPaths(projectDir, ARTIFACT_ID).eventsNdjson,
      'utf8'
    );
    expect(await readFile(hotPaths.eventsNdjson, 'utf8')).toBe(archiveLog);

    // Cache rows serve the resume path.
    expect(storeB.store.getArtifact(ARTIFACT_ID)?.task).toBe('handoff fixture');

    // Idempotent: a second restore copies nothing (checked BEFORE any
    // local-only writes, which would rightly be flagged as divergence).
    const again = await restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });
    expect(again.events_copied).toBe(0);

    // The thread CONTINUES in worktree B (recovery-on-read + cp 2).
    const open = await storeB.writeCheckpointOpened(
      { artifact_id: ARTIFACT_ID, declared_step_ids: [STEP_2] },
      { idempotencyKey: 'open-2', headSha: 'beefcafe' }
    );
    if (open.outcome !== 'created') throw new Error('expected created');
    expect(open.checkpoint.n).toBe(2);
  });

  it('requires pin-driven restores to remain in flight before writing hot state', async () => {
    expect(await inspectArchivedArtifactAvailability(projectDir, ARTIFACT_ID)).toMatchObject({
      kind: 'in_flight',
    });
    await storeA.writeSummary({
      schema_version: 1,
      artifact_id: ARTIFACT_ID,
      outcome: 'shipped',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'cafef00d',
      ts: '2026-07-02T12:30:00.000Z',
    });
    expect(await inspectArchivedArtifactAvailability(projectDir, ARTIFACT_ID)).toEqual({
      kind: 'summarized',
    });

    await expect(
      restoreArtifactFromArchive({
        repoRoot: repoB.path,
        config: getDefaultConfig(),
        store: storeB,
        projectDir,
        artifactId: ARTIFACT_ID,
        requireInFlight: true,
        archiveLock: mirror,
      })
    ).rejects.toBeInstanceOf(ArchiveRestoreNotInFlightError);
    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    await expect(readFile(hotPaths.eventsNdjson, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(storeB.store.getArtifact(ARTIFACT_ID)).toBeNull();
  });

  it('distinguishes a missing archive source from an unreadable one', async () => {
    const archivePath = archiveArtifactPaths(projectDir, ARTIFACT_ID).eventsNdjson;
    await rm(archivePath);
    expect(await inspectArchivedArtifactAvailability(projectDir, ARTIFACT_ID)).toEqual({
      kind: 'missing',
    });

    await mkdir(archivePath);
    expect(await inspectArchivedArtifactAvailability(projectDir, ARTIFACT_ID)).toMatchObject({
      kind: 'uncertain',
      reason: expect.any(String),
    });
  });

  it('refuses a state-gated restore without archive-side coordination', async () => {
    await expect(
      restoreArtifactFromArchive({
        repoRoot: repoB.path,
        config: getDefaultConfig(),
        store: storeB,
        projectDir,
        artifactId: ARTIFACT_ID,
        requireInFlight: true,
      })
    ).rejects.toThrow('cannot be proven without archive coordination');
    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    await expect(readFile(hotPaths.eventsNdjson, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('tops up only the suffix when hot is an exact ordered archive prefix', async () => {
    const archivePaths = archiveArtifactPaths(projectDir, ARTIFACT_ID);
    const archiveLog = await readFile(archivePaths.eventsNdjson, 'utf8');
    const archiveLines = archiveLog.trimEnd().split('\n');
    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    await mkdir(hotPaths.dir, { recursive: true });
    await writeFile(hotPaths.eventsNdjson, `${archiveLines.slice(0, 2).join('\n')}\n`, 'utf8');
    storeB.store.upsertArtifact({
      id: ARTIFACT_ID,
      branch: 'feat/x',
      task: 'handoff fixture',
      label: 'handoff fixture',
      agent: 'claude-code',
      base_sha: 'abc123',
      started_at: '2026-07-02T12:00:00.000Z',
      completed_at: null,
      status: 'active',
      non_goals: '[]',
    });
    storeB.store.setCloudSyncState(ARTIFACT_ID, {
      syncedAt: '2026-07-02T12:01:00.000Z',
      hash: 'prefix-hash',
      externalId: ARTIFACT_ID,
      orgId: 'org',
    });

    const result = await restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });

    expect(result.events_copied).toBe(archiveLines.length - 2);
    expect(await readFile(hotPaths.eventsNdjson, 'utf8')).toBe(archiveLog);
    expect(storeB.store.getCloudSyncRawHash(ARTIFACT_ID)).toMatch(/^dirty:[^:]+:prefix-hash$/);
  });

  it('refuses a diverged hot log (local events the archive lacks)', async () => {
    await restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });
    // Local-only progress in B (no mirror wired) → B diverges from the archive.
    await storeB.writeCheckpointOpened(
      { artifact_id: ARTIFACT_ID, declared_step_ids: [STEP_2] },
      { idempotencyKey: 'open-2', headSha: 'beefcafe' }
    );
    await expect(
      restoreArtifactFromArchive({
        repoRoot: repoB.path,
        config: getDefaultConfig(),
        store: storeB,
        projectDir,
        artifactId: ARTIFACT_ID,
      })
    ).rejects.toBeInstanceOf(ArchiveRestoreDivergenceError);
  });

  it('refuses a gappy non-prefix subset before writing and names explicit recovery', async () => {
    const archivePath = archiveArtifactPaths(projectDir, ARTIFACT_ID).eventsNdjson;
    const archiveLines = (await readFile(archivePath, 'utf8')).trimEnd().split('\n');
    expect(archiveLines.length).toBeGreaterThanOrEqual(3);
    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    await mkdir(hotPaths.dir, { recursive: true });
    const gappyHot = `${archiveLines[0]}\n${archiveLines.at(-1)}\n`;
    await writeFile(hotPaths.eventsNdjson, gappyHot, 'utf8');

    const restore = restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });

    await expect(restore).rejects.toBeInstanceOf(ArchiveRestoreNonPrefixError);
    await expect(restore).rejects.toThrow(
      `orcaops archive resolve --artifact ${ARTIFACT_ID} --source archive --apply`
    );
    expect(await readFile(hotPaths.eventsNdjson, 'utf8')).toBe(gappyHot);
  });

  it.each<[string, (raw: string) => string]>([
    ['a torn final line', (raw) => `${raw}{"truncated":`],
    [
      'a rotted interior checksum',
      (raw) => raw.replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`),
    ],
  ])('refuses to restore from an archive copy with %s', async (_shape, damage) => {
    const archivePath = archiveArtifactPaths(projectDir, ARTIFACT_ID).eventsNdjson;
    await writeFile(archivePath, damage(await readFile(archivePath, 'utf8')), 'utf8');

    const restore = restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });

    await expect(restore).rejects.toBeInstanceOf(ArchiveRestoreSourceInvalidError);
    await expect(restore).rejects.toThrow(/corrupt archive line/);
    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    await expect(readFile(hotPaths.eventsNdjson, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('canonically replaces hot from archive with backup and projection/cache refresh', async () => {
    await restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });
    await storeB.writeCheckpointOpened(
      { artifact_id: ARTIFACT_ID, declared_step_ids: [STEP_2] },
      { idempotencyKey: 'local-open-2', headSha: 'beefcafe' }
    );
    await storeB.writeCheckpointClosed(
      {
        artifact_id: ARTIFACT_ID,
        n: 2,
        summary: 'LocalOnlySentinel',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_2],
        head_sha: 'beefcafe',
      },
      { idempotencyKey: 'local-close-2' }
    );

    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    const archivePaths = archiveArtifactPaths(projectDir, ARTIFACT_ID);
    const hotBefore = await readFile(hotPaths.eventsNdjson, 'utf8');
    const hotRead = await readEventLog({
      eventLogPath: hotPaths.eventsNdjson,
      sidecarsDir: hotPaths.sidecarsDir,
    });
    const archiveRead = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    expect(storeB.store.search('LocalOnlySentinel')).toHaveLength(1);
    await writeFile(hotPaths.resumeMd, 'stale local resume', 'utf8');
    // Populate the recovered-checkpoint cache pre-replace: the replace
    // path mutates the hot log directly; with no read cache, the
    // same-store read below must observe the restored state.
    const preReplace = await storeB.readCheckpoints(ARTIFACT_ID);
    expect(preReplace.map((cp) => cp.n)).toContain(2);

    const result = await replaceHotArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
      expectedHotEventIds: hotRead.events.map((event) => event.event_id),
      expectedHotCorruptLines: 0,
      expectedArchiveEventIds: archiveRead.events.map((event) => event.event_id),
    });

    expect(result).toMatchObject({
      events_installed: archiveRead.events.length,
      backup_path: expect.any(String),
      indexed: true,
    });
    expect(await readFile(path.join(result.backup_path, 'events.ndjson'), 'utf8')).toBe(hotBefore);
    expect(await readFile(hotPaths.eventsNdjson, 'utf8')).toBe(
      await readFile(archivePaths.eventsNdjson, 'utf8')
    );
    expect(storeB.store.getArtifact(ARTIFACT_ID)?.task).toBe('handoff fixture');
    expect(storeB.store.listArtifacts().map((artifact) => artifact.id)).toContain(ARTIFACT_ID);
    expect(storeB.store.search('handoff').map((row) => row.artifact_id)).toContain(ARTIFACT_ID);
    expect(storeB.store.search('LocalOnlySentinel')).toEqual([]);
    await expect(access(hotPaths.checkpointJson(2))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(hotPaths.resumeMd)).rejects.toMatchObject({ code: 'ENOENT' });
    // Same-store read reflects the replaced log — cp 2 is gone.
    const postReplace = await storeB.readCheckpoints(ARTIFACT_ID);
    expect(postReplace.map((cp) => cp.n)).not.toContain(2);
  });

  it('leaves both sources untouched when the observed hot sequence changed', async () => {
    await restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });
    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    const archivePaths = archiveArtifactPaths(projectDir, ARTIFACT_ID);
    const observedHot = await readEventLog({
      eventLogPath: hotPaths.eventsNdjson,
      sidecarsDir: hotPaths.sidecarsDir,
    });
    const observedArchive = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    await storeB.writeCheckpointOpened(
      { artifact_id: ARTIFACT_ID, declared_step_ids: [STEP_2] },
      { idempotencyKey: 'concurrent-open-2', headSha: 'beefcafe' }
    );
    const hotAfterChange = await readFile(hotPaths.eventsNdjson, 'utf8');
    const archiveBefore = await readFile(archivePaths.eventsNdjson, 'utf8');

    await expect(
      replaceHotArtifactFromArchive({
        repoRoot: repoB.path,
        config: getDefaultConfig(),
        store: storeB,
        projectDir,
        artifactId: ARTIFACT_ID,
        expectedHotEventIds: observedHot.events.map((event) => event.event_id),
        expectedHotCorruptLines: 0,
        expectedArchiveEventIds: observedArchive.events.map((event) => event.event_id),
      })
    ).rejects.toBeInstanceOf(ArchiveRestoreConcurrentChangeError);
    expect(await readFile(hotPaths.eventsNdjson, 'utf8')).toBe(hotAfterChange);
    expect(await readFile(archivePaths.eventsNdjson, 'utf8')).toBe(archiveBefore);
  });

  it('refuses replacement from a corrupt archive and leaves both sources untouched', async () => {
    await restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });
    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    const archivePaths = archiveArtifactPaths(projectDir, ARTIFACT_ID);
    const observedHot = await readEventLog({
      eventLogPath: hotPaths.eventsNdjson,
      sidecarsDir: hotPaths.sidecarsDir,
    });
    const observedArchive = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    await appendFile(archivePaths.eventsNdjson, '{"truncated":', 'utf8');
    const hotBefore = await readFile(hotPaths.eventsNdjson, 'utf8');
    const archiveBefore = await readFile(archivePaths.eventsNdjson, 'utf8');

    const replace = replaceHotArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
      expectedHotEventIds: observedHot.events.map((event) => event.event_id),
      expectedHotCorruptLines: 0,
      expectedArchiveEventIds: observedArchive.events.map((event) => event.event_id),
    });

    await expect(replace).rejects.toBeInstanceOf(ArchiveRestoreSourceInvalidError);
    await expect(replace).rejects.toThrow(/corrupt archive line/);
    expect(await readFile(hotPaths.eventsNdjson, 'utf8')).toBe(hotBefore);
    expect(await readFile(archivePaths.eventsNdjson, 'utf8')).toBe(archiveBefore);
  });

  it('preserves a redirected-backup error when staging cleanup also fails', async () => {
    await restoreArtifactFromArchive({
      repoRoot: repoB.path,
      config: getDefaultConfig(),
      store: storeB,
      projectDir,
      artifactId: ARTIFACT_ID,
    });
    const hotPaths = artifactPathsFor(repoB.path, getDefaultConfig(), ARTIFACT_ID);
    const archivePaths = archiveArtifactPaths(projectDir, ARTIFACT_ID);
    const hotBefore = await readFile(hotPaths.eventsNdjson, 'utf8');
    const hot = await readEventLog({
      eventLogPath: hotPaths.eventsNdjson,
      sidecarsDir: hotPaths.sidecarsDir,
      containmentRoot: repoB.path,
    });
    const archived = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-restore-outside-'));
    const sentinel = path.join(outside, 'sentinel');
    await writeFile(sentinel, 'unchanged', 'utf8');
    await symlink(outside, path.join(hotPaths.dir, 'restore-backups'));
    restoreFaults.failStagingCleanup = true;
    restoreFaults.stagingCleanupFailureCount = 0;
    try {
      await expect(
        replaceHotArtifactFromArchive({
          repoRoot: repoB.path,
          config: getDefaultConfig(),
          store: storeB,
          projectDir,
          artifactId: ARTIFACT_ID,
          expectedHotEventIds: hot.events.map((event) => event.event_id),
          expectedHotCorruptLines: hot.corrupt.length,
          expectedArchiveEventIds: archived.events.map((event) => event.event_id),
        })
      ).rejects.toThrow(/must not contain symlinks/);
      expect(restoreFaults.stagingCleanupFailureCount).toBe(1);
      expect(await readFile(hotPaths.eventsNdjson, 'utf8')).toBe(hotBefore);
      expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
    } finally {
      restoreFaults.failStagingCleanup = false;
      restoreFaults.stagingCleanupFailureCount = 0;
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('throws a clear error when the artifact is not archived', async () => {
    await expect(
      restoreArtifactFromArchive({
        repoRoot: repoB.path,
        config: getDefaultConfig(),
        store: storeB,
        projectDir,
        artifactId: '01999999-9999-7000-8000-0000000000ff',
      })
    ).rejects.toThrow(/not in the archive/);
  });
});

describe('restoreReviewLogsFromArchive', () => {
  const SLUG = 'feat%2Fx';

  function restoreOptions(
    repoRoot: string,
    projectDir: string,
    reviewStateVersion = 3
  ): ReviewLogRestoreOptions {
    return {
      repoRoot,
      projectDir,
      reviewStateVersion,
      archiveLock: new ArchiveMirror({
        projectDir,
        locksDir: path.join(projectDir, '..', 'locks'),
        redactSecrets: false,
      }),
      withHotReviewLocks: (_slug, fn) => fn(),
      validateReviewLogs: async (journalFile, commentsFile) => {
        for (const file of [journalFile, commentsFile]) {
          let raw: string;
          try {
            raw = await readFile(file, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          for (const line of raw.split('\n').filter(Boolean)) JSON.parse(line);
        }
      },
    };
  }

  async function seedArchivedReview(
    projectDir: string
  ): Promise<{ journal: string; comments: string }> {
    const mirror = new ArchiveMirror({
      projectDir,
      locksDir: path.join(projectDir, '..', 'locks'),
      redactSecrets: false,
    });
    const journalRaw = [
      JSON.stringify({
        type: 'section',
        ts: '2026-08-11T10:00:00.000Z',
        threadKey: 'S1',
        action: 'VISIT',
      }),
      JSON.stringify({
        type: 'section',
        ts: '2026-08-11T10:01:00.000Z',
        threadKey: 'S1',
        action: 'MARK_REVIEWED',
      }),
    ];
    const commentsRaw = [
      JSON.stringify({
        type: 'add',
        comment_id: 'c1',
        ts: '2026-08-11T10:02:00.000Z',
        author: 'reviewer',
        body: 'why?',
        anchor: {
          kind: 'DIFF_LINE',
          file: 'src/a.ts',
          side: 'add',
          line: 1,
          lineHash: 'line-hash',
        },
      }),
    ];
    for (const raw of journalRaw) {
      await mirror.mirrorReviewEvent(3, SLUG, 'journal', raw, reviewEventIdentity(raw));
    }
    for (const raw of commentsRaw) {
      await mirror.mirrorReviewEvent(3, SLUG, 'comments', raw, reviewEventIdentity(raw));
    }
    return { journal: `${journalRaw.join('\n')}\n`, comments: `${commentsRaw.join('\n')}\n` };
  }

  it('rehydrates the hot review logs from the archive, byte-identical', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-restore-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    await mkdir(repoRoot, { recursive: true });
    const expected = await seedArchivedReview(projDir);
    // Byte-identical to the archived logs.
    const archive = archiveReviewPaths(projDir, 3, SLUG);
    expect(await readFile(archive.journalNdjson, 'utf8')).toBe(expected.journal);

    // Hot worktree is empty (fresh cold-start).
    const result = await restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir));
    expect(result.lines_copied).toBe(3);
    expect(result.slugs).toEqual([{ slug: SLUG, journal_lines: 2, comments_lines: 1 }]);

    const hotJournal = path.join(repoRoot, '.orcaops', 'reviews', SLUG, 'journal.ndjson');
    const hotComments = path.join(repoRoot, '.orcaops', 'reviews', SLUG, 'comments.ndjson');
    expect(await readFile(hotJournal, 'utf8')).toBe(expected.journal);
    expect(await readFile(hotComments, 'utf8')).toBe(expected.comments);

    // Idempotent: a second restore copies nothing.
    const again = await restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir));
    expect(again.lines_copied).toBe(0);
    expect(again.slugs).toEqual([]);
  });

  it('tops up only the lines a partial hot log lacks', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-topup-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    const expected = await seedArchivedReview(projDir);
    // Pre-seed the hot journal with the FIRST archived line only.
    const hotDir = path.join(repoRoot, '.orcaops', 'reviews', SLUG);
    const firstJournalLine = expected.journal.split('\n')[0]!;
    await mkdir(hotDir, { recursive: true });
    await writeFile(
      path.join(hotDir, 'review-state.json'),
      `${JSON.stringify({ review_state_version: 3 })}\n`
    );
    await writeFile(path.join(hotDir, 'journal.ndjson'), `${firstJournalLine}\n`, 'utf8');

    const result = await restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir));
    // Only the second journal line + the one comment are new.
    expect(result.slugs).toEqual([{ slug: SLUG, journal_lines: 1, comments_lines: 1 }]);
    expect(await readFile(path.join(hotDir, 'journal.ndjson'), 'utf8')).toBe(expected.journal);
  });

  it('refuses both logs before writing when either hot log is not an archive prefix', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-diverged-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    await mkdir(repoRoot, { recursive: true });
    await seedArchivedReview(projDir);
    const hotDir = path.join(repoRoot, '.orcaops', 'reviews', SLUG);
    const localComment = `${JSON.stringify({
      type: 'add',
      comment_id: 'local',
      ts: '2026-08-11T10:03:00.000Z',
      author: 'reviewer',
      body: 'local',
      anchor: {
        kind: 'DIFF_LINE',
        file: 'src/local.ts',
        side: 'add',
        line: 1,
        lineHash: 'local-line',
      },
    })}\n`;
    await mkdir(hotDir, { recursive: true });
    await writeFile(
      path.join(hotDir, 'review-state.json'),
      `${JSON.stringify({ review_state_version: 3 })}\n`
    );
    await writeFile(path.join(hotDir, 'comments.ndjson'), localComment);

    await expect(
      restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir))
    ).rejects.toMatchObject({ code: 'ARCHIVE_REVIEW_RESTORE_DIVERGENCE' });
    await expect(readFile(path.join(hotDir, 'journal.ndjson'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(hotDir, 'comments.ndjson'), 'utf8')).toBe(localComment);
  });

  it('refuses a symlinked hot review directory without touching its target', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-symlink-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    const outside = path.join(base, 'outside');
    await mkdir(path.join(repoRoot, '.orcaops', 'reviews'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await seedArchivedReview(projDir);
    const sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'unchanged');
    await symlink(outside, path.join(repoRoot, '.orcaops', 'reviews', SLUG), 'dir');

    await expect(restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir))).rejects.toThrow(
      /must not contain symlinks/
    );
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
    await expect(readFile(path.join(outside, 'journal.ndjson'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses symlinked archive log files without importing external bytes', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-archive-link-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    await mkdir(repoRoot, { recursive: true });
    await seedArchivedReview(projDir);
    const archive = archiveReviewPaths(projDir, 3, SLUG);
    const outside = path.join(base, 'outside-journal.ndjson');
    await writeFile(outside, `${JSON.stringify({ external: true })}\n`);
    await rm(archive.journalNdjson);
    await symlink(outside, archive.journalNdjson);

    await expect(restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir))).rejects.toThrow(
      /must not contain symlinks/
    );
    await expect(
      readFile(path.join(repoRoot, '.orcaops', 'reviews', SLUG, 'journal.ndjson'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a dangling symlink in the archived reviews root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-root-link-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    await mkdir(projDir, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await symlink(path.join(base, 'missing-reviews'), path.join(projDir, 'reviews'), 'dir');

    await expect(restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir))).rejects.toThrow(
      /must not contain symlinks/
    );
  });

  it('refuses a symlinked archived review slug instead of reporting an empty restore', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-slug-link-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    const reviewsRoot = path.join(projDir, 'reviews', 'v3');
    const outside = path.join(base, 'outside-review');
    await mkdir(reviewsRoot, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(reviewsRoot, SLUG), 'dir');

    await expect(restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir))).rejects.toThrow(
      /must not be a symlink/
    );
  });

  it('refuses symlinked hot marker files without reading external state', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-marker-link-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    await seedArchivedReview(projDir);
    const hotDir = path.join(repoRoot, '.orcaops', 'reviews', SLUG);
    const outside = path.join(base, 'outside-marker.json');
    await mkdir(hotDir, { recursive: true });
    await writeFile(outside, `${JSON.stringify({ review_state_version: 3 })}\n`);
    await symlink(outside, path.join(hotDir, 'review-state.json'));

    await expect(restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir))).rejects.toThrow(
      /must not contain symlinks/
    );
    await expect(readFile(path.join(hotDir, 'journal.ndjson'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses an unterminated archive line before creating hot review state', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-torn-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    await mkdir(repoRoot, { recursive: true });
    await seedArchivedReview(projDir);
    const archive = archiveReviewPaths(projDir, 3, SLUG);
    await writeFile(
      archive.commentsNdjson,
      (await readFile(archive.commentsNdjson, 'utf8')).trimEnd()
    );

    await expect(restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir))).rejects.toThrow(
      /unterminated final line/
    );
    await expect(
      readFile(path.join(repoRoot, '.orcaops', 'reviews', SLUG, 'review-state.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores only from its own version namespace — a vN restore never replays vN-1 bytes', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-vercut-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    await mkdir(repoRoot, { recursive: true });
    const expected = await seedArchivedReview(projDir);
    const v3Archive = archiveReviewPaths(projDir, 3, SLUG);
    const v3JournalBefore = await readFile(v3Archive.journalNdjson, 'utf8');

    // NOT cut-discriminating: the version literals here are passed straight
    // through as parameters, so this pins the version-agnostic namespace
    // property — a restore reads ONLY its own version namespace, and a vN
    // restore over a vN-1-only archive restores nothing and writes no hot
    // state. (The literal-version refusal of pre-cut state is pinned by the
    // review-state gate's own tests.)
    const result = await restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir, 4));
    expect(result).toEqual({ slugs: [], lines_copied: 0 });
    await expect(
      readFile(path.join(repoRoot, '.orcaops', 'reviews', SLUG, 'journal.ndjson'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // The archived v3 bytes are untouched.
    expect(await readFile(v3Archive.journalNdjson, 'utf8')).toBe(v3JournalBefore);
    expect(v3JournalBefore).toBe(expected.journal);

    // New v4 logs mirror into their own namespace and restore from it.
    const mirror = new ArchiveMirror({
      projectDir: projDir,
      locksDir: path.join(projDir, '..', 'locks'),
      redactSecrets: false,
    });
    const v4Raw = JSON.stringify({
      type: 'section',
      ts: '2026-08-11T10:09:00.000Z',
      threadKey: 'S9',
      action: 'VISIT',
    });
    await mirror.mirrorReviewEvent(4, SLUG, 'journal', v4Raw, reviewEventIdentity(v4Raw));
    const v4Result = await restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir, 4));
    expect(v4Result.slugs).toEqual([{ slug: SLUG, journal_lines: 1, comments_lines: 0 }]);
    expect(
      await readFile(path.join(repoRoot, '.orcaops', 'reviews', SLUG, 'journal.ndjson'), 'utf8')
    ).toBe(`${v4Raw}\n`);
  });

  it('returns empty when the project has no archived reviews', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-none-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const result = await restoreReviewLogsFromArchive(
      restoreOptions(path.join(base, 'worktree'), projDir)
    );
    expect(result).toEqual({ slugs: [], lines_copied: 0 });
  });

  it('never imports an unversioned v2 archive into v3 live state', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'orcaops-review-v2-archive-'));
    const projDir = archiveProjectDir(path.join(base, 'archive'), 'proj-1');
    const repoRoot = path.join(base, 'worktree');
    const legacyDir = path.join(projDir, 'reviews', SLUG);
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, 'journal.ndjson'),
      `${JSON.stringify({
        type: 'review_lifecycle',
        review_basis: 'NARRATIVE',
        narrative_generation: 'legacy',
      })}\n`
    );

    const result = await restoreReviewLogsFromArchive(restoreOptions(repoRoot, projDir));
    expect(result).toEqual({ slugs: [], lines_copied: 0 });
    await expect(
      readFile(path.join(repoRoot, '.orcaops', 'reviews', SLUG, 'journal.ndjson'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
