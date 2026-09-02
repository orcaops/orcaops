import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runFixture } from '@orcaops/evaluator-sdk';
import { makeContext } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/core');

describe('revision-touched-scope-stable (runFixture)', () => {
  it('pass: touched_scope unchanged across revision', async () => {
    const basePlan = makeContext().plan;
    const ctx = makeContext({
      evaluator_ref: 'core/revision-touched-scope-stable',
      phase: 'post-plan-revision',
      plan: {
        ...basePlan,
        revision_n: 1,
        rationale: 'reordering steps without scope shift',
        touched_scope: ['payments', 'infra'],
      },
      prior_plan: {
        ...basePlan,
        revision_n: 0,
        touched_scope: ['payments', 'infra'],
      },
    });
    const r = await runFixture({
      command: ['node', './runtime/revision-touched-scope-stable.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/touched_scope unchanged/);
  });

  it('violation: revision expands touched_scope with new tag', async () => {
    const basePlan = makeContext().plan;
    const ctx = makeContext({
      evaluator_ref: 'core/revision-touched-scope-stable',
      phase: 'post-plan-revision',
      plan: {
        ...basePlan,
        revision_n: 1,
        rationale: 'discovered auth interplay',
        touched_scope: ['payments', 'infra', 'auth'],
      },
      prior_plan: {
        ...basePlan,
        revision_n: 0,
        touched_scope: ['payments', 'infra'],
      },
    });
    const r = await runFixture({
      command: ['node', './runtime/revision-touched-scope-stable.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('violation');
    expect(r.envelope.body).toMatch(/added 1 touched_scope tag/);
    expect(r.envelope.body).toMatch(/`auth`/);
  });
});
