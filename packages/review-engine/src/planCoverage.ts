// Plan-coverage map: each plan step → the checkpoints that claimed it
// (`completed_step_ids`, strong) vs merely declared it (`declared_step_ids`,
// weak), with steps no checkpoint completed flagged loudly. Surfaced in the
// Brief; a step with no landed code reads as a seam, not an empty walk section.

import type { MemberRef, PlanCoverageEntry } from '@orcaops/review-core';

import { orderedCheckpoints, type ReviewArtifact } from './model.js';

export function buildPlanCoverage(artifacts: readonly ReviewArtifact[]): PlanCoverageEntry[] {
  const entries: PlanCoverageEntry[] = [];
  let order = 0;

  for (const a of artifacts) {
    const closed = orderedCheckpoints(a);
    for (const step of a.planSteps) {
      const claimedBy: MemberRef[] = [];
      const declaredBy: MemberRef[] = [];
      for (const cp of closed) {
        const ref: MemberRef = { artifact: a.id, cp: cp.n };
        if (cp.completedStepIds.includes(step.stepId)) claimedBy.push(ref);
        else if (cp.declaredStepIds.includes(step.stepId)) declaredBy.push(ref);
      }
      entries.push({
        artifact: a.id,
        step_id: step.stepId,
        label: step.label,
        text: step.text,
        order,
        claimed_by: claimedBy,
        declared_by: declaredBy,
        unclaimed: claimedBy.length === 0,
      });
      order += 1;
    }
  }

  return entries;
}
