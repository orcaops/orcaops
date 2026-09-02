import type { EvaluateOptions, EvaluateResult, LLMClient } from '../types.js';
import { evaluateOneShot, type OneShotConfig } from './one-shot.js';

export type ClaudeCodeClientConfig = OneShotConfig;

/**
 * LLMClient backed by the local `claude` CLI. Piggybacks on the user's
 * existing Claude Code authentication — no API key handling.
 */
export function createClaudeCodeClient(cfg: ClaudeCodeClientConfig): LLMClient {
  return {
    isDeterministic: false,
    defaultProvider: 'claude',
    evaluate(opts: EvaluateOptions) {
      return evaluateOneShot(cfg, opts);
    },
  };
}

export { evaluateOneShot };
export type { OneShotConfig };

// Re-export internals so tests can address them directly.
export { buildClaudeArgs, buildClaudeEnv } from './args.js';
export { type ClaudeResultEvent, LineBuffer, parseClaudeStreamLine } from './stream-parser.js';

export type { EvaluateOptions, EvaluateResult };
