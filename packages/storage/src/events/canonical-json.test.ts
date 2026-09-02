import { describe, expect, it } from 'vitest';

import { canonicalJson, CanonicalJsonError } from './canonical-json.js';

describe('canonicalJson', () => {
  describe('primitives', () => {
    it('serializes null', () => {
      expect(canonicalJson(null)).toBe('null');
    });

    it('serializes booleans', () => {
      expect(canonicalJson(true)).toBe('true');
      expect(canonicalJson(false)).toBe('false');
    });

    it('serializes finite numbers identically to JSON.stringify', () => {
      expect(canonicalJson(0)).toBe('0');
      expect(canonicalJson(-1)).toBe('-1');
      expect(canonicalJson(1.5)).toBe('1.5');
      expect(canonicalJson(1e10)).toBe('10000000000');
    });

    it('serializes strings with proper escaping (delegates to JSON.stringify)', () => {
      expect(canonicalJson('hello')).toBe('"hello"');
      expect(canonicalJson('with "quotes"')).toBe('"with \\"quotes\\""');
      expect(canonicalJson('newline\nhere')).toBe('"newline\\nhere"');
      expect(canonicalJson('')).toBe('""');
    });
  });

  describe('arrays', () => {
    it('preserves element order', () => {
      expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    });

    it('emits no whitespace', () => {
      expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    });

    it('handles nested arrays', () => {
      expect(canonicalJson([[1, 2], [3]])).toBe('[[1,2],[3]]');
    });

    it('handles empty arrays', () => {
      expect(canonicalJson([])).toBe('[]');
    });
  });

  describe('objects', () => {
    it('sorts keys lexicographically (codepoint order)', () => {
      const a = { b: 2, a: 1, c: 3 };
      const b = { c: 3, a: 1, b: 2 };
      expect(canonicalJson(a)).toBe(canonicalJson(b));
      expect(canonicalJson(a)).toBe('{"a":1,"b":2,"c":3}');
    });

    it('emits no whitespace', () => {
      expect(canonicalJson({ x: 1, y: 2 })).toBe('{"x":1,"y":2}');
    });

    it('handles nested objects with key sorting at every level', () => {
      const value = { z: { y: 1, x: 2 }, a: { c: 3, b: 4 } };
      expect(canonicalJson(value)).toBe('{"a":{"b":4,"c":3},"z":{"x":2,"y":1}}');
    });

    it('handles empty objects', () => {
      expect(canonicalJson({})).toBe('{}');
    });

    it('drops undefined-valued keys (matches JSON.stringify behavior)', () => {
      expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
    });

    it('mixes objects + arrays + primitives', () => {
      const value = {
        list: [{ id: 2 }, { id: 1 }],
        meta: { count: 2 },
        ok: true,
      };
      expect(canonicalJson(value)).toBe(
        '{"list":[{"id":2},{"id":1}],"meta":{"count":2},"ok":true}'
      );
    });
  });

  describe('canonical equality', () => {
    it('returns identical strings for objects differing only in key order', () => {
      const a = { foo: { bar: 1, baz: 2 }, qux: [3, 2, 1] };
      const b = { qux: [3, 2, 1], foo: { baz: 2, bar: 1 } };
      expect(canonicalJson(a)).toBe(canonicalJson(b));
    });

    it('returns DIFFERENT strings when array order differs (arrays are ordered)', () => {
      expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
    });
  });

  describe('disallowed types', () => {
    it('throws on non-finite numbers', () => {
      expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
      expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(CanonicalJsonError);
      expect(() => canonicalJson(NaN)).toThrow(CanonicalJsonError);
    });

    it('throws on bare undefined (objects drop undefined keys, but undefined as value is invalid)', () => {
      expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    });

    it('throws on bigints / symbols / functions', () => {
      expect(() => canonicalJson(BigInt(1))).toThrow(CanonicalJsonError);
      expect(() => canonicalJson(Symbol('x'))).toThrow(CanonicalJsonError);
      expect(() => canonicalJson(() => 1)).toThrow(CanonicalJsonError);
    });

    it('error path identifies the offending field', () => {
      try {
        canonicalJson({ outer: { list: [1, NaN, 2] } });
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CanonicalJsonError);
        expect((err as CanonicalJsonError).path).toBe('outer.list[1]');
      }
    });
  });
});
