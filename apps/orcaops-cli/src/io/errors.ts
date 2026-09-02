import type { GateAuditPayload } from '@orcaops/evaluator-protocol';

/**
 * One in-flight artifact offered as a disambiguation choice when a capture
 * command can't resolve `artifact_id` (more than one active on the branch
 * and none passed). Rides the `AMBIGUOUS_ARTIFACT` error envelope so the
 * agent picks an `id` without parsing prose. `label` is the friendly plan
 * headline (falls back to `task` when unlabelled); `created_by_session_id`
 * is the disambiguator under subagent parallelism (which session opened it).
 */
export interface ArtifactCandidate {
  id: string;
  label: string;
  task: string;
  state: string;
  checkpoint_count: number;
  last_activity_at: string;
  created_by_session_id: string | null;
}

/**
 * One open checkpoint offered as a disambiguation choice when `checkpoint
 * close` is called with `n` omitted and more than one checkpoint is open.
 * Rides the `AMBIGUOUS_CHECKPOINT` error envelope so the agent picks an `n`.
 */
export interface OpenCheckpointCandidate {
  n: number;
  declared_step_ids: string[];
  agent_session_id: string | null;
  opened_at: string;
}

export interface GcApplyProgress {
  state: 'refused' | 'partial_completion' | 'recoverable_in_progress';
  completed: {
    stale_pins: number;
    abandoned_summarized: number;
    snapshot_refs: number;
    baseline_refs: number;
    stale_review_dirs: number;
    review_refs: number;
  };
  failed_candidate: {
    kind: 'stale_pin' | 'abandoned_summarized' | 'stale_review_dir';
    id: string;
  };
}

/**
 * The blocked-`checkpoint open` envelope: a pre-append open rejection (e.g.
 * `checkpoint-scope-density`). Shared by the producer
 * (`commands/capture/checkpoint.ts`) and the consumer (`lib/next-actions.ts`
 * `openRejectionAction`) so a field rename is a compile error, not a silently
 * degraded hint. The block is pre-append, so it never lands as a persisted
 * run the lifecycle snapshot can see — the remediation hint is built off this
 * envelope instead. The producer carries extra fields (`evaluator_results`,
 * `blocking`, `message`) and asserts conformance via `satisfies`.
 */
export interface OpenRejectionEnvelope {
  ok: false;
  status: 'blocked';
  artifact_id: string;
  /** The rejected scope — fed (reduced) into the remediation template. */
  declared_step_ids: string[];
  /** Block-severity evaluator refs that rejected the open. */
  blocked_evaluator_refs: string[];
  /** Inline pre-append evaluator runs — carried for the agent, not read by the hint. */
  evaluator_results: readonly unknown[];
  /** Present iff this is a gate rejection — the consumer's discriminant. */
  gate_audit: GateAuditPayload;
  blocking: true;
  message: string;
}

/**
 * One secret-shaped field, as reported to the agent that authored it.
 *
 * Deliberately narrower than storage's `SecretFinding`: `key_prefix` is the
 * matched field's leading token (`token:`, `api_key=`) so the agent can find
 * the offending line in a long summary, but the value itself never appears.
 * Without some locator an agent rewords blindly and re-fails; with the value,
 * the envelope would restate the secret it just refused to store.
 */
export interface SecretFindingReport {
  /** JSON path of the offending field, e.g. `plan_steps[0].text`. */
  path: string;
  /** Pattern names that matched, e.g. `['github-token']`. */
  patterns: string[];
  key_prefix?: string;
}

/**
 * Structured error envelope returned by all capture commands.
 * The agent can pattern-match on `code` and report `message`.
 */
export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    /** Dotted path into the input where the error occurred, when applicable. */
    path?: string;
    /**
     * Short verb hinting next-step for agent consumers (only set on auth-shaped
     * errors that the SDK's mapCloudAuthError mapped). Stable values:
     * `login`, `contact_admin`, `wait`, `none`. Agents key on this to pick a
     * remediation prompt without parsing English.
     */
    actionable?: string;
    /**
     * Candidate artifacts for `AMBIGUOUS_ARTIFACT` — the agent re-issues the
     * call naming one `id`.
     */
    candidates?: ArtifactCandidate[];
    /**
     * Open checkpoints for `AMBIGUOUS_CHECKPOINT` — the agent re-issues
     * `checkpoint close` naming one `n`.
     */
    open_checkpoints?: OpenCheckpointCandidate[];
    /**
     * The candidate version the cloud advanced to, carried on a
     * `REVIEW_PUSH_CONFLICT` so an agent can auto-re-pull without parsing the
     * message. Set only on that code.
     */
    current_version_number?: number;
    /** Truthful per-candidate progress when destructive GC stops early. */
    gc_progress?: GcApplyProgress;
    /**
     * Every secret-shaped field found in the payload, carried on
     * `SECRET_IN_PAYLOAD`. All of them, not just the first: the remedy is an
     * agent rewriting narrative, so one field per round trip is expensive.
     *
     * Never the matched value — see {@link SecretFindingReport}.
     */
    secret_findings?: SecretFindingReport[];
  };
}

