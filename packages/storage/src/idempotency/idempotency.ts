import { createHash } from 'node:crypto';

import { PlanIdempotencyPendingError } from '../artifacts/errors.js';
import { canonicalJson } from '../events/canonical-json.js';
import type { EventRecord, EventType } from '../events/event-log.js';
import type { IdempotencyBlockRow, Store } from '../store/sqlite.js';

/**
 * Idempotency dispatch for mutating capture inputs.
 *
 * Idempotency is keyed on every mutating capture. Two scopes:
 *
 *   - **Project-wide for `plan_captured`:** capture-plan creates the
 *     artifact, so a retry would mint a fresh UUIDv7 if we didn't
 *     dedup at the project level. Lookup uses the SQLite
 *     `plan_idempotency` table; the PRIMARY KEY constraint is the
 *     race coordinator for concurrent calls (insert-first pattern).
 *
 *   - **Artifact-scoped for the rest:** checkpoint, summary, evaluator
 *     runs, block resolutions. Lookup scans the artifact's event log
 *     for events of the same `type` with the same `idempotency_key`.
 *
 * Conflict semantics (apply to both scopes):
 *   - Same key + structurally-equal payload → return prior result;
 *     status `IDEMPOTENT_REPLAY` (informational).
 *   - Same key + DIFFERENT payload → reject with status
 *     `IDEMPOTENCY_CONFLICT`. Programming bug; the caller is making
 *     a different decision under the same key.
 *
 * Payload equality uses the canonical JSON serialization (one rule
 * end-to-end with the per-line event-record checksum).
 */

export type IdempotencyOutcome<TArtifactId> =
  | { kind: 'first-call' }
  | { kind: 'replay'; artifactId: TArtifactId; rotted?: false }
  | { kind: 'conflict'; artifactId: TArtifactId };

// ── Project-wide (capture plan) ──────────────────────────────────────

export interface PlanIdempotencyContext {
  store: Store;
  idempotencyKey: string;
  /**
   * Canonical-JSON-shaped payload that uniquely identifies the plan
   * being captured. Two calls with the same key but different
   * payloads should be treated as a conflict; the comparison is
   * canonical-JSON byte equality.
   *
   * The `plan_idempotency` table persists key + artifact_id +
   * created_at only; payload comparison happens via the optional
   * `loadPriorPayload` callback, which reads the matched artifact's
   * `plan_captured` event. Without the callback, conflict detection is
   * key-only (any second call with the same key replays).
   */
  payload: unknown;
  /**
   * Mint a fresh artifact_id (UUIDv7). Called when the lookup
   * returns no prior call AND the insert succeeds (no race lost).
   * The factory is called inside the insert path so the caller can
   * pin a specific id for testing.
   */
  mintArtifactId: () => string;
  /**
   * ISO timestamp to record on insert (treated as `created_at` in
   * the plan_idempotency table). Defaults to the current time.
   */
  now?: () => string;
  /**
   * Optional callback to load the prior call's plan_captured payload
   * for canonical-equality comparison. When omitted, the helper does
   * key-only matching: any second call with the same key returns
   * `replay`. Wiring it to read from the matched artifact's
   * events.ndjson enables true `IDEMPOTENCY_CONFLICT` detection when
   * payloads differ.
   */
  loadPriorPayload?: (priorArtifactId: string) => Promise<unknown> | unknown;
  /**
   * Whether the reserved artifact has a PUBLISHED plan. A reservation
   * row alone proves only that a capture STARTED: replaying it before
   * the plan exists would report success for a planless artifact.
   * Adoption and reclamation were both tried and refuted (a live winner
   * cannot be distinguished from a dead one without a coordinator), so
   * a planless reservation throws `PlanIdempotencyPendingError` — a
   * loud, retryable refusal. The failure path's atomic rollback removes
   * its own reservation, so the error persists only across a hard
   * crash. A post-append projection failure is recovered by rebuilding
   * and retrying the same key; pre-append failures are rolled back by
   * the capture path when it can prove that no durable event landed.
   */
  hasPublishedPlan?: (artifactId: string) => boolean;
}

export interface PlanIdempotencyResult {
  artifactId: string;
  outcome: 'created' | 'replay' | 'conflict';
}

