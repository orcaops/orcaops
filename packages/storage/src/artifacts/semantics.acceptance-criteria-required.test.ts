import { beforeEach, describe, expect, it } from 'vitest';

import type { ArtifactDraftSemantics } from './draft-preparation.js';
import {
  createRetainedArtifactDraft,
  type RetainedArtifactDraft,
} from './retained-draft.test-support.js';
import { CapturePlanReviseInputSchema } from '../schema/capture-input.js';
import type { Plan } from '../schema/plan.js';

/**
 * A revision may not author a rubric-free step, and may not strip the last
 * criterion off a step that has one. A step that was ALREADY rubric-free
 * before the contract carries forward untouched.
 */
describe('acceptance criteria required on plan revise', () => {
  let draft: RetainedArtifactDraft;
  let store: ArtifactDraftSemantics;

  const branch = 'feat/require-criteria';
  const artifactId = '01999999-9999-7000-8000-0000000000ac';
  const COVERED = '01HX0K8N6ZQF8M5R2V8DZ7T3KA';
  const BARE = '01HX0K8N6ZQF8M5R2V8DZ7T3KB';
  const CRIT = '01HX0K8N6ZQF8M5R2V8DZ7TCA1';

  beforeEach(() => {
    draft = createRetainedArtifactDraft(artifactId);
    store = draft.semantics;
  });

  type StepInput = {
    step_id?: string;
    text: string;
    label: string;
    acceptance_criteria: Array<{ criterion_id?: string; text: string }>;
  };

  /** COVERED carries one criterion; BARE has none, as retained history may. */
  async function writeInitialPlan(): Promise<void> {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch,
        base_sha: 'base000',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'deliver the slice',
        label: 'initial-label',
        plan_steps: [
          {
            step_id: COVERED,
            text: 'covered step text',
            label: 'covered-step',
            acceptance_criteria: [{ criterion_id: CRIT, text: 'suite has >= 42 tests' }],
          },
          {
            step_id: BARE,
            text: 'bare step text',
            label: 'bare-step',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-05-31T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'init' }
    );
  }

  async function revise(
    steps: StepInput[],
    opts: { ack?: string[]; key?: string } = {}
  ): Promise<Plan> {
    const key = opts.key ?? 'rev-1';
    const res = await store.revisePlan(
      {
        idempotency_key: key,
        artifact_id: artifactId,
        label: 'revised-label',
        plan_steps: steps,
        touched_scope: [],
        non_goals: [],
        decisions: [],
        rationale: 'adjust the plan',
        prior_plan_event_id: null,
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: opts.ack ?? [],
      },
      { idempotencyKey: key }
    );
    if (res.outcome === 'conflict') throw new Error('unexpected idempotency conflict in test');
    return res.plan;
  }

  const coveredStep = (criteria: Array<{ criterion_id?: string; text: string }>): StepInput => ({
    step_id: COVERED,
    text: 'covered step text',
    label: 'covered-step',
    acceptance_criteria: criteria,
  });

  const bareStep = (): StepInput => ({
    step_id: BARE,
    text: 'bare step text',
    label: 'bare-step',
    acceptance_criteria: [],
  });

  const rewrittenBareStep = (
    criteria: Array<{ criterion_id?: string; text: string }> = []
  ): StepInput => ({
    step_id: BARE,
    text: 'rewritten bare step text',
    label: 'bare-step',
    acceptance_criteria: criteria,
  });

  const keepCrit = () => coveredStep([{ criterion_id: CRIT, text: 'suite has >= 42 tests' }]);

  async function openCpOn(stepId: string): Promise<void> {
    await store.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [stepId] },
      { idempotencyKey: `cp-open-${stepId}`, headSha: 'base000' }
    );
  }

  it('rejects a newly added step that declares no criteria', async () => {
    await writeInitialPlan();
    await expect(
      revise([
        keepCrit(),
        bareStep(),
        { text: 'new step text', label: 'new-step', acceptance_criteria: [] },
      ])
    ).rejects.toMatchObject({
      code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED',
      path: 'plan_steps',
      steps: [{ label: 'new-step', position: 3, kind: 'added' }],
    });
  });

  it('names the offending step and teaches the nested YAML shape', async () => {
    await writeInitialPlan();
    await expect(
      revise([
        keepCrit(),
        bareStep(),
        { text: 'new step text', label: 'new-step', acceptance_criteria: [] },
      ])
    ).rejects.toThrow(
      /step #3 "new-step" declares no acceptance criteria[\s\S]*acceptance_criteria:/
    );
  });

  it('rejects removing the last criterion from a covered step', async () => {
    await writeInitialPlan();
    await expect(revise([coveredStep([]), bareStep()])).rejects.toMatchObject({
      code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED',
      steps: [{ stepId: COVERED, kind: 'rubric-removed' }],
    });
  });

  it('rejects the same removal when the criterion is simply omitted', async () => {
    await writeInitialPlan();
    // Omitting the array is the same narrowing as an explicit []. The default
    // lands in the input schema, so the parsed shape is what reaches the gate.
    const parsed = CapturePlanReviseInputSchema.parse({
      idempotency_key: 'rev-omitted',
      artifact_id: artifactId,
      label: 'revised-label',
      plan_steps: [
        { step_id: COVERED, text: 'covered step text', label: 'covered-step' },
        { step_id: BARE, text: 'bare step text', label: 'bare-step' },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      rationale: 'adjust the plan',
      prior_plan_event_id: null,
      acknowledge_drops_completed_steps: [],
      acknowledge_criteria_changes: [],
    });
    expect(parsed.plan_steps[0].acceptance_criteria).toEqual([]);
    await expect(store.revisePlan(parsed, { idempotencyKey: 'rev-omitted' })).rejects.toMatchObject(
      { code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED' }
    );
  });

  it('does not let acknowledgement unlock the last-criterion removal', async () => {
    await writeInitialPlan();
    await openCpOn(COVERED);
    await expect(revise([coveredStep([]), bareStep()], { ack: [CRIT] })).rejects.toMatchObject({
      code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED',
    });
  });

  it('points a rubric-removal at replacement and at the recovery paths', async () => {
    await writeInitialPlan();
    await expect(revise([coveredStep([]), bareStep()])).rejects.toThrow(
      /replace the old criteria with valid new ones[\s\S]*abandon it[\s\S]*add a new step/
    );
  });

  it('carries a step that was already rubric-free straight through', async () => {
    await writeInitialPlan();
    const plan = await revise([keepCrit(), bareStep()]);
    expect(plan.plan_steps[1].step_id).toBe(BARE);
    expect(plan.plan_steps[1].acceptance_criteria).toEqual([]);
  });

  it('allows a label-only edit to a historical rubric-free step', async () => {
    await writeInitialPlan();
    const plan = await revise([keepCrit(), { ...bareStep(), label: 'renamed-bare-step' }]);
    expect(plan.plan_steps[1]).toMatchObject({
      step_id: BARE,
      text: 'bare step text',
      label: 'renamed-bare-step',
      acceptance_criteria: [],
    });
  });

  it('rejects rewritten historical text when the step remains rubric-free', async () => {
    await writeInitialPlan();
    await expect(revise([keepCrit(), rewrittenBareStep()])).rejects.toMatchObject({
      code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED',
      steps: [{ stepId: BARE, kind: 'historical-step-rewritten' }],
    });
  });

  it('explains how to remediate a rewritten historical rubric-free step', async () => {
    await writeInitialPlan();
    await expect(revise([keepCrit(), rewrittenBareStep()])).rejects.toThrow(
      /Restore the retained step text byte-for-byte[\s\S]*label-only edits remain allowed[\s\S]*supply at least one criterion/
    );
  });

  it('allows rewritten historical text when an unprotected step gains a rubric', async () => {
    await writeInitialPlan();
    const plan = await revise([
      keepCrit(),
      rewrittenBareStep([{ text: 'rewritten work is observable' }]),
    ]);
    expect(plan.plan_steps[1]).toMatchObject({
      step_id: BARE,
      text: 'rewritten bare step text',
      acceptance_criteria: [{ text: 'rewritten work is observable' }],
    });
  });

  it.each([
    { name: 'without criteria', criteria: [] },
    { name: 'with criteria', criteria: [{ text: 'rewritten work is observable' }] },
  ])('keeps protected-step precedence for a rewrite $name', async ({ criteria }) => {
    await writeInitialPlan();
    await openCpOn(BARE);
    await expect(revise([keepCrit(), rewrittenBareStep(criteria)])).rejects.toMatchObject({
      code: 'PLAN_REVISION_INPUT_INVALID',
    });
  });

  it('allows replacing the last criterion on an unprotected step', async () => {
    await writeInitialPlan();
    const plan = await revise([coveredStep([{ text: 'coverage stays above 90%' }]), bareStep()]);
    expect(plan.plan_steps[0].acceptance_criteria.map((c) => c.text)).toEqual([
      'coverage stays above 90%',
    ]);
    expect(plan.criterion_lineage.removed.map((r) => r.criterion_id)).toEqual([CRIT]);
  });

  it('still rejects that replacement on a step an open checkpoint declares', async () => {
    await writeInitialPlan();
    await openCpOn(COVERED);
    await expect(
      revise([coveredStep([{ text: 'coverage stays above 90%' }]), bareStep()])
    ).rejects.toMatchObject({ code: 'PLAN_REVISION_INPUT_INVALID' });
  });

  it('leaves the authoritative plan untouched when it rejects', async () => {
    await writeInitialPlan();
    const before = await store.readPlan(artifactId);
    await expect(revise([coveredStep([]), bareStep()])).rejects.toMatchObject({
      code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED',
    });
    const after = await store.readPlan(artifactId);
    expect(after?.revision_n).toBe(0);
    expect(after).toEqual(before);
  });
});
