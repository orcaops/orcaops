import { describe, expect, it } from 'vitest';

import { CheckpointContextSchema, EvaluatorContextSchema, PlanContextSchema } from './context.js';

const minimalPlan = {
  task: 'test task',
  label: 'short label',
  branch: 'main',
  base_sha: 'abc123',
  agent: null,
  agent_session_id: null,
  plan_steps: [
    {
      step_id: '01HXSTEP0000000000000000',
      text: 'do a thing',
      label: 'do a thing',
      acceptance_criteria: [],
    },
  ],
  touched_scope: [],
  non_goals: [],
  decisions: [],
  revision_n: 0,
  revised_at: null,
  rationale: null,
  step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
  started_at: '2026-05-12T20:00:00.000Z',
};

const minimalContext = {
  schema: 'orcaops.evaluator_context/v1',
  run_id: '01HXRUN0000000000000000000',
  evaluator_ref: 'core/plan-label-quality',
  phase: 'post-plan' as const,
  artifact_id: '01HXART0000000000000000000',
  checkpoint_n: null,
  repo: { root: '/repo', branch: 'main', base_sha: 'abc', head_sha: 'def' },
  plan: minimalPlan,
  prior_plan: null,
  source_plan: null,
  current_checkpoint: null,
  closed_checkpoints: [],
  open_checkpoints: [],
  abandoned_checkpoints: [],
  summary: null,
  changed_files: [],
  params: {},
};

describe('PlanContextSchema', () => {
  it('accepts the minimal plan shape', () => {
    const out = PlanContextSchema.parse(minimalPlan);
    expect(out.task).toBe('test task');
  });
  it('accepts a revision plan with rationale + step_lineage', () => {
    const out = PlanContextSchema.parse({
      ...minimalPlan,
      revision_n: 1,
      revised_at: '2026-05-12T21:00:00.000Z',
      rationale: 'discovered new constraints',
      step_lineage: {
        added: ['01HXNEW0000000000000000000'],
        dropped: [],
        unchanged: ['01HXSTEP0000000000000000'],
        rewritten: [],
      },
    });
    expect(out.step_lineage.added).toEqual(['01HXNEW0000000000000000000']);
  });

  it('requires step_lineage because every current bridge payload supplies it', () => {
    const withoutLineage: Record<string, unknown> = { ...minimalPlan };
    delete withoutLineage.step_lineage;
    expect(PlanContextSchema.safeParse(withoutLineage).success).toBe(false);
  });

  it('rejects unknown step_lineage keys', () => {
    expect(
      PlanContextSchema.safeParse({
        ...minimalPlan,
        step_lineage: { ...minimalPlan.step_lineage, legacy: [] },
      }).success
    ).toBe(false);
  });
  it('rejects empty branch / base_sha', () => {
    expect(PlanContextSchema.safeParse({ ...minimalPlan, branch: '' }).success).toBe(false);
    expect(PlanContextSchema.safeParse({ ...minimalPlan, base_sha: '' }).success).toBe(false);
  });

  it('accepts plan decisions in the base shape (with alternatives_considered)', () => {
    const out = PlanContextSchema.parse({
      ...minimalPlan,
      decisions: [
        {
          decision: 'imperative enqueueCommand',
          reason: 'atomic with the write',
          alternatives_considered: [{ option: 'event listener', rejected_because: 'async gap' }],
        },
      ],
    });
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0].alternatives_considered).toEqual([
      { option: 'event listener', rejected_because: 'async gap' },
    ]);
  });

  it('rejects a plan decision carrying revision_n (strict — the bridge must strip it)', () => {
    const res = PlanContextSchema.safeParse({
      ...minimalPlan,
      decisions: [{ decision: 'd', reason: 'r', revision_n: 0 }],
    });
    expect(res.success).toBe(false);
  });

  it('requires decisions (no default — every PlanContext carries the array)', () => {
    const withoutDecisions: Record<string, unknown> = { ...minimalPlan };
    delete withoutDecisions.decisions;
    expect(PlanContextSchema.safeParse(withoutDecisions).success).toBe(false);
  });
});

