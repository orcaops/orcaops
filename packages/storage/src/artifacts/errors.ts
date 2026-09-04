/**
 * Structured errors raised by the artifact-write path. The CLI
 * boundary catches these and remaps them to public error-code
 * envelopes (storage doesn't depend on the CLI's error registry —
 * see `apps/orcaops-cli/src/lib/run-capture.ts`).
 */

/**
 * Thrown by `ArtifactStore.writeSummary` when the artifact's
 * lifecycle state is `blocked` — a block-severity evaluator has either
 * produced an unresolved violation or failed to run. Violations can be
 * dispositioned; errors can only be cleared by a successful re-run.
 *
 * `blockingEvaluators` carries the set of evaluator names whose
 * latest run is blocking, so the CLI can surface what to fix or rerun.
 * Capture payloads aren't
 * touched — the gate runs *before* the event append.
 */
export class BlockedError extends Error {
  /** Stable, public-facing error code. Always `'BLOCKED'`. */
  readonly code = 'BLOCKED' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly blockingEvaluators: readonly string[]
  ) {
    super(message);
    this.name = 'BlockedError';
  }
}

/**
 * Thrown by `ArtifactStore.writeCheckpointOpened` when the proposed
 * `declared_step_ids` overlap with another open cp's declared scope
 * or with a closed cp's `completed_step_ids`. Distinct code because
 * parent agents handle it programmatically (retry with different
 * scope) differently from generic INVALID_INPUT.
 */
export class OpenCheckpointOverlapError extends Error {
  readonly code = 'OPEN_CP_OVERLAP' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly conflicts: ReadonlyArray<{
      stepId: string;
      heldBy:
        | { kind: 'open'; n: number; agent_session_id?: string }
        | { kind: 'closed'; n: number };
    }>
  ) {
    super(message);
    this.name = 'OpenCheckpointOverlapError';
  }
}

/**
 * Thrown by `ArtifactStore.writeSummary` when the artifact still has
 * one or more open checkpoints. Atomic with the summary write (the
 * gate check happens inside the artifact lock), so two-phase
 * lifecycle state can't drift between check and write.
 *
 * Each entry carries enough context (`n`, `agent_session_id`,
 * declared scope, idle time) for the CLI to produce a single
 * actionable error message naming what to close or abandon.
 */
export class OpenCheckpointsPendingError extends Error {
  readonly code = 'OPEN_CP_PENDING' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly openCheckpoints: ReadonlyArray<{
      n: number;
      agent_session_id: string | null;
      declared_step_ids: string[];
      opened_at: string;
      idle_for_seconds: number;
    }>
  ) {
    super(message);
    this.name = 'OpenCheckpointsPendingError';
  }
}

export class WarningAcceptanceInvalidError extends Error {
  readonly code = 'WARNING_ACCEPTANCE_INVALID' as const;
  readonly path = 'accepted_warnings' as const;

  constructor(
    message: string,
    public readonly artifactId: string
  ) {
    super(message);
    this.name = 'WarningAcceptanceInvalidError';
  }
}

/**
 * Base class for storage-side checkpoint-validation errors. The CLI
 * boundary maps these to public `INVALID_INPUT` envelopes, leaving
 * generic `Error` subclasses to surface as `INTERNAL` (a real bug).
 *
 * Each subclass carries enough context (artifactId, n where
 * applicable, the offending input) for the CLI to produce a
 * specific, actionable error message without re-deriving state.
 */
