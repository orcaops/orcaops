import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  openProjectIndex,
  readProjectIndexMeta,
  refreshProjectIndex,
  resolveJournalFallback,
} from './global-index.js';
import { ArchiveMirror, USAGE_MIRROR_LOCK_ID } from './mirror.js';
import {
  archiveArtifactPaths,
  archiveLocksDir,
  archiveProjectDir,
  archiveUsageLedgerPaths,
  projectIndexDbPath,
  projectIndexMetaPath,
} from './paths.js';
import { usageLedgerPath, usageSidecarsDir } from '../artifacts/paths.js';
import { ArtifactStore } from '../artifacts/store.js';
import { ArtifactLock, ArtifactLockTimeoutError } from '../locks.js';
import { getDefaultConfig } from '../schema/config.js';
import { CURRENT_VERSION } from '../store/migrations/index.js';
import { Store } from '../store/sqlite.js';
import { appendUsageLedgerRecord } from '../usage/ledger-log.js';

/**
 * Per-project disposable index over archive events. Fixtures
 * are REAL lifecycles: an ArtifactStore with a write-through mirror, so
 * the archive contains exactly what production mirroring produces.
 */

const STEP_ID = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';

interface Project {
  repo: TempRepo;
  store: ArtifactStore;
  projectId: string;
  projectDir: string;
}

let base: string;
let dataRoot: string;
let indexRoot: string;
let projects: Project[] = [];

async function makeProject(projectId: string, task: string, artifactId: string): Promise<Project> {
  const repo = await createTempRepo({ initialBranch: 'main' });
  const projectDir = archiveProjectDir(dataRoot, projectId);
  const mirror = new ArchiveMirror({
    projectDir,
    locksDir: archiveLocksDir(indexRoot, projectId),
    redactSecrets: false,
  });
  const store = new ArtifactStore({
    repoRoot: repo.path,
    config: getDefaultConfig(),
    archive: mirror,
  });
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
      summary: `finished ${task} with sliding window`,
      files_changed: ['src/x.ts'],
      decisions: [],
      uncertainty: ['ttl strategy'],
      done_criteria: [],
      verification: [{ command: 'pnpm test', exit_code: 0 }],
      completed_step_ids: [STEP_ID],
      head_sha: 'cafef00d',
    },
    { idempotencyKey: `close-${artifactId}` }
  );
  const project = { repo, store, projectId, projectDir };
  projects.push(project);
  return project;
}

async function mirrorUsageSnapshot(p: Project, key: string): Promise<void> {
  const hotLedger = {
    ledgerPath: usageLedgerPath(p.repo.path),
    sidecarsDir: usageSidecarsDir(p.repo.path),
  };
  const usage = {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const record = await appendUsageLedgerRecord(
    {
      type: 'agent_usage_snapshot_recorded',
      ts: '2026-07-02T12:30:00.000Z',
      idempotency_key: key,
      payload: {
        snapshot_id: `snap-${key}`,
        idempotency_key: key,
        agent: 'claude-code',
        session_id: 'sess-1',
        artifact_id: null,
        source_plan_ref_id: null,
        lifecycle_event: 'plan',
        checkpoint_n: null,
        cumulative_usage: usage,
        delta_usage: null,
        baseline_kind: 'first_observation',
        model_breakdown: [],
        record_count: 1,
        as_of: '2026-07-02T12:30:00.000Z',
      },
    },
    hotLedger
  );
  const mirror = new ArchiveMirror({
    projectDir: p.projectDir,
    locksDir: archiveLocksDir(indexRoot, p.projectId),
    redactSecrets: false,
  });
  await mirror.mirrorUsageRecord(record, hotLedger.sidecarsDir, path.dirname(hotLedger.ledgerPath));
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'orcaops-gidx-'));
  dataRoot = path.join(base, 'archive');
  indexRoot = path.join(base, 'index');
  projects = [];
});

afterEach(async () => {
  for (const p of projects) {
    p.store.close();
    await p.repo.cleanup();
  }
});

const ART_A = '01999999-9999-7000-8000-0000000000aa';
const ART_B = '01999999-9999-7000-8000-0000000000bb';

async function withoutEventType(
  projectDir: string,
  artifactId: string,
  eventType: string
): Promise<string> {
  const logPath = archiveArtifactPaths(projectDir, artifactId).eventsNdjson;
  const original = await readFile(logPath, 'utf8');
  const filtered = original
    .trimEnd()
    .split('\n')
    .filter((line) => (JSON.parse(line) as { type: string }).type !== eventType)
    .join('\n');
  await writeFile(logPath, `${filtered}\n`, 'utf8');
  return original;
}

