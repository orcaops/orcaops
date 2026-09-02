import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runFixture } from '@orcaops/evaluator-sdk';
import { makeContext } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/core');

describe('plan-label-quality (runFixture)', () => {
  it('pass: label "rate limit /api/charge" is specific + distinct from task', async () => {
    const ctx = makeContext({
      evaluator_ref: 'core/plan-label-quality',
      plan: {
        ...makeContext().plan,
        task: 'add a Redis-backed sliding-window rate limiter to /api/charge',
        label: 'rate limit /api/charge',
      },
    });
    const r = await runFixture({
      command: ['node', './runtime/plan-label-quality.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/looks specific enough/);
  });

  it('violation: label "wip" is generic + too short', async () => {
    const ctx = makeContext({
      evaluator_ref: 'core/plan-label-quality',
      plan: {
        ...makeContext().plan,
        task: 'do some work on the rate limiter',
        label: 'wip',
      },
    });
    const r = await runFixture({
      command: ['node', './runtime/plan-label-quality.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('violation');
    expect(r.envelope.body).toMatch(/too short/);
    expect(r.envelope.body).toMatch(/too generic/);
  });
});