export abstract class CheckpointValidationError extends Error {
  abstract readonly code: string;
  /**
   * Field-attribution for the CLI's INVALID_INPUT envelope. Each
   * subclass overrides this with the input path that triggered the
   * rejection (e.g., 'declared_step_ids'). Optional — when
   * undefined, the CLI omits the `path` field on the error envelope.
   */
  readonly path?: string;
  constructor(
    message: string,
    public readonly artifactId: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when the agent passes an `n` that doesn't reference any cp. */
export class CheckpointNotFoundError extends CheckpointValidationError {
  readonly code = 'CHECKPOINT_NOT_FOUND' as const;
  readonly path = 'n' as const;
  constructor(
    artifactId: string,
    public readonly n: number
  ) {
    super(
      `No checkpoint at n=${n} for artifact "${artifactId}". ` +
        `Open one via \`orcaops capture checkpoint open\` first.`,
      artifactId
    );
  }
}

/** Thrown on close/abandon when the cp at `n` is already closed/abandoned. */
export class CheckpointNotOpenError extends CheckpointValidationError {
  readonly code = 'CHECKPOINT_NOT_OPEN' as const;
  readonly path = 'n' as const;
  constructor(
    artifactId: string,
    public readonly n: number,
    public readonly currentStatus: 'closed' | 'abandoned'
  ) {
    super(
      `Checkpoint #${n} is in status "${currentStatus}", not "open" — ` +
        `cannot close or abandon a non-open cp.`,
      artifactId
    );
  }
}

/**
 * Thrown by `writeCheckpointClosed` when `completed_step_ids`
 * contains a step_id the open cp didn't declare. Forces agents to
 * either narrow the close or open a separate cp for the new step_id.
 */
export class CompletedNotInDeclaredError extends CheckpointValidationError {
  readonly code = 'COMPLETED_NOT_IN_DECLARED' as const;
  readonly path = 'completed_step_ids' as const;
  constructor(
    artifactId: string,
    public readonly n: number,
    public readonly offendingStepId: string,
    public readonly declared: readonly string[]
  ) {
    super(
      `completed_step_ids contains "${offendingStepId}", which was not declared at open ` +
        `(declared: [${declared.join(', ')}]). Re-issue close with step_ids ⊆ the declared scope, ` +
        `or capture a separate cp for the new step.`,
      artifactId
    );
  }
}

/**
 * Thrown by `writeCheckpointOpened` when `declared_step_ids` fails
 * the no-duplicates / non-empty / step-exists checks. Mirrors the
 * Zod-level shape for callers that bypass the CLI parse.
 */
export class DeclaredStepsInvalidError extends CheckpointValidationError {
  readonly code = 'DECLARED_STEPS_INVALID' as const;
  readonly path = 'declared_step_ids' as const;
  constructor(
    artifactId: string,
    message: string,
    public readonly declared: readonly string[]
  ) {
    super(message, artifactId);
  }
}

/**
 * Thrown by `writeCheckpointClosed` when `completed_step_ids` fails
 * the no-duplicates check (the subset-of-declared check has its own
 * `CompletedNotInDeclaredError`). Distinct from
 * `DeclaredStepsInvalidError` so the message/path stays specific even
 * though both map to INVALID_INPUT at the CLI boundary.
 */
export class CompletedStepsInvalidError extends CheckpointValidationError {
  readonly code = 'COMPLETED_STEPS_INVALID' as const;
  readonly path = 'completed_step_ids' as const;
  constructor(
    artifactId: string,
    public readonly n: number,
    message: string,
    public readonly completed: readonly string[]
  ) {
    super(message, artifactId);
  }
}

/**
 * Thrown by `writeCheckpointClosed` when a `done_criteria` entry's
 * `criterion_id` does not resolve to an acceptance criterion on a step in
 * `completed_step_ids`. Evidence may only be attached to criteria of
 * steps this cp actually claims — otherwise a cp could invent evidence
 * for criteria it never delivered, reopening the self-report gap the
 * plan-time anchor exists to close. Maps to INVALID_INPUT (path:
 * done_criteria) at the CLI boundary.
 */
export class DoneCriteriaInvalidError extends CheckpointValidationError {
  readonly code = 'DONE_CRITERIA_INVALID' as const;
  readonly path = 'done_criteria' as const;
  constructor(
    artifactId: string,
    public readonly n: number,
    message: string
  ) {
    super(message, artifactId);
  }
}

/** Thrown when a checkpoint claims completion without citing verification. */
export class VerificationRequiredError extends CheckpointValidationError {
  readonly code = 'VERIFICATION_REQUIRED' as const;
  readonly path = 'verification' as const;

  constructor(
    artifactId: string,
    public readonly n: number
  ) {
    super(
      `Checkpoint #${n} claims completed step_ids but cites no verification. ` +
        `Run the proving command fresh and include { command, exit_code, output_digest? }; ` +
        `a non-zero exit code is valid honest evidence.`,
      artifactId
    );
  }
}

/**
 * Thrown by `writeCheckpointOpened`'s evaluator-context callback when
 * a `policy_exceptions[]` entry names an unknown evaluator, names an
 * evaluator that doesn't fire at `checkpoint-open`, or names an
 * evaluator whose spec does not set `resolution.policy_exception.enabled`
 * to true. Distinct error so the user-facing envelope reports
 * `path: 'policy_exceptions'` (not `declared_step_ids`).
 */
export class PolicyExceptionInvalidError extends CheckpointValidationError {
  readonly code = 'POLICY_EXCEPTION_INVALID' as const;
  readonly path = 'policy_exceptions' as const;
  constructor(
    artifactId: string,
    message: string,
    public readonly evaluator: string
  ) {
    super(message, artifactId);
  }
}

/**
 * Thrown by `ArtifactStore.revisePlan` when a `summary_captured` event
 * already exists for the artifact — revision is frozen post-summary
 * (the plan as-of finalization is the audit record reviewers read;
 * revising past it would invalidate the summary's coverage claim).
 *
 * Note: `pre_pr_checked` does NOT finalize. pre-pr is a repeatable
 * gate before summary, so revising after a passing pre-pr is allowed —
 * the pre-pr marker simply goes stale and the check re-runs.
 *
 * Symmetric to OpenCheckpointsPendingError on writeSummary: that
 * gate refuses finalization while open cps exist; this gate refuses
 * revision after finalization.
 */
export class ArtifactFinalizedError extends Error {
  readonly code = 'ARTIFACT_FINALIZED' as const;

  constructor(
    message: string,
    public readonly artifactId: string
  ) {
    super(message);
    this.name = 'ArtifactFinalizedError';
  }
}

/**
 * Thrown by `ArtifactStore.writeSummary` when a `summary_captured`
 * event already exists and the caller did NOT provide a `prior_summary_event_id`
 * supersede token. A bare re-capture is refused so a second agent (multi-agent
 * repos share one artifact thread) can't silently clobber the reviewer-facing
 * summary. The message names the existing summary event id so the caller can
 * retry with it as the token. Distinct from `ArtifactFinalizedError` (which
 * freezes plan REVISION) — the summary itself remains amendable, explicitly.
 */
export class SummaryAlreadyCapturedError extends Error {
  readonly code = 'SUMMARY_ALREADY_CAPTURED' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly summaryEventId: string
  ) {
    super(message);
    this.name = 'SummaryAlreadyCapturedError';
  }
}

/**
 * Thrown by `ArtifactStore.writeSummary` when a `prior_summary_event_id`
 * supersede token was provided but is not the latest summary event — another
 * amend landed since it was read. Optimistic-concurrency, mirroring
 * `StalePlanRevisionError`. Re-read resume/status and retry with the fresh token.
 */
export class StaleSummarySupersedeError extends Error {
  readonly code = 'STALE_SUMMARY' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly latestSummaryEventId: string
  ) {
    super(message);
    this.name = 'StaleSummarySupersedeError';
  }
}

