import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rebuildCache } from './rebuild.js';
import { withNonDerivableWriteLease } from './write-lease.js';
import { ArtifactLock, ArtifactLockLeaseLostError, ArtifactLockTimeoutError } from '../locks.js';
import { Store } from './sqlite.js';
import {
  ArtifactStore,
  inspectArtifactDeletionStaging,
  reconcileArtifactDeletionStaging,
} from '../artifacts/store.js';
import { appendEvent } from '../events/event-log.js';
import { getDefaultConfig } from '../schema/config.js';

const passingPrePrReview = (headSha: string) => ({
  head_sha: headSha,
  outcome: 'passed' as const,
  evaluator_set_fingerprint: 'a'.repeat(64),
  review_context_fingerprint: 'b'.repeat(64),
  run_ids: [],
});

describe('rebuildCache lease guard', () => {
  let tmpRoot: string;
  let store: Store;
  const config = getDefaultConfig();

  const dbPath = (): string => path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db');

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-rebuild-'));
    await mkdir(path.join(tmpRoot, '.orcaops', 'artifacts'), { recursive: true });
    store = new Store(dbPath());
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('a lost lease leaves the rebuilt projection marked for a full retry', async () => {
    store.insertPlanIdempotency({
      idempotency_key: 'planless-before-loss',
      artifact_id: '01999999-9999-7000-8000-000000000001',
      created_at: '2026-08-01T00:00:00.000Z',
    });
    await expect(
      rebuildCache({
        repoRoot: tmpRoot,
        config,
        store,
        assertLease: async () => {
          throw new Error('lease lost (injected)');
        },
      })
    ).rejects.toThrow('lease lost (injected)');

    expect(store.projectionHealth).toBe('rebuild_pending');
    expect(store.lookupPlanIdempotency('planless-before-loss')).toBeNull();

    store.close();
    store = new Store(dbPath());
    expect(store.projectionHealth).toBe('rebuild_pending');

    await rebuildCache({ repoRoot: tmpRoot, config, store });
    expect(store.projectionHealth).toBe('healthy');
    expect(store.lookupPlanIdempotency('planless-before-loss')).toBeNull();
  });

  it('a fresh cache accounts for an artifact directory without an event log', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000bd';
    await mkdir(path.join(tmpRoot, config.artifacts.path, artifactId), { recursive: true });
    store.close();
    await rm(dbPath(), { force: true });

    const artifacts = new ArtifactStore({ repoRoot: tmpRoot, config });
    store = artifacts.store;
    expect(store.projectionHealth).toBe('rebuild_pending');

    const result = await rebuildCache({ repoRoot: tmpRoot, config, store });
    expect(result.artifacts).toBe(0);
    expect(result.skipped_artifacts).toBe(1);
    expect(store.projectionHealth).toBe('degraded');
    expect(store.projectionSkippedArtifacts).toBe(1);
  });
});

