import { createHash } from 'node:crypto';

import type {
  Checkpoint,
  CodingSessionRow,
  DiffFingerprintManifest,
  EvaluatorLog,
  Plan,
  SessionModelBreakdownRow,
  SourcePlanLinkRow,
  SourcePlanPin,
  Summary,
  UsageSnapshotRow,
} from '@orcaops/storage';

/**
 * Stable SHA-256 of the artifact tree at a given moment. Used by `pushArtifact`
 * to short-circuit when nothing has changed since the previous successful
 * push. Two runs with byte-identical inputs MUST produce the same hash.
 *
 * Inputs are reduced to canonical-JSON: keys sorted recursively, Unicode
 * preserved, no whitespace. Checkpoints are pre-sorted by `n` so disk-order
 * jitter (e.g. globbing differences) doesn't cascade into the digest.
 */
export interface ArtifactSnapshot {
  plan: Plan | null;
  checkpoints: Checkpoint[];
  summary: Summary | null;
  evaluators: EvaluatorLog | null;
  /**
   * The pinned source plan, or null when unpinned. Materialized by
   * `readSnapshot` via `readArtifact` (NOT the Plan projection — that drops it,
   * the silent-no-op trap). Joins `computeArtifactHash` as
   * `{source_ref, hash, baseline}` — see below — so local born-pin replay
   * identity changes are never hidden by the unchanged short-circuit.
   */
  source_plan: SourcePlanPin | null;
  /**
   * Full diff-fingerprint manifests for closed cps whose projection
   * declares a non-null `manifest_hash`, keyed by `n`. Materialized by
   * `readSnapshot` for the wire payload.
   *
   * INTENTIONALLY EXCLUDED FROM `computeArtifactHash`: that function
   * constructs its canonical object explicitly as
   * `{plan, checkpoints, summary, evaluators}` and never spreads the
   * snapshot, so this field does not enter the digest. The summary's
   * `manifest_hash` (carried on the checkpoint projection) is the
   * integrity anchor that drives hash invalidation; the heavy manifest
   * is transport-only.
   */
  fingerprintByN: Map<number, DiffFingerprintManifest>;
  /**
   * Coding-agent token usage for this artifact: exact per-session
   * totals + cumulative snapshot rows + the per-session model breakdown +
   * source-plan links. null when the artifact has no sessions / snapshots /
   * links. Materialized by `readSnapshot`. The heavy rows are EXCLUDED from
   * `computeArtifactHash` (only `usage.anchor` enters — see below), exactly like
   * `fingerprintByN`.
   */
  usage: ArtifactUsageData | null;
}

/**
 * The usage rows emitted to the cloud for one artifact, plus a precomputed light
 * `anchor` (a sub-hash) that is the ONLY usage data folded into
 * `computeArtifactHash`. `modelBreakdowns` carries each in-scope session's exact
 * per-model split (its global high-water snapshot's breakdown), keyed to the
 * `sessions` rows by (agent, session_id).
 */
export interface ArtifactUsageData {
  sessions: CodingSessionRow[];
  snapshots: UsageSnapshotRow[];
  modelBreakdowns: SessionModelBreakdownRow[];
  source_plan_links: SourcePlanLinkRow[];
  anchor: string;
}

