import { z } from 'zod';

/**
 * Control-character hygiene for artifact free-text.
 *
 * The load-bearing case is U+0000 (NUL): Postgres `text`/`jsonb` cannot
 * store it (it 5xx's `unsupported Unicode escape sequence`), and SQLite
 * TEXT / FTS5 truncate C-strings on it — so a single NUL that reaches
 * storage silently corrupts the artifact and permanently blocks its cloud
 * sync. A NUL is trivially authored by accident (an invisible byte pasted
 * into a plan/summary renders as a space and passes every length check).
 *
 * The forbidden set is the C0 and C1 control ranges (U+0000–U+001F and
 * U+007F–U+009F), EXCEPT the three whitespace controls that are legitimate
 * in multi-line prose — tab (U+0009), newline (U+000A), carriage return
 * (U+000D). This mirrors the intent of the control-char class in
 * `@orcaops/core`'s `snapshotRefName` (which additionally forbids
 * tab/newline/CR because a git ref name can't contain them); it is
 * intentionally a *separate, parallel* policy — `@orcaops/core` depends on
 * `@orcaops/storage`, so the constant cannot be shared the other way, and
 * our free-text policy must keep the whitespace controls.
 *
 * Two policies, by field kind:
 *   - PROSE (author-facing free text) is **stripped** — an invisible,
 *     meaningless byte should self-heal, not hard-fail an agent that can't
 *     see it. See {@link proseText}.
 *   - IDENTIFIERS (ids, refs, SHAs, keys, branch) are **rejected** —
 *     silently rewriting an identifier could change an idempotency key or
 *     target the wrong artifact. See {@link identifierText}.
 *
 * Implemented with numeric char-code checks rather than a control-char
 * regex literal on purpose: a regex literal would embed raw control bytes
 * in this source file (the very thing we are trying to keep out of text).
 */

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const UNIT_SEP = 0x1f; // top of the C0 range
const DEL = 0x7f;
const C1_END = 0x9f;
// Flatten periodically so dense hostile input cannot retain millions of slices.
const SEGMENTS_PER_BLOCK = 1024;

/** True iff `code` is a forbidden control char (C0/C1 minus TAB/LF/CR). */
function isForbiddenCode(code: number): boolean {
  if (code === TAB || code === LF || code === CR) return false;
  return code <= UNIT_SEP || (code >= DEL && code <= C1_END);
}

/** True iff `s` contains any forbidden control character. */
export function containsForbiddenControlChars(s: string): boolean {
  return firstForbiddenControlChar(s) !== null;
}

/**
 * The first forbidden control char in `s`, as `{ index, code }`, or null when
 * clean. For assert-never-strip boundaries (a hash-anchored source-plan body)
 * that must NAME the offending byte in their error instead of a bare boolean.
 */
export function firstForbiddenControlChar(s: string): { index: number; code: number } | null {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (isForbiddenCode(code)) return { index: i, code };
  }
  return null;
}

/**
 * Remove every forbidden control character from `s`. Tab, newline, and
 * carriage return are preserved. Pure + deterministic, so the canonical
 * form / checksum / idempotency key stay consistent for the same input.
 */
export function stripControlChars(s: string): string {
  let cursor = 0;
  while (cursor < s.length && !isForbiddenCode(s.charCodeAt(cursor))) cursor += 1;
  if (cursor === s.length) return s;

  const blocks: string[] = [];
  const segments: string[] = [];
  let cleanStart = 0;
  for (; cursor < s.length; cursor += 1) {
    if (!isForbiddenCode(s.charCodeAt(cursor))) continue;
    if (cleanStart < cursor) segments.push(s.slice(cleanStart, cursor));
    cleanStart = cursor + 1;
    if (segments.length === SEGMENTS_PER_BLOCK) {
      blocks.push(segments.join(''));
      segments.length = 0;
    }
  }
  if (cleanStart < s.length) segments.push(s.slice(cleanStart));
  if (segments.length > 0) blocks.push(segments.join(''));
  return blocks.join('');
}

/**
 * Recursively strip forbidden control characters from every string within
 * an arbitrary JSON-ish value (nested objects, arrays) — **including object
 * keys**. Returns a new value; the input object is never mutated.
 *
 * Keys are stripped, not left alone: this is used for `z.unknown()` payloads
 * (e.g. an evaluator run's `raw`), where the keys are arbitrary generated text
 * — NOT schema field names — so a NUL can ride in a key (`{ "\\u0000k": "…" }`
 * is valid JSON) just as easily as in a value. A value-only strip would leave
 * that NUL in the SQLite TEXT / cloud jsonb and 5xx Postgres. On the (rare)
 * collision where two keys strip to the same string, last-write-wins — an
 * acceptable outcome for corruption healing on already-broken input.
 */
export function deepStripControlChars(value: unknown): unknown {
  if (typeof value === 'string') return stripControlChars(value);
  if (Array.isArray(value)) return value.map((v) => deepStripControlChars(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[stripControlChars(k)] = deepStripControlChars(v);
    }
    return out;
  }
  return value;
}