export async function lookupOrInsertPlanIdempotency(
  ctx: PlanIdempotencyContext
): Promise<PlanIdempotencyResult> {
  const now = ctx.now ?? (() => new Date().toISOString());
  const prior = ctx.store.lookupPlanIdempotency(ctx.idempotencyKey);
  if (prior !== null) {
    assertPublishedOrPending(prior.artifact_id, ctx);
    return resolvePriorPlanCall(prior.artifact_id, ctx);
  }

  const candidateArtifactId = ctx.mintArtifactId();
  try {
    ctx.store.insertPlanIdempotency({
      idempotency_key: ctx.idempotencyKey,
      artifact_id: candidateArtifactId,
      created_at: now(),
    });
    return { artifactId: candidateArtifactId, outcome: 'created' };
  } catch (err) {
    if (!isPrimaryKeyConflict(err)) throw err;
    // Race lost — re-read the winner and treat as replay/conflict.
    const winner = ctx.store.lookupPlanIdempotency(ctx.idempotencyKey);
    if (winner === null) {
      // The PRIMARY KEY constraint fired but the row vanished — should
      // be impossible without a parallel truncatePlanIdempotency call,
      // which doesn't happen on the live capture path. Re-throw to
      // surface the anomaly.
      throw err;
    }
    assertPublishedOrPending(winner.artifact_id, ctx);
    return resolvePriorPlanCall(winner.artifact_id, ctx);
  }
}

/**
 * Refuse loudly when a matched reservation has no published plan —
 * every branch that resolves a prior call (direct lookup AND the
 * insert-race loser) must pass through this, or a phantom replay of a
 * planless artifact slips out.
 */
function assertPublishedOrPending(artifactId: string, ctx: PlanIdempotencyContext): void {
  if (ctx.hasPublishedPlan !== undefined && !ctx.hasPublishedPlan(artifactId)) {
    throw new PlanIdempotencyPendingError(ctx.idempotencyKey, artifactId);
  }
}

async function resolvePriorPlanCall(
  priorArtifactId: string,
  ctx: PlanIdempotencyContext
): Promise<PlanIdempotencyResult> {
  if (ctx.loadPriorPayload === undefined) {
    // No `loadPriorPayload` supplied: treat any matched key as replay.
    return { artifactId: priorArtifactId, outcome: 'replay' };
  }
  const priorPayload = await ctx.loadPriorPayload(priorArtifactId);
  const same = canonicalJson(priorPayload) === canonicalJson(ctx.payload);
  return {
    artifactId: priorArtifactId,
    outcome: same ? 'replay' : 'conflict',
  };
}

function isPrimaryKeyConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; message?: string };
  if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return true;
  }
  // better-sqlite3 sometimes reports as plain SQLITE_CONSTRAINT with the
  // primary-key reason in the message. Be conservative.
  if (typeof e.message === 'string' && /UNIQUE|PRIMARY KEY/i.test(e.message)) return true;
  return false;
}

// ── Artifact-scoped (checkpoint / summary / evaluator-run / block) ──

export interface ArtifactScopedIdempotencyInput {
  /** Events read from the artifact's event log (already filtered for corruption). */
  events: readonly EventRecord[];
  /** Event type the new call would write (for example, `checkpoint_closed`). */
  type: EventType;
  /** Idempotency key on the new call. */
  idempotencyKey: string;
  /**
   * Canonical-JSON-shaped payload of the new call. Used for
   * structural equality against the prior call's payload.
   */
  payload: unknown;
  /**
   * Resolve the prior event's payload for comparison. Receives the
   * matched event record. Inline events provide payload directly;
   * sidecar events need a sidecar read (the caller passes a closure
   * that knows where the sidecars live).
   */
  loadPriorPayload: (priorEvent: EventRecord) => Promise<unknown> | unknown;
}

export type ArtifactScopedResult =
  | { kind: 'first-call' }
  | { kind: 'replay'; priorEventId: string }
  | { kind: 'conflict'; priorEventId: string };

/**
 * Find the latest event of the given `type` whose `idempotency_key`
 * matches. Returns first-call if none. Compares payloads with
 * canonical JSON to distinguish replay vs conflict.
 *
 * Caller is responsible for having read the event log via
 * `readEventLog` (which filters out corrupt entries — those should
 * never be a basis for replay).
 */
export async function findArtifactScopedReplay(
  input: ArtifactScopedIdempotencyInput
): Promise<ArtifactScopedResult> {
  // Walk in reverse so the latest match wins (the same key on an old
  // event followed by a fresh one with the same key + same payload
  // should still resolve as replay against the most recent write).
  for (let i = input.events.length - 1; i >= 0; i--) {
    const ev = input.events[i];
    if (ev.type !== input.type) continue;
    if (ev.idempotency_key !== input.idempotencyKey) continue;
    const priorPayload = await input.loadPriorPayload(ev);
    const same = canonicalJson(priorPayload) === canonicalJson(input.payload);
    return same
      ? { kind: 'replay', priorEventId: ev.event_id }
      : { kind: 'conflict', priorEventId: ev.event_id };
  }
  return { kind: 'first-call' };
}

// ── Three-outcome idempotency (committed / soft_blocked / hard_rejected) ──
//
// Pre-append evaluator gates can reject a write without
// producing an event, so the event log alone can't represent every
// idempotency outcome. The `idempotency_blocks` table holds records
// for non-event outcomes (soft_blocked + hard_rejected); committed
// outcomes still live in the event log.

