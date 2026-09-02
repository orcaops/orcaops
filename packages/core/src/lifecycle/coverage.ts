/**
 * Plan-step coverage computation, shared by the resume builder and the
 * lifecycle snapshot so the two can't drift. Pure.
 *
 *   - `uncovered_step_ids`: plan steps claimed by no closed cp AND declared
 *     by no open cp (closedClaimed ∪ openDeclared, complemented).
 *   - `uncompleted_step_ids`: plan steps claimed by no closed cp. An open
 *     declaration removes a step from `uncovered_step_ids`, but cannot make
 *     it complete.
 *   - `plan_coverage_complete`: every plan step is claimed by some CLOSED
 *     cp's completed_step_ids (open declarations do NOT count). Trivially
 *     true for an empty plan — callers that care guard on step count.
 */
export interface CoverageInput {
  /** Latest plan revision's step_ids, in plan order. */
  planStepIds: string[];
  closedCheckpoints: ReadonlyArray<{ completed_step_ids: readonly string[] }>;
  openCheckpoints: ReadonlyArray<{ declared_step_ids: readonly string[] }>;
}

export interface Coverage {
  /** Neither completed by a closed checkpoint nor declared by an open one. */
  uncovered_step_ids: string[];
  /** Not completed by a closed checkpoint; open declarations still appear. */
  uncompleted_step_ids: string[];
  plan_coverage_complete: boolean;
}

export function computeCoverage(input: CoverageInput): Coverage {
  const planStepIdSet = new Set(input.planStepIds);

  // Uncovered = plan steps neither claimed by a closed cp nor declared by
  // an open cp.
  const claimed = new Set<string>();
  for (const cp of input.closedCheckpoints) {
    for (const s of cp.completed_step_ids) claimed.add(s);
  }
  for (const cp of input.openCheckpoints) {
    for (const s of cp.declared_step_ids) claimed.add(s);
  }
  const uncovered_step_ids = input.planStepIds.filter((id) => !claimed.has(id));

  // Coverage-complete is keyed on CLOSED claims only (intersected with the
  // latest plan's step set, so a dropped-then-completed step doesn't count).
  const planClaimed = new Set<string>();
  for (const cp of input.closedCheckpoints) {
    for (const s of cp.completed_step_ids) {
      if (planStepIdSet.has(s)) planClaimed.add(s);
    }
  }
  const uncompleted_step_ids = input.planStepIds.filter((id) => !planClaimed.has(id));
  const plan_coverage_complete = uncompleted_step_ids.length === 0;

  return { uncovered_step_ids, uncompleted_step_ids, plan_coverage_complete };
}
