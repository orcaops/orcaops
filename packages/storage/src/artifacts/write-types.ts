import type { GateAuditPayload } from '@orcaops/evaluator-protocol';

import type { PartitionSegment } from '../events/claims-partition.js';
import type {
  AbandonedCheckpoint,
  CheckpointDecision,
  ClosedCheckpoint,
  DoneCriterion,
  OpenCheckpoint,
  PolicyException,
  VerificationEntry,
} from '../schema/checkpoint.js';
import type { CaptureAgentId } from '../schema/config.js';
import type {
  CheckpointSnapshotBoundary,
  DiffFingerprintManifest,
  DiffFingerprintSummary,
} from '../schema/diff-fingerprint.js';
import type { EvaluatorLog } from '../schema/evaluator-run.js';
import type { GitImportEnrichmentPayload } from '../schema/git-import-enrichment.js';
import type { Plan } from '../schema/plan.js';
import type { SourcePlanPin } from '../schema/source-plan.js';
import type { Summary } from '../schema/summary.js';

/**
 * Options for the "auto-mint" event writers: the idempotency key is
 * OPTIONAL and auto-minted (UUIDv7) when omitted. Each such writer
 * resolves `opts.idempotencyKey ?? uuidv7()` at the write boundary, so a
 * missing key never reaches event encoding, whose strict schema rejects
 * an empty key. Supply a key only for replay-safe
 * retries (reusing one dedups the call as a replay).
 */
export interface AutoMintWriteOptions {
  idempotencyKey?: string;
}

export interface PlanWriteOptions extends AutoMintWriteOptions {
  /**
   * Optional pinned source plan. Honored only by the
   * initial `writePlan` — it is spliced onto the `plan_captured` event
   * payload and projected set-once onto artifact.json by
   * `rebuildArtifactJsonFromEvents`. `revisePlan` ignores it (the pin is
   * capture-only and immutable). `PlanSchema` is intentionally not
   * `.strict()`, so the extra key is dropped from the rebuilt *plan*
   * projection while the artifact-json rebuilder reads it off the same
   * raw payload — keep PlanSchema non-strict for this to hold.
   */
  sourcePlan?: SourcePlanPin;
  /**
   * Plan-time baseline seed tree. Spliced onto the `plan_captured` payload
   * and projected set-once onto artifact.json as `baseline_seed_tree_sha` by
   * `rebuildArtifactJsonFromEvents` — mirrors `sourcePlan`. Null/undefined ⇒
   * no seed; the field stays null until the capture path snapshots the
   * worktree at capture.
   */
  baselineSeedTreeSha?: string | null;
  /**
   * Paths unmerged in the real index when the plan-time baseline was
   * captured. PAYLOAD-ONLY (`baseline_unmerged_paths`, stamped when
   * non-empty): a baseline snapshotted mid-conflict carries marker bytes,
   * so seed recovery from it would attribute marker→resolution hunks to
   * cp 1 with no close-time filter applicable — the close path reads this
   * raw off `plan_captured` and BLOCKS the seed-recovery branch instead.
   * Never projected; irrelevant when the seed was superseded (the caller
   * clears it — the set describes the plan-time tree, not an adopted one).
   */
  baselineUnmergedPaths?: readonly string[];
  /**
   * Auditability of the `--source-plan` supersession override:
   * the artifact whose pre-work tree overrode `baselineSeedTreeSha`.
   * Spliced onto the `plan_captured` payload and projected set-once onto
   * artifact.json as `superseded_artifact_id` — mirrors `sourcePlan` /
   * `baselineSeedTreeSha`. Null/undefined ⇒ no supersession.
   */
  supersededArtifactId?: string | null;
}

/** Replay-dedup hooks shared by the capture-style writers. */
interface ReplayWriteOptions {
  replayPayload?: unknown;
  extractReplayShape?: (priorPayload: unknown) => unknown;
}

/**
 * Options for writers with caller-controlled dedup (`revisePlan` + the
 * checkpoint writers). Unlike the auto-mint writers, the idempotency key
 * is REQUIRED here — these calls carry replay semantics, so the key is
 * never auto-minted. A falsy key is caught by the event schema rather
 * than swapped for a random one (which would mask a caller
 * bug by silently dropping dedup).
 */
export interface CaptureWriteOptions extends ReplayWriteOptions {
  idempotencyKey: string;
  /**
   * The runtime-resolved invoking agent (flag > env > ambient > 'other'),
   * stamped onto the event payload as provenance. Lives on the write
   * OPTIONS, not the input: inputs are agent-authored content while
   * provenance is runtime-derived and must not be payload-spoofable.
   * Optional — storage-direct callers (tests) omit it and the event
   * simply carries no attribution (readers inherit `plan.agent`).
   * NEVER included in replay-equality shapes: a retry of the same
   * logical call from a different agent/shell must replay, not
   * IDEMPOTENCY_CONFLICT.
   */
  invokedByAgent?: CaptureAgentId;
}

