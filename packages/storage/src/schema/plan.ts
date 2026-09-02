import { z } from 'zod';

import { CAPTURE_AGENT_IDS } from './config.js';
import { PlanDecisionSchema } from './decision.js';
import { ArtifactOriginSchema } from './origin.js';
import { proseText } from '../text/control-chars.js';

/**
 * The label ceiling every display surface and authoring gate shares. Exported
 * beside the schema so producers (seed synthesis, enrichment validation,
 * cluster labeling) cannot drift from what the store actually rejects.
 */
export const ARTIFACT_LABEL_MAX = 70;

/**
 * Short-form description of a plan step — a 1-line human-readable
 * TL;DR of the step's `text`. Used as the consumable headline
 * alongside the longer `text` in checklists and dashboards. Distinct
 * from `step_id` (the immutable UUIDv7 identity that machine
 * references use); `label` is for display.
 *
 * Format: prose. 1–70 chars. No newlines or tabs; no leading or
 * trailing whitespace. Uniqueness within a plan is enforced via
 * `PlanSchema.superRefine` (the leaf schema can't see sibling steps).
 */
export const PlanStepLabelSchema = z
  .string()
  .min(1)
  .max(ARTIFACT_LABEL_MAX)
  .regex(/^[^\n\r\t]*$/, 'must not contain newlines or tabs')
  .refine((s) => s.trim() === s, 'must not have leading or trailing whitespace');

export type PlanStepLabel = z.infer<typeof PlanStepLabelSchema>;

/**
 * Plan-level short headline — a 1-line human-readable name for the
 * whole capture thread, distinct from the longer prose `task`. Reuses
 * the same constraints as `PlanStepLabelSchema` (1–70 chars, no
 * newlines/tabs, trimmed) so display surfaces can render labels
 * uniformly at the thread and step grain. Per-revision: agents may
 * sharpen the label on `plan revise` as scope evolves.
 */
export const PlanLabelSchema = PlanStepLabelSchema;
export type PlanLabel = z.infer<typeof PlanLabelSchema>;

/**
 * A plan-time acceptance criterion — a free-text rubric line
 * the delivery-coverage (`step-coverage`) evaluator grades the shipped
 * diff against. Identity is the server-minted UUIDv7 `criterion_id`,
 * stable across plan revisions (mirrors `step_id`); `done_criteria`
 * evidence at checkpoint-close keys back to it. Stability is enforced on
 * revise: an omitted `criterion_id` whose text is unchanged auto-carries the
 * prior id (see `revisePlan`), reconciling identity rather than re-minting it.
 * `text` must be non-blank.
 * Criteria are optional per step — a step with none is simply not
 * coverage-graded.
 */