/**
 * Compute the canonical-JSON sha256 of a payload. Used as the
 * idempotency record's `payload_hash` so same-key/different-payload
 * conflicts can be detected across all three outcomes.
 */
export function computePayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * Combined lookup that scans both the artifact's event log (for
 * `committed` outcomes) and the `idempotency_blocks` table (for
 * `soft_blocked` / `hard_rejected` outcomes). Returns the resolution
 * to be applied by the caller.
 *
 * `currentFingerprint` is the evaluator fingerprint that would be
 * applied on the new call — pass `undefined` when the call doesn't
 * involve evaluator-gated logic. For soft_blocked replay, the cached
 * fingerprint is compared to this value: match → replay cached
 * envelope; mismatch → re-evaluate (the cache is stale).
 */
export type ThreeOutcomeLookupResult =
  | { kind: 'first-call' }
  | { kind: 'replay-committed'; priorEventId: string }
  | { kind: 'replay-soft-blocked'; envelope: unknown }
  | {
      kind: 'reevaluate';
      priorOutcome: 'soft_blocked' | 'hard_rejected';
      reason: 'fingerprint-mismatch' | 'hard-rejected-can-clear';
    }
  | { kind: 'conflict'; priorOutcome: 'committed' | 'soft_blocked' | 'hard_rejected' };

export interface ThreeOutcomeLookupInput {
  store: Store;
  events: readonly EventRecord[];
  artifactId: string;
  type: EventType;
  idempotencyKey: string;
  /** The new call's full payload. Hashed for conflict detection. */
  payload: unknown;
  /**
   * Optional raw-intent shape for blocked attempts. Committed replay can
   * compare resolved output while a rejection must remain stable across
   * later state changes.
   */
  blockedPayload?: unknown;
  /**
   * Resolve the prior committed event's payload for canonical-equality
   * comparison against the new call. Same shape as
   * `findArtifactScopedReplay`'s callback.
   */
  loadPriorPayload: (priorEvent: EventRecord) => Promise<unknown> | unknown;
  /**
   * Current evaluator fingerprint applied to the new call. Required
   * for evaluator-gated event types (e.g., `checkpoint_opened`); pass
   * `undefined` for non-gated types. When undefined, soft_blocked
   * cache hits replay without fingerprint validation (treated as
   * always-stale → re-evaluate).
   */
  currentFingerprint?: string;
}

export async function findThreeOutcomeIdempotency(
  input: ThreeOutcomeLookupInput
): Promise<ThreeOutcomeLookupResult> {
  const committed = await findCommittedReplay({
    events: input.events,
    type: input.type,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    loadPriorPayload: input.loadPriorPayload,
  });
  if (committed.kind !== 'first-call') return committed;

  return findBlockedReplay({
    store: input.store,
    artifactId: input.artifactId,
    type: input.type,
    idempotencyKey: input.idempotencyKey,
    payload: input.blockedPayload ?? input.payload,
    currentFingerprint: input.currentFingerprint,
  });
}

/**
 * Stage 1 of the three-outcome lookup: scan the event log for a
 * matching `committed` event. Returns 'first-call' when no record
 * exists in the log; 'replay-committed' on payload match;
 * 'conflict' on payload mismatch.
 *
 * Designed to be called BEFORE the caller has any evaluator-context
 * dependency. This is what makes committed-replay deterministic
 * across evaluator-registry drift: a previously-committed open is
 * replayable even if the evaluators that originally gated it have
 * since been deleted, made invalid, or had their args changed.
 */
export async function findCommittedReplay(input: {
  events: readonly EventRecord[];
  type: EventType;
  idempotencyKey: string;
  payload: unknown;
  loadPriorPayload: (priorEvent: EventRecord) => Promise<unknown> | unknown;
}): Promise<
  | { kind: 'first-call' }
  | { kind: 'replay-committed'; priorEventId: string }
  | { kind: 'conflict'; priorOutcome: 'committed' }
> {
  const newPayloadHash = computePayloadHash(input.payload);
  for (let i = input.events.length - 1; i >= 0; i--) {
    const ev = input.events[i];
    if (ev.type !== input.type) continue;
    if (ev.idempotency_key !== input.idempotencyKey) continue;
    const priorPayload = await input.loadPriorPayload(ev);
    const priorHash = computePayloadHash(priorPayload);
    if (priorHash === newPayloadHash) {
      return { kind: 'replay-committed', priorEventId: ev.event_id };
    }
    return { kind: 'conflict', priorOutcome: 'committed' };
  }
  return { kind: 'first-call' };
}

