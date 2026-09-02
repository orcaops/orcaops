import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';
import type { CorruptEntry, EventRecord, EventType, InlineEventRecord } from './event-log.js';
import {
  type LossyCorruptEvent,
  lossyCorruptEvents,
  recoverProjection,
  type RecoveryInput,
} from './recovery.js';

/** Test helper: build an inline event record with a valid checksum. */
function event(over: {
  event_id: string;
  type: EventType;
  ts?: string;
  idempotency_key?: string;
  payload?: unknown;
}): InlineEventRecord {
  const base = {
    event_id: over.event_id,
    type: over.type,
    ts: over.ts ?? '2026-04-26T12:00:00.000Z',
    schema_version: 1 as const,
    idempotency_key: over.idempotency_key ?? `${over.type}-${over.event_id}`,
    payload: over.payload ?? { id: over.event_id },
  };
  const checksum = createHash('sha256').update(canonicalJson(base), 'utf8').digest('hex');
  return { ...base, checksum };
}

/** A lost line at an explicit log position; type is untrusted unless given. */
function lost(
  line: number,
  event_id: string | null,
  type: EventType | null = null
): LossyCorruptEvent {
  return { line, event_id, type };
}

interface FakeProjection {
  /** Number of events folded into this rebuild — pinpoints which call-time we ran. */
  count: number;
  /** Concatenated event_ids in order, for assertion. */
  ids: string;
}

function rebuildFake(events: EventRecord[]): FakeProjection {
  return {
    count: events.length,
    ids: events.map((e) => e.event_id).join(','),
  };
}

function input(
  over: Partial<RecoveryInput<FakeProjection>> & {
    /** Events with their log lines; order in the array is append order. */
    eventsAt: Array<[number, EventRecord]>;
    relevantTypes: ReadonlySet<EventType>;
  }
): RecoveryInput<FakeProjection> {
  const { eventsAt, ...rest } = over;
  return {
    projection: null,
    events: eventsAt.map(([, e]) => e),
    lineByEventId: new Map(eventsAt.map(([line, e]) => [e.event_id, line])),
    lossyCorrupt: over.lossyCorrupt ?? [],
    rebuild: over.rebuild ?? rebuildFake,
    ...rest,
  };
}

