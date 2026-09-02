/**
 * Real-Codex smoke test. Skipped by default; run with:
 *
 *   RUN_LLM_TESTS=1 pnpm --filter @orcaops/llm test
 *
 * Requires `codex login` already done. Costs a small amount against the
 * user's Codex subscription / credits.
 */

import { run } from 'effection';
import { describe, expect, it } from 'vitest';

import { createCodexCliClient } from '../../../src/codex/index.js';

const enabled = process.env.RUN_LLM_TESTS === '1';
const describeReal = enabled ? describe : describe.skip;

describeReal('CodexCliClient (real codex smoke)', () => {
  const client = createCodexCliClient({
    defaultTimeoutMs: 60_000,
  });

  it('one-shot returns a body for a trivial prompt', async () => {
    const result = await run(() =>
      client.evaluate({
        prompt: 'Respond with exactly the single word PASS and nothing else.',
      })
    );
    expect(result.error).toBeUndefined();
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.body.toUpperCase()).toContain('PASS');
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
  }, 90_000);
});
