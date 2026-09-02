import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { EvaluatorContext } from '@orcaops/evaluator-protocol';
import { makeContext as makeBaseContext, runFixture } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/demo');

function makeContext(): EvaluatorContext {
  return makeBaseContext({ evaluator_ref: 'demo/hello' });
}

/**
 * demo/hello is intentionally one-sided: it ALWAYS emits pass, so this
 * suite is pass-only. demo/always-block is the symmetric
 * always-violates case.
 */
describe('demo/hello (runFixture, pass-only)', () => {
  it('pass: hello evaluator emits a deterministic PASS envelope', async () => {
    const r = await runFixture({
      command: ['node', './runtime/hello.js'],
      cwd: packRoot,
      context: makeContext(),
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/Hello from packs\/demo/);
  });
});