/**
 * Stage 2 of the three-outcome lookup: scan the
 * `idempotency_blocks` table for a matching soft_blocked /
 * hard_rejected record. Caller must have already ruled out
 * committed replay via `findCommittedReplay` — otherwise a same-key
 * call with a prior committed event will be misclassified as
 * first-call here.
 *
 * `currentFingerprint` is the evaluator fingerprint applied to the
 * new call. Pass `undefined` when the call has no evaluator-gated
 * logic (close, abandon). With undefined, soft_blocked records
 * always re-evaluate (treated as always-stale).
 */
export async function findBlockedReplay(input: {
  store: Store;
  artifactId: string;
  type: EventType;
  idempotencyKey: string;
  payload: unknown;
  currentFingerprint?: string;
}): Promise<
  | { kind: 'first-call' }
  | { kind: 'replay-soft-blocked'; envelope: unknown }
  | {
      kind: 'reevaluate';
      priorOutcome: 'soft_blocked' | 'hard_rejected';
      reason: 'fingerprint-mismatch' | 'hard-rejected-can-clear';
    }
  | { kind: 'conflict'; priorOutcome: 'soft_blocked' | 'hard_rejected' }
> {
  const newPayloadHash = computePayloadHash(input.payload);
  const block = input.store.getIdempotencyBlock({
    artifact_id: input.artifactId,
    idempotency_key: input.idempotencyKey,
    event_type: input.type,
  });
  if (block === null) {
    return { kind: 'first-call' };
  }
  if (block.payload_hash !== newPayloadHash) {
    return { kind: 'conflict', priorOutcome: block.outcome };
  }
  if (block.outcome === 'hard_rejected') {
    return {
      kind: 'reevaluate',
      priorOutcome: 'hard_rejected',
      reason: 'hard-rejected-can-clear',
    };
  }
  // soft_blocked: fingerprint-gated replay.
  if (input.currentFingerprint === undefined) {
    return {
      kind: 'reevaluate',
      priorOutcome: 'soft_blocked',
      reason: 'fingerprint-mismatch',
    };
  }
  if (block.evaluator_fingerprint !== input.currentFingerprint) {
    return {
      kind: 'reevaluate',
      priorOutcome: 'soft_blocked',
      reason: 'fingerprint-mismatch',
    };
  }
  if (block.envelope === null) {
    // Should not happen — soft_blocked records are written with an
    // envelope. Defensive: treat as cache miss.
    return {
      kind: 'reevaluate',
      priorOutcome: 'soft_blocked',
      reason: 'fingerprint-mismatch',
    };
  }
  return { kind: 'replay-soft-blocked', envelope: JSON.parse(block.envelope) as unknown };
}

/**
 * Persist a soft_blocked outcome. The caller owns the envelope shape;
 * it's stored verbatim and replayed on matching-fingerprint hits.
 */
export function recordSoftBlocked(input: {
  store: Store;
  artifactId: string;
  idempotencyKey: string;
  type: EventType;
  payload: unknown;
  envelope: unknown;
  evaluatorFingerprint: string;
  now?: () => string;
}): void {
  const now = input.now ?? (() => new Date().toISOString());
  input.store.upsertIdempotencyBlock({
    artifact_id: input.artifactId,
    idempotency_key: input.idempotencyKey,
    event_type: input.type,
    outcome: 'soft_blocked',
    payload_hash: computePayloadHash(input.payload),
    evaluator_fingerprint: input.evaluatorFingerprint,
    envelope: JSON.stringify(input.envelope),
    recorded_at: now(),
  });
}

/**
 * Persist a hard_rejected outcome. Stores only the payload_hash for
 * conflict detection; no envelope (replay always re-evaluates).
 */
export function recordHardRejected(input: {
  store: Store;
  artifactId: string;
  idempotencyKey: string;
  type: EventType;
  payload: unknown;
  now?: () => string;
}): void {
  const now = input.now ?? (() => new Date().toISOString());
  input.store.upsertIdempotencyBlock({
    artifact_id: input.artifactId,
    idempotency_key: input.idempotencyKey,
    event_type: input.type,
    outcome: 'hard_rejected',
    payload_hash: computePayloadHash(input.payload),
    evaluator_fingerprint: null,
    envelope: null,
    recorded_at: now(),
  });
}

/**
 * Clear an idempotency_blocks record. Called when a prior
 * soft_blocked or hard_rejected record is being upgraded to
 * committed (the new committed event is the new source of truth and
 * makes the block record redundant).
 */
export function clearIdempotencyBlock(input: {
  store: Store;
  artifactId: string;
  idempotencyKey: string;
  type: EventType;
}): void {
  input.store.deleteIdempotencyBlock({
    artifact_id: input.artifactId,
    idempotency_key: input.idempotencyKey,
    event_type: input.type,
  });
}
// Suppress unused-import warning for IdempotencyBlockRow when callers
// of this module re-export the type via `export *`.
export type { IdempotencyBlockRow };
