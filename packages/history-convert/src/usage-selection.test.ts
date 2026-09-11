import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { type SourcePlanLinkRow, type UsageSnapshotRow } from './legacy/storage/store/sqlite.js';
import { replayUsageEventsIntoStore } from './legacy/storage/usage/ledger.js';
import { decodeLegacyUsageBundle } from './usage-bundle.js';
import {
  assertLegacyUsageSelection,
  type LegacyUsageSource,
  selectLegacyUsage,
} from './usage-selection.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const id = (n: number) => `01999999-9999-7000-8000-${String(n).padStart(12, '0')}`;
const key = (value: string, type = 'source_plan_linked') => hash(canonicalJson([type, value]));
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
function link(n: number, name: string, target = id(n), note = 'plan') {
  const unsigned = {
    event_id: id(n),
    type: 'source_plan_linked',
    ts: '2026-04-26T12:00:00.000Z',
    schema_version: 1,
    idempotency_key: name,
    payload: {
      canonical_ref_id: note,
      artifact_id: target,
      linked_at: '2026-04-26T12:00:00.000Z',
      pinned_version: null,
    },
  };
  return encode({ ...unsigned, checksum: hash(canonicalJson(unsigned)) });
}
const source = (sourceId: string, records: readonly Buffer[]): LegacyUsageSource => ({
  sourceId,
  bundle: decodeLegacyUsageBundle([
    { relativePath: 'ledger.ndjson', bytes: Buffer.concat(records) },
  ]),
});
function replay(bundle: LegacyUsageSource['bundle']) {
  const snapshots: UsageSnapshotRow[] = [];
  const links: SourcePlanLinkRow[] = [];
  const counts = replayUsageEventsIntoStore(
    {
      insertUsageSnapshot: (row) => snapshots.push(row),
      applySourcePlanLink: (row) => links.push(row),
    },
    bundle.events.map(({ event }) => ({
      event_id: event.record.event_id,
      type: event.record.type as 'source_plan_linked' | 'agent_usage_snapshot_recorded',
      ts: event.record.ts,
      idempotency_key: event.record.idempotency_key,
      payload: event.payload,
    }))
  );
  return { snapshots, links, counts };
}
function canonical(selection: ReturnType<typeof selectLegacyUsage>) {
  return decodeLegacyUsageBundle([
    { relativePath: 'ledger.ndjson', bytes: Buffer.from(selection.eventBytesBase64, 'base64') },
    ...selection.sidecars.map(({ eventId, bytesBase64 }) => ({
      relativePath: `sidecars/${eventId}.json`,
      bytes: Buffer.from(bytesBase64, 'base64'),
    })),
  ]);
}

