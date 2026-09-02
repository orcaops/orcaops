/**
 * Wrap a checker body so a thrown error becomes a non-zero process exit.
 * The command engine records that as `run_status: 'error'`; a crash is an
 * infrastructure failure, not a policy violation authored by the evaluator.
 *
 * Usage:
 *   safeExecute(async () => {
 *     const ctx = readEvaluatorContext();
 *     const result = await myChecker(ctx);
 *     writeResult(result);
 *   });
 *
 * The wrapper reports diagnostics on stderr, keeping stdout reserved for a
 * valid evaluator result envelope. Synchronous and async functions are both
 * supported.
 */
export function safeExecute(fn: () => void | Promise<void>): void {
  void (async () => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
      process.stderr.write(`Evaluator crashed: ${message}${stack}\n`);
      process.exitCode = 1;
    }
  })();
}
