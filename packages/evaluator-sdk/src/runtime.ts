import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';

import { ORCAOPS_CONTEXT_PATH_ENV, readEvaluatorContext } from './context.js';
import { safeExecute } from './errors.js';
import { writeResult } from './result.js';

/**
 * Guarded entry point for command-engine pack runtimes. Reads the
 * `EvaluatorContext`, awaits the `check` function, writes the result
 * envelope — but ONLY when `ORCAOPS_CONTEXT_PATH` is set in the env.
 *
 * When the env var is absent (e.g., the runtime file is imported by
 * a fixture test or any other unit test), `runIfDispatched` is a
 * no-op. This is the contract that lets pack runtimes export
 * `check` for in-process testing without the top-level execution
 * polluting test stdout with evaluator result envelopes.
 *
 * The `check` function may be sync or async; the helper awaits it.
 * Any thrown error becomes a non-zero process exit via `safeExecute`.
 */
export function runIfDispatched(
  check: (ctx: EvaluatorContext) => EvaluatorResultEnvelope | Promise<EvaluatorResultEnvelope>
): void {
  if (!process.env[ORCAOPS_CONTEXT_PATH_ENV]) return;
  safeExecute(async () => {
    const result = await check(readEvaluatorContext());
    writeResult(result);
  });
}
