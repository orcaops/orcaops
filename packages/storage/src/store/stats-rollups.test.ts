import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type EvaluatorRunRow, Store } from './sqlite.js';

/**
 * Thin stats readers: `evaluatorRunStats`, `planRevisionCounts`,
 * `closedCheckpointIntervals`, `hygieneCounts`. Seeded timestamps/rows pin
 * cases a live E2E repo cannot reproduce without backdating (per-verdict
 * grids, revised plans, hygiene violations).
 */

describe('stats rollup readers', () => {
  let tmpRoot: string;
  let store: Store;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-stats-rollups-'));
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function seedArtifact(
    id: string,
    status: 'active' | 'complete' = 'active',
    originKind: 'git-import' | null = null
  ): void {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id,
      branch: 'main',
      task: `task ${id}`,
      agent: 'claude-code',
      base_sha: 'deadbeef',
      started_at: '2026-06-29T00:00:00.000Z',
      completed_at: null,
      status,
      origin_kind: originKind,
    });
  }

  function seedClosedCp(
    artifactId: string,
    n: number,
    openedAt: string,
    closedAt: string,
    over: Partial<{
      completed_step_ids: string[];
      uncertainty: string[];
      decisions: unknown[];
      files_changed: string[];
    }> = {}
  ): void {
    store.upsertCheckpoint({
      status: 'closed',
      artifact_id: artifactId,
      n,
      declared_step_ids: [`step-${artifactId}-${n}`],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: openedAt,
      closed_at: closedAt,
      summary: 'work',
      files_changed: over.files_changed ?? ['src/x.ts'],
      decisions: over.decisions ?? [{ decision: 'd', reason: 'r' }],
      uncertainty: over.uncertainty ?? ['u'],
      done_criteria: [],
      completed_step_ids: over.completed_step_ids ?? [`step-${artifactId}-${n}`],
      head_sha: 'cafef00d',
    });
  }

  function seedRun(over: Partial<EvaluatorRunRow> & { run_id: string; artifact_id: string }): void {
    store.insertEvaluatorRun({
      evaluator_ref: 'core/some-check',
      package_id: 'core',
      evaluator_id: 'some-check',
      phase: 'checkpoint-close',
      severity: 'warn',
      run_status: 'completed',
      verdict: 'pass',
      body: 'PASS',
      raw: null,
      metrics: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_write: null,
      cost_usd: null,
      duration_ms: null,
      checkpoint_n: null,
      error_code: null,
      error_message: null,
      ts: '2026-06-29T01:00:00.000Z',
      disposition: null,
      source_event_index: 0,
      local_kind_rank: 0,
      local_index: 0,
      ...over,
      provider: over.provider ?? null,
    });
  }

  function seedPlanRevision(artifactId: string, revisionN: number): void {
    store.upsertPlanRevision({
      plan: {
        artifact_id: artifactId,
        revision_n: revisionN,
        captured_at: '2026-06-29T00:00:00.000Z',
        label: `plan ${artifactId} r${revisionN}`,
        rationale: revisionN === 0 ? null : 'revised',
        touched_scope: '[]',
        non_goals: '[]',
        decisions: '[]',
        step_lineage: '{}',
        criterion_lineage: '{}',
        prior_event_id: null,
        source_event_id: `evt-${artifactId}-${revisionN}`,
      },
      steps: [],
    });
  }

  it('evaluatorRunStats groups by (ref, phase) across verdicts and statuses', () => {
    seedArtifact('a1');
    let i = 0;
    const run = (over: Partial<EvaluatorRunRow>): void =>
      seedRun({ run_id: `r-${++i}`, artifact_id: 'a1', source_event_index: i, ...over });
    run({ verdict: 'pass' });
    run({ verdict: 'pass' });
    run({ verdict: 'violation' });
    run({ verdict: 'info' });
    run({ run_status: 'error', verdict: null, error_code: 'X', error_message: 'boom' });
    run({ run_status: 'skipped', verdict: null });
    run({ evaluator_ref: 'core/other', evaluator_id: 'other', phase: 'pre-pr', verdict: 'pass' });

    const rows = store.evaluatorRunStats();
    expect(rows).toHaveLength(2);
    const some = rows.find((r) => r.evaluator_ref === 'core/some-check');
    expect(some).toMatchObject({
      phase: 'checkpoint-close',
      total: 6,
      completed: 4,
      pass: 2,
      violation: 1,
      info: 1,
      error: 1,
      skipped: 1,
    });
    const other = rows.find((r) => r.evaluator_ref === 'core/other');
    expect(other).toMatchObject({ phase: 'pre-pr', total: 1, pass: 1 });
  });

  it('planRevisionCounts returns the latest revision_n per artifact', () => {
    seedArtifact('a1');
    seedArtifact('a2');
    seedPlanRevision('a1', 0);
    seedPlanRevision('a2', 0);
    seedPlanRevision('a2', 1);
    seedPlanRevision('a2', 2);
    expect(store.planRevisionCounts()).toEqual([
      { artifact_id: 'a1', max_revision_n: 0 },
      { artifact_id: 'a2', max_revision_n: 2 },
    ]);
  });

  it('closedCheckpointIntervals returns raw seeded intervals, closed cps only', () => {
    seedArtifact('a1');
    seedClosedCp('a1', 1, '2026-06-29T00:00:00.000Z', '2026-06-29T01:00:00.000Z');
    store.upsertCheckpoint({
      status: 'open',
      artifact_id: 'a1',
      n: 2,
      declared_step_ids: ['step-open'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: '2026-06-29T02:00:00.000Z',
      head_sha: 'cafef00d',
    });
    expect(store.closedCheckpointIntervals()).toEqual([
      {
        artifact_id: 'a1',
        n: 1,
        opened_at: '2026-06-29T00:00:00.000Z',
        closed_at: '2026-06-29T01:00:00.000Z',
      },
    ]);
  });

  it('hygieneCounts pins each counter, including the lifecycle-based pre-pr source', () => {
    // a1: complete artifact with an ORPHAN OPEN cp + a summary WITHOUT a
    // pre-pr lifecycle + a closed cp missing steps/uncertainty/decisions/files.
    seedArtifact('a1', 'complete');
    store.upsertCheckpoint({
      status: 'open',
      artifact_id: 'a1',
      n: 2,
      declared_step_ids: ['s'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: '2026-06-29T02:00:00.000Z',
      head_sha: 'cafef00d',
    });
    seedClosedCp('a1', 1, '2026-06-29T00:00:00.000Z', '2026-06-29T01:00:00.000Z', {
      completed_step_ids: [],
      uncertainty: [],
      decisions: [],
      files_changed: [],
    });
    store.upsertSummary({
      artifact_id: 'a1',
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      ts: '2026-06-29T03:00:00.000Z',
    });

    // a2: clean — active artifact, hygienic closed cp, summary WITH a pre-pr
    // lifecycle row (the evaluator_runs table stays EMPTY for it, proving the
    // counter reads lifecycles, not runs).
    seedArtifact('a2');
    seedClosedCp('a2', 1, '2026-06-29T00:00:00.000Z', '2026-06-29T01:00:00.000Z');
    store.upsertSummary({
      artifact_id: 'a2',
      outcome: 'done',
      tests_written: [],
      tests_run: [],
      open_items: [],
      ts: '2026-06-29T03:00:00.000Z',
    });
    store.recordLifecycle({
      artifact_id: 'a2',
      fires_at: 'pre-pr',
      triggered_at: '2026-06-29T02:30:00.000Z',
    });

    expect(store.hygieneCounts()).toEqual({
      open_checkpoints_on_finished_artifacts: 1,
      summaries_without_pre_pr_run: 1,
      closed_cp_without_completed_steps: 1,
      closed_cp_without_uncertainty: 1,
      closed_cp_without_decisions: 1,
      closed_cp_without_files_changed: 1,
    });
  });

  it('all four readers are zero/empty on a fresh store', () => {
    expect(store.evaluatorRunStats()).toEqual([]);
    expect(store.planRevisionCounts()).toEqual([]);
    expect(store.closedCheckpointIntervals()).toEqual([]);
    expect(store.hygieneCounts()).toEqual({
      open_checkpoints_on_finished_artifacts: 0,
      summaries_without_pre_pr_run: 0,
      closed_cp_without_completed_steps: 0,
      closed_cp_without_uncertainty: 0,
      closed_cp_without_decisions: 0,
      closed_cp_without_files_changed: 0,
    });
  });

  it('excludes imported artifacts from revision, duration, and hygiene aggregates', () => {
    seedArtifact('imported', 'complete', 'git-import');
    seedPlanRevision('imported', 3);
    seedClosedCp('imported', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', {
      completed_step_ids: [],
      uncertainty: [],
      decisions: [],
      files_changed: [],
    });
    store.upsertSummary({
      artifact_id: 'imported',
      outcome: 'historic work',
      tests_written: [],
      tests_run: [],
      open_items: [],
      ts: '2020-01-01T00:00:00.000Z',
    });

    expect(store.planRevisionCounts()).toEqual([]);
    expect(store.closedCheckpointIntervals()).toEqual([]);
    expect(store.hygieneCounts()).toEqual({
      open_checkpoints_on_finished_artifacts: 0,
      summaries_without_pre_pr_run: 0,
      closed_cp_without_completed_steps: 0,
      closed_cp_without_uncertainty: 0,
      closed_cp_without_decisions: 0,
      closed_cp_without_files_changed: 0,
    });
  });
});