/**
 * Collect the JSON paths of every string within `value` that contains a
 * forbidden control char — a best-effort "what was cleaned / what is dirty"
 * report for the CLI advisory and the wire-side assert. Walks values + array
 * items AND object **keys** (a NUL in a key of a `z.unknown()` payload is just
 * as unstorable as one in a value, and deepStripControlChars heals it, so
 * the assert must be able to see it too). A dirty key is reported as
 * `…{key <cleaned-key>}` with the key itself sanitized so the path string we
 * surface never re-embeds the forbidden byte.
 */
export function collectControlCharPaths(value: unknown, base = ''): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (containsForbiddenControlChars(v)) out.push(path === '' ? '(root)' : path);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const cleanKey = stripControlChars(k);
        if (containsForbiddenControlChars(k)) {
          out.push(path === '' ? `{key ${cleanKey}}` : `${path}.{key ${cleanKey}}`);
        }
        walk(val, path === '' ? cleanKey : `${path}.${cleanKey}`);
      }
    }
  };
  walk(value, base);
  return out;
}

/**
 * Thrown by {@link assertNoForbiddenControlChars} — the wire-side net, raised
 * inside the background push (not at a CLI input boundary). Carries the JSON
 * `path` so the failure surfaces as a clear LOCAL error instead of an opaque
 * cloud 5xx: the eager-push path records it as a distinct `content-invalid`
 * sync failure, which `cloud_sync` reports as `reason: "content_invalid"` and
 * `orcaops doctor` shows with this field path — steering the user to scrub the
 * byte + rebuild rather than a `resync --force` loop that would re-trip it.
 */
export class ForbiddenControlCharError extends Error {
  readonly name = 'ForbiddenControlCharError';
  readonly path: string;
  constructor(path: string) {
    super(
      `forbidden control character at ${path === '' ? '(root)' : path}` +
        ` — a NUL or other disallowed control byte cannot be stored by the cloud`
    );
    this.path = path;
  }
}

/**
 * Required wire-side net: throw {@link ForbiddenControlCharError} on the
 * first forbidden control char anywhere in `value`. **Asserts, never
 * strips** — so a hash-anchored field (a source-plan pin's content) is never
 * mutated. The wire policy matches capture input: C0 minus TAB/LF/CR, DEL,
 * and the full C1 display-control range all reject.
 */
export function assertNoForbiddenControlChars(value: unknown): void {
  const paths = collectControlCharPaths(value);
  if (paths.length > 0) throw new ForbiddenControlCharError(paths[0]);
}

type StringSchema = z.ZodType<string, string>;

/** Reject empty or whitespace-only prose after capture-time sanitization. */
export const nonBlank = (s: string): boolean => s.trim().length > 0;

/**
 * Introspectable marker the {@link proseText} / {@link identifierText} helpers
 * stamp onto the schemas they return, via a dedicated Zod registry. A
 * structural completeness test walks each capture-input schema's shape and
 * fails if any author-facing string leaf is a bare `z.string()` carrying NO
 * entry here — making "every author-facing field is policy-wrapped" a
 * machine-checkable invariant rather than a reviewer's vigilance. A dedicated
 * registry (not `.meta()`) keeps the marker strongly typed and off the global
 * metadata namespace.
 */
export const textPolicyRegistry = z.registry<{ policy: 'prose' | 'identifier' }>();

/** Read the text policy a helper stamped on `schema`, or undefined if bare. */
export function textPolicyOf(schema: z.ZodType): 'prose' | 'identifier' | undefined {
  return textPolicyRegistry.get(schema)?.policy;
}

/**
 * Zod helper for an author-facing **prose** string. Strips forbidden
 * control chars FIRST (self-healing), THEN applies `constraint`, THEN rejects
 * blank text. The final refinement is unconditional, so custom constraints,
 * optional-present values, and list entries cannot reopen the whitespace gap.
 * Stamped `policy: 'prose'` in {@link textPolicyRegistry} for the completeness
 * test.
 */
export function proseText(constraint: StringSchema = z.string()) {
  return z
    .string()
    .transform(stripControlChars)
    .pipe(constraint)
    .refine(nonBlank, 'must not be blank')
    .register(textPolicyRegistry, { policy: 'prose' });
}

/**
 * Zod helper for a **structural identifier** string (ids, refs, SHAs, keys,
 * branch names). REJECTS any forbidden control char rather than stripping
 * it. Compose `.optional()` / `.nullable()` / `.default()` at the call site.
 * Default constraint is a non-empty string. Stamped `policy: 'identifier'` in
 * {@link textPolicyRegistry} for the completeness test.
 */
export function identifierText(constraint: StringSchema = z.string().min(1)) {
  return constraint
    .refine((s) => !containsForbiddenControlChars(s), {
      message: 'must not contain control characters',
    })
    .register(textPolicyRegistry, { policy: 'identifier' });
}
