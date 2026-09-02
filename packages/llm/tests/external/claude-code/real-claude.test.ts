/**
 * Real-Claude smoke tests. Skipped by default; run with:
 *
 *   RUN_LLM_TESTS=1 pnpm --filter @orcaops/llm test
 *
 * Verifies that the ClaudeCodeClient's one-shot shape can drive a `claude`
 * invocation end-to-end against the user's local
 * subscription. These cost real money (a few cents) and require:
 *   - `claude` on PATH
 *   - `claude login` already done (no API key fallback)
 */

import { run } from 'effection';
import { describe, expect, it } from 'vitest';

import { createClaudeCodeClient } from '../../../src/claude-code/index.js';

const enabled = process.env.RUN_LLM_TESTS === '1';
const describeReal = enabled ? describe : describe.skip;

describeReal('ClaudeCodeClient (real claude smoke)', () => {
  // Cache priming on the first turn dominates cost (the user's project
  // CLAUDE.md / agents / plugins push cache_creation tokens to ~25k, which
  // costs ~$0.03 by itself). We cap at $0.20 so the cold-cache run isn't
  // immediately budget-exceeded.
  const client = createClaudeCodeClient({
    defaultModel: 'claude-haiku-4-5',
    defaultMaxBudgetUsd: 0.2,
    defaultTimeoutMs: 60_000,
  });

  it('one-shot returns a PASS verdict for a trivial prompt', async () => {
    const result = await run(() =>
      client.evaluate({
        prompt: 'Respond with exactly the single word PASS and nothing else.',
        systemPrompt:
          'You are a test stub. Reply with exactly the verdict the user asks for. No tools, no extras.',
      })
    );
    expect(result.error).toBeUndefined();
    expect(result.body.trim()).toMatch(/^PASS/);
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-/);
    expect(result.durationMs).toBeGreaterThan(0);
  }, 90_000);
});