/**
 * Thrown by `ArtifactStore.revisePlan` when the new plan would drop
 * a `step_id` that any **open** cp currently declares. Hard
 * conflict — the agent must abandon the cp first, or revise without
 * dropping that step_id.
 *
 * Distinct from `OpenCheckpointOverlapError`: same conflict source
 * (a live cp's declared scope) but different actor (plan-revise
 * instead of cp-open).
 */
export class PlanRevisionOpenCpConflictError extends Error {
  readonly code = 'PLAN_REVISION_OPEN_CP_CONFLICT' as const;
  readonly path = 'plan_steps' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly conflicts: ReadonlyArray<{
      stepId: string;
      cpN: number;
      agentSessionId: string | null;
    }>
  ) {
    super(message);
    this.name = 'PlanRevisionOpenCpConflictError';
  }
}

/**
 * Thrown by `ArtifactStore.revisePlan` when `prior_plan_event_id`
 * does not match the artifact's latest plan event — a newer
 * `plan_revised` (or the only `plan_captured`) has been committed
 * since the agent last observed the plan. Optimistic-concurrency
 * miss; the agent re-reads resume and retries with the fresh token.
 *
 * Also thrown by `writeCheckpointOpened` when the input carries a
 * non-null `plan_revision_id` that is no longer the latest plan
 * event for the artifact.
 */
