import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArtifactStore,
  type Config,
  type EvaluatorDispositionPayload,
  type EvaluatorRunPayload,
  getDefaultConfig,
  uuidv7,
} from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { nextActions } from './next-actions.js';
import { computeUnresolvedBlocks, deriveLifecycleSnapshot } from './snapshot.js';
import { writeDigest } from '../digest/builder.js';

const HEAD = 'head-sha-fixed';
const repoStub = { getHeadSha: async () => HEAD };
const passingPrePrReview = (headSha: string) => ({
  head_sha: headSha,
  outcome: 'passed' as const,
  evaluator_set_fingerprint: 'a'.repeat(64),
  review_context_fingerprint: 'b'.repeat(64),
  run_ids: [],
});

describe('computeUnresolvedBlocks', () => {
  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    evaluator_ref: 'pack/x',
    run_id: 'r1',
    phase: 'checkpoint-close',
    severity: 'block',
    run_status: 'completed',
    verdict: 'violation',
    disposition: 'unresolved',
    ...over,
  });

  it('surfaces a lone unresolved block violation', () => {
    expect(computeUnresolvedBlocks([row()])).toEqual([
      {
        kind: 'violation',
        evaluator_ref: 'pack/x',
        run_id: 'r1',
        phase: 'checkpoint-close',
        acknowledge_enabled: false,
      },
    ]);
  });

  it('a later PASS on the same ref clears the block (regression guard)', () => {
    const blocks = computeUnresolvedBlocks([
      row({ run_id: 'r1', verdict: 'violation' }),
      row({ run_id: 'r2', verdict: 'pass' }), // a later passing run-evaluators
    ]);
    expect(blocks).toEqual([]);
  });

  it('a newer violation supersedes the older run_id', () => {
    const blocks = computeUnresolvedBlocks([row({ run_id: 'r1' }), row({ run_id: 'r2' })]);
    expect(blocks.map((b) => b.run_id)).toEqual(['r2']);
  });

  it('a dismissed latest run clears the block', () => {
    expect(computeUnresolvedBlocks([row({ disposition: 'dismissed' })])).toEqual([]);
  });

  it('an error supersedes an earlier violation and requires a rerun', () => {
    const blocks = computeUnresolvedBlocks([
      row({ run_id: 'r1' }),
      row({ run_id: 'r2', run_status: 'error', verdict: null }),
    ]);
    expect(blocks).toMatchObject([{ kind: 'error', run_id: 'r2', acknowledge_enabled: false }]);
  });

  it('a skipped run leaves the current violation unchanged', () => {
    const blocks = computeUnresolvedBlocks([
      row({ run_id: 'r1' }),
      row({ run_id: 'r2', run_status: 'skipped', verdict: null }),
    ]);
    expect(blocks.map((b) => b.run_id)).toEqual(['r1']);
  });

  it('independent refs: one open, one cleared by a later pass', () => {
    const blocks = computeUnresolvedBlocks([
      row({ evaluator_ref: 'pack/a', run_id: 'a1' }),
      row({ evaluator_ref: 'pack/b', run_id: 'b1' }),
      row({ evaluator_ref: 'pack/b', run_id: 'b2', verdict: 'pass' }),
    ]);
    expect(blocks.map((b) => b.evaluator_ref)).toEqual(['pack/a']);
  });

  it('excludes checkpoint-open (pre-append soft) blocks', () => {
    expect(computeUnresolvedBlocks([row({ phase: 'checkpoint-open' })])).toEqual([]);
  });

  it('acknowledge_enabled comes from the lookup; defaults false without one', () => {
    expect(computeUnresolvedBlocks([row()])[0].acknowledge_enabled).toBe(false);
    const withLookup = computeUnresolvedBlocks([row()], (ref) => ref === 'pack/x');
    expect(withLookup[0].acknowledge_enabled).toBe(true);
  });
});

