import { describe, expect, it } from 'vitest';

import {
  isDigestCurrent,
  isPrePrCurrent,
  type LifecycleSnapshot,
  nextActions,
  type SemanticVerb,
} from './next-actions.js';

const HEAD = 'sha-current';
const EV = 'event-latest';
const USAGE = 'usage-current';

/** A planned artifact with no progress; override per case. */
function snap(over: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return {
    artifact_id: 'art-1',
    state: 'planned',
    current_head_sha: HEAD,
    artifact_source_event_id: EV,
    pre_pr_checked_head_sha: null,
    pre_pr_checked_source_event_id: null,
    digest_present: false,
    digest_source_event_id: null,
    digest_usage_fingerprint: null,
    live_usage_fingerprint: USAGE,
    open_checkpoints: [],
    uncovered_step_ids: [],
    plan_coverage_complete: false,
    unresolved_blocks: [],
    ...over,
  };
}

const verbs = (s: LifecycleSnapshot): SemanticVerb[] => nextActions(s).map((a) => a.verb);

describe('nextActions', () => {
  it('planned with no steps → no suggestions', () => {
    expect(nextActions(snap())).toEqual([]);
  });

  it('uncovered steps, no open cp → open one covering them', () => {
    const s = snap({
      state: 'planned',
      uncovered_step_ids: ['s1', 's2', 's3'],
    });
    const actions = nextActions(s);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ verb: 'checkpoint-open', step_ids: ['s1', 's2', 's3'] });
  });

  it('multiple uncovered steps → effect lists the ids and asks for a coherent subset (step_ids unchanged)', () => {
    const s = snap({ state: 'planned', uncovered_step_ids: ['s1', 's2', 's3'] });
    const open = nextActions(s)[0];
    // Semantic truth (the full uncovered set) is preserved on the action...
    expect(open).toMatchObject({ verb: 'checkpoint-open', step_ids: ['s1', 's2', 's3'] });
    // ...but the rationale names the candidates and discourages declaring all of them.
    expect(open.effect).toContain('COHERENT SUBSET');
    expect(open.effect).toContain('s1, s2, s3');
    expect(open.effect).toContain('not all of them');
    // Every open hint installs "open before you change the worktree".
    expect(open.effect).toContain('before you change the worktree');
  });

  it('a single uncovered step → effect names the one step with singular phrasing', () => {
    const s = snap({ state: 'planned', uncovered_step_ids: ['s9'] });
    const open = nextActions(s)[0];
    expect(open).toMatchObject({ verb: 'checkpoint-open', step_ids: ['s9'] });
    expect(open.effect).toContain('last uncovered step (s9)');
    expect(open.effect).toContain('before you change the worktree');
    expect(open.effect).not.toContain('COHERENT SUBSET');
  });

  it('no checkpoints yet → first-checkpoint wording, distinct from the recurring next-open', () => {
    const s = snap({
      state: 'planned',
      uncovered_step_ids: ['s1', 's2', 's3'],
      no_checkpoints_yet: true,
    });
    const open = nextActions(s)[0];
    // step_ids semantic truth is still the full uncovered set (the renderer fills the command).
    expect(open).toMatchObject({ verb: 'checkpoint-open', step_ids: ['s1', 's2', 's3'] });
    // Distinct cadence-setting wording; not the recurring subset string.
    expect(open.effect).toContain('FIRST checkpoint');
    expect(open.effect).toContain('before you change the worktree');
    // Attribution framing is strong-but-true (no false absolute "loses ...").
    expect(open.effect).toContain('only reliable way to get clean per-line attribution');
    expect(open.effect).not.toContain('loses per-line attribution');
    expect(open.effect).not.toContain('COHERENT SUBSET');
  });

  it('open cps AND uncovered steps → close each AND open (parallelism, never serialized)', () => {
    const s = snap({
      state: 'active',
      open_checkpoints: [
        { n: 1, declared_step_ids: ['s1'] },
        { n: 2, declared_step_ids: ['s2'] },
      ],
      uncovered_step_ids: ['s3', 's4'],
    });
    const actions = nextActions(s);
    expect(actions.map((a) => a.verb)).toEqual([
      'checkpoint-close',
      'checkpoint-close',
      'checkpoint-open',
    ]);
    expect(actions[0]).toMatchObject({ verb: 'checkpoint-close', checkpoint_n: 1 });
    expect(actions[1]).toMatchObject({ verb: 'checkpoint-close', checkpoint_n: 2 });
    expect(actions[2]).toMatchObject({ verb: 'checkpoint-open', step_ids: ['s3', 's4'] });
    // The close hint chains into "open the next checkpoint before you change the worktree".
    expect(actions[0].effect).toContain('before you change the worktree');
  });

  it('coverage complete and nothing open recommends finish', () => {
    const s = snap({ state: 'active', plan_coverage_complete: true });
    expect(verbs(s)).toEqual(['finish']);
  });

  it('a standalone current pre-pr marker still recommends the normal finish path', () => {
    const s = snap({
      state: 'active',
      plan_coverage_complete: true,
      pre_pr_checked_head_sha: HEAD,
      pre_pr_checked_source_event_id: EV,
    });
    expect(verbs(s)).toEqual(['finish']);
  });

  it('a stale pre-pr marker recommends finish, which reruns the checks', () => {
    const s = snap({
      state: 'active',
      plan_coverage_complete: true,
      pre_pr_checked_head_sha: 'sha-OLD',
      pre_pr_checked_source_event_id: EV,
    });
    expect(verbs(s)).toEqual(['finish']);
  });

  it('an event-stale pre-pr marker recommends finish', () => {
    const s = snap({
      state: 'active',
      plan_coverage_complete: true,
      pre_pr_checked_head_sha: HEAD,
      pre_pr_checked_source_event_id: 'event-OLD',
    });
    expect(verbs(s)).toEqual(['finish']);
  });

  it('blocked, ack-enabled, pre-pr phase → acknowledge + dismiss (no forward progress)', () => {
    const s = snap({
      state: 'blocked',
      plan_coverage_complete: true,
      unresolved_blocks: [
        {
          kind: 'violation',
          evaluator_ref: 'core/x',
          run_id: 'r1',
          phase: 'pre-pr',
          acknowledge_enabled: true,
        },
      ],
    });
    const actions = nextActions(s);
    expect(actions.map((a) => a.verb)).toEqual(['block-acknowledge', 'block-dismiss']);
    expect(actions[0]).toMatchObject({ evaluator_ref: 'core/x', run_id: 'r1' });
  });

  it('blocked, ack-disabled, checkpoint-close phase → dismiss only', () => {
    const s = snap({
      state: 'blocked',
      unresolved_blocks: [
        {
          kind: 'violation',
          evaluator_ref: 'core/y',
          run_id: 'r2',
          phase: 'checkpoint-close',
          acknowledge_enabled: false,
        },
      ],
    });
    expect(verbs(s)).toEqual(['block-dismiss']);
  });

  it('multiple blocks → one ack/dismiss pair per run_id', () => {
    const s = snap({
      state: 'blocked',
      unresolved_blocks: [
        {
          kind: 'violation',
          evaluator_ref: 'core/a',
          run_id: 'rA',
          phase: 'checkpoint-close',
          acknowledge_enabled: true,
        },
        {
          kind: 'violation',
          evaluator_ref: 'core/b',
          run_id: 'rB',
          phase: 'pre-pr',
          acknowledge_enabled: false,
        },
      ],
    });
    expect(verbs(s)).toEqual(['block-acknowledge', 'block-dismiss', 'block-dismiss']);
  });

  it('summarized, digest stale/absent → digest', () => {
    const s = snap({ state: 'summarized', plan_coverage_complete: true });
    expect(verbs(s)).toEqual(['digest']);
  });

  it('summarized, digest current → terminal (no suggestions)', () => {
    const s = snap({
      state: 'summarized',
      plan_coverage_complete: true,
      digest_present: true,
      digest_source_event_id: EV,
      digest_usage_fingerprint: USAGE,
    });
    expect(nextActions(s)).toEqual([]);
  });

  it('blocked short-circuits even when coverage is complete', () => {
    const s = snap({
      state: 'blocked',
      plan_coverage_complete: true,
      pre_pr_checked_head_sha: HEAD,
      pre_pr_checked_source_event_id: EV,
      unresolved_blocks: [
        {
          kind: 'violation',
          evaluator_ref: 'core/z',
          run_id: 'r9',
          phase: 'pre-pr',
          acknowledge_enabled: false,
        },
      ],
    });
    expect(verbs(s)).toEqual(['block-dismiss']);
  });

  it('an evaluator error can only be cleared by rerunning its phase', () => {
    const s = snap({
      state: 'blocked',
      unresolved_blocks: [
        {
          kind: 'error',
          evaluator_ref: 'core/x',
          run_id: 'r-error',
          phase: 'pre-pr',
          acknowledge_enabled: false,
        },
      ],
    });
    const actions = nextActions(s);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      verb: 'evaluator-rerun',
      evaluator_ref: 'core/x',
      run_id: 'r-error',
      evaluator_phase: 'pre-pr',
    });
  });
});

