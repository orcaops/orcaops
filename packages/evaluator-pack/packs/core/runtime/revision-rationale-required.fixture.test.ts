import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runFixture } from '@orcaops/evaluator-sdk';
import { makeContext } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/core');

describe('revision-rationale-required (runFixture)', () => {
  it('pass: revision has a rationale of adequate length', async () => {
    const ctx = makeContext({
      evaluator_ref: 'core/revision-rationale-required',
      phase: 'post-plan-revision',
      plan: {
        ...makeContext().plan,
        revision_n: 1,
        rationale: 'discovered we need a config-loader pass before mounting the middleware',
        revised_at: '2026-05-13T01:00:00.000Z',
      },
    });
    const r = await runFixture({
      command: ['node', './runtime/revision-rationale-required.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/Rationale present/);
  });

  it('violation: revision has empty rationale', async () => {
    const ctx = makeContext({
      evaluator_ref: 'core/revision-rationale-required',
      phase: 'post-plan-revision',
      plan: {
        ...makeContext().plan,
        revision_n: 1,
        rationale: '',
        revised_at: '2026-05-13T01:00:00.000Z',
      },
    });
    const r = await runFixture({
      command: ['node', './runtime/revision-rationale-required.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('violation');
    expect(r.envelope.body).toMatch(/has no rationale/);
  });
});
