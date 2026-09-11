import { z } from 'zod';

import { proseText } from '../text/control-chars.js';
export const DecisionBaseSchema = z.object({
  decision: proseText(),
  reason: proseText(),
  alternatives_considered: z
    .array(
      z.object({
        option: proseText(),
        rejected_because: proseText(),
      })
    )
    .optional(),
});
export type DecisionBase = z.infer<typeof DecisionBaseSchema>;
export const GitCommitDecisionEvidenceSchema = z.strictObject({
  kind: z.literal('git-commit'),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/u),
  quote: proseText(),
});
export type GitCommitDecisionEvidence = z.infer<typeof GitCommitDecisionEvidenceSchema>;
export const PlanDecisionSchema = DecisionBaseSchema.extend({
  revision_n: z.number().int().nonnegative(),
  evidence: GitCommitDecisionEvidenceSchema.optional(),
});
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;
