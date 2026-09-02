import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z, ZodError } from 'zod';

import type { GateAuditPayload } from '@orcaops/evaluator-protocol';

import { writeArtifactJson } from './artifact-json.js';
import { atomicWriteFile } from './atomic-write.js';
import {
  ArtifactDeletionRecoveryError,
  ArtifactFinalizedError,
  BlockedError,
  CheckpointNotFoundError,
  CheckpointNotOpenError,
  CompletedNotInDeclaredError,
  CompletedStepsInvalidError,
  DeclaredStepsInvalidError,
  DoneCriteriaInvalidError,
  EventLogAppendRefusedError,
  OpenCheckpointOverlapError,
  OpenCheckpointsPendingError,
  PlanRevisionInputInvalidError,
  PlanRevisionOpenCpConflictError,
  RecoveryRefusedError,
  StalePlanRevisionError,
  StaleSummarySupersedeError,
  SummaryAlreadyCapturedError,
  UnacknowledgedCriteriaChangesError,
  UnacknowledgedDroppedCompletionsError,
  VerificationRequiredError,
  WarningAcceptanceInvalidError,
} from './errors.js';
import {
  type ArtifactPaths,
  artifactPathsFor,
  artifactsRoot,
  cacheDbPath,
  hasDurableCacheSources,
  locksDir,
} from './paths.js';
import type { ArchiveMirror } from '../archive/mirror.js';
import { canonicalJson } from '../events/canonical-json.js';
import {
  applyClaimsPartition,
  applyUnmergedExclusion,
  type PartitionSegment,
} from '../events/claims-partition.js';
import {
  appendEvent,
  type AppendEventInput,
  type EventRecord,
  type EventType,
  flushEventLog,
  readEventLog,
} from '../events/event-log.js';
import { getHwmBaseline } from '../events/hwm-baseline.js';
import {
  adjudicateOverlapGroups,
  type AdjudicationCheckpoint,
  type CheckpointAdjudication,
} from '../events/overlap-adjudication.js';
import {
  type EventWithPayload,
  loadEventsWithPayloads,
  rebuildArtifactJsonFromEvents,
  rebuildCheckpointFromEvents,
  rebuildEvaluatorLogFromEvents,
  rebuildPlanFromEvents,
  rebuildSummaryFromEvents,
} from '../events/rebuilders.js';
import { lossyCorruptEvents, recoverProjection, type RecoveryResult } from '../events/recovery.js';
import { detectWindowOverlap } from '../events/window-overlap.js';
import { fsyncDirStrict, mkdirDurable } from '../fs/durable.js';
import {
  clearIdempotencyBlock,
  findArtifactScopedReplay,
  findBlockedReplay,
  findCommittedReplay,
  findThreeOutcomeIdempotency,
  recordHardRejected,
  recordSoftBlocked,
} from '../idempotency/idempotency.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { ArtifactLock, ArtifactLockLeaseLostError } from '../locks.js';
import { parseMarkdown } from '../markdown/parse.js';
import { serializeMarkdown } from '../markdown/serialize.js';
import { assertResolvedWithin, assertSafePathSegment } from '../paths/containment.js';
import {
  type ArtifactJson,
  ArtifactJsonSchema,
  type BranchLineageEntry,
  BranchLineageEntrySchema,
} from '../schema/artifact-json.js';
import type { CapturePlanReviseInput } from '../schema/capture-input.js';
import {
  type AbandonedCheckpoint,
  type Checkpoint,
  type CheckpointDecision,
  CheckpointSchema,
  type ClosedCheckpoint,
  type DoneCriterion,
  type OpenCheckpoint,
  OpenCheckpointSchema,
  type PolicyException,
  type VerificationEntry,
  type WindowOverlap,
} from '../schema/checkpoint.js';
import type { CaptureAgentId, Config } from '../schema/config.js';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  type CheckpointSnapshotBoundary,
  type DiffFingerprintManifest,
  type DiffFingerprintSummary,
} from '../schema/diff-fingerprint.js';
import {
  blockingEvaluatorFailureKind,
  type EvaluatorDispositionPayload,
  EvaluatorDispositionPayloadSchema,
  type EvaluatorLog,
  EvaluatorLogSchema,
  type EvaluatorRunPayload,
  EvaluatorRunPayloadSchema,
} from '../schema/evaluator-run.js';
import {
  type AcceptanceCriterion,
  type CriterionLineage,
  CriterionLineageSchema,
  type NonGoal,
  type Plan,
  type PlanInput,
  PlanInputSchema,
  PlanSchema,
  type PlanStep,
  type StepLineage,
  StepLineageSchema,
} from '../schema/plan.js';
import {
  PrePrCheckedPayloadSchema,
  type PrePrCheckedWritePayload,
} from '../schema/pre-pr-checked.js';
import { type SourcePlanPin, SourcePlanPinSchema } from '../schema/source-plan.js';
import {
  type AcceptedWarning,
  normalizeAcceptedWarnings,
  normalizeAcceptedWarningsForReplay,
  type Summary,
  type SummaryInput,
  SummaryInputSchema,
  SummarySchema,
} from '../schema/summary.js';
import { buildPlanSearchContent } from '../store/search-content.js';
import {
  type ArtifactRow,
  type CheckpointRow,
  type SearchSourceRef,
  Store,
} from '../store/sqlite.js';
import { withNonDerivableWriteLease } from '../store/write-lease.js';
import { deepStripControlChars } from '../text/control-chars.js';

export interface ArtifactStoreOptions {
  repoRoot: string;
  config: Config;
  store?: Store;
  lock?: ArtifactLock;
  /**
   * Optional archive mirror. When present, every event append is
   * write-through mirrored into the home-dir archive — fail-open (the
   * mirror never throws), inside the already-held per-artifact lock.
   */
  archive?: ArchiveMirror | null;
}

export interface ArtifactDeletionStagingEntry {
  artifact_id: string;
  staging_path: string;
  phase: 'prepared' | 'committed';
}

export interface ArtifactDeletionStagingInspection {
  entries: ArtifactDeletionStagingEntry[];
  problems: string[];
}

export interface ArtifactDeletionReconciliation {
  restored: string[];
  removed: string[];
}

const ARTIFACT_DELETION_LOCK_KEY = 'artifact-deletion';