export class StalePlanRevisionError extends Error {
  readonly code = 'STALE_PLAN_REVISION' as const;
  readonly path = 'prior_plan_event_id' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly observedEventId: string,
    public readonly latestEventId: string,
    public readonly latestRevisionN: number
  ) {
    super(message);
    this.name = 'StalePlanRevisionError';
  }
}

/**
 * Thrown by `ArtifactStore.revisePlan` when the new plan would drop
 * one or more `step_id`s that closed cps have already claimed via
 * `completed_step_ids`, AND the input's
 * `acknowledge_drops_completed_steps` does not cover each. Mirrors
 * the explicit policy-exception opt-in pattern — silent drop of a
 * historic completion is rejected so the audit trail reflects an
 * explicit choice.
 */
export class UnacknowledgedDroppedCompletionsError extends Error {
  readonly code = 'PLAN_REVISION_UNACKNOWLEDGED_DROPS' as const;
  readonly path = 'acknowledge_drops_completed_steps' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly unacknowledged: ReadonlyArray<{
      stepId: string;
      cpN: number;
    }>
  ) {
    super(message);
    this.name = 'UnacknowledgedDroppedCompletionsError';
  }
}

/**
 * Thrown by `ArtifactStore.revisePlan` when a revision removes an acceptance
 * criterion from an open or completed step without listing that criterion_id
 * in `acknowledge_criteria_changes`. Removal narrows the current rubric while
 * the opening-revision evidence remains historical, so an explicit audited
 * acknowledgement is sufficient. Additions and rewrites are rejected instead.
 */
export class UnacknowledgedCriteriaChangesError extends Error {
  readonly code = 'PLAN_REVISION_UNACKNOWLEDGED_CRITERIA_CHANGES' as const;
  readonly path = 'acknowledge_criteria_changes' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly unacknowledged: ReadonlyArray<{
      criterionId: string;
      stepId: string;
      kind: 'removed';
    }>
  ) {
    super(message);
    this.name = 'UnacknowledgedCriteriaChangesError';
  }
}

/**
 * Thrown by `ArtifactStore.revisePlan` when the input plan_steps
 * carry duplicate step_ids or reference step_ids that would yield
 * an inconsistent step_lineage block. Distinct from
 * `DeclaredStepsInvalidError` so the path attribution stays
 * specific to plan-revise input.
 */
export class PlanRevisionInputInvalidError extends Error {
  readonly code = 'PLAN_REVISION_INPUT_INVALID' as const;
  readonly path = 'plan_steps' as const;

  constructor(
    message: string,
    public readonly artifactId: string
  ) {
    super(message);
    this.name = 'PlanRevisionInputInvalidError';
  }
}

export class SchemaAheadError extends Error {
  /** Stable, public-facing error code. Always `'SCHEMA_AHEAD'`. */
  readonly code = 'SCHEMA_AHEAD' as const;

