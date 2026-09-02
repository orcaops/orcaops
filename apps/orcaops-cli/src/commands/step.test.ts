import { describe, expect, it } from 'vitest';

import { buildStepBrief, type StepBriefInput } from './step.js';

const STEP_A = {
  step_id: 'step-a',
  idx: 1,
  text: 'implement the middleware',
  label: 'Implement middleware',
  acceptance_criteria: [
    { criterion_id: 'crit-1', text: 'limit-exceeded path tested' },
    { criterion_id: 'crit-2', text: 'mounted on /api/charge' },
  ],
};
const STEP_B = {
  step_id: 'step-b',
  idx: 2,
  text: 'write the docs',
  label: 'Write docs',
  acceptance_criteria: [],
};

const BASE: StepBriefInput = {
  artifactId: 'a-1',
  stepId: 'step-a',
  origin: null,
  latest: {
    revision_n: 0,
    steps: [STEP_A, STEP_B],
    non_goals: [{ text: 'no auth changes', rationale: 'separate slice' }],
    touched_scope: ['payments'],
  },
  lastPresent: null,
  claims: {
    closedClaimed: ['step-a'],
    openDeclared: [{ n: 3, declared: ['step-b'] }],
  },
  closedCheckpoints: [
    {
      n: 1,
      closed_at: '2026-06-30T12:00:00.000Z',
      summary: 'wired the middleware',
      completed_step_ids: ['step-a'],
      done_criteria: [
        { criterion_id: 'crit-1', evidence: 'limit test green' },
        { criterion_id: 'crit-other', evidence: 'unrelated evidence' },
      ],
    },
  ],
};

describe('buildStepBrief', () => {
  it('assembles the full brief for a claimed step', () => {
    const brief = buildStepBrief(BASE);

    expect(brief.step).toEqual({
      step_id: 'step-a',
      text: 'implement the middleware',
      label: 'Implement middleware',
      acceptance_criteria: STEP_A.acceptance_criteria,
      dropped_in_latest_revision: false,
      last_present_revision_n: 0,
    });
    expect(brief.claim_state).toEqual({ state: 'claimed', checkpoint_n: 1 });
    // done_criteria filtered to THIS step's criterion ids.
    expect(brief.related_closed_checkpoints).toEqual([
      {
        n: 1,
        closed_at: '2026-06-30T12:00:00.000Z',
        summary: 'wired the middleware',
        done_criteria: [{ criterion_id: 'crit-1', evidence: 'limit test green' }],
      },
    ]);
    expect(brief.guardrails.touched_scope).toEqual(['payments']);
    expect(brief.guardrails.non_goals).toHaveLength(1);
    expect(brief.siblings).toEqual([
      {
        step_id: 'step-b',
        label: 'Write docs',
        claim_state: { state: 'declared_by_open_checkpoint', checkpoint_n: 3 },
      },
    ]);
    expect(brief.note).toBeUndefined();
  });

  it('an unclaimed, undeclared step reports unclaimed', () => {
    const brief = buildStepBrief({
      ...BASE,
      stepId: 'step-b',
      claims: { closedClaimed: [], openDeclared: [] },
    });
    expect(brief.claim_state).toEqual({ state: 'unclaimed' });
    expect(brief.related_closed_checkpoints).toEqual([]);
  });

  it('a dropped step renders from its last-present revision and is not claimable', () => {
    const DROPPED = {
      step_id: 'step-dropped',
      idx: 3,
      text: 'the step that was cut',
      label: 'Cut step',
      acceptance_criteria: [{ criterion_id: 'crit-d', text: 'was going to matter' }],
    };
    const brief = buildStepBrief({
      ...BASE,
      stepId: 'step-dropped',
      latest: { ...BASE.latest, revision_n: 2 },
      lastPresent: { revision_n: 1, step: DROPPED },
    });

    expect(brief.step.dropped_in_latest_revision).toBe(true);
    expect(brief.step.last_present_revision_n).toBe(1);
    expect(brief.step.text).toBe('the step that was cut');
    expect(brief.step.acceptance_criteria).toEqual(DROPPED.acceptance_criteria);
    expect(brief.claim_state).toEqual({ state: 'not_claimable_dropped' });
    expect(brief.note).toMatch(/informational-only/);
    expect(brief.note).toMatch(/revision 1/);
    // Siblings still come from the LATEST revision.
    expect(brief.siblings.map((s) => s.step_id)).toEqual(['step-a', 'step-b']);
  });

  it('a checkpoint that only carries matching criteria evidence (without claiming) is related', () => {
    const brief = buildStepBrief({
      ...BASE,
      closedCheckpoints: [
        {
          n: 2,
          closed_at: '2026-06-30T14:00:00.000Z',
          summary: 'partial evidence only',
          completed_step_ids: [],
          done_criteria: [{ criterion_id: 'crit-2', evidence: 'mounted + smoke-tested' }],
        },
      ],
      claims: { closedClaimed: [], openDeclared: [] },
    });
    expect(brief.claim_state).toEqual({ state: 'unclaimed' });
    expect(brief.related_closed_checkpoints).toHaveLength(1);
    expect(brief.related_closed_checkpoints[0].done_criteria[0].criterion_id).toBe('crit-2');
  });

  it('carries the imported origin through; live captures stay null', () => {
    expect(buildStepBrief(BASE).origin).toBeNull();
    expect(buildStepBrief({ ...BASE, origin: 'git-import' }).origin).toBe('git-import');
  });
});
