import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { PlanContext } from '@orcaops/evaluator-protocol';
import { runFixture } from '@orcaops/evaluator-sdk';
import { makeContext } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/core');

function makeRevisionContext(opts: { priorNonGoals: string[]; currentNonGoals: string[] }): {
  plan: PlanContext;
  prior_plan: PlanContext;
} {
  const basePlan = makeContext().plan;
  // Map the test's string inputs to structured NonGoal objects; the
  // evaluator dedups on `.text`, so removal detection is unchanged.
  const toNonGoals = (texts: string[]): PlanContext['non_goals'] =>
    texts.map((text) => ({ text, rationale: 'out of scope', source_refs: [] }));
  return {
    plan: {
      ...basePlan,
      revision_n: 1,
      rationale: 'narrowed scope',
      non_goals: toNonGoals(opts.currentNonGoals),
    },
    prior_plan: {
      ...basePlan,
      revision_n: 0,
      non_goals: toNonGoals(opts.priorNonGoals),
    },
  };
}

describe('revision-non-goals-stable (runFixture)', () => {
  it('pass: non-goals unchanged across revision', async () => {
    const { plan, prior_plan } = makeRevisionContext({
      priorNonGoals: ['no schema migration', 'no auth change'],
      currentNonGoals: ['no schema migration', 'no auth change'],
    });
    const ctx = makeContext({
      evaluator_ref: 'core/revision-non-goals-stable',
      phase: 'post-plan-revision',
      plan,
      prior_plan,
    });
    const r = await runFixture({
      command: ['node', './runtime/revision-non-goals-stable.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/Non-goals unchanged across revision/);
  });

  it('violation: revision removes a non-goal', async () => {
    const { plan, prior_plan } = makeRevisionContext({
      priorNonGoals: ['no schema migration', 'no auth change'],
      currentNonGoals: ['no auth change'],
    });
    const ctx = makeContext({
      evaluator_ref: 'core/revision-non-goals-stable',
      phase: 'post-plan-revision',
      plan,
      prior_plan,
    });
    const r = await runFixture({
      command: ['node', './runtime/revision-non-goals-stable.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('violation');
    expect(r.envelope.body).toMatch(/removed 1 non-goal/);
  });
});
