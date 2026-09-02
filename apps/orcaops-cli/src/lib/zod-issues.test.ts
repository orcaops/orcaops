import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { formatZodIssues, zodIssueHint, zodIssuePath } from './zod-issues.js';

function issuesOf(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('expected the parse to fail');
  return result.error.issues;
}

describe('zodIssuePath', () => {
  it('joins a nested path and names the root', () => {
    const schema = z.object({ a: z.object({ b: z.string() }) });
    expect(zodIssuePath(issuesOf(schema, { a: { b: 1 } })[0]!)).toBe('a.b');
    expect(zodIssuePath(issuesOf(z.string(), 1)[0]!)).toBe('(root)');
  });
});

describe('zodIssueHint', () => {
  it('nudges toward quoting when YAML coercion produced the wrong type', () => {
    // `0123` unquoted in YAML parses as a number, so a string field fails
    // here rather than at the YAML parse — the cause is invisible otherwise.
    const hint = zodIssueHint(issuesOf(z.object({ label: z.string() }), { label: 123 })[0]!);
    expect(hint).toContain('block scalar');
    expect(hint).toContain('quote the value');
  });

  it('gives the structured-value hint instead when an object reached a string field', () => {
    // Quoting cannot turn an object into a string, so the other hint would
    // send the author down a dead end.
    const hint = zodIssueHint(
      issuesOf(z.object({ items: z.array(z.string()) }), {
        items: [{ decision: 'd', reason: 'r' }],
      })[0]!
    );
    expect(hint).toContain('structured value');
    expect(hint).toContain('deferred_decisions');
    expect(hint).not.toContain('block scalar');
  });

  it('adds nothing to unrelated issues', () => {
    expect(zodIssueHint(issuesOf(z.object({ n: z.number() }), { n: 'x' })[0]!)).toBe('');
  });
});

describe('formatZodIssues', () => {
  it('renders a single issue as one line', () => {
    const out = formatZodIssues(issuesOf(z.object({ a: z.string() }), { a: 1 }));
    expect(out.startsWith('a: ')).toBe(true);
    expect(out).not.toContain('\n');
  });

  it('renders EVERY issue when a parse produces several', () => {
    // The failure this replaces: reporting issues[0] alone turns one round of
    // fixes into as many rounds as there are mistakes.
    const schema = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
    const out = formatZodIssues(issuesOf(schema, { a: 1, b: 'x', c: 'y' }));
    expect(out).toContain('a: ');
    expect(out).toContain('b: ');
    expect(out).toContain('c: ');
    expect(out.split('\n')).toHaveLength(3);
  });

  it('caps the list and says how many it dropped', () => {
    const shape = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`f${i}`, z.string()])
    ) as Record<string, z.ZodString>;
    const value = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, i]));
    const out = formatZodIssues(issuesOf(z.object(shape), value));
    expect(out).toContain('…and 5 more issue(s)');
  });

  it('carries the hint through into the rendered lines', () => {
    const out = formatZodIssues(
      issuesOf(z.object({ label: z.string(), n: z.number() }), { label: 123, n: 'x' })
    );
    expect(out).toContain('block scalar');
  });

  it('handles an empty issue list', () => {
    expect(formatZodIssues([])).toBe('Invalid input');
  });
});