async function rotCheckpointClosedChecksum(projectDir: string, artifactId: string): Promise<void> {
  const logPath = archiveArtifactPaths(projectDir, artifactId).eventsNdjson;
  const lines = (await readFile(logPath, 'utf8')).trimEnd().split('\n');
  const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
  if (i === -1) throw new Error('no close line in fixture');
  lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
  await writeFile(logPath, lines.join('\n') + '\n', 'utf8');
}

describe('global index — ingest from archive events', () => {
  it.each([false, true])(
    'isolates an unreadable artifact high-water when memory index=%s',
    async (memoryIndex) => {
      const good = await makeProject('proj-a', 'healthy archive', ART_A);
      const bad = await makeProject('proj-a', 'unreadable archive', ART_B);
      const badLog = archiveArtifactPaths(bad.projectDir, ART_B).eventsNdjson;
      await rm(badLog);
      await symlink(badLog, badLog);
      if (memoryIndex) {
        await mkdir(projectIndexDbPath(indexRoot, 'proj-a'), { recursive: true });
      }

      const idx = await openProjectIndex(indexRoot, 'proj-a');
      const result = await refreshProjectIndex(good.projectDir, idx, indexRoot, 'proj-a');

      expect(idx.store.getArtifact(ART_A)).not.toBeNull();
      expect(idx.store.getArtifact(ART_B)).toBeNull();
      expect(result.artifact_issues).toEqual([
        expect.objectContaining({ kind: 'artifact_unavailable', artifact_id: ART_B }),
      ]);
      idx.close();
    }
  );

  it(
    'two projects yield rows, interval timestamps, FTS hits, and usage rollups',
    { timeout: 30_000 },
    async () => {
      const a = await makeProject('proj-a', 'rate limiting', ART_A);
      const b = await makeProject('proj-b', 'schema migration', ART_B);
      await mirrorUsageSnapshot(a, 'usage-a-1');

      for (const p of [a, b]) {
        const idx = await openProjectIndex(indexRoot, p.projectId);
        expect(idx.journalMode).toBe('wal');
        const r = await refreshProjectIndex(p.projectDir, idx, indexRoot, p.projectId);
        expect(r.ingested_artifacts).toBe(1);

        const artifactId = p.projectId === 'proj-a' ? ART_A : ART_B;
        const artifact = idx.store.getArtifact(artifactId);
        expect(artifact?.status).toBe('active');

        const cp = idx.store.db
          .prepare(
            'SELECT opened_at, closed_at, abandoned_at FROM checkpoints WHERE artifact_id = ?'
          )
          .get(artifactId) as {
          opened_at: string;
          closed_at: string | null;
          abandoned_at: string | null;
        };
        expect(cp.opened_at.length).toBeGreaterThan(0);
        expect(cp.closed_at?.length).toBeGreaterThan(0);
        expect(cp.abandoned_at).toBeNull();
        idx.close();
      }

      // FTS + usage on project A specifically.
      const idxA = await openProjectIndex(indexRoot, 'proj-a');
      await refreshProjectIndex(a.projectDir, idxA, indexRoot, 'proj-a');
      const hits = idxA.store.search('sliding window', {});
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].artifact_id).toBe(ART_A);
      const usageCount = idxA.store.db
        .prepare('SELECT COUNT(*) AS c FROM usage_snapshots')
        .get() as {
        c: number;
      };
      expect(usageCount.c).toBe(1);
      idxA.close();
    }
  );

  it('incremental refresh skips unchanged artifacts and picks up new events', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    const first = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(first.ingested_artifacts).toBe(1);

    const second = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(second.ingested_artifacts).toBe(0);
    expect(second.skipped_artifacts).toBe(1);
    expect(second.meta.generation).toBe(first.meta.generation);

    // New event (summary) → the artifact re-ingests.
    await a.store.writeSummary(
      {
        schema_version: 1,
        artifact_id: ART_A,
        outcome: 'done and dusted',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'sha-final',
        ts: '2026-07-02T13:00:00.000Z',
      },
      { idempotencyKey: 'sum-1' }
    );
    const third = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(third.ingested_artifacts).toBe(1);
    expect(idx.store.getArtifact(ART_A)?.status).toBe('complete');
    idx.close();
  });

  it('retries a stale concurrent refresh before publishing its generation', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idxA = await openProjectIndex(indexRoot, 'proj-a');
    const initial = await refreshProjectIndex(a.projectDir, idxA, indexRoot, 'proj-a');
    expect(initial.meta.generation).toBe(1);
    const idxB = await openProjectIndex(indexRoot, 'proj-a');
    await a.store.writeSummary(
      {
        schema_version: 1,
        artifact_id: ART_A,
        outcome: 'done and dusted',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'sha-final',
        ts: '2026-07-02T13:00:00.000Z',
      },
      { idempotencyKey: 'sum-concurrent-refresh' }
    );

    const lock = new ArtifactLock({ locksDir: archiveLocksDir(indexRoot, 'proj-a') });
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = lock.withLock(ART_A, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await enteredPromise;

    const first = refreshProjectIndex(a.projectDir, idxA, indexRoot, 'proj-a');
    const second = refreshProjectIndex(a.projectDir, idxB, indexRoot, 'proj-a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await held;

    const results = await Promise.all([first, second]);
    const generations = results
      .map((result) => result.meta.generation)
      .sort((left, right) => left - right);
    expect(generations).toEqual([2, 2]);
    expect(idxA.meta.generation).toBe(2);
    expect(idxB.meta.generation).toBe(2);
    expect(idxA.store.getArtifact(ART_A)?.status).toBe('complete');
    expect(idxB.store.getArtifact(ART_A)?.status).toBe('complete');
    idxA.close();
    idxB.close();
  });

  it('realigns metadata when publication succeeds but lock cleanup fails', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    const initial = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(initial.meta.generation).toBe(1);
    await a.store.writeSummary(
      {
        schema_version: 1,
        artifact_id: ART_A,
        outcome: 'done and dusted',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'sha-final',
        ts: '2026-07-02T13:00:00.000Z',
      },
      { idempotencyKey: 'sum-publication-release-failure' }
    );

    const lockSpy = vi
      .spyOn(ArtifactLock.prototype, 'withLock')
      .mockImplementation(async (artifactId, callback) => {
        const result = await callback({
          assert: async () => undefined,
          verify: async () => undefined,
        });
        if (artifactId === 'archive-index-publication') throw new Error('release failed');
        return result;
      });
    try {
      await expect(refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a')).rejects.toThrow(
        'release failed'
      );
      expect(idx.store.getArtifact(ART_A)?.status).toBe('complete');
      expect(idx.meta.generation).toBe(2);
      expect(idx.meta.artifacts[ART_A]).toBeDefined();
    } finally {
      lockSpy.mockRestore();
      idx.close();
    }
  });

  it('rejects metadata when SQLite generation advances during alignment', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const seed = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, seed, indexRoot, 'proj-a');
    seed.close();

    const writer = await openProjectIndex(indexRoot, 'proj-a');
    const originalListArtifacts = Store.prototype.listArtifacts;
    let advanced = false;
    const listSpy = vi.spyOn(Store.prototype, 'listArtifacts').mockImplementation(function (
      this: Store
    ) {
      if (!advanced && this !== writer.store) {
        advanced = true;
        writer.store.db
          .prepare(
            `UPDATE schema_meta SET value = '2'
             WHERE key = 'archive_refresh_generation'`
          )
          .run();
      }
      return originalListArtifacts.call(this);
    });
    let reader: Awaited<ReturnType<typeof openProjectIndex>> | undefined;
    try {
      reader = await openProjectIndex(indexRoot, 'proj-a');
      expect(reader.journalMode).not.toBe('memory');
      expect(advanced).toBe(true);
      expect(reader.meta.generation).toBe(0);
      expect(reader.meta.artifacts).toEqual({});
    } finally {
      listSpy.mockRestore();
      reader?.close();
      writer.close();
    }
  });

  it('keeps the prior generation in service when a changed artifact lock times out', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    const initial = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    await a.store.writeSummary(
      {
        schema_version: 1,
        artifact_id: ART_A,
        outcome: 'done and dusted',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'sha-final',
        ts: '2026-07-02T13:00:00.000Z',
      },
      { idempotencyKey: 'sum-lock-timeout' }
    );
    const lockSpy = vi
      .spyOn(ArtifactLock.prototype, 'withLock')
      .mockRejectedValueOnce(new ArtifactLockTimeoutError(ART_A, 10_000));
    try {
      const result = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
      expect(idx.store.getArtifact(ART_A)?.status).toBe('active');
      expect(result.meta.artifacts[ART_A]).toEqual(initial.meta.artifacts[ART_A]);
      expect(result.index_issues).toEqual([
        expect.objectContaining({
          kind: 'index_degraded',
          message: expect.stringContaining('prior indexed generation remains in service'),
        }),
      ]);
    } finally {
      lockSpy.mockRestore();
      idx.close();
    }
  });

  it('treats a locked-restat disappearance as deletion, not a mixed projection', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    await a.store.writeSummary(
      {
        schema_version: 1,
        artifact_id: ART_A,
        outcome: 'done and dusted',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'sha-final',
        ts: '2026-07-02T13:00:00.000Z',
      },
      { idempotencyKey: 'sum-disappears-under-lock' }
    );

    const lock = new ArtifactLock({ locksDir: archiveLocksDir(indexRoot, 'proj-a') });
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = lock.withLock(ART_A, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await enteredPromise;
    const refresh = refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson);
    release();
    await held;

    const result = await refresh;
    expect(idx.store.getArtifact(ART_A)).toBeNull();
    expect(result.meta.artifacts[ART_A]).toBeUndefined();
    idx.close();
  });

  it('isolates non-ENOENT stat failures to the affected artifact', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    const logPath = archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson;
    await rm(logPath);
    await symlink(path.basename(logPath), logPath);

    const result = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(idx.store.getArtifact(ART_A)).toBeNull();
    expect(result.artifact_issues).toEqual([
      expect.objectContaining({ kind: 'artifact_unavailable', artifact_id: ART_A }),
    ]);
    idx.close();
  });

  it('quarantines a lossy archive thread instead of indexing survivor-only state', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    // Rot an interior line's checksum: the thread rebuilds from the
    // survivors, silently omitting the lost contribution — indexing it
    // would serve that incomplete state through every --all-projects
    // surface.
    await rotCheckpointClosedChecksum(a.projectDir, ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');

    const result = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(idx.store.getArtifact(ART_A)).toBeNull();
    expect(result.artifact_issues).toEqual([
      expect.objectContaining({
        artifact_id: ART_A,
        message: expect.stringContaining('corrupt event-log line'),
      }),
    ]);
    idx.close();
  });

  it('quarantines an archive artifact whose initial plan event is missing', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    await withoutEventType(a.projectDir, ART_A, 'plan_captured');
    const idx = await openProjectIndex(indexRoot, 'proj-a');

    const result = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(idx.store.getArtifact(ART_A)).toBeNull();
    expect(result.artifact_issues).toEqual([
      expect.objectContaining({
        artifact_id: ART_A,
        message: expect.stringContaining('has no plan_captured event'),
      }),
    ]);
    expect(result.meta.artifacts[ART_A]).toBeUndefined();
    expect(result.meta.artifact_issues[ART_A]).toBeDefined();
    idx.close();
  });

  it('clears usage rows when the locked ledger disappears', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    await mirrorUsageSnapshot(a, 'usage-delete-1');
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    await mirrorUsageSnapshot(a, 'usage-delete-2');

    const lock = new ArtifactLock({ locksDir: archiveLocksDir(indexRoot, 'proj-a') });
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = lock.withLock(USAGE_MIRROR_LOCK_ID, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await enteredPromise;
    const refresh = refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(archiveUsageLedgerPaths(a.projectDir).ledgerNdjson);
    release();
    await held;

    const result = await refresh;
    const count = idx.store.db.prepare(`SELECT COUNT(*) AS count FROM usage_snapshots`).get() as {
      count: number;
    };
    expect(count.count).toBe(0);
    expect(result.meta.usage).toBeNull();
    idx.close();
  });

  it('discloses invalid usage records when exact replay drops prior rows', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    await mirrorUsageSnapshot(a, 'usage-invalid-1');
    let idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    const ledgerPath = archiveUsageLedgerPaths(a.projectDir).ledgerNdjson;
    const originalLedger = await readFile(ledgerPath, 'utf8');
    const record = JSON.parse(originalLedger.trim()) as {
      checksum: string;
    };
    record.checksum = '0'.repeat(record.checksum.length);
    await writeFile(ledgerPath, `${JSON.stringify(record)} \n`);

    const result = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    const count = idx.store.db.prepare(`SELECT COUNT(*) AS count FROM usage_snapshots`).get() as {
      count: number;
    };
    expect(count.count).toBe(0);
    expect(result.index_issues).toEqual([
      expect.objectContaining({
        kind: 'index_degraded',
        message: expect.stringContaining('skipped 1 invalid or unreadable record'),
      }),
    ]);
    idx.close();
    idx = await openProjectIndex(indexRoot, 'proj-a');
    const repeated = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(repeated.meta.generation).toBe(result.meta.generation);
    expect(repeated.index_issues).toEqual([
      expect.objectContaining({
        kind: 'index_degraded',
        message: expect.stringContaining('skipped 1 invalid or unreadable record'),
      }),
    ]);
    await writeFile(ledgerPath, originalLedger);
    const repaired = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(repaired.index_issues).toEqual([]);
    expect(
      (
        idx.store.db.prepare(`SELECT COUNT(*) AS count FROM usage_snapshots`).get() as {
          count: number;
        }
      ).count
    ).toBe(1);
    idx.close();
  });

  it('discloses checksummed usage records whose payload does not match their type', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const paths = archiveUsageLedgerPaths(a.projectDir);
    await appendUsageLedgerRecord(
      {
        type: 'agent_usage_snapshot_recorded',
        ts: '2026-07-02T12:30:00.000Z',
        idempotency_key: 'usage-invalid-payload',
        payload: { malformed: true },
      },
      { ledgerPath: paths.ledgerNdjson, sidecarsDir: paths.sidecarsDir }
    );

    const idx = await openProjectIndex(indexRoot, 'proj-a');
    const result = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    const count = idx.store.db.prepare(`SELECT COUNT(*) AS count FROM usage_snapshots`).get() as {
      count: number;
    };
    expect(count.count).toBe(0);
    expect(result.index_issues).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('skipped 1 invalid or unreadable record'),
      }),
    ]);
    idx.close();
  });

  it('does not publish staged artifact changes when usage loading fails', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');

    await a.store.writeSummary(
      {
        schema_version: 1,
        artifact_id: ART_A,
        outcome: 'done and dusted',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'sha-final',
        ts: '2026-07-02T13:00:00.000Z',
      },
      { idempotencyKey: 'sum-staged-refresh' }
    );
    const usagePath = archiveUsageLedgerPaths(a.projectDir).ledgerNdjson;
    await mkdir(usagePath, { recursive: true });

    await expect(refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a')).rejects.toThrow();
    expect(idx.store.getArtifact(ART_A)?.status).toBe('active');

    await rm(usagePath, { recursive: true, force: true });
    await expect(
      refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a')
    ).resolves.toMatchObject({ ingested_artifacts: 1 });
    expect(idx.store.getArtifact(ART_A)?.status).toBe('complete');
    idx.close();
  });

  it('keeps the refreshed projection usable when the disposable meta write fails', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');

    await a.store.writeSummary(
      {
        schema_version: 1,
        artifact_id: ART_A,
        outcome: 'done and dusted',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'sha-final',
        ts: '2026-07-02T13:00:00.000Z',
      },
      { idempotencyKey: 'sum-meta-write-failure' }
    );
    const metaPath = projectIndexMetaPath(indexRoot, 'proj-a');
    await rm(metaPath, { force: true });
    await mkdir(metaPath);

    const refreshed = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(refreshed.meta.artifacts[ART_A]).toBeDefined();
    expect(idx.store.getArtifact(ART_A)?.status).toBe('complete');
    expect(refreshed.index_issues).toEqual([
      expect.objectContaining({
        kind: 'index_degraded',
        message: expect.stringContaining('Could not update the disposable archive index metadata'),
      }),
    ]);
    const repeated = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(repeated.ingested_artifacts).toBe(0);
    expect(repeated.skipped_artifacts).toBe(1);
    idx.close();
  });

  it('removes a projection once when its archive event log disappears', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    await rm(archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson);

    const refreshed = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(idx.store.getArtifact(ART_A)).toBeNull();
    expect(refreshed.meta.artifacts).toEqual({});
    const repeated = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(repeated.meta.generation).toBe(refreshed.meta.generation);
    idx.close();
  });

  it('removes a projection when its archive artifact directory disappears', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    await rm(archiveArtifactPaths(a.projectDir, ART_A).dir, { recursive: true });

    const refreshed = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(idx.store.getArtifact(ART_A)).toBeNull();
    expect(refreshed.meta.artifacts).toEqual({});
    idx.close();
  });

  it('quarantines events stored under a different artifact directory identity', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    await rename(
      archiveArtifactPaths(a.projectDir, ART_A).dir,
      archiveArtifactPaths(a.projectDir, ART_B).dir
    );

    const idx = await openProjectIndex(indexRoot, 'proj-a');
    const result = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(idx.store.getArtifact(ART_A)).toBeNull();
    expect(idx.store.getArtifact(ART_B)).toBeNull();
    expect(result.artifact_issues).toEqual([
      expect.objectContaining({
        artifact_id: ART_B,
        message: expect.stringContaining(`event for "${ART_A}"`),
      }),
    ]);
    expect(result.meta.artifact_issues[ART_B]).toBeDefined();
    idx.close();
  });

  it('deleting the DB rebuilds identical content (disposable by contract)', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    let idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    const beforeHits = idx.store.search('sliding window', {}).length;
    expect(beforeHits).toBeGreaterThanOrEqual(1);
    idx.close();

    const dbPath = projectIndexDbPath(indexRoot, 'proj-a');
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });

    idx = await openProjectIndex(indexRoot, 'proj-a');
    // Meta says "unchanged", but the empty-DB guard forces a full re-ingest.
    const r = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(r.ingested_artifacts).toBe(1);
    expect(idx.store.getArtifact(ART_A)).not.toBeNull();
    expect(idx.store.search('sliding window', {}).length).toBe(beforeHits);
    idx.close();
  });

  it('CACHEDIR.TAG lands at the index root', async () => {
    await openProjectIndex(indexRoot, 'proj-a');
    const { readFile } = await import('node:fs/promises');
    const tag = await readFile(path.join(indexRoot, 'CACHEDIR.TAG'), 'utf8');
    expect(tag.startsWith('Signature: 8a477f597d28d172789f06886806bc55')).toBe(true);
  });

  it('readProjectIndexMeta exposes the per-artifact high-water after a refresh', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    idx.close();

    const meta = await readProjectIndexMeta(indexRoot, 'proj-a');
    expect(meta.schema_version).toBe(1);
    expect(meta.artifacts[ART_A]).toBeDefined();

    // The high-water is exactly the archive events-log stat — the same
    // (size, mtime_ms) a read-only consumer routes last-write lookups by.
    const s = await stat(archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson);
    expect(meta.artifacts[ART_A].size).toBe(s.size);
    expect(meta.artifacts[ART_A].mtime_ms).toBe(s.mtimeMs);
  });

  it('readProjectIndexMeta returns an empty meta for an unknown project', async () => {
    expect(await readProjectIndexMeta(indexRoot, 'no-such-project')).toEqual({
      schema_version: 1,
      generation: 0,
      artifacts: {},
      artifact_issues: {},
      usage: null,
    });
  });

  it('readProjectIndexMeta rejects malformed cache shapes as empty', async () => {
    const metaPath = projectIndexMetaPath(indexRoot, 'proj-a');
    await mkdir(path.dirname(metaPath), { recursive: true });
    await writeFile(
      metaPath,
      JSON.stringify({
        schema_version: 1,
        generation: 7,
        artifacts: null,
        artifact_issues: {},
        usage: { size: 'not-a-number', mtime_ms: 1 },
      })
    );

    expect(await readProjectIndexMeta(indexRoot, 'proj-a')).toEqual({
      schema_version: 1,
      generation: 0,
      artifacts: {},
      artifact_issues: {},
      usage: null,
    });
  });

  it.each([undefined, -1, 1.5, '1'])(
    'readProjectIndexMeta rejects an invalid generation %s as empty',
    async (generation) => {
      const metaPath = projectIndexMetaPath(indexRoot, 'proj-a');
      await mkdir(path.dirname(metaPath), { recursive: true });
      await writeFile(
        metaPath,
        JSON.stringify({
          schema_version: 1,
          generation,
          artifacts: {
            [ART_A]: { size: 42, mtime_ms: 1234 },
          },
          artifact_issues: {},
          usage: null,
        })
      );

      expect(await readProjectIndexMeta(indexRoot, 'proj-a')).toEqual({
        schema_version: 1,
        generation: 0,
        artifacts: {},
        artifact_issues: {},
        usage: null,
      });
    }
  );

  it('quarantines one invalid artifact, persists its high-water, retries on change, and removes stale rows', async () => {
    const good = await makeProject('proj-a', 'healthy archive', ART_A);
    const bad = await makeProject('proj-a', 'incomplete archive', ART_B);
    const badLog = archiveArtifactPaths(bad.projectDir, ART_B).eventsNdjson;
    const completeBadLog = await withoutEventType(bad.projectDir, ART_B, 'checkpoint_opened');

    let idx = await openProjectIndex(indexRoot, 'proj-a');
    const first = await refreshProjectIndex(good.projectDir, idx, indexRoot, 'proj-a');
    expect(idx.store.getArtifact(ART_A)).not.toBeNull();
    expect(idx.store.getArtifact(ART_B)).toBeNull();
    expect(first.artifact_issues).toEqual([
      expect.objectContaining({
        artifact_id: ART_B,
        kind: 'artifact_unavailable',
      }),
    ]);

    const failedMeta = await readProjectIndexMeta(indexRoot, 'proj-a');
    expect(failedMeta.artifacts[ART_A]).toBeDefined();
    expect(failedMeta.artifacts[ART_B]).toBeUndefined();
    expect(failedMeta.artifact_issues[ART_B]).toEqual(
      expect.objectContaining({
        size: expect.any(Number),
        mtime_ms: expect.any(Number),
        message: expect.stringContaining('no matching prior checkpoint_opened'),
      })
    );

    // The same failed high-water is a cheap skip, and its warning survives a
    // process-style close/reopen instead of reparsing every Watch tick.
    const unchanged = await refreshProjectIndex(good.projectDir, idx, indexRoot, 'proj-a');
    expect(unchanged.ingested_artifacts).toBe(0);
    expect(unchanged.skipped_artifacts).toBe(2);
    expect(unchanged.artifact_issues).toEqual(first.artifact_issues);
    expect(unchanged.meta.generation).toBe(first.meta.generation);
    idx.close();
    idx = await openProjectIndex(indexRoot, 'proj-a');
    const reopened = await refreshProjectIndex(good.projectDir, idx, indexRoot, 'proj-a');
    expect(reopened.artifact_issues).toEqual(first.artifact_issues);
    expect(reopened.meta.generation).toBe(first.meta.generation);

    // A changed, repaired log retries automatically and clears the issue.
    await writeFile(badLog, completeBadLog, 'utf8');
    const repaired = await refreshProjectIndex(good.projectDir, idx, indexRoot, 'proj-a');
    expect(repaired.artifact_issues).toEqual([]);
    expect(idx.store.getArtifact(ART_B)).not.toBeNull();
    expect((await readProjectIndexMeta(indexRoot, 'proj-a')).artifact_issues).toEqual({});

    // If a previously indexed artifact later becomes invalid, remove its
    // disposable projection rather than serving stale history.
    await withoutEventType(bad.projectDir, ART_B, 'checkpoint_opened');
    const regressed = await refreshProjectIndex(good.projectDir, idx, indexRoot, 'proj-a');
    expect(regressed.artifact_issues).toHaveLength(1);
    expect(idx.store.getArtifact(ART_B)).toBeNull();
    idx.close();
  });
});