/**
 * Options for `writeSummary`: an auto-minted key (like the other
 * auto-mint writers) plus the replay-dedup hooks.
 */
export interface SummaryWriteOptions extends AutoMintWriteOptions, ReplayWriteOptions {
  /**
   * Supersede token — the latest `summary_captured` event id. Required
   * to REPLACE an existing summary; a bare re-capture is refused
   * (SUMMARY_ALREADY_CAPTURED). Consumed as an optimistic-concurrency check;
   * never written into the event payload, so the artifact hash is unaffected.
   */
  priorSummaryEventId?: string;
}

export type WriteOutcome = 'created' | 'replay' | 'conflict';

export interface CheckpointOpenInput {
  artifact_id: string;
  /**
   * UUIDv7 step_ids the new cp will cover. Must be non-empty and
   * must reference step_ids present in the latest plan revision.
   */
  declared_step_ids: string[];
  agent_session_id?: string;
  policy_exceptions?: PolicyException[];
  /**
   * Optimistic-concurrency token: latest plan event_id the agent
   * observed. Null = skip the freshness check (race tolerance);
   * otherwise rejected with `STALE_PLAN_REVISION` when stale.
   */
  plan_revision_id?: string | null;
}

/**
 * Pre-append callback invoked during artifact preparation, after
 * idempotency lookup and semantic validation, before the event is
 * appended. Returns either:
 *   - `{ ok: true }` (no audit) — append a plain checkpoint_opened, or
 *   - `{ ok: true, gate_audit }` — append a checkpoint_opened with the
 *     gate's runs[] + dispositions[] embedded on the event payload so
 *     the projection rebuilder can unfold them, or
 *   - `{ ok: false, envelope }` to record a `soft_blocked` idempotency
 *     entry (using the fingerprint from the EvaluatorContext) and
 *     return the blocked outcome.
 *
 * The CLI uses this to run `checkpoint-open` evaluators in dry-run
 * mode against the proposed projection. Storage stays oblivious to
 * evaluator details; it only knows "block or proceed", plus the audit
 * envelope to embed when allowed.
 */
export type CheckpointOpenPreAppendResult =
  | { ok: true; gate_audit?: GateAuditPayload }
  | { ok: false; envelope: unknown };

export type ProposedOpenCheckpoint = Omit<OpenCheckpoint, 'source_event_id'>;

export type CheckpointOpenPreAppend = (
  proposed: ProposedOpenCheckpoint
) => Promise<CheckpointOpenPreAppendResult>;

/**
 * Bundle of evaluator-derived data the storage layer needs once it
 * has determined the call isn't a committed replay. The CLI builds
 * this lazily — `loadEvaluators` runs only when this resolves —
 * so committed replays succeed even when the evaluator registry has
 * drifted, been deleted, or gone misconfigured since the original
 * call.
 */
export interface OpenEvaluatorContext {
  /**
   * Combined sha256 of every `fires_at: checkpoint-open` evaluator
   * (id + content + args). Used as the soft_blocked replay key.
   */
  fingerprint: string;
  /**
   * Validate that every entry in `policy_exceptions[]` names a real
   * `fires_at: checkpoint-open` evaluator that opts into the inline
   * exception flow via `resolution.policy_exception.enabled`. Throws a
   * `CheckpointValidationError` (mapped to INVALID_INPUT at the CLI
   * boundary) on bad input. Storage calls this AFTER the
   * idempotency lookup so a bad opt-in is recorded as
   * `hard_rejected`.
   */
  validatePolicyExceptions: () => void;
  /**
   * Run `checkpoint-open` evaluators in dry-run mode against the
   * proposed projection. Returns `{ ok: true }` to proceed or
   * `{ ok: false, envelope }` to block (storage records soft_blocked
   * with the fingerprint and returns the envelope to the caller).
   */
  preAppend: CheckpointOpenPreAppend;
}

/**
 * Snapshot/fingerprint capture callbacks fired AFTER all gates and
 * BEFORE event encoding. Each callback returns the boundary (and, for
 * close, the fingerprint summary + optional manifest) that storage
 * embeds in the event payload. When absent, storage substitutes the
 * deliberate-skip default (`buildDefaultSkipped*` helpers from
 * `../schema/diff-fingerprint.js`) — `snapshot_error_reason: null` +
 * `diff_fingerprint_summary.status: 'skipped'`.
 *
 * The CLI supplies these callbacks by wrapping the
 * `captureCheckpointSnapshot` helper. They are optional storage hooks:
 * a caller that omits them still produces v4 events with
 * deliberate-skip boundaries.
 *
 * Fail-open invariant: a callback that THROWS is converted by storage
 * to a boundary with `snapshot_error_reason: 'unknown'` (and, for
 * close, a summary with `error_reason: 'unknown'`). This preserves the
 * diagnostic distinction between "didn't attempt" (absent callback,
 * null error) and "tried and unexpectedly failed" (threw, 'unknown')
 * for doctor's `skipped-fingerprint-rate` check.
 */
