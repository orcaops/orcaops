import { z } from 'zod';

/**
 * Lifecycle hook an evaluator runs at. The five hooks cover the
 * capture lifecycle: post-plan → (post-plan-revision)* →
 * (checkpoint-open → checkpoint-close)* → pre-pr. Summary capture does
 * not run evaluators.
 */
export const EvaluatorPhaseSchema = z.enum([
  'post-plan',
  'post-plan-revision',
  'checkpoint-open',
  'checkpoint-close',
  'pre-pr',
]);
export type EvaluatorPhase = z.infer<typeof EvaluatorPhaseSchema>;

/** How strongly a violation matters. */
export const EvaluatorSeveritySchema = z.enum(['info', 'warn', 'block']);
export type EvaluatorSeverity = z.infer<typeof EvaluatorSeveritySchema>;

/** Engine dispatch kind. Future engines slot in cleanly. */
export const EvaluatorEngineKindSchema = z.enum(['command', 'llm']);
export type EvaluatorEngineKind = z.infer<typeof EvaluatorEngineKindSchema>;

/** Output format for LLM-engine evaluators. */
export const LlmOutputFormatSchema = z.enum(['markdown', 'json']);
export type LlmOutputFormat = z.infer<typeof LlmOutputFormatSchema>;

/** LLM effort level passed through to the provider. */
export const LlmEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type LlmEffort = z.infer<typeof LlmEffortSchema>;

/** LLM provider identifier. */
export const LlmProviderSchema = z.enum(['claude', 'codex']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

/**
 * Named sections of the auto-prepended `## Context` block that an LLM
 * evaluator can request *in addition to* the baseline.
 *
 * Every LLM evaluator always receives the baseline — plan task, branch,
 * phase, touched scope, non-goals, plan steps, checkpoint summaries,
 * changed files, and summary outcome — gated only on whether that data
 * exists. These four are the heavier, opt-in sections, each of which
 * widens what leaves the repository for the provider:
 *
 *   `acceptance-criteria`   — per-step rubric the delivery is graded against
 *   `delivered-checkpoints` — each closed cp's completed steps + claimed evidence
 *   `diff-boundary`         — base/head SHA, changed files, worktree-inspection guidance
 *   `source-plan`           — the full pinned source-plan document
 */
export const ContextSectionSchema = z.enum([
  'acceptance-criteria',
  'delivered-checkpoints',
  'diff-boundary',
  'source-plan',
]);
export type ContextSection = z.infer<typeof ContextSectionSchema>;

/**
 * Eligibility behavior for an evaluator gated on LLM availability.
 *   `required` — skip when no LLM provider is configured.
 *   `absent`   — skip when an LLM IS configured (deterministic fallback sibling).
 *   `optional` — always eligible (the default).
 */
export const WhenLlmSchema = z.enum(['required', 'absent', 'optional']);
export type WhenLlm = z.infer<typeof WhenLlmSchema>;

/** Working directory mode for command-engine evaluators. */
export const EngineCwdSchema = z.enum(['package', 'repo']);
export type EngineCwd = z.infer<typeof EngineCwdSchema>;

/**
 * Execution state of a single evaluator run. Distinct from `verdict`:
 * `error` means the rule didn't run; `skipped` means it was filtered
 * out; `completed` means the rule produced a verdict.
 */
export const EvaluatorRunStatusSchema = z.enum(['completed', 'error', 'skipped']);
export type EvaluatorRunStatus = z.infer<typeof EvaluatorRunStatusSchema>;

/**
 * Evaluator's outcome when `run_status === 'completed'`. `null` when
 * the run didn't complete (the run carries an `error` or was skipped).
 */
export const EvaluatorVerdictSchema = z.enum(['pass', 'violation', 'info']);
export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>;

/**
 * Human/agent resolution of a blocking-eligible run. Materialized
 * field — derived in the projection from the latest
 * `evaluator_disposition_recorded` event whose `run_id` matches.
 *
 *   `unresolved`     — blocking-eligible, no disposition event yet
 *   `acknowledged`   — formal acknowledgement via `block acknowledge`
 *   `dismissed`      — override via `block dismiss`
 *   `policy-excepted`— bypass via inline `policy_exceptions[]` at open time
 *
 * `null` is used for the materialized field when a run is not
 * blocking-eligible (pass / info / error / skipped, or non-block severity).
 */
export const EvaluatorDispositionSchema = z.enum([
  'unresolved',
  'acknowledged',
  'dismissed',
  'policy-excepted',
]);
export type EvaluatorDisposition = z.infer<typeof EvaluatorDispositionSchema>;

/**
 * Subset of dispositions that get *written* as disposition events.
 * `unresolved` is a materialized-only value (never an event payload),
 * so disposition payloads validate against this narrower set.
 */
export const WrittenDispositionSchema = z.enum(['acknowledged', 'dismissed', 'policy-excepted']);
export type WrittenDisposition = z.infer<typeof WrittenDispositionSchema>;

/** Tokens reported by an LLM evaluator's provider. */
export const LlmTokenUsageSchema = z
  .object({
    in: z.number().int().nonnegative(),
    out: z.number().int().nonnegative(),
    /** Anthropic prompt-cache: served from cache (~10% of full input rate). */
    cache_read: z.number().int().nonnegative().optional(),
    /** Anthropic prompt-cache: wrote to cache (~125% on the write turn). */
    cache_write: z.number().int().nonnegative().optional(),
  })
  .strict();
export type LlmTokenUsage = z.infer<typeof LlmTokenUsageSchema>;

/**
 * Structured error payload attached to a run with `run_status: 'error'`.
 * `code` is from a small enum (TIMEOUT, EXIT_CODE, JSON_PARSE,
 * ENVELOPE_INVALID, RAW_SCHEMA_INVALID, OUTPUT_TOO_LARGE, CANCELED,
 * NO_VERDICT_LINE, ...) — kept open as `z.string()` so engine authors
 * can introduce new codes without a schema bump.
 */
export const EvaluatorRunErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();
export type EvaluatorRunError = z.infer<typeof EvaluatorRunErrorSchema>;

/**
 * Pattern that pack-IDs and evaluator-IDs share: kebab-case starting
 * with a lowercase alphanumeric. Used by the schemas in `package.ts`
 * and `spec.ts`, and by the resolved-ref parser.
 */
export const IdPatternRegex = /^[a-z0-9][a-z0-9-]*$/;

/** A non-empty UUIDv7 / opaque identifier string. Used for run_id, disposition_id, artifact_id, etc. */
export const IdSchema = z.string().min(1);