/**
 * Rewrite the on-disk cache schema version — the state an orcaops upgrade (or a
 * rollback to an older build) leaves behind on a disposable index.
 */
function setIndexSchemaVersion(projectId: string, version: number): void {
  const store = new Store(projectIndexDbPath(indexRoot, projectId));
  try {
    store.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(version));
  } finally {
    store.close();
  }
}

describe('global index — degrade tiers', () => {
  it('tier-1 rule: non-wal journal grants degrade to delete', () => {
    expect(resolveJournalFallback('wal')).toBe('wal');
    expect(resolveJournalFallback('WAL')).toBe('wal');
    expect(resolveJournalFallback('truncate')).toBe('delete');
    expect(resolveJournalFallback('memory')).toBe('delete');
  });

  it('tier-2: an unopenable DB path degrades to an in-memory Store that still answers', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    // Occupy the DB path with a DIRECTORY → better-sqlite3 cannot open it.
    await mkdir(projectIndexDbPath(indexRoot, 'proj-a'), { recursive: true });
    const idx = await openProjectIndex(indexRoot, 'proj-a');
    expect(idx.journalMode).toBe('memory');
    expect(idx.dbPath).toBeNull();
    const r = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(r.ingested_artifacts).toBe(1);
    expect(idx.store.getArtifact(ART_A)).not.toBeNull();
    const eventsStat = await stat(archiveArtifactPaths(a.projectDir, ART_A).eventsNdjson);
    expect(r.meta.artifacts[ART_A]).toEqual({
      size: eventsStat.size,
      mtime_ms: eventsStat.mtimeMs,
    });
    idx.close();
  });

  it('tier-2 memory indexes still isolate an invalid artifact', async () => {
    const good = await makeProject('proj-a', 'healthy archive', ART_A);
    const bad = await makeProject('proj-a', 'incomplete archive', ART_B);
    await withoutEventType(bad.projectDir, ART_B, 'checkpoint_opened');
    await mkdir(projectIndexDbPath(indexRoot, 'proj-a'), { recursive: true });

    const idx = await openProjectIndex(indexRoot, 'proj-a');
    expect(idx.journalMode).toBe('memory');
    const result = await refreshProjectIndex(good.projectDir, idx, indexRoot, 'proj-a');
    expect(idx.store.getArtifact(ART_A)).not.toBeNull();
    expect(idx.store.getArtifact(ART_B)).toBeNull();
    expect(result.artifact_issues.map((issue) => issue.artifact_id)).toEqual([ART_B]);
    idx.close();
  });

  it('an index below the current schema is dropped and rebuilt, not degraded to memory', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const seeded = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, seeded, indexRoot, 'proj-a');
    expect(seeded.store.getArtifact(ART_A)).not.toBeNull();
    seeded.close();
    setIndexSchemaVersion('proj-a', CURRENT_VERSION - 1);

    const idx = await openProjectIndex(indexRoot, 'proj-a');
    expect(idx.journalMode).not.toBe('memory');
    expect(idx.dbPath).toBe(projectIndexDbPath(indexRoot, 'proj-a'));
    // Rebuilt from empty: the stale projection is gone, high-waters with it.
    expect(idx.meta.generation).toBe(0);
    expect(idx.meta.artifacts).toEqual({});
    expect(idx.store.getArtifact(ART_A)).toBeNull();

    const refreshed = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(refreshed.ingested_artifacts).toBe(1);
    expect(idx.store.getArtifact(ART_A)).not.toBeNull();
    idx.close();

    // The point of the rebuild: the next open inherits a persisted high-water,
    // so unchanged artifacts are skipped instead of re-ingested every time.
    const reopened = await openProjectIndex(indexRoot, 'proj-a');
    expect(reopened.journalMode).not.toBe('memory');
    expect(reopened.meta.artifacts[ART_A]).toBeDefined();
    const again = await refreshProjectIndex(a.projectDir, reopened, indexRoot, 'proj-a');
    expect(again.ingested_artifacts).toBe(0);
    expect(again.skipped_artifacts).toBe(1);
    reopened.close();
  });

  it('an index newer than this build keeps its files and stays on the memory tier', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    const seeded = await openProjectIndex(indexRoot, 'proj-a');
    await refreshProjectIndex(a.projectDir, seeded, indexRoot, 'proj-a');
    seeded.close();
    const dbPath = projectIndexDbPath(indexRoot, 'proj-a');
    const metaBefore = await readFile(projectIndexMetaPath(indexRoot, 'proj-a'), 'utf8');
    setIndexSchemaVersion('proj-a', CURRENT_VERSION + 1);

    const idx = await openProjectIndex(indexRoot, 'proj-a');
    expect(idx.journalMode).toBe('memory');
    expect(idx.dbPath).toBeNull();
    // A newer orcaops wrote this index. Deleting it would make two installed
    // builds destroy and rebuild each other's cache in a loop.
    await expect(stat(dbPath)).resolves.toBeDefined();
    await expect(readFile(projectIndexMetaPath(indexRoot, 'proj-a'), 'utf8')).resolves.toBe(
      metaBefore
    );
    const refreshed = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(refreshed.ingested_artifacts).toBe(1);
    idx.close();
  });

  it('tier-2 memory indexes still quarantine a lossy archive thread', async () => {
    const a = await makeProject('proj-a', 'rate limiting', ART_A);
    // Lossy (non-tail) rot: a pure truncated tail has lossyLines === 0 and
    // indexes cleanly, which would exercise the wrong branch.
    await rotCheckpointClosedChecksum(a.projectDir, ART_A);
    await mkdir(projectIndexDbPath(indexRoot, 'proj-a'), { recursive: true });

    const idx = await openProjectIndex(indexRoot, 'proj-a');
    expect(idx.journalMode).toBe('memory');
    const result = await refreshProjectIndex(a.projectDir, idx, indexRoot, 'proj-a');
    expect(idx.store.getArtifact(ART_A)).toBeNull();
    expect(result.artifact_issues).toEqual([
      expect.objectContaining({
        artifact_id: ART_A,
        message: expect.stringContaining('corrupt event-log line'),
      }),
    ]);
    idx.close();
  });
});
