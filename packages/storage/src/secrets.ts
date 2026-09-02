import {
  REDACTION_MARKER,
  redactSecrets,
  redactSecretsInValue,
  scrubEvaluatorDiagnosticAndBound as scrubSharedTerminalDiagnosticAndBound,
} from '@orcaops/evaluator-protocol/secrets';

/**
 * Secret detection + redaction for output- and index-time scrubbing.
 *
 * Threat model: accidental capture of secrets the agent quoted from
 * debug output, env files, or its own logs. Adversarial capture is
 * out of scope (the user owns the filesystem).
 *
 * Capture payloads are NEVER mutated. Redaction is output-only:
 *   - Output sites (digest, why, resume, search snippets, status, show) call
 *     `redactSecretsInString` / `redactSecretsInObject` at render time.
 *   - The FTS5 indexer redacts before insertion so a secret never
 *     reaches the search index.
 *
 * The pattern set itself lives in `@orcaops/evaluator-protocol/secrets`,
 * shared with the evaluator runner (which folds raw evaluator output into
 * persisted error bodies) and with the payload guard that refuses a write.
 * Those layers act on a finding differently, so what holds them in agreement
 * about WHICH shapes count is the corpus at
 * `@orcaops/evaluator-protocol/secret-corpus` rather than manual audit.
 */

export { REDACTION_MARKER };

/**
 * Replace every secret in `input` with `[REDACTED_SECRET]`. The
 * surrounding text (including any prefix the pattern intentionally
 * left visible, e.g. `api_key=`) is preserved.
 *
 * Idempotent on already-redacted strings: the marker contains no
 * secret characters that any pattern matches.
 */
export function redactSecretsInString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  return redactSecrets(input);
}

/** Secret-scrub, terminal-sanitize, and bound an untrusted diagnostic. */
export function scrubTerminalDiagnosticAndBound(input: string, maxLength: number): string {
  return scrubSharedTerminalDiagnosticAndBound(input, maxLength);
}

/**
 * Recursively redact every string-valued node of a JSON-shaped value.
 * Object keys are NOT scanned (keys aren't secrets in our threat
 * model and scanning them would defeat the redaction marker reused
 * across the codebase). Arrays and nested objects are walked.
 *
 * `Date`, `RegExp`, and other non-plain objects are returned as-is —
 * the function targets parsed JSON, not arbitrary runtime values.
 */
export function redactSecretsInObject<T>(value: T): T {
  return redactSecretsInValue(value);
}
