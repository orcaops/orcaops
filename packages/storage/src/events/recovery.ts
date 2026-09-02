import type { CorruptEntry, EventRecord, EventType } from './event-log.js';

/**
 * Recovery-on-read for projection files (`artifact.json`, `plan.json`,
 * `checkpoint-N.json`, `summary.json`, `evaluators.json`).
 *
 * The v1 integrity contract is ARTIFACT-LEVEL and deterministic:
 *
 *   - Any detectable non-tail event-log corruption makes the whole
 *     artifact unreadable for substantive reads. No inference is made
 *     about which projection a lost line belonged to.
 *   - Over an intact log, a projection naming a source event absent
 *     from that log is unaccounted for — lines were removed without
 *     leaving corruption markers (e.g. a clean suffix truncation).
 *     Recovery refuses and NEVER overwrites the projection: it is the
 *     only remaining witness of the missing history.
 *   - Over an intact log with events of the projection's types, the log
 *     is authoritative: a missing, garbled, or stale projection is
 *     rebuilt from events and served without mutating disk. A later normal
 *     write repairs the persistent projection.
 *   - A truncated final line is never-acknowledged crash residue, not
 *     loss — reads serve past it (captures refuse separately at the
 *     append preflight).
 *
 * Explicitly OUTSIDE the local guarantee: coordinated loss of the log
 * suffix AND every projection that witnessed it (nothing on disk can
 * prove those events existed) — and, by the same token, clean suffix
 * truncation of an ARCHIVE copy, which stores no projections at all.
 * Head witnesses close both gaps and are deliberately post-release
 * work.
 *
 * The rebuild step itself is type-specific; the caller supplies a
 * `rebuild` callback. This module owns only the decision logic.
 */

export interface ProjectionWithSource<T> {
  /** The projection value as read from disk. */
  value: T;
  /** The non-empty `source_event_id` embedded in the validated projection. */
  source_event_id: string;
}

/**
 * One lost (acknowledged-then-corrupted) event-log line. Produced from
 * `readEventLog`'s corrupt entries by `lossyCorruptEvents` — truncated
 * tails are excluded there because a partial final line was never
 * acknowledged, so it is "never written", not lost data.
 */
export interface LossyCorruptEvent {
  /** 1-based line number in `events.ndjson`. */
  line: number;
  /** Best-effort id from the rotted line; null when unparseable. */
  event_id: string | null;
  /**
   * Trusted event type — present ONLY for sidecar-corrupt entries,
   * where the line's schema and checksum both passed. Null otherwise.
   * Retained for doctor-facing detail; the refusal decision is
   * artifact-level and does not consult it.
   */
  type: EventType | null;
}

/**
 * Marker for a projection file that EXISTS on disk but could not be
 * read (garbled JSON or strict-schema rejection). Distinct from null
 * (absent): with surviving events it self-heals by rebuild, but with
 * nothing to rebuild from an unreadable file must refuse loudly —
 * more damage must never produce a quieter answer than less.
 */
export interface UnreadableProjection {
  unreadable: true;
}

export interface RecoveryInput<T> {
  /**
   * Projection currently on disk: parsed, `{unreadable: true}` for a
   * file that exists but cannot be parsed, or null when absent.
   */
  projection: ProjectionWithSource<T> | UnreadableProjection | null;
  /**
   * All events from the artifact's event log, in append order, after
   * `readEventLog` has filtered out corrupt lines.
   */
  events: EventRecord[];
  /** Lost lines from the same read (see `LossyCorruptEvent`). */
  lossyCorrupt: readonly LossyCorruptEvent[];
  /**
   * 1-based event-log line per surviving event id, from the same
   * `readEventLog` call. Over an intact log this is the complete id
   * universe — the missing-source refusal checks membership here.
   */
  lineByEventId: ReadonlyMap<string, number>;
  /** Event types that contribute to this projection. */
  relevantTypes: ReadonlySet<EventType>;
  /**
   * Rebuild the projection from the relevant subset of events (in
   * append order). Pure function; receives only events whose `type`
   * is in `relevantTypes`.
   */
  rebuild: (relevantEvents: EventRecord[]) => T;
}

export type RecoveryStatus =
  /** Projection matches the latest relevant surviving event. */
  | 'current'
  /** Projection rebuilt from the intact log; reason says why. */
  | 'rebuilt'
  /**
   * No relevant events exist AND no projection is on disk — an empty
   * artifact for this projection type (a summary not yet captured, a
   * checkpoint n never opened).
   */
  | 'no-source'
  /**
   * Serving any answer would silently lose or misrepresent
   * acknowledged data. The reason names what refused; doctor surfaces
   * corrupt lines and the user decides what to do.
   */
  | 'unrecoverable';

