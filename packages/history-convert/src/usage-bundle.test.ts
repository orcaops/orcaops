import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { assertDecodedLegacyUsageBundle, decodeLegacyUsageBundle } from './usage-bundle.js';

const eventId = '01999999-9999-7000-8000-000000000001';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
function payload(inputTokens = 12) {
  return {
    snapshot_id: 'snapshot-1',
    idempotency_key: 'usage-key',
    agent: 'codex',
    session_id: 'session-1',
    artifact_id: null,
    source_plan_ref_id: 'plan-1',
    lifecycle_event: 'source-plan',
    checkpoint_n: null,
    cumulative_usage: {
      input_tokens: inputTokens,
      output_tokens: 3,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 1,
      dimensions: { batch: 4 },
    },
    delta_usage: null,
    baseline_kind: 'first_observation',
    model_breakdown: [],
    record_count: 1,
    as_of: '2026-04-26T12:00:00.000Z',
  };
}
function record(value: unknown, sidecar = false) {
  const unsigned = {
    event_id: eventId,
    type: 'agent_usage_snapshot_recorded',
    ts: '2026-04-26T12:00:00.000Z',
    schema_version: 1,
    idempotency_key: 'usage-key',
    ...(sidecar
      ? { sidecar_sha256: hash(value as Buffer), sidecar_size: (value as Buffer).length }
      : { payload: value }),
  };
  return encode({ ...unsigned, checksum: hash(canonicalJson(unsigned)) });
}

describe('retained usage repair evidence', () => {
  it('preserves repeated same-ID original records in order without treating them as new accounting facts', () => {
    const bytes = Buffer.concat([record(payload()), record(payload()), record(payload(15))]);
    const bundle = decodeLegacyUsageBundle([{ relativePath: 'ledger.ndjson', bytes }]);
    expect(bundle.events.map((event) => event.event.payload)).toEqual([
      payload(),
      payload(),
      payload(15),
    ]);
    expect(bundle.events.map((event) => event.ordinal)).toEqual([0, 1, 2]);
    expect(bundle.events.map((event) => event.event.record.event_id)).toEqual([
      eventId,
      eventId,
      eventId,
    ]);
    expect(bundle.members[0]!.bytesBase64).toBe(bytes.toString('base64'));
    expect(() => assertDecodedLegacyUsageBundle(bundle)).not.toThrow();
    expect(() => assertDecodedLegacyUsageBundle({ ...bundle })).toThrow();
    bytes.fill(0);
    expect(bundle.events[0]!.event.payload).toEqual(payload());
  });
  it('resolves each original sidecar reference to its exact retained current or displaced bytes', () => {
    const original = Buffer.from('  ' + JSON.stringify(payload()) + '\n');
    const current = encode(payload(15));
    const displaced = `sidecar-conflicts/${eventId}/${hash(original)}.json`;
    const members = [
      {
        relativePath: 'ledger.ndjson',
        bytes: Buffer.concat([record(original, true), record(current, true)]),
      },
      { relativePath: `sidecars/${eventId}.json`, bytes: current },
      { relativePath: displaced, bytes: original },
    ];
    const bundle = decodeLegacyUsageBundle(members);
    expect(bundle.events.map((event) => event.sidecarRelativePath)).toEqual([
      displaced,
      `sidecars/${eventId}.json`,
    ]);
    expect(bundle.sidecars).toEqual([
      expect.objectContaining({
        role: 'displaced',
        references: [0],
        sha256: hash(original),
        payloadType: 'snapshot',
      }),
      expect.objectContaining({
        role: 'canonical',
        references: [1],
        sha256: hash(current),
        payloadType: 'snapshot',
      }),
    ]);
    expect(() => decodeLegacyUsageBundle(members.slice(0, 2))).toThrow(
      expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' })
    );
    members[2]!.bytes = encode(payload(17));
    expect(() => decodeLegacyUsageBundle(members)).toThrow(/content-addressed identity/);
    expect(Object.isFrozen(bundle.sidecars[0]!.references)).toBe(true);
  });
  it('retains valid unreferenced sidecars as explicit original attachments without manufacturing a ledger event', () => {
    const original = encode(payload());
    const sidecar = {
      relativePath: `sidecar-conflicts/${eventId}/${hash(original)}.json`,
      bytes: original,
    };
    const bundle = decodeLegacyUsageBundle([
      { relativePath: 'ledger.ndjson', bytes: Buffer.alloc(0) },
      sidecar,
    ]);
    expect(bundle.events).toEqual([]);
    expect(bundle.sidecars).toEqual([
      expect.objectContaining({ role: 'displaced', references: [] }),
    ]);
    expect(bundle.members).toHaveLength(2);
    expect(() => decodeLegacyUsageBundle([sidecar])).toThrow(
      expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' })
    );
  });
  it('rejects mismatched idempotency keys, invalid payloads, unclassified files and partial original lines', () => {
    for (const bytes of [
      record({ ...payload(), idempotency_key: 'different-key' }),
      record(payload(-1)),
      record(payload()).subarray(0, -1),
    ])
      expect(() => decodeLegacyUsageBundle([{ relativePath: 'ledger.ndjson', bytes }])).toThrow(
        expect.objectContaining({ code: 'SOURCE_INTEGRITY' })
      );
    expect(() =>
      decodeLegacyUsageBundle([
        { relativePath: 'ledger.ndjson', bytes: record(payload()) },
        { relativePath: 'unknown.json', bytes: encode({}) },
      ])
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_RESOURCE_SCHEMA' }));
    const invalid = encode({ ...payload(), unknown: true });
    expect(() =>
      decodeLegacyUsageBundle([
        { relativePath: 'ledger.ndjson', bytes: Buffer.alloc(0) },
        { relativePath: `sidecars/${eventId}.json`, bytes: invalid },
      ])
    ).toThrow(/complete frozen payload/);
  });
  it('preserves original link records and their nullable pinned-version field', () => {
    const link = {
      canonical_ref_id: 'plan-1',
      artifact_id: eventId,
      linked_at: '2026-04-26T12:00:00.000Z',
      pinned_version: null,
    };
    const { checksum: _checksum, ...envelope } = JSON.parse(record(payload()).toString());
    const unsigned = { ...envelope, type: 'source_plan_linked', payload: link };
    const bundle = decodeLegacyUsageBundle([
      {
        relativePath: 'ledger.ndjson',
        bytes: encode({ ...unsigned, checksum: hash(canonicalJson(unsigned)) }),
      },
    ]);
    expect(bundle.events[0]!.event.payload).toEqual(link);
  });
});
