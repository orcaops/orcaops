import type { Operation } from 'effection';

import type { EvaluateOptions, EvaluateResult, LLMClient } from '@orcaops/llm';

export interface MockLLMOptions {
  /**
   * Map a call to a partial EvaluateResult (the harness fills in defaults
   * for fields you omit). Route on `opts.prompt` content if you need different
   * responses per evaluator.
   */
  respond?: (opts: EvaluateOptions) => Partial<EvaluateResult>;
  /** Override the default model id reported in EvaluateResult.model. */
  defaultModel?: string;
  /** Override the default sessionId for one-shots. */
  defaultSessionId?: string;
}

export interface MockLLMClient extends LLMClient {
  /** All `evaluate()` calls in invocation order. */
  readonly calls: ReadonlyArray<EvaluateOptions>;
  /** Drop call history. Useful between test phases. */
  reset(): void;
}

/**
 * Scriptable LLMClient for tests. Records every call; returns canned
 * responses based on the supplied `respond` function. By default returns
 * `{ body: 'PASS\n\nok' }` for everything.
 *
 * Usage:
 *   const llm = createMockLLMClient({
 *     respond: (opts) => opts.prompt.includes('drift')
 *       ? { body: 'VIOLATION\n\n## findings\n- detected drift' }
 *       : { body: 'PASS' },
 *   });
 *   // pass `llm` as `override` to buildLLMClient or directly to the runner
 *   expect(llm.calls).toHaveLength(2);
 */
export function createMockLLMClient(opts: MockLLMOptions = {}): MockLLMClient {
  const calls: EvaluateOptions[] = [];
  const defaultModel = opts.defaultModel ?? 'mock';
  const defaultSessionId = opts.defaultSessionId ?? 'mock-one-shot';

  function buildResult(reqOpts: EvaluateOptions, sessionId: string): EvaluateResult {
    const partial = opts.respond ? opts.respond(reqOpts) : {};
    return {
      body: 'PASS\n\nok',
      model: defaultModel,
      sessionId,
      durationMs: 1,
      ...partial,
    };
  }

  const client: MockLLMClient = {
    isDeterministic: false,
    // A mock stands in for a real client but reaches no worktree; 'claude'
    // keeps the consent gate's implicit-codex rule from firing on fixtures.
    defaultProvider: 'claude',
    *evaluate(reqOpts: EvaluateOptions): Operation<EvaluateResult> {
      calls.push(reqOpts);
      return buildResult(reqOpts, defaultSessionId);
    },
    get calls() {
      return calls;
    },
    reset() {
      calls.length = 0;
    },
  };

  return client;
}
