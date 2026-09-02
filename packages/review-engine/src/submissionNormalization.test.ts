import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  canonicalJsonSha256,
  normalizeSubmission,
  sha256,
} from './submissionNormalization.js';

describe('submission normalization lineage', () => {
  it('hashes exact raw bytes and canonicalizes object key order independently', () => {
    const first = '{"z":2,"a":{"y":1,"x":0}}\n';
    const second = '{"a":{"x":0,"y":1},"z":2}';
    const a = normalizeSubmission(first);
    const b = normalizeSubmission(second);

    expect(a.code).toBe('CLEAN_JSON');
    expect(a.raw_sha256).toBe(sha256(first));
    expect(a.raw_sha256).not.toBe(b.raw_sha256);
    expect(a.normalized_sha256).toBe(b.normalized_sha256);
    expect(a.normalized_sha256).toBe(canonicalJsonSha256(a.value));
    expect(canonicalJson(a.value)).toBe('{"a":{"x":0,"y":1},"z":2}');
  });

  it('unwraps exactly one JSON-string layer and records the normalization code', () => {
    const document = { acts: [], questions: [] };
    const wrapped = normalizeSubmission(JSON.stringify(JSON.stringify(document)));
    expect(wrapped.code).toBe('JSON_STRING_UNWRAPPED');
    expect(wrapped.value).toEqual(document);
    expect(wrapped.normalized_sha256).toBe(canonicalJsonSha256(document));

    const doubleWrapped = normalizeSubmission(
      JSON.stringify(JSON.stringify(JSON.stringify(document)))
    );
    expect(doubleWrapped.code).toBe('JSON_STRING_UNWRAPPED');
    expect(typeof doubleWrapped.value).toBe('string');
  });

  it('preserves invalid JSON as the schema input while retaining raw-byte lineage', () => {
    const raw = 'not json {';
    const result = normalizeSubmission(raw);
    expect(result).toEqual({
      value: raw,
      code: 'INVALID_JSON',
      raw_sha256: sha256(raw),
      normalized_sha256: canonicalJsonSha256(raw),
    });
  });
});
