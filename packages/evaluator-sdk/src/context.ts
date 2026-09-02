import { readFileSync } from 'node:fs';

import { type EvaluatorContext, EvaluatorContextSchema } from '@orcaops/evaluator-protocol';

/**
 * Environment variable the command engine sets on the spawned
 * evaluator subprocess. The path resolves to a JSON file holding a
 * fully-validated `EvaluatorContext`. The runner writes it once per
 * dispatch; evaluators read it once at startup.
 *
 * Keep this name in sync with `@orcaops/evaluator-runner`'s command
 * engine — it's the contract that lets pack runtimes stay independent
 * of any runner internals.
 */
export const ORCAOPS_CONTEXT_PATH_ENV = 'ORCAOPS_CONTEXT_PATH';

export interface ReadEvaluatorContextOptions {
  /** Override env source (defaults to `process.env`). Test injection. */
  env?: NodeJS.ProcessEnv;
  /** Override fs reader (defaults to `node:fs.readFileSync`). Test injection. */
  readFile?: (path: string) => string;
}

/**
 * Read + validate the `EvaluatorContext` from the path in
 * `ORCAOPS_CONTEXT_PATH`. Synchronous: pack runtimes are short-lived
 * subprocesses that need the context before they do any work.
 *
 * Throws `Error` on missing env var, unreadable file, malformed JSON,
 * or schema validation failure. The errors carry enough detail for
 * `safeExecute` to report an infrastructure error through a non-zero exit.
 */
export function readEvaluatorContext(opts: ReadEvaluatorContextOptions = {}): EvaluatorContext {
  const env = opts.env ?? process.env;
  const ctxPath = env[ORCAOPS_CONTEXT_PATH_ENV];
  if (!ctxPath) {
    throw new Error(
      `${ORCAOPS_CONTEXT_PATH_ENV} is unset; this evaluator must run via the ` +
        `@orcaops/evaluator-runner command engine.`
    );
  }
  const reader = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let raw: string;
  try {
    raw = reader(ctxPath);
  } catch (err) {
    throw new Error(`Failed to read evaluator context at ${ctxPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Evaluator context at ${ctxPath} is not valid JSON: ${(err as Error).message}`);
  }
  return EvaluatorContextSchema.parse(parsed);
}