export interface CheckpointSnapshotCallbacks {
  captureOpenSnapshot?: (proposed: { artifact_id: string; n: number }) => Promise<{
    boundary: CheckpointSnapshotBoundary;
    /**
     * Paths unmerged in the real index at open time. Stamped payload-only
     * as `open_unmerged_paths` on the checkpoint_opened event (when
     * non-empty) so close can compute the open∪close degraded union —
     * never folded into the projection.
     */
    unmerged_paths?: readonly string[];
    /**
     * The unmerged-index probe itself failed at open. Stamped payload-only
     * as `open_unmerged_probe_failed` (when true) so close can mark the
     * whole window unverified via `attribution_degraded.probe_failed`.
     */
    unmerged_probe_failed?: boolean;
  }>;
}

export interface CheckpointCloseCallbacks {
  captureCloseFingerprint?: (ctx: {
    openCheckpoint: OpenCheckpoint;
    closeContext: { artifact_id: string; n: number };
    /**
     * Empty-fence recovery context resolved from the retained event snapshot. When the open→close fence
     * is empty but files were claimed, the callback may re-diff from
     * `hwmBaselineTreeSha ?? seedBaselineTreeSha` (whichever is non-null),
     * scoped to `filesChanged`. `recoveryBlocked` (interval overlap, or a null
     * HWM terminal tree) forbids recovery entirely — including the seed path.
     */
    recovery: {
      hwmBaselineTreeSha: string | null;
      seedBaselineTreeSha: string | null;
      recoveryBlocked: boolean;
      filesChanged: readonly string[];
    };
    /**
     * Present ONLY when this close's interval overlapped a
     * sibling checkpoint's in the same artifact's event log. The store
     * computes this from retained events (interval scan + boundary refs +
     * known claims) and passes it in; the callback — which owns ALL git
     * work — appends its fresh close boundary ({eventIdx:
     * currentCloseIdx, phase 'close', its new tree}) to `boundaries`
     * and computes per-segment file-sets via core's
     * `computeWindowSegments`, returning them as `segment_evidence`.
     * Storage never invokes Git; callbacks prepare evidence before publication.
     */
    overlap?: {
      currentCloseIdx: number;
      boundaries: ReadonlyArray<{
        eventIdx: number;
        n: number;
        phase: 'open' | 'close' | 'abandon';
        treeSha: string | null;
      }>;
    };
  }) => Promise<{
    boundary: CheckpointSnapshotBoundary;
    summary: DiffFingerprintSummary;
    manifest: DiffFingerprintManifest | null;
    /**
     * Segment file-sets for the claims partition. Omitted
     * when `overlap` was absent, the close tree is unavailable, or
     * segment computation failed — the store then partitions
     * claims-only, disclosed.
     */
    segment_evidence?: PartitionSegment[];
    /**
     * Paths unmerged in the real index at close time. Unioned with the open
     * event's `open_unmerged_paths` into the degraded set the close filters
     * on and persists as `attribution_degraded`.
     */
    unmerged_paths?: readonly string[];
    /**
     * The unmerged-index probe itself failed at close. Merged (OR) with
     * the open event's `open_unmerged_probe_failed` into
     * `attribution_degraded.probe_failed` — an unverifiable window must
     * stay durably distinguishable from a clean one.
     */
    unmerged_probe_failed?: boolean;
  }>;
}

export interface CheckpointAbandonCallbacks {
  captureAbandonSnapshot?: (proposed: {
    artifact_id: string;
    n: number;
  }) => Promise<{ boundary: CheckpointSnapshotBoundary }>;
}

export interface CheckpointOpenWriteOptions extends CaptureWriteOptions {
  /**
   * Git HEAD at the time of the open. CLI resolves via
   * `ctx.repo.getHeadSha()`. Required: the runtime is the only
   * source of truth for this value; tests can pin a fake SHA.
   */
  headSha: string;
  /** Backdated event time used by git-history imports. */
  openedAt?: string;
  /**
   * Lazy evaluator-context builder. Storage calls this ONLY after the
   * committed-event lookup misses — keeping committed replay
   * deterministic across registry drift. When the call has no
   * evaluator-gated logic (storage-direct test callers), pass
   * `undefined` and storage will skip stage-2 idempotency lookup,
   * skip policy-exception validation, and skip the dry-run.
   */
  evaluatorContext?: () => Promise<OpenEvaluatorContext>;
  /**
   * Optional snapshot capture callbacks. When absent, storage writes a
   * deliberate-skip `open_snapshot` boundary on the event payload.
   */
  snapshotCallbacks?: CheckpointSnapshotCallbacks;
}

