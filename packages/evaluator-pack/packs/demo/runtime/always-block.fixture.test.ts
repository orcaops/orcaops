import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { EvaluatorContext } from '@orcaops/evaluator-protocol';
import { makeContext as makeBaseContext, runFixture } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/demo');

function makeContext(): EvaluatorContext {
  return makeBaseContext({
    evaluator_ref: 'demo/always-block',
    phase: 'checkpoint-open',
    checkpoint_n: 1,
  });
}

/**
 * demo/always-block is intentionally one-sided: it ALWAYS emits
 * violation, so this suite is violation-only. demo/hello is the
 * symmetric always-passes case.
 */
describe('demo/always-block (runFixture, violation-only)', () => {
  it('violation: always-block evaluator emits a deterministic VIOLATION envelope', async () => {
    const r = await runFixture({
      command: ['node', './runtime/always-block.js'],
      cwd: packRoot,
      context: makeContext(),
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('violation');
    expect(r.envelope.body).toMatch(/demo blocking evaluator/);
  });
});
