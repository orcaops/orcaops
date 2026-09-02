import { z } from 'zod';

import { proseText } from '../text/control-chars.js';

/**
 * Shared decision shape — the neutral base both checkpoint-close
 * decisions and plan-time decisions extend from.
 *
 * Kept as a leaf shared by plan and checkpoint schemas. Prose policy lives
 * below the schema layer in `control-chars.ts`, so both consumers share the
 * same strip-then-nonblank contract without creating an import cycle.
 */
export const DecisionBaseSchema = z.object({
  decision: proseText(),
  reason: proseText(),
  /**
   * Optional rejected alternatives that informed this decision. Each
   * entry names an `option` the agent considered and `rejected_because`
   * the reason it lost. Rejected options often tell a reviewer more
   * than the chosen one; this surfaces them structurally in the digest
   * rather than flattening them into the free-text `reason`. Pure
   * narrative enrichment in the WHY bucket — enriches, does not enforce.
   */
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

/**
 * A plan-time decision — the architectural choice captured where it is
 * actually made (plan mode), distinct from checkpoint-close decisions
 * captured per chunk of work.
 *
 * Adds `revision_n`: the plan revision the decision was made at. It is
 * *persisted metadata stamped by the write path* — the agent NEVER
 * supplies it (capture inputs use `DecisionBaseSchema`). Plan decisions
 * are append-only / cumulative across revisions: a later revision adds
 * new entries (each tagged with its own `revision_n`) without erasing
 * earlier ones, so the latest plan always holds the full set and the
 * tag lets readers attribute each decision to the revision that made it.
 */
export const PlanDecisionSchema = DecisionBaseSchema.extend({
  revision_n: z.number().int().nonnegative(),
});

export type PlanDecision = z.infer<typeof PlanDecisionSchema>;