export interface CheckpointCloseWriteOptions extends CaptureWriteOptions {
  /** Qualified preparation evidence replaces the target-only draft's empty cross-artifact cache. */
  crossArtifactSiblings?: readonly { artifact_id: string; n: number }[];

  /** Backdated event time used by git-history imports. */
  closedAt?: string;
  /** Imported checkpoints do not participate in wall-clock overlap claims. */
  skipWallClockOverlapScan?: boolean;
  /**
   * Optional snapshot + fingerprint capture callbacks. When absent
   * (existing callers), storage writes deliberate-skip
   * `close_snapshot` + `diff_fingerprint_summary` on the event
   * payload, no `diff_fingerprint_manifest`.
   */
  snapshotCallbacks?: CheckpointCloseCallbacks;
}

export interface CheckpointAbandonWriteOptions extends CaptureWriteOptions {
  /**
   * Optional snapshot capture callbacks. When absent (existing
   * callers), storage writes a deliberate-skip `abandon_snapshot` on
   * the event payload. No manifest is built for abandoned cps in v1.
   */
  snapshotCallbacks?: CheckpointAbandonCallbacks;
}

export type CheckpointOpenWriteResult =
  | { outcome: 'created'; checkpoint: OpenCheckpoint }
  | { outcome: 'replay'; checkpoint: OpenCheckpoint; priorEventId: string }
  | { outcome: 'blocked'; envelope: unknown; idempotencyOutcome: 'created' | 'replay' }
  | { outcome: 'conflict'; priorEventId?: string };

export interface CheckpointCloseInput {
  artifact_id: string;
  n: number;
  summary: string;
  files_changed: string[];
  decisions: CheckpointDecision[];
  uncertainty: string[];
  done_criteria: DoneCriterion[];
  /**
   * Verified-close evidence. Optional here so pre-existing
   * internal callers (test fixtures, eval-test) stay valid; the write
   * path treats absent as empty and converts empty → key-absent at
   * every persisted layer (optional-absent posture).
   */
  verification?: VerificationEntry[];
  /**
   * UUIDv7 step_ids completed by THIS checkpoint. Must be a subset
   * of the open cp's `declared_step_ids` (subset, not equal —
   * agents discover scope mid-step). Storage validates uniqueness
   * within the array; subset check enforces against the open's
   * declared scope.
   */
  completed_step_ids: string[];
  /**
   * Git HEAD at close time. CLI resolves via `ctx.repo.getHeadSha()`.
   * Required: the runtime is the only source of truth; tests pin a
   * fake SHA. No fallback to `plan.base_sha` — that masked stale
   * heads in synthetic test contexts.
   */
  head_sha: string;
}

export type CheckpointCloseWriteResult =
  | { outcome: 'created'; checkpoint: ClosedCheckpoint }
  | { outcome: 'replay'; checkpoint: ClosedCheckpoint; priorEventId: string }
  | { outcome: 'conflict' };

export interface CheckpointAbandonInput {
  artifact_id: string;
  n: number;
  reason: string;
}

export type CheckpointAbandonWriteResult =
  | { outcome: 'created'; checkpoint: AbandonedCheckpoint }
  | { outcome: 'replay'; checkpoint: AbandonedCheckpoint; priorEventId: string }
  | { outcome: 'conflict' };

export interface SummaryWriteResult {
  outcome: WriteOutcome;
  summary: Summary;
  priorEventId?: string;
  /** The summary_captured event id on the created path — the supersede token. */
  event_id?: string;
}

export type GitImportEnrichmentWriteResult =
  | { outcome: 'created'; event_id: string; enrichment: GitImportEnrichmentPayload }
  | { outcome: 'replay'; priorEventId: string; enrichment: GitImportEnrichmentPayload }
  | { outcome: 'conflict'; priorEventId: string };

/**
 * Result of writing an evaluator run or disposition event. Returns
 * the rebuilt V2 log so callers can short-circuit a follow-up
 * `readEvaluatorLog` after a write.
 */
export interface EvaluatorRunWriteResult {
  outcome: WriteOutcome;
  log: EvaluatorLog;
  priorEventId?: string;
}

export type PlanReviseWriteResult =
  | { outcome: 'created'; plan: Plan; priorEventId: string }
  | { outcome: 'replay'; plan: Plan; priorEventId: string }
  | { outcome: 'conflict'; priorEventId?: string };