  constructor(
    public readonly cacheVersion: number,
    public readonly cliVersion: number
  ) {
    super(
      `SQLite cache schema version ${cacheVersion} is newer than supported (${cliVersion}). ` +
        'Upgrade orcaops; do not delete the cache (rebuilding at an older schema would ' +
        'silently drop forward-only fields from newer events).'
    );
    this.name = 'SchemaAheadError';
  }
}

/**
 * Thrown by recovery-aware reads (`readCheckpointsRecovered`, the
 * projection readers that delegate to `persistAndReturn`) when the
 * artifact-level integrity contract refuses: any non-tail event-log
 * corruption, a projection source absent from the intact log, or a
 * recovered set whose step claims conflict.
 *
 * Containment call sites catch EXACTLY this class (skip-with-warning
 * where omission only weakens claims) and rethrow everything else, so
 * an unrelated failure — a containment/symlink refusal, a programming
 * error — is never downgraded to a skipped row.
 */
export class RecoveryRefusedError extends Error {
  readonly code = 'RECOVERY_REFUSED' as const;

  constructor(
    message: string,
    public readonly artifactId: string
  ) {
    super(message);
    this.name = 'RecoveryRefusedError';
  }
}

/**
 * A protected artifact deletion could not be reconciled automatically.
 * `semanticCommitted` distinguishes cleanup residue after a completed delete
 * from an uncommitted operation whose staged bytes must remain protected.
 */
export class ArtifactDeletionRecoveryError extends Error {
  readonly code = 'ARTIFACT_DELETION_RECOVERY_REQUIRED' as const;

  constructor(
    message: string,
    public readonly artifactId: string | null,
    public readonly stagingPaths: readonly string[],
    public readonly semanticCommitted: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ArtifactDeletionRecoveryError';
  }
}

/**
 * Recovery instructions are shared with doctor so the refusal and the
 * diagnostic cannot recommend divergent operations. Rebuild first: a
 * durable plan event repairs to the original artifact identity. A fresh
 * key is safe only after the operator establishes that no plan event was
 * published and no capture still owns the reservation.
 */
export const PLAN_IDEMPOTENCY_PENDING_REMEDY =
  'Run `orcaops rebuild`, then retry `orcaops capture plan` with the same idempotency key. ' +
  'If it remains pending, run `orcaops doctor`; use a fresh key only after confirming that ' +
  'no plan was published and no capture is still running.';

/**
 * Thrown when a plan-idempotency key is reserved but the cache has no
 * published plan for its artifact. The winner may still be in flight,
 * may have failed before the durable append, or may have appended the
 * event and failed while projecting it. Replaying as success before
 * that distinction is resolved would either report a planless artifact
 * or hide the recovery required to make the committed artifact usable.
 */
export class PlanIdempotencyPendingError extends Error {
  readonly code = 'IDEMPOTENCY_PENDING' as const;

  constructor(
    public readonly idempotencyKey: string,
    public readonly artifactId: string
  ) {
    super(
      `idempotency key "${idempotencyKey}" is reserved by a capture that has not published ` +
        `a plan in the cache (artifact ${artifactId}: in flight, failed before publishing, ` +
        `or awaiting projection recovery). ${PLAN_IDEMPOTENCY_PENDING_REMEDY}`
    );
    this.name = 'PlanIdempotencyPendingError';
  }
}

/**
 * Thrown by the append preflight when the event log cannot safely take
 * another event: a lossy (non-tail) corrupt line, an unterminated
 * crash-residue tail, or a log the preflight could not read at all
 * (errno-class failure — appending blind is never safe). Typed so a
 * caller that touches a PRIOR artifact as a side effect (capture-plan
 * pin displacement) can contain exactly this refusal without silencing
 * path-guard or programming errors — and so mid-append write failures,
 * which stay untyped, are never contained with it.
 */
export class EventLogAppendRefusedError extends Error {
  readonly code = 'APPEND_REFUSED' as const;

  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly shape: 'lossy' | 'truncated_tail' | 'unreadable'
  ) {
    super(message);
    this.name = 'EventLogAppendRefusedError';
  }
}
