import type { Operation } from 'effection';

import type { EvaluateOptions, EvaluateResult, LLMClient } from './types.js';

const DETERMINISTIC_SESSION_ID = 'deterministic';
const DETERMINISTIC_BODY = 'ERROR\n\nNo LLM provider executed.';
const DETERMINISTIC_CANCELLED_BODY = 'ERROR\n\nCancelled';

/**
 * Short-circuit envelope when the caller aborts before / during the
 * call. The deterministic client has no subprocess to kill, but it
 * must still honor the contract — the runner's `dispatchEvaluators`
 * forwards the signal uniformly and expects every provider to surface
 * `CANCELLED` so a torn-down checkpoint-open gate doesn't get a
 * spurious PASS row for an aborted run.
 */
function cancelledResult(): EvaluateResult {
  return {
    body: DETERMINISTIC_CANCELLED_BODY,
    model: null,
    sessionId: DETERMINISTIC_SESSION_ID,
    durationMs: 0,
    error: { code: 'CANCELLED', message: 'Aborted before deterministic result' },
  };
}

/**
 * No-network LLM client. Used when:
 *   - `--no-llm` flag is passed
 *   - `config.llm.tool === 'none'`
 *   - factory auto-detect finds no CLI tools and llm.tool is 'auto'
 *   - unit tests that aren't gated behind RUN_LLM_TESTS=1
 *
 * Returns an explicit unavailable-provider error. The evaluator dispatcher
 * records LLM evaluators as skipped before calling this client; the error is
 * defense in depth for direct callers and other LLM consumers.
 */
export const deterministicClient: LLMClient = {
  isDeterministic: true,
  defaultProvider: null,
  isProviderAvailable: () => false,

  *evaluate(opts: EvaluateOptions): Operation<EvaluateResult> {
    if (opts.signal?.aborted) return cancelledResult();
    return {
      body: DETERMINISTIC_BODY,
      model: null,
      sessionId: DETERMINISTIC_SESSION_ID,
      durationMs: 0,
      error: { code: 'TOOL_NOT_FOUND', message: 'No LLM provider configured or available' },
    };
  },
};