describe('isPrePrCurrent / isDigestCurrent', () => {
  it('pre-pr current requires both HEAD and event-id to match', () => {
    expect(
      isPrePrCurrent(snap({ pre_pr_checked_head_sha: HEAD, pre_pr_checked_source_event_id: EV }))
    ).toBe(true);
    expect(
      isPrePrCurrent(snap({ pre_pr_checked_head_sha: HEAD, pre_pr_checked_source_event_id: 'old' }))
    ).toBe(false);
    expect(isPrePrCurrent(snap())).toBe(false);
  });

  it('digest current requires presence, matching event-id, and exact usage fingerprints', () => {
    const current = snap({
      digest_present: true,
      digest_source_event_id: EV,
      digest_usage_fingerprint: USAGE,
    });
    expect(isDigestCurrent(current)).toBe(true);
    expect(isDigestCurrent({ ...current, digest_source_event_id: 'old' })).toBe(false);
    expect(isDigestCurrent({ ...current, digest_present: false })).toBe(false);
    expect(isDigestCurrent({ ...current, digest_usage_fingerprint: 'usage-old' })).toBe(false);
  });

  it('treats an absent cached or live usage fingerprint as stale', () => {
    const current = snap({
      digest_present: true,
      digest_source_event_id: EV,
      digest_usage_fingerprint: USAGE,
    });
    const { digest_usage_fingerprint: _cached, ...withoutCached } = current;
    const { live_usage_fingerprint: _live, ...withoutLive } = current;
    expect(isDigestCurrent(withoutCached as LifecycleSnapshot)).toBe(false);
    expect(isDigestCurrent(withoutLive as LifecycleSnapshot)).toBe(false);
  });
});
