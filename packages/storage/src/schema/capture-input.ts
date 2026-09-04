import { z } from 'zod';

import {
  CheckpointDecisionSchema,
  DoneCriterionSchema,
  PolicyExceptionSchema,
  VerificationEntrySchema,
} from './checkpoint.js';
import { DecisionBaseSchema } from './decision.js';
import { NonGoalSchema, PlanLabelSchema, PlanStepLabelSchema } from './plan.js';
import { AcceptedWarningsSchema } from './summary.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { identifierText, proseText } from '../text/control-chars.js';

/**
 * Per-criterion input on initial `capture plan` — the caller supplies
 * only `text`; the runtime mints the UUIDv7 `criterion_id` (mirrors how
 * step_ids are minted server-side).
 */
const CaptureAcceptanceCriterionInputSchema = z.object({
  text: proseText(),
});

/**
 * Per-criterion input on `capture plan revise`. The caller may carry a
 * `criterion_id` forward (preserve identity explicitly), or omit it — in which
 * case the store reconciles identity by text: an omitted criterion whose text
 * byte-identically matches an unconsumed prior criterion on the SAME step
 * auto-carries that prior id (so restating an unchanged criterion never churns
 * its identity, even without echoing the id), and only an omitted criterion with
 * no such prior-text match mints a fresh id. The store rejects a SUPPLIED id that
 * did not exist in the prior revision or belonged to a different step.
 */
const PlanReviseAcceptanceCriterionInputSchema = z.object({
  criterion_id: identifierText().optional(),
  text: proseText(),
});

/**
 * Per-step input on `orcaops capture plan` (initial). Caller supplies
 * the display `text` and a short-form description `label` (1-line
 * TL;DR of the step); the runtime mints a UUIDv7 `step_id`. Labels
 * must be unique within the plan — uniqueness is enforced at the
 * storage write path (returns `INVALID_INPUT`).
 */
export const CapturePlanStepInputSchema = z.object({
  text: proseText(),
  label: proseText(PlanStepLabelSchema),
  acceptance_criteria: z.array(CaptureAcceptanceCriterionInputSchema).default([]),
});
export type CapturePlanStepInput = z.infer<typeof CapturePlanStepInputSchema>;

/**
 * Idempotency key — used to dedup retries (project-wide for `capture
 * plan`, artifact-scoped for the rest). Any non-empty string the caller
 * picks.
 *
 * Auto-minted (UUIDv7) when absent, so the common path never has to
 * juggle a fresh key: the field is optional on input and always present
 * on output. Supply one explicitly only for replay-safe retries — a
 * caller that wants a retried call to dedup as a replay (rather than mint
 * a new event) must reuse the same key. `.default()` already makes the
 * input optional, so there is no separate `.optional()`. It is an
 * identifier (control chars rejected, never stripped — a silent rewrite
 * would change which prior call a retry dedups against).
 */
const IdempotencyKeySchema = identifierText().default(() => uuidv7());

/**
 * Agent-facing input shape for `orcaops capture plan` (initial capture).
 * Each step entry carries display `text` and a short-form description
 * `label`; the runtime mints UUIDv7 `step_id`s and returns them in the
 * response. Smaller than the full Plan because the runtime derives:
 *   - artifact_id (UUIDv7)
 *   - base_sha (git rev-parse HEAD)
 *   - started_at (now)
 *   - schema_version (always 4)
 *   - agent (from config)
 *   - agent_session_id (null unless caller provides)
 *   - revision_n (always 0 for initial)
 *   - revised_at, rationale, prior_plan_event_id (all null on initial)
 *   - step_lineage (empty on initial)
 *   - per-step step_id (UUIDv7 minted server-side)
 */
export const CapturePlanInputSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  task: proseText(),
  /**
   * Plan-level short headline (1–70 chars, single line, trimmed). The
   * thread-grain analogue of `PlanStep.label`; agents supply it on
   * every initial capture. See `PlanLabelSchema` in plan.ts.
   */
  label: proseText(PlanLabelSchema),
  branch: identifierText().optional(),
  plan_steps: z.array(CapturePlanStepInputSchema).min(1),
  touched_scope: z.array(proseText(z.string())).default([]),
  /**
   * Things this plan is intentionally NOT going to do. First-class
   * intent-debt field. Surfaces in plan.md, digest, and resume; checked
   * at checkpoint-close by the `non-goals-violated` evaluator.
   */
  non_goals: z.array(NonGoalSchema).default([]),
  /**
   * Plan-time decisions (base shape — the agent supplies NO
   * `revision_n`; the write path stamps it at `revision_n: 0` on
   * initial capture). Defaults to empty so existing callers are
   * unaffected.
   */
  decisions: z.array(DecisionBaseSchema).default([]),
  agent_session_id: identifierText(z.string()).nullable().optional(),
});
export type CapturePlanInput = z.infer<typeof CapturePlanInputSchema>;

