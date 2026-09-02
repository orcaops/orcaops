import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  assertNoForbiddenControlChars,
  collectControlCharPaths,
  containsForbiddenControlChars,
  deepStripControlChars,
  ForbiddenControlCharError,
  identifierText,
  proseText,
  stripControlChars,
} from './control-chars.js';

// Construct control chars at runtime via char codes so this SOURCE file never
// embeds a raw control byte (the exact failure mode the module exists to stop).
const NUL = String.fromCharCode(0x00);
const BS = String.fromCharCode(0x08); // backspace
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const CSI = String.fromCharCode(0x9b);

describe('stripControlChars', () => {
  it('removes C0, DEL, and C1 controls', () => {
    expect(stripControlChars(`a${NUL}b`)).toBe('ab');
    expect(stripControlChars(`a${BS}b${ESC}c${DEL}d${CSI}e`)).toBe('abcde');
  });

  it('preserves tab, newline, carriage return', () => {
    expect(stripControlChars('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('is identity (same value) for clean strings and idempotent', () => {
    const clean = 'plain prose with\tlegit\nwhitespace';
    expect(stripControlChars(clean)).toBe(clean);
    const dirty = `x${NUL}y`;
    expect(stripControlChars(stripControlChars(dirty))).toBe(stripControlChars(dirty));
  });

  it('bounds intermediate segments for dense alternating controls', () => {
    const visible = 'x'.repeat(1024 * 1024);
    expect(stripControlChars(`${NUL}x`.repeat(visible.length))).toBe(visible);
  });
});

describe('containsForbiddenControlChars', () => {
  it('true for forbidden control chars, false for whitespace/clean', () => {
    expect(containsForbiddenControlChars(`a${NUL}`)).toBe(true);
    expect(containsForbiddenControlChars(`a${DEL}`)).toBe(true);
    expect(containsForbiddenControlChars(`a${CSI}`)).toBe(true);
    expect(containsForbiddenControlChars('a\t\n\r b')).toBe(false);
    expect(containsForbiddenControlChars('clean')).toBe(false);
  });
});

describe('deepStripControlChars', () => {
  it('strips strings nested in objects and arrays without mutating the input', () => {
    const input = { a: `x${NUL}y`, b: [{ c: `p${ESC}q` }, 'clean'], n: 3, z: null };
    const out = deepStripControlChars(input) as typeof input;
    expect(out).toEqual({ a: 'xy', b: [{ c: 'pq' }, 'clean'], n: 3, z: null });
    // input untouched (immutable)
    expect(input.a).toBe(`x${NUL}y`);
  });

  it('handles the z.unknown() nested-LLM-output shape (raw)', () => {
    const raw = { output: `result${NUL}`, items: [`a${BS}`, 'b'] };
    expect(deepStripControlChars(raw)).toEqual({ output: 'result', items: ['a', 'b'] });
  });

  it('strips forbidden control chars from object KEYS, not just values', () => {
    // The evaluator-raw gap: a NUL can ride in a JSON key (`{"\\u0000x":…}` is
    // valid JSON), which a value-only strip would leave in SQLite/jsonb.
    const raw = { [`k${NUL}ey`]: 'v', nested: { [`${NUL}deep`]: `x${NUL}` } };
    expect(deepStripControlChars(raw)).toEqual({ key: 'v', nested: { deep: 'x' } });
  });
});

describe('collectControlCharPaths', () => {
  it('reports JSON paths of dirty strings', () => {
    const input = { task: `t${NUL}`, steps: [{ text: 'clean' }, { text: `bad${NUL}` }] };
    expect(collectControlCharPaths(input).sort()).toEqual(['steps[1].text', 'task']);
  });

  it('returns empty for clean input', () => {
    expect(collectControlCharPaths({ a: 'b', c: ['d', 'e'] })).toEqual([]);
  });

  it('reports a dirty object KEY with the key sanitized in the path', () => {
    expect(collectControlCharPaths({ [`bad${NUL}key`]: 'cleanvalue', good: 'fine' })).toEqual([
      '{key badkey}',
    ]);
    expect(collectControlCharPaths({ meta: { [`x${NUL}`]: 'v' } })).toEqual(['meta.{key x}']);
  });

  it('reports nested dirty values under a dirty key using only sanitized path segments', () => {
    expect(collectControlCharPaths({ [`bad${NUL}key`]: { value: `dirty${NUL}` } })).toEqual([
      '{key badkey}',
      'badkey.value',
    ]);
  });
});

describe('assertNoForbiddenControlChars (wire-side net)', () => {
  it('throws ForbiddenControlCharError with the first offending path', () => {
    let err: unknown;
    try {
      assertNoForbiddenControlChars({ ok: 'fine', bad: { nested: `x${NUL}` } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenControlCharError);
    expect((err as ForbiddenControlCharError).path).toBe('bad.nested');
  });

  it('does not throw for clean values', () => {
    expect(() => assertNoForbiddenControlChars({ a: 'b\tc\n', arr: ['x'] })).not.toThrow();
  });

  it('rejects C1 display controls on the wire (one policy with capture input)', () => {
    // The wire asserts exactly what capture input rejects; input strips while
    // the wire never mutates persisted content.
    let err: unknown;
    try {
      assertNoForbiddenControlChars({ task: `before${CSI}after` });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenControlCharError);
    expect((err as ForbiddenControlCharError).path).toBe('task');
    expect(proseText().parse(`before${CSI}after`)).toBe('beforeafter');
  });

  it('throws on a forbidden char in an object KEY (closes the evaluator-raw gap)', () => {
    // A key NUL would otherwise slip past both the deep-strip and the assert
    // and 5xx Postgres; the net must see it.
    let err: unknown;
    try {
      assertNoForbiddenControlChars({ evaluators: { runs: [{ raw: { [`k${NUL}`]: 'v' } }] } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenControlCharError);
    expect((err as ForbiddenControlCharError).path).toBe('evaluators.runs[0].raw.{key k}');
  });
});

describe('proseText (strip-then-validate)', () => {
  it('strips control chars and passes the constraint', () => {
    expect(proseText().parse(`hello${NUL} world`)).toBe('hello world');
  });

  it('rejects an all-forbidden required field (sanitize-then-validate, no poison-pill)', () => {
    // `\x00\x00` strips to "" which then fails min(1) → clean ZodError, never a
    // persisted empty required field.
    expect(() => proseText().parse(`${NUL}${NUL}`)).toThrow();
  });

  it('rejects whitespace through the default and a custom constraint', () => {
    expect(() => proseText().parse('  \n\t')).toThrow();
    expect(() => proseText(z.string()).parse('   ')).toThrow();
  });

  it('rejects a blank optional value when it is present', () => {
    const optional = proseText().optional();
    expect(optional.parse(undefined)).toBeUndefined();
    expect(() => optional.parse('   ')).toThrow();
  });

  it('composes with a richer constraint (label: no newlines, <=70, trimmed)', () => {
    const label = proseText(
      z
        .string()
        .min(1)
        .max(70)
        .regex(/^[^\n\r\t]*$/)
        .refine((s) => s.trim() === s)
    );
    expect(label.parse(`Redis${NUL} middleware`)).toBe('Redis middleware');
    // a newline survives the strip (legit whitespace) and then fails the regex
    expect(() => label.parse('two\nlines')).toThrow();
  });
});

describe('identifierText (reject, never strip)', () => {
  it('rejects a control char rather than rewriting the identifier', () => {
    expect(() => identifierText().parse(`01HX${NUL}ID`)).toThrow();
  });

  it('accepts a clean identifier', () => {
    expect(identifierText().parse('019f00b8-c987-79bc')).toBe('019f00b8-c987-79bc');
  });
});
