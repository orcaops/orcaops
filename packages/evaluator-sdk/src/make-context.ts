import {
  type EvaluatorContext,
  EvaluatorContextSchema,
  type PlanContext,
} from '@orcaops/evaluator-protocol';

/**
 * Build a valid `EvaluatorContext` for a fixture test, overriding only the
 * fields the test is about.
 *
 * `EvaluatorContextSchema` is `.strict()` with eighteen required keys, three
 * of which are nullable and must be *present* as `null` rather than omitted.
 * Hand-rolling one is the single most common way to lose an afternoon writing
 * a first evaluator, and the failure is unhelpful: a strict-schema rejection
 * naming one missing key at a time.
 *
 * The result is parsed before it is returned, so an override that breaks the
 * contract fails here — in the test that wrote it — rather than inside the
 * runtime under test.
 */
export function makeContext(overrides: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return EvaluatorContextSchema.parse({
    schema: 'orcaops.evaluator_context/v1',
    run_id: '019e0000-0000-7000-8000-000000000000',
    evaluator_ref: 'core/test',
    phase: 'post-plan',
    artifact_id: '019e0000-0000-7000-8000-000000000001',
    checkpoint_n: null,
    repo: { root: '/repo', branch: 'main', base_sha: 'deadbeef', head_sha: 'cafebabe' },
    plan: {
      task: 'test',
      label: 'test plan',
      branch: 'main',
      base_sha: 'deadbeef',
      agent: 'claude-code',
      agent_session_id: null,
      plan_steps: [],
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      touched_scope: [],
      non_goals: [],
      decisions: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      started_at: '2026-05-13T00:00:00.000Z',
    },
    prior_plan: null,
    source_plan: null,
    current_checkpoint: null,
    closed_checkpoints: [],
    open_checkpoints: [],
    abandoned_checkpoints: [],
    summary: null,
    changed_files: [],
    params: {},
    ...overrides,
  });
}

/**
 * Mint a plan step with a well-formed `step_id` and the required `label` /
 * `acceptance_criteria` keys. `idx` only has to be unique within the fixture.
 *
 * Returns the plan-step type rather than the literal shape: annotating
 * `acceptance_criteria: []` would publish an empty tuple, so a caller could
 * not push a criterion onto the result without replacing the property.
 */
export function makePlanStep(
  idx: number,
  text: string,
  label?: string
): PlanContext['plan_steps'][number] {
  return {
    step_id: `019e0000-0000-7000-8000-${idx.toString().padStart(12, '0')}`,
    text,
    label: label ?? `s${idx}`,
    acceptance_criteria: [],
  };
}
