import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { EvaluatorContext } from '@orcaops/evaluator-protocol';
import { makeContext as makeBaseContext, makePlanStep, runFixture } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/core');

function makeContext(opts: {
  planSteps: number;
  declaredStepIds: string[];
  params?: Record<string, unknown>;
}): EvaluatorContext {
  const planSteps = Array.from({ length: opts.planSteps }, (_, i) =>
    makePlanStep(i + 1, `step ${i + 1}`)
  );
  return makeBaseContext({
    evaluator_ref: 'core/checkpoint-scope-density',
    phase: 'checkpoint-open',
    checkpoint_n: 1,
    plan: { ...makeBaseContext().plan, plan_steps: planSteps },
    current_checkpoint: {
      status: 'open',
      n: 1,
      declared_step_ids: opts.declaredStepIds,
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      head_sha: 'cafebabe',
      opened_at: '2026-05-13T00:00:00.000Z',
    },
    params: opts.params ?? { max_fraction_of_plan: 0.6, min_plan_size: 4 },
  });
}

describe('checkpoint-scope-density (runFixture)', () => {
  it('pass: 1 of 5 plan steps declared (20% < 60% threshold)', async () => {
    const result = await runFixture({
      command: ['node', './runtime/checkpoint-scope-density.js'],
      cwd: packRoot,
      context: makeContext({
        planSteps: 5,
        declaredStepIds: ['019e0000-0000-7000-8000-000000000001'],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope.verdict).toBe('pass');
    expect(result.envelope.body).toMatch(/under the 60% threshold/);
  });

  it('violation: 4 of 5 plan steps declared (80% > 60% threshold)', async () => {
    const result = await runFixture({
      command: ['node', './runtime/checkpoint-scope-density.js'],
      cwd: packRoot,
      context: makeContext({
        planSteps: 5,
        declaredStepIds: [
          '019e0000-0000-7000-8000-000000000001',
          '019e0000-0000-7000-8000-000000000002',
          '019e0000-0000-7000-8000-000000000003',
          '019e0000-0000-7000-8000-000000000004',
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope.verdict).toBe('violation');
    expect(result.envelope.body).toMatch(/declares 4 of 5/);
  });
});