describe('non-derivable survival across rebuildCache', () => {
  let tmpRoot: string;
  let store: Store;
  const config = getDefaultConfig();

  const dbPath = (): string => path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db');

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-rebuild-nd-'));
    await mkdir(path.join(tmpRoot, '.orcaops', 'artifacts'), { recursive: true });
    store = new Store(dbPath());
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const insertReservation = (key: string, artifactId: string): void => {
    store.db
      .prepare(
        `INSERT INTO plan_idempotency (idempotency_key, artifact_id, created_at)
         VALUES (?, ?, '2026-08-01T00:00:00.000Z')`
      )
      .run(key, artifactId);
  };

  const plantPlanEvent = async (artifactId: string, key: string, ts: string): Promise<void> => {
    const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
    await mkdir(dir, { recursive: true });
    await appendEvent(
      {
        type: 'plan_captured',
        ts,
        idempotency_key: key,
        payload: { artifact_id: artifactId, task: 't' },
      },
      { eventLogPath: path.join(dir, 'events.ndjson'), sidecarsDir: path.join(dir, 'sidecars') }
    );
  };

  it('discards a planless reservation with no event witness', async () => {
    insertReservation('planless-k', '01999999-9999-7000-8000-00000000000a');
    await rebuildCache({ repoRoot: tmpRoot, config, store });
    expect(store.lookupPlanIdempotency('planless-k')).toBeNull();
  });

  it('discards cloud bookkeeping and requeues the same artifact identity', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000ab';
    const artifacts = new ArtifactStore({ repoRoot: tmpRoot, config, store });
    await artifacts.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'main',
        base_sha: 'sha',
        agent: 'other',
        agent_session_id: null,
        task: 'rebuild token rotation',
        label: 'rebuild-token-rotation',
        plan_steps: [
          {
            step_id: '01999999-9999-7000-8000-0000000000ac',
            text: 'one',
            label: 'one',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-08-01T00:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'rebuild-token-rotation' }
    );
    store.setCloudSyncState(artifactId, {
      syncedAt: '2026-08-01T00:01:00.000Z',
      hash: 'clean-hash',
      externalId: artifactId,
      orgId: 'org',
    });
    await rebuildCache({ repoRoot: tmpRoot, config, store });

    expect(store.getArtifact(artifactId)?.id).toBe(artifactId);
    expect(store.getCloudSyncRawHash(artifactId)).toBeNull();
    expect(store.getCloudSyncState(artifactId)).toBeNull();
    expect(store.getCloudSyncStateForArtifact(artifactId)?.pending).toBe(true);
  });

  it('reprojects git-import origin from the event log', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000ad';
    const artifacts = new ArtifactStore({ repoRoot: tmpRoot, config, store });
    await artifacts.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'main',
        base_sha: 'sha',
        agent: 'other',
        agent_session_id: null,
        task: 'historic task',
        label: 'historic-task',
        plan_steps: [
          {
            step_id: '01999999-9999-7000-8000-0000000000ae',
            text: 'one',
            label: 'one',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        origin: {
          kind: 'git-import',
          imported_at: '2026-08-01T01:00:00.000Z',
          tool_version: '0.0.5',
          source_range: 'main~1..main',
          authors: ['dev@example.com'],
          enriched_at: null,
        },
        started_at: '2020-01-01T00:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'rebuild-import-origin' }
    );

    await rebuildCache({ repoRoot: tmpRoot, config, store });
    expect(store.getArtifact(artifactId)?.origin_kind).toBe('git-import');
    expect((await artifacts.readArtifact(artifactId))?.origin?.kind).toBe('git-import');
  });

  it('does not index a raw plan projection when its event log is absent', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000ae';
    const artifacts = new ArtifactStore({ repoRoot: tmpRoot, config, store });
    await artifacts.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'main',
        base_sha: 'sha',
        agent: 'other',
        agent_session_id: null,
        task: 'unprovenanced plan',
        label: 'unprovenanced-plan',
        plan_steps: [
          {
            step_id: '01999999-9999-7000-8000-0000000000af',
            text: 'one',
            label: 'one',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-08-01T00:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'unprovenanced-plan' }
    );
    const eventLogPath = path.join(tmpRoot, config.artifacts.path, artifactId, 'events.ndjson');
    const eventLog = await readFile(eventLogPath);
    await rm(eventLogPath);

    const result = await rebuildCache({
      repoRoot: tmpRoot,
      config,
      store,
      onPhase: async (phase) => {
        if (phase === 'replay-start') expect(store.projectionHealth).toBe('rebuild_pending');
      },
    });

    expect(result.artifacts).toBe(0);
    expect(result.skipped_artifacts).toBe(1);
    expect(store.getArtifact(artifactId)).toBeNull();
    expect(store.projectionHealth).toBe('degraded');
    expect(store.projectionSkippedArtifacts).toBe(1);

    store.close();
    store = new Store(dbPath());
    expect(store.projectionHealth).toBe('degraded');
    expect(store.projectionSkippedArtifacts).toBe(1);

    await writeFile(eventLogPath, eventLog);
    const recovered = await rebuildCache({ repoRoot: tmpRoot, config, store });
    expect(recovered.skipped_artifacts).toBe(0);
    expect(store.projectionHealth).toBe('healthy');
    expect(store.projectionSkippedArtifacts).toBeNull();
  });

  it('reconstructs a published plan reservation from its event', async () => {
    await plantPlanEvent(
      '01999999-9999-7000-8000-00000000000c',
      'published-k',
      '2026-08-02T00:00:00.000Z'
    );
    insertReservation('published-k', '01999999-9999-7000-8000-00000000000d');
    await rebuildCache({ repoRoot: tmpRoot, config, store });
    const row = store.lookupPlanIdempotency('published-k');
    expect(row?.artifact_id).toBe('01999999-9999-7000-8000-00000000000c');
  });

  it('reports conflicting event-derived reservation keys without cache arbitration', async () => {
    const a1 = '01999999-9999-7000-8000-000000000001';
    const a2 = '01999999-9999-7000-8000-000000000002';
    await plantPlanEvent(a1, 'conflict-k', '2026-08-02T00:00:00.000Z');
    await plantPlanEvent(a2, 'conflict-k', '2026-08-03T00:00:00.000Z');
    insertReservation('conflict-k', '01999999-9999-7000-8000-00000000000e');

    const seen: string[] = [];
    await rebuildCache({
      repoRoot: tmpRoot,
      config,
      store,
      onPlanIdempotencyConflicts: (conflicts) => {
        for (const c of conflicts) seen.push(c.idempotency_key);
      },
    });
    expect(seen).toEqual(['conflict-k']);
    // Directory-scan order decides the rebuilder's first-wins row; only an
    // artifact carrying the event can win.
    const row = store.lookupPlanIdempotency('conflict-k');
    expect([a1, a2]).toContain(row?.artifact_id);
  });

  it('discards zero-run lifecycle rows and derives only event-proven completions', async () => {
    const artifactId = '01999999-9999-7000-8000-000000000011';
    const artifacts = new ArtifactStore({ repoRoot: tmpRoot, config, store });
    await artifacts.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'main',
        base_sha: 'sha',
        agent: 'other',
        agent_session_id: null,
        task: 'incomplete evaluator lifecycle',
        label: 'incomplete-lifecycle',
        plan_steps: [
          {
            step_id: '01999999-9999-7000-8000-000000000012',
            text: 'one',
            label: 'one',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-08-01T00:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'incomplete-lifecycle' }
    );
    await artifacts.writeCheckpointOpened(
      {
        artifact_id: artifactId,
        declared_step_ids: ['01999999-9999-7000-8000-000000000012'],
      },
      { idempotencyKey: 'open-after-gate', headSha: 'sha' }
    );
    await artifacts.writePrePrChecked(artifactId, passingPrePrReview('sha'), {
      idempotencyKey: 'passing-pre-pr',
    });
    store.recordLifecycle({
      artifact_id: artifactId,
      fires_at: 'post-plan',
      triggered_at: '2026-08-01T00:00:01.000Z',
    });
    expect(store.hasLifecycle({ artifact_id: artifactId, fires_at: 'post-plan' })).toBe(true);

    await rebuildCache({ repoRoot: tmpRoot, config, store });

    expect(store.hasLifecycle({ artifact_id: artifactId, fires_at: 'post-plan' })).toBe(false);
    expect(
      store.hasLifecycle({
        artifact_id: artifactId,
        fires_at: 'checkpoint-open',
        cp_n: 1,
      })
    ).toBe(true);
    expect(store.hasLifecycle({ artifact_id: artifactId, fires_at: 'pre-pr' })).toBe(true);
  });
});

