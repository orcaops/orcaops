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
    expect(r.envelope.findings).toBeUndefined();
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
    expect(r.envelope.findings).toEqual([
      {
        key: 'scope/auth',
        title: 'Revision n=1 added the touched_scope tag "auth"',
        detail: expect.stringContaining('The prior plan did not declare it'),
      },
    ]);
  });

  it('violation: a scope tag that cannot spell a key still reports a finding', async () => {
    // A key is refused rather than sanitised, and a finding without one is a
    // finding with no cross-run identity — never a lost finding or a lost run.
    const basePlan = makeContext().plan;
    const ctx = makeContext({
      evaluator_ref: 'core/revision-touched-scope-stable',
      phase: 'post-plan-revision',
      plan: {
        ...basePlan,
        revision_n: 2,
        rationale: 'discovered auth interplay',
        touched_scope: ['payments', 'auth service'],
      },
      prior_plan: { ...basePlan, revision_n: 1, touched_scope: ['payments'] },
    });
    const r = await runFixture({
      command: ['node', './runtime/revision-touched-scope-stable.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('violation');
    expect(r.envelope.findings).toHaveLength(1);
    expect(r.envelope.findings?.[0].key).toBeUndefined();
    expect(r.envelope.findings?.[0].title).toContain('auth service');
  });
});