/**
 * Per-step input on `orcaops capture plan revise`. Agent supplies a
 * full new plan_steps array; each entry may carry a `step_id` to
 * preserve identity across the revision (carryover or rewrite) or
 * omit it to signal a fresh step (server mints UUIDv7). `label` is
 * always required — caller supplies it on every entry, including
 * carryovers (the prior label is not implicitly inherited; revising
 * is the supported way to relabel a step).
 *
 * The diff against the prior plan is computed server-side and emitted
 * as `step_lineage` on the `plan_revised` event payload.
 */
export const PlanReviseStepInputSchema = z.object({
  step_id: identifierText().optional(),
  text: proseText(),
  label: proseText(PlanStepLabelSchema),
  acceptance_criteria: z.array(PlanReviseAcceptanceCriterionInputSchema).default([]),
});
export type PlanReviseStepInput = z.infer<typeof PlanReviseStepInputSchema>;

/**
 * Agent-facing input for `orcaops capture plan revise`. Mirrors the
 * checkpoint open/close pattern: artifact-scoped, three-outcome
 * idempotency, optimistic-concurrency token (`prior_plan_event_id`).
 *
 * Validation gates owned by the runtime:
 *   - `ARTIFACT_FINALIZED` if a summary_captured event exists
 *     (revision is frozen post-summary; pre_pr_checked does NOT
 *     finalize — pre-pr is a repeatable gate before summary).
 *   - `PLAN_REVISION_OPEN_CP_CONFLICT` if any `step_id` declared by
 *     an open cp would be dropped.
 *   - `INVALID_INPUT` (unacknowledged_drops) if any `step_id`
 *     completed by a closed cp would be dropped without an
 *     `acknowledge_drops_completed_steps` entry covering it.
 *   - `STALE_PLAN_REVISION` if `prior_plan_event_id` is not the
 *     latest plan event for the artifact.
 *   - `IDEMPOTENCY_CONFLICT` on key reuse with a different payload.
 */
export const CapturePlanReviseInputSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  artifact_id: identifierText(),
  /**
   * Plan-level short headline for the new revision. Required (no
   * implicit carryover from the prior revision) — `plan revise` is
   * the supported way to relabel the thread, mirroring the per-step
   * `label` policy.
   */
  label: proseText(PlanLabelSchema),
  /**
   * Full new plan: a complete supersede payload. Each entry preserves
   * a `step_id` to carry over (or rewrite) the existing step;
   * omitting `step_id` mints a new one for the new step.
   */
  plan_steps: z.array(PlanReviseStepInputSchema).min(1),
  touched_scope: z.array(proseText(z.string())).default([]),
  non_goals: z.array(NonGoalSchema).default([]),
  /**
   * Plan-time decisions added in THIS revision (base shape — no
   * `revision_n`; the write path stamps it at the new revision and
   * cumulates onto the prior set). Append-only: a revise supplies only
   * the new decisions, never the full history. Defaults to empty.
   */
  decisions: z.array(DecisionBaseSchema).default([]),
  /**
   * Required (non-empty) on revisions; the
   * `revision-rationale-required` evaluator enforces this further at
   * post-plan-revision time.
   */
  rationale: proseText(),
  /**
   * Optimistic-concurrency token. The event_id of the latest plan
   * event the agent observed (typically surfaced in resume's
   * `plan_event_id`). Required to make the revision serializable
   * against concurrent revisions; null permits the agent to skip the
   * check (race tolerance).
   */
  prior_plan_event_id: identifierText().nullable(),
  /**
   * Explicit acknowledgement (one entry per closed-cp-claimed step
   * being dropped). Mirrors the explicit policy-exception opt-in pattern
   * — silent drop of a closed-cp-claimed step is rejected; explicit
   * acknowledgement is recorded in the event payload.
   */
  acknowledge_drops_completed_steps: z.array(identifierText()).default([]),
  /**
   * Explicit acknowledgement for removing a criterion from an open or
   * completed step. Additions and rewrites on protected steps are rejected;
   * an acknowledgement records narrowing only.
   */
  acknowledge_criteria_changes: z.array(identifierText()).default([]),
  agent_session_id: identifierText(z.string()).nullable().optional(),
});
export type CapturePlanReviseInput = z.infer<typeof CapturePlanReviseInputSchema>;

/**
 * Agent-facing input for `orcaops capture checkpoint open`.
 * Runtime derives: opened_at (now), head_sha (git HEAD), n (server-assigned).
 */
export const CaptureCheckpointOpenInputSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  // Optional: omit to autodetect the single active artifact on the branch.
  artifact_id: identifierText().optional(),
  /**
   * UUIDv7 step_ids the new cp will cover. Must be non-empty and must
   * all reference step_ids present in the plan revision active at
   * open time (validated against the plan_revision_id token if
   * supplied).
   */
  declared_step_ids: z.array(identifierText()).min(1),
  /** Optional subagent attribution; surfaces in status/resume/digest. */
  agent_session_id: identifierText().optional(),
  /**
   * Inline pre-write block-resolution. Each entry names an evaluator
   * (which must set `resolution.policy_exception.enabled: true`) plus a
   * reason. The exception is recorded on the open cp and surfaces in
   * the digest; doctor flags persistent dismissals.
   */
  policy_exceptions: z.array(PolicyExceptionSchema).default([]),
  /**
   * Optimistic-concurrency token: latest plan event_id the agent
   * observed. Null = skip the freshness check (lower-friction path).
   */
  plan_revision_id: identifierText().nullable().optional(),
});
export type CaptureCheckpointOpenInput = z.infer<typeof CaptureCheckpointOpenInputSchema>;