/**
 * Options for the "auto-mint" event writers: the idempotency key is
 * OPTIONAL and auto-minted (UUIDv7) when omitted. Each such writer
 * resolves `opts.idempotencyKey ?? uuidv7()` at the write boundary, so a
 * missing key never reaches `appendEvent` — which throws on a
 * missing/empty key rather than letting a keyless event be silently
 * dropped by the strict read-schema. Supply a key only for replay-safe
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
 * never auto-minted. A falsy key is caught loudly by `appendEvent`'s
 * guard rather than swapped for a random one (which would mask a caller
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
 * Pre-append callback invoked inside the artifact lock, after
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
   * exception flow via `acknowledge_policy_exception`. Throws a
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
 * BEFORE `appendEvent`. Each callback returns the boundary (and, for
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
     * Empty-fence recovery context, resolved under the lock from the
     * in-lock event log + artifact.json projection. When the open→close fence
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
     * computes this under the lock (interval scan + boundary refs +
     * known claims) and passes it in; the callback — which owns ALL git
     * work — appends its fresh close boundary ({eventIdx:
     * currentCloseIdx, phase 'close', its new tree}) to `boundaries`
     * and computes per-segment file-sets via core's
     * `computeWindowSegments`, returning them as `segment_evidence`.
     * Storage never invokes git; everything happens under the one
     * existing lock acquisition.
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

export class ArtifactStore {
  readonly repoRoot: string;
  readonly config: Config;
  readonly store: Store;
  readonly lock: ArtifactLock;
  private readonly ownsStore: boolean;
  private readonly archive: ArchiveMirror | null;
  private readonly eventBatchContext = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly dirtyBatchedArtifacts = new Set<string>();
  constructor(opts: ArtifactStoreOptions) {
    this.repoRoot = opts.repoRoot;
    this.config = opts.config;
    if (opts.store) {
      this.store = opts.store;
      this.ownsStore = false;
    } else {
      this.store = new Store(cacheDbPath(this.repoRoot, this.config), {
        containmentRoot: this.repoRoot,
        rebuildFreshProjection: hasDurableCacheSources(this.repoRoot, this.config),
      });
      this.ownsStore = true;
    }
    this.lock =
      opts.lock ??
      new ArtifactLock({
        locksDir: locksDir(this.repoRoot),
        containmentRoot: this.repoRoot,
        heartbeatIntervalMs: 30_000,
      });
    this.archive = opts.archive ?? null;
  }

  /**
   * The single write seam for artifact events: hot append first
   * (authoritative), archive mirror second — same held lock, fail-open
   * (the mirror reports failures via its own warn sink and never throws,
   * so capture is never blocked by archive trouble).
   */
  private async appendAndMirror(
    input: AppendEventInput,
    paths: ArtifactPaths
  ): Promise<EventRecord> {
    // Lossy-history preflight BEFORE the append: every capture writer
    // funnels through here, so refusal is side-effect-free — nothing
    // reaches the log or the cloud mirror. Guarding only in the
    // post-append fold let a writer durably mutate both and THEN fail,
    // so a retry after repair could append the semantic operation twice.
    // The re-read is deliberately redundant with the callers' own
    // loadAllEvents folds: defense in depth at the one choke point,
    // priced at one extra log scan per append.
    let preflightRead;
    try {
      preflightRead = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
        containmentRoot: this.repoRoot,
      });
    } catch (err) {
      if (err instanceof Error && typeof (err as NodeJS.ErrnoException).errno === 'number') {
        throw new EventLogAppendRefusedError(
          `artifact ${paths.artifactId}: the event log could not be read for the append ` +
            `preflight (${(err as NodeJS.ErrnoException).code ?? 'I/O error'}) — refusing ` +
            `to append blind. Restore read access to the artifact directory and retry.`,
          paths.artifactId,
          'unreadable'
        );
      }
      throw err;
    }
    const { corrupt, lineByEventId } = preflightRead;
    const lossy = corrupt.filter((c) => c.kind !== 'truncated_tail');
    if (lossy.length > 0) {
      throw new EventLogAppendRefusedError(
        `artifact ${paths.artifactId}: event log carries corrupt line(s) ` +
          `${lossy.map((c) => String(c.line)).join(', ')} — writes refuse on a lossy ` +
          `history, since rebuilding projections from the survivors would silently drop ` +
          `the lost contribution. Run \`orcaops doctor\` to see every corrupt event-log ` +
          `line for this artifact.`,
        paths.artifactId,
        'lossy'
      );
    }
    // A crash-truncated tail is benign to READ (never acknowledged, so
    // treated as never written), but appending after unterminated bytes
    // would either merge the new event into the partial line or convert
    // the residue into lossy corruption — refuse and name the line so
    // the operator removes it or restores the log before capturing.
    const tail = corrupt.find((c) => c.kind === 'truncated_tail');
    if (tail !== undefined) {
      throw new EventLogAppendRefusedError(
        `artifact ${paths.artifactId}: the final event-log line (${tail.line}) is an ` +
          `unterminated partial write — crash residue that was never acknowledged. ` +
          `Remove that partial line before capturing again (with the archive enabled, ` +
          `\`orcaops archive resolve --artifact ${paths.artifactId} --source archive --apply\` ` +
          `can replace the hot log); ` +
          `appending after it would corrupt both it and the new event.`,
        paths.artifactId,
        'truncated_tail'
      );
    }
    // Missing-source witness guard: the read side refuses a projection
    // whose source event is absent from the intact log and preserves the
    // file as the only witness of the removed history — but every append
    // rebuilds artifact.json, which would overwrite that witness.
    // artifact.json's source is always the artifact's LAST event, so a
    // clean suffix truncation is visible here as a non-null source id
    // the log no longer contains. One extra file read at the single
    // write choke point protects the projection every writer rewrites.
    const artifactWitness = await readProjectionForRecovery(
      paths.artifactJson,
      this.repoRoot,
      (raw) => raw
    );
    if (
      artifactWitness !== null &&
      !('unreadable' in artifactWitness) &&
      !lineByEventId.has(artifactWitness.source_event_id)
    ) {
      throw new RecoveryRefusedError(
        `artifact ${paths.artifactId}: artifact.json names source event ` +
          `${artifactWitness.source_event_id}, which is absent from the intact event log — ` +
          `log lines were removed without corruption markers (e.g. a clean truncation). ` +
          `Writing would rebuild projections over the removed history and destroy the ` +
          `witness. Restore events.ndjson from a backup or the archive mirror before ` +
          `capturing again.`,
        paths.artifactId
      );
    }
    // Rotate before the durable append. A false-pending marker after a failed
    // append is safe; rotating afterward would leave a stale push a window to
    // record clean state for content that has already landed in the event log.
    this.store.rotateCloudSyncTokens([paths.artifactId]);
    const batched = this.eventBatchContext.getStore()?.has(paths.artifactId) === true;
    const event = await appendEvent(input, {
      eventLogPath: paths.eventsNdjson,
      sidecarsDir: paths.sidecarsDir,
      // The grant: this store owns the artifacts tree, so a pre-existing
      // permissive root is narrowed when a new artifact lands under it. Only
      // here is that ownership actually known.
      ownedRoot: artifactsRoot(this.repoRoot, this.config),
      containmentRoot: this.repoRoot,
      ...(batched ? { deferSync: true } : {}),
    });
    if (batched) this.dirtyBatchedArtifacts.add(paths.artifactId);
    if (this.archive) {
      // The archive must never hold an event the durable hot log could still
      // lose: complete the deferred durability acknowledgement before any
      // mirror write. With the archive enabled a batch therefore flushes per
      // event; the batching win is preserved for archive-less stores.
      if (batched && this.dirtyBatchedArtifacts.has(paths.artifactId)) {
        await flushEventLog(paths.eventsNdjson, this.repoRoot);
        this.dirtyBatchedArtifacts.delete(paths.artifactId);
      }
      await this.archive.mirrorEventRecord(
        paths.artifactId,
        event,
        paths.sidecarsDir,
        this.repoRoot
      );
    }
    return event;
  }

  close(): void {
    if (this.ownsStore) {
      this.store.close();
    }
  }

  /**
   * Run `fn` inside the per-artifact lock. Public so CLI callers can
   * make their own atomic sections (e.g., pre-pr-check's gate +
   * lifecycle write) without re-implementing lock semantics. Internal
   * write methods take the lock themselves; this helper is for
   * read-then-write patterns at the CLI layer that storage's own
   * methods don't cover. Throws `ArtifactLockTimeoutError` per the
   * `ArtifactLock` contract.
   */
  withArtifactLock<T>(artifactId: string, fn: () => Promise<T>): Promise<T> {
    return this.lock.withLock(artifactId, fn);
  }

  /**
   * Hold one artifact lock and acknowledge one event-log flush for a multi-event
   * operation. Internal writers stay individually durable outside this seam.
   */
  withArtifactEventBatch<T>(artifactId: string, fn: () => Promise<T>): Promise<T> {
    const active = this.eventBatchContext.getStore();
    if (active?.has(artifactId)) return fn();
    return this.lock.withLock(artifactId, async () => {
      const batch = new Set(active ?? []);
      batch.add(artifactId);
      return this.eventBatchContext.run(batch, async () => {
        try {
          return await fn();
        } finally {
          try {
            if (this.dirtyBatchedArtifacts.has(artifactId)) {
              const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
              await flushEventLog(paths.eventsNdjson, this.repoRoot);
            }
          } finally {
            this.dirtyBatchedArtifacts.delete(artifactId);
          }
        }
      });
    });
  }

  private withWriteLock<T>(artifactId: string, fn: () => Promise<T>): Promise<T> {
    return this.eventBatchContext.getStore()?.has(artifactId)
      ? fn()
      : this.lock.withLock(artifactId, fn);
  }

  // ────────────────────────────────────────
  // Plan
  // ────────────────────────────────────────

  /**
   * Initial plan capture. Caller passes a Plan with revision_n = 0 and
   * step_ids already minted (the CLI mints them in capture/plan.ts).
   * Emits a `plan_captured` event; subsequent revisions go through
   * `revisePlan` and emit `plan_revised`.
   */
  /**
   * Repair a checkpoint whose event landed but whose projection and cache row
   * did not. Every writer appends its event before writing derived state, so
   * every writer has that window. Inert unless the derived state disagrees.
   */
  private async repairCheckpointProjection(
    paths: ArtifactPaths,
    events: EventWithPayload[],
    artifact: ArtifactRow,
    n: number
  ): Promise<void> {
    // Rebuild from the WHOLE log, not the replaying branch's own
    // reconstruction: an open-event replay on a since-closed checkpoint must
    // not drag the projection back to `open`. Derived state only moves forward.
    const rebuilt = rebuildCheckpointFromEvents(events, n);
    if (!rebuilt) return;
    const checkpoint = rebuilt.checkpoint;
    const cached = this.store.getCheckpoints(artifact.id).find((row) => row.n === n);
    const rowTorn = !cached || cached.status !== checkpoint.status;
    // Only close writes a search entry — open and abandon do not, so the
    // repair must not invent one for them. The entry is the LAST write of the
    // close commit group, so the row agreeing does not prove the group
    // finished: a crash between the two leaves the checkpoint's summary and
    // uncertainty unsearchable, and gating on the row alone never repairs it.
    const searchSource: SearchSourceRef = `checkpoint:${n}`;
    const searchTorn =
      checkpoint.status === 'closed' && !this.store.hasSearchEntry(artifact.id, searchSource);
    if (!rowTorn && !searchTorn) return;
    if (rowTorn) {
      const rebuiltArtifact = rebuildArtifactJsonFromEvents(events);
      await atomicWriteFile(
        paths.checkpointJson(checkpoint.n),
        JSON.stringify(checkpoint, null, 2) + '\n',
        this.repoRoot
      );
      await atomicWriteFile(
        paths.checkpointMd(checkpoint.n),
        checkpointMarkdown(checkpoint),
        this.repoRoot
      );
      if (rebuiltArtifact) {
        await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);
      }
      this.store.upsertCheckpoint(checkpointToRow(checkpoint));
    }
    if (checkpoint.status === 'closed') {
      this.store.replaceSearchEntry({
        artifact_id: artifact.id,
        source: searchSource,
        branch: artifact.branch,
        ts: checkpoint.closed_at,
        content: `${checkpoint.summary} · ${checkpoint.uncertainty.join(' · ')}`,
      });
    }
  }

  /**
   * Project an initial plan into the SQLite cache. Shared by the commit path
   * and the replay branch's repair so the two cannot drift.
   */
  private projectPlanIntoCache(
    plan: Pick<
      PlanInput,
      | 'artifact_id'
      | 'branch'
      | 'task'
      | 'label'
      | 'agent'
      | 'base_sha'
      | 'started_at'
      | 'non_goals'
      | 'touched_scope'
      | 'decisions'
      | 'step_lineage'
      | 'criterion_lineage'
      | 'plan_steps'
      | 'origin'
    >,
    sourceEventId: string,
    branchLineage: ArtifactJson['branch_lineage']
  ): void {
    this.store.upsertArtifact({
      id: plan.artifact_id,
      branch: plan.branch,
      task: plan.task,
      label: plan.label,
      agent: plan.agent,
      base_sha: plan.base_sha,
      started_at: plan.started_at,
      completed_at: null,
      status: 'active',
      non_goals: JSON.stringify(plan.non_goals),
      origin_kind: plan.origin?.kind ?? null,
    });
    this.store.upsertPlanRevision({
      plan: {
        artifact_id: plan.artifact_id,
        revision_n: 0,
        captured_at: plan.started_at,
        label: plan.label,
        rationale: null,
        touched_scope: JSON.stringify(plan.touched_scope),
        non_goals: JSON.stringify(plan.non_goals),
        decisions: JSON.stringify(plan.decisions),
        step_lineage: JSON.stringify(plan.step_lineage),
        criterion_lineage: JSON.stringify(plan.criterion_lineage),
        prior_event_id: null,
        source_event_id: sourceEventId,
      },
      steps: plan.plan_steps.map((s, idx) => ({
        step_id: s.step_id,
        idx,
        text: s.text,
        label: s.label,
        acceptance_criteria: JSON.stringify(s.acceptance_criteria),
      })),
    });
    this.store.replaceSearchEntry({
      artifact_id: plan.artifact_id,
      source: 'plan:0',
      branch: plan.branch,
      ts: plan.started_at,
      content: buildPlanSearchContent(plan),
    });
    const tail = branchLineage[branchLineage.length - 1];
    this.store.upsertLineageByLatestSha({
      artifact_id: plan.artifact_id,
      latest_lineage_sha: tail.head_sha,
      branch_name: tail.branch,
    });
    for (const entry of branchLineage) {
      this.store.upsertLineageBranch({
        artifact_id: plan.artifact_id,
        branch_name: entry.branch,
      });
    }
  }

  async writePlan(input: PlanInput, opts: PlanWriteOptions = {}): Promise<{ event_id: string }> {
    const plan = PlanInputSchema.parse(input);
    if (plan.revision_n !== 0) {
      throw new Error(
        `writePlan requires revision_n = 0 (got ${plan.revision_n}); ` +
          `subsequent revisions go through revisePlan.`
      );
    }
    const paths = artifactPathsFor(this.repoRoot, this.config, plan.artifact_id);
    const idempotencyKey = opts.idempotencyKey ?? uuidv7();

    return this.withWriteLock(plan.artifact_id, async () => {
      const eventPayload = plan;
      // Splice the pinned source plan onto the plan_captured
      // payload when present. It is NOT a Plan field — the (non-strict)
      // plan rebuilder drops it, while rebuildArtifactJsonFromEvents
      // reads it off this same payload and projects it set-once.
      // Validate the pin at the write boundary so
      // a malformed source_plan is rejected HERE rather than silently nulled
      // at read by the rebuilder's safeParse. Parse ONLY when present —
      // opts.sourcePlan is undefined for unpinned artifacts (the common
      // path), which must stay "no pin".
      const pin = opts.sourcePlan ? SourcePlanPinSchema.parse(opts.sourcePlan) : undefined;
      // Splice the plan-time baseline seed (when the caller supplies it) onto
      // the same plan_captured payload — like source_plan it is NOT a Plan
      // field, so the non-strict plan rebuilder drops it while the artifact-json
      // rebuilder reads it off this raw payload and projects it set-once.
      const seed =
        typeof opts.baselineSeedTreeSha === 'string' ? opts.baselineSeedTreeSha : undefined;
      // Splice the supersession audit id (when a confirmed
      // --source-plan re-capture overrode the seed) onto the same payload,
      // mirroring source_plan / baseline_seed_tree_sha — the non-strict plan
      // rebuilder drops it; the artifact-json rebuilder projects it set-once.
      const superseded =
        typeof opts.supersededArtifactId === 'string' ? opts.supersededArtifactId : undefined;
      const payload = {
        ...eventPayload,
        ...(pin ? { source_plan: pin } : {}),
        ...(seed !== undefined ? { baseline_seed_tree_sha: seed } : {}),
        // Payload-only, stamped when non-empty — read raw at close to
        // block seed recovery from a mid-conflict baseline.
        ...((opts.baselineUnmergedPaths?.length ?? 0) > 0
          ? { baseline_unmerged_paths: [...(opts.baselineUnmergedPaths ?? [])] }
          : {}),
        ...(superseded !== undefined ? { superseded_artifact_id: superseded } : {}),
      };

      // A key match replays regardless of payload equality: initial capture is
      // once-only, so a second plan_captured is never the right answer — and a
      // caller deriving both the artifact id and the key deterministically
      // would otherwise append one after a crash, which rebuildPlanFromEvents
      // then refuses permanently as log corruption. An omitted key is a minted
      // uuidv7 that matches nothing, so opt-out callers are unaffected.
      const priorEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const priorPlan = priorEvents.find(
        (candidate) =>
          candidate.record.type === 'plan_captured' &&
          candidate.record.idempotency_key === idempotencyKey
      );
      if (priorPlan) {
        // Driven off the REBUILT plan, never the retry's input: the durable
        // event is authoritative over whatever this call happens to carry.
        const rebuilt = rebuildPlanFromEvents(priorEvents);
        const rebuiltJson = rebuildArtifactJsonFromEvents(priorEvents);
        if (rebuilt && rebuiltJson) {
          await atomicWriteFile(
            paths.planJson,
            JSON.stringify(rebuilt.plan, null, 2) + '\n',
            this.repoRoot
          );
          await atomicWriteFile(paths.planMd, planMarkdown(rebuilt.plan), this.repoRoot);
          await writeArtifactJson(paths.artifactJson, rebuiltJson.json, this.repoRoot);
          this.projectPlanIntoCache(
            rebuilt.plan,
            priorPlan.record.event_id,
            rebuiltJson.json.branch_lineage
          );
        }
        return { event_id: priorPlan.record.event_id };
      }

      const event = await this.appendAndMirror(
        {
          type: 'plan_captured',
          ts: plan.started_at,
          idempotency_key: idempotencyKey,
          payload,
        },
        paths
      );

      const events = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuiltPlan = rebuildPlanFromEvents(events);
      if (!rebuiltPlan) {
        throw new Error(
          `event-first writePlan invariant: rebuilder found no plan_captured event ` +
            `right after appending one (event_id=${event.event_id})`
        );
      }
      const rebuiltArtifact = rebuildArtifactJsonFromEvents(events);
      if (!rebuiltArtifact) {
        throw new Error(
          `event-first writePlan invariant: artifact.json rebuilder returned null ` +
            `with a plan_captured event present (event_id=${event.event_id})`
        );
      }

      await atomicWriteFile(
        paths.planJson,
        JSON.stringify(rebuiltPlan.plan, null, 2) + '\n',
        this.repoRoot
      );
      await atomicWriteFile(paths.planMd, planMarkdown(rebuiltPlan.plan), this.repoRoot);
      await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);

      this.projectPlanIntoCache(plan, event.event_id, rebuiltArtifact.json.branch_lineage);

      // Return the plan_captured event_id so the CLI can surface it as the
      // top-level plan_event_id (the plan_revision_id optimistic-concurrency
      // token), matching revisePlan / resume which already expose it. The
      // event_id is already minted above — this is response-shape only, nothing
      // new is hashed.
      return { event_id: event.event_id };
    });
  }

  /**
   * Whether the authoritative event log contains the initial plan event
   * for this artifact and key. Capture-plan uses this only after
   * writePlan throws: a confirmed event keeps the reservation for
   * rebuild + same-key replay, while a confirmed absence permits the
   * unpublished reservation to be rolled back.
   */
  async hasCommittedPlanCapture(artifactId: string, idempotencyKey: string): Promise<boolean> {
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    const events = await this.loadAllEvents(
      paths.eventsNdjson,
      paths.sidecarsDir,
      paths.artifactId
    );
    return events.some(
      (event) =>
        event.record.type === 'plan_captured' && event.record.idempotency_key === idempotencyKey
    );
  }

  /**
   * Plan revision. Append-only `plan_revised` event with full
   * supersede semantics (the payload carries the complete new plan;
   * latest event wins in the projection). Three-outcome idempotency
   * scoped to the artifact + idempotency_blocks table.
   *
   * Validation gates (in order, all under the per-artifact lock):
   *   1. `ARTIFACT_FINALIZED` if a `summary_captured` event exists for
   *      the artifact. (`pre_pr_checked` does NOT finalize — pre-pr is a
   *      repeatable gate before summary.)
   *   2. Schema invariants: input.plan_steps non-empty, step_ids
   *      unique within the input.
   *   3. `STALE_PLAN_REVISION` if `prior_plan_event_id` is non-null
   *      and not the latest plan event.
   *   4. Carryover step_ids must exist in the prior revision
   *      (`PLAN_REVISION_INPUT_INVALID`).
   *   5. `PLAN_REVISION_OPEN_CP_CONFLICT` if any open cp's
   *      `declared_step_ids` includes a step_id being dropped.
   *   6. `PLAN_REVISION_UNACKNOWLEDGED_DROPS` if any closed cp's
   *      `completed_step_ids` includes a step_id being dropped
   *      AND that step_id isn't in
   *      `acknowledge_drops_completed_steps`.
   */
  async revisePlan(
    input: CapturePlanReviseInput,
    opts: CaptureWriteOptions
  ): Promise<PlanReviseWriteResult> {
    const artifact = this.store.getArtifact(input.artifact_id);
    if (!artifact) {
      throw new Error(
        `Cannot revise plan for unknown artifact_id "${input.artifact_id}". ` +
          `Call writePlan first.`
      );
    }
    const paths = artifactPathsFor(this.repoRoot, this.config, input.artifact_id);

    return this.withWriteLock(input.artifact_id, async () => {
      const events = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );

      // Replay shape strips runtime-derived fields (revised_at, the
      // server-minted step_ids on new steps) so payload-equality
      // detection is deterministic across calls. We compare the
      // input shape — which carries optional step_ids the agent
      // chose to preserve — not the materialized event payload.
      //
      // `prior_plan_event_id` is intentionally OMITTED from the
      // replay shape: it's a freshness token at call-time (null =
      // skip-check, otherwise the event_id the agent observed), not
      // part of revision intent. Including it would make identical-
      // payload retries with different freshness intent (or with the
      // server-resolved event_id on the committed side) false-conflict.
      const replayAgentSessionId = resolveRevisionAgentSessionForReplay(
        events,
        opts.idempotencyKey,
        input.agent_session_id
      );
      const reviseReplayPayload = opts.replayPayload ?? {
        artifact_id: input.artifact_id,
        label: input.label,
        plan_steps: input.plan_steps.map((s) => ({
          step_id: s.step_id ?? null,
          text: s.text,
          label: s.label,
          acceptance_criteria: s.acceptance_criteria.map((c) => ({
            criterion_id: c.criterion_id ?? null,
            text: c.text,
          })),
        })),
        touched_scope: [...input.touched_scope],
        non_goals: [...input.non_goals],
        rationale: input.rationale,
        agent_session_id: replayAgentSessionId,
        acknowledge_drops_completed_steps: [...input.acknowledge_drops_completed_steps].sort(),
        acknowledge_criteria_changes: [...(input.acknowledge_criteria_changes ?? [])].sort(),
        // New decisions THIS revise declares (base shape — the write path stamps
        // revision_n and cumulates onto the prior set). `?? []` for direct callers
        // that omit it; the extract shape below filters the committed cumulative
        // set back down to this revision's new entries for the equality check.
        decisions: [...(input.decisions ?? [])],
      };
      const reviseBlockedPayload = {
        ...reviseReplayPayload,
        agent_session_id:
          input.agent_session_id === undefined
            ? { mode: 'inherit' as const }
            : { mode: 'set' as const, value: input.agent_session_id },
      };
      const reviseExtractShape =
        opts.extractReplayShape ??
        ((priorPayload: unknown) => {
          if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
          const p = priorPayload as Record<string, unknown>;
          return {
            artifact_id: p.artifact_id,
            label: p.label,
            // The committed event payload has the materialized plan
            // (every step has a step_id). Reconstruct the input
            // shape so equality matches a same-payload replay.
            plan_steps: extractInputStepShapeFromCommitted(p),
            touched_scope: p.touched_scope,
            non_goals: p.non_goals,
            rationale: p.rationale,
            agent_session_id: p.agent_session_id ?? null,
            acknowledge_drops_completed_steps: extractAckDrops(p),
            acknowledge_criteria_changes: extractAckCriteriaChanges(p),
            // This revision's NEW decisions, reconstructed to the base input
            // shape from the cumulative committed set (keep only entries stamped
            // at this payload's revision_n, drop the tag). Array.isArray-guarded
            // because the committed payload is raw untyped JSON here.
            decisions: extractNewDecisionsFromCommitted(p),
          };
        });
      const lookup = await findThreeOutcomeIdempotency({
        store: this.store,
        events: events.map((e) => e.record),
        artifactId: input.artifact_id,
        type: 'plan_revised',
        idempotencyKey: opts.idempotencyKey,
        payload: reviseReplayPayload,
        blockedPayload: reviseBlockedPayload,
        loadPriorPayload: (priorEvent) =>
          normalizePriorPayload(priorEvent, events, reviseExtractShape),
      });
      if (lookup.kind === 'replay-committed') {
        const matchedEventIdx = events.findIndex(
          (event) => event.record.event_id === lookup.priorEventId
        );
        const rebuilt =
          matchedEventIdx >= 0 ? rebuildPlanFromEvents(events.slice(0, matchedEventIdx + 1)) : null;
        if (rebuilt) {
          return {
            outcome: 'replay' as const,
            plan: rebuilt.plan,
            priorEventId: lookup.priorEventId,
          };
        }
      }
      if (lookup.kind === 'conflict') {
        return { outcome: 'conflict' as const };
      }
      // first-call OR reevaluate — proceed.

      const recordAndThrow = async (err: Error): Promise<never> => {
        await withNonDerivableWriteLease(this.repoRoot, () =>
          recordHardRejected({
            store: this.store,
            artifactId: input.artifact_id,
            idempotencyKey: opts.idempotencyKey,
            type: 'plan_revised',
            payload: reviseBlockedPayload,
          })
        );
        throw err;
      };

      // GATE 1: artifact-finalized. Only `summary_captured` finalizes.
      // `pre_pr_checked` is a repeatable gate before summary, NOT a
      // one-way door, so a passing pre-pr does not freeze plan revision
      // (the pre-pr marker simply goes stale and the check re-runs).
      const finalizationEv = events.find((e) => e.record.type === 'summary_captured');
      if (finalizationEv) {
        await recordAndThrow(
          new ArtifactFinalizedError(
            `Cannot revise plan for artifact "${input.artifact_id}": ` +
              `summary was captured at ${finalizationEv.record.ts} — revision is frozen post-finalization.`,
            input.artifact_id
          )
        );
      }

      // GATE 2: schema invariants on input plan_steps.
      const seenInputIds = new Set<string>();
      for (const s of input.plan_steps) {
        if (s.step_id !== undefined) {
          if (seenInputIds.has(s.step_id)) {
            await recordAndThrow(
              new PlanRevisionInputInvalidError(
                `plan_steps contains duplicate step_id "${s.step_id}".`,
                input.artifact_id
              )
            );
          }
          seenInputIds.add(s.step_id);
        }
      }
      const seenLabels = new Set<string>();
      for (let i = 0; i < input.plan_steps.length; i++) {
        const label = input.plan_steps[i].label;
        if (seenLabels.has(label)) {
          await recordAndThrow(
            new PlanRevisionInputInvalidError(
              `plan_steps[${i}].label "${label}" is duplicated within the revision input.`,
              input.artifact_id
            )
          );
        }
        seenLabels.add(label);
      }

      // Need the prior plan for: stale-token check, carryover
      // validation, lineage computation. Past gate 1, the artifact
      // exists and has a plan (writePlan minted revision_n = 0).
      const priorRebuilt = rebuildPlanFromEvents(events);
      if (!priorRebuilt) {
        await recordAndThrow(
          new Error(
            `revisePlan invariant: artifact "${input.artifact_id}" has no plan event but ` +
              `getArtifact returned non-null. Capture-flow ordering bug.`
          )
        );
      }
      const priorPlan = priorRebuilt!.plan;
      const priorEventId = priorRebuilt!.sourceEventId;

      // GATE 3: stale plan revision token.
      if (input.prior_plan_event_id !== null && input.prior_plan_event_id !== priorEventId) {
        await recordAndThrow(
          new StalePlanRevisionError(
            `prior_plan_event_id="${input.prior_plan_event_id}" is not the latest ` +
              `plan event for artifact "${input.artifact_id}" (latest is ${priorEventId}, ` +
              `revision_n=${priorPlan.revision_n}). Re-read the resume / status surface ` +
              `and retry with the fresh token.`,
            input.artifact_id,
            input.prior_plan_event_id,
            priorEventId,
            priorPlan.revision_n
          )
        );
      }

      // GATE 4: carryover step_ids exist in prior plan.
      const priorIdSet = new Set(priorPlan.plan_steps.map((s) => s.step_id));
      for (const s of input.plan_steps) {
        if (s.step_id !== undefined && !priorIdSet.has(s.step_id)) {
          await recordAndThrow(
            new PlanRevisionInputInvalidError(
              `plan_steps[].step_id "${s.step_id}" does not appear in the prior plan ` +
                `(revision_n=${priorPlan.revision_n}). Drop the step_id to mint a new ` +
                `step, or use a step_id that exists in the prior plan.`,
              input.artifact_id
            )
          );
        }
      }

      // Materialize new plan_steps with minted step_ids for fresh entries.
      // Order is preserved from the input array. Acceptance-criteria identity
      // is reconciled, not blindly re-minted: a supplied criterion_id is
      // preserved (revise is full-supersede), and an OMITTED one auto-carries
      // the prior id of a same-step criterion with byte-identical text —
      // honoring the revision-stable-identity contract for unchanged text —
      // else mints. ID policy: a supplied criterion_id MUST have
      // existed in the prior revision and on the SAME step — carry forward or
      // mint, never invent or reassign across steps. In-payload duplicate
      // criterion_ids are caught by PlanSchema.superRefine on the
      // defense-in-depth parse.
      // Single pass over the prior plan builds both indexes downstream needs:
      // `priorCriterionById` (the Pass-A existence/same-step guard + the
      // removed/rewritten lineage diff below) and `priorCriteriaByStep` (the
      // per-step FIFO queue an omitted criterion_id auto-carries against, Pass B).
      const priorCriterionById = new Map<string, { stepId: string; text: string }>();
      const priorCriteriaByStep = new Map<string, Array<{ id: string; text: string }>>();
      for (const ps of priorPlan.plan_steps) {
        const queue: Array<{ id: string; text: string }> = [];
        for (const c of ps.acceptance_criteria) {
          priorCriterionById.set(c.criterion_id, { stepId: ps.step_id, text: c.text });
          queue.push({ id: c.criterion_id, text: c.text });
        }
        priorCriteriaByStep.set(ps.step_id, queue);
      }
      // criterion_ids minted in THIS revision (omitted entries with no carry
      // match). Persisted on the plan_revised event as `criterion_lineage.added`
      // so the idempotency extract can null exactly these to match a same-call
      // retry — mirrors how `step_lineage.added` nulls minted step_ids.
      const mintedCriterionIds: string[] = [];
      // Prior criterion_ids auto-carried this revision (omit → matched a prior
      // id by exact text). Persisted as `criterion_lineage.carried`; the
      // idempotency extract nulls both `added` and `carried` so a same-call
      // retry that re-omits the same text replays instead of false-conflicting
      // (a carried id is concrete in the committed plan but absent from `added`).
      const carriedCriterionIds: string[] = [];
      const newSteps: PlanStep[] = [];
      for (const s of input.plan_steps) {
        const stepId = s.step_id ?? uuidv7();
        const priorQueue = priorCriteriaByStep.get(stepId) ?? [];
        // Prior ids claimed within THIS step — an explicit supply (Pass A) or an
        // auto-carry (Pass B). Per-step scope is sufficient: the prior queue is
        // partitioned by step, so a prior id is only ever contended within its
        // own step (and duplicate input step_ids are already rejected upstream).
        const consumedPriorIds = new Set<string>();
        // Pass A — reserve every explicitly-supplied criterion_id (running the
        // existence + same-step guards) BEFORE the omit-scan, so an omitted
        // duplicate-text entry can't steal an id an explicit entry already owns
        // (which would mint a duplicate id and trip PlanSchema.superRefine).
        for (const c of s.acceptance_criteria) {
          if (c.criterion_id === undefined) continue;
          const priorStepId = priorCriterionById.get(c.criterion_id)?.stepId;
          if (priorStepId === undefined) {
            await recordAndThrow(
              new PlanRevisionInputInvalidError(
                `criterion_id "${c.criterion_id}" does not exist in the prior revision; ` +
                  `carry an existing criterion_id forward, or omit it to mint a new one.`,
                input.artifact_id
              )
            );
          }
          if (priorStepId !== stepId) {
            await recordAndThrow(
              new PlanRevisionInputInvalidError(
                `criterion_id "${c.criterion_id}" belonged to a different step in the prior ` +
                  `revision; acceptance criteria cannot be reassigned across steps.`,
                input.artifact_id
              )
            );
          }
          consumedPriorIds.add(c.criterion_id);
        }
        // Pass B — emit output in input order. Explicit ids pass through
        // (validated in Pass A). An omitted entry carries the first unconsumed
        // prior on this step with byte-identical text (no normalization: the
        // stored criterion text and the revise input share the same prose
        // sanitizer without trimming, so `===` is symmetric and never
        // under-carries); on a miss it mints. A fresh/minted step_id has an
        // empty queue → mints.
        const acceptance_criteria = s.acceptance_criteria.map((c) => {
          if (c.criterion_id !== undefined) {
            return { criterion_id: c.criterion_id, text: c.text };
          }
          const match = priorQueue.find((p) => p.text === c.text && !consumedPriorIds.has(p.id));
          if (match !== undefined) {
            consumedPriorIds.add(match.id);
            carriedCriterionIds.push(match.id);
            return { criterion_id: match.id, text: c.text };
          }
          const mintedId = uuidv7();
          mintedCriterionIds.push(mintedId);
          return { criterion_id: mintedId, text: c.text };
        });
        newSteps.push({ step_id: stepId, text: s.text, label: s.label, acceptance_criteria });
      }
      // Defense-in-depth: minted ids cannot collide with existing
      // ones. UUIDv7 collisions are vanishingly unlikely; surface
      // the case anyway as INTERNAL.
      const newIdSet = new Set(newSteps.map((s) => s.step_id));
      if (newIdSet.size !== newSteps.length) {
        await recordAndThrow(
          new Error(
            `revisePlan invariant: minted plan_steps contain a step_id collision ` +
              `for artifact "${input.artifact_id}". UUIDv7 collision (impossible) or ` +
              `programming error.`
          )
        );
      }

      // Compute step_lineage. `rewritten` carries prior_text_hash so
      // doctor can detect divergent rewrites.
      const priorById = new Map(priorPlan.plan_steps.map((s) => [s.step_id, s] as const));
      const added: string[] = [];
      const unchanged: string[] = [];
      const rewritten: Array<{ step_id: string; prior_text_hash: string }> = [];
      for (const s of newSteps) {
        const prior = priorById.get(s.step_id);
        if (prior === undefined) {
          added.push(s.step_id);
        } else if (prior.text === s.text) {
          unchanged.push(s.step_id);
        } else {
          rewritten.push({
            step_id: s.step_id,
            prior_text_hash: createHash('sha256').update(prior.text).digest('hex'),
          });
        }
      }
      const dropped: string[] = priorPlan.plan_steps
        .filter((s) => !newIdSet.has(s.step_id))
        .map((s) => s.step_id);

      const stepLineage: StepLineage = { added, dropped, unchanged, rewritten };

      // Compute criterion_lineage — the acceptance-criteria
      // sibling of step_lineage. `added` = ids minted this revision (drives
      // the idempotency strip); `removed` / `rewritten` carry the prior text
      // so a narrowed rubric is visible in the digest. The revise ID policy
      // above rejects cross-step reassignment, so a preserved id stays on the
      // same step — `prior_step_id` is its prior (== current) owner.
      // (`priorCriterionById` is built in the single prior-plan pass above.)
      const newCriterionIds = new Set<string>();
      const criterionRewritten: CriterionLineage['rewritten'] = [];
      for (const s of newSteps) {
        for (const c of s.acceptance_criteria) {
          newCriterionIds.add(c.criterion_id);
          const prior = priorCriterionById.get(c.criterion_id);
          if (prior !== undefined && prior.text !== c.text) {
            criterionRewritten.push({
              criterion_id: c.criterion_id,
              prior_step_id: prior.stepId,
              prior_text: prior.text,
              new_text: c.text,
            });
          }
        }
      }
      const criterionRemoved: CriterionLineage['removed'] = [];
      for (const [cid, info] of priorCriterionById) {
        if (!newCriterionIds.has(cid)) {
          criterionRemoved.push({ criterion_id: cid, prior_step_id: info.stepId, text: info.text });
        }
      }
      const criterionLineage: CriterionLineage = {
        added: mintedCriterionIds,
        carried: carriedCriterionIds,
        removed: criterionRemoved,
        rewritten: criterionRewritten,
      };

      // GATE 5: open-cp scope-loss is a hard conflict.
      const openCps = this.store.getOpenCheckpoints(input.artifact_id);
      const droppedSet = new Set(dropped);
      const openConflicts: Array<{
        stepId: string;
        cpN: number;
        agentSessionId: string | null;
      }> = [];
      for (const cp of openCps) {
        for (const stepId of cp.declared_step_ids) {
          if (droppedSet.has(stepId)) {
            openConflicts.push({
              stepId,
              cpN: cp.n,
              agentSessionId: cp.agent_session_id ?? null,
            });
          }
        }
      }
      if (openConflicts.length > 0) {
        const detail = openConflicts
          .map(
            (c) =>
              `step_id "${c.stepId}" declared by open cp #${c.cpN}` +
              (c.agentSessionId ? ` (${c.agentSessionId})` : '')
          )
          .join('; ');
        await recordAndThrow(
          new PlanRevisionOpenCpConflictError(
            `Cannot revise plan: ${detail}. Abandon the conflicting checkpoint, or close it ` +
              `without including the affected step in completed_step_ids, then revise and ` +
              `reopen work against the new plan.`,
            input.artifact_id,
            openConflicts
          )
        );
      }

      // GATE 6: closed-cp completion-loss requires acknowledgement.
      const closedCps = this.store.getClosedCheckpoints(input.artifact_id);
      const completedClaims = new Map<string, number>(); // step_id → cp.n
      for (const cp of closedCps) {
        for (const stepId of cp.completed_step_ids) {
          if (!completedClaims.has(stepId)) completedClaims.set(stepId, cp.n);
        }
      }
      const acknowledged = new Set(input.acknowledge_drops_completed_steps);
      const unacknowledged: Array<{ stepId: string; cpN: number }> = [];
      for (const stepId of dropped) {
        const cpN = completedClaims.get(stepId);
        if (cpN !== undefined && !acknowledged.has(stepId)) {
          unacknowledged.push({ stepId, cpN });
        }
      }
      if (unacknowledged.length > 0) {
        const detail = unacknowledged
          .map((u) => `"${u.stepId}" (claimed by closed cp #${u.cpN})`)
          .join(', ');
        await recordAndThrow(
          new UnacknowledgedDroppedCompletionsError(
            `Cannot revise plan: dropping step_id(s) ${detail} without explicit ` +
              `acknowledgement. Add each to \`acknowledge_drops_completed_steps\` to ` +
              `confirm the historic completion record will be retained as audit-only.`,
            input.artifact_id,
            unacknowledged
          )
        );
      }

      // GATE 6b: the meaning of active or completed work cannot be silently
      // replaced. Additions and rewrites create a new obligation, so they are
      // rejected. Criterion removal only narrows the current plan and remains
      // available through the existing audited acknowledgement.
      const openDeclaredStepIds = new Set<string>();
      for (const cp of openCps) {
        for (const sid of cp.declared_step_ids) openDeclaredStepIds.add(sid);
      }
      const protectedStepIds = new Set([...openDeclaredStepIds, ...completedClaims.keys()]);
      const criterionStepById = new Map<string, string>();
      for (const step of newSteps) {
        for (const criterion of step.acceptance_criteria) {
          criterionStepById.set(criterion.criterion_id, step.step_id);
        }
      }
      const protectedAdditions = mintedCriterionIds
        .map((criterionId) => ({ criterionId, stepId: criterionStepById.get(criterionId) }))
        .filter(
          (entry): entry is { criterionId: string; stepId: string } =>
            entry.stepId !== undefined && protectedStepIds.has(entry.stepId)
        );
      const protectedCriterionRewrites = criterionRewritten.filter((entry) =>
        protectedStepIds.has(entry.prior_step_id)
      );
      const protectedStepRewrites = rewritten.filter((entry) =>
        protectedStepIds.has(entry.step_id)
      );
      if (
        protectedAdditions.length > 0 ||
        protectedCriterionRewrites.length > 0 ||
        protectedStepRewrites.length > 0
      ) {
        const changes = [
          ...protectedAdditions.map(
            (entry) => `criterion ${entry.criterionId} added to step ${entry.stepId}`
          ),
          ...protectedCriterionRewrites.map(
            (entry) => `criterion ${entry.criterion_id} rewritten on step ${entry.prior_step_id}`
          ),
          ...protectedStepRewrites.map((entry) => `step ${entry.step_id} text rewritten`),
        ].join('; ');
        await recordAndThrow(
          new PlanRevisionInputInvalidError(
            `Cannot revise protected step meaning: ${changes}. For an open checkpoint, close ` +
              `without including the affected step in completed_step_ids, or abandon it; then ` +
              `revise and reopen. For a completed step, preserve its historical meaning and ` +
              `create a new plan step for the new obligation. Label-only edits remain allowed.`,
            input.artifact_id
          )
        );
      }

      const ackedCriteria = new Set(input.acknowledge_criteria_changes ?? []);
      const unackedCriteria: Array<{
        criterionId: string;
        stepId: string;
        kind: 'removed';
      }> = [];
      for (const r of criterionRemoved) {
        if (
          newIdSet.has(r.prior_step_id) &&
          protectedStepIds.has(r.prior_step_id) &&
          !ackedCriteria.has(r.criterion_id)
        ) {
          unackedCriteria.push({
            criterionId: r.criterion_id,
            stepId: r.prior_step_id,
            kind: 'removed',
          });
        }
      }
      if (unackedCriteria.length > 0) {
        const detail = unackedCriteria
          .map((u) => `"${u.criterionId}" (${u.kind} on step ${u.stepId})`)
          .join(', ');
        await recordAndThrow(
          new UnacknowledgedCriteriaChangesError(
            `Cannot revise plan: acceptance criterion removal(s) ${detail} on an open or ` +
              `completed step without explicit acknowledgement. Add each criterion_id to ` +
              `\`acknowledge_criteria_changes\` to preserve the narrowing as an audited choice.`,
            input.artifact_id,
            unackedCriteria
          )
        );
      }

      // Build the new Plan and emit plan_revised. Defense-in-depth:
      // PlanSchema.parse validates the shape one last time before
      // append.
      const revisedAt = new Date().toISOString();
      const newRevisionN = priorPlan.revision_n + 1;
      const newPlanCandidate: PlanInput = {
        schema_version: 4,
        artifact_id: input.artifact_id,
        branch: priorPlan.branch,
        base_sha: priorPlan.base_sha,
        agent: priorPlan.agent,
        agent_session_id:
          input.agent_session_id === undefined
            ? priorPlan.agent_session_id
            : input.agent_session_id,
        task: priorPlan.task,
        label: input.label,
        plan_steps: newSteps,
        touched_scope: input.touched_scope,
        non_goals: input.non_goals,
        // Append-only / cumulate-at-write: keep every prior decision (each
        // retains the revision_n it was made at) and stamp the new ones with
        // this revision. The latest plan thus holds the full cumulative set,
        // so the latest-wins plan rebuilder needs no special-casing.
        decisions: [
          ...priorPlan.decisions,
          // `?? []` guards direct callers (storage tests) that pass a partial
          // input; the CLI always parses, so decisions is defaulted there.
          ...(input.decisions ?? []).map((d) => ({ ...d, revision_n: newRevisionN })),
        ],
        started_at: priorPlan.started_at,
        revision_n: newRevisionN,
        revised_at: revisedAt,
        // Runtime-resolved invoking agent for THIS revision (options, not
        // input — provenance is not payload-spoofable). Null for
        // storage-direct callers; never carried from the prior revision.
        revised_by_agent: opts.invokedByAgent ?? null,
        rationale: input.rationale,
        step_lineage: stepLineage,
        criterion_lineage: criterionLineage,
        prior_plan_event_id: priorEventId,
        ...(priorPlan.origin !== undefined ? { origin: priorPlan.origin } : {}),
      };
      const newPlan = PlanInputSchema.parse(newPlanCandidate);

      const eventPayload = newPlan;
      // Persist the acknowledgement on the event so the audit trail
      // reflects the explicit choice. (PlanSchema doesn't carry it
      // because the field is input-only; it lives on the event
      // payload, not the authoring plan.)
      const eventPayloadWithAck = {
        ...eventPayload,
        acknowledge_drops_completed_steps: [...input.acknowledge_drops_completed_steps].sort(),
        acknowledge_criteria_changes: [...(input.acknowledge_criteria_changes ?? [])].sort(),
        // `criterion_lineage` (incl. `added` = the minted ids the idempotency
        // extract nulls) rides `eventPayload` as part of the plan — it is
        // a PlanSchema field, not an event-only sibling.
      };
      const event = await this.appendAndMirror(
        {
          type: 'plan_revised',
          ts: revisedAt,
          idempotency_key: opts.idempotencyKey,
          payload: eventPayloadWithAck,
        },
        paths
      );

      const updatedEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuiltPlan = rebuildPlanFromEvents(updatedEvents);
      if (!rebuiltPlan) {
        throw new Error(
          `event-first revisePlan invariant: rebuilder returned null right after ` +
            `appending plan_revised event ${event.event_id}.`
        );
      }
      const rebuiltArtifact = rebuildArtifactJsonFromEvents(updatedEvents);
      if (!rebuiltArtifact) {
        throw new Error(
          `event-first revisePlan invariant: artifact.json rebuilder returned null ` +
            `(event_id=${event.event_id}).`
        );
      }

      await atomicWriteFile(
        paths.planJson,
        JSON.stringify(rebuiltPlan.plan, null, 2) + '\n',
        this.repoRoot
      );
      await atomicWriteFile(paths.planMd, planMarkdown(rebuiltPlan.plan), this.repoRoot);
      await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);

      // Mirror updated non_goals + label into the artifacts row
      // (denormalized "latest revision" projection).
      this.store.upsertArtifact({
        ...artifact,
        label: newPlan.label,
        non_goals: JSON.stringify(newPlan.non_goals),
      });
      this.store.upsertPlanRevision({
        plan: {
          artifact_id: input.artifact_id,
          revision_n: newRevisionN,
          captured_at: revisedAt,
          label: newPlan.label,
          rationale: newPlan.rationale,
          touched_scope: JSON.stringify(newPlan.touched_scope),
          non_goals: JSON.stringify(newPlan.non_goals),
          decisions: JSON.stringify(newPlan.decisions),
          step_lineage: JSON.stringify(stepLineage),
          criterion_lineage: JSON.stringify(criterionLineage),
          prior_event_id: priorEventId,
          source_event_id: event.event_id,
        },
        steps: newSteps.map((s, idx) => ({
          step_id: s.step_id,
          idx,
          text: s.text,
          label: s.label,
          acceptance_criteria: JSON.stringify(s.acceptance_criteria),
        })),
      });
      const searchContent = buildPlanSearchContent({
        label: newPlan.label,
        task: newPlan.task,
        plan_steps: newSteps,
        non_goals: newPlan.non_goals,
        decisions: newPlan.decisions,
      });
      this.store.replaceSearchEntry({
        artifact_id: input.artifact_id,
        source: `plan:${newRevisionN}`,
        branch: newPlan.branch,
        ts: revisedAt,
        content: searchContent,
      });

      // Clear any prior hard_rejected idempotency record for this key
      // (hard_rejected → committed upgrade path).
      await withNonDerivableWriteLease(this.repoRoot, () =>
        clearIdempotencyBlock({
          store: this.store,
          artifactId: input.artifact_id,
          idempotencyKey: opts.idempotencyKey,
          type: 'plan_revised',
        })
      );

      return {
        outcome: 'created' as const,
        plan: rebuiltPlan.plan,
        priorEventId: event.event_id,
      };
    });
  }

  // ────────────────────────────────────────
  // Checkpoint OPEN
  // ────────────────────────────────────────

  async writeCheckpointOpened(
    input: CheckpointOpenInput,
    opts: CheckpointOpenWriteOptions
  ): Promise<CheckpointOpenWriteResult> {
    const artifact = this.store.getArtifact(input.artifact_id);
    if (!artifact) {
      throw new Error(
        `Cannot open checkpoint for unknown artifact_id "${input.artifact_id}". ` +
          'Call writePlan first.'
      );
    }
    const paths = artifactPathsFor(this.repoRoot, this.config, input.artifact_id);

    return this.withWriteLock(input.artifact_id, async () => {
      const events = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const openReplayShape = opts.replayPayload ?? {
        artifact_id: input.artifact_id,
        declared_step_ids: [...input.declared_step_ids],
        agent_session_id: input.agent_session_id ?? null,
        policy_exceptions: input.policy_exceptions ?? [],
        plan_revision_id: input.plan_revision_id ?? null,
      };
      const openExtractShape =
        opts.extractReplayShape ??
        ((priorPayload: unknown) => {
          if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
          const p = priorPayload as Record<string, unknown>;
          return {
            artifact_id: p.artifact_id,
            declared_step_ids: p.declared_step_ids,
            agent_session_id: p.agent_session_id ?? null,
            policy_exceptions: p.policy_exceptions ?? [],
            plan_revision_id: p.plan_revision_id ?? null,
          };
        });

      // STAGE 1: Committed-event lookup. No evaluator dependency —
      // a previously committed open is replayable even if the
      // registry has drifted, been deleted, or gone misconfigured.
      const committed = await findCommittedReplay({
        events: events.map((e) => e.record),
        type: 'checkpoint_opened',
        idempotencyKey: opts.idempotencyKey,
        payload: openReplayShape,
        loadPriorPayload: (priorEvent) =>
          normalizePriorPayload(priorEvent, events, openExtractShape),
      });
      if (committed.kind === 'replay-committed') {
        const ev = events.find((e) => e.record.event_id === committed.priorEventId);
        if (ev) {
          const p = ev.payload as {
            n: number;
            declared_step_ids: string[];
            agent_session_id?: string;
            agent: CaptureAgentId;
            policy_exceptions: PolicyException[];
            plan_revision_id: string | null;
            open_plan_revision_event_id: string;
            opened_at: string;
            head_sha: string;
            open_snapshot: CheckpointSnapshotBoundary;
          };
          // Same requirements, same parse, as `rebuildCheckpointFromEvents`:
          // an event log that replays here must project there too, so no key
          // gets a forward-default on this path. An incomplete payload (a v3
          // event with no open_snapshot, say) fails with the exact field path.
          const open: OpenCheckpoint = OpenCheckpointSchema.parse({
            schema_version: 4,
            status: 'open',
            artifact_id: input.artifact_id,
            n: p.n,
            declared_step_ids: [...p.declared_step_ids],
            agent_session_id: p.agent_session_id,
            agent: p.agent,
            policy_exceptions: p.policy_exceptions,
            plan_revision_id: p.plan_revision_id,
            open_plan_revision_event_id: p.open_plan_revision_event_id,
            opened_at: p.opened_at,
            head_sha: p.head_sha,
            open_snapshot: p.open_snapshot,
            source_event_id: ev.record.event_id,
          });
          await this.repairCheckpointProjection(paths, events, artifact, p.n);
          return {
            outcome: 'replay' as const,
            checkpoint: open,
            priorEventId: committed.priorEventId,
          };
        }
      }
      if (committed.kind === 'conflict') {
        return { outcome: 'conflict' as const };
      }

      // STAGE 2: Build evaluator context lazily. This is where
      // `loadEvaluators` actually runs, where misconfigured
      // checkpoint-open evaluators fail loudly, and where the
      // fingerprint is computed for soft_blocked replay matching.
      // Storage-direct callers (tests) may omit it; in that case we
      // skip stage-2 lookup, skip policy validation, and skip
      // dry-run (no soft_blocked records ever written).
      const evalCtx =
        opts.evaluatorContext !== undefined ? await opts.evaluatorContext() : undefined;

      // STAGE 3: idempotency_blocks lookup — soft_blocked / hard_rejected.
      const blocked = await findBlockedReplay({
        store: this.store,
        artifactId: input.artifact_id,
        type: 'checkpoint_opened',
        idempotencyKey: opts.idempotencyKey,
        payload: openReplayShape,
        currentFingerprint: evalCtx?.fingerprint,
      });
      if (blocked.kind === 'replay-soft-blocked') {
        return {
          outcome: 'blocked' as const,
          envelope: blocked.envelope,
          idempotencyOutcome: 'replay' as const,
        };
      }
      if (blocked.kind === 'conflict') {
        return { outcome: 'conflict' as const };
      }
      // first-call OR reevaluate — proceed to validation + dry-run.

      // STAGE 4: Policy-exception opt-in validation. Runs after
      // idempotency lookup so a bad opt-in is recorded as
      // hard_rejected (and a same-key/different-payload retry can
      // be detected as a conflict).
      if (evalCtx !== undefined) {
        try {
          evalCtx.validatePolicyExceptions();
        } catch (err) {
          await withNonDerivableWriteLease(this.repoRoot, () =>
            recordHardRejected({
              store: this.store,
              artifactId: input.artifact_id,
              idempotencyKey: opts.idempotencyKey,
              type: 'checkpoint_opened',
              payload: openReplayShape,
            })
          );
          throw err;
        }
      }

      // 2. Defense-in-depth validation of declared_step_ids.
      // The CLI also runs these checks for friendlier error messages,
      // but storage owns the invariant so non-CLI callers can't bypass.
      if (input.declared_step_ids.length === 0) {
        await withNonDerivableWriteLease(this.repoRoot, () =>
          recordHardRejected({
            store: this.store,
            artifactId: input.artifact_id,
            idempotencyKey: opts.idempotencyKey,
            type: 'checkpoint_opened',
            payload: openReplayShape,
          })
        );
        throw new DeclaredStepsInvalidError(
          input.artifact_id,
          'declared_step_ids must be non-empty.',
          input.declared_step_ids
        );
      }
      const latestPlan = rebuildPlanFromEvents(events);
      if (!latestPlan) {
        await withNonDerivableWriteLease(this.repoRoot, () =>
          recordHardRejected({
            store: this.store,
            artifactId: input.artifact_id,
            idempotencyKey: opts.idempotencyKey,
            type: 'checkpoint_opened',
            payload: openReplayShape,
          })
        );
        throw new Error(
          `writeCheckpointOpened invariant: artifact "${input.artifact_id}" has no plan ` +
            `but getArtifact returned non-null. Capture-flow ordering bug.`
        );
      }
      const planStepIds = new Set(latestPlan.plan.plan_steps.map((s) => s.step_id));
      const seenSteps = new Set<string>();
      for (const stepId of input.declared_step_ids) {
        if (!planStepIds.has(stepId)) {
          await withNonDerivableWriteLease(this.repoRoot, () =>
            recordHardRejected({
              store: this.store,
              artifactId: input.artifact_id,
              idempotencyKey: opts.idempotencyKey,
              type: 'checkpoint_opened',
              payload: openReplayShape,
            })
          );
          throw new DeclaredStepsInvalidError(
            input.artifact_id,
            `declared_step_ids contains "${stepId}", which is not present in the latest ` +
              `plan revision (revision_n=${latestPlan.plan.revision_n}).`,
            input.declared_step_ids
          );
        }
        if (seenSteps.has(stepId)) {
          await withNonDerivableWriteLease(this.repoRoot, () =>
            recordHardRejected({
              store: this.store,
              artifactId: input.artifact_id,
              idempotencyKey: opts.idempotencyKey,
              type: 'checkpoint_opened',
              payload: openReplayShape,
            })
          );
          throw new DeclaredStepsInvalidError(
            input.artifact_id,
            `declared_step_ids contains duplicate "${stepId}"; each step_id can be ` +
              `declared at most once per cp.`,
            input.declared_step_ids
          );
        }
        seenSteps.add(stepId);
      }

      // 2.5. Optimistic-concurrency token (STALE_PLAN_REVISION).
      // Skip when the agent passes null — that's the explicit
      // race-tolerance opt-out.
      if (
        input.plan_revision_id !== undefined &&
        input.plan_revision_id !== null &&
        input.plan_revision_id !== latestPlan.sourceEventId
      ) {
        await withNonDerivableWriteLease(this.repoRoot, () =>
          recordHardRejected({
            store: this.store,
            artifactId: input.artifact_id,
            idempotencyKey: opts.idempotencyKey,
            type: 'checkpoint_opened',
            payload: openReplayShape,
          })
        );
        throw new StalePlanRevisionError(
          `plan_revision_id="${input.plan_revision_id}" is not the latest plan event ` +
            `for artifact "${input.artifact_id}" (latest is ${latestPlan.sourceEventId}, ` +
            `revision_n=${latestPlan.plan.revision_n}). Re-read the resume / status ` +
            `surface and retry with the fresh token, or pass null to skip the check.`,
          input.artifact_id,
          input.plan_revision_id,
          latestPlan.sourceEventId,
          latestPlan.plan.revision_n
        );
      }

      // 3. Disjointness against currently-open and closed cps.
      const claims = this.store.getStepClaims(input.artifact_id);
      const closedClaimedSet = new Set(claims.closedClaimed);
      const conflicts: Array<{
        stepId: string;
        heldBy:
          | { kind: 'open'; n: number; agent_session_id?: string }
          | { kind: 'closed'; n: number };
      }> = [];
      for (const stepId of input.declared_step_ids) {
        if (closedClaimedSet.has(stepId)) {
          const closed = this.store.getClosedCheckpoints(input.artifact_id);
          const holder = closed.find((c) => c.completed_step_ids.includes(stepId));
          conflicts.push({
            stepId,
            heldBy: { kind: 'closed', n: holder?.n ?? -1 },
          });
          continue;
        }
        for (const open of claims.openDeclared) {
          if (open.declared.includes(stepId)) {
            const openRow = this.store
              .getOpenCheckpoints(input.artifact_id)
              .find((r) => r.n === open.n);
            const heldBy: { kind: 'open'; n: number; agent_session_id?: string } = {
              kind: 'open',
              n: open.n,
            };
            if (openRow?.agent_session_id) heldBy.agent_session_id = openRow.agent_session_id;
            conflicts.push({ stepId, heldBy });
            break;
          }
        }
      }
      if (conflicts.length > 0) {
        // Hard rejection: invariant violation. Record so a same-key
        // retry with the same payload re-evaluates (the conflicting cp
        // may be abandoned in the meantime, clearing the overlap).
        await withNonDerivableWriteLease(this.repoRoot, () =>
          recordHardRejected({
            store: this.store,
            artifactId: input.artifact_id,
            idempotencyKey: opts.idempotencyKey,
            type: 'checkpoint_opened',
            payload: openReplayShape,
          })
        );
        const detail = conflicts
          .map((c) =>
            c.heldBy.kind === 'open'
              ? `step_id "${c.stepId}" declared by open cp #${c.heldBy.n}` +
                (c.heldBy.agent_session_id ? ` (${c.heldBy.agent_session_id})` : '')
              : `step_id "${c.stepId}" already claimed by closed cp #${c.heldBy.n}`
          )
          .join('; ');
        throw new OpenCheckpointOverlapError(
          `OPEN_CP_OVERLAP: ${detail}. Choose a non-overlapping declared scope ` +
            `or revise the plan to split the step.`,
          input.artifact_id,
          conflicts
        );
      }

      // 3. Server-assigned n + opened_at + head_sha. CLI passes HEAD
      // via opts.headSha (required) — no fallback to plan.base_sha.
      const n = this.store.nextCheckpointN(input.artifact_id);
      const openedAt = z
        .string()
        .datetime()
        .parse(opts.openedAt ?? new Date().toISOString());
      const headSha = opts.headSha;

      // 4. Pre-append callback (CLI runs evaluator dry-run here).
      let gateAudit: unknown | undefined;
      if (evalCtx !== undefined) {
        const proposedOpen: ProposedOpenCheckpoint = {
          schema_version: 4,
          status: 'open',
          artifact_id: input.artifact_id,
          n,
          declared_step_ids: [...input.declared_step_ids],
          agent: opts.invokedByAgent ?? 'other',
          agent_session_id: input.agent_session_id,
          policy_exceptions: input.policy_exceptions ?? [],
          plan_revision_id: input.plan_revision_id ?? null,
          // Server-derived open-time revision. latestPlan was
          // resolved above for declared-step validation; its sourceEventId is
          // the authoritative revision this cp opens against.
          open_plan_revision_event_id: latestPlan.sourceEventId,
          opened_at: openedAt,
          head_sha: headSha,
          // Placeholder for the v4 evaluator dry-run. The real
          // open_snapshot from the snapshot callback
          // replaces this on the actual event payload at append time;
          // the dry-run sees only the deliberate-skip default.
          open_snapshot: buildDefaultSkippedSnapshotBoundary(),
        };
        const preResult = await evalCtx.preAppend(proposedOpen);
        if (!preResult.ok) {
          await withNonDerivableWriteLease(this.repoRoot, () =>
            recordSoftBlocked({
              store: this.store,
              artifactId: input.artifact_id,
              idempotencyKey: opts.idempotencyKey,
              type: 'checkpoint_opened',
              payload: openReplayShape,
              envelope: preResult.envelope,
              evaluatorFingerprint: evalCtx.fingerprint,
            })
          );
          return {
            outcome: 'blocked' as const,
            envelope: preResult.envelope,
            idempotencyOutcome: 'created' as const,
          };
        }
        if (preResult.gate_audit !== undefined) {
          gateAudit = preResult.gate_audit;
        }
      }

      // 5. Append checkpoint_opened event. The optional gate_audit is
      // embedded so the projection rebuilder can unfold runs[] +
      // dispositions[]. Absent on opens that didn't
      // run any checkpoint-open evaluators (e.g., storage-direct test
      // callers or empty packs).
      //
      // v4: open_snapshot is REQUIRED on the event payload. Storage's
      // fail-open contract distinguishes three cases:
      //   * absent callback → deliberate-skip boundary (snapshot_error_reason: null)
      //   * callback threw → 'unknown' boundary (defense-in-depth; the
      //     callback contract says it must not throw)
      //   * callback succeeded → use the returned boundary unchanged
      let openSnapshot: CheckpointSnapshotBoundary;
      let openUnmergedPaths: readonly string[] = [];
      let openUnmergedProbeFailed = false;
      if (opts.snapshotCallbacks?.captureOpenSnapshot) {
        try {
          const result = await opts.snapshotCallbacks.captureOpenSnapshot({
            artifact_id: input.artifact_id,
            n,
          });
          openSnapshot = result.boundary;
          openUnmergedPaths = result.unmerged_paths ?? [];
          openUnmergedProbeFailed = result.unmerged_probe_failed === true;
        } catch {
          openSnapshot = {
            snapshot_ref: null,
            tree_sha: null,
            snapshot_commit_sha: null,
            snapshot_error_reason: 'unknown',
          };
        }
      } else {
        openSnapshot = buildDefaultSkippedSnapshotBoundary();
      }
      const eventPayload: Record<string, unknown> = {
        artifact_id: input.artifact_id,
        n,
        declared_step_ids: [...input.declared_step_ids],
        agent_session_id: input.agent_session_id,
        agent: opts.invokedByAgent ?? 'other',
        policy_exceptions: input.policy_exceptions ?? [],
        plan_revision_id: input.plan_revision_id ?? null,
        open_plan_revision_event_id: latestPlan.sourceEventId,
        opened_at: openedAt,
        head_sha: headSha,
        open_snapshot: openSnapshot,
      };
      if (gateAudit !== undefined) {
        eventPayload.gate_audit = gateAudit;
      }
      // The gate_audit precedent: payload-only, read back raw at close.
      if (openUnmergedPaths.length > 0) {
        eventPayload.open_unmerged_paths = [...openUnmergedPaths];
      }
      if (openUnmergedProbeFailed) {
        eventPayload.open_unmerged_probe_failed = true;
      }
      const event = await this.appendAndMirror(
        {
          type: 'checkpoint_opened',
          ts: openedAt,
          idempotency_key: opts.idempotencyKey,
          payload: eventPayload,
        },
        paths
      );

      // 6. Re-read + rebuild.
      const updatedEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuilt = rebuildCheckpointFromEvents(updatedEvents, n);
      if (!rebuilt || rebuilt.checkpoint.status !== 'open') {
        throw new Error(
          `event-first writeCheckpointOpened invariant: rebuild produced no open cp at n=${n}`
        );
      }
      const rebuiltArtifact = rebuildArtifactJsonFromEvents(updatedEvents);
      if (!rebuiltArtifact) {
        throw new Error(
          `event-first writeCheckpointOpened invariant: artifact.json rebuilder returned null`
        );
      }

      // 7. Write projections.
      await atomicWriteFile(
        paths.checkpointJson(n),
        JSON.stringify(rebuilt.checkpoint, null, 2) + '\n',
        this.repoRoot
      );
      await atomicWriteFile(
        paths.checkpointMd(n),
        checkpointMarkdown(rebuilt.checkpoint),
        this.repoRoot
      );
      await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);

      // 8. SQLite indexes.
      this.store.upsertCheckpoint(checkpointToRow(rebuilt.checkpoint));

      // 9. Clear any prior soft_blocked / hard_rejected idempotency
      // record for this key — the committed event supersedes it
      // (hard_rejected → committed upgrade path).
      await withNonDerivableWriteLease(this.repoRoot, () =>
        clearIdempotencyBlock({
          store: this.store,
          artifactId: input.artifact_id,
          idempotencyKey: opts.idempotencyKey,
          type: 'checkpoint_opened',
        })
      );

      void event; // event_id retained on the projection's source_event_id
      return { outcome: 'created' as const, checkpoint: rebuilt.checkpoint };
    });
  }

  // ────────────────────────────────────────
  // Checkpoint CLOSE
  // ────────────────────────────────────────

  async writeCheckpointClosed(
    input: CheckpointCloseInput,
    opts: CheckpointCloseWriteOptions
  ): Promise<CheckpointCloseWriteResult> {
    const artifact = this.store.getArtifact(input.artifact_id);
    if (!artifact) {
      throw new Error(`Cannot close checkpoint for unknown artifact_id "${input.artifact_id}".`);
    }
    const paths = artifactPathsFor(this.repoRoot, this.config, input.artifact_id);

    return this.withWriteLock(input.artifact_id, async () => {
      const events = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );

      // Three-outcome idempotency lookup. close has no
      // evaluator-gated logic, so currentFingerprint is undefined —
      // any soft_blocked record (shouldn't exist for this type) is
      // treated as stale. hard_rejected records re-evaluate; on
      // success the record is cleared.
      //
      // Default replay shape strips runtime-derived fields
      // (`head_sha`, `ts`) so callers that don't supply
      // `replayPayload`/`extractReplayShape` still get correct
      // replay semantics. The persisted close event includes those
      // fields; the default extractor strips them on the prior side
      // so canonicalJson hashes match.
      // `verification` is conditionally included on BOTH sides of the
      // replay hash (payload spread + extractor spread) so a pre-upgrade
      // close retried by a newer CLI (no verification) still replays
      // instead of IDEMPOTENCY_CONFLICT — symmetric key-absence is the
      // optional-absent contract.
      const closeReplayPayload = opts.replayPayload ?? {
        artifact_id: input.artifact_id,
        n: input.n,
        summary: input.summary,
        files_changed: [...input.files_changed],
        decisions: input.decisions.map((d) => ({ ...d })),
        uncertainty: [...input.uncertainty],
        done_criteria: [...input.done_criteria],
        ...((input.verification ?? []).length > 0
          ? { verification: (input.verification ?? []).map((v) => ({ ...v })) }
          : {}),
        completed_step_ids: [...input.completed_step_ids],
      };
      const closeExtractShape =
        opts.extractReplayShape ??
        ((priorPayload: unknown) => {
          if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
          const p = priorPayload as Record<string, unknown>;
          return {
            artifact_id: p.artifact_id,
            n: p.n,
            summary: p.summary,
            files_changed: p.files_changed,
            decisions: p.decisions,
            uncertainty: p.uncertainty,
            done_criteria: p.done_criteria,
            ...(p.verification !== undefined ? { verification: p.verification } : {}),
            completed_step_ids: p.completed_step_ids,
          };
        });
      const lookup = await findThreeOutcomeIdempotency({
        store: this.store,
        events: events.map((e) => e.record),
        artifactId: input.artifact_id,
        type: 'checkpoint_closed',
        idempotencyKey: opts.idempotencyKey,
        payload: closeReplayPayload,
        loadPriorPayload: (priorEvent) =>
          normalizePriorPayload(priorEvent, events, closeExtractShape),
      });
      if (lookup.kind === 'replay-committed') {
        const rebuilt = rebuildCheckpointFromEvents(events, input.n);
        if (rebuilt && rebuilt.checkpoint.status === 'closed') {
          // A close whose projection never landed leaves the cached status
          // reading `open`, and writeSummary's completion gate reads that
          // cache — so the artifact could never be summarized.
          await this.repairCheckpointProjection(paths, events, artifact, input.n);
          return {
            outcome: 'replay' as const,
            checkpoint: rebuilt.checkpoint,
            priorEventId: lookup.priorEventId,
          };
        }
      }
      if (lookup.kind === 'conflict') {
        return { outcome: 'conflict' as const };
      }
      // first-call OR reevaluate — proceed.

      // Helper for the hard_rejected → throw pattern. Records the
      // rejection so a same-key/same-payload retry re-evaluates and a
      // same-key/different-payload retry surfaces as IDEMPOTENCY_CONFLICT.
      const recordAndThrow = async (err: Error): Promise<never> => {
        await withNonDerivableWriteLease(this.repoRoot, () =>
          recordHardRejected({
            store: this.store,
            artifactId: input.artifact_id,
            idempotencyKey: opts.idempotencyKey,
            type: 'checkpoint_closed',
            payload: closeReplayPayload,
          })
        );
        throw err;
      };

      // 2. Confirm there is an open cp at n.
      const existing = rebuildCheckpointFromEvents(events, input.n);
      if (!existing) {
        await recordAndThrow(new CheckpointNotFoundError(input.artifact_id, input.n));
      }
      if (existing!.checkpoint.status !== 'open') {
        await recordAndThrow(
          new CheckpointNotOpenError(input.artifact_id, input.n, existing!.checkpoint.status)
        );
      }
      const open = existing!.checkpoint as OpenCheckpoint;

      // 3. Validate completed_step_ids — no-dups + subset of
      //    declared_step_ids. Step-id existence in the latest plan
      //    is implied by the open's declared set (which was checked
      //    against the latest plan at open time, and revisions
      //    cannot drop a declared step_id per the open-cp gate).
      const seenCompleted = new Set<string>();
      for (const stepId of input.completed_step_ids) {
        if (seenCompleted.has(stepId)) {
          await recordAndThrow(
            new CompletedStepsInvalidError(
              input.artifact_id,
              input.n,
              `completed_step_ids contains duplicate "${stepId}"; each step_id can be ` +
                `claimed at most once per cp.`,
              [...input.completed_step_ids]
            )
          );
        }
        seenCompleted.add(stepId);
      }
      const declared = new Set(open.declared_step_ids);
      for (const stepId of input.completed_step_ids) {
        if (!declared.has(stepId)) {
          await recordAndThrow(
            new CompletedNotInDeclaredError(input.artifact_id, input.n, stepId, [
              ...open.declared_step_ids,
            ])
          );
        }
      }

      // 3b. Validate done_criteria: each criterion_id must resolve to an
      //     acceptance criterion on a step in completed_step_ids — not
      //     merely "exists somewhere in the active plan". Evidence may
      //     only be attached to criteria of steps this cp actually claims,
      //     so a cp can't invent evidence for criteria it never delivered
      //     (the self-report gap the plan-time anchor exists to close).
      //
      //     Validate against the plan revision THIS cp opened
      //     against (`open_plan_revision_event_id`), not the latest. A later
      //     revise can remove/rewrite a criterion; grading close-time evidence
      //     against the latest revision would reject honest evidence for a
      //     since-removed criterion (and GATE 6b already gates such changes on
      //     open-cp steps). STRICT: an open revision that no longer resolves
      //     is cache corruption, not a degrade — fail loudly so close, why,
      //     and push all refuse on the same rule.
      // Resolution runs for EVERY close — an empty rubric must not bypass
      // the strict open-revision rule, or an unresolvable revision would
      // close cleanly here and fail only at push.
      const resolvedOpenRev = await this.resolveOpenRevisionPlanStrict(
        input.artifact_id,
        open.open_plan_revision_event_id
      );
      if (resolvedOpenRev.kind !== 'resolved') {
        throw new Error(
          `Checkpoint ${open.n} of artifact "${input.artifact_id}" opened against ` +
            `plan revision event "${open.open_plan_revision_event_id}", which is ` +
            `missing from the cache — run \`orcaops rebuild\` and retry.`
        );
      }
      const openRevPlan = resolvedOpenRev.plan;
      const completedSet = new Set(input.completed_step_ids);
      const criterionToStep = new Map<string, string>();
      const requiredCriterionIds: string[] = [];
      for (const ps of openRevPlan.plan_steps) {
        for (const c of ps.acceptance_criteria) {
          criterionToStep.set(c.criterion_id, ps.step_id);
          if (completedSet.has(ps.step_id)) requiredCriterionIds.push(c.criterion_id);
        }
      }
      if (input.done_criteria.length > 0) {
        for (const dc of input.done_criteria) {
          const stepId = criterionToStep.get(dc.criterion_id);
          if (stepId === undefined || !completedSet.has(stepId)) {
            await recordAndThrow(
              new DoneCriteriaInvalidError(
                input.artifact_id,
                input.n,
                `done_criteria criterion_id "${dc.criterion_id}" does not resolve to an ` +
                  `acceptance criterion on a completed step; evidence may only be attached ` +
                  `to criteria of steps in completed_step_ids.`
              )
            );
          }
        }
      }
      const citedCriterionIds = new Set(input.done_criteria.map((entry) => entry.criterion_id));
      const missingCriterionIds = requiredCriterionIds.filter((id) => !citedCriterionIds.has(id));
      if (missingCriterionIds.length > 0) {
        await recordAndThrow(
          new DoneCriteriaInvalidError(
            input.artifact_id,
            input.n,
            `done_criteria is missing evidence for opening-revision criterion_id(s): ` +
              `${missingCriterionIds.join(', ')}. Leave unfinished steps out of ` +
              `completed_step_ids, or cite evidence for every criterion before closing.`
          )
        );
      }
      if (
        completedSet.size > 0 &&
        openRevPlan.origin?.kind !== 'git-import' &&
        (input.verification ?? []).length === 0
      ) {
        await recordAndThrow(new VerificationRequiredError(input.artifact_id, input.n));
      }

      // 4. Append close event with the canonical close-time payload.
      // head_sha is required on the input; CLI resolves via
      // `ctx.repo.getHeadSha()` before calling. No fallback.
      //
      // v4 fail-open contract for snapshot/fingerprint capture:
      //   * absent callback → deliberate-skip boundary + summary
      //     (snapshot_error_reason: null, summary.error_reason: null)
      //   * callback threw → 'unknown' boundary + summary (defense-
      //     in-depth; the callback contract says it must not throw)
      //   * callback succeeded → use the returned values unchanged
      const closedAt = z
        .string()
        .datetime()
        .parse(opts.closedAt ?? new Date().toISOString());
      if (Date.parse(closedAt) < Date.parse(open.opened_at)) {
        throw new RangeError(
          `Checkpoint close timestamp ${closedAt} precedes its open timestamp ${open.opened_at}.`
        );
      }
      const headSha = input.head_sha;

      // Overlap detection, computed HERE under the lock.
      // Within-artifact overlap comes from the event-log interval scan
      // (index order, never timestamps); cross-artifact overlap is a
      // best-effort wall-clock scan over the repo-global SQLite store —
      // claims-only by design (timestamp ordering across logs is weaker
      // than index order). The current cp's open-event index is shared
      // with the hwm-baseline resolution below.
      const currentOpenIdx = events.findIndex(
        (e) => e.record.type === 'checkpoint_opened' && (e.payload as { n?: number }).n === input.n
      );
      const overlapCtx =
        currentOpenIdx === -1 ? null : detectWindowOverlap(events, input.n, currentOpenIdx);
      const crossArtifactSiblings = opts.skipWallClockOverlapScan
        ? []
        : this.store
            .findWallClockOverlappingCheckpoints({
              excludeArtifactId: input.artifact_id,
              windowStart: open.opened_at,
              windowEnd: closedAt,
            })
            .map((r) => ({ artifact_id: r.artifact_id, n: r.n }));

      // Read raw off the open event payload — the baseline_seed_tree_sha
      // precedent; these keys are deliberately absent from the projection.
      const openEventPayloadRaw =
        currentOpenIdx === -1
          ? undefined
          : (events[currentOpenIdx].payload as {
              open_unmerged_paths?: unknown;
              open_unmerged_probe_failed?: unknown;
            });
      const openUnmergedPaths: readonly string[] =
        Array.isArray(openEventPayloadRaw?.open_unmerged_paths) &&
        openEventPayloadRaw.open_unmerged_paths.every((p): p is string => typeof p === 'string')
          ? openEventPayloadRaw.open_unmerged_paths
          : [];
      const openUnmergedProbeFailed = openEventPayloadRaw?.open_unmerged_probe_failed === true;

      let closeSnapshot: CheckpointSnapshotBoundary;
      let fingerprintSummary: DiffFingerprintSummary;
      let fingerprintManifest: DiffFingerprintManifest | null;
      let segmentEvidence: PartitionSegment[] | undefined;
      let closeUnmergedPaths: readonly string[] = [];
      let closeUnmergedProbeFailed = false;
      if (opts.snapshotCallbacks?.captureCloseFingerprint) {
        // Resolve the empty-fence recovery baseline from the in-lock event
        // log (computed HERE under the lock — never re-read in the CLI, which
        // would race). The current cp's close event is not appended yet, so
        // getHwmBaseline treats currentCloseIdx = events.length; currentOpenIdx
        // is this cp's open-event index. The seed is read off the rebuilt
        // artifact.json projection — the SQLite ArtifactRow has no such column.
        // Read the plan-time seed directly off the plan_captured event
        // (set-once, immutable — mirrors the typed read in rebuilders.ts) rather
        // than rebuilding the whole artifact.json projection here. The rebuild is
        // a second full event scan on every close (on top of getHwmBaseline's),
        // and only this one field is needed.
        const planCaptured = events.find((e) => e.record.type === 'plan_captured');
        const planPayload = planCaptured?.payload as
          | { baseline_seed_tree_sha?: unknown; baseline_unmerged_paths?: unknown }
          | undefined;
        // Blocking the SEED branch only: a mid-conflict baseline carries
        // marker bytes no boundary-time union can filter (the conflict may
        // have resolved before this cp even opened). The HWM branch stays
        // usable — its baseline is a prior cp's terminal tree, whose own
        // close-side set was recorded.
        const baselineWasConflicted =
          Array.isArray(planPayload?.baseline_unmerged_paths) &&
          planPayload.baseline_unmerged_paths.length > 0;
        const seedBaselineTreeSha =
          !baselineWasConflicted && typeof planPayload?.baseline_seed_tree_sha === 'string'
            ? planPayload.baseline_seed_tree_sha
            : null;
        // `open` is pre-validated above, so its checkpoint_opened event is
        // always present — but guard defensively. A -1 index would feed
        // getHwmBaseline a bogus interval boundary (this cp's [open, close) window
        // would appear to start before every other interval), silently mis-scoping
        // the overlap concurrency guard. A missing open event means we cannot
        // resolve a trustworthy baseline → block recovery (fall back to the empty
        // summary); never guess off a -1 index.
        const hwm =
          currentOpenIdx === -1
            ? { hwmBaselineTreeSha: null, recoveryBlocked: true }
            : getHwmBaseline(events, input.n, currentOpenIdx);
        const recoveryCtx = {
          hwmBaselineTreeSha: hwm.hwmBaselineTreeSha,
          seedBaselineTreeSha,
          recoveryBlocked: hwm.recoveryBlocked,
          filesChanged: input.files_changed,
        };
        try {
          const result = await opts.snapshotCallbacks.captureCloseFingerprint({
            openCheckpoint: open,
            closeContext: { artifact_id: input.artifact_id, n: input.n },
            recovery: recoveryCtx,
            ...(overlapCtx !== null
              ? {
                  overlap: {
                    currentCloseIdx: overlapCtx.currentCloseIdx,
                    boundaries: overlapCtx.boundaries,
                  },
                }
              : {}),
          });
          closeSnapshot = result.boundary;
          fingerprintSummary = result.summary;
          fingerprintManifest = result.manifest;
          segmentEvidence = result.segment_evidence;
          closeUnmergedPaths = result.unmerged_paths ?? [];
          closeUnmergedProbeFailed = result.unmerged_probe_failed === true;
        } catch {
          closeSnapshot = {
            snapshot_ref: null,
            tree_sha: null,
            snapshot_commit_sha: null,
            snapshot_error_reason: 'unknown',
          };
          fingerprintSummary = {
            ...buildDefaultSkippedFingerprintSummary(),
            error_reason: 'unknown',
          };
          fingerprintManifest = null;
        }
      } else {
        closeSnapshot = buildDefaultSkippedSnapshotBoundary();
        fingerprintSummary = buildDefaultSkippedFingerprintSummary();
        fingerprintManifest = null;
      }

      // Apply the pure claims partition to the callback's
      // evidence. The partition recomputes the {manifest, summary} pair
      // consistently when it removes hunks — persisting a filtered
      // manifest under the unfiltered summary would persist a lie and
      // break the derive verifier. Non-overlap closes skip this block
      // entirely: payload and hashes stay byte-identical to a close with
      // no overlap.
      // Degraded union: paths unmerged at EITHER boundary. Computed before
      // the partition (which keeps them out of its positive-attribution
      // sets) but their hunks are filtered AFTER it — pre-filtering would
      // make the partition's own-claim inManifest check misclassify an
      // honestly-claimed conflicted path as a rejected claim.
      const unmergedUnion = [...new Set([...openUnmergedPaths, ...closeUnmergedPaths])].sort();
      // A failed probe at EITHER boundary marks the whole window unverified:
      // the empty exclusion set must never read as verified-clean.
      const unmergedProbeFailed = openUnmergedProbeFailed || closeUnmergedProbeFailed;

      let windowOverlapRecord: WindowOverlap | undefined;
      if (overlapCtx !== null || crossArtifactSiblings.length > 0) {
        const partition = await applyClaimsPartition({
          currentN: input.n,
          ownClaim: input.files_changed,
          manifest: fingerprintManifest,
          summary: fingerprintSummary,
          siblings: overlapCtx?.siblings ?? [],
          segments: segmentEvidence ?? [],
          crossArtifactSiblings,
          extraDegradations:
            overlapCtx !== null &&
            segmentEvidence === undefined &&
            crossArtifactSiblings.length === 0
              ? ['segment_evidence_unavailable']
              : [],
          unmergedPaths: unmergedUnion,
        });
        fingerprintManifest = partition.manifest;
        fingerprintSummary = partition.summary;
        windowOverlapRecord = partition.windowOverlap;
      }

      // Unmerged-path exclusion: one store-side choke point AFTER the
      // partition, so it covers the normal manifest, the recovered
      // manifest, and the partition output alike. The {manifest, summary}
      // pair is recomputed together; no-match unions pass through
      // byte-identical.
      if (unmergedUnion.length > 0 && fingerprintManifest !== null) {
        const excluded = await applyUnmergedExclusion(
          fingerprintManifest,
          fingerprintSummary,
          unmergedUnion
        );
        fingerprintManifest = excluded.manifest;
        fingerprintSummary = excluded.summary;
      }

      const eventPayload: Record<string, unknown> = {
        artifact_id: input.artifact_id,
        n: input.n,
        summary: input.summary,
        files_changed: [...input.files_changed],
        decisions: input.decisions.map((d) => ({ ...d })),
        uncertainty: [...input.uncertainty],
        done_criteria: [...input.done_criteria],
        // Optional-absent: key omitted when nothing cited.
        ...((input.verification ?? []).length > 0
          ? { verification: (input.verification ?? []).map((v) => ({ ...v })) }
          : {}),
        // Optional-absent: key stamped ONLY on overlap-
        // partitioned closes — a defaulted key would churn every legacy
        // artifact's computeArtifactHash (spurious cloud re-pushes).
        ...(windowOverlapRecord !== undefined ? { window_overlap: windowOverlapRecord } : {}),
        // Optional-absent: stamped whenever the union is non-empty OR the
        // probe failed at a boundary, even when the manifest is null — the
        // degradation disclosure must survive independently of manifest
        // presence, and an unverifiable window must stay durably
        // distinguishable from a clean one.
        ...(unmergedUnion.length > 0 || unmergedProbeFailed
          ? {
              attribution_degraded: {
                unmerged_paths: unmergedUnion,
                ...(unmergedProbeFailed ? { probe_failed: true } : {}),
              },
            }
          : {}),
        completed_step_ids: [...input.completed_step_ids],
        head_sha: headSha,
        ts: closedAt,
        close_snapshot: closeSnapshot,
        diff_fingerprint_summary: fingerprintSummary,
      };
      eventPayload.closed_by_agent = opts.invokedByAgent ?? 'other';
      if (fingerprintManifest !== null) {
        // Spills to sidecar past the 8 KB inline budget via the
        // existing event-log path (~50-80 KB typical per close).
        eventPayload.diff_fingerprint_manifest = fingerprintManifest;
      }
      const event = await this.appendAndMirror(
        {
          type: 'checkpoint_closed',
          ts: closedAt,
          idempotency_key: opts.idempotencyKey,
          payload: eventPayload,
        },
        paths
      );

      // 5. Re-read + rebuild.
      const updatedEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuilt = rebuildCheckpointFromEvents(updatedEvents, input.n);
      if (!rebuilt || rebuilt.checkpoint.status !== 'closed') {
        throw new Error(
          `event-first writeCheckpointClosed invariant: rebuild produced no closed cp at n=${input.n}`
        );
      }
      const rebuiltArtifact = rebuildArtifactJsonFromEvents(updatedEvents);
      if (!rebuiltArtifact) {
        throw new Error(
          `event-first writeCheckpointClosed invariant: artifact.json rebuilder returned null`
        );
      }

      await atomicWriteFile(
        paths.checkpointJson(input.n),
        JSON.stringify(rebuilt.checkpoint, null, 2) + '\n',
        this.repoRoot
      );
      await atomicWriteFile(
        paths.checkpointMd(input.n),
        checkpointMarkdown(rebuilt.checkpoint),
        this.repoRoot
      );
      await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);

      this.store.upsertCheckpoint(checkpointToRow(rebuilt.checkpoint));
      this.store.replaceSearchEntry({
        artifact_id: input.artifact_id,
        source: `checkpoint:${input.n}`,
        branch: artifact.branch,
        ts: closedAt,
        content: `${input.summary} · ${input.uncertainty.join(' · ')}`,
      });

      // Clear any prior hard_rejected idempotency record for this key
      // — the committed event supersedes it (hard_rejected → committed
      // upgrade path).
      await withNonDerivableWriteLease(this.repoRoot, () =>
        clearIdempotencyBlock({
          store: this.store,
          artifactId: input.artifact_id,
          idempotencyKey: opts.idempotencyKey,
          type: 'checkpoint_closed',
        })
      );

      void event;
      return { outcome: 'created' as const, checkpoint: rebuilt.checkpoint };
    });
  }

  // ────────────────────────────────────────
  // Checkpoint ABANDON
  // ────────────────────────────────────────

  async writeCheckpointAbandoned(
    input: CheckpointAbandonInput,
    opts: CheckpointAbandonWriteOptions
  ): Promise<CheckpointAbandonWriteResult> {
    const artifact = this.store.getArtifact(input.artifact_id);
    if (!artifact) {
      throw new Error(`Cannot abandon checkpoint for unknown artifact_id "${input.artifact_id}".`);
    }
    const paths = artifactPathsFor(this.repoRoot, this.config, input.artifact_id);

    return this.withWriteLock(input.artifact_id, async () => {
      const events = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );

      // Default replay shape strips `abandoned_at` and `head_sha`
      // (runtime-derived) so storage-direct callers get correct
      // replay semantics without needing custom extractors.
      const abandonReplayPayload = opts.replayPayload ?? {
        artifact_id: input.artifact_id,
        n: input.n,
        reason: input.reason,
      };
      const abandonExtractShape =
        opts.extractReplayShape ??
        ((priorPayload: unknown) => {
          if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
          const p = priorPayload as Record<string, unknown>;
          return {
            artifact_id: p.artifact_id,
            n: p.n,
            reason: p.reason,
          };
        });
      const lookup = await findThreeOutcomeIdempotency({
        store: this.store,
        events: events.map((e) => e.record),
        artifactId: input.artifact_id,
        type: 'checkpoint_abandoned',
        idempotencyKey: opts.idempotencyKey,
        payload: abandonReplayPayload,
        loadPriorPayload: (priorEvent) =>
          normalizePriorPayload(priorEvent, events, abandonExtractShape),
      });
      if (lookup.kind === 'replay-committed') {
        const rebuilt = rebuildCheckpointFromEvents(events, input.n);
        if (rebuilt && rebuilt.checkpoint.status === 'abandoned') {
          await this.repairCheckpointProjection(paths, events, artifact, input.n);
          return {
            outcome: 'replay' as const,
            checkpoint: rebuilt.checkpoint,
            priorEventId: lookup.priorEventId,
          };
        }
      }
      if (lookup.kind === 'conflict') {
        return { outcome: 'conflict' as const };
      }
      // first-call OR reevaluate — proceed.

      const recordAndThrow = async (err: Error): Promise<never> => {
        await withNonDerivableWriteLease(this.repoRoot, () =>
          recordHardRejected({
            store: this.store,
            artifactId: input.artifact_id,
            idempotencyKey: opts.idempotencyKey,
            type: 'checkpoint_abandoned',
            payload: abandonReplayPayload,
          })
        );
        throw err;
      };

      const existing = rebuildCheckpointFromEvents(events, input.n);
      if (!existing) {
        await recordAndThrow(new CheckpointNotFoundError(input.artifact_id, input.n));
      }
      if (existing!.checkpoint.status !== 'open') {
        await recordAndThrow(
          new CheckpointNotOpenError(input.artifact_id, input.n, existing!.checkpoint.status)
        );
      }
      // Abandoned cps inherit the open-time head_sha — abandon means
      // no work happened, so the head from open-time is the right
      // attribution. Made explicit on the event payload so the
      // rebuilder doesn't have to look it up implicitly.
      const openCp = existing!.checkpoint as OpenCheckpoint;

      // v4 fail-open contract for abandon snapshot capture:
      //   * absent callback → deliberate-skip boundary
      //   * callback threw → 'unknown' boundary (defense-in-depth)
      //   * callback succeeded → use the returned boundary unchanged
      const abandonedAt = new Date().toISOString();
      let abandonSnapshot: CheckpointSnapshotBoundary;
      if (opts.snapshotCallbacks?.captureAbandonSnapshot) {
        try {
          const result = await opts.snapshotCallbacks.captureAbandonSnapshot({
            artifact_id: input.artifact_id,
            n: input.n,
          });
          abandonSnapshot = result.boundary;
        } catch {
          abandonSnapshot = {
            snapshot_ref: null,
            tree_sha: null,
            snapshot_commit_sha: null,
            snapshot_error_reason: 'unknown',
          };
        }
      } else {
        abandonSnapshot = buildDefaultSkippedSnapshotBoundary();
      }
      const eventPayload = {
        artifact_id: input.artifact_id,
        n: input.n,
        reason: input.reason,
        abandoned_at: abandonedAt,
        head_sha: openCp.head_sha,
        abandon_snapshot: abandonSnapshot,
        abandoned_by_agent: opts.invokedByAgent ?? 'other',
      };
      const event = await this.appendAndMirror(
        {
          type: 'checkpoint_abandoned',
          ts: abandonedAt,
          idempotency_key: opts.idempotencyKey,
          payload: eventPayload,
        },
        paths
      );

      const updatedEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuilt = rebuildCheckpointFromEvents(updatedEvents, input.n);
      if (!rebuilt || rebuilt.checkpoint.status !== 'abandoned') {
        throw new Error(
          `event-first writeCheckpointAbandoned invariant: rebuild produced no abandoned cp at n=${input.n}`
        );
      }
      const rebuiltArtifact = rebuildArtifactJsonFromEvents(updatedEvents);
      if (!rebuiltArtifact) {
        throw new Error(
          `event-first writeCheckpointAbandoned invariant: artifact.json rebuilder returned null`
        );
      }

      await atomicWriteFile(
        paths.checkpointJson(input.n),
        JSON.stringify(rebuilt.checkpoint, null, 2) + '\n',
        this.repoRoot
      );
      await atomicWriteFile(
        paths.checkpointMd(input.n),
        checkpointMarkdown(rebuilt.checkpoint),
        this.repoRoot
      );
      await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);

      this.store.upsertCheckpoint(checkpointToRow(rebuilt.checkpoint));

      // Clear any prior hard_rejected idempotency record for this key
      // (hard_rejected → committed upgrade path).
      await withNonDerivableWriteLease(this.repoRoot, () =>
        clearIdempotencyBlock({
          store: this.store,
          artifactId: input.artifact_id,
          idempotencyKey: opts.idempotencyKey,
          type: 'checkpoint_abandoned',
        })
      );

      void event;
      return { outcome: 'created' as const, checkpoint: rebuilt.checkpoint };
    });
  }

  // ────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────

  /**
   * Project a summary into the SQLite cache — the last writes of the commit
   * group. Shared by the commit path and the replay branch's repair, both
   * driven from the event-derived summary rather than a caller's input.
   */
  private projectSummaryIntoCache(summary: Summary, artifact: ArtifactRow): void {
    this.store.upsertSummary({
      artifact_id: summary.artifact_id,
      outcome: summary.outcome,
      tests_written: summary.tests_written,
      tests_run: summary.tests_run,
      open_items: summary.open_items,
      ts: summary.ts,
    });
    this.store.upsertArtifact({
      ...artifact,
      completed_at: summary.ts,
      status: 'complete',
    });
    this.store.replaceSearchEntry({
      artifact_id: summary.artifact_id,
      source: 'summary',
      branch: artifact.branch,
      ts: summary.ts,
      content: `${summary.outcome} · ${summary.open_items.join(' · ')}`,
    });
  }

  async writeSummary(
    input: SummaryInput,
    opts: SummaryWriteOptions = {}
  ): Promise<SummaryWriteResult> {
    const parsedSummary = SummaryInputSchema.parse(input);
    const s: SummaryInput =
      parsedSummary.accepted_warnings === undefined
        ? parsedSummary
        : {
            ...parsedSummary,
            accepted_warnings: normalizeAcceptedWarnings(parsedSummary.accepted_warnings),
          };
    const artifact = this.store.getArtifact(s.artifact_id);
    if (!artifact) {
      throw new Error(
        `Cannot write summary for unknown artifact_id "${s.artifact_id}". ` +
          'Call writePlan first.'
      );
    }
    const paths = artifactPathsFor(this.repoRoot, this.config, s.artifact_id);
    const idempotencyKey = opts.idempotencyKey ?? uuidv7();

    return this.withWriteLock(s.artifact_id, async () => {
      const events = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      // Default replay shape strips runtime-derived fields so callers that
      // don't supply `replayPayload`/`extractReplayShape` still get correct
      // replay semantics. `head_sha` is excluded because a supersede inherits
      // it rather than deriving it, and `agent` so a cross-agent retry replays
      // instead of conflicting.
      const summaryReplayPayload = opts.replayPayload ?? {
        artifact_id: s.artifact_id,
        outcome: s.outcome,
        tests_written: [...s.tests_written],
        tests_run: [...s.tests_run],
        open_items: [...s.open_items],
        deferred_decisions: [...s.deferred_decisions],
        ...(s.accepted_warnings === undefined
          ? {}
          : { accepted_warnings: normalizeAcceptedWarnings(s.accepted_warnings) }),
      };
      const summaryExtractShape =
        opts.extractReplayShape ??
        ((priorPayload: unknown) => {
          if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
          const p = priorPayload as Record<string, unknown>;
          return {
            artifact_id: p.artifact_id,
            outcome: p.outcome,
            tests_written: p.tests_written,
            tests_run: p.tests_run,
            open_items: p.open_items,
            deferred_decisions: p.deferred_decisions,
            accepted_warnings: normalizeAcceptedWarningsForReplay(p.accepted_warnings),
          };
        });
      const replay = await findArtifactScopedReplay({
        events: events.map((e) => e.record),
        type: 'summary_captured',
        idempotencyKey,
        payload: summaryReplayPayload,
        loadPriorPayload: (priorEvent) =>
          normalizePriorPayload(priorEvent, events, summaryExtractShape),
      });
      if (replay.kind === 'replay') {
        const priorSummary = await this.loadSummaryFromEvents(events);
        if (!priorSummary) {
          throw new Error(
            `idempotency invariant: replay matched event ${replay.priorEventId} but the ` +
              `summary projection could not be rebuilt from events`
          );
        }
        // SQLite is written last in the commit group, so an absent or
        // disagreeing row is a sound witness that a crash tore it. Repair from
        // the REBUILT summary, never this call's input — a retry may carry a
        // different ts/head_sha, and the durable event is authoritative.
        const cachedBefore = this.store.getSummary(s.artifact_id);
        const cacheTorn = cachedBefore === null || cachedBefore.ts !== priorSummary.ts;
        // replaceSearchEntry is the last write of the group, so a tear can
        // land with the row already correct and only the index missing —
        // the row alone is not a sufficient witness.
        const searchTorn = !this.store.hasSearchEntry(s.artifact_id, 'summary');
        if (cacheTorn || searchTorn) {
          this.projectSummaryIntoCache(priorSummary, artifact);
        }
        if (cacheTorn) {
          const rebuiltArtifact = rebuildArtifactJsonFromEvents(events);
          await atomicWriteFile(
            paths.summaryJson,
            JSON.stringify(priorSummary, null, 2) + '\n',
            this.repoRoot
          );
          await atomicWriteFile(paths.summaryMd, summaryMarkdown(priorSummary), this.repoRoot);
          if (rebuiltArtifact) {
            await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);
          }
        }
        return {
          outcome: 'replay' as const,
          summary: priorSummary,
          priorEventId: replay.priorEventId,
        };
      }
      if (replay.kind === 'conflict') {
        const priorSummary = await this.loadSummaryFromEvents(events);
        if (!priorSummary) {
          throw new Error(
            `idempotency invariant: conflict matched event ${replay.priorEventId} but the ` +
              `summary projection could not be rebuilt from events`
          );
        }
        return {
          outcome: 'conflict' as const,
          summary: priorSummary,
          priorEventId: replay.priorEventId,
        };
      }

      // GATE: reject a silent second summary. A fresh idempotency_key on
      // an already-summarized artifact would otherwise append a new
      // summary_captured and last-wins-clobber the reviewer-facing record with
      // no trace on any surface. Require an explicit prior_summary_event_id (the
      // latest summary event id) to supersede — the same optimistic-concurrency
      // idiom as prior_plan_event_id, race-safe against two agents amending at
      // once. Placed AFTER the replay/conflict lookup so an idempotent same-key
      // retry still replays. The token flows via opts and never enters the
      // payload, so the artifact hash is unaffected.
      const priorSummaryEvents = events.filter((e) => e.record.type === 'summary_captured');
      const priorSummaryEvent =
        priorSummaryEvents.length > 0 ? priorSummaryEvents[priorSummaryEvents.length - 1] : null;
      // An amendment must NOT move the recorded window. Callers derive head_sha
      // from the CURRENT HEAD, so superseding after later commits would silently
      // restamp the summary onto work it never covered — an artifact reviewed at
      // one commit would claim a head it never saw. Only a FIRST capture derives
      // HEAD; a supersede inherits the head it is replacing. Enforced here rather
      // than in the CLI because the prior event is already loaded and validated
      // under this lock, and because a storage-direct caller would otherwise
      // still be able to widen the window.
      let effectiveSummary = s;
      if (priorSummaryEvent === null) {
        if (s.accepted_warnings !== undefined) {
          validateWarningAcceptance(s.artifact_id, s.accepted_warnings, events);
        }
      } else {
        const latestSummaryEventId = priorSummaryEvent.record.event_id;
        if (opts.priorSummaryEventId === undefined) {
          throw new SummaryAlreadyCapturedError(
            `Artifact "${s.artifact_id}" already has a summary (event ` +
              `${latestSummaryEventId} at ${priorSummaryEvent.record.ts}). A bare re-capture is ` +
              `refused so a second agent can't silently clobber the summary. To REPLACE it, ` +
              `re-run capture summary with prior_summary_event_id: "${latestSummaryEventId}".`,
            s.artifact_id,
            latestSummaryEventId
          );
        }
        if (opts.priorSummaryEventId !== latestSummaryEventId) {
          throw new StaleSummarySupersedeError(
            `Stale prior_summary_event_id for artifact "${s.artifact_id}": you passed ` +
              `"${opts.priorSummaryEventId}" but the latest summary event is ` +
              `"${latestSummaryEventId}". Re-read resume/status and retry with the fresh token.`,
            s.artifact_id,
            latestSummaryEventId
          );
        }
        // token == latest summary event → an explicit supersede; the append
        // below adds a new summary_captured that latest-wins in the projection.
        //
        // Validate the WHOLE prior payload rather than probing head_sha: that is
        // the contract every summary event was written under, so a payload
        // failing it means the log is inconsistent, not that this field is
        // special. Event payloads are z.unknown() at the event-log layer, so
        // this is the only place the shape gets checked.
        //
        // Fail closed. Falling back to the caller's summary would carry
        // CURRENT HEAD and silently restamp the very corruption this
        // inheritance exists to prevent. There is no legitimate
        // prior summary to be lenient toward: SummarySchema requires head_sha as
        // a non-empty string at the only schema version, so an unreadable prior
        // means tampering or corruption, and that must be loud.
        const priorParsed = SummaryInputSchema.safeParse(priorSummaryEvent.payload);
        if (!priorParsed.success) {
          throw new Error(
            `event-first writeSummary invariant: the summary event being superseded ` +
              `(${latestSummaryEventId}) has a payload that does not satisfy SummarySchema, ` +
              `so its head_sha cannot be inherited. Refusing to amend rather than restamp the ` +
              `recorded window to current HEAD. Inspect the event log for artifact ` +
              `"${s.artifact_id}". (${priorParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`
          );
        }
        if (!acceptedWarningsEqual(s.accepted_warnings, priorParsed.data.accepted_warnings)) {
          throw new WarningAcceptanceInvalidError(
            `Summary amendment for artifact "${s.artifact_id}" must repeat the prior summary's ` +
              'accepted_warnings exactly. Warning acceptances cannot be added, removed, or changed ' +
              'by amending summary text.',
            s.artifact_id
          );
        }
        effectiveSummary = { ...s, head_sha: priorParsed.data.head_sha };
      }

      const preWriteArtifact = rebuildArtifactJsonFromEvents(events);
      if (preWriteArtifact && preWriteArtifact.json.state === 'blocked') {
        const blockingEvaluators = preWriteArtifact.openBlocks;
        throw new BlockedError(
          `Cannot capture summary while artifact "${s.artifact_id}" is blocked by ` +
            `${blockingEvaluators.length} unresolved block-severity evaluator(s): ` +
            `${blockingEvaluators.map((n) => `"${n}"`).join(', ')}. ` +
            `Resolve a policy finding via \`orcaops block acknowledge\` / ` +
            `\`orcaops block dismiss\`, or fix the work or evaluator and re-run it. ` +
            `Evaluator errors cannot be acknowledged or dismissed.`,
          s.artifact_id,
          blockingEvaluators
        );
      }

      // Completion gate: refuse while any open cp exists. Inside the
      // lock so a subagent can't open a cp between this check and the
      // event append below.
      const openCps = this.store.getOpenCheckpoints(s.artifact_id);
      if (openCps.length > 0) {
        const now = Date.now();
        const openSummaries = openCps.map((cp) => {
          const idleSeconds = Math.max(
            0,
            Math.round((now - new Date(cp.opened_at).getTime()) / 1000)
          );
          return {
            n: cp.n,
            agent_session_id: cp.agent_session_id,
            declared_step_ids: [...cp.declared_step_ids],
            opened_at: cp.opened_at,
            idle_for_seconds: idleSeconds,
          };
        });
        const detail = openSummaries
          .map(
            (cp) =>
              `#${cp.n}` +
              (cp.agent_session_id ? ` (${cp.agent_session_id})` : '') +
              ` declared [${cp.declared_step_ids.join(', ')}], opened ${cp.opened_at} ` +
              `(idle ${cp.idle_for_seconds}s)`
          )
          .join('; ');
        throw new OpenCheckpointsPendingError(
          `Cannot capture summary while ${openCps.length} open checkpoint(s) exist: ${detail}. ` +
            `Close or abandon each before retrying.`,
          s.artifact_id,
          openSummaries
        );
      }

      const eventPayload = effectiveSummary;
      const event = await this.appendAndMirror(
        {
          type: 'summary_captured',
          ts: s.ts,
          idempotency_key: idempotencyKey,
          payload: eventPayload,
        },
        paths
      );

      const updatedEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuiltSummary = rebuildSummaryFromEvents(updatedEvents);
      if (!rebuiltSummary) {
        throw new Error(
          `event-first writeSummary invariant: rebuilder found no summary_captured event ` +
            `right after appending one (event_id=${event.event_id})`
        );
      }
      const rebuiltArtifact = rebuildArtifactJsonFromEvents(updatedEvents);
      if (!rebuiltArtifact) {
        throw new Error(
          `event-first writeSummary invariant: artifact.json rebuilder returned null ` +
            `(event_id=${event.event_id})`
        );
      }

      await atomicWriteFile(
        paths.summaryJson,
        JSON.stringify(rebuiltSummary.summary, null, 2) + '\n',
        this.repoRoot
      );
      await atomicWriteFile(
        paths.summaryMd,
        summaryMarkdown(rebuiltSummary.summary),
        this.repoRoot
      );
      await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);

      this.projectSummaryIntoCache(rebuiltSummary.summary, artifact);

      return {
        outcome: 'created' as const,
        summary: rebuiltSummary.summary,
        event_id: event.event_id,
      };
    });
  }

  // ────────────────────────────────────────
  // Evaluator runs (protocol-aligned)
  // ────────────────────────────────────────

  /**
   * Append an `evaluator_run_recorded` event and replay the
   * projections (evaluators.json + artifact.json + SQLite mirror +
   * search index). Returns the rebuilt V2 log + outcome.
   *
   * The payload carries `run_status`, `verdict`, and `error` as distinct
   * fields; the materialized `disposition`
   * column is derived by the projection rebuilder (initially
   * `unresolved` for blocking-eligible runs, `null` otherwise) and
   * mirrored onto the SQLite row by `insertEvaluatorRun` here.
   */
  async writeEvaluatorRunPayload(
    artifactId: string,
    runInput: EvaluatorRunPayload,
    opts: AutoMintWriteOptions = {}
  ): Promise<EvaluatorRunWriteResult> {
    // Sanitize before validate: evaluator output (body / error.message / the
    // arbitrary `raw`) is generated text — frequently LLM output — that can
    // carry a NUL. It is FTS-indexed + cloud-synced from this parsed value, so
    // deep-strip every string (write-only: the shared schema is also parsed on
    // rebuild, so we strip here at the write site, not in the schema). Ids/refs
    // are engine-derived and unaffected; the wire assert is the final net.
    const run = EvaluatorRunPayloadSchema.parse(deepStripControlChars(runInput));
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) {
      throw new Error(`Cannot append evaluator run for unknown artifact_id "${artifactId}".`);
    }
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);

    const idempotencyKey = opts.idempotencyKey ?? uuidv7();
    return this.withWriteLock(artifactId, async () => {
      const event = await this.appendAndMirror(
        {
          type: 'evaluator_run_recorded',
          ts: run.ts,
          idempotency_key: idempotencyKey,
          payload: run,
        },
        paths
      );

      const updatedEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuiltLog = rebuildEvaluatorLogFromEvents(updatedEvents, artifactId);
      if (!rebuiltLog) {
        throw new Error(
          `event-first writeEvaluatorRunPayload invariant: rebuilder returned null ` +
            `right after appending event ${event.event_id}`
        );
      }
      const rebuiltArtifact = rebuildArtifactJsonFromEvents(updatedEvents);
      if (!rebuiltArtifact) {
        throw new Error(
          `event-first writeEvaluatorRunPayload invariant: artifact.json rebuilder returned null ` +
            `(event_id=${event.event_id})`
        );
      }

      await atomicWriteFile(
        paths.evaluatorsJson,
        JSON.stringify(rebuiltLog.log, null, 2) + '\n',
        this.repoRoot
      );
      await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);

      // Find the materialized row for this run and persist it to
      // SQLite. The rebuilder computes the disposition + order_key
      // components — we mirror them onto the row exactly.
      const materialized = rebuiltLog.log.runs.find((r) => r.run_id === run.run_id);
      if (!materialized) {
        throw new Error(
          `event-first writeEvaluatorRunPayload invariant: rebuilt log missing run_id=${run.run_id}`
        );
      }
      this.store.insertEvaluatorRun({
        run_id: materialized.run_id,
        artifact_id: materialized.artifact_id,
        evaluator_ref: materialized.evaluator_ref,
        package_id: materialized.package_id,
        evaluator_id: materialized.evaluator_id,
        phase: materialized.phase,
        severity: materialized.severity,
        run_status: materialized.run_status,
        verdict: materialized.verdict,
        body: materialized.body,
        raw: materialized.raw !== undefined ? JSON.stringify(materialized.raw) : null,
        metrics: materialized.metrics !== undefined ? JSON.stringify(materialized.metrics) : null,
        provider: materialized.provider ?? null,
        model: materialized.model ?? null,
        tokens_in: materialized.tokens?.in ?? null,
        tokens_out: materialized.tokens?.out ?? null,
        tokens_cache_read: materialized.tokens?.cache_read ?? null,
        tokens_cache_write: materialized.tokens?.cache_write ?? null,
        cost_usd: materialized.cost_usd ?? null,
        duration_ms: materialized.duration_ms ?? null,
        checkpoint_n: materialized.checkpoint_n ?? null,
        error_code: materialized.error?.code ?? null,
        error_message: materialized.error?.message ?? null,
        ts: materialized.ts,
        disposition: materialized.disposition,
        source_event_index: materialized.source_event_index,
        local_kind_rank: 0,
        local_index: materialized.local_index,
      });

      this.store.replaceSearchEntry({
        artifact_id: artifactId,
        source: `evaluator:${run.evaluator_ref}:${run.ts}`,
        branch: artifact.branch,
        ts: run.ts,
        content:
          `${run.evaluator_ref} · ${run.severity}/${run.run_status}` +
          `${run.verdict !== null ? `/${run.verdict}` : ''} · ${run.body}`,
      });

      return { outcome: 'created' as const, log: rebuiltLog.log };
    });
  }

  /**
   * Append an `evaluator_disposition_recorded` event and replay the
   * projections. The store-layer write of the disposition row +
   * atomic UPDATE of the targeted run's materialized `disposition`
   * column happens inside `Store.insertEvaluatorDisposition`'s
   * transaction; this method handles event log + JSON projections
   * + search index.
   *
   * Note: the FK constraint on `evaluator_dispositions(run_id)`
   * requires the targeted run to exist in SQLite BEFORE this method
   * runs. The capture-side caller is responsible for ordering
   * (typically: the run was written via `writeEvaluatorRunPayload`
   * earlier in the lifecycle).
   */
  async writeEvaluatorDisposition(
    artifactId: string,
    dispositionInput: EvaluatorDispositionPayload,
    opts: AutoMintWriteOptions = {}
  ): Promise<EvaluatorRunWriteResult> {
    // Sanitize before validate: the disposition `reason` comes from a CLI flag
    // (`block acknowledge`/`dismiss`), bypassing the capture-input schemas, and
    // is FTS-indexed + cloud-synced. Deep-strip every string here so a NUL in
    // the reason can't poison search or the cloud.
    const dispo = EvaluatorDispositionPayloadSchema.parse(deepStripControlChars(dispositionInput));
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) {
      throw new Error(
        `Cannot append evaluator disposition for unknown artifact_id "${artifactId}".`
      );
    }
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);

    const idempotencyKey = opts.idempotencyKey ?? uuidv7();
    return this.withWriteLock(artifactId, async () => {
      const currentEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const currentLog = rebuildEvaluatorLogFromEvents(currentEvents, artifactId);
      const target = currentLog?.log.runs.find((run) => run.run_id === dispo.run_id);
      if (!target || target.evaluator_ref !== dispo.evaluator_ref) {
        throw new Error(
          `Cannot append evaluator disposition: run "${dispo.run_id}" does not identify ` +
            `evaluator "${dispo.evaluator_ref}" on artifact "${artifactId}".`
        );
      }
      if (blockingEvaluatorFailureKind(target) !== 'violation') {
        throw new Error(
          `Cannot append evaluator disposition for run "${dispo.run_id}": only completed ` +
            `block-severity violations can be acknowledged or dismissed. Evaluator errors ` +
            `must be rerun successfully.`
        );
      }
      const event = await this.appendAndMirror(
        {
          type: 'evaluator_disposition_recorded',
          ts: dispo.ts,
          idempotency_key: idempotencyKey,
          payload: dispo,
        },
        paths
      );

      const updatedEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuiltLog = rebuildEvaluatorLogFromEvents(updatedEvents, artifactId);
      if (!rebuiltLog) {
        throw new Error(
          `event-first writeEvaluatorDisposition invariant: rebuilder returned null ` +
            `right after appending event ${event.event_id}`
        );
      }
      const rebuiltArtifact = rebuildArtifactJsonFromEvents(updatedEvents);
      if (!rebuiltArtifact) {
        throw new Error(
          `event-first writeEvaluatorDisposition invariant: artifact.json rebuilder returned null ` +
            `(event_id=${event.event_id})`
        );
      }

      await atomicWriteFile(
        paths.evaluatorsJson,
        JSON.stringify(rebuiltLog.log, null, 2) + '\n',
        this.repoRoot
      );
      await writeArtifactJson(paths.artifactJson, rebuiltArtifact.json, this.repoRoot);

      // Locate the materialized disposition row in the rebuilt log
      // and persist it (with the matching order_key) — the
      // store's insertEvaluatorDisposition atomically UPDATEs the
      // targeted run's disposition column inside the same SQLite
      // transaction.
      const materialized = rebuiltLog.log.dispositions.find(
        (d) => d.disposition_id === dispo.disposition_id
      );
      if (!materialized) {
        throw new Error(
          `event-first writeEvaluatorDisposition invariant: rebuilt log missing ` +
            `disposition_id=${dispo.disposition_id}`
        );
      }
      this.store.insertEvaluatorDisposition({
        disposition_id: materialized.disposition_id,
        artifact_id: materialized.artifact_id,
        run_id: materialized.run_id,
        evaluator_ref: materialized.evaluator_ref,
        disposition: materialized.disposition,
        reason: materialized.reason,
        agent_session_id: materialized.agent_session_id,
        ts: materialized.ts,
        source_event_index: materialized.source_event_index,
        local_kind_rank: 1,
        local_index: materialized.local_index,
      });

      this.store.replaceSearchEntry({
        artifact_id: artifactId,
        source: `block-resolution:${dispo.evaluator_ref}:${dispo.ts}`,
        branch: artifact.branch,
        ts: dispo.ts,
        content: `${dispo.evaluator_ref} · ${dispo.disposition} · ${dispo.reason}`,
      });

      return { outcome: 'created' as const, log: rebuiltLog.log };
    });
  }

  // ────────────────────────────────────────
  // Read path
  // ────────────────────────────────────────

  async readPlan(artifactId: string): Promise<Plan | null> {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) return null;
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);

    const projection = await readProjectionForRecovery(paths.planJson, this.repoRoot, (raw) =>
      PlanSchema.parse(raw)
    );
    const { events, lossyCorrupt, lineByEventId } = await this.loadAllEventsForRecovery(
      paths.eventsNdjson,
      paths.sidecarsDir
    );

    const recovery = recoverProjection<Plan>({
      projection,
      events: events.map((e) => e.record),
      lossyCorrupt,
      lineByEventId,
      relevantTypes: new Set<EventType>(['plan_captured', 'plan_revised']),
      rebuild: () => {
        const r = rebuildPlanFromEvents(events);
        if (!r)
          throw new Error(
            `recoverProjection asked for a rebuild but rebuildPlanFromEvents returned null ` +
              `(artifact_id=${artifactId})`
          );
        return r.plan;
      },
    });
    return await this.persistAndReturn<Plan>(recovery, paths.planJson, artifactId);
  }

  /**
   * Read a specific plan revision as a fully-validated Plan projection.
   * Used by the evaluator bridge to populate `EvaluatorContext.prior_plan`
   * on post-plan-revision evaluators (the three `revision-*-stable`
   * checkers compare current vs. prior to detect scope drift).
   *
   * Per-revision variable fields (label, plan_steps, touched_scope,
   * non_goals, rationale, step_lineage, captured_at, prior_event_id,
   * source_event_id) come from the per-revision `plans` + `plan_steps`
   * sqlite rows. Artifact-stable fields (branch, base_sha, agent,
   * agent_session_id, task, started_at) are sourced from the latest plan
   * — they don't change across revisions in practice and the per-revision
   * sqlite rows don't carry them.
   *
   * Returns null when the artifact has no plan yet, when the requested
   * revision_n doesn't exist, or when revision_n > latest revision.
   * When revision_n equals the latest revision, this returns the same
   * value as `readPlan` (latest).
   */
  /**
   * Strict resolution of the plan revision a checkpoint opened against.
   * NEVER falls back to the latest plan:
   *   - `unresolved` — the token maps to no known revision (a cache
   *                    rebuilt mid-transition, or corruption); the caller
   *                    fails loudly.
   *   - `resolved`   — the exact open-time revision, with its acceptance criteria
   *                    as they read at open (not the latest).
   * The cloud-sync `done_criteria.text` producer and close-time
   * `done_criteria` validation both fail fast on `unresolved` so a degraded
   * read is never durably written anywhere.
   */
  async resolveOpenRevisionPlanStrict(
    artifactId: string,
    openPlanRevisionEventId: string
  ): Promise<{ kind: 'resolved'; plan: Plan } | { kind: 'unresolved' }> {
    const match = this.store
      .listPlanRevisions(artifactId)
      .find((r) => r.plan.source_event_id === openPlanRevisionEventId);
    if (!match) return { kind: 'unresolved' };
    const plan = await this.readPlanRevision(artifactId, match.plan.revision_n);
    return plan ? { kind: 'resolved', plan } : { kind: 'unresolved' };
  }

  async readPlanRevision(artifactId: string, revisionN: number): Promise<Plan | null> {
    if (revisionN < 0) return null;
    const latest = await this.readPlan(artifactId);
    if (!latest) return null;
    if (revisionN > latest.revision_n) return null;
    if (revisionN === latest.revision_n) return latest;

    const row = this.store.getPlanRevision(artifactId, revisionN);
    if (!row) return null;

    const lineageParse = <T>(
      schema: { parse: (v: unknown) => T },
      raw: string,
      column: string
    ): T => {
      try {
        return schema.parse(JSON.parse(raw));
      } catch (err) {
        throw new Error(
          `stored plan revision ${revisionN} for artifact ${artifactId} has a ${column} column ` +
            `that fails the strict schema (${err instanceof Error ? err.message : String(err)}) — ` +
            `the SQLite cache is stale or damaged; run \`orcaops rebuild\` and retry`
        );
      }
    };
    const stepLineage = lineageParse(StepLineageSchema, row.plan.step_lineage, 'step_lineage');
    const criterionLineage = lineageParse(
      CriterionLineageSchema,
      row.plan.criterion_lineage,
      'criterion_lineage'
    );
    return PlanSchema.parse({
      schema_version: 4,
      artifact_id: artifactId,
      branch: latest.branch,
      base_sha: latest.base_sha,
      agent: latest.agent,
      agent_session_id: latest.agent_session_id,
      task: latest.task,
      label: row.plan.label,
      plan_steps: row.steps.map((s) => ({
        step_id: s.step_id,
        text: s.text,
        label: s.label,
        acceptance_criteria: JSON.parse(s.acceptance_criteria) as AcceptanceCriterion[],
      })),
      touched_scope: JSON.parse(row.plan.touched_scope) as string[],
      non_goals: JSON.parse(row.plan.non_goals) as NonGoal[],
      decisions: JSON.parse(row.plan.decisions) as Plan['decisions'],
      started_at: latest.started_at,
      revision_n: row.plan.revision_n,
      revised_at: row.plan.revision_n === 0 ? null : row.plan.captured_at,
      rationale: row.plan.rationale,
      step_lineage: stepLineage,
      criterion_lineage: criterionLineage,
      prior_plan_event_id: row.plan.prior_event_id,
      source_event_id: row.plan.source_event_id,
    });
  }

  /**
   * Singular checkpoint read — delegates to the recovery-aware plural
   * read and selects `n`, so the artifact-level refusal applies
   * identically to both reads: agreement is structural, not
   * test-enforced.
   */
  async readCheckpoint(artifactId: string, n: number): Promise<Checkpoint | null> {
    const all = await this.readCheckpointsRecovered(artifactId);
    return all.find((cp) => cp.n === n) ?? null;
  }

  async readCheckpoints(artifactId: string): Promise<Checkpoint[]> {
    return this.readCheckpointsRecovered(artifactId);
  }

  /**
   * Resolve the checkpoint number committed by a prior close key.
   * This lets the CLI replay an omitted-n close after the checkpoint
   * is no longer open. The close writer still performs the full payload
   * equality check; this method recovers only the routing field needed
   * to reach that check.
   */
  async findCommittedCheckpointCloseN(
    artifactId: string,
    idempotencyKey: string
  ): Promise<number | null> {
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    const events = await this.loadAllEvents(
      paths.eventsNdjson,
      paths.sidecarsDir,
      paths.artifactId
    );
    const match = events.find(
      (event) =>
        event.record.type === 'checkpoint_closed' && event.record.idempotency_key === idempotencyKey
    );
    if (match === undefined) return null;
    const n = (match.payload as { n?: unknown }).n;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
  }

  /**
   * Latest `checkpoint_closed` diff-fingerprint manifest for cp `n`, or
   * null. Reused by cloud sync's strict-fingerprint materialization
   * (`readSnapshot`); `fingerprint show` and doctor reuse it.
   *
   * Uses the corrupt-DROPPING loader: under the artifact-level contract
   * any corrupt line (sidecar included) refuses `readCheckpointsRecovered`
   * first, so this reader's null now only means a genuinely absent
   * manifest over an intact log — `readSnapshot` still treats that as
   * `FingerprintManifestMissingError` as defense in depth.
   */
  async readCheckpointDiffFingerprint(
    artifactId: string,
    n: number
  ): Promise<DiffFingerprintManifest | null> {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) return null;
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    const events = await this.loadAllEventsTolerant(paths.eventsNdjson, paths.sidecarsDir);
    let latest: EventWithPayload | null = null;
    for (const ev of events) {
      if (ev.record.type !== 'checkpoint_closed') continue;
      if ((ev.payload as { n?: unknown }).n !== n) continue;
      latest = ev; // last close in append order wins
    }
    if (latest === null) return null;
    return (latest.payload as ClosedFingerprintPayload).diff_fingerprint_manifest ?? null;
  }

  /**
   * Every checkpoint's stored manifest, keyed by `n`, in ONE event-log pass.
   *
   * The singular `readCheckpointDiffFingerprint` above reloads the entire event
   * log per call. That is fine for the CLI's one-checkpoint verbs, but the review
   * engine needs every checkpoint of every artifact on the branch, and calling the
   * singular in a loop is O(checkpoints x event log) on the path the watch TUI hits
   * on every review open. Same corrupt-DROPPING semantics as the singular: a
   * checkpoint whose manifest sidecar is corrupt simply has no entry here, which —
   * paired with a non-null stored `manifest_hash` — is precisely the signal that
   * the sidecar is corrupt rather than never captured.
   */
  async readCheckpointDiffFingerprints(
    artifactId: string
  ): Promise<Map<number, DiffFingerprintManifest>> {
    const out = new Map<number, DiffFingerprintManifest>();
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) return out;
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    const events = await this.loadAllEventsTolerant(paths.eventsNdjson, paths.sidecarsDir);
    for (const ev of events) {
      if (ev.record.type !== 'checkpoint_closed') continue;
      const payload = ev.payload as ClosedFingerprintPayload;
      const n = payload.n;
      if (typeof n !== 'number') continue;
      const manifest = payload.diff_fingerprint_manifest;
      // Last close in append order wins — mirrors the singular. A later close
      // WITHOUT a manifest must also win (it supersedes), so delete rather than
      // leave a stale earlier manifest in place.
      if (manifest === undefined) out.delete(n);
      else out.set(n, manifest);
    }
    return out;
  }

  /**
   * Recovery-aware plural checkpoint read: refuses the whole artifact on
   * any non-tail loss, then rebuilds each `n` from the intact log. The
   * singular `readCheckpoint` delegates HERE, and `readCheckpoints()` is
   * an alias, so digest/status/resume share the same semantics.
   */
  async readCheckpointsRecovered(artifactId: string): Promise<Checkpoint[]> {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) return [];
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    const { events, lossyCorrupt, lineByEventId } = await this.loadAllEventsForRecovery(
      paths.eventsNdjson,
      paths.sidecarsDir
    );

    // Enumerate cp `n`s from both sources, unioned: raw event payloads
    // + on-disk projection files. A checkpoint-N.json with no events of
    // its type in the intact log is discovered here and then REFUSED by
    // its own recovery (unprovenanced state), never silently skipped.
    const ns = new Set<number>();
    for (const ev of events) {
      if (
        ev.record.type !== 'checkpoint_opened' &&
        ev.record.type !== 'checkpoint_closed' &&
        ev.record.type !== 'checkpoint_abandoned'
      )
        continue;
      const candidate = (ev.payload as { n?: unknown }).n;
      if (typeof candidate === 'number' && Number.isInteger(candidate)) ns.add(candidate);
    }
    let dirEntries: string[] = [];
    try {
      dirEntries = await readdir(paths.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const name of dirEntries) {
      const m = /^checkpoint-(\d+)\.json$/.exec(name);
      if (m) ns.add(Number(m[1]));
    }

    // Read every discovered projection up front.
    const projections = new Map<
      number,
      { value: Checkpoint; source_event_id: string } | { unreadable: true } | null
    >();
    for (const n of ns) {
      projections.set(
        n,
        await readProjectionForRecovery(paths.checkpointJson(n), this.repoRoot, (raw) =>
          CheckpointSchema.parse(raw)
        )
      );
    }

    // Artifact-level refusal: ANY non-tail loss makes the whole
    // artifact unreadable — no inference about which projection a lost
    // line belonged to (v1 contract; per-projection discharge inference
    // was deliberately deleted).
    if (lossyCorrupt.length > 0) {
      throw new RecoveryRefusedError(
        `artifact ${artifactId} is unreadable: corrupt event-log line(s) ` +
          `${lossyCorrupt.map((c) => String(c.line)).join(', ')} — run \`orcaops doctor\`; ` +
          `restore events.ndjson from a backup or the archive mirror, or delete the ` +
          `artifact to accept the loss.`,
        artifactId
      );
    }

    const out: Checkpoint[] = [];
    for (const n of [...ns].sort((a, b) => a - b)) {
      const projection = projections.get(n) ?? null;
      const cpEvents = events.filter(
        (e) =>
          (e.record.type === 'checkpoint_opened' ||
            e.record.type === 'checkpoint_closed' ||
            e.record.type === 'checkpoint_abandoned') &&
          (e.payload as { n?: unknown }).n === n
      );
      const recovery = recoverProjection<Checkpoint>({
        projection,
        events: cpEvents.map((e) => e.record),
        lossyCorrupt,
        lineByEventId,
        relevantTypes: new Set<EventType>([
          'checkpoint_opened',
          'checkpoint_closed',
          'checkpoint_abandoned',
        ]),
        rebuild: () => {
          const r = rebuildCheckpointFromEvents(cpEvents, n);
          if (!r)
            throw new Error(
              `recoverProjection asked for a rebuild but rebuildCheckpointFromEvents(n=${n}) ` +
                `returned null (artifact_id=${artifactId})`
            );
          return r.checkpoint;
        },
      });
      const cp = await this.persistAndReturn<Checkpoint>(
        recovery,
        paths.checkpointJson(n),
        artifactId
      );
      if (cp !== null) out.push(cp);
    }
    assertCheckpointStepClaimsDisjoint(out, artifactId);
    return out;
  }

  /**
   * Adjudication read model over window-overlap groups.
   * Folds every `window_overlap` record on this artifact's closed cps —
   * plus the checkpoints of any cross-artifact siblings the pending
   * records name — into per-checkpoint final file sets. Manifest
   * consumers MUST read this view: final ambiguity can land on a later
   * close than the manifest it affects (append-only log, no rewrites).
   * Returns entries only for checkpoints carrying `window_overlap`.
   */
  async adjudicateWindowOverlap(artifactId: string): Promise<Map<number, CheckpointAdjudication>> {
    const cps = await this.readCheckpointsRecovered(artifactId);
    const own: AdjudicationCheckpoint[] = cps.map((cp) => ({
      n: cp.n,
      status: cp.status,
      filesChanged: cp.status === 'closed' ? cp.files_changed : [],
      ...(cp.status === 'closed' && cp.window_overlap !== undefined
        ? { windowOverlap: cp.window_overlap }
        : {}),
    }));

    const crossIds = new Set<string>();
    for (const cp of cps) {
      if (cp.status !== 'closed') continue;
      for (const ref of cp.window_overlap?.cross_artifact_siblings ?? []) {
        crossIds.add(ref.artifact_id);
      }
    }
    const crossMap = new Map<
      string,
      Array<{ n: number; status: 'open' | 'closed' | 'abandoned'; filesChanged: string[] }>
    >();
    const unreadableCross = new Set<string>();
    for (const id of crossIds) {
      // A rotted cross-artifact sibling must not abort adjudication for
      // this artifact. Omitting it from the map folds it exactly like a
      // still-open sibling (nothing finalizes, nothing lifts to clean),
      // and the entry names it so consumers disclose the omission.
      let rows;
      try {
        rows = await this.readCheckpointsRecovered(id);
      } catch (err) {
        // Only recovery refusals fold as unreadable; a containment
        // violation or programming error must stay loud.
        if (!(err instanceof RecoveryRefusedError)) throw err;
        unreadableCross.add(id);
        continue;
      }
      crossMap.set(
        id,
        rows.map((r) => ({
          n: r.n,
          status: r.status,
          filesChanged: r.status === 'closed' ? r.files_changed : [],
        }))
      );
    }
    return adjudicateOverlapGroups(own, crossMap, unreadableCross);
  }

  async readSummary(artifactId: string): Promise<Summary | null> {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) return null;
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);

    const projection = await readProjectionForRecovery(paths.summaryJson, this.repoRoot, (raw) =>
      SummarySchema.parse(raw)
    );
    const { events, lossyCorrupt, lineByEventId } = await this.loadAllEventsForRecovery(
      paths.eventsNdjson,
      paths.sidecarsDir
    );

    const recovery = recoverProjection<Summary>({
      projection,
      events: events.map((e) => e.record),
      lossyCorrupt,
      lineByEventId,
      relevantTypes: new Set<EventType>(['summary_captured']),
      rebuild: () => {
        const r = rebuildSummaryFromEvents(events);
        if (!r)
          throw new Error(
            `recoverProjection asked for a rebuild but rebuildSummaryFromEvents returned null ` +
              `(artifact_id=${artifactId})`
          );
        return r.summary;
      },
    });
    return await this.persistAndReturn<Summary>(recovery, paths.summaryJson, artifactId);
  }

  async readEvaluatorLog(artifactId: string): Promise<EvaluatorLog | null> {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) return null;
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);

    const projection = await readProjectionForRecovery(paths.evaluatorsJson, this.repoRoot, (raw) =>
      EvaluatorLogSchema.parse(raw)
    );
    const { events, lossyCorrupt, lineByEventId } = await this.loadAllEventsForRecovery(
      paths.eventsNdjson,
      paths.sidecarsDir
    );

    const recovery = recoverProjection<EvaluatorLog>({
      projection,
      events: events.map((e) => e.record),
      lossyCorrupt,
      lineByEventId,
      relevantTypes: new Set<EventType>([
        'evaluator_run_recorded',
        'evaluator_disposition_recorded',
        // checkpoint_opened can carry an embedded gate_audit payload
        // that contributes to the projection — keep it in the
        // relevance set so recovery picks up new audit rows.
        'checkpoint_opened',
      ]),
      rebuild: () => {
        const r = rebuildEvaluatorLogFromEvents(events, artifactId);
        if (!r)
          throw new Error(
            `recoverProjection asked for a rebuild but rebuildEvaluatorLogFromEvents returned null ` +
              `(artifact_id=${artifactId})`
          );
        return r.log;
      },
    });
    return await this.persistAndReturn<EvaluatorLog>(recovery, paths.evaluatorsJson, artifactId);
  }

  async readPrePrReview(artifactId: string, reviewId: string) {
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    const events = await this.loadAllEventsForRecovery(paths.eventsNdjson, paths.sidecarsDir);
    const event = events.events.find(
      (candidate) =>
        candidate.record.type === 'pre_pr_checked' && candidate.record.event_id === reviewId
    );
    if (!event) return null;
    const payload = PrePrCheckedPayloadSchema.safeParse(event.payload);
    return payload.success ? { event_id: reviewId, payload: payload.data } : null;
  }

  async readArtifact(artifactId: string): Promise<ArtifactJson | null> {
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);

    const projection = await readProjectionForRecovery(paths.artifactJson, this.repoRoot, (raw) =>
      ArtifactJsonSchema.parse(raw)
    );
    const { events, lossyCorrupt, lineByEventId } = await this.loadAllEventsForRecovery(
      paths.eventsNdjson,
      paths.sidecarsDir
    );

    const relevantTypes = new Set<EventType>([
      'plan_captured',
      'plan_revised',
      'checkpoint_opened',
      'checkpoint_closed',
      'checkpoint_abandoned',
      'summary_captured',
      'branch_lineage_updated',
      'block_acknowledged',
      'block_dismissed',
      'evaluator_run_recorded',
      'evaluator_disposition_recorded',
      'pre_pr_checked',
      // The rebuilder folds pin displacement into updated_at/source —
      // omitting it here would declare a pre-displacement projection
      // current and serve stale metadata.
      'pin_displaced',
    ]);

    const recovery = recoverProjection<ArtifactJson>({
      projection,
      events: events.map((e) => e.record),
      lossyCorrupt,
      lineByEventId,
      relevantTypes,
      rebuild: () => {
        const r = rebuildArtifactJsonFromEvents(events);
        if (!r)
          throw new Error(
            `recoverProjection asked for a rebuild but rebuildArtifactJsonFromEvents returned ` +
              `null (artifact_id=${artifactId})`
          );
        return r.json;
      },
    });
    return await this.persistAndReturn<ArtifactJson>(recovery, paths.artifactJson, artifactId);
  }

  async appendBranchLineage(
    artifactId: string,
    entry: BranchLineageEntry,
    opts: AutoMintWriteOptions = {}
  ): Promise<{ outcome: WriteOutcome; artifact: ArtifactJson; sourceEventId: string }> {
    const validated = BranchLineageEntrySchema.parse(entry);
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    const idempotencyKey = opts.idempotencyKey ?? uuidv7();

    return this.withWriteLock(artifactId, async () => {
      const event = await this.appendAndMirror(
        {
          type: 'branch_lineage_updated',
          ts: validated.ts,
          idempotency_key: idempotencyKey,
          payload: validated,
        },
        paths
      );

      const updatedEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuilt = rebuildArtifactJsonFromEvents(updatedEvents);
      if (!rebuilt) {
        throw new Error(
          `appendBranchLineage invariant: artifact.json rebuilder returned null right after ` +
            `appending branch_lineage_updated event ${event.event_id} — artifact ${artifactId} ` +
            `must have a prior plan_captured event for lineage to make sense`
        );
      }

      await writeArtifactJson(paths.artifactJson, rebuilt.json, this.repoRoot);
      const tail = rebuilt.json.branch_lineage[rebuilt.json.branch_lineage.length - 1];
      this.store.upsertLineageByLatestSha({
        artifact_id: artifactId,
        latest_lineage_sha: tail.head_sha,
        branch_name: tail.branch,
      });
      for (const entry of rebuilt.json.branch_lineage) {
        this.store.upsertLineageBranch({
          artifact_id: artifactId,
          branch_name: entry.branch,
        });
      }
      return { outcome: 'created', artifact: rebuilt.json, sourceEventId: rebuilt.sourceEventId };
    });
  }

  /**
   * Append a durable record for one non-blocking pre-PR attempt. Passing
   * attempts update the artifact's advisory pass marker; warning attempts are
   * retained for exact review without advancing the summary hint.
   *
   * NOT idempotency-keyed against the command input: each call mints a
   * fresh key and appends a fresh event. For a pass, this makes the advisory
   * marker current even though evaluator runs were written just before it.
   * A warning attempt deliberately advances the event log without pinning a
   * pass marker.
   *
   * Accepted cost: N non-blocking pre-pr runs at unchanged inputs append N
   * events, all but the latest redundant in the projection — bounded log
   * churn. Keep the `orcaops-pre-pr` skill text
   * in sync with this: it MUST say a fresh event is appended each pass (not
   * "overwritten; nothing is appended").
   *
   * NOT a finalization signal — `revisePlan` finalizes on
   * `summary_captured` only.
   */
  async writePrePrChecked(
    artifactId: string,
    payload: PrePrCheckedWritePayload,
    opts: AutoMintWriteOptions = {}
  ): Promise<{ event_id: string; artifact: ArtifactJson; sourceEventId: string }> {
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    const idempotencyKey = opts.idempotencyKey ?? uuidv7();
    return this.withWriteLock(artifactId, async () => {
      const ts = new Date().toISOString();
      const validated = PrePrCheckedPayloadSchema.parse({ ...payload, ts });
      const event = await this.appendAndMirror(
        {
          type: 'pre_pr_checked',
          ts,
          idempotency_key: idempotencyKey,
          payload: validated,
        },
        paths
      );

      const updatedEvents = await this.loadAllEvents(
        paths.eventsNdjson,
        paths.sidecarsDir,
        paths.artifactId
      );
      const rebuilt = rebuildArtifactJsonFromEvents(updatedEvents);
      if (!rebuilt) {
        throw new Error(
          `writePrePrChecked invariant: artifact.json rebuilder returned null right after ` +
            `appending pre_pr_checked event ${event.event_id} — artifact ${artifactId} must have ` +
            `a prior plan_captured event`
        );
      }

      await writeArtifactJson(paths.artifactJson, rebuilt.json, this.repoRoot);
      return {
        event_id: event.event_id,
        artifact: rebuilt.json,
        sourceEventId: rebuilt.sourceEventId,
      };
    });
  }

  async writePinDisplaced(
    artifactId: string,
    payload: {
      displaced_by_artifact_id: string;
      shell_key: unknown;
      reason: 'auto-on-capture-plan' | 'explicit-checkout';
    },
    opts: AutoMintWriteOptions = {}
  ): Promise<{ event_id: string }> {
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    const idempotencyKey = opts.idempotencyKey ?? uuidv7();
    return this.withWriteLock(artifactId, async () => {
      const ts = new Date().toISOString();
      const event = await this.appendAndMirror(
        {
          type: 'pin_displaced',
          ts,
          idempotency_key: idempotencyKey,
          payload,
        },
        paths
      );

      const artifact = this.store.getArtifact(artifactId);
      if (artifact) {
        const shellKeyKind =
          payload.shell_key &&
          typeof payload.shell_key === 'object' &&
          'kind' in (payload.shell_key as Record<string, unknown>)
            ? String((payload.shell_key as { kind: unknown }).kind)
            : 'unknown';
        this.store.replaceSearchEntry({
          artifact_id: artifactId,
          source: `pin-displaced:${event.event_id}`,
          branch: artifact.branch,
          ts,
          content:
            `pin-displaced · displaced_by=${payload.displaced_by_artifact_id} ` +
            `shell_key=${shellKeyKind} reason=${payload.reason}`,
        });
      }

      return { event_id: event.event_id };
    });
  }

  async deleteArtifact(
    artifactId: string,
    opts?: {
      beforeDelete?: () => Promise<void>;
      onRowsDeleted?: () => Promise<void>;
      onDetached?: () => Promise<void>;
    }
  ): Promise<{ deleted: boolean }> {
    const paths = artifactPathsFor(this.repoRoot, this.config, artifactId);
    let semanticCommitted = false;
    let committedStagingPath: string | null = null;
    try {
      return await this.lock.withLock(artifactId, async (artifactLease) => {
        await artifactLease.verify();
        const detectArtifactLeaseLoss = async (
          operationError: unknown
        ): Promise<ArtifactLockLeaseLostError | null> => {
          if (operationError instanceof ArtifactLockLeaseLostError) return operationError;
          try {
            await artifactLease.assert();
            return null;
          } catch (leaseError) {
            if (leaseError instanceof ArtifactLockLeaseLostError) return leaseError;
            throw leaseError;
          }
        };
        return withArtifactDeletionLock(this.repoRoot, async (assertDeletionLease) => {
          await reconcileArtifactDeletionStagingLocked({
            repoRoot: this.repoRoot,
            config: this.config,
            store: this.store,
          });
          await assertDeletionLease();
          const target = assertResolvedWithin(paths.dir, this.repoRoot, 'artifact deletion', {
            rejectSymlinks: true,
          });

          const ownerDir = artifactDeletionOwnerDir(this.repoRoot, artifactId);
          await mkdirDurable(
            ownerDir,
            0o700,
            artifactDeletionStagingRoot(this.repoRoot),
            this.repoRoot
          );
          const stagingId = uuidv7();
          const preparedStage = assertResolvedWithin(
            path.join(ownerDir, `prepared-${stagingId}`),
            this.repoRoot,
            'prepared artifact deletion staging',
            { rejectSymlinks: true }
          );
          const committedStage = assertResolvedWithin(
            path.join(ownerDir, `committed-${stagingId}`),
            this.repoRoot,
            'committed artifact deletion staging',
            { rejectSymlinks: true }
          );
          let hadDirectory = false;
          let rowsDeleted = false;
          try {
            await withNonDerivableWriteLease(this.repoRoot, async () => {
              if (this.store.projectionHealth !== 'healthy') {
                throw new ArtifactDeletionRecoveryError(
                  `Artifact ${artifactId} deletion lost its healthy projection precondition.`,
                  artifactId,
                  [],
                  false
                );
              }
              await opts?.beforeDelete?.();
              await artifactLease.assert();
              this.store.setProjectionHealth('rebuild_pending');
              try {
                await rename(target, preparedStage);
                hadDirectory = true;
              } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                if (await pathExists(target)) throw err;
              }
              if (hadDirectory) {
                await fsyncDirStrict(ownerDir, this.repoRoot);
                await fsyncDirStrict(path.dirname(target), this.repoRoot);
              }
              await artifactLease.assert();
              this.store.deleteArtifact(artifactId);
              rowsDeleted = true;
              await opts?.onRowsDeleted?.();
            });
          } catch (error) {
            if (!hadDirectory && rowsDeleted) {
              semanticCommitted = true;
              await rm(ownerDir, { recursive: true, force: true }).catch(() => {});
              throw new ArtifactDeletionRecoveryError(
                `Artifact ${artifactId} had no durable directory and its row deletion committed, ` +
                  'but deletion finalization failed; run `orcaops rebuild` before retrying.',
                artifactId,
                [],
                true,
                { cause: error }
              );
            }
            const artifactLeaseError = await detectArtifactLeaseLoss(error);
            if (artifactLeaseError !== null) {
              if (!hadDirectory) {
                await rm(ownerDir, { recursive: true, force: true }).catch(() => {});
              }
              throw new ArtifactDeletionRecoveryError(
                `Artifact ${artifactId} deletion lost its artifact lock; protected staging ` +
                  'was left for reconciliation by the next invocation.',
                artifactId,
                hadDirectory ? [preparedStage] : [],
                false,
                { cause: artifactLeaseError }
              );
            }
            try {
              await assertDeletionLease();
            } catch (leaseError) {
              throw new ArtifactDeletionRecoveryError(
                `Artifact ${artifactId} deletion lost its global recovery lock; protected ` +
                  'staging was left for the current lock holder or the next invocation.',
                artifactId,
                hadDirectory ? [preparedStage] : [],
                false,
                { cause: leaseError }
              );
            }
            if (!hadDirectory) {
              await rm(ownerDir, { recursive: true, force: true }).catch(() => {});
            }
            try {
              await reconcileArtifactDeletionStagingLocked({
                repoRoot: this.repoRoot,
                config: this.config,
                store: this.store,
              });
            } catch (recoveryError) {
              throw new ArtifactDeletionRecoveryError(
                `Artifact ${artifactId} deletion failed and automatic restoration also failed: ` +
                  `${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
                artifactId,
                hadDirectory ? [preparedStage] : [],
                false,
                { cause: error }
              );
            }
            throw error;
          }

          if (!hadDirectory) semanticCommitted = true;

          try {
            await assertDeletionLease();
            await artifactLease.assert();
            if (hadDirectory) {
              await rename(preparedStage, committedStage);
              committedStagingPath = committedStage;
              semanticCommitted = true;
              await fsyncDirStrict(ownerDir, this.repoRoot);
            } else {
              semanticCommitted = true;
            }
            await opts?.onDetached?.();
            await assertDeletionLease();
            await artifactLease.assert();
            await rm(ownerDir, { recursive: true, force: true, maxRetries: 3 });
            committedStagingPath = null;
          } catch (error) {
            if (!semanticCommitted) {
              const artifactLeaseError = await detectArtifactLeaseLoss(error);
              if (artifactLeaseError !== null) {
                throw new ArtifactDeletionRecoveryError(
                  `Artifact ${artifactId} deletion lost its artifact lock before commit; ` +
                    'protected staging was left for reconciliation by the next invocation.',
                  artifactId,
                  hadDirectory ? [preparedStage] : [],
                  false,
                  { cause: artifactLeaseError }
                );
              }
              try {
                await reconcileArtifactDeletionStagingLocked({
                  repoRoot: this.repoRoot,
                  config: this.config,
                  store: this.store,
                });
              } catch (recoveryError) {
                throw new ArtifactDeletionRecoveryError(
                  `Artifact ${artifactId} deletion could not commit and restoration failed: ` +
                    `${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
                  artifactId,
                  hadDirectory ? [preparedStage] : [],
                  false,
                  { cause: error }
                );
              }
              throw error;
            }
            throw new ArtifactDeletionRecoveryError(
              `Artifact ${artifactId} was deleted, but protected staging cleanup failed; ` +
                `retry any orcaops command after correcting filesystem access.`,
              artifactId,
              hadDirectory ? [committedStage] : [],
              true,
              { cause: error }
            );
          }
          try {
            await withNonDerivableWriteLease(this.repoRoot, async () => {
              await artifactLease.assert();
              if (this.store.projectionHealth !== 'rebuild_pending') {
                throw new ArtifactDeletionRecoveryError(
                  `Artifact ${artifactId} deletion could not certify its pending projection state.`,
                  artifactId,
                  [],
                  true
                );
              }
              this.store.setProjectionHealth('healthy');
            });
          } catch (error) {
            if (error instanceof ArtifactDeletionRecoveryError) throw error;
            throw new ArtifactDeletionRecoveryError(
              `Artifact ${artifactId} deletion committed, but projection finalization failed; ` +
                'run `orcaops rebuild` before further destructive work.',
              artifactId,
              [],
              true,
              { cause: error }
            );
          }
          return { deleted: true };
        });
      });
    } catch (error) {
      if (
        semanticCommitted &&
        !(error instanceof ArtifactDeletionRecoveryError && error.semanticCommitted)
      ) {
        try {
          await withNonDerivableWriteLease(this.repoRoot, () => {
            if (this.store.projectionHealth === 'healthy') {
              this.store.setProjectionHealth('rebuild_pending');
            }
          });
        } catch (projectionError) {
          throw new ArtifactDeletionRecoveryError(
            `Artifact ${artifactId} deletion committed and its artifact lock was not finalized, ` +
              'but the projection could not be marked pending; stop destructive work and run ' +
              '`orcaops doctor` before recovery.',
            artifactId,
            committedStagingPath === null ? [] : [committedStagingPath],
            true,
            { cause: projectionError }
          );
        }
        throw new ArtifactDeletionRecoveryError(
          `Artifact ${artifactId} deletion committed, but lock finalization failed; ` +
            'run `orcaops rebuild` before further destructive work.',
          artifactId,
          committedStagingPath === null ? [] : [committedStagingPath],
          true,
          { cause: error }
        );
      }
      throw error;
    }
  }

  /**
   * Parse a `plan.md` back through the strict authoring schema. Test/utility
   * surface: nothing in production reads plan.md (it is write-only for
   * humans); this exists so the writer can be held to "never emit a
   * document your own parser rejects", not as a shipping round-trip.
   */
  static async parsePlanMarkdown(filePath: string): Promise<PlanInput> {
    const raw = await readFile(filePath, 'utf8');
    const parsed = parseMarkdown(raw);
    return PlanInputSchema.parse({ ...parsed.frontmatter, schema_version: 4 });
  }

  // ────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────

  /**
   * Fold loader for WRITE paths: refuses when the log carries lossy
   * (non-truncated-tail) corruption. Appending to a lossy history would
   * rebuild projections from survivors and stamp them with a fresh
   * source id — the one way to manufacture the incomplete-but-current
   * snapshot the read-side completeness rule exists to refuse.
   */
  private async loadAllEvents(
    eventLogPath: string,
    sidecarsDir: string,
    artifactId: string
  ): Promise<EventWithPayload[]> {
    const { events, corrupt } = await readEventLog({
      eventLogPath,
      sidecarsDir,
      containmentRoot: this.repoRoot,
    });
    const lossy = corrupt.filter((c) => c.kind !== 'truncated_tail');
    if (lossy.length > 0) {
      // Deliberately UNTYPED, unlike the appendAndMirror preflight twin:
      // this loader never runs inside the contained prior-artifact pin
      // phase, and typing it would silently widen that containment if a
      // future caller routed prior-artifact reads through here.
      throw new Error(
        `artifact ${artifactId}: event log carries corrupt line(s) ` +
          `${lossy.map((c) => String(c.line)).join(', ')} — writes refuse on a lossy ` +
          `history, since rebuilding projections from the survivors would silently drop ` +
          `the lost contribution. Run \`orcaops doctor\` to see every corrupt event-log ` +
          `line for this artifact.`
      );
    }
    return loadEventsWithPayloads(events, {
      sidecarsDir,
      containmentRoot: this.repoRoot,
    });
  }

  /**
   * Corrupt-DROPPING loader for the two fingerprint readers, which
   * deliberately treat a corrupt close as "no manifest for n" so
   * strict-sync hard-fails instead of bypassing (see their docblocks).
   */
  private async loadAllEventsTolerant(
    eventLogPath: string,
    sidecarsDir: string
  ): Promise<EventWithPayload[]> {
    const { events } = await readEventLog({
      eventLogPath,
      sidecarsDir,
      containmentRoot: this.repoRoot,
    });
    return loadEventsWithPayloads(events, {
      sidecarsDir,
      containmentRoot: this.repoRoot,
    });
  }

  private async loadAllEventsForRecovery(
    eventLogPath: string,
    sidecarsDir: string
  ): Promise<{
    events: EventWithPayload[];
    lossyCorrupt: ReturnType<typeof lossyCorruptEvents>;
    lineByEventId: ReadonlyMap<string, number>;
  }> {
    const { events, corrupt, lineByEventId } = await readEventLog({
      eventLogPath,
      sidecarsDir,
      containmentRoot: this.repoRoot,
    });
    const loaded = await loadEventsWithPayloads(events, {
      sidecarsDir,
      containmentRoot: this.repoRoot,
    });
    return { events: loaded, lossyCorrupt: lossyCorruptEvents(corrupt), lineByEventId };
  }

  private async persistAndReturn<T>(
    recovery: RecoveryResult<T>,
    targetPath: string,
    artifactId: string
  ): Promise<T | null> {
    switch (recovery.status) {
      case 'current':
        return recovery.projection;
      case 'rebuilt':
        return recovery.projection;
      case 'no-source':
        return recovery.projection;
      case 'unrecoverable': {
        // Point at doctor only when the refusal cites corrupt log lines —
        // its check inspects events.ndjson, so for a refusal about an
        // unparseable PROJECTION file it would report all-clean and
        // mislead the operator; naming the file is the actionable part.
        // Gated on the structured flag, never on reason prose.
        const doctorHint = recovery.lossCited
          ? ` Run \`orcaops doctor\` to see every corrupt event-log line for this artifact.`
          : '';
        // Reason FIRST: downstream error envelopes truncate long
        // messages, and the absolute target path must never push the
        // actionable reason past the cap.
        throw new RecoveryRefusedError(
          `projection unrecoverable for artifact ${artifactId}: ` +
            `${recovery.reason} (${targetPath}).${doctorHint}`,
          artifactId
        );
      }
    }
  }

  private async loadSummaryFromEvents(events: EventWithPayload[]): Promise<Summary | null> {
    const r = rebuildSummaryFromEvents(events);
    return r ? r.summary : null;
  }
}