export function computeArtifactHash(snapshot: ArtifactSnapshot): string {
  const sortedCheckpoints = [...snapshot.checkpoints].sort((a, b) => a.n - b.n);
  const canonical = canonicalJson({
    plan: snapshot.plan,
    checkpoints: sortedCheckpoints,
    summary: snapshot.summary,
    evaluators: snapshot.evaluators,
    // Pin participates in change-detection so a first push attaches it and an
    // identical later push still skips cleanly. `pin.hash` is already
    // sha256(content), the light integrity anchor, so the uncapped body stays
    // out. The normalized baseline is immutable born-pin identity and must
    // participate. CONDITIONAL spread omits the key entirely when unpinned.
    ...(snapshot.source_plan
      ? {
          source_plan: {
            source_ref: snapshot.source_plan.source_ref,
            hash: snapshot.source_plan.hash,
            baseline: snapshot.source_plan.baseline,
          },
        }
      : {}),
    // Usage participates via a precomputed light anchor ONLY (the heavy rows
    // stay out, like fingerprintByN): any usage change flips the digest so a
    // usage-only update re-pushes, while a usage-less artifact omits the key
    // entirely (CONDITIONAL spread), so it never re-pushes spuriously.
    ...(snapshot.usage ? { usage: { anchor: snapshot.usage.anchor } } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  // undefined, function, symbol — not JSON-representable; treat as null.
  return 'null';
}

/**
 * The light usage sub-hash folded into `computeArtifactHash` (via
 * `ArtifactUsageData.anchor`). Deterministic and order-independent: arrays are
 * sorted by BYTE order (not `localeCompare`, which is locale/ICU-version
 * dependent and would make the digest non-reproducible across runtimes). Covers
 * everything the wire emits — session totals, the per-session model breakdown
 * (its high-water snapshot may live on another artifact, so the scalar totals
 * alone don't capture a per-model re-split; the raw JSON also carries the
 * per-model rate classes + dimensions), the session-total + per-snapshot
 * dimensions columns, per-snapshot idempotency_key + cumulative, and links — so
 * any change to the emitted payload (including a dimensions/rate-class-only
 * change) flips it and a usage-only update re-pushes, without folding the heavy
 * rows into the digest.
 */
export function computeUsageAnchor(usage: {
  sessions: CodingSessionRow[];
  snapshots: UsageSnapshotRow[];
  modelBreakdowns: SessionModelBreakdownRow[];
  source_plan_links: SourcePlanLinkRow[];
}): string {
  const byteCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const bySession = (
    a: { agent: string; session_id: string },
    b: { agent: string; session_id: string }
  ): number => byteCmp(a.agent, b.agent) || byteCmp(a.session_id, b.session_id);
  const sessions = usage.sessions
    .map((s) => ({
      agent: s.agent,
      session_id: s.session_id,
      in: s.cumulative_input_tokens,
      out: s.cumulative_output_tokens,
      cw: s.cumulative_cache_creation_input_tokens,
      cr: s.cumulative_cache_read_input_tokens,
      as_of: s.as_of,
      record_count: s.record_count,
    }))
    .sort(bySession);
  const snapshots = usage.snapshots
    .map((s) => ({
      k: s.idempotency_key,
      in: s.cumulative_input_tokens,
      out: s.cumulative_output_tokens,
      cw: s.cumulative_cache_creation_input_tokens,
      cr: s.cumulative_cache_read_input_tokens,
      // The snapshot total's dimensions column (raw JSON string; not in the
      // scalar `cumulative`), so a dimensions-only change flips the anchor.
      dim: s.dimensions,
    }))
    .sort((a, b) => byteCmp(a.k, b.k));
  // The per-session model split actually emitted (the global high-water
  // snapshot's breakdown); the raw JSON is stable per snapshot, so a re-split
  // changes the string and flips the anchor. `mb` already carries the per-model
  // rate classes + per-model dimensions; `dim` adds the session-TOTAL dimensions
  // column (emitted inside the session entry's `total`, absent from `mb`).
  const modelBreakdowns = usage.modelBreakdowns
    .map((m) => ({
      agent: m.agent,
      session_id: m.session_id,
      mb: m.model_breakdown,
      dim: m.dimensions,
    }))
    .sort(bySession);
  const links = usage.source_plan_links
    .map((l) => ({ ref: l.source_plan_ref_id, linked_at: l.linked_at, v: l.pinned_version }))
    .sort((a, b) => byteCmp(a.ref, b.ref));
  return createHash('sha256')
    .update(canonicalJson({ sessions, snapshots, modelBreakdowns, links }))
    .digest('hex');
}
