import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runFixture } from '@orcaops/evaluator-sdk';
import { makeContext, makePlanStep } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/core');

describe('completion-claims / completed-steps-claimed (runFixture)', () => {
  it('pass: closed checkpoint declares completed step_ids', async () => {
    const step = makePlanStep(1, 'build rate-limit middleware');
    const ctx = makeContext({
      evaluator_ref: 'core/completed-steps-claimed',
      phase: 'checkpoint-close',
      plan: {
        ...makeContext().plan,
        plan_steps: [step],
      },
      current_checkpoint: {
        status: 'closed',
        verification: [],
        n: 1,
        declared_step_ids: [step.step_id],
        completed_step_ids: [step.step_id],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        summary: 'wired the middleware',
        files_changed: ['src/limiter.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        head_sha: 'cafebabe',
        opened_at: '2026-05-13T00:00:00.000Z',
        closed_at: '2026-05-13T00:05:00.000Z',
      },
    });
    const r = await runFixture({
      command: ['node', './runtime/completion-claims.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/Checkpoint claims step_id/);
  });

  it('violation: closed cp has no completed_step_ids but content overlaps a plan step', async () => {
    const step = makePlanStep(1, 'build redis sliding-window rate limiter middleware');
    const ctx = makeContext({
      evaluator_ref: 'core/completed-steps-claimed',
      phase: 'checkpoint-close',
      plan: {
        ...makeContext().plan,
        plan_steps: [step],
      },
      current_checkpoint: {
        status: 'closed',
        verification: [],
        n: 1,
        declared_step_ids: [step.step_id],
        completed_step_ids: [],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        summary: 'wired redis sliding window middleware for the rate limiter',
        files_changed: ['src/limiter.ts'],
        decisions: [],
        uncertainty: [],
        done_criteria: [
          {
            criterion_id: '019e0000-0000-7000-8000-0000000000c1',
            evidence: 'rate limiter applied to requests',
          },
        ],
        head_sha: 'cafebabe',
        opened_at: '2026-05-13T00:00:00.000Z',
        closed_at: '2026-05-13T00:05:00.000Z',
      },
    });
    const r = await runFixture({
      command: ['node', './runtime/completion-claims.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('violation');
    expect(r.envelope.body).toMatch(/completed_step_ids/);
  });
});