describe('deriveLifecycleSnapshot', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;
  const artifactId = '01999999-9999-7000-8000-000000000abc';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
  });
  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  async function writePlan3(): Promise<void> {
    await store.writePlan({
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'feat/x',
      base_sha: 'base',
      agent: 'claude-code',
      agent_session_id: null,
      task: 't',
      label: 'lbl',
      plan_steps: [
        { step_id: 'step-1', text: 'one', label: 'step-1', acceptance_criteria: [] },
        { step_id: 'step-2', text: 'two', label: 'step-2', acceptance_criteria: [] },
        { step_id: 'step-3', text: 'three', label: 'step-3', acceptance_criteria: [] },
      ],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    });
  }

  async function openClose(n: number, stepIds: string[]): Promise<void> {
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: stepIds },
      { idempotencyKey: `open-${n}`, headSha: 'base' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n,
        summary: `cp ${n}`,
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: stepIds,
        head_sha: 'base',
      },
      { idempotencyKey: `close-${n}` }
    );
  }

  it('planned: all steps uncovered, coverage incomplete', async () => {
    await writePlan3();
    const s = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(s.state).toBe('planned');
    expect(s.uncovered_step_ids).toEqual(['step-1', 'step-2', 'step-3']);
    expect(s.plan_coverage_complete).toBe(false);
    expect(s.open_checkpoints).toEqual([]);
    expect(s.current_head_sha).toBe(HEAD);
  });

  it('active with an open cp: open surfaced, declared+closed steps not uncovered', async () => {
    await writePlan3();
    await openClose(1, ['step-1']); // closed → state active
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: ['step-2'] },
      { idempotencyKey: 'open-2', headSha: 'base' }
    );
    const s = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(s.state).toBe('active');
    expect(s.open_checkpoints).toEqual([{ n: 2, declared_step_ids: ['step-2'] }]);
    // step-1 closed-claimed, step-2 open-declared → only step-3 uncovered.
    expect(s.uncovered_step_ids).toEqual(['step-3']);
    expect(s.plan_coverage_complete).toBe(false);
  });

  it('coverage complete: no uncovered, plan_coverage_complete true', async () => {
    await writePlan3();
    await openClose(1, ['step-1', 'step-2', 'step-3']);
    const s = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(s.uncovered_step_ids).toEqual([]);
    expect(s.plan_coverage_complete).toBe(true);
    expect(s.state).toBe('active');
  });

  it('pre-pr marker: writePrePrChecked makes the marker current (head + event match)', async () => {
    await writePlan3();
    await openClose(1, ['step-1', 'step-2', 'step-3']);
    await store.writePrePrChecked(artifactId, passingPrePrReview(HEAD));
    const s = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(s.pre_pr_checked_head_sha).toBe(HEAD);
    expect(s.pre_pr_checked_source_event_id).toBe(s.artifact_source_event_id);
  });

  it('a warning review does not suggest capturing the summary', async () => {
    await writePlan3();
    await openClose(1, ['step-1', 'step-2', 'step-3']);
    await store.writePrePrChecked(artifactId, {
      ...passingPrePrReview(HEAD),
      outcome: 'needs_attention',
      run_ids: ['warn-run'],
    });
    const snapshot = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(snapshot.pre_pr_checked_source_event_id).toBeNull();
    expect(nextActions(snapshot).map((action) => action.verb)).not.toContain('capture-summary');
  });

  it('digest: absent → not present; written → present+current; later event → stale', async () => {
    await writePlan3();
    await openClose(1, ['step-1', 'step-2', 'step-3']);

    const before = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(before.digest_present).toBe(false);
    expect(before.digest_usage_fingerprint).toBeNull();
    expect(before.live_usage_fingerprint).not.toBe('');

    await writeDigest({ store, artifactId });
    const current = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(current.digest_present).toBe(true);
    expect(current.digest_source_event_id).toBe(current.artifact_source_event_id);
    expect(current.digest_usage_fingerprint).toBe(current.live_usage_fingerprint);

    // Advance the event log → digest goes stale (built-from id lags).
    await store.writePrePrChecked(artifactId, passingPrePrReview(HEAD));
    const stale = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(stale.digest_present).toBe(true);
    expect(stale.digest_source_event_id).not.toBe(stale.artifact_source_event_id);
  });

  it('blocked: unresolved block surfaces with phase + ack eligibility from the lookup', async () => {
    await writePlan3();
    const runId = uuidv7();
    const payload: EvaluatorRunPayload = {
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: artifactId,
      evaluator_ref: 'test-pack/blocker',
      package_id: 'test-pack',
      evaluator_id: 'blocker',
      phase: 'checkpoint-close',
      severity: 'block',
      run_status: 'completed',
      verdict: 'violation',
      body: 'nope',
      ts: '2026-04-25T12:30:00.000Z',
    };
    await store.writeEvaluatorRunPayload(artifactId, payload, { idempotencyKey: `run-${runId}` });

    const s = (await deriveLifecycleSnapshot(store, repoStub, artifactId, {
      acknowledgeByRef: (ref) => ref === 'test-pack/blocker',
    }))!;
    expect(s.state).toBe('blocked');
    expect(s.unresolved_blocks).toEqual([
      {
        kind: 'violation',
        evaluator_ref: 'test-pack/blocker',
        run_id: runId,
        phase: 'checkpoint-close',
        acknowledge_enabled: true,
      },
    ]);
  });

  it('a passing rerun clears a prior block: no unresolved_blocks, leaves blocked, hint advances', async () => {
    await writePlan3();
    const mk = (runId: string, verdict: 'violation' | 'pass', ts: string): EvaluatorRunPayload => ({
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: artifactId,
      evaluator_ref: 'test-pack/blocker',
      package_id: 'test-pack',
      evaluator_id: 'blocker',
      phase: 'checkpoint-close',
      severity: 'block',
      run_status: 'completed',
      verdict,
      body: verdict,
      ts,
    });
    await store.writeEvaluatorRunPayload(
      artifactId,
      mk('run-v', 'violation', '2026-04-25T12:30:00.000Z'),
      {
        idempotencyKey: 'run-v',
      }
    );
    const blocked = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(blocked.state).toBe('blocked');
    expect(blocked.unresolved_blocks).toHaveLength(1);

    // A later passing run-evaluators supersedes the violation.
    await store.writeEvaluatorRunPayload(
      artifactId,
      mk('run-p', 'pass', '2026-04-25T12:40:00.000Z'),
      {
        idempotencyKey: 'run-p',
      }
    );
    const cleared = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(cleared.unresolved_blocks).toEqual([]);
    expect(cleared.state).not.toBe('blocked');
    // Hint advances (open the uncovered steps) instead of suggesting ack/dismiss.
    const verbs = nextActions(cleared).map((a) => a.verb);
    expect(verbs).not.toContain('block-acknowledge');
    expect(verbs).not.toContain('block-dismiss');
    expect(verbs).toContain('checkpoint-open');
  });

  it('parity: a stale-targeted disposition leaves the block up — computeUnresolvedBlocks agrees with the store state projection', async () => {
    await writePlan3();
    const mkRun = (runId: string, ts: string): EvaluatorRunPayload => ({
      schema: 'orcaops.evaluator_run/v1',
      run_id: runId,
      artifact_id: artifactId,
      evaluator_ref: 'test-pack/blocker',
      package_id: 'test-pack',
      evaluator_id: 'blocker',
      phase: 'checkpoint-close',
      severity: 'block',
      run_status: 'completed',
      verdict: 'violation',
      body: 'nope',
      ts,
    });
    // r1 violates, then r2 violates (supersedes r1).
    await store.writeEvaluatorRunPayload(artifactId, mkRun('run-1', '2026-04-25T12:30:00.000Z'), {
      idempotencyKey: 'run-1',
    });
    await store.writeEvaluatorRunPayload(artifactId, mkRun('run-2', '2026-04-25T12:31:00.000Z'), {
      idempotencyKey: 'run-2',
    });
    // A disposition acknowledges the STALE run r1 (not the current r2). Per
    // the supersession rules this must NOT clear the block (mirrors the storage
    // computeOpenBlocksByRef test in rebuilders.test.ts).
    const disposition: EvaluatorDispositionPayload = {
      schema: 'orcaops.evaluator_disposition/v1',
      disposition_id: uuidv7(),
      artifact_id: artifactId,
      run_id: 'run-1',
      evaluator_ref: 'test-pack/blocker',
      disposition: 'acknowledged',
      reason: 'ack the stale run',
      agent_session_id: null,
      ts: '2026-04-25T12:35:00.000Z',
    };
    await store.writeEvaluatorDisposition(artifactId, disposition, { idempotencyKey: 'disp-1' });

    const s = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    // core's computeUnresolvedBlocks (over SQLite rows) and storage's
    // computeOpenBlocksByRef (which derives `state` from the event log) MUST
    // agree: the block is still up, surfaced on the current run r2.
    expect(s.unresolved_blocks.map((b) => b.evaluator_ref)).toEqual(['test-pack/blocker']);
    expect(s.unresolved_blocks[0]?.run_id).toBe('run-2');
    expect(s.state).toBe('blocked');
    expect(s.unresolved_blocks.length > 0).toBe(s.state === 'blocked');
  });

  it('summarized: state passes through after writeSummary', async () => {
    await writePlan3();
    await openClose(1, ['step-1', 'step-2', 'step-3']);
    await store.writeSummary(
      {
        schema_version: 1,
        artifact_id: artifactId,
        outcome: 'done',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: HEAD,
        ts: '2026-04-25T13:00:00.000Z',
      },
      { idempotencyKey: 'sum-1' }
    );
    const s = (await deriveLifecycleSnapshot(store, repoStub, artifactId))!;
    expect(s.state).toBe('summarized');
    expect(s.plan_coverage_complete).toBe(true);
  });

  it('returns null for an unknown artifact', async () => {
    expect(await deriveLifecycleSnapshot(store, repoStub, 'nope')).toBeNull();
  });

  it('respects an injected currentHeadSha (no repo call)', async () => {
    await writePlan3();
    let called = false;
    const s = (await deriveLifecycleSnapshot(
      store,
      {
        getHeadSha: async () => {
          called = true;
          return 'unused';
        },
      },
      artifactId,
      { currentHeadSha: 'injected-sha' }
    ))!;
    expect(s.current_head_sha).toBe('injected-sha');
    expect(called).toBe(false);
  });
});
