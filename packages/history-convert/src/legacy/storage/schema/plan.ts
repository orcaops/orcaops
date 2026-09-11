import { z } from 'zod';

import { CAPTURE_AGENT_IDS } from './config.js';
import { PlanDecisionSchema } from './decision.js';
import { ArtifactOriginSchema } from './origin.js';
import { proseText } from '../text/control-chars.js';
export const ARTIFACT_LABEL_MAX = 70;
export const PlanStepLabelSchema = z
  .string()
  .min(1)
  .max(ARTIFACT_LABEL_MAX)
  .regex(/^[^\n\r\t]*$/, 'must not contain newlines or tabs')
  .refine((s) => s.trim() === s, 'must not have leading or trailing whitespace');
export type PlanStepLabel = z.infer<typeof PlanStepLabelSchema>;
export const PlanLabelSchema = PlanStepLabelSchema;
export type PlanLabel = z.infer<typeof PlanLabelSchema>;
export const AcceptanceCriterionSchema = z.object({
  criterion_id: z.string().min(1),
  text: proseText(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export const PlanStepSchema = z.object({
  step_id: z.string().min(1),
  text: z.string().min(1),
  label: PlanStepLabelSchema,
  acceptance_criteria: z.array(AcceptanceCriterionSchema),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;
export const NonGoalSchema = z.object({
  text: proseText(z.string().min(1).max(2048)),
  rationale: proseText(),
  source_refs: z.array(proseText(z.string())).default([]),
});
export type NonGoal = z.infer<typeof NonGoalSchema>;
export const PersistedNonGoalSchema = NonGoalSchema.safeExtend({
  source_refs: z.array(proseText(z.string())),
});
export const StepLineageSchema = z.object({
  added: z.array(z.string().min(1)),
  dropped: z.array(z.string().min(1)),
  unchanged: z.array(z.string().min(1)),
  rewritten: z.array(
    z.object({
      step_id: z.string().min(1),
      prior_text_hash: z.string().min(1),
    })
  ),
});
export type StepLineage = z.infer<typeof StepLineageSchema>;
export const CriterionLineageSchema = z.object({
  added: z.array(z.string().min(1)),
  carried: z.array(z.string().min(1)),
  removed: z.array(
    z.object({
      criterion_id: z.string().min(1),
      prior_step_id: z.string().min(1),
      text: z.string().min(1),
    })
  ),
  rewritten: z.array(
    z.object({
      criterion_id: z.string().min(1),
      prior_step_id: z.string().min(1),
      prior_text: z.string().min(1),
      new_text: z.string().min(1),
    })
  ),
});
export type CriterionLineage = z.infer<typeof CriterionLineageSchema>;
export const PlanInputSchema = z
  .object({
    schema_version: z.literal(4),
    artifact_id: z.string().min(1),
    branch: z.string().min(1),
    base_sha: z.string().min(1),
    agent: z.enum(CAPTURE_AGENT_IDS),
    agent_session_id: z.string().nullable(),
    task: z.string().min(1),
    label: PlanLabelSchema,
    plan_steps: z.array(PlanStepSchema).min(1),
    touched_scope: z.array(z.string()),
    non_goals: z.array(PersistedNonGoalSchema),
    decisions: z.array(PlanDecisionSchema),
    origin: ArtifactOriginSchema.optional(),
    started_at: z.string().datetime(),
    revision_n: z.number().int().nonnegative(),
    revised_at: z.string().datetime().nullable(),
    revised_by_agent: z.enum(CAPTURE_AGENT_IDS).nullable().optional(),
    rationale: z.string().nullable(),
    step_lineage: StepLineageSchema,
    criterion_lineage: CriterionLineageSchema,
    prior_plan_event_id: z.string().min(1).nullable(),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < plan.plan_steps.length; i++) {
      const label = plan.plan_steps[i].label;
      if (seen.has(label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['plan_steps', i, 'label'],
          message: `Duplicate label "${label}" in plan; labels must be unique within a revision.`,
        });
      }
      seen.add(label);
    }
    const seenCriterionIds = new Set<string>();
    for (let i = 0; i < plan.plan_steps.length; i++) {
      const criteria = plan.plan_steps[i].acceptance_criteria;
      for (let j = 0; j < criteria.length; j++) {
        const cid = criteria[j].criterion_id;
        if (seenCriterionIds.has(cid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['plan_steps', i, 'acceptance_criteria', j, 'criterion_id'],
            message: `Duplicate criterion_id "${cid}" in plan; criterion_ids must be unique within a revision.`,
          });
        }
        seenCriterionIds.add(cid);
      }
    }
  });
export type PlanInput = z.infer<typeof PlanInputSchema>;
export const PlanSchema = PlanInputSchema.safeExtend({
  source_event_id: z.string().min(1),
});
export type Plan = z.infer<typeof PlanSchema>;
export interface CriterionRewordWarning {
  step_id: string;
  label: string;
  removed_texts: string[];
  minted: Array<{
    criterion_id: string;
    text: string;
  }>;
}
export interface CriterionMoveWarning {
  kind: 'cross-step-criterion-move';
  source_step_id: string;
  destination_step_id: string;
  text: string;
  minted_criterion_id: string;
  message: string;
}
export function criterionMoveWarnings(plan: Plan): CriterionMoveWarning[] {
  const stepIds = new Set(plan.plan_steps.map((s) => s.step_id));
  const added = new Set(plan.criterion_lineage.added);
  const removedByText = new Map<
    string,
    Array<{
      prior_step_id: string;
    }>
  >();
  for (const r of plan.criterion_lineage.removed) {
    const t = r.text.trim();
    const list = removedByText.get(t) ?? [];
    list.push({ prior_step_id: r.prior_step_id });
    removedByText.set(t, list);
  }
  const mintsByText = new Map<
    string,
    Array<{
      step_id: string;
      criterion_id: string;
    }>
  >();
  const currentTextCount = new Map<string, number>();
  for (const step of plan.plan_steps) {
    for (const c of step.acceptance_criteria) {
      const t = c.text.trim();
      currentTextCount.set(t, (currentTextCount.get(t) ?? 0) + 1);
      if (added.has(c.criterion_id)) {
        const list = mintsByText.get(t) ?? [];
        list.push({ step_id: step.step_id, criterion_id: c.criterion_id });
        mintsByText.set(t, list);
      }
    }
  }
  const warnings: CriterionMoveWarning[] = [];
  for (const [text, removed] of removedByText) {
    const mints = mintsByText.get(text);
    if (removed.length !== 1 || mints === undefined || mints.length !== 1) continue;
    const source = removed[0];
    const mint = mints[0];
    if (source.prior_step_id === mint.step_id) continue;
    if (!stepIds.has(source.prior_step_id)) continue;
    if ((currentTextCount.get(text) ?? 0) > 1) continue;
    warnings.push({
      kind: 'cross-step-criterion-move',
      source_step_id: source.prior_step_id,
      destination_step_id: mint.step_id,
      text,
      minted_criterion_id: mint.criterion_id,
      message:
        `A criterion with this exact text was removed from one step and freshly ` +
        `minted on another this revision. If this was a deliberate move, nothing ` +
        `is wrong — but note the minted criterion has a NEW criterion_id: ` +
        `cross-step criterion_id reuse is forbidden by the revise API, so any ` +
        `done_criteria evidence recorded against the removed criterion stays ` +
        `with the old step's history and does not transfer.`,
    });
  }
  return warnings;
}
export function criterionRewordWarnings(plan: Plan): CriterionRewordWarning[] {
  const added = new Set(plan.criterion_lineage.added);
  return plan.plan_steps.flatMap((step) => {
    const removed_texts = plan.criterion_lineage.removed
      .filter((r) => r.prior_step_id === step.step_id)
      .map((r) => r.text);
    const minted = step.acceptance_criteria
      .filter((c) => added.has(c.criterion_id))
      .map((c) => ({ criterion_id: c.criterion_id, text: c.text }));
    return removed_texts.length > 0 && minted.length > 0
      ? [{ step_id: step.step_id, label: step.label, removed_texts, minted }]
      : [];
  });
}
