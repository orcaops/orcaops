import { stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor, artifactsRoot, cacheDbPath } from '../../src/artifacts/paths.js';
import { ArtifactStore } from '../../src/artifacts/store.js';
import { type Config, getDefaultConfig } from '../../src/schema/config.js';
import { rebuildCache } from '../../src/store/rebuild.js';
import { Store } from '../../src/store/sqlite.js';
import { UsageLedger } from '../../src/usage/ledger.js';

describe('ArtifactStore E2E', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;

  const branch = 'feat/rate-limit';
  const startedAt = '2026-04-25T12:00:00.000Z';
  // Pinned literal: the derivation helper lives in @orcaops/core; storage tests stay free of that upward dep.
  const artifactId = 'a1b2c3d4';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  it('writes plan + 2 checkpoints + summary; SQLite reflects all of it', async () => {
    const STEP_1 = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
    const STEP_2 = '01HX0K8N6ZQF8M5R2V8DZ7T3LY';
    const STEP_3 = '01HX0K8N6ZQF8M5R2V8DZ7T3MZ';
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'cafef00d',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'add rate limiting to /api/charge',
        label: 'rate limit /api/charge',
        plan_steps: [
          {
            step_id: STEP_1,
            text: 'implement Redis sliding-window middleware',
            label: 'redis-mw',
            acceptance_criteria: [],
          },
          {
            step_id: STEP_2,
            text: 'mount on /api/charge',
            label: 'mount',
            acceptance_criteria: [],
          },
          {
            step_id: STEP_3,
            text: 'add tests for limit-exceeded path',
            label: 'tests',
            acceptance_criteria: [],
          },
        ],
        touched_scope: ['payments', 'infra'],
        non_goals: [],
        decisions: [],
        started_at: startedAt,
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'plan-1' }
    );

    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_1] },
      { idempotencyKey: 'cp-1-open', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'wired Redis middleware module',
        files_changed: ['src/middleware/rateLimiter.ts'],
        decisions: [{ decision: 'sliding window over fixed', reason: 'avoids burst-at-boundary' }],
        uncertainty: ['ttl strategy for multi-region redis'],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_1],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: 'cp-1-close' }
    );

    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_2] },
      { idempotencyKey: 'cp-2-open', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 2,
        summary: 'mounted middleware on /api/charge route',
        files_changed: ['src/app.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_2],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: 'cp-2-close' }
    );

    await store.writeSummary(
      {
        schema_version: 1,
        artifact_id: artifactId,
        outcome: 'rate limiter shipped to /api/charge with 9 passing tests',
        tests_written: ['tests/rateLimiter.test.ts'],
        tests_run: ['npm test -- rateLimiter'],
        open_items: ['ttl strategy for multi-region redis'],
        deferred_decisions: [],
        head_sha: 'cccc3333',
        ts: '2026-04-25T13:30:00.000Z',
      },
      { idempotencyKey: 'sum-1' }
    );

    // SQLite reflects everything
    const artifact = store.store.getArtifact(artifactId);
    expect(artifact?.task).toBe('add rate limiting to /api/charge');
    expect(artifact?.status).toBe('complete');
    expect(artifact?.completed_at).toBe('2026-04-25T13:30:00.000Z');

    const planRev = store.store.getLatestPlanRevision(artifactId);
    expect(planRev?.steps).toHaveLength(3);
    expect(planRev?.steps[0].text).toMatch(/Redis sliding-window/);
    expect(planRev?.plan.revision_n).toBe(0);

    const checkpoints = store.store.getCheckpoints(artifactId);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0].n).toBe(1);
    if (checkpoints[0].status !== 'closed') throw new Error('expected closed');
    expect(checkpoints[0].files_changed).toEqual(['src/middleware/rateLimiter.ts']);
    expect(checkpoints[1].n).toBe(2);

    const summary = store.store.getSummary(artifactId);
    expect(summary?.outcome).toMatch(/rate limiter shipped/);

    // Disk has the canonical files
    const paths = artifactPathsFor(repo.path, config, artifactId);
    await expect(stat(paths.planMd)).resolves.toBeDefined();
    await expect(stat(paths.planJson)).resolves.toBeDefined();
    await expect(stat(paths.checkpointMd(1))).resolves.toBeDefined();
    await expect(stat(paths.checkpointJson(1))).resolves.toBeDefined();
    await expect(stat(paths.checkpointMd(2))).resolves.toBeDefined();
    await expect(stat(paths.checkpointJson(2))).resolves.toBeDefined();
    await expect(stat(paths.summaryMd)).resolves.toBeDefined();
    await expect(stat(paths.summaryJson)).resolves.toBeDefined();

    // FTS5 search hits the plan + checkpoint content
    expect(store.store.searchCount('rate')).toBeGreaterThan(0);
    expect(store.store.searchCount('redis')).toBeGreaterThan(0);
  });

  it('round-trips: write → read returns the same data', async () => {
    const STEP_A = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
    const STEP_B = '01HX0K8N6ZQF8M5R2V8DZ7T3LY';
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'cafef00d',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'add rate limiting to /api/charge',
        label: 'rate limit /api/charge',
        plan_steps: [
          { step_id: STEP_A, text: 'step a', label: 'a', acceptance_criteria: [] },
          { step_id: STEP_B, text: 'step b', label: 'b', acceptance_criteria: [] },
        ],
        touched_scope: ['payments'],
        non_goals: [],
        decisions: [],
        started_at: startedAt,
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'plan-1' }
    );

    const read = await store.readPlan(artifactId);
    expect(read?.task).toBe('add rate limiting to /api/charge');
    expect(read?.plan_steps.map((s) => s.text)).toEqual(['step a', 'step b']);
    expect(read?.plan_steps.map((s) => s.label)).toEqual(['a', 'b']);
  });

  it('rebuilds the cache from disk after the SQLite file is deleted', async () => {
    const STEP_ONE = '01HX0K8N6ZQF8M5R2V8DZ7T3KX';
    const STEP_TWO = '01HX0K8N6ZQF8M5R2V8DZ7T3LY';
    // Build a complete artifact
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'cafef00d',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'add rate limiting to /api/charge',
        label: 'rate limit /api/charge',
        plan_steps: [
          { step_id: STEP_ONE, text: 'step one', label: 'one', acceptance_criteria: [] },
          { step_id: STEP_TWO, text: 'step two', label: 'two', acceptance_criteria: [] },
        ],
        touched_scope: ['payments'],
        non_goals: [],
        decisions: [
          {
            decision: 'use an idempotent slidingwindow limiter',
            reason: 'smooths burst-at-boundary',
            revision_n: 0,
            alternatives_considered: [
              { option: 'fixedwindow counter', rejected_because: 'allows a boundary burst' },
            ],
          },
        ],
        started_at: startedAt,
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'plan-1' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_ONE] },
      { idempotencyKey: 'cp-1-open', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 1,
        summary: 'wired middleware',
        files_changed: ['src/a.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_ONE],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: 'cp-1-close' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [STEP_TWO] },
      { idempotencyKey: 'cp-2-open', headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: 2,
        summary: 'mounted route',
        files_changed: ['src/app.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_TWO],
        head_sha: 'cafef00d',
      },
      { idempotencyKey: 'cp-2-close' }
    );
    await store.writeSummary(
      {
        schema_version: 1,
        artifact_id: artifactId,
        outcome: 'shipped',
        tests_written: ['tests/x.test.ts'],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: 'cccc3333',
        ts: '2026-04-25T13:30:00.000Z',
      },
      { idempotencyKey: 'sum-1' }
    );

    const fs = await import('node:fs/promises');
    const artifactPaths = artifactPathsFor(repo.path, config, artifactId);
    await fs.rename(
      artifactPaths.checkpointJson(1),
      path.join(artifactPaths.dir, 'checkpoint-01.json')
    );

    // Close the live store, simulate cache loss by deleting the db
    store.close();
    const dbFile = cacheDbPath(repo.path, config);
    await fs.rm(dbFile, { force: true });
    await fs.rm(path.join(path.dirname(dbFile), 'orcaops.db-wal'), { force: true });
    await fs.rm(path.join(path.dirname(dbFile), 'orcaops.db-shm'), { force: true });

    // Reopen through the artifact store: surviving event logs distinguish
    // this from a genuinely empty repository and arm automatic recovery.
    const freshArtifactStore = new ArtifactStore({ repoRoot: repo.path, config });
    const fresh = freshArtifactStore.store;
    expect(fresh.projectionHealth).toBe('rebuild_pending');
    expect(fresh.getArtifact(artifactId)).toBeNull();
    const result = await rebuildCache({ repoRoot: repo.path, config, store: fresh });

    expect(result.artifacts).toBe(1);
    expect(result.checkpoints).toBe(2);
    expect(result.summaries).toBe(1);

    expect(fresh.getArtifact(artifactId)?.status).toBe('complete');
    expect(fresh.getCheckpoints(artifactId)).toHaveLength(2);
    expect(fresh.getSummary(artifactId)?.outcome).toBe('shipped');
    expect(fresh.searchCount('middleware')).toBeGreaterThan(0);
    // Plan decisions index into FTS on rebuild — findable by the decision text
    // and by a rejected alternative.
    expect(fresh.searchCount('slidingwindow')).toBeGreaterThan(0);
    expect(fresh.searchCount('fixedwindow')).toBeGreaterThan(0);

    freshArtifactStore.close();
    // Reassign so afterEach doesn't try to close the already-closed `store`.
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  it('rebuildCache replays usage that predates any artifact (no .orcaops/artifacts dir)', async () => {
    // Record a usage snapshot with NO plan/artifact captured — the repo has
    // .orcaops/usage/ but no .orcaops/artifacts/. The usage replay must run
    // BEFORE the missing-artifacts-dir early return, else pre-artifact usage
    // is wiped.
    const ledger = new UsageLedger({ repoRoot: repo.path, store: store.store });
    await ledger.appendUsageSnapshot({
      agent: 'claude-code',
      session_id: 's-pre',
      artifact_id: null,
      source_plan_ref_id: 'cloud:ext-pre',
      lifecycle_event: 'plan_review',
      checkpoint_n: null,
      cumulative_usage: {
        input_tokens: 42,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model_breakdown: [],
      record_count: 1,
      as_of: '2026-04-25T12:00:00.000Z',
      ts: '2026-04-25T12:00:00.000Z',
      baseline_hint: 'whole_session',
      idempotency_key: 'pre-1',
    });
    expect(store.store.listCodingSessions()).toHaveLength(1);

    // Drop the SQLite cache and guarantee there is NO artifacts dir on disk.
    store.close();
    const dbFile = cacheDbPath(repo.path, config);
    const fs = await import('node:fs/promises');
    await fs.rm(dbFile, { force: true });
    await fs.rm(path.join(path.dirname(dbFile), 'orcaops.db-wal'), { force: true });
    await fs.rm(path.join(path.dirname(dbFile), 'orcaops.db-shm'), { force: true });
    await fs.rm(artifactsRoot(repo.path, config), { recursive: true, force: true });
    await expect(stat(artifactsRoot(repo.path, config))).rejects.toMatchObject({ code: 'ENOENT' });

    const fresh = new Store(dbFile);
    const result = await rebuildCache({ repoRoot: repo.path, config, store: fresh });

    // No artifacts on disk, but the usage ledger still replayed.
    expect(result.artifacts).toBe(0);
    expect(result.usage_snapshots).toBe(1);
    expect(result.source_plan_links).toBe(0);
    expect(fresh.listCodingSessions()).toHaveLength(1);
    expect(fresh.listCodingSessions()[0].cumulative_input_tokens).toBe(42);

    fresh.close();
    // Reassign so afterEach doesn't try to close the already-closed `store`.
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });

  it('rejects checkpoint open without a prior plan', async () => {
    await expect(
      store.writeCheckpointOpened(
        { artifact_id: 'missing00', declared_step_ids: ['01HX0K8N6ZQF8M5R2V8DZ7T3KX'] },
        { idempotencyKey: 'no-plan-cp', headSha: 'cafef00d' }
      )
    ).rejects.toThrow(/unknown artifact_id/i);
  });
});
