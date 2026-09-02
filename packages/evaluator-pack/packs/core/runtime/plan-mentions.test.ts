import { describe, expect, it } from 'vitest';

import type { EvaluatorContext } from '@orcaops/evaluator-protocol';
import { makeContext as makeBaseContext, makePlanStep } from '@orcaops/evaluator-sdk';

import { check } from './plan-mentions.js';

/**
 * Pure-function tests for the plan-mentions checker. These import the
 * check() export directly, bypassing the @orcaops/evaluator-sdk
 * subprocess path. runFixture-based subprocess tests are canonical
 * for the production execution path; these unit-level tests cover the
 * logic branches in isolation.
 */

type StepInput = string | { text: string; acceptanceCriteria?: string[] };

function makeContext(plan: {
  plan_steps: StepInput[];
  touched_scope?: string[];
}): EvaluatorContext {
  const base = makeBaseContext();
  return makeBaseContext({
    evaluator_ref: 'core/plan-mentions-tests',
    plan: {
      ...base.plan,
      plan_steps: plan.plan_steps.map((input, i) => {
        const text = typeof input === 'string' ? input : input.text;
        const step = makePlanStep(i + 1, text, `step-${i + 1}`);
        return {
          ...step,
          acceptance_criteria:
            typeof input === 'string'
              ? []
              : (input.acceptanceCriteria ?? []).map((criterion, criterionIndex) => ({
                  criterion_id: makePlanStep(100 + i * 10 + criterionIndex, criterion).step_id,
                  text: criterion,
                })),
        };
      }),
      touched_scope: plan.touched_scope ?? [],
    },
    params: { tokens: ['test', 'tests', 'spec', 'specs'] },
  });
}