export type RecoveryResult<T> =
  | { status: 'current'; projection: T; sourceEventId: string }
  | {
      status: 'rebuilt';
      projection: T;
      sourceEventId: string;
      reason: 'missing' | 'stale';
    }
  | { status: 'no-source'; projection: null }
  | {
      status: 'unrecoverable';
      reason: string;
      /**
       * True when the refusal cites corrupt event-log lines — the store
       * appends operator guidance (doctor) exactly when this is set, so
       * the gate can never drift from reason prose.
       */
      lossCited: boolean;
    };

function describeLines(entries: readonly LossyCorruptEvent[]): string {
  return entries.map((c) => String(c.line)).join(', ');
}

/**
 * Decide what to return for a projection given the live event log.
 * Pure decision function — does not write to disk. Callers serve current or
 * rebuilt results in memory; `unrecoverable` must never overwrite the on-disk
 * file because it may be the only remaining witness.
 */
export function recoverProjection<T>(input: RecoveryInput<T>): RecoveryResult<T> {
  const { events, lossyCorrupt, lineByEventId, relevantTypes, rebuild } = input;
  const projectionUnreadable = input.projection !== null && 'unreadable' in input.projection;
  const projection =
    input.projection === null || 'unreadable' in input.projection ? null : input.projection;

  // ── Artifact-level refusal: any non-tail loss, any projection. ──
  if (lossyCorrupt.length > 0) {
    return {
      status: 'unrecoverable',
      lossCited: true,
      reason:
        `corrupt event-log line(s) ${describeLines(lossyCorrupt)} — the artifact is ` +
        `unreadable until the log is restored from a backup or the archive mirror, ` +
        `or the artifact is deleted to accept the loss`,
    };
  }

  // ── Intact log from here on: `lineByEventId` is the complete id universe. ──
  const relevant = events.filter((e) => relevantTypes.has(e.type));
  const latestRelevant = relevant.length > 0 ? relevant[relevant.length - 1] : null;

  // Missing source: the projection names an event the intact log does
  // not contain. History was removed without corruption markers (e.g. a
  // clean suffix truncation) — refuse, and never overwrite the file.
  if (projection !== null && !lineByEventId.has(projection.source_event_id)) {
    return {
      status: 'unrecoverable',
      lossCited: false,
      reason:
        `projection names source event ${projection.source_event_id}, which is absent ` +
        `from the intact event log — log lines were removed without corruption markers ` +
        `(e.g. a clean truncation); the projection is preserved as the only witness. ` +
        `Restore the log from a backup or the archive mirror`,
    };
  }

  if (latestRelevant === null) {
    if (projection !== null) {
      // A projection with NO backing events in an intact log cannot
      // have been produced by that log. Refuse to serve unprovenanced
      // state (and never overwrite it).
      return {
        status: 'unrecoverable',
        lossCited: false,
        reason:
          `projection file exists but the intact event log has no events of its ` +
          `type — unprovenanced state this log cannot have produced. The ` +
          `projection is preserved unmodified; restore the event ` +
          `log from a backup or the archive mirror if this history should exist`,
      };
    }
    if (projectionUnreadable) {
      // The file EXISTS but cannot be parsed, and there is nothing to
      // rebuild it from — vanishing here would let more damage produce a
      // quieter answer than the readable refusal above.
      return {
        status: 'unrecoverable',
        lossCited: false,
        reason:
          `a projection file exists but cannot be parsed, and the event log ` +
          `has no surviving events of its type to rebuild it from — restore ` +
          `the file or the log rather than treating the state as empty`,
      };
    }
    // Nothing of this kind yet (summary not captured, checkpoint never
    // opened) — a normal empty result.
    return { status: 'no-source', projection: null };
  }

  if (projection !== null && projection.source_event_id === latestRelevant.event_id) {
    return {
      status: 'current',
      projection: projection.value,
      sourceEventId: latestRelevant.event_id,
    };
  }

  // Missing, garbled, or stale projection over an intact log with relevant
  // events: the log is authoritative — rebuild.
  const rebuilt = rebuild(relevant);
  return {
    status: 'rebuilt',
    projection: rebuilt,
    sourceEventId: latestRelevant.event_id,
    reason: projection !== null ? 'stale' : 'missing',
  };
}

/**
 * Convert the `corrupt` array from `readEventLog` into the lost-event
 * list the recovery function expects. Truncated tails are excluded — a
 * partial final line was never acknowledged, so treating it as loss
 * would punish the documented crash-mid-write shape. The trusted
 * `record` header exists only on sidecar-corrupt entries; every other
 * kind contributes an unknown (null) type.
 */
export function lossyCorruptEvents(corrupt: readonly CorruptEntry[]): LossyCorruptEvent[] {
  const out: LossyCorruptEvent[] = [];
  for (const entry of corrupt) {
    if (entry.kind === 'truncated_tail') continue;
    out.push({
      line: entry.line,
      event_id: entry.event_id ?? null,
      type: entry.kind === 'sidecar_corrupt' && entry.record ? entry.record.type : null,
    });
  }
  return out;
}