describe('recoverProjection', () => {
  // ── happy path: current projection ────────────────────────────────

  it('returns "current" when source_event_id matches the latest relevant event', () => {
    const e1 = event({ event_id: 'e-1', type: 'plan_captured' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { value: { count: 1, ids: 'e-1' }, source_event_id: 'e-1' },
        eventsAt: [[1, e1]],
        relevantTypes: new Set(['plan_captured']),
      })
    );
    expect(result).toEqual({
      status: 'current',
      projection: { count: 1, ids: 'e-1' },
      sourceEventId: 'e-1',
    });
  });

  it('compares against ONLY relevant types when picking the latest event', () => {
    const e1 = event({ event_id: 'cp-1', type: 'checkpoint_opened' });
    // A later event of an UNrelated type should not affect the comparison.
    const eIrrelevant = event({ event_id: 'sum-1', type: 'summary_captured' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { value: { count: 1, ids: 'cp-1' }, source_event_id: 'cp-1' },
        eventsAt: [
          [1, e1],
          [2, eIrrelevant],
        ],
        relevantTypes: new Set(['checkpoint_opened']),
      })
    );
    expect(result.status).toBe('current');
  });

  // ── rebuild paths ─────────────────────────────────────────────────

  it('rebuilds with reason "missing" when the projection is null and events exist', () => {
    const e1 = event({ event_id: 'e-1', type: 'plan_captured' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: null,
        eventsAt: [[1, e1]],
        relevantTypes: new Set(['plan_captured']),
      })
    );
    expect(result).toEqual({
      status: 'rebuilt',
      projection: { count: 1, ids: 'e-1' },
      sourceEventId: 'e-1',
      reason: 'missing',
    });
  });

  it('rebuilds with reason "stale" when the projection points at an older event', () => {
    const e1 = event({ event_id: 'cp-1', type: 'checkpoint_opened' });
    const e2 = event({ event_id: 'cp-2', type: 'checkpoint_opened' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { value: { count: 1, ids: 'cp-1' }, source_event_id: 'cp-1' },
        eventsAt: [
          [1, e1],
          [2, e2],
        ],
        relevantTypes: new Set(['checkpoint_opened']),
      })
    );
    expect(result).toEqual({
      status: 'rebuilt',
      projection: { count: 2, ids: 'cp-1,cp-2' },
      sourceEventId: 'cp-2',
      reason: 'stale',
    });
  });

  it('rebuild callback receives ONLY the relevant subset, not the full event list', () => {
    const cp1 = event({ event_id: 'cp-1', type: 'checkpoint_opened' });
    const sum = event({ event_id: 'sum-1', type: 'summary_captured' });
    const cp2 = event({ event_id: 'cp-2', type: 'checkpoint_opened' });
    const seen: EventRecord[] = [];
    recoverProjection<FakeProjection>(
      input({
        projection: null,
        eventsAt: [
          [1, cp1],
          [2, sum],
          [3, cp2],
        ],
        relevantTypes: new Set(['checkpoint_opened']),
        rebuild: (relevant) => {
          seen.push(...relevant);
          return rebuildFake(relevant);
        },
      })
    );
    expect(seen.map((e) => e.event_id)).toEqual(['cp-1', 'cp-2']);
  });

  // ── asymmetric: rotted source event, valid projection ────────────

  // ── artifact-level refusal: any non-tail loss refuses everything ──

  it('any non-tail loss refuses — even a projection that matches the latest survivor', () => {
    const open = event({ event_id: 'open-1', type: 'checkpoint_opened' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { value: { count: 1, ids: 'open-1' }, source_event_id: 'open-1' },
        eventsAt: [[1, open]],
        lossyCorrupt: [lost(2, null)],
        relevantTypes: new Set(['checkpoint_opened']),
      })
    );
    expect(result.status).toBe('unrecoverable');
    if (result.status === 'unrecoverable') {
      expect(result.lossCited).toBe(true);
      expect(result.reason).toMatch(/line\(s\) 2/);
      expect(result.reason).toMatch(/unreadable until/);
    }
  });

  it('any non-tail loss refuses a missing-projection rebuild', () => {
    const open = event({ event_id: 'open-1', type: 'checkpoint_opened' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: null,
        eventsAt: [[1, open]],
        lossyCorrupt: [lost(2, 'x-1')],
        relevantTypes: new Set(['checkpoint_opened']),
      })
    );
    expect(result.status).toBe('unrecoverable');
  });

  it("a lost line's trusted irrelevant type still refuses — the contract is artifact-level", () => {
    // Pre-v1 recovery reasoned per projection type; the v1 contract
    // deliberately does not: any loss anywhere makes the artifact
    // unreadable, so no inference can misattribute a lost line.
    const open = event({ event_id: 'open-1', type: 'checkpoint_opened' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { value: { count: 1, ids: 'open-1' }, source_event_id: 'open-1' },
        eventsAt: [[1, open]],
        lossyCorrupt: [lost(2, 'sum-1', 'summary_captured')],
        relevantTypes: new Set(['checkpoint_opened']),
      })
    );
    expect(result.status).toBe('unrecoverable');
  });

  // ── missing source over an intact log (clean truncation) ──────────

  it('refuses a projection naming a source absent from the intact log, without citing loss', () => {
    // A clean suffix truncation leaves no corruption markers: the log
    // parses green but the projection names an event it does not
    // contain. Refuse — and lossCited stays false, because doctor's
    // corrupt-line check would (correctly) report this log as clean.
    const open = event({ event_id: 'open-1', type: 'checkpoint_opened' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { value: { count: 2, ids: 'open-1,close-1' }, source_event_id: 'close-1' },
        eventsAt: [[1, open]],
        relevantTypes: new Set(['checkpoint_opened', 'checkpoint_closed']),
      })
    );
    expect(result.status).toBe('unrecoverable');
    if (result.status === 'unrecoverable') {
      expect(result.lossCited).toBe(false);
      expect(result.reason).toMatch(/absent from the intact event log/);
      expect(result.reason).toMatch(/close-1/);
    }
  });

  it('the missing-source refusal fires even when the named source is of an irrelevant type', () => {
    // lineByEventId is the complete id universe of an intact log, so
    // membership is checked globally — a projection naming ANY absent
    // id is unaccounted for.
    const open = event({ event_id: 'open-1', type: 'checkpoint_opened' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { value: { count: 1, ids: 'open-1' }, source_event_id: 'ghost-1' },
        eventsAt: [[1, open]],
        relevantTypes: new Set(['checkpoint_opened']),
      })
    );
    expect(result.status).toBe('unrecoverable');
    if (result.status === 'unrecoverable') expect(result.lossCited).toBe(false);
  });

  it('a garbled projection over an intact log with relevant events rebuilds (self-heal)', () => {
    const open = event({ event_id: 'open-1', type: 'checkpoint_opened' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { unreadable: true },
        eventsAt: [[1, open]],
        relevantTypes: new Set(['checkpoint_opened']),
      })
    );
    expect(result.status).toBe('rebuilt');
    if (result.status === 'rebuilt') expect(result.projection.ids).toBe('open-1');
  });

  it('refuses a projection with no backing events and NO recorded rot (unprovenanced state)', () => {
    const proj: FakeProjection = { count: 1, ids: 'old' };
    const unrelated = event({ event_id: 'summary-1', type: 'summary_captured' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { value: proj, source_event_id: 'summary-1' },
        eventsAt: [[1, unrelated]],
        relevantTypes: new Set(['plan_captured']),
      })
    );
    expect(result.status).toBe('unrecoverable');
    if (result.status === 'unrecoverable') {
      expect(result.reason).toMatch(/unprovenanced state/);
      expect(result.reason).toMatch(/restore the event log from a backup or the archive mirror/);
    }
  });

  it('refuses an UNREADABLE projection with no backing events instead of reading as no-source', () => {
    // The file exists but cannot be parsed; nothing survives to rebuild
    // it from. Vanishing here would let more damage produce a quieter
    // answer than the readable unprovenanced-state refusal.
    const result = recoverProjection<FakeProjection>(
      input({
        projection: { unreadable: true },
        eventsAt: [],
        relevantTypes: new Set(['plan_captured']),
      })
    );
    expect(result.status).toBe('unrecoverable');
    if (result.status === 'unrecoverable') expect(result.reason).toMatch(/cannot be parsed/);
  });

  it('returns "no-source" with null projection when neither projection nor events exist', () => {
    const result = recoverProjection<FakeProjection>(
      input({
        projection: null,
        eventsAt: [],
        relevantTypes: new Set(['plan_captured']),
      })
    );
    expect(result).toEqual({ status: 'no-source', projection: null });
  });

  it('returns "no-source" when events exist but none are of relevant types', () => {
    const sum = event({ event_id: 'sum-1', type: 'summary_captured' });
    const result = recoverProjection<FakeProjection>(
      input({
        projection: null,
        eventsAt: [[1, sum]],
        relevantTypes: new Set(['checkpoint_opened']),
      })
    );
    expect(result).toEqual({ status: 'no-source', projection: null });
  });

  it('refuses an empty result when any line was lost — artifact-level, type-blind', () => {
    const result = recoverProjection<FakeProjection>(
      input({
        projection: null,
        eventsAt: [],
        lossyCorrupt: [lost(1, 'sum-1', 'summary_captured')],
        relevantTypes: new Set(['checkpoint_opened']),
      })
    );
    expect(result.status).toBe('unrecoverable');
  });
});

