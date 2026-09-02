import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { PlanContext } from '@orcaops/evaluator-protocol';
import { runFixture } from '@orcaops/evaluator-sdk';
import { makeContext, makePlanStep } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/core');

function makeRevisionPlan(opts: {
  revisionN: number;
  steps: string[];
  added: number;
  dropped: number;
  unchanged: number;
}): PlanContext {
  return {
    ...makeContext().plan,
    revision_n: opts.revisionN,
    rationale: 'discovered new prerequisite step',
    revised_at: '2026-05-13T01:00:00.000Z',
    plan_steps: opts.steps.map((text, idx) => makePlanStep(idx + 1, text)),
    step_lineage: {
      added: Array.from(
        { length: opts.added },
        (_, i) => makePlanStep(100 + i, 'placeholder').step_id
      ),
      dropped: Array.from(
        { length: opts.dropped },
        (_, i) => makePlanStep(200 + i, 'placeholder').step_id
      ),
      unchanged: Array.from(
        { length: opts.unchanged },
        (_, i) => makePlanStep(300 + i, 'placeholder').step_id
      ),
      rewritten: [],
    },
  };
}

describe('revision-diff-bounded (runFixture)', () => {
  it('pass: small diff (1 added, 0 dropped against 5 prior) is under threshold', async () => {
    const ctx = makeContext({
      evaluator_ref: 'core/revision-diff-bounded',
      phase: 'post-plan-revision',
      plan: makeRevisionPlan({
        revisionN: 1,
        steps: ['s1', 's2', 's3', 's4', 's5', 's6'],
        added: 1,
        dropped: 0,
        unchanged: 5,
      }),
    });
    const r = await runFixture({
      command: ['node', './runtime/revision-diff-bounded.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/under the/);
  });

  it('violation: large diff (4 added + 1 dropped against 5 prior) exceeds threshold', async () => {
    const ctx = makeContext({
      evaluator_ref: 'core/revision-diff-bounded',
      phase: 'post-plan-revision',
      plan: makeRevisionPlan({
        revisionN: 1,
        steps: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
        added: 4,
        dropped: 1,
        unchanged: 4,
      }),
    });
    const r = await runFixture({
      command: ['node', './runtime/revision-diff-bounded.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('violation');
    expect(r.envelope.body).toMatch(/adds 4 and drops 1/);
  });
});
