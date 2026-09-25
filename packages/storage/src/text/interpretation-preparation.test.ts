import { expect, it } from 'vitest';

import { REDACTION_MARKER } from '@orcaops/evaluator-protocol/secrets';

import { prepareInterpretationText } from './interpretation-preparation.js';

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

it('maps Unicode and removed controls without inventing original bytes', () => {
  const original = 'café\u0007choose';
  const prepared = prepareInterpretationText(original);

  expect(prepared.prepared).toBe('caféchoose');
  expect(prepared.mapping).toEqual([
    {
      kind: 'copied',
      prepared: { start: 0, end: bytes('café') },
      original: { start: 0, end: bytes('café') },
    },
    {
      kind: 'removed_control',
      prepared: { start: bytes('café'), end: bytes('café') },
      original: { start: bytes('café'), end: bytes('café\u0007') },
    },
    {
      kind: 'copied',
      prepared: { start: bytes('café'), end: bytes('caféchoose') },
      original: { start: bytes('café\u0007'), end: bytes(original) },
    },
  ]);
});

it('marks secret replacement bytes as redacted instead of quoted original text', () => {
  const prefix = 'token=';
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
  const suffix = ' retained';
  const prepared = prepareInterpretationText(`${prefix}${secret}${suffix}`);

  expect(prepared.prepared).toBe(`${prefix}${REDACTION_MARKER}${suffix}`);
  expect(prepared.mapping).toEqual([
    {
      kind: 'copied',
      prepared: { start: 0, end: bytes(prefix) },
      original: { start: 0, end: bytes(prefix) },
    },
    {
      kind: 'redacted',
      prepared: { start: bytes(prefix), end: bytes(prefix + REDACTION_MARKER) },
      original: { start: bytes(prefix), end: bytes(prefix + secret) },
    },
    {
      kind: 'copied',
      prepared: {
        start: bytes(prefix + REDACTION_MARKER),
        end: bytes(prefix + REDACTION_MARKER + suffix),
      },
      original: { start: bytes(prefix + secret), end: bytes(prefix + secret + suffix) },
    },
  ]);
});

it('produces stable content and mapping hashes', () => {
  const first = prepareInterpretationText('Résumé\u0000is ready');
  const second = prepareInterpretationText('Résumé\u0000is ready');

  expect(second).toEqual(first);
  expect(first.originalSha256).not.toBe(first.preparedSha256);
  expect(first.mappingSha256).toMatch(/^[0-9a-f]{64}$/u);
});

it('keeps contiguous original byte positions across many Unicode and control runs', () => {
  const part = 'é🚲\u0000';
  const prepared = prepareInterpretationText(part.repeat(5000));
  expect(prepared.prepared).toBe('é🚲'.repeat(5000));
  expect(prepared.mapping).toHaveLength(10000);
  for (const [index, run] of prepared.mapping.entries()) {
    const before = Math.floor(index / 2) * bytes(part);
    expect(run.original).toEqual(
      index % 2 === 0
        ? { start: before, end: before + bytes('é🚲') }
        : { start: before + bytes('é🚲'), end: before + bytes(part) }
    );
  }
});
