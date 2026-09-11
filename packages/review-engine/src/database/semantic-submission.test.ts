import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { prepareDatabaseSemanticSubmission } from './semantic-submission.js';

const prepare = (bytes: Uint8Array, maximumBytes = 128_000) =>
  prepareDatabaseSemanticSubmission({ bytes, maximumBytes, secretAllow: [] });

describe('semantic submission preparation', () => {
  it('retains exact authored UTF-8 bytes separately from canonical normalization', () => {
    const bytes = Buffer.from(' { "dispositions": [], "schema_version": 3 }\n');
    const result = prepare(bytes);
    expect(result.bytes.equals(bytes)).toBe(true);
    expect(result.raw_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.normalization).toBe('CLEAN_JSON');
    expect(result.canonical).toEqual({ schema_version: 3, dispositions: [] });
    bytes.fill(0);
    expect(result.bytes.toString()).toBe(' { "dispositions": [], "schema_version": 3 }\n');
  });

  it('unwraps one JSON string without replacing the original bytes or raw hash', () => {
    const bytes = Buffer.from(JSON.stringify('{"schema_version":3,"dispositions":[]}'));
    const result = prepare(bytes);
    expect(result.normalization).toBe('JSON_STRING_UNWRAPPED');
    expect(result.raw_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.normalized_sha256).not.toBe(result.raw_sha256);
    expect(result.canonical).toEqual({ schema_version: 3, dispositions: [] });
  });

  it('preserves an invalid model submission for a rejected attempt without accepting it', () => {
    const result = prepare(Buffer.from('not JSON'));
    expect(result.normalization).toBe('INVALID_JSON');
    expect(result.canonical).toBeNull();
    expect(result.bytes.toString()).toBe('not JSON');
    expect(result).not.toHaveProperty('accepted');
  });

  it('refuses escaped secrets even in discarded duplicate JSON fields', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const escaped = token.replace('g', '\\u0067');
    expect(() => prepare(Buffer.from(`{"discarded":"${escaped}","discarded":null}`))).toThrow(
      expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
    );
  });

  it('enforces the original UTF-8 byte ceiling without truncation', () => {
    const bytes = Buffer.from('"é"');
    expect(prepare(bytes, bytes.length).bytes.equals(bytes)).toBe(true);
    expect(() => prepare(bytes, bytes.length - 1)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
    for (const maximum of [0, -1, 1.5, NaN, Infinity, 128_001])
      expect(() => prepare(bytes, maximum)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' })
      );
  });

  it('refuses invalid UTF-8 and sparse secret allowlists', () => {
    expect(() => prepare(Uint8Array.from([255]))).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
    expect(() =>
      prepareDatabaseSemanticSubmission({
        bytes: Buffer.from('{}'),
        maximumBytes: 128_000,
        secretAllow: new Array<string>(1),
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