function artifactDeletionStagingRoot(repoRoot: string): string {
  return assertResolvedWithin(
    path.join(repoRoot, '.orcaops', 'tmp', 'artifact-deletions'),
    repoRoot,
    'protected artifact deletion root',
    { rejectSymlinks: true }
  );
}

function artifactDeletionOwnerDir(repoRoot: string, artifactId: string): string {
  assertSafePathSegment(artifactId, 'artifact deletion owner');
  return assertResolvedWithin(
    path.join(artifactDeletionStagingRoot(repoRoot), artifactId),
    repoRoot,
    'protected artifact deletion owner',
    { rejectSymlinks: true }
  );
}

function artifactDeletionStagePhase(name: string): 'prepared' | 'committed' | null {
  if (/^prepared-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(name)) {
    return 'prepared';
  }
  if (/^committed-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(name)) {
    return 'committed';
  }
  return null;
}

async function withArtifactDeletionLock<T>(
  repoRoot: string,
  fn: (assertLease: () => Promise<void>) => Promise<T>
): Promise<T> {
  const lock = new ArtifactLock({
    locksDir: locksDir(repoRoot),
    containmentRoot: repoRoot,
    heartbeatIntervalMs: 30_000,
  });
  return lock.withLock(ARTIFACT_DELETION_LOCK_KEY, async (lease) => {
    await lease.verify();
    const result = await fn(() => lease.verify());
    await lease.verify();
    return result;
  });
}