/**
 * Agent-facing input for `orcaops capture checkpoint close`. The agent
 * passes back `n` from the prior `open` call. Runtime derives:
 *   - closed_at (now)
 *   - head_sha (git HEAD)
 */
export const CaptureCheckpointCloseInputSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  // Optional: omit to autodetect the single active artifact on the branch.
  artifact_id: identifierText().optional(),
  // Optional: omit to close the single open checkpoint (AMBIGUOUS_CHECKPOINT if >1 open).
  n: z.number().int().positive().optional(),
  summary: proseText(),
  files_changed: z.array(proseText(z.string())).default([]),
  decisions: z.array(CheckpointDecisionSchema).default([]),
  uncertainty: z.array(proseText(z.string())).default([]),
  done_criteria: z.array(DoneCriterionSchema).default([]),
  /**
   * Verified-close evidence: commands run fresh at close
   * with their exit codes. `.default([])` HERE for agent ergonomics —
   * the input is never hashed; the storage layers convert an empty
   * array to key-absence (optional-absent posture, see checkpoint.ts).
   */
  verification: z.array(VerificationEntrySchema).default([]),
  /**
   * UUIDv7 step_ids completed by THIS checkpoint. Must be a subset of
   * the open cp's `declared_step_ids` (subset, not equal — agents
   * discover scope mid-step). The storage write path additionally
   * validates each value against the plan revision active at open
   * time and rejects duplicates within the array.
   */
  completed_step_ids: z.array(identifierText()).default([]),
});
export type CaptureCheckpointCloseInput = z.infer<typeof CaptureCheckpointCloseInputSchema>;

/**
 * Agent-facing input for `orcaops capture checkpoint abandon`. Cancels
 * an open cp without claiming work; the declared steps are released.
 */
export const CaptureCheckpointAbandonInputSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  // Optional: omit to autodetect the single active artifact on the branch.
  artifact_id: identifierText().optional(),
  n: z.number().int().positive(),
  reason: proseText(),
});
export type CaptureCheckpointAbandonInput = z.infer<typeof CaptureCheckpointAbandonInputSchema>;

/**
 * Agent-facing input for `orcaops capture summary`. Runtime supplies ts +
 * head_sha: a first capture derives head_sha from current HEAD, while a
 * supersede inherits the superseded summary's head_sha so an amendment cannot
 * widen the window it records.
 */
export const CaptureSummaryInputSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  // Optional: omit to autodetect the single active artifact on the branch.
  artifact_id: identifierText().optional(),
  outcome: proseText(),
  tests_written: z.array(proseText(z.string())).default([]),
  tests_run: z.array(proseText(z.string())).default([]),
  open_items: z.array(proseText(z.string())).default([]),
  deferred_decisions: z.array(proseText(z.string())).default([]),
  accepted_warnings: AcceptedWarningsSchema.optional(),
  // Supersede token — the latest summary event id, REQUIRED to replace
  // an existing summary (a bare re-capture is refused). Consumed by the write
  // path as an optimistic-concurrency check; never persisted into the payload.
  prior_summary_event_id: identifierText().optional(),
});
export type CaptureSummaryInput = z.infer<typeof CaptureSummaryInputSchema>;

/** Input for `orcaops capture run-evaluators` (explicit re-run). */
export const CaptureRunEvaluatorsInputSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  artifact_id: identifierText(),
  fires_at: z.enum([
    'post-plan',
    'post-plan-revision',
    'checkpoint-open',
    'checkpoint-close',
    'pre-pr',
  ]),
  /** Required when fires_at is checkpoint-open or checkpoint-close. */
  checkpoint_n: z.number().int().positive().optional(),
});
export type CaptureRunEvaluatorsInput = z.infer<typeof CaptureRunEvaluatorsInputSchema>;

/** Input for `orcaops capture pre-pr-check`. */
export const CapturePrePrCheckInputSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  // Optional: omit to autodetect the single active artifact on the branch.
  artifact_id: identifierText().optional(),
  branch: identifierText().optional(),
});
export type CapturePrePrCheckInput = z.infer<typeof CapturePrePrCheckInputSchema>;

/** Input for `orcaops capture acknowledge`. */
export const CaptureAcknowledgeInputSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  artifact_id: identifierText(),
  evaluator: identifierText(),
  reason: proseText(),
});
export type CaptureAcknowledgeInput = z.infer<typeof CaptureAcknowledgeInputSchema>;