describe('retained usage semantic union', () => {
  it('matches the exact frozen last-valid projector while mapping every original repair occurrence', () => {
    const initial = link(1, 'one', id(5));
    const other = link(2, 'two', id(6));
    const repaired = link(1, 'one', id(7));
    const hot = source('hot', [initial, other]);
    const archive = source('archive', [initial, other, repaired, repaired]);
    const selected = selectLegacyUsage([hot, archive]);
    expect(replay(canonical(selected))).toEqual(replay(archive.bundle));
    expect(selected.counts).toEqual({
      originalOccurrences: 6,
      selectedSnapshots: 0,
      selectedLinks: 2,
      retainedEvidenceOccurrences: 4,
    });
    expect(selected.occurrences).toHaveLength(6);
    expect(
      selected.occurrences.filter((entry) => entry.disposition === 'selected-original')
    ).toHaveLength(2);
    expect(
      selected.occurrences.every(
        (entry) => selected.records[entry.canonicalRecordIndex] !== undefined
      )
    ).toBe(true);
    expect(selected.records.map((entry) => entry.ordinal)).toEqual([1, 3]);
    expect(selected.sources[0]!.bundle.members[0]!.bytesBase64).toBe(
      archive.bundle.members[0]!.bytesBase64
    );
    expect(() => assertLegacyUsageSelection(selected)).not.toThrow();
    expect(() => assertLegacyUsageSelection({ ...selected })).toThrow();
  });
  it('keeps unique valid facts from separate worktrees and orders them deterministically without timestamps', () => {
    const sources = [
      source('one', [link(1, 'one'), link(3, 'three')]),
      source('two', [link(2, 'two'), link(3, 'three')]),
    ];
    const selected = selectLegacyUsage(sources);
    expect(selected.records).toHaveLength(3);
    expect(selected.records.at(-1)!.key).toBe(key('three'));
    expect(selectLegacyUsage([...sources].reverse()).manifestHash).toBe(selected.manifestHash);
    expect(replay(canonical(selected)).links).toHaveLength(3);
    expect(selected.counts.originalOccurrences).toBe(4);
  });
  it('refuses incomparable same-key chains and conflicting source replay orders', () => {
    expect(() =>
      selectLegacyUsage([
        source('one', [link(1, 'shared', id(4))]),
        source('two', [link(2, 'shared', id(5))]),
      ])
    ).toThrow(/divergent ordered semantic/);
    const first = link(1, 'one');
    const second = link(2, 'two');
    expect(() =>
      selectLegacyUsage([source('one', [first, second]), source('two', [second, first])])
    ).toThrow(/conflicting semantic replay order/);
    expect(() => selectLegacyUsage([source('one', [link(1, 'one'), link(1, 'two')])])).toThrow(
      /reuse an event identity/
    );
  });
  it('requires reviewed whole-source hashes for redaction and never resolves arbitrary divergent counters by preference', () => {
    const sources = [
      source('raw', [link(1, 'one', id(3), 'api_key=testing1234')]),
      source('archive', [link(1, 'one', id(3), 'api_key=[REDACTED_SECRET]')]),
    ];
    const choice = {
      key: key('one'),
      sourceId: 'archive',
      sources: sources.map(({ sourceId, bundle }) => ({ sourceId, sha256: bundle.sha256 })),
    };
    expect(() => selectLegacyUsage(sources)).toThrow(/hash-bound reviewed/);
    const selected = selectLegacyUsage(sources, [choice]);
    expect(selected.records[0]!.fidelity).toContainEqual(
      expect.objectContaining({ sourceId: 'raw', selectedRedacted: 1 })
    );
    expect(replay(canonical(selected)).links[0]!.source_plan_ref_id).toBe(
      'api_key=[REDACTED_SECRET]'
    );
    expect(() => selectLegacyUsage(sources, [{ ...choice, sources: [] }])).toThrow(
      /complete source manifest/
    );
    expect(() => selectLegacyUsage(sources, [{ ...choice, key: 'unknown' }])).toThrow();
    expect(
      JSON.stringify({ occurrences: selected.occurrences, records: selected.records })
    ).not.toContain('testing1234');
  });
  it('preserves exact snapshot dimensions, model fields, embedded deltas and terminal sidecar bytes', () => {
    const scalar = {
      input_tokens: 12,
      output_tokens: 3,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 1,
    };
    const payload = {
      snapshot_id: 'snapshot',
      idempotency_key: 'snapshot-key',
      agent: 'codex',
      session_id: 'session',
      artifact_id: null,
      source_plan_ref_id: 'plan',
      lifecycle_event: 'source-plan',
      checkpoint_n: null,
      cumulative_usage: { ...scalar, dimensions: { batch: 4 } },
      delta_usage: { ...scalar, input_tokens: 7 },
      baseline_kind: 'prior_same_source_plan',
      model_breakdown: [
        {
          model: 'model',
          speed: 'fast',
          service_tier: 'priority',
          inference_geo: 'region',
          cumulative: scalar,
          delta: { ...scalar, input_tokens: 5 },
        },
      ],
      record_count: 3,
      as_of: '2026-04-26T12:00:00.000Z',
    };
    const sidecar = Buffer.from('  ' + JSON.stringify(payload) + '\n');
    const unsigned = {
      event_id: id(1),
      type: 'agent_usage_snapshot_recorded',
      ts: '2026-04-26T12:00:00.000Z',
      schema_version: 1,
      idempotency_key: 'snapshot-key',
      sidecar_sha256: hash(sidecar),
      sidecar_size: sidecar.length,
    };
    const bundle = decodeLegacyUsageBundle([
      {
        relativePath: 'ledger.ndjson',
        bytes: Buffer.concat([
          link(2, 'link'),
          encode({ ...unsigned, checksum: hash(canonicalJson(unsigned)) }),
        ]),
      },
      { relativePath: `sidecars/${id(1)}.json`, bytes: sidecar },
    ]);
    const selected = selectLegacyUsage([{ sourceId: 'original', bundle }]);
    expect(replay(canonical(selected))).toEqual(replay(bundle));
    expect(selected.sidecars[0]!.bytesBase64).toBe(sidecar.toString('base64'));
    expect(selected.counts).toEqual({
      originalOccurrences: 2,
      selectedSnapshots: 1,
      selectedLinks: 1,
      retainedEvidenceOccurrences: 0,
    });
    expect(replay(canonical(selected)).snapshots[0]).toMatchObject({
      delta_input_tokens: 7,
      dimensions: '{"batch":4}',
      model_breakdown: JSON.stringify(payload.model_breakdown),
      checkpoint_n: null,
    });
    const duplicate = {
      ...unsigned,
      event_id: id(4),
      idempotency_key: 'other-key',
      sidecar_sha256: undefined,
      sidecar_size: undefined,
      payload: { ...payload, idempotency_key: 'other-key' },
    };
    const different = source('other', [
      encode({ ...duplicate, checksum: hash(canonicalJson(duplicate)) }),
    ]);
    expect(() => selectLegacyUsage([{ sourceId: 'original', bundle }, different])).toThrow(
      /reuse a snapshot identity/
    );
  });
});