/**
 * Structured extras an `OrcaopsError` can carry to be merged into the error
 * envelope's `error` object (e.g. the ambiguity candidate lists). Typed as a
 * subset of `ErrorEnvelope['error']` so the merge in `toErrorEnvelope` stays
 * type-safe.
 */
export type ErrorEnvelopeExtras = Pick<
  ErrorEnvelope['error'],
  'candidates' | 'open_checkpoints' | 'current_version_number' | 'gc_progress' | 'secret_findings'
>;

/**
 * Thrown by capture commands to signal a structured failure that should be
 * rendered as a JSON error envelope (no stack trace, exit code 1).
 */
export class OrcaopsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly inputPath?: string,
    /**
     * Structured payload merged into the error envelope's `error` object by
     * `toErrorEnvelope` — e.g. `{ candidates }` for `AMBIGUOUS_ARTIFACT` or
     * `{ open_checkpoints }` for `AMBIGUOUS_CHECKPOINT`.
     */
    public readonly details?: ErrorEnvelopeExtras
  ) {
    super(message);
    this.name = 'OrcaopsError';
  }
}

export const ErrorCodes = {
  INVALID_INPUT: 'INVALID_INPUT',
  NO_INPUT: 'NO_INPUT',
  /**
   * A well-formed payload carrying a recognizable credential. Distinct from
   * `INVALID_INPUT` on purpose: the shape is fine, and the remedy is to
   * describe the credential rather than quote it. Telling an agent to "fix the
   * JSON shape" here would send it to retry the identical payload.
   *
   * Nothing was written, pushed, or snapshotted — the check runs before any
   * durable state exists. Read `secret_findings` for every offending field.
   */
  SECRET_IN_PAYLOAD: 'SECRET_IN_PAYLOAD',
  NOT_A_REPO: 'NOT_A_REPO',
  ALREADY_INITIALIZED: 'ALREADY_INITIALIZED',
  /**
   * `orcaops init` was run from a subdirectory of the git worktree (cwd is
   * not the worktree root). Refused so we never drop an undiscoverable
   * `.orcaops` in a subdir. Remediation: re-run from the worktree root, or
   * pass `--root <root>` / `--here`. Machine-detectable so an agent can retry.
   */
  INIT_NOT_AT_ROOT: 'INIT_NOT_AT_ROOT',
  UNKNOWN_ARTIFACT: 'UNKNOWN_ARTIFACT',
  /**
   * A checkpoint's snapshot boundary cannot serve a `snapshots
   * checkout` / `snapshots diff` request. Three shapes,
   * each with a distinct message: the boundary is all-null (capture was
   * deliberately skipped or failed — message carries the recorded
   * `snapshot_error_reason`); the pinned commit/tree is unreachable
   * (refs pruned by `snapshots prune` / `gc`, or by the cloud-sync
   * auto-prune once a synced cp's manifest landed — time-travel is
   * strongest on unsynced/local work); or the requested phase does not
   * exist for the cp's status (e.g. `--phase close` on an abandoned
   * cp). Machine-detectable so timetravel-style callers can degrade
   * instead of parsing messages. Malformed flags stay `INVALID_INPUT`;
   * a missing artifact stays `UNKNOWN_ARTIFACT` (derive precedent).
   */
  SNAPSHOT_UNAVAILABLE: 'SNAPSHOT_UNAVAILABLE',
  UNINITIALIZED: 'UNINITIALIZED',
  EVALUATOR_NOT_FOUND: 'EVALUATOR_NOT_FOUND',
  /**
   * A pack failed to load, so the evaluator set is incomplete and the ref
   * being looked for may well exist. Distinct from EVALUATOR_NOT_FOUND,
   * which asserts the ref is absent from a set that loaded cleanly — a
   * claim discovery cannot honestly make once anything failed.
   */
  EVALUATOR_DISCOVERY_FAILED: 'EVALUATOR_DISCOVERY_FAILED',
  BLOCK_NOT_ACKNOWLEDGEABLE: 'BLOCK_NOT_ACKNOWLEDGEABLE',
  NOT_CONNECTED: 'NOT_CONNECTED',
  CLOUD_ERROR: 'CLOUD_ERROR',
  /**
   * `orcaops push` targeted a `git-import` artifact. Imported history is
   * local-only in v1 (storage-class containment); the refusal happens in core
   * before any cloud client is constructed. Distinct from `CLOUD_ERROR` so
   * agents can tell a containment refusal from a transport failure.
   */
  IMPORTED_ARTIFACT_LOCAL_ONLY: 'IMPORTED_ARTIFACT_LOCAL_ONLY',
  MISSING_GIT_REMOTE: 'MISSING_GIT_REMOTE',
  /**
   * Destructive GC could not prove Git branch enumeration or reachability.
   * The candidate report remains available as a dry-run, but `--apply`
   * refuses before deleting refs, files, pins, or database rows.
   */
  GC_GIT_UNCERTAIN: 'GC_GIT_UNCERTAIN',
  /** Durable hot/archive state could not support a safe stale-pin classification. */
  GC_STORAGE_UNCERTAIN: 'GC_STORAGE_UNCERTAIN',
  /** Destructive GC requires a complete, current SQLite projection. */
  GC_PROJECTION_UNHEALTHY: 'GC_PROJECTION_UNHEALTHY',
  /** Protected local state needs operator-visible reconciliation before commands continue. */
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  /** GC's exact destructive candidate/ref set changed during validation. */
  GC_CANDIDATES_CHANGED: 'GC_CANDIDATES_CHANGED',
  /** A per-candidate GC mutation stopped; inspect `gc_progress` before retrying. */
  GC_APPLY_FAILED: 'GC_APPLY_FAILED',
  /**
   * Programming bug: caller used the same `idempotency_key` as a prior
   * mutating capture but with a structurally-different payload. The
   * caller must use a fresh key (the prior decision still stands).
   */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /**
   * A plan-idempotency key is reserved but its artifact has no cached
   * plan (winner in flight, pre-publication failure, or a published
   * event awaiting projection recovery). Rebuild and retry the same key
   * before considering a fresh one. Remapped from storage's
   * PlanIdempotencyPendingError.
   */
  IDEMPOTENCY_PENDING: 'IDEMPOTENCY_PENDING',
  /**
   * Two-phase checkpoint open: `declared_step_ids` overlap with
   * another open cp's declared scope or a closed cp's
   * `completed_step_ids`. Distinct code so parent agents handle
   * it programmatically (retry with smaller scope, or revise the
   * plan to split the step).
   */
  OPEN_CP_OVERLAP: 'OPEN_CP_OVERLAP',
  /** Seed apply rejected because another artifact still has an open checkpoint. */
  SEED_OPEN_CHECKPOINT: 'SEED_OPEN_CHECKPOINT',
  /**
   * A seed command found the project-wide run lock held by a live owner.
   * Distinct from `INVALID_INPUT` so agents can wait-and-retry instead of
   * treating the conflict as a malformed invocation; the message names the
   * lock path, the owner pid when known, and the remedy.
   */
  SEED_RUN_ACTIVE: 'SEED_RUN_ACTIVE',
  /**
   * Plan revision rejected because dropping a step_id that an open
   * checkpoint currently declares would orphan the cp's scope.
   * Distinct from `OPEN_CP_OVERLAP` (cp-open rejected by another cp)
   * — same conflict source (live cp's declared scope), different
   * actor (plan-revise rejected by a live cp).
   */
  PLAN_REVISION_OPEN_CP_CONFLICT: 'PLAN_REVISION_OPEN_CP_CONFLICT',
  /**
   * `prior_plan_event_id` (on plan-revise) or `plan_revision_id`
   * (on cp-open) does not match the artifact's latest plan event.
   * Optimistic-concurrency miss: a newer plan event has been
   * committed since the agent's last observation. Remediation:
   * re-read resume / status to pick up the fresh event_id, retry.
   */
  STALE_PLAN_REVISION: 'STALE_PLAN_REVISION',
  /**
   * Plan revision rejected because finalization (summary capture) has
   * already fired. Plan is frozen post-finalization to preserve the audit
   * record reviewers will read. (pre-pr-check does NOT finalize — it's a
   * repeatable gate before summary.) Remediation: undo the finalization
   * (not currently supported) or start a fresh artifact.
   */
  ARTIFACT_FINALIZED: 'ARTIFACT_FINALIZED',
  SUMMARY_ALREADY_CAPTURED: 'SUMMARY_ALREADY_CAPTURED',
  STALE_SUMMARY: 'STALE_SUMMARY',
  /**
   * Plan revision rejected because the new plan would drop a
   * step_id that a closed cp claimed in `completed_step_ids` AND
   * the input did not include that step_id in
   * `acknowledge_drops_completed_steps`. Mirrors the
   * `acknowledge_policy_exception` pattern.
   */
  PLAN_REVISION_UNACKNOWLEDGED_DROPS: 'PLAN_REVISION_UNACKNOWLEDGED_DROPS',
  /**
   * Plan revision rejected because it removes or rewrites an acceptance
   * criterion on a step with an OPEN checkpoint without listing the
   * criterion_id in `acknowledge_criteria_changes`.
   * Changing the rubric under active work is the silent-narrowing vector
   * the plan-time anchor exists to close; same explicit-acknowledgement
   * shape as `PLAN_REVISION_UNACKNOWLEDGED_DROPS`.
   */
  PLAN_REVISION_UNACKNOWLEDGED_CRITERIA_CHANGES: 'PLAN_REVISION_UNACKNOWLEDGED_CRITERIA_CHANGES',
  /**
   * Plan revision rejected because the input plan_steps carry
   * duplicate step_ids, reference a step_id absent from the prior
   * plan, or otherwise yield an inconsistent step_lineage block.
   */
  PLAN_REVISION_INPUT_INVALID: 'PLAN_REVISION_INPUT_INVALID',
  /** `.orcaops/config.json` violates a current validation rule. */
  INVALID_CONFIG: 'INVALID_CONFIG',
  /**
   * Capture rejected because the artifact's state is `blocked`. A
   * block-severity evaluator violated and has not yet been resolved
   * via `orcaops block acknowledge` / `orcaops block dismiss` (or by
   * a re-run that passes). Surfaced from `capture summary` (which is
   * the gate); remediation checkpoints stay allowed.
   */
  BLOCKED: 'BLOCKED',
  /**
   * Caller's shell does not expose any of the env vars the pin model
   * recognizes (`$CLAUDE_SESSION_ID`, `$CODEX_SESSION_ID`,
   * `$TMUX_PANE`, `$STY`+`$WINDOW`, `$TTY`), so no pin can be written
   * or cleared. Surfaced from `orcaops checkout` and from
   * `orcaops resume`'s implicit auto-pin path. Headless / CI callers
   * that hit this should pass `--no-pin` (where supported) to
   * proceed without leaving a pin.
   */
  NO_SHELL_KEY: 'NO_SHELL_KEY',
  /**
   * `orcaops eval add-pack <source>` couldn't resolve the source —
   * missing package dependency, missing path, or unrecognized source
   * shape. Carries the hint string ("install with `pnpm add -D <pkg>`",
   * etc.) in the message.
   */
  PACK_RESOLUTION: 'PACK_RESOLUTION',
  /**
   * `orcaops eval add-pack <source>` resolved the source but the
   * pack failed validation — invalid manifest, broken specs, missing
   * runtime files, etc. The structured errors[] in validatePack's
   * result are surfaced in the message.
   */
  PACK_VALIDATION: 'PACK_VALIDATION',
  /**
   * `orcaops eval add-pack <source>` rejected because the pack is
   * already registered in .orcaops/evaluators.yaml under the same
   * id. Re-run with --force to overwrite, or use update-pack to
   * refresh.
   */
  PACK_ALREADY_INSTALLED: 'PACK_ALREADY_INSTALLED',
  /**
   * Couldn't acquire the per-artifact lock within the budget (default
   * 10s). Another process is holding the lock and hasn't released
   * yet. Remediation: retry; if it persists, run `orcaops doctor`
   * to surface stale lockdirs. Remapped at the CLI boundary from
   * storage's `ArtifactLockTimeoutError`.
   */
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  /**
   * Multiple in-flight artifacts on the current branch and no pin
   * to disambiguate. NOT thrown via OrcaopsError — the picker
   * payload is `ok: true, resolved: false` per the resume wire
   * shape. Documented here so skill bodies and external
   * tooling can reference the same registry of codes.
   */
  AMBIGUOUS_RESUME: 'AMBIGUOUS_RESUME',
  /**
   * A capture command (checkpoint open/close/abandon, summary,
   * pre-pr-check) was invoked with no `artifact_id` and more than one
   * active artifact exists on the branch. Thrown via OrcaopsError with a
   * structured `candidates[]` (`ArtifactCandidate`) on the envelope so the
   * agent re-issues naming one `id`. Unlike `AMBIGUOUS_RESUME` (a read that
   * returns `ok: true, resolved: false`), capture is a write that cannot
   * proceed, so this is `ok: false`.
   */
  AMBIGUOUS_ARTIFACT: 'AMBIGUOUS_ARTIFACT',
  /**
   * `capture checkpoint close` was invoked with `n` omitted and more than
   * one checkpoint is open (concurrent subagent work). Thrown via
   * OrcaopsError with a structured `open_checkpoints[]`
   * (`OpenCheckpointCandidate`) so the agent re-issues `close` naming one
   * `n`. Zero open checkpoints is `INVALID_INPUT`, not this.
   */
  AMBIGUOUS_CHECKPOINT: 'AMBIGUOUS_CHECKPOINT',
  /**
   * Pin overwritten while the prior artifact was still active or
   * blocked. Informational, not a CLI error — emitted as an event
   * (`pin_displaced` in the artifact's events.ndjson) and surfaced
   * by doctor. Documented here so consumers can identify the event
   * by a stable code.
   */
  PIN_DISPLACED: 'PIN_DISPLACED',
  /**
   * A current-shell pin names an archive-resident artifact, but archive
   * corruption, I/O failure, divergence, or a restore failure prevents a
   * trustworthy resolution. Resume keeps the pin and refuses instead of
   * silently selecting another in-flight artifact.
   */
  PIN_RESOLUTION_FAILED: 'PIN_RESOLUTION_FAILED',
  /**
   * Per-line checksum mismatch / sidecar SHA / size mismatch / JSON
   * parse failure / schema-validation failure on `events.ndjson`.
   * Currently surfaced through doctor's read-side scan,
   * not thrown by capture commands; registered here so future
   * paths that DO escalate corruption have a stable code.
   */
  EVENT_LOG_CORRUPT: 'EVENT_LOG_CORRUPT',
  /**
   * Explicit archive activation enabled mirroring but could not fully
   * reconcile existing history because repairable lag or a content conflict
   * remains. The archive stays enabled; inspect `archive status`, then use
   * `archive repair` or the explicit `archive resolve` source choice.
   */
  ARCHIVE_INCOMPLETE: 'ARCHIVE_INCOMPLETE',
  /**
   * On-disk SQLite cache schema version is newer than this CLI
   * supports. Schema evolution is forward-only. Remediation
   * is to upgrade the CLI; deleting the cache to "fix" it would
   * silently drop forward-only fields from newer events.
   * Remapped at the CLI boundary from storage's `SchemaAheadError`.
   */
  SCHEMA_AHEAD: 'SCHEMA_AHEAD',
  /**
   * `block acknowledge` / `block dismiss` invoked with --evaluator
   * <ref> but no unresolved blocking run exists on the artifact for
   * that ref (or --run-id was specified and that run isn't blocking
   * -eligible / is already resolved). The agent must either pick a
   * different ref / run_id or accept that nothing needs resolving.
   */
  NO_BLOCKING_RUN: 'NO_BLOCKING_RUN',
  /**
   * `plan review push` failed closed: the candidate advanced since the pull, so
   * the CAS token (`expected_candidate_version_id`) no longer matches the cloud.
   * A distinct code because agents branch on it — re-pull, re-apply, push again.
   * The envelope carries `current_version_number` (the version the candidate
   * moved to). The cloud ALWAYS fails closed; `--on-conflict=propose` is a
   * CLI-side recovery that re-files the same body as a proposal instead of
   * raising this.
   */
  REVIEW_PUSH_CONFLICT: 'REVIEW_PUSH_CONFLICT',
  /**
   * `plan review approve --wait` gave up before the plan was approved. A
   * distinct code (and exit 2) because "not approved yet" is an expected
   * outcome scripts branch on — a decline or an away human is
   * indistinguishable from not-yet on the v1 wire, and neither is a cloud
   * failure.
   */
  REVIEW_APPROVE_TIMEOUT: 'REVIEW_APPROVE_TIMEOUT',
  /**
   * `review watch` gave up before any new HUMAN activity appeared on the
   * subject. Distinct code (and exit 2) for the same reason as
   * `REVIEW_APPROVE_TIMEOUT`: "nothing new yet" is an expected outcome
   * scripts and the review-feedback skill branch on, not a cloud failure.
   */
  REVIEW_WATCH_TIMEOUT: 'REVIEW_WATCH_TIMEOUT',
  INTERNAL: 'INTERNAL',
} as const;

/**
 * Informational status carried in successful capture responses when the
 * input replayed a prior mutation (same `idempotency_key`, same payload).
 * NOT thrown via OrcaopsError — replays are `ok: true` outcomes.
 */
export const InfoCodes = {
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY',
} as const;
