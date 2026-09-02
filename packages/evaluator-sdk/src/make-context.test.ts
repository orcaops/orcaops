import { describe, expect, it } from 'vitest';

import { EvaluatorContextSchema } from '@orcaops/evaluator-protocol';

import { makeContext, makePlanStep } from './make-context.js';

describe('makeContext', () => {
  it('produces a context that satisfies the strict schema', () => {
    expect(EvaluatorContextSchema.safeParse(makeContext()).success).toBe(true);
  });

  it('carries the nullable keys as explicit null rather than omitting them', () => {
    // The schema is `.strict()`, so an omitted nullable key is a parse error
    // and not a defaulted absence — the exact trap this helper exists for.
    const ctx = makeContext();
    for (const key of ['source_plan', 'current_checkpoint', 'summary'] as const) {
      expect(Object.hasOwn(ctx, key)).toBe(true);
      expect(ctx[key]).toBeNull();
    }
  });

  it('applies overrides on top of the base', () => {
    const ctx = makeContext({ phase: 'pre-pr', changed_files: ['src/a.ts'] });
    expect(ctx.phase).toBe('pre-pr');
    expect(ctx.changed_files).toEqual(['src/a.ts']);
    expect(ctx.evaluator_ref).toBe('core/test');
  });

  it('rejects an override that breaks the contract, at the call site', () => {
    expect(() => makeContext({ phase: 'not-a-phase' as never })).toThrow();
    expect(() => makeContext({ repo: { root: '/repo' } as never })).toThrow();
  });

  it('returns an independent object each call', () => {
    const first = makeContext();
    first.changed_files.push('mutated.ts');
    expect(makeContext().changed_files).toEqual([]);
  });
});

describe('makePlanStep', () => {
  it('mints the keys a plan step must carry', () => {
    const step = makePlanStep(1, 'do the thing');
    expect(step).toEqual({
      step_id: '019e0000-0000-7000-8000-000000000001',
      text: 'do the thing',
      label: 's1',
      acceptance_criteria: [],
    });
  });

  it('produces distinct ids and accepts an explicit label', () => {
    expect(makePlanStep(1, 'a').step_id).not.toBe(makePlanStep(2, 'b').step_id);
    expect(makePlanStep(3, 'c', 'wire it up').label).toBe('wire it up');
  });

  it('parses inside a context', () => {
    const ctx = makeContext({
      plan: { ...makeContext().plan, plan_steps: [makePlanStep(1, 'a'), makePlanStep(2, 'b')] },
    });
    expect(ctx.plan.plan_steps).toHaveLength(2);
  });
});