describe('lossyCorruptEvents', () => {
  const base = { line: 1, raw: '{...}' };

  it('excludes truncated tails — a partial final line was never acknowledged', () => {
    const entries: CorruptEntry[] = [
      { ...base, kind: 'truncated_tail', reason: 'truncated tail' },
      { ...base, line: 2, kind: 'checksum_mismatch', reason: 'checksum mismatch', event_id: 'e-1' },
    ];
    expect(lossyCorruptEvents(entries)).toEqual([{ line: 2, event_id: 'e-1', type: null }]);
  });

  it('carries the trusted type only for sidecar-corrupt entries', () => {
    const record = event({ event_id: 'e-2', type: 'summary_captured' });
    const entries: CorruptEntry[] = [
      { ...base, kind: 'sidecar_corrupt', reason: 'sidecar missing', event_id: 'e-2', record },
      { ...base, line: 2, kind: 'invalid_json', reason: 'line is not valid JSON' },
      { ...base, line: 3, kind: 'schema_mismatch', reason: 'event record fails schema' },
    ];
    expect(lossyCorruptEvents(entries)).toEqual([
      { line: 1, event_id: 'e-2', type: 'summary_captured' },
      { line: 2, event_id: null, type: null },
      { line: 3, event_id: null, type: null },
    ]);
  });

  it('returns an empty list when nothing is corrupt', () => {
    expect(lossyCorruptEvents([]).length).toBe(0);
  });
});
