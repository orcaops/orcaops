import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { decodeLegacyLog, type LegacyLog, selectLegacyContinuation } from './log.js';

const eventId = (n: number) => `01999999-9999-7000-8000-${String(n).padStart(12, '0')}`;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function record(n: number, payload: unknown, ts = '2026-04-26T12:00:00.000Z') {
  const value = {
    event_id: eventId(n),
    type: 'pin_displaced',
    ts,
    schema_version: 1,
    idempotency_key: `record-${n}`,
    payload,
  };
  return { ...value, checksum: hash(canonicalJson(value)) };
}
const log = (...records: unknown[]) =>
  Buffer.from(records.map((row) => JSON.stringify(row) + '\n').join(''));

describe('retained log verification', () => {
  it('validates complete usage payloads independently of envelope checksum and storage form', () => {
    const payload = {
      snapshot_id: 'snapshot-1',
      idempotency_key: 'usage-key',
      agent: 'codex',
      session_id: 'session-1',
      artifact_id: null,
      source_plan_ref_id: 'plan-1',
      lifecycle_event: 'source-plan',
      checkpoint_n: null,
      cumulative_usage: {
        input_tokens: 12,
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
    const base = { ...record(1, payload), idempotency_key: payload.idempotency_key };
    const { checksum: _checksum, ...unsigned } = { ...base, type: 'agent_usage_snapshot_recorded' };
    const row = { ...unsigned, checksum: hash(canonicalJson(unsigned)) };
    expect(decodeLegacyLog({ kind: 'usage', bytes: log(row) }).events[0]!.payload).toEqual(payload);
    const differentKey = { ...unsigned, idempotency_key: 'different-envelope-key' };
    expect(() =>
      decodeLegacyLog({
        kind: 'usage',
        bytes: log({ ...differentKey, checksum: hash(canonicalJson(differentKey)) }),
      })
    ).toThrow(/idempotency keys disagree/);
    for (const invalid of [
      { ...payload, cumulative_usage: { ...payload.cumulative_usage, input_tokens: -1 } },
      { ...payload, model_breakdown: undefined },
      { ...payload, extra: 'unique source' },
    ]) {
      const bytes = encodeUsage(invalid);
      expect(() => decodeLegacyLog({ kind: 'usage', bytes })).toThrow(/usage payload/);
    }
    function encodeUsage(value: unknown) {
      const changed = { ...unsigned, payload: value };
      return log({ ...changed, checksum: hash(canonicalJson(changed)) });
    }
    const sidecar = Buffer.from('  ' + JSON.stringify(payload) + '\n');
    const { payload: _payload, ...reference } = unsigned;
    const outOfLine = { ...reference, sidecar_sha256: hash(sidecar), sidecar_size: sidecar.length };
    const decoded = decodeLegacyLog({
      kind: 'usage',
      bytes: log({ ...outOfLine, checksum: hash(canonicalJson(outOfLine)) }),
      sidecars: new Map([[eventId(1), sidecar]]),
    });
    expect(Buffer.from(decoded.sidecars[0]!.bytesBase64, 'base64')).toEqual(sidecar);
    const link = {
      ...unsigned,
      type: 'source_plan_linked',
      payload: {
        canonical_ref_id: 'plan-1',
        artifact_id: eventId(4),
        linked_at: unsigned.ts,
        pinned_version: null,
      },
    };
    expect(
      decodeLegacyLog({
        kind: 'usage',
        bytes: log({ ...link, checksum: hash(canonicalJson(link)) }),
      }).events[0]!.payload
    ).toEqual(link.payload);
    const mismatch = { ...link, payload };
    expect(() =>
      decodeLegacyLog({
        kind: 'usage',
        bytes: log({ ...mismatch, checksum: hash(canonicalJson(mismatch)) }),
      })
    ).toThrow(/usage payload/);
  });
  it('retains exact source bytes while freezing parsed content', () => {
    const bytes = Buffer.from(
      '  ' + JSON.stringify(record(1, { reason: 'explicit-checkout' })) + '\n'
    );
    const decoded = decodeLegacyLog({ kind: 'artifact', bytes });
    expect(decoded.sha256).toBe(hash(bytes));
    expect(Buffer.from(decoded.bytesBase64, 'base64')).toEqual(bytes);
    bytes.fill(0);
    expect(decoded.events[0]!.record.event_id).toBe(eventId(1));
    expect(Object.isFrozen(decoded.events[0]!.payload)).toBe(true);
  });

  it('rejects changed content even when it remains structurally valid JSON', () => {
    const original = record(1, { reason: 'explicit-checkout' });
    expect(() =>
      decodeLegacyLog({
        kind: 'artifact',
        bytes: log({ ...original, payload: { reason: 'changed' } }),
      })
    ).toThrow(expect.objectContaining({ code: 'SOURCE_INTEGRITY' }));
  });

  it.each([
    Buffer.from(JSON.stringify(record(1, {}))),
    Buffer.from('{bad json}\n'),
    Buffer.from([0xff, 0x0a]),
    Buffer.from('\n'),
  ])('rejects incomplete or invalid source bytes without skipping them', (bytes) => {
    expect(() => decodeLegacyLog({ kind: 'artifact', bytes })).toThrow(
      expect.objectContaining({ code: 'SOURCE_INTEGRITY' })
    );
  });

  it('rejects repeated event IDs even when their bytes are equal', () => {
    const row = record(1, {});
    expect(() => decodeLegacyLog({ kind: 'artifact', bytes: log(row, row) })).toThrow(
      /repeats an event/
    );
  });

  it('verifies exact sidecar bytes and preserves their original representation', () => {
    const sidecar = Buffer.from('{ "reason": "explicit-checkout" }\n');
    const { payload: _payload, checksum: _checksum, ...inline } = record(1, {});
    const value = { ...inline, sidecar_sha256: hash(sidecar), sidecar_size: sidecar.length };
    const row = { ...value, checksum: hash(canonicalJson(value)) };
    const sidecars = new Map([[eventId(1), sidecar]]);
    const decoded = decodeLegacyLog({ kind: 'artifact', bytes: log(row), sidecars });
    expect(decoded.events[0]!.payload).toEqual({ reason: 'explicit-checkout' });
    expect(Buffer.from(decoded.sidecars[0]!.bytesBase64, 'base64')).toEqual(sidecar);
    sidecar[3] = 0;
    expect(() => decodeLegacyLog({ kind: 'artifact', bytes: log(row), sidecars })).toThrow(
      /sidecar/
    );
    expect(() => decodeLegacyLog({ kind: 'artifact', bytes: log(row) })).toThrow(/sidecar/);
  });

  it('refuses unreferenced sidecars instead of silently dropping unique input', () => {
    expect(() =>
      decodeLegacyLog({
        kind: 'artifact',
        bytes: log(record(1, {})),
        sidecars: new Map([[eventId(2), Buffer.from('{}')]]),
      })
    ).toThrow(/unreferenced sidecar/);
  });
});

describe('ordered source continuation', () => {
  it('selects a verified longer prefix independently of event timestamps', () => {
    const first = record(1, {}, '2026-08-01T00:00:00.000Z');
    const second = record(2, {}, '2026-04-01T00:00:00.000Z');
    const short = decodeLegacyLog({ kind: 'artifact', bytes: log(first) });
    const long = decodeLegacyLog({ kind: 'artifact', bytes: log(first, second) });
    const selected = selectLegacyContinuation([
      { sourceId: 'newer', log: short },
      { sourceId: 'older', log: long },
    ]);
    expect(selected.sourceId).toBe('older');
    expect(selected.sources).toEqual([
      { sourceId: 'newer', sha256: short.sha256, relation: 'prefix' },
      { sourceId: 'older', sha256: long.sha256, relation: 'equal' },
    ]);
  });

  it('refuses divergent and reordered histories rather than concatenating them', () => {
    const first = record(1, {});
    const second = record(2, {});
    const source = decodeLegacyLog({ kind: 'artifact', bytes: log(first, second) });
    for (const other of [
      log(first, record(3, {})),
      log(second, first),
      log(record(1, { redacted: true }), second),
    ]) {
      expect(() =>
        selectLegacyContinuation([
          { sourceId: 'left', log: source },
          { sourceId: 'right', log: decodeLegacyLog({ kind: 'artifact', bytes: other }) },
        ])
      ).toThrow(expect.objectContaining({ code: 'SOURCE_CONFLICT' }));
    }
  });

  it('refuses structurally forged logs and duplicate source labels', () => {
    const valid = decodeLegacyLog({ kind: 'artifact', bytes: log(record(1, {})) });
    expect(() =>
      selectLegacyContinuation([{ sourceId: 'forged', log: { ...valid } as LegacyLog }])
    ).toThrow(/independently decoded/);
    expect(() =>
      selectLegacyContinuation([
        { sourceId: 'same', log: valid },
        { sourceId: 'same', log: valid },
      ])
    ).toThrow(/distinct explicit/);
  });
});