describe('CheckpointContextSchema', () => {
  it('accepts an open checkpoint variant', () => {
    const out = CheckpointContextSchema.parse({
      status: 'open',
      n: 3,
      declared_step_ids: ['01HXSTEP0000000000000000'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      head_sha: 'deadbeef',
      opened_at: '2026-05-12T20:30:00.000Z',
    });
    expect(out.status).toBe('open');
  });

  it('accepts a closed checkpoint with omitted verification and defaults it to empty', () => {
    const out = CheckpointContextSchema.parse({
      status: 'closed',
      n: 1,
      declared_step_ids: ['01HXSTEP0000000000000000'],
      completed_step_ids: ['01HXSTEP0000000000000000'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      summary: 'did the thing',
      files_changed: ['src/foo.ts'],
      decisions: [{ decision: 'use X', reason: 'because Y' }],
      uncertainty: ['unclear about edge case Z'],
      done_criteria: [{ criterion_id: '01HXCRIT0000000000000000', evidence: 'tests green' }],
      head_sha: 'deadbeef',
      opened_at: '2026-05-12T20:30:00.000Z',
      closed_at: '2026-05-12T21:00:00.000Z',
    });
    expect(out.status).toBe('closed');
    if (out.status === 'closed') expect(out.verification).toEqual([]);
  });

  it('accepts a closed checkpoint whose decision carries alternatives_considered', () => {
    const out = CheckpointContextSchema.parse({
      status: 'closed',
      n: 1,
      declared_step_ids: ['01HXSTEP0000000000000000'],
      completed_step_ids: ['01HXSTEP0000000000000000'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      summary: 'did the thing',
      files_changed: [],
      decisions: [
        {
          decision: 'use X',
          reason: 'because Y',
          alternatives_considered: [{ option: 'use Z', rejected_because: 'slower' }],
        },
      ],
      uncertainty: [],
      done_criteria: [],
      head_sha: 'deadbeef',
      opened_at: '2026-05-12T20:30:00.000Z',
      closed_at: '2026-05-12T21:00:00.000Z',
    });
    expect(out.status).toBe('closed');
    if (out.status === 'closed') {
      expect(out.decisions[0].alternatives_considered).toEqual([
        { option: 'use Z', rejected_because: 'slower' },
      ]);
    }
  });

  it('rejects an unknown key inside an alternatives_considered entry (strict)', () => {
    const res = CheckpointContextSchema.safeParse({
      status: 'closed',
      n: 1,
      declared_step_ids: ['01HXSTEP0000000000000000'],
      completed_step_ids: ['01HXSTEP0000000000000000'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      summary: 'did the thing',
      files_changed: [],
      decisions: [
        {
          decision: 'use X',
          reason: 'because Y',
          alternatives_considered: [{ option: 'use Z', rejected_because: 'slower', stray: 1 }],
        },
      ],
      uncertainty: [],
      done_criteria: [],
      head_sha: 'deadbeef',
      opened_at: '2026-05-12T20:30:00.000Z',
      closed_at: '2026-05-12T21:00:00.000Z',
    });
    expect(res.success).toBe(false);
  });

  it('accepts an abandoned checkpoint', () => {
    const out = CheckpointContextSchema.parse({
      status: 'abandoned',
      n: 2,
      declared_step_ids: ['01HXSTEP0000000000000000'],
      agent_session_id: null,
      head_sha: 'deadbeef',
      reason: 'wrong approach',
      opened_at: '2026-05-12T20:30:00.000Z',
      abandoned_at: '2026-05-12T20:35:00.000Z',
    });
    expect(out.status).toBe('abandoned');
  });

  it('rejects an unknown status discriminator', () => {
    const res = CheckpointContextSchema.safeParse({ status: 'pending' });
    expect(res.success).toBe(false);
  });

  it('rejects a closed checkpoint missing completed_step_ids', () => {
    const res = CheckpointContextSchema.safeParse({
      status: 'closed',
      n: 1,
      declared_step_ids: [],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      summary: '',
      files_changed: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      head_sha: 'x',
      opened_at: '2026-05-12T20:30:00.000Z',
      closed_at: '2026-05-12T21:00:00.000Z',
    });
    expect(res.success).toBe(false);
  });
});

describe('EvaluatorContextSchema', () => {
  it('accepts a minimal context', () => {
    const out = EvaluatorContextSchema.parse(minimalContext);
    expect(out.phase).toBe('post-plan');
    expect(out.prior_plan).toBeNull();
  });

  it('accepts a context with a current_checkpoint discriminated union member', () => {
    const out = EvaluatorContextSchema.parse({
      ...minimalContext,
      phase: 'checkpoint-open',
      checkpoint_n: 1,
      current_checkpoint: {
        status: 'open',
        n: 1,
        declared_step_ids: ['01HXSTEP0000000000000000'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        head_sha: 'def',
        opened_at: '2026-05-12T20:30:00.000Z',
      },
    });
    expect(out.current_checkpoint?.status).toBe('open');
  });

  it('accepts a pinned source_plan and structured non_goals', () => {
    const out = EvaluatorContextSchema.parse({
      ...minimalContext,
      plan: {
        ...minimalPlan,
        non_goals: [
          { text: 'no schema migration', rationale: 'out of scope', source_refs: ['section 2'] },
        ],
      },
      source_plan: {
        source_ref: { kind: 'local', locator: 'docs/plan.md' },
        content: 'section 1: ...\nsection 2: ...',
        hash: 'a'.repeat(64),
      },
    });
    expect(out.source_plan?.source_ref.locator).toBe('docs/plan.md');
    expect(out.plan.non_goals[0]).toEqual({
      text: 'no schema migration',
      rationale: 'out of scope',
      source_refs: ['section 2'],
    });
  });

  it('rejects a non-null source_plan missing required keys (strict)', () => {
    const res = EvaluatorContextSchema.safeParse({
      ...minimalContext,
      source_plan: { content: 'x', hash: 'y' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a wrong schema literal', () => {
    const res = EvaluatorContextSchema.safeParse({
      ...minimalContext,
      schema: 'orcaops.evaluator_context/v0',
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const res = EvaluatorContextSchema.safeParse({ ...minimalContext, stray: 1 });
    expect(res.success).toBe(false);
  });

  it('rejects a non-positive checkpoint_n (when not null)', () => {
    const res = EvaluatorContextSchema.safeParse({ ...minimalContext, checkpoint_n: 0 });
    expect(res.success).toBe(false);
  });
});
