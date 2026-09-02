import { z } from 'zod';

import { EvaluatorPhaseSchema, IdSchema } from './common.js';

/**
 * Stable-versioned subset shapes of the storage types. The runner
 * builds these from storage projections; evaluators consume them
 * exclusively. Storage can evolve internal fields without breaking
 * packs — the protocol owns the wire shape evaluators depend on.
 */

const StepLineageEntrySchema = z
  .object({
    step_id: IdSchema,
    prior_text_hash: z.string().min(1),
  })
  .strict();

const AcceptanceCriterionContextSchema = z
  .object({
    criterion_id: IdSchema,
    text: z.string(),
  })
  .strict();

const DoneCriterionContextSchema = z
  .object({
    criterion_id: IdSchema,
    evidence: z.string(),
  })
  .strict();

/**
 * Verified-close evidence entry. The bridge serializes the
 * `verification` key ONLY when non-empty (omit-when-empty) so context
 * files stay parseable by separately-built packs pinning older strict
 * schemas; `.default([])` below means new packs always see an array.
 */
const VerificationEntryContextSchema = z
  .object({
    command: z.string(),
    exit_code: z.number().int(),
    output_digest: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const PlanStepContextSchema = z
  .object({
    step_id: IdSchema,
    text: z.string(),
    label: z.string(),
    acceptance_criteria: z.array(AcceptanceCriterionContextSchema),
  })
  .strict();

/**
 * Wire-subset of the storage `NonGoal` ({ text, rationale, source_refs }).
 * Defined locally — the protocol owns its own shapes and must NOT import
 * from `@orcaops/storage`. `PlanContext.non_goals` uses this structured
 * shape rather than a flat `string[]`; `source_refs` back-pointers +
 * `rationale` are what let the `plan-conformance` judge tell a declared
 * exclusion from a silent gap.
 */
const NonGoalContextSchema = z
  .object({
    text: z.string(),
    rationale: z.string(),
    source_refs: z.array(z.string()),
  })
  .strict();
export type NonGoalContext = z.infer<typeof NonGoalContextSchema>;

/**
 * Plan-time / checkpoint decision wire-subset. Declared ABOVE
 * `PlanContextSchema` because that schema references it at module-eval
 * (Zod builds eagerly): a `const` used before its declaration is a TDZ
 * ReferenceError, not a hoisting no-op. `.strict()` — the storage-only
 * `revision_n` on plan decisions MUST be stripped by the CLI bridge.
 */
const DecisionContextSchema = z
  .object({
    decision: z.string(),
    reason: z.string(),
    /**
     * Optional rejected alternatives mirrored from the stored
     * `CheckpointDecisionSchema`. Carried into the context (rather than
     * stripped) so evaluators that inspect decision narrative receive the
     * complete authored decision. Optional: absent on decisions that didn't
     * record alternatives.
     */
    alternatives_considered: z
      .array(
        z
          .object({
            option: z.string(),
            rejected_because: z.string(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

export const PlanContextSchema = z
  .object({
    task: z.string(),
    label: z.string(),
    branch: z.string().min(1),
    base_sha: z.string().min(1),
    agent: z.string().nullable(),
    agent_session_id: z.string().nullable(),
    plan_steps: z.array(PlanStepContextSchema),
    touched_scope: z.array(z.string()),
    non_goals: z.array(NonGoalContextSchema),
    /**
     * Plan-time decisions — the base shape
     * (`{ decision, reason, alternatives_considered? }`); `revision_n`
     * is storage-only and is stripped by the CLI bridge before it
     * reaches here (this schema is `.strict()`). Carried so future
     * conformance / decision-aware evaluators see declared plan
     * decisions and capture-time secret scanners walk their narrative.
     */
    decisions: z.array(DecisionContextSchema),
    revision_n: z.number().int().nonnegative(),
    revised_at: z.string().nullable(),
    rationale: z.string().nullable(),
    step_lineage: z
      .object({
        added: z.array(IdSchema).default([]),
        dropped: z.array(IdSchema).default([]),
        unchanged: z.array(IdSchema).default([]),
        rewritten: z.array(StepLineageEntrySchema).default([]),
      })
      .strict(),
    started_at: z.string(),
  })
  .strict();
export type PlanContext = z.infer<typeof PlanContextSchema>;

const PolicyExceptionContextSchema = z
  .object({
    evaluator: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const OpenCheckpointContextSchema = z
  .object({
    status: z.literal('open'),
    n: z.number().int().positive(),
    declared_step_ids: z.array(IdSchema),
    agent_session_id: z.string().nullable(),
    policy_exceptions: z.array(PolicyExceptionContextSchema),
    plan_revision_id: z.string().nullable(),
    head_sha: z.string().min(1),
    opened_at: z.string(),
  })
  .strict();

const ClosedCheckpointContextSchema = z
  .object({
    status: z.literal('closed'),
    n: z.number().int().positive(),
    declared_step_ids: z.array(IdSchema),
    completed_step_ids: z.array(IdSchema),
    agent_session_id: z.string().nullable(),
    policy_exceptions: z.array(PolicyExceptionContextSchema),
    plan_revision_id: z.string().nullable(),
    summary: z.string(),
    files_changed: z.array(z.string()),
    decisions: z.array(DecisionContextSchema),
    uncertainty: z.array(z.string()),
    done_criteria: z.array(DoneCriterionContextSchema),
    verification: z.array(VerificationEntryContextSchema).default([]),
    head_sha: z.string().min(1),
    opened_at: z.string(),
    closed_at: z.string(),
  })
  .strict();

const AbandonedCheckpointContextSchema = z
  .object({
    status: z.literal('abandoned'),
    n: z.number().int().positive(),
    declared_step_ids: z.array(IdSchema),
    agent_session_id: z.string().nullable(),
    head_sha: z.string().min(1),
    reason: z.string(),
    opened_at: z.string(),
    abandoned_at: z.string(),
  })
  .strict();

export const CheckpointContextSchema = z.discriminatedUnion('status', [
  OpenCheckpointContextSchema,
  ClosedCheckpointContextSchema,
  AbandonedCheckpointContextSchema,
]);
export type CheckpointContext = z.infer<typeof CheckpointContextSchema>;
export type OpenCheckpointContext = z.infer<typeof OpenCheckpointContextSchema>;
export type ClosedCheckpointContext = z.infer<typeof ClosedCheckpointContextSchema>;
export type AbandonedCheckpointContext = z.infer<typeof AbandonedCheckpointContextSchema>;

export const SummaryContextSchema = z
  .object({
    outcome: z.string(),
    open_items: z.array(z.string()),
    tests_written: z.array(z.string()),
    tests_run: z.array(z.string()),
    /** Acknowledged decisions deferred to a follow-up artifact. */
    deferred_decisions: z.array(z.string()),
    /**
     * ISO timestamp when the summary event was captured. Distinct from
     * `plan.started_at` (which is plan-capture time); future checkers
     * comparing summary timing rely on the actual write time.
     */
    written_at: z.string().datetime(),
  })
  .strict();
export type SummaryContext = z.infer<typeof SummaryContextSchema>;

export const RepoContextSchema = z
  .object({
    root: z.string().min(1),
    branch: z.string().min(1),
    base_sha: z.string().min(1),
    head_sha: z.string().min(1),
  })
  .strict();
export type RepoContext = z.infer<typeof RepoContextSchema>;

/**
 * Wire-subset of the storage `SourcePlanPin` — the immutable source
 * plan pinned via `--source-plan`, carried artifact-level into the
 * evaluator context for `plan-conformance` to grade against. Defined
 * locally (the protocol owns its shapes; no storage import). `kind` is a
 * loose `string` so a future `cloud:` backend needs no reshape here — the
 * judge never branches on it.
 */
const SourceRefContextSchema = z
  .object({
    kind: z.string(),
    locator: z.string(),
    version: z.string().optional(),
  })
  .strict();

export const SourcePlanContextSchema = z
  .object({
    source_ref: SourceRefContextSchema,
    content: z.string(),
    hash: z.string(),
  })
  .strict();
export type SourcePlanContext = z.infer<typeof SourcePlanContextSchema>;

export const EvaluatorContextSchema = z
  .object({
    schema: z.literal('orcaops.evaluator_context/v1'),
    run_id: IdSchema,
    evaluator_ref: z.string().min(1),
    phase: EvaluatorPhaseSchema,
    artifact_id: IdSchema,
    checkpoint_n: z.number().int().positive().nullable(),
    repo: RepoContextSchema,
    plan: PlanContextSchema,
    prior_plan: PlanContextSchema.nullable(),
    /**
     * The pinned source plan for `plan-conformance`, or `null` when the
     * artifact didn't opt in via `--source-plan`. Artifact-level
     * (sibling of `plan`), not inside PlanContext. MUST be populated as
     * `null` rather than omitted — the schema is `.strict()`.
     */
    source_plan: SourcePlanContextSchema.nullable(),
    current_checkpoint: CheckpointContextSchema.nullable(),
    closed_checkpoints: z.array(CheckpointContextSchema),
    open_checkpoints: z.array(CheckpointContextSchema),
    abandoned_checkpoints: z.array(CheckpointContextSchema),
    summary: SummaryContextSchema.nullable(),
    changed_files: z.array(z.string()),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EvaluatorContext = z.infer<typeof EvaluatorContextSchema>;
