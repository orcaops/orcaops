import type { Operation } from 'effection';

import type { EvaluateOptions, EvaluateResult, LLMClient } from '../types.js';
import { evaluateOneShot, type OneShotConfig } from './one-shot.js';

export type CodexCliClientConfig = OneShotConfig;

/**
 * LLMClient backed by the local `codex` CLI. EXPERIMENTAL — Codex's CLI
 * exposes a narrower surface than Claude's:
 *
 *   - No `--max-budget-usd`. EvaluateOptions.maxBudgetUsd is ignored.
 *   - No `--effort`. EvaluateOptions.effort is ignored.
 *   - No `--system-prompt`. EvaluateOptions.systemPrompt is silently dropped;
 *     evaluators that rely on system-prompt overrides degrade gracefully.
 *
 * Body capture is via Codex's `--output-last-message <file>`, which avoids
 * the need to parse Codex's JSONL event stream.
 */
export function createCodexCliClient(cfg: CodexCliClientConfig): LLMClient {
  return {
    isDeterministic: false,
    defaultProvider: 'codex',
    evaluate(opts: EvaluateOptions): Operation<EvaluateResult> {
      return evaluateOneShot(cfg, opts);
    },
  };
}

export { buildCodexArgs, buildCodexEnv } from './args.js';
export { evaluateOneShot } from './one-shot.js';
export type { OneShotConfig };