describe('plan-mentions check()', () => {
  it('passes when at least one step mentions a token', () => {
    const ctx = makeContext({
      plan_steps: ['build the rate limiter', 'add tests for the limiter'],
    });
    const result = check(ctx);
    expect(result.verdict).toBe('pass');
    expect(result.body).toMatch(/findings/);
  });

  it('passes when test intent appears only in an acceptance criterion', () => {
    const ctx = makeContext({
      plan_steps: [
        {
          text: 'build the rate limiter',
          acceptanceCriteria: ['the focused regression tests pass'],
        },
      ],
    });

    const result = check(ctx);

    expect(result.verdict).toBe('pass');
    expect(result.body).toContain('step 1, criterion 1');
    expect(result.raw).toMatchObject({
      inspected: { steps: 1, criteria: 1 },
      matches: [{ source: 'criterion', stepIndex: 1, criterionIndex: 1 }],
    });
  });

  it.each(['unit-test coverage', 'update foo.test.ts', 'RUN TESTS'])(
    'matches bounded token usage in %s',
    (text) => {
      expect(check(makeContext({ plan_steps: [text] })).verdict).toBe('pass');
    }
  );

  it.each([
    'contest rollout behavior',
    'attest compatibility',
    'special handling',
    'specify the API',
  ])('does not match embedded token text in %s', (text) => {
    expect(check(makeContext({ plan_steps: [text] })).verdict).toBe('violation');
  });

  it('treats configured tokens as literals', () => {
    const ctx = makeContext({ plan_steps: ['run the test+case check'] });
    ctx.params = { tokens: ['TEST+CASE'] };

    const result = check(ctx);
    expect(result.verdict).toBe('pass');
    expect(result.raw).toMatchObject({ matches: [{ matched: 'test+case' }] });
  });

  it.each([
    'no tests needed',
    'tests are not needed',
    "tests aren't needed",
    'do not run tests',
    'skip tests',
    'tests are out of scope',
    'tests are deferred',
    'exclude tests',
    'tests should be skipped',
    'No regression tests are needed',
    'Without tests, continue',
  ])('ignores negated test intent in %s', (text) => {
    const result = check(makeContext({ plan_steps: [text] }));
    expect(result.verdict).toBe('violation');
    expect(result.body).toContain('ignored negated evidence');
  });

  it.each(['No regression tests fail', 'Without tests failing, continue'])(
    'recognizes positive test intent in %s',
    (text) => {
      expect(check(makeContext({ plan_steps: [text] })).verdict).toBe('pass');
    }
  );

  it('accepts a positive occurrence after a negated clause', () => {
    const ctx = makeContext({
      plan_steps: ['No tests existed previously; add regression tests for the corrected behavior'],
    });

    expect(check(ctx).verdict).toBe('pass');
  });

  it('accepts a later configured token after an earlier token is negated', () => {
    const ctx = makeContext({
      plan_steps: ['Do not run tests; add a focused spec for the corrected behavior'],
    });

    expect(check(ctx).verdict).toBe('pass');
  });

  it.each(['Tests are deferred; add regression tests', 'Exclude tests; add a focused spec'])(
    'accepts a positive occurrence after a negative commitment in %s',
    (text) => {
      expect(check(makeContext({ plan_steps: [text] })).verdict).toBe('pass');
    }
  );

  it('violates when no step mentions any token', () => {
    const ctx = makeContext({
      plan_steps: ['build the rate limiter', 'mount the middleware'],
    });
    const result = check(ctx);
    expect(result.verdict).toBe('violation');
    expect(result.body).toMatch(/No explicit, non-negated test intent/);
    expect(result.raw).toMatchObject({
      planSteps: ['build the rate limiter', 'mount the middleware'],
    });
  });

  it('passes when an exempt scope matches even without mentions', () => {
    const ctx = makeContext({
      plan_steps: [
        {
          text: 'just a refactor pass',
          acceptanceCriteria: ['the refactor preserves formatting'],
        },
      ],
      touched_scope: ['refactor'],
    });
    ctx.params = { tokens: ['test'], exempt_scopes: ['refactor'] };
    const result = check(ctx);
    expect(result.verdict).toBe('pass');
    expect(result.body).toContain('Token inspection was skipped');
    expect(result.body).toContain('0 plan steps');
    expect(result.body).toContain('1 plan step');
    expect(result.raw).toEqual({
      inspected: { steps: 0, criteria: 0 },
      available: { steps: 1, criteria: 1 },
      inspectionSkipped: {
        reason: 'all-declared-scopes-exempt',
        declaredScopes: ['refactor'],
      },
    });
  });

  it('preserves the non-exempt raw compatibility fields', () => {
    const passing = check(makeContext({ plan_steps: ['add focused tests'] }));
    const violating = check(makeContext({ plan_steps: ['update runtime behavior'] }));

    expect(Object.keys(passing.raw ?? {}).sort()).toEqual(['inspected', 'matches']);
    expect(Object.keys(violating.raw ?? {}).sort()).toEqual([
      'inspected',
      'negatedMatches',
      'planSteps',
      'tokens',
    ]);
  });

  it('does not exempt an empty scope', () => {
    const ctx = makeContext({ plan_steps: ['update the implementation'] });
    ctx.params = { tokens: ['test'], exempt_scopes: ['docs'] };

    expect(check(ctx).verdict).toBe('violation');
  });

  it('does not exempt mixed functional and non-functional scopes', () => {
    const ctx = makeContext({
      plan_steps: ['update the implementation'],
      touched_scope: ['runtime', 'docs'],
    });
    ctx.params = { tokens: ['test'], exempt_scopes: ['docs'] };

    expect(check(ctx).verdict).toBe('violation');
  });

  it('exempts a non-empty scope only when every tag is exempt', () => {
    const ctx = makeContext({
      plan_steps: ['update prose formatting'],
      touched_scope: ['docs', 'formatting'],
    });
    ctx.params = { tokens: ['test'], exempt_scopes: ['docs', 'formatting'] };

    expect(check(ctx).verdict).toBe('pass');
  });
});