describe('rebuild/writer serialization barriers', () => {
  let tmpRoot: string;
  let store: Store;
  const config = getDefaultConfig();

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-serial-'));
    await mkdir(path.join(tmpRoot, '.orcaops', 'artifacts'), { recursive: true });
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const plantValidArtifact = async (
    artifacts: ArtifactStore,
    artifactId: string,
    idempotencyKey: string
  ): Promise<void> => {
    await artifacts.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'main',
        base_sha: '0000000000000000000000000000000000000001',
        agent: 'other',
        agent_session_id: null,
        task: 't',
        label: 'l',
        plan_steps: [
          {
            step_id: '01999999-9999-7000-8000-000000000001',
            text: 'step',
            label: 'step',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        started_at: '2026-08-01T00:00:00.000Z',
        non_goals: [],
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        prior_plan_event_id: null,
        decisions: [],
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      },
      { idempotencyKey }
    );
  };

  const barrierTest = async (phase: 'reset-start' | 'replay-start'): Promise<void> => {
    const gate = deferred();
    const reached = deferred();
    const rebuild = rebuildCache({
      repoRoot: tmpRoot,
      config,
      store,
      onPhase: async (p) => {
        if (p === phase) {
          reached.resolve();
          await gate.promise;
        }
      },
    });
    await reached.promise;
    let committed = false;
    const write = withNonDerivableWriteLease(tmpRoot, () => {
      store.insertPlanIdempotency({
        idempotency_key: 'barrier-k',
        artifact_id: '01999999-9999-7000-8000-0000000000b1',
        created_at: '2026-08-01T00:00:00.000Z',
      });
      committed = true;
    });
    await sleep(60);
    expect(committed).toBe(false);
    gate.resolve();
    await rebuild;
    await write;
    expect(committed).toBe(true);
    expect(store.lookupPlanIdempotency('barrier-k')?.artifact_id).toBe(
      '01999999-9999-7000-8000-0000000000b1'
    );
  };

  it('a write arriving before reset blocks until rebuild finalizes, then survives', async () => {
    await barrierTest('reset-start');
  });

  it('a write arriving during replay blocks until rebuild finalizes, then survives', async () => {
    await barrierTest('replay-start');
  });

  it('a writer behind a held lock times out loudly with nothing written', async () => {
    const gate = deferred();
    const reached = deferred();
    const rebuild = rebuildCache({
      repoRoot: tmpRoot,
      config,
      store,
      onPhase: async (p) => {
        if (p === 'reset-start') {
          reached.resolve();
          await gate.promise;
        }
      },
    });
    await reached.promise;
    await expect(
      withNonDerivableWriteLease(
        tmpRoot,
        () => {
          store.insertPlanIdempotency({
            idempotency_key: 'timeout-k',
            artifact_id: '01999999-9999-7000-8000-0000000000b2',
            created_at: '2026-08-01T00:00:00.000Z',
          });
        },
        { acquireTimeoutMs: 80 }
      )
    ).rejects.toBeInstanceOf(ArtifactLockTimeoutError);
    expect(store.lookupPlanIdempotency('timeout-k')).toBeNull();
    gate.resolve();
    await rebuild;
  });

  it('a lost lease fails loudly by default, with the write committed exactly once', async () => {
    const { rm: rmNode } = await import('node:fs/promises');
    const lockPath = path.join(tmpRoot, '.orcaops', 'tmp', 'locks', 'cache-rebuild.lock');
    await expect(
      withNonDerivableWriteLease(tmpRoot, async () => {
        store.insertPlanIdempotency({
          idempotency_key: 'loss-k',
          artifact_id: '01999999-9999-7000-8000-0000000000c1',
          created_at: '2026-08-01T00:00:00.000Z',
        });
        // Simulate a reap while suspended: the post-write assert must fail
        // LOUDLY — a blind rerun would re-resolve a committed reservation
        // as pending.
        await rmNode(lockPath, { recursive: true, force: true });
      })
    ).rejects.toMatchObject({ code: 'LOCK_LEASE_LOST' });
    const rows = store.db
      .prepare(`SELECT COUNT(*) AS c FROM plan_idempotency WHERE idempotency_key = 'loss-k'`)
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('a cloud failure-counter write under lease loss fails loudly with exactly one increment', async () => {
    const { rm: rmNode } = await import('node:fs/promises');
    const lockPath = path.join(tmpRoot, '.orcaops', 'tmp', 'locks', 'cache-rebuild.lock');
    const artifactId = '01999999-9999-7000-8000-0000000000c2';
    store.upsertArtifact({
      id: artifactId,
      branch: 'main',
      task: 't',
      label: 'l',
      agent: 'other',
      base_sha: 'sha',
      started_at: '2026-08-01T00:00:00.000Z',
      completed_at: null,
      status: 'active',
      non_goals: '[]',
    });
    await expect(
      withNonDerivableWriteLease(tmpRoot, async () => {
        store.recordCloudSyncFailure(artifactId, {
          kind: 'network',
          message: 'boom',
          attemptedAt: '2026-08-01T00:00:01.000Z',
          attemptStartedAt: '2026-08-01T00:00:00.500Z',
        });
        await rmNode(lockPath, { recursive: true, force: true });
      })
    ).rejects.toMatchObject({ code: 'LOCK_LEASE_LOST' });
    const row = store.db
      .prepare('SELECT cloud_consecutive_failures AS c FROM artifacts WHERE id = ?')
      .get(artifactId) as { c: number };
    expect(row.c).toBe(1);
  });

  it('an opted-in idempotent upsert retries once after lease loss and lands its exact value', async () => {
    const { rm: rmNode } = await import('node:fs/promises');
    const lockPath = path.join(tmpRoot, '.orcaops', 'tmp', 'locks', 'cache-rebuild.lock');
    const artifactId = '01999999-9999-7000-8000-0000000000c3';
    store.upsertArtifact({
      id: artifactId,
      branch: 'main',
      task: 't',
      label: 'l',
      agent: 'other',
      base_sha: 'sha',
      started_at: '2026-08-01T00:00:00.000Z',
      completed_at: null,
      status: 'active',
      non_goals: '[]',
    });
    const triggeredAt = '2026-08-01T00:00:02.000Z';
    let calls = 0;
    await withNonDerivableWriteLease(
      tmpRoot,
      async () => {
        calls += 1;
        store.recordLifecycle({
          artifact_id: artifactId,
          fires_at: 'post-plan',
          triggered_at: triggeredAt,
        });
        if (calls === 1) await rmNode(lockPath, { recursive: true, force: true });
      },
      { retryOnLeaseLoss: true }
    );
    expect(calls).toBe(2);
    const row = store.db
      .prepare(
        `SELECT triggered_at FROM evaluator_lifecycles WHERE artifact_id = ? AND fires_at = 'post-plan'`
      )
      .get(artifactId) as { triggered_at: string };
    expect(row.triggered_at).toBe(triggeredAt);
  });

  it('gc deletion racing a rebuild leaves no directory, rows, or reservation', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000d1';
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config });
    try {
      const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
      await plantValidArtifact(astore, artifactId, 'gc-race-k');

      const gate = deferred();
      const reached = deferred();
      const rebuild = rebuildCache({
        repoRoot: tmpRoot,
        config,
        store: astore.store,
        onPhase: async (p) => {
          if (p === 'replay-start') {
            reached.resolve();
            await gate.promise;
          }
        },
      });
      await reached.promise;
      // Deletion arrives mid-rebuild: it blocks on the lease while replay
      // sees the still-present log,
      // then erase rows AND directory in one leased span.
      const del = astore.deleteArtifact(artifactId);
      await sleep(60);
      const { access } = await import('node:fs/promises');
      await access(dir); // still present — deletion is blocked
      gate.resolve();
      await rebuild;
      await del;

      await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(astore.store.getArtifact(artifactId)).toBeNull();
      expect(astore.store.lookupPlanIdempotency('gc-race-k')).toBeNull();

      await rebuildCache({ repoRoot: tmpRoot, config, store: astore.store });
      expect(astore.store.getArtifact(artifactId)).toBeNull();
      expect(astore.store.lookupPlanIdempotency('gc-race-k')).toBeNull();
    } finally {
      astore.close?.();
    }
  });

  it('uses a heartbeating artifact lock by default', () => {
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config });
    try {
      expect(astore.lock.options.heartbeatIntervalMs).toBe(30_000);
      expect(astore.lock.options.heartbeatIntervalMs).toBeLessThan(
        astore.lock.options.staleThresholdMs
      );
    } finally {
      astore.close();
    }
  });

  it('keeps a slow artifact deletion lock live past the stale threshold', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000f1';
    const artifactLock = new ArtifactLock({
      locksDir: path.join(tmpRoot, '.orcaops', 'tmp', 'locks'),
      containmentRoot: tmpRoot,
      heartbeatIntervalMs: 10,
      staleThresholdMs: 50,
      retryIntervalMs: 5,
    });
    const contender = new ArtifactLock({
      locksDir: path.join(tmpRoot, '.orcaops', 'tmp', 'locks'),
      containmentRoot: tmpRoot,
      acquireTimeoutMs: 80,
      staleThresholdMs: 50,
      retryIntervalMs: 5,
    });
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config, lock: artifactLock });
    try {
      const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
      await plantValidArtifact(astore, artifactId, 'gc-live-artifact-lock-k');
      const gate = deferred();
      const reached = deferred();
      const deletion = astore.deleteArtifact(artifactId, {
        beforeDelete: async () => {
          reached.resolve();
          await gate.promise;
        },
      });
      await reached.promise;
      await sleep(80);
      try {
        await expect(contender.withLock(artifactId, async () => undefined)).rejects.toBeInstanceOf(
          ArtifactLockTimeoutError
        );
      } finally {
        gate.resolve();
      }
      await expect(deletion).resolves.toEqual({ deleted: true });
      const { access } = await import('node:fs/promises');
      await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(astore.store.getArtifact(artifactId)).toBeNull();
      expect(astore.store.projectionHealth).toBe('healthy');
    } finally {
      astore.close?.();
    }
  });

  it('refuses deletion when a stale artifact lease is reaped before staging', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000f2';
    const locksRoot = path.join(tmpRoot, '.orcaops', 'tmp', 'locks');
    const artifactLock = new ArtifactLock({
      locksDir: locksRoot,
      containmentRoot: tmpRoot,
      staleThresholdMs: 40,
      retryIntervalMs: 5,
    });
    const contender = new ArtifactLock({
      locksDir: locksRoot,
      containmentRoot: tmpRoot,
      acquireTimeoutMs: 500,
      staleThresholdMs: 40,
      retryIntervalMs: 5,
    });
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config, lock: artifactLock });
    const deletionGate = deferred();
    const deletionReached = deferred();
    const contenderGate = deferred();
    const contenderReached = deferred();
    try {
      const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
      await plantValidArtifact(astore, artifactId, 'gc-reaped-artifact-lock-k');
      const deletion = astore.deleteArtifact(artifactId, {
        beforeDelete: async () => {
          deletionReached.resolve();
          await deletionGate.promise;
        },
      });
      await deletionReached.promise;
      await sleep(80);
      const successor = contender.withLock(artifactId, async () => {
        contenderReached.resolve();
        await contenderGate.promise;
      });
      await contenderReached.promise;
      deletionGate.resolve();

      const error = await deletion.then(
        () => null,
        (thrown: unknown) => thrown
      );
      expect(error).toMatchObject({ semanticCommitted: false });
      expect((error as Error).cause).toBeInstanceOf(ArtifactLockLeaseLostError);
      const { access } = await import('node:fs/promises');
      await expect(access(dir)).resolves.toBeUndefined();
      expect(astore.store.getArtifact(artifactId)).not.toBeNull();
      expect(astore.store.projectionHealth).toBe('healthy');

      contenderGate.resolve();
      await successor;
    } finally {
      deletionGate.resolve();
      contenderGate.resolve();
      astore.close?.();
    }
  });

  it('leaves prepared staging recoverable when artifact ownership is lost after row deletion', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000f3';
    const locksRoot = path.join(tmpRoot, '.orcaops', 'tmp', 'locks');
    const artifactLock = new ArtifactLock({
      locksDir: locksRoot,
      containmentRoot: tmpRoot,
      staleThresholdMs: 60_000,
    });
    const successor = new ArtifactLock({
      locksDir: locksRoot,
      containmentRoot: tmpRoot,
      staleThresholdMs: 60_000,
    });
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config, lock: artifactLock });
    try {
      const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
      await plantValidArtifact(astore, artifactId, 'gc-lost-row-delete-artifact-lock-k');

      const error = await astore
        .deleteArtifact(artifactId, {
          onRowsDeleted: async () => {
            await rm(artifactLock.lockPathFor(artifactId), { recursive: true, force: true });
            await successor.withLock(artifactId, async () => undefined);
          },
        })
        .then(
          () => null,
          (thrown: unknown) => thrown
        );

      expect(error).toMatchObject({ semanticCommitted: false });
      expect((error as Error).cause).toBeInstanceOf(ArtifactLockLeaseLostError);
      const { access } = await import('node:fs/promises');
      await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(astore.store.getArtifact(artifactId)).toBeNull();
      expect(astore.store.projectionHealth).toBe('rebuild_pending');
      expect(await inspectArtifactDeletionStaging(tmpRoot)).toMatchObject({
        entries: [{ artifact_id: artifactId, phase: 'prepared' }],
        problems: [],
      });

      await reconcileArtifactDeletionStaging({ repoRoot: tmpRoot, config, store: astore.store });
      await expect(access(dir)).resolves.toBeUndefined();
      expect((await inspectArtifactDeletionStaging(tmpRoot)).entries).toEqual([]);
      expect(astore.store.getArtifact(artifactId)).toBeNull();
      await rebuildCache({ repoRoot: tmpRoot, config, store: astore.store });
      expect(astore.store.getArtifact(artifactId)).not.toBeNull();
      expect(astore.store.projectionHealth).toBe('healthy');
    } finally {
      astore.close?.();
    }
  });

  it('restores protected bytes and retains pending health when row deletion fails', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000d2';
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config });
    try {
      const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
      await plantValidArtifact(astore, artifactId, 'gc-gap-k');

      await expect(
        astore.deleteArtifact(artifactId, {
          onRowsDeleted: async () => {
            throw new Error('injected post-row-delete failure');
          },
        })
      ).rejects.toThrow('injected post-row-delete failure');

      const { access } = await import('node:fs/promises');
      await access(dir);
      expect(astore.store.getArtifact(artifactId)).toBeNull();
      expect(astore.store.lookupPlanIdempotency('gc-gap-k')).toBeNull();
      expect(astore.store.projectionHealth).toBe('rebuild_pending');

      await rebuildCache({ repoRoot: tmpRoot, config, store: astore.store });
      expect(astore.store.projectionHealth).toBe('healthy');
      expect(astore.store.getArtifact(artifactId)).not.toBeNull();
      expect(astore.store.lookupPlanIdempotency('gc-gap-k')?.artifact_id).toBe(artifactId);
    } finally {
      astore.close?.();
    }
  });

  it('restores a staged directory when the SQLite delete transaction fails', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000e1';
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config });
    try {
      const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
      await plantValidArtifact(astore, artifactId, 'gc-sqlite-failure-k');
      astore.store.db.exec(
        `CREATE TRIGGER fail_gc_artifact_delete
         BEFORE DELETE ON artifacts
         WHEN OLD.id = '${artifactId}'
         BEGIN SELECT RAISE(ABORT, 'injected SQLite delete failure'); END`
      );

      await expect(astore.deleteArtifact(artifactId)).rejects.toThrow(
        'injected SQLite delete failure'
      );

      const { access } = await import('node:fs/promises');
      await access(dir);
      expect(astore.store.getArtifact(artifactId)).not.toBeNull();
      expect(astore.store.projectionHealth).toBe('rebuild_pending');
      expect((await inspectArtifactDeletionStaging(tmpRoot)).entries).toEqual([]);

      astore.store.db.exec('DROP TRIGGER fail_gc_artifact_delete');
      await rebuildCache({ repoRoot: tmpRoot, config, store: astore.store });
      expect(astore.store.projectionHealth).toBe('healthy');
      expect(astore.store.getArtifact(artifactId)).not.toBeNull();
    } finally {
      astore.close?.();
    }
  });

  it('restores crash-staged bytes before rebuild resets the projection', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000e2';
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config });
    try {
      const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
      const owner = path.join(tmpRoot, '.orcaops', 'tmp', 'artifact-deletions', artifactId);
      const staged = path.join(owner, 'prepared-01999999-9999-7000-8000-0000000000e3');
      await plantValidArtifact(astore, artifactId, 'gc-crash-stage-k');
      await mkdir(owner, { recursive: true });
      astore.store.setProjectionHealth('rebuild_pending');
      await rename(dir, staged);

      await rebuildCache({ repoRoot: tmpRoot, config, store: astore.store });

      const { access } = await import('node:fs/promises');
      await access(dir);
      await expect(access(owner)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(astore.store.projectionHealth).toBe('healthy');
      expect(astore.store.getArtifact(artifactId)).not.toBeNull();
      expect(astore.store.lookupPlanIdempotency('gc-crash-stage-k')?.artifact_id).toBe(artifactId);
    } finally {
      astore.close?.();
    }
  });

  it('keeps committed cleanup residue protected until the next rebuild', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000e4';
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config });
    try {
      const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
      await plantValidArtifact(astore, artifactId, 'gc-cleanup-residue-k');

      await expect(
        astore.deleteArtifact(artifactId, {
          onDetached: async () => {
            throw new Error('injected cleanup failure');
          },
        })
      ).rejects.toMatchObject({ semanticCommitted: true });

      const { access } = await import('node:fs/promises');
      await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(astore.store.getArtifact(artifactId)).toBeNull();
      expect(astore.store.projectionHealth).toBe('rebuild_pending');
      expect((await inspectArtifactDeletionStaging(tmpRoot)).entries).toHaveLength(1);

      await rebuildCache({ repoRoot: tmpRoot, config, store: astore.store });
      expect((await inspectArtifactDeletionStaging(tmpRoot)).entries).toEqual([]);
      expect(astore.store.getArtifact(artifactId)).toBeNull();
      expect(astore.store.projectionHealth).toBe('healthy');
    } finally {
      astore.close?.();
    }
  });

  it('degrades and preserves both copies when hot and staged state are ambiguous', async () => {
    const artifactId = '01999999-9999-7000-8000-0000000000e5';
    const astore = new ArtifactStore({ repoRoot: tmpRoot, config });
    try {
      const dir = path.join(tmpRoot, config.artifacts.path, artifactId);
      const staged = path.join(
        tmpRoot,
        '.orcaops',
        'tmp',
        'artifact-deletions',
        artifactId,
        'prepared-01999999-9999-7000-8000-0000000000e6'
      );
      await plantValidArtifact(astore, artifactId, 'gc-ambiguous-k');
      await mkdir(staged, { recursive: true });
      await writeFile(path.join(staged, 'events.ndjson'), 'protected copy\n', 'utf8');
      astore.store.setProjectionHealth('rebuild_pending');

      await expect(
        rebuildCache({ repoRoot: tmpRoot, config, store: astore.store })
      ).rejects.toThrow('exists in both the hot store and prepared deletion staging');

      const { access } = await import('node:fs/promises');
      await access(dir);
      await access(staged);
      expect(astore.store.projectionHealth).toBe('degraded');
    } finally {
      astore.close?.();
    }
  });
});
