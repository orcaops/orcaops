import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Auto-fill `idempotency_key` on capture inputs that omit one. The
 * field is required end-to-end; tests that don't care about retry
 * semantics get a fresh key per call so their input fixtures stay
 * short. Tests that DO care (idempotent replay coverage) pass an
 * explicit key and override this helper.
 *
 * An explicit empty string is preserved (the CLI will reject it via
 * Zod min(1)) — only `undefined` / non-string values trigger auto-fill.
 * This lets tests assert the "missing idempotency_key" rejection path
 * without monkey-patching around the transformer.
 */
export function withIdempotencyKey(input: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...input };
  if (typeof next.idempotency_key !== 'string') {
    next.idempotency_key = `test-${randomUUID()}`;
  }
  // Plan-shaped inputs (those carrying `task`) require a top-level
  // `label`. Auto-fill with a short placeholder when the test fixture
  // omits it; tests that care about label semantics pass an explicit
  // value and this is a no-op.
  if (next.task !== undefined && typeof next.label !== 'string') {
    next.label = 'test-label';
  }
  return next;
}

export function injectIdempotencyKeyInJson(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return json;
  return JSON.stringify(withIdempotencyKey(parsed as Record<string, unknown>));
}

let inputFileDir: string | null = null;
let inputFileN = 0;

/**
 * Write an inline capture payload to a per-process temp file and return its
 * path, for canonical `--input <path>`. JSON payloads receive the same
 * idempotency/label auto-fill the inline `--json` alias applied; YAML and
 * intentionally-malformed payloads pass through byte-identical.
 */
export function inputFile(payload: string): string {
  inputFileDir ??= mkdtempSync(path.join(tmpdir(), 'orcaops-input-'));
  const p = path.join(inputFileDir, `payload-${inputFileN++}`);
  writeFileSync(p, injectIdempotencyKeyInJson(payload), 'utf8');
  return p;
}