export async function inspectArtifactDeletionStaging(
  repoRoot: string
): Promise<ArtifactDeletionStagingInspection> {
  let root: string;
  try {
    root = artifactDeletionStagingRoot(repoRoot);
  } catch (error) {
    return { entries: [], problems: [error instanceof Error ? error.message : String(error)] };
  }
  let owners;
  try {
    owners = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], problems: [] };
    return { entries: [], problems: [error instanceof Error ? error.message : String(error)] };
  }

  const entries: ArtifactDeletionStagingEntry[] = [];
  const problems: string[] = [];
  for (const owner of owners) {
    try {
      assertSafePathSegment(owner.name, 'artifact deletion staging owner');
      if (!owner.isDirectory()) {
        problems.push(`unexpected non-directory entry ${JSON.stringify(owner.name)}`);
        continue;
      }
      const ownerDir = artifactDeletionOwnerDir(repoRoot, owner.name);
      const stagedEntries = await readdir(ownerDir, { withFileTypes: true });
      if (stagedEntries.length === 0) continue;
      if (stagedEntries.length !== 1 || !stagedEntries[0].isDirectory()) {
        problems.push(
          `artifact ${owner.name} has ${stagedEntries.length} ambiguous protected staging entries`
        );
        continue;
      }
      assertSafePathSegment(stagedEntries[0].name, 'artifact deletion staging entry');
      const phase = artifactDeletionStagePhase(stagedEntries[0].name);
      if (phase === null) {
        problems.push(
          `artifact ${owner.name} has an unrecognized protected staging entry ` +
            JSON.stringify(stagedEntries[0].name)
        );
        continue;
      }
      entries.push({
        artifact_id: owner.name,
        phase,
        staging_path: assertResolvedWithin(
          path.join(ownerDir, stagedEntries[0].name),
          repoRoot,
          'protected artifact deletion entry',
          { rejectSymlinks: true }
        ),
      });
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  entries.sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  problems.sort();
  return { entries, problems };
}

export async function reconcileArtifactDeletionStaging(opts: {
  repoRoot: string;
  config: Config;
  store: Store;
}): Promise<ArtifactDeletionReconciliation> {
  const { reconciliation } = await withReconciledArtifactDeletionStaging(opts, async () => {});
  return reconciliation;
}

/** Hold the recovery barrier so no new deletion stage can race `fn`. */
export async function withReconciledArtifactDeletionStaging<T>(
  opts: { repoRoot: string; config: Config; store: Store },
  fn: (assertDeletionLease: () => Promise<void>) => Promise<T>
): Promise<{ reconciliation: ArtifactDeletionReconciliation; result: T }> {
  return withArtifactDeletionLock(opts.repoRoot, async (assertLease) => {
    const reconciliation = await reconcileArtifactDeletionStagingLocked(opts);
    await assertLease();
    const result = await fn(assertLease);
    await assertLease();
    return { reconciliation, result };
  });
}

async function reconcileArtifactDeletionStagingLocked(opts: {
  repoRoot: string;
  config: Config;
  store: Store;
}): Promise<ArtifactDeletionReconciliation> {
  const inspection = await inspectArtifactDeletionStaging(opts.repoRoot);
  if (inspection.problems.length > 0) {
    await withNonDerivableWriteLease(opts.repoRoot, () =>
      opts.store.setProjectionHealth('degraded')
    );
    throw new ArtifactDeletionRecoveryError(
      `Protected artifact deletion staging is ambiguous: ${inspection.problems.join('; ')}`,
      null,
      inspection.entries.map((entry) => entry.staging_path),
      false
    );
  }
  if (inspection.entries.length === 0) return { restored: [], removed: [] };

  if (inspection.entries.length !== 1) {
    await withNonDerivableWriteLease(opts.repoRoot, () =>
      opts.store.setProjectionHealth('degraded')
    );
    throw new ArtifactDeletionRecoveryError(
      'More than one artifact deletion recovery record was found; automatic recovery is ambiguous.',
      null,
      inspection.entries.map((entry) => entry.staging_path),
      false
    );
  }

  const entry = inspection.entries[0];
  const target = artifactPathsFor(opts.repoRoot, opts.config, entry.artifact_id).dir;
  if (entry.phase === 'committed') {
    try {
      await withNonDerivableWriteLease(opts.repoRoot, () => {
        if (opts.store.projectionHealth === 'healthy') {
          opts.store.setProjectionHealth('rebuild_pending');
        }
        opts.store.deleteArtifact(entry.artifact_id);
      });
      await rm(path.dirname(entry.staging_path), {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
      return { restored: [], removed: [entry.artifact_id] };
    } catch (error) {
      throw new ArtifactDeletionRecoveryError(
        `Committed artifact ${entry.artifact_id} deletion could not finish recovery.`,
        entry.artifact_id,
        [entry.staging_path],
        true,
        { cause: error }
      );
    }
  }

  try {
    await withNonDerivableWriteLease(opts.repoRoot, async () => {
      if (opts.store.projectionHealth === 'healthy') {
        opts.store.setProjectionHealth('rebuild_pending');
      }
      if (await pathExists(target)) {
        opts.store.setProjectionHealth('degraded');
        throw new ArtifactDeletionRecoveryError(
          `Artifact ${entry.artifact_id} exists in both the hot store and prepared deletion ` +
            'staging; refusing to overwrite either copy.',
          entry.artifact_id,
          [entry.staging_path],
          false
        );
      }
      const root = artifactsRoot(opts.repoRoot, opts.config);
      await mkdirDurable(root, 0o700, root, opts.repoRoot);
      await rename(entry.staging_path, target);
      try {
        await fsyncDirStrict(path.dirname(entry.staging_path), opts.repoRoot);
        await fsyncDirStrict(path.dirname(target), opts.repoRoot);
      } finally {
        await rm(path.dirname(entry.staging_path), { recursive: true, force: true }).catch(
          () => {}
        );
      }
    });
    return { restored: [entry.artifact_id], removed: [] };
  } catch (error) {
    if (error instanceof ArtifactDeletionRecoveryError) throw error;
    throw new ArtifactDeletionRecoveryError(
      `Prepared artifact ${entry.artifact_id} deletion could not restore protected bytes.`,
      entry.artifact_id,
      [entry.staging_path],
      false,
      { cause: error }
    );
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * The cross-checkpoint step-claim invariants `rebuildAllCheckpointsFromEvents`
 * enforces during a raw fold, restated over recovered `Checkpoint` values so
 * the projection-backed plural read applies them too: one step_id may be
 * claimed by at most one closed cp, declared by at most one open cp, and
 * never declared open while claimed closed.
 */
function assertCheckpointStepClaimsDisjoint(cps: readonly Checkpoint[], artifactId: string): void {
  const closedClaims = new Map<string, number>();
  for (const cp of cps) {
    if (cp.status !== 'closed') continue;
    for (const stepId of cp.completed_step_ids) {
      const prior = closedClaims.get(stepId);
      if (prior !== undefined && prior !== cp.n) {
        throw new RecoveryRefusedError(
          `readCheckpointsRecovered: step_id ${stepId} is claimed by both closed cp ` +
            `#${prior} and closed cp #${cp.n} (artifact ${artifactId}) — log corruption.`,
          artifactId
        );
      }
      closedClaims.set(stepId, cp.n);
    }
  }
  const openDeclares = new Map<string, number>();
  for (const cp of cps) {
    if (cp.status !== 'open') continue;
    for (const stepId of cp.declared_step_ids) {
      const priorOpen = openDeclares.get(stepId);
      if (priorOpen !== undefined && priorOpen !== cp.n) {
        throw new RecoveryRefusedError(
          `readCheckpointsRecovered: step_id ${stepId} is declared by both open cp ` +
            `#${priorOpen} and open cp #${cp.n} (artifact ${artifactId}) — log corruption.`,
          artifactId
        );
      }
      openDeclares.set(stepId, cp.n);
      const closedHolder = closedClaims.get(stepId);
      if (closedHolder !== undefined) {
        throw new RecoveryRefusedError(
          `readCheckpointsRecovered: step_id ${stepId} is declared by open cp #${cp.n} ` +
            `but already claimed by closed cp #${closedHolder} (artifact ${artifactId}) — ` +
            `log corruption.`,
          artifactId
        );
      }
    }
  }
}

/**
 * Read + strict-parse a projection file for recovery. Three-way result:
 * a parsed projection, null for an ABSENT file, or `{unreadable: true}`
 * for a file that exists but is garbled or strict-rejected — recovery
 * rebuilds an unreadable projection from surviving events, and refuses
 * loudly when nothing survives to rebuild from, so the caller never
 * surfaces a bare SyntaxError/ZodError with no next step. Containment
 * and I/O errors other than ENOENT still throw.
 */
async function readProjectionForRecovery<T>(
  filePath: string,
  containmentRoot: string,
  parse: (raw: unknown) => T
): Promise<{ value: T; source_event_id: string } | { unreadable: true } | null> {
  let onDisk: unknown;
  try {
    onDisk = await readJsonOptional(filePath, containmentRoot);
  } catch (err) {
    if (err instanceof SyntaxError) return { unreadable: true };
    throw err;
  }
  if (onDisk === null) return null;
  try {
    const value = parse(onDisk);
    const sourceEventId = extractSourceEventId(onDisk);
    if (sourceEventId === null) return { unreadable: true };
    return { value, source_event_id: sourceEventId };
  } catch (err) {
    if (err instanceof ZodError) return { unreadable: true };
    throw err;
  }
}

async function readJsonOptional(
  filePath: string,
  containmentRoot?: string
): Promise<unknown | null> {
  const target =
    containmentRoot === undefined
      ? filePath
      : assertResolvedWithin(filePath, containmentRoot, 'artifact projection read', {
          rejectSymlinks: true,
        });
  try {
    const raw = await readFile(target, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Minimal structural view of a `checkpoint_closed` event payload — just
 * the fields `readCheckpointDiffFingerprint` reads. Deliberately NOT
 * rebuilders' `ClosedEventPayload` (module-private; importing it would
 * widen that surface).
 */
interface ClosedFingerprintPayload {
  n?: number;
  diff_fingerprint_manifest?: DiffFingerprintManifest;
}

function extractSourceEventId(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const v = (json as { source_event_id?: unknown }).source_event_id;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function normalizePriorPayload(
  priorEvent: EventRecord,
  loaded: readonly EventWithPayload[],
  extractReplayShape: ((priorPayload: unknown) => unknown) | undefined
): unknown {
  const match = loaded.find((e) => e.record.event_id === priorEvent.event_id);
  if (!match) return undefined;
  return extractReplayShape ? extractReplayShape(match.payload) : match.payload;
}

function checkpointToRow(cp: Checkpoint): CheckpointRow {
  if (cp.status === 'open') {
    return {
      status: 'open',
      artifact_id: cp.artifact_id,
      n: cp.n,
      declared_step_ids: [...cp.declared_step_ids],
      agent_session_id: cp.agent_session_id ?? null,
      policy_exceptions: cp.policy_exceptions,
      plan_revision_id: cp.plan_revision_id,
      opened_at: cp.opened_at,
      head_sha: cp.head_sha,
      open_plan_revision_event_id: cp.open_plan_revision_event_id,
    };
  }
  if (cp.status === 'closed') {
    return {
      status: 'closed',
      artifact_id: cp.artifact_id,
      n: cp.n,
      declared_step_ids: [...cp.declared_step_ids],
      agent_session_id: cp.agent_session_id ?? null,
      policy_exceptions: cp.policy_exceptions,
      plan_revision_id: cp.plan_revision_id,
      opened_at: cp.opened_at,
      closed_at: cp.closed_at,
      summary: cp.summary,
      files_changed: [...cp.files_changed],
      decisions: [...cp.decisions],
      uncertainty: [...cp.uncertainty],
      done_criteria: [...cp.done_criteria],
      completed_step_ids: [...cp.completed_step_ids],
      head_sha: cp.head_sha,
      open_plan_revision_event_id: cp.open_plan_revision_event_id,
    };
  }
  return {
    status: 'abandoned',
    artifact_id: cp.artifact_id,
    n: cp.n,
    declared_step_ids: [...cp.declared_step_ids],
    agent_session_id: cp.agent_session_id ?? null,
    policy_exceptions: cp.policy_exceptions,
    plan_revision_id: cp.plan_revision_id,
    opened_at: cp.opened_at,
    abandoned_at: cp.abandoned_at,
    reason: cp.reason,
    head_sha: cp.head_sha,
    open_plan_revision_event_id: cp.open_plan_revision_event_id,
  };
}

/**
 * Reconstruct the agent's input shape (per `PlanReviseStepInputSchema`)
 * from a committed `plan_revised` event payload. The committed payload
 * carries the full materialized plan_steps with every step_id populated;
 * the input shape carries `step_id` as optional (omitted = "mint a new
 * one"). To make payload-equality replay work, we strip the materialized
 * step_ids that were minted (i.e., listed in `step_lineage.added`) so
 * the prior shape matches an agent's same-call retry.
 */
function extractInputStepShapeFromCommitted(payload: Record<string, unknown>): Array<{
  step_id: string | null;
  text: string;
  label: string;
  acceptance_criteria: Array<{ criterion_id: string | null; text: string }>;
}> {
  const planSteps = Array.isArray(payload.plan_steps) ? payload.plan_steps : [];
  const lineage = (payload.step_lineage ?? {}) as { added?: unknown };
  const addedSet = new Set<string>(
    Array.isArray(lineage.added)
      ? lineage.added.filter((x): x is string => typeof x === 'string')
      : []
  );
  // criterion_ids the input OMITTED this revision — both those minted fresh
  // (`added`) and those auto-carried from a prior id (`carried`). Null these so
  // a same-call retry that re-omitted the same texts matches as a replay. The
  // carried half is critical: a carried id is concrete in the committed plan but
  // absent from `added`, so without unioning `carried` the retry's null would
  // not match the committed concrete id and the call would false-conflict. Reads
  // RAW committed JSON (not Zod-parsed), so no schema narrowing applies here —
  // guard each field with Array.isArray before spreading untyped values.
  const criterionLineage = (payload.criterion_lineage ?? {}) as {
    added?: unknown;
    carried?: unknown;
  };
  const omittedCriterionSet = new Set<string>([
    ...(Array.isArray(criterionLineage.added)
      ? criterionLineage.added.filter((x): x is string => typeof x === 'string')
      : []),
    ...(Array.isArray(criterionLineage.carried)
      ? criterionLineage.carried.filter((x): x is string => typeof x === 'string')
      : []),
  ]);
  return planSteps.map((s) => {
    if (typeof s !== 'object' || s === null) {
      return { step_id: null, text: '', label: '', acceptance_criteria: [] };
    }
    const obj = s as {
      step_id?: unknown;
      text?: unknown;
      label?: unknown;
      acceptance_criteria?: unknown;
    };
    const stepId = typeof obj.step_id === 'string' ? obj.step_id : null;
    const text = typeof obj.text === 'string' ? obj.text : '';
    const label = typeof obj.label === 'string' ? obj.label : '';
    const acceptance_criteria = (
      Array.isArray(obj.acceptance_criteria) ? obj.acceptance_criteria : []
    ).map((c) => {
      const co = (typeof c === 'object' && c !== null ? c : {}) as {
        criterion_id?: unknown;
        text?: unknown;
      };
      const cid = typeof co.criterion_id === 'string' ? co.criterion_id : null;
      const ctext = typeof co.text === 'string' ? co.text : '';
      return {
        criterion_id: cid !== null && omittedCriterionSet.has(cid) ? null : cid,
        text: ctext,
      };
    });
    return {
      step_id: stepId !== null && addedSet.has(stepId) ? null : stepId,
      text,
      label,
      acceptance_criteria,
    };
  });
}

/** Pull the acknowledgement list out of a committed plan_revised payload (sorted). */
function extractAckDrops(payload: Record<string, unknown>): string[] {
  const v = payload.acknowledge_drops_completed_steps;
  if (!Array.isArray(v)) return [];
  return [...v.filter((x): x is string => typeof x === 'string')].sort();
}

function extractAckCriteriaChanges(payload: Record<string, unknown>): string[] {
  const v = payload.acknowledge_criteria_changes;
  if (!Array.isArray(v)) return [];
  return [...v.filter((x): x is string => typeof x === 'string')].sort();
}

function resolveRevisionAgentSessionForReplay(
  events: readonly EventWithPayload[],
  idempotencyKey: string,
  inputValue: string | null | undefined
): string | null {
  if (inputValue !== undefined) return inputValue;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.record.type === 'plan_revised' && event.record.idempotency_key === idempotencyKey) {
      const payload = event.payload as { agent_session_id?: unknown };
      return typeof payload.agent_session_id === 'string' ? payload.agent_session_id : null;
    }
  }
  return rebuildPlanFromEvents(events)?.plan.agent_session_id ?? null;
}

/**
 * Pull THIS revision's new plan decisions out of a committed `plan_revised`
 * payload, reconstructed to the base input shape (`{ decision, reason,
 * alternatives_considered? }`, no `revision_n`) so canonical-JSON equality
 * matches a same-payload replay.
 *
 * The committed payload carries the full cumulative set (each entry tagged with
 * the revision it was made at); this revision's new entries are those whose
 * `revision_n` equals the payload's own. Explicit field reconstruction (not a
 * `delete`) guarantees only base-shape keys survive. `Array.isArray`-guarded
 * because the payload is raw untyped JSON — never spread an unchecked value.
 */
function extractNewDecisionsFromCommitted(
  payload: Record<string, unknown>
): Array<Record<string, unknown>> {
  if (!Array.isArray(payload.decisions)) return [];
  const revisionN = payload.revision_n;
  const out: Array<Record<string, unknown>> = [];
  for (const d of payload.decisions) {
    if (typeof d !== 'object' || d === null) continue;
    const dec = d as Record<string, unknown>;
    if (dec.revision_n !== revisionN) continue;
    const base: Record<string, unknown> = { decision: dec.decision, reason: dec.reason };
    if (dec.alternatives_considered !== undefined) {
      base.alternatives_considered = dec.alternatives_considered;
    }
    out.push(base);
  }
  return out;
}

// ── markdown serializers ────────────────────────────────────────────

function planMarkdown(plan: Plan): string {
  const frontmatter: Record<string, unknown> = {
    artifact_id: plan.artifact_id,
    branch: plan.branch,
    base_sha: plan.base_sha,
    agent: plan.agent,
    agent_session_id: plan.agent_session_id,
    task: plan.task,
    label: plan.label,
    plan_steps: plan.plan_steps,
    touched_scope: plan.touched_scope,
  };
  // Every remaining key is emitted unconditionally, empty or null:
  // parsePlanMarkdown applies the strict authoring schema, and the writer must
  // never emit a document its own parser rejects.
  frontmatter.non_goals = plan.non_goals;
  frontmatter.decisions = plan.decisions;
  if (plan.origin !== undefined) frontmatter.origin = plan.origin;
  frontmatter.started_at = plan.started_at;
  frontmatter.revision_n = plan.revision_n;
  frontmatter.revised_at = plan.revised_at;
  frontmatter.rationale = plan.rationale;
  frontmatter.prior_plan_event_id = plan.prior_plan_event_id;
  frontmatter.step_lineage = plan.step_lineage;
  frontmatter.criterion_lineage = plan.criterion_lineage;
  return serializeMarkdown({
    frontmatter,
    body: `# ${plan.task}`,
  });
}

function checkpointMarkdown(cp: Checkpoint): string {
  // v4: snapshot boundaries + fingerprint summary appear in
  // frontmatter so reviewers can see capture status at a glance.
  // The full diff_fingerprint_manifest is intentionally NOT in the
  // markdown — it lives only in the close event payload (with
  // sidecar spill at >8 KB) since hunk-by-hunk hash listings are too
  // dense for at-a-glance reading. Use `orcaops fingerprint show`
  // for the rendered manifest.
  if (cp.status === 'open') {
    return serializeMarkdown({
      frontmatter: {
        artifact_id: cp.artifact_id,
        n: cp.n,
        status: 'open',
        declared_step_ids: cp.declared_step_ids,
        agent_session_id: cp.agent_session_id,
        policy_exceptions: cp.policy_exceptions,
        plan_revision_id: cp.plan_revision_id,
        opened_at: cp.opened_at,
        head_sha: cp.head_sha,
        open_snapshot: cp.open_snapshot,
      },
      body: `# Checkpoint #${cp.n} — open`,
    });
  }
  if (cp.status === 'closed') {
    return serializeMarkdown({
      frontmatter: {
        artifact_id: cp.artifact_id,
        n: cp.n,
        status: 'closed',
        declared_step_ids: cp.declared_step_ids,
        agent_session_id: cp.agent_session_id,
        policy_exceptions: cp.policy_exceptions,
        plan_revision_id: cp.plan_revision_id,
        opened_at: cp.opened_at,
        closed_at: cp.closed_at,
        files_changed: cp.files_changed,
        decisions: cp.decisions,
        uncertainty: cp.uncertainty,
        done_criteria: cp.done_criteria,
        // Optional-absent: frontmatter key only when cited.
        ...(cp.verification !== undefined && cp.verification.length > 0
          ? { verification: cp.verification }
          : {}),
        // Optional-absent: only on overlap-partitioned closes.
        ...(cp.window_overlap !== undefined ? { window_overlap: cp.window_overlap } : {}),
        // Optional-absent: only on unmerged-degraded closes.
        ...(cp.attribution_degraded !== undefined
          ? { attribution_degraded: cp.attribution_degraded }
          : {}),
        completed_step_ids: cp.completed_step_ids,
        head_sha: cp.head_sha,
        ...(cp.open_head_sha !== undefined ? { open_head_sha: cp.open_head_sha } : {}),
        open_snapshot: cp.open_snapshot,
        close_snapshot: cp.close_snapshot,
        diff_fingerprint_summary: cp.diff_fingerprint_summary,
      },
      body: cp.summary,
    });
  }
  return serializeMarkdown({
    frontmatter: {
      artifact_id: cp.artifact_id,
      n: cp.n,
      status: 'abandoned',
      declared_step_ids: cp.declared_step_ids,
      agent_session_id: cp.agent_session_id,
      policy_exceptions: cp.policy_exceptions,
      plan_revision_id: cp.plan_revision_id,
      opened_at: cp.opened_at,
      abandoned_at: cp.abandoned_at,
      reason: cp.reason,
      head_sha: cp.head_sha,
      open_snapshot: cp.open_snapshot,
      abandon_snapshot: cp.abandon_snapshot,
    },
    body: `# Checkpoint #${cp.n} — abandoned\n\n${cp.reason}`,
  });
}

function summaryMarkdown(s: Summary): string {
  return serializeMarkdown({
    frontmatter: {
      artifact_id: s.artifact_id,
      ts: s.ts,
      outcome: s.outcome,
      tests_written: s.tests_written,
      tests_run: s.tests_run,
      open_items: s.open_items,
      deferred_decisions: s.deferred_decisions,
      ...(s.accepted_warnings === undefined ? {} : { accepted_warnings: s.accepted_warnings }),
      head_sha: s.head_sha,
    },
    body: s.outcome,
  });
}

function validateWarningAcceptance(
  artifactId: string,
  acceptedWarnings: readonly AcceptedWarning[],
  events: readonly EventWithPayload[]
): void {
  const reviewId = acceptedWarnings[0]?.review_id;
  let latestReview: EventWithPayload | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.record.type === 'pre_pr_checked') {
      latestReview = events[index];
      break;
    }
  }
  if (!latestReview || latestReview.record.event_id !== reviewId) {
    throw new WarningAcceptanceInvalidError(
      `Warning acceptance is stale for artifact "${artifactId}": review "${reviewId ?? '<missing>'}" ` +
        `is not the latest pre-PR review. Re-run finish and review the current findings.`,
      artifactId
    );
  }

  const marker = PrePrCheckedPayloadSchema.safeParse(latestReview.payload);
  if (!marker.success || marker.data.outcome !== 'needs_attention' || !marker.data.run_ids) {
    throw new WarningAcceptanceInvalidError(
      `Pre-PR review "${reviewId}" is not an accept-able warning review. Re-run finish.`,
      artifactId
    );
  }

  const runsById = new Map<string, EvaluatorRunPayload>();
  for (const event of events) {
    if (event.record.type !== 'evaluator_run_recorded') continue;
    const parsed = EvaluatorRunPayloadSchema.safeParse(event.payload);
    if (parsed.success) runsById.set(parsed.data.run_id, parsed.data);
  }

  const expected = new Map<string, string>();
  for (const runId of marker.data.run_ids) {
    const run = runsById.get(runId);
    if (!run) {
      throw new WarningAcceptanceInvalidError(
        `Pre-PR review "${reviewId}" refers to missing evaluator run "${runId}". Re-run finish.`,
        artifactId
      );
    }
    if (run.artifact_id !== artifactId || run.phase !== 'pre-pr') {
      throw new WarningAcceptanceInvalidError(
        `Run "${runId}" does not belong to the pre-PR review for artifact "${artifactId}". ` +
          `Re-run finish.`,
        artifactId
      );
    }
    if (run.severity !== 'warn') continue;
    if (run.run_status === 'error') {
      throw new WarningAcceptanceInvalidError(
        `Evaluator "${run.evaluator_ref}" failed during review "${reviewId}". ` +
          `Errors cannot be accepted; re-run finish.`,
        artifactId
      );
    }
    if (run.run_status === 'completed' && run.verdict === 'violation') {
      expected.set(run.run_id, run.evaluator_ref);
    }
  }

  const supplied = new Set(acceptedWarnings.map((warning) => warning.run_id));
  if (
    supplied.size !== expected.size ||
    [...expected.keys()].some((runId) => !supplied.has(runId))
  ) {
    throw new WarningAcceptanceInvalidError(
      `Warning acceptance for review "${reviewId}" must cover its complete warning set exactly ` +
        `(expected: [${[...expected.keys()].join(', ')}]).`,
      artifactId
    );
  }
  for (const warning of acceptedWarnings) {
    if (expected.get(warning.run_id) !== warning.evaluator_ref) {
      throw new WarningAcceptanceInvalidError(
        `Accepted run "${warning.run_id}" does not belong to evaluator ` +
          `"${warning.evaluator_ref}" in review "${reviewId}".`,
        artifactId
      );
    }
  }
}

function acceptedWarningsEqual(
  left: readonly AcceptedWarning[] | undefined,
  right: readonly AcceptedWarning[] | undefined
): boolean {
  const normalizedLeft = left === undefined ? null : normalizeAcceptedWarnings(left);
  const normalizedRight = right === undefined ? null : normalizeAcceptedWarnings(right);
  return canonicalJson(normalizedLeft) === canonicalJson(normalizedRight);
}
