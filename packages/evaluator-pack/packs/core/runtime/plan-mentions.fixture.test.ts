import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { EvaluatorContext } from '@orcaops/evaluator-protocol';
import { makeContext as makeBaseContext, makePlanStep } from '@orcaops/evaluator-sdk';
import { runFixture } from '@orcaops/evaluator-sdk';

/**
 * runFixture-based subprocess test for plan-mentions. This exercises
 * the same production code path the runner uses (spawn → ORCAOPS_CONTEXT_PATH
 * env → stdout envelope → schema validation) rather than calling
 * `check()` in-process as the unit tests do.
 *
 * Convention: every deterministic command-engine evaluator ships ≥1
 * pass and ≥1 violation fixture case. The fixture contexts below
 * are inline in this file rather than separate `*.context.json` files
 * to keep the proof-of-pattern self-contained; future evaluator
 * fixture suites can choose either inline (smaller pack) or external
 * (easier to read in isolation).
 */

// runFixture spawns the compiled .js the resolver places at dist/packs/<id>/
// runtime/<file>.js. Point cwd at dist/packs/core so the spec-declared
// relative path `./runtime/plan-mentions.js` resolves.
const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/core');

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

describe('plan-mentions (runFixture / subprocess)', () => {
  it('pass: a plan step that mentions a token produces verdict=pass', async () => {
    const result = await runFixture({
      command: ['node', './runtime/plan-mentions.js'],
      cwd: packRoot,
      context: makeContext({
        plan_steps: ['build the rate limiter', 'add tests for the limiter'],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope.verdict).toBe('pass');
    expect(result.envelope.body).toMatch(/findings/);
  });

  it('passes when test intent exists only in an acceptance criterion', async () => {
    const result = await runFixture({
      command: ['node', './runtime/plan-mentions.js'],
      cwd: packRoot,
      context: makeContext({
        plan_steps: [
          {
            text: 'build the rate limiter',
            acceptanceCriteria: ['the focused regression tests pass'],
          },
        ],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.verdict).toBe('pass');
    expect(result.envelope.raw).toMatchObject({
      matches: [{ source: 'criterion', stepIndex: 1, criterionIndex: 1 }],
    });
  });

  it('violation: no plan step mentions any token → verdict=violation', async () => {
    const result = await runFixture({
      command: ['node', './runtime/plan-mentions.js'],
      cwd: packRoot,
      context: makeContext({
        plan_steps: ['build the rate limiter', 'mount the middleware'],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope.verdict).toBe('violation');
    expect(result.envelope.body).toMatch(/No explicit, non-negated test intent/);
  });

  it('rejects embedded and negated token occurrences through the command engine', async () => {
    const result = await runFixture({
      command: ['node', './runtime/plan-mentions.js'],
      cwd: packRoot,
      context: makeContext({
        plan_steps: [
          {
            text: 'specify the contest behavior',
            acceptanceCriteria: ['no tests are needed'],
          },
        ],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.verdict).toBe('violation');
    expect(result.envelope.body).toContain('1 acceptance criterion');
    expect(result.envelope.body).toContain('ignored negated evidence');
  });

  it('recognizes positive double-negative intent through the command engine', async () => {
    const result = await runFixture({
      command: ['node', './runtime/plan-mentions.js'],
      cwd: packRoot,
      context: makeContext({
        plan_steps: ['No regression tests fail'],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.verdict).toBe('pass');
    expect(result.envelope.raw).toMatchObject({
      matches: [{ matched: 'tests', source: 'step', stepIndex: 1 }],
    });
  });

  it('rejects a negative test commitment through the command engine', async () => {
    const result = await runFixture({
      command: ['node', './runtime/plan-mentions.js'],
      cwd: packRoot,
      context: makeContext({
        plan_steps: ['tests are deferred'],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.verdict).toBe('violation');
    expect(result.envelope.raw).toMatchObject({
      negatedMatches: [{ matched: 'tests', source: 'step', stepIndex: 1 }],
    });
  });

  it('reports skipped and available evidence for an exempt plan', async () => {
    const context = makeContext({
      plan_steps: [
        {
          text: 'correct README punctuation',
          acceptanceCriteria: ['the rendered paragraph remains readable'],
        },
      ],
      touched_scope: ['docs'],
    });
    context.params = {
      tokens: ['test', 'tests', 'spec', 'specs'],
      exempt_scopes: ['docs'],
    };

    const result = await runFixture({
      command: ['node', './runtime/plan-mentions.js'],
      cwd: packRoot,
      context,
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.verdict).toBe('pass');
    expect(result.envelope.body).toContain('Token inspection was skipped');
    expect(result.envelope.raw).toEqual({
      inspected: { steps: 0, criteria: 0 },
      available: { steps: 1, criteria: 1 },
      inspectionSkipped: {
        reason: 'all-declared-scopes-exempt',
        declaredScopes: ['docs'],
      },
    });
  });
});
