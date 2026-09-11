import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { redactSecretsInValue } from './legacy/protocol/secrets.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { decodeLegacyLog } from './log.js';
import {
  assertLegacyLogSelection,
  type LegacyLogSource,
  selectLegacyRepresentation,
} from './representation.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const eventId = (n: number) => `01999999-9999-7000-8000-${String(n).padStart(12, '0')}`;
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
const source = (sourceId: string, records: unknown[]): LegacyLogSource => ({
  sourceId,
  log: decodeLegacyLog({
    kind: 'artifact',
    bytes: Buffer.from(records.map((row) => JSON.stringify(row) + '\n').join('')),
  }),
});
const choice = (sources: readonly LegacyLogSource[], sourceId: string) => ({
  sourceId,
  sources: sources.map((source) => ({ sourceId: source.sourceId, sha256: source.log.sha256 })),
});

describe('retained representation selection', () => {
  it('selects complete ordered continuation while retaining every original source identity', () => {
    const first = record(1, { value: 'first' }, '2026-08-01T00:00:00.000Z');
    const last = record(2, { value: 'second' }, '2026-04-01T00:00:00.000Z');
    const sources = [source('short', [first]), source('long', [first, last])];
    const selected = selectLegacyRepresentation(sources);
    expect(selected.sourceId).toBe('long');
    expect(selected.sources).toEqual([
      expect.objectContaining({ sourceId: 'long', relation: 'equal', fidelity: 'same-payload' }),
      expect.objectContaining({ sourceId: 'short', relation: 'prefix', fidelity: 'same-payload' }),
    ]);
    expect(() => assertLegacyLogSelection(selected)).not.toThrow();
    expect(() => assertLegacyLogSelection({ ...selected })).toThrow();
    expect(() => selectLegacyRepresentation(sources, choice(sources, 'short'))).toThrow(
      /omit retained/
    );
  });
  it('requires a complete hash-bound choice for frozen redaction and discloses either selected fidelity', () => {
    const raw = {
      reason: 'api_key=testing1234',
      nested: ['unchanged', { value: 'password=example123' }],
    };
    const redacted = redactSecretsInValue(raw);
    expect(redacted).toEqual({
      reason: 'api_key=[REDACTED_SECRET]',
      nested: ['unchanged', { value: 'password=[REDACTED_SECRET]' }],
    });
    const sources = [source('raw', [record(1, raw)]), source('archive', [record(1, redacted)])];
    expect(() => selectLegacyRepresentation(sources)).toThrow(/hash-bound reviewed/);
    const safe = selectLegacyRepresentation(sources, choice(sources, 'archive'));
    expect(safe.sources).toContainEqual(
      expect.objectContaining({
        sourceId: 'raw',
        fidelity: 'selected-redacted',
        differentPayloads: 1,
      })
    );
    const original = selectLegacyRepresentation(sources, choice(sources, 'raw'));
    expect(original.sources).toContainEqual(
      expect.objectContaining({
        sourceId: 'archive',
        fidelity: 'selected-unredacted',
        differentPayloads: 1,
      })
    );
    expect(() =>
      selectLegacyRepresentation(sources, {
        ...choice(sources, 'archive'),
        sources: choice(sources, 'archive').sources.slice(1),
      })
    ).toThrow(/complete source manifest/);
    expect(() =>
      selectLegacyRepresentation(sources, {
        ...choice(sources, 'archive'),
        sources: choice(sources, 'archive').sources.map((entry) => ({
          ...entry,
          sha256: '0'.repeat(64),
        })),
      })
    ).toThrow(/complete source manifest/);
    expect(Object.isFrozen(safe.sources[0])).toBe(true);
    expect(
      JSON.stringify({ manifestHash: safe.manifestHash, sources: safe.sources })
    ).not.toContain('testing1234');
  });
  it('rejects altered semantic content, two different raw secrets, reordered IDs and changed envelopes despite a reviewed choice', () => {
    const original = source('left', [record(1, { value: 'api_key=testing1234' }), record(2, {})]);
    for (const records of [
      [record(1, { value: 'api_key=othersecret' }), record(2, {})],
      [record(1, { value: 'unrelated prose' }), record(2, {})],
      [record(2, {}), record(1, { value: 'api_key=testing1234' })],
      [record(1, { value: 'api_key=testing1234' }, '2026-04-27T12:00:00.000Z'), record(2, {})],
    ]) {
      const sources = [original, source('right', records)];
      expect(() => selectLegacyRepresentation(sources, choice(sources, 'right'))).toThrow(
        expect.objectContaining({ code: 'SOURCE_CONFLICT' })
      );
    }
  });
  it('accepts identical payload with different inline/sidecar storage while preserving selected bytes', () => {
    const payload = { value: 'same content' };
    const inline = record(1, payload);
    const { payload: _payload, checksum: _checksum, ...envelope } = inline;
    const bytes = Buffer.from('  ' + JSON.stringify(payload) + '\n');
    const unsigned = { ...envelope, sidecar_sha256: hash(bytes), sidecar_size: bytes.length };
    const outOfLine = { ...unsigned, checksum: hash(canonicalJson(unsigned)) };
    const sidecar = {
      sourceId: 'archive',
      log: decodeLegacyLog({
        kind: 'artifact',
        bytes: Buffer.from(JSON.stringify(outOfLine) + '\n'),
        sidecars: new Map([[eventId(1), bytes]]),
      }),
    };
    const selected = selectLegacyRepresentation([source('hot', [inline]), sidecar]);
    expect(selected.sourceId).toBe('archive');
    expect(selected.sources.every((entry) => entry.fidelity === 'same-payload')).toBe(true);
    expect(Buffer.from(selected.log.sidecars[0]!.bytesBase64, 'base64')).toEqual(bytes);
  });
  it('rejects forged decoded inputs and does not equate two redacted descendants without direct evidence', () => {
    const first = source('left', [record(1, { a: '[REDACTED_SECRET]', b: 'password=example123' })]);
    const second = source('right', [
      record(1, { a: 'api_key=testing1234', b: '[REDACTED_SECRET]' }),
    ]);
    expect(() =>
      selectLegacyRepresentation([first, { ...second, log: { ...second.log } }])
    ).toThrow(/independently decoded/);
    expect(() =>
      selectLegacyRepresentation([first, second], choice([first, second], 'right'))
    ).toThrow(/beyond the frozen/);
    expect(() => selectLegacyRepresentation([first, first])).toThrow(/distinct source/);
  });
});