export const AcceptanceCriterionSchema = z.object({
  criterion_id: z.string().min(1),
  text: proseText(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/**
 * A single plan step. Identity is the server-minted UUIDv7 `step_id`,
 * which is stable across plan revisions — checkpoints reference steps
 * by `step_id`, not by ordinal position. Display position is the
 * step's index in `Plan.plan_steps`, computed at render time. The
 * `label` is a short-form description (1-line TL;DR of `text`) used
 * as the consumable headline in display surfaces; see
 * `PlanStepLabelSchema`.
 */
export const PlanStepSchema = z.object({
  step_id: z.string().min(1),
  text: z.string().min(1),
  label: PlanStepLabelSchema,
  /**
   * Plan-time acceptance criteria for this step — the rubric
   * `step-coverage` grades delivery against. Required on the persisted
   * shape: the writer materializes an empty array when the capture input
   * omits criteria, and a step with an empty rubric is simply not
   * coverage-graded. `criterion_id`s are server-minted and
   * revision-stable.
   */
  acceptance_criteria: z.array(AcceptanceCriterionSchema),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * A single structured non-goal. An exclusion must name itself (`text`) AND justify itself
 * (`rationale`), turning a free-text escape hatch into an auditable
 * record. `source_refs` optionally back-points at the dropped
 * source-plan item(s) it excludes (free-form strings for MVP, e.g.
 * `"section 2.3"`, resolved against the pinned plan by the conformance
 * judge); not every non-goal drops a source item, so it defaults to
 * empty.
 *
 * Both `text` and `rationale` must be **non-blank** — `min(1)` alone
 * accepts a single space and would reopen the very gap the structured
 * shape exists to close. `text` is capped at 2048 to mirror the cloud
 * wire contract (`OssPlanPayload.non_goals` strings, where this flattens
 * to `text`), so a non-goal can never pass local capture yet explode on
 * sync.
 */
export const NonGoalSchema = z.object({
  text: proseText(z.string().min(1).max(2048)),
  rationale: proseText(),
  source_refs: z.array(proseText(z.string())).default([]),
});
export type NonGoal = z.infer<typeof NonGoalSchema>;

/**
 * Persisted (durable-read) variant: the input default above materializes
 * `source_refs` on every write, so a stored non-goal missing it can only be
 * loss or tampering — the strict read fails with the field path instead of
 * silently healing to `[]`.
 */
export const PersistedNonGoalSchema = NonGoalSchema.safeExtend({
  source_refs: z.array(proseText(z.string())),
});

/**
 * Server-computed diff between the prior plan revision and this one.
 * Lives inline on every `plan_revised` payload so digest/show/doctor
 * read it directly without recomputing. Empty arrays on the initial
 * `plan_captured` (revision_n = 0).
 *
 * Self-consistency invariants (validated on write):
 *   - added ∪ unchanged ∪ rewritten == new plan's step_id set
 *   - dropped ∪ unchanged ∪ rewritten == prior plan's step_id set
 */
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

/**
 * Server-computed criterion-level diff against the prior revision —
 * the acceptance-criteria sibling of `StepLineageSchema`.
 *
 *   - `added`: criterion_ids minted this revision (omitted entries with no
 *     auto-carry match). Together with `carried`, drives the idempotency strip
 *     in `extractInputStepShapeFromCommitted`.
 *   - `carried`: prior criterion_ids auto-carried this revision — an omitted
 *     entry whose text byte-identically matched a prior criterion on the same
 *     step, so identity is reconciled rather than re-minted. Concrete in the
 *     committed plan but NOT in `added`, so the extract must null both `added`
 *     and `carried` to keep a same-call re-omit a replay, not a conflict.
 *   - `removed`: criteria that existed in the prior revision and are
 *     gone from this one. Rich (carries the prior `text` + owning
 *     `prior_step_id`) because the latest plan no longer holds that text,
 *     so the digest can render the dropped rubric without a back-read.
 *   - `rewritten`: criteria whose id is preserved but whose text changed
 *     (a silent rubric-weakening vector — `store.ts` revise takes the new
 *     text verbatim). Carries prior + new text for a digest diff.
 *
 * Empty on revision_n = 0 (no prior plan exists).
 */
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
    // The authoring agent — runtime-resolved at capture by the CLI
    // (shared capture-identity list, config.ts).
    agent: z.enum(CAPTURE_AGENT_IDS),
    agent_session_id: z.string().nullable(),
    task: z.string().min(1),
    /**
     * Plan-level short headline — see `PlanLabelSchema`. Required at
     * every revision (no implicit carryover); agents may sharpen the
     * label as scope evolves.
     */
    label: PlanLabelSchema,
    /**
     * Ordered list of steps. Each carries a stable UUIDv7 `step_id` that
     * survives plan revisions — checkpoints' `declared_step_ids` /
     * `completed_step_ids` reference these IDs directly.
     */
    plan_steps: z.array(PlanStepSchema).min(1),
    touched_scope: z.array(z.string()),
    non_goals: z.array(PersistedNonGoalSchema),
    /**
     * Plan-time architectural decisions — the choice captured where it's
     * made (plan mode), each with `revision_n` and optional
     * `alternatives_considered`. Append-only /
     * cumulative across revisions: the write path stores `prior + new`
     * so the latest plan holds the full set (the latest-wins rebuilder
     * is unchanged). Required: every launch writer materializes the
     * array; persisted payloads without it fail parse by design.
     */
    decisions: z.array(PlanDecisionSchema),
    /** Optional-absent provenance for artifacts synthesized from git history. */
    origin: ArtifactOriginSchema.optional(),
    started_at: z.string().datetime(),
    /**
     * 0-based revision counter. `0` is the initial `plan_captured`; each
     * `plan_revised` event increments by 1. "Revision count" in surfaces
     * = `revision_n` (so revisions-after-initial is the natural count).
     */
    revision_n: z.number().int().nonnegative(),
    /** ISO timestamp of the latest revision; null on revision_n = 0. */
    revised_at: z.string().datetime().nullable(),
    /**
     * The agent that invoked the latest `plan revise` — runtime-resolved
     * by the CLI, distinct from `agent` (the authoring agent, frozen at
     * initial capture). ABSENT on revision_n = 0 (the initial-capture
     * writer never sets the key — hash stability); the revise writer
     * always materializes it (null for storage-direct callers).
     */
    revised_by_agent: z.enum(CAPTURE_AGENT_IDS).nullable().optional(),
    /**
     * Required and non-empty on revisions; null on revision_n = 0. The
     * `revision-rationale-required` evaluator enforces non-emptiness;
     * the schema permits an empty string only on the initial capture
     * (which uses `null`) so the type stays uniform.
     */
    rationale: z.string().nullable(),
    /**
     * Server-computed diff against the prior revision. Empty on
     * revision_n = 0 (no prior plan exists).
     */
    step_lineage: StepLineageSchema,
    /**
     * Server-computed criterion-level diff against the prior revision —
     * sibling to `step_lineage`. `added` drives the
     * idempotency strip; `removed` / `rewritten` make a narrowed
     * acceptance-criteria rubric visible in the digest. Empty on
     * revision_n = 0.
     */
    criterion_lineage: CriterionLineageSchema,
    /**
     * Event ID of the immediately-prior `plan_captured` / `plan_revised`
     * event. Used by clients as the optimistic-concurrency token on the
     * next revision (`prior_plan_event_id`) and on `checkpoint open`
     * (`plan_revision_id`). Null on revision_n = 0.
     */
    prior_plan_event_id: z.string().min(1).nullable(),
  })
  .superRefine((plan, ctx) => {
    // Step labels must be unique within a revision — they are the
    // human / cloud-platform-facing identifier and a duplicate makes
    // them useless for reference. Enforced here so every Plan parse
    // (initial capture + revise) shares one validation path.
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

    // criterion_ids must be unique across the whole revision — they are
    // the stable identity that close-time `done_criteria` evidence keys
    // back to, so a duplicate would let evidence bind ambiguously.
    // Cross-step reassignment and "must exist in the prior revision" are
    // revise-only guards enforced in the store (they need the prior plan).
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

/** Event-backed plan projection. Authoring uses {@link PlanInputSchema}. */
export const PlanSchema = PlanInputSchema.safeExtend({
  source_event_id: z.string().min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Per-step reword advisory carried on a `plan revise` result. Each
 * entry names a step where this revision BOTH dropped a prior criterion and
 * minted a new one — a *possible* omitted-`criterion_id`-on-reword.
 */
export interface CriterionRewordWarning {
  step_id: string;
  label: string;
  /** Prior criterion texts dropped on this step (from `criterion_lineage.removed`). */
  removed_texts: string[];
  /** Criteria freshly minted on this step this revision — the actionable candidates. */
  minted: Array<{ criterion_id: string; text: string }>;
}

/**
 * Advisory (gates nothing): flag per-step drop+mint co-occurrence on a revision.
 *
 * After auto-carry, a criterion whose text is unchanged keeps its id (it lands in
 * `criterion_lineage.carried`, NOT `added`). So when a single step shows BOTH a
 * dropped criterion (in `removed`) AND a freshly minted one (in `added`), the mint
 * MAY be a prior criterion reworded with its `criterion_id` omitted — which loses
 * lineage fidelity and can orphan the `done_criteria` evidence keyed to the old id.
 *
 * Deliberately hedged: per-step drop+mint is NOT necessarily a reword (an
 * intentional remove plus an unrelated add produces the same shape), so the result
 * carries both the dropped texts and the actionable minted `{criterion_id, text}`
 * and lets the agent decide — re-supplying the `criterion_id` if it was a reword.
 *
 * Keyed off `added` (mints only) — NOT `added ∪ carried` — so a clean auto-carry
 * never warns.
 *
 * This signal is per-step, so it does not catch a cross-step move (drop on
 * step A, mint on step B with identical text). The revise API cannot express
 * "same criterion, new step": cross-step `criterion_id` reuse is invalid.
 */
/**
 * Non-blocking cross-step criterion-move advisory.
 *
 * Fires only when a revision drops a criterion text on one SURVIVING step
 * and mints the identical trimmed text on a DIFFERENT step — the shape of
 * a criterion "moved" across steps. All three guards are mandatory:
 *
 *  1. Deterministic 1:1 pairing — the trimmed text appears exactly once in
 *     `criterion_lineage.removed` and exactly once among this revision's
 *     mints, on different steps.
 *  2. The source step survives the revision (whole-step restructuring is
 *     covered by step-lineage and acknowledgement machinery instead).
 *  3. Texts that also appear as duplicates or `carried` occurrences on
 *     other steps are suppressed (boilerplate).
 *
 * The message explains that cross-step `criterion_id` reuse is forbidden;
 * it deliberately never advises re-supplying the old id (which would be
 * INVALID_INPUT — a criterion_id can only be carried on its own step).
 */
export interface CriterionMoveWarning {
  kind: 'cross-step-criterion-move';
  source_step_id: string;
  destination_step_id: string;
  /** Trimmed criterion text shared by the drop and the mint. */
  text: string;
  minted_criterion_id: string;
  message: string;
}

export function criterionMoveWarnings(plan: Plan): CriterionMoveWarning[] {
  const stepIds = new Set(plan.plan_steps.map((s) => s.step_id));
  const added = new Set(plan.criterion_lineage.added);

  // Trimmed-text occurrence counts across BOTH sides of the pairing.
  const removedByText = new Map<string, Array<{ prior_step_id: string }>>();
  for (const r of plan.criterion_lineage.removed) {
    const t = r.text.trim();
    const list = removedByText.get(t) ?? [];
    list.push({ prior_step_id: r.prior_step_id });
    removedByText.set(t, list);
  }
  const mintsByText = new Map<string, Array<{ step_id: string; criterion_id: string }>>();
  // Occurrences of each trimmed text across EVERY current criterion — not
  // just lineage-carried ids. Explicitly re-supplied criterion_ids never
  // land in `criterion_lineage.carried`, so an id-based check would let a
  // boilerplate text that survives on another step slip past guard 3.
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
    // Guard 1: exactly one drop and exactly one mint of this text.
    if (removed.length !== 1 || mints === undefined || mints.length !== 1) continue;
    const source = removed[0];
    const mint = mints[0];
    // Same-step drop+mint is reword territory, not a move.
    if (source.prior_step_id === mint.step_id) continue;
    // Guard 2: the source step must survive the revision.
    if (!stepIds.has(source.prior_step_id)) continue;
    // Guard 3: boilerplate suppression — the text also lives on ANOTHER
    // current criterion (the single mint accounts for exactly one).
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
  const added = new Set(plan.criterion_lineage.added); // mints only — NOT added ∪ carried
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
