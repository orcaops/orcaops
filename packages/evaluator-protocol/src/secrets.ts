/**
 * The shared secret pattern set and a string redactor.
 *
 * Hosted here because `@orcaops/evaluator-protocol` is already a dependency
 * of every consumer that needs it — `@orcaops/storage` (output- and
 * index-time redaction) and `@orcaops/evaluator-runner` (which folds raw
 * evaluator stdout/stderr into PERSISTED error bodies) — so sharing adds no
 * dependency edge in either direction. It is a `./secrets`
 * subpath rather than a barrel export so nothing enters the pack-runtime
 * import surface.
 *
 * This is the only detector. An evaluator pack once carried a second,
 * independent one; core owns the write gate now, and the pack copy was deleted
 * with it. `./secret-corpus` is therefore shared TEST DATA rather than a
 * cross-implementation contract — the shapes every consumer of this module
 * must agree on, asserted by each against its own semantics.
 */

import { type NormalizedText, normalizeForDetection } from './normalize.js';
import { stripTerminalFormatting } from './terminal.js';

export const REDACTION_MARKER = '[REDACTED_SECRET]';

/**
 * Cut trailing content that a byte cap may have severed mid-secret.
 *
 * Call this on text known to be truncated at the end, before or after
 * redaction. It removes, from the earliest offending position to the end:
 *
 *   1. an unterminated private-key block (PEM or the JSON-escaped GCP form);
 *   2. a trailing unbroken token-shaped run, which is what a severed provider
 *      token looks like.
 *
 * RESIDUAL: this is containment, not detection. A secret with no recognizable
 * opening marker whose shape is indistinguishable from ordinary text can
 * survive a cut. The tail run is deliberately bounded at both ends to avoid
 * eating ordinary long prose.
 */
const MAX_SEVERED_TOKEN_CHARS = 128;
const severedTokenCharacter = /^[A-Za-z0-9_\-+/=]$/;

export function cutTruncatedSecretTail(text: string): string {
  let cut = text.length;

  let unterminated: PrivateKeyRange | undefined;
  for (const range of privateKeyRanges(text)) {
    if (!range.terminated) unterminated = range;
  }
  if (unterminated !== undefined) {
    // Take the enclosing JSON key too when present, so a severed GCP
    // service-account blob does not leave `"private_key": "` dangling.
    const jsonKey = text.lastIndexOf('"private_key"', unterminated.start);
    cut = Math.min(cut, jsonKey >= 0 ? jsonKey : unterminated.start);
  }

  // Bounded on BOTH ends. Below the floor there is too little of a secret
  // left to be worth eating legitimate content for; above the ceiling it
  // cannot be a severed token at all — every token pattern here is anchored
  // and bounded, so a run that long would have MATCHED and been redacted
  // already. Without the ceiling this eats whole outputs: a 1000-character
  // run of one repeated character is a trailing token-shaped run by the
  // regex, and nothing like a secret.
  const head = text.slice(0, cut);
  let tailStart = head.length;
  while (
    tailStart > 0 &&
    head.length - tailStart <= MAX_SEVERED_TOKEN_CHARS &&
    severedTokenCharacter.test(head[tailStart - 1]!)
  ) {
    tailStart -= 1;
  }
  const tailLength = head.length - tailStart;
  if (tailLength >= 20 && tailLength <= MAX_SEVERED_TOKEN_CHARS) {
    cut = Math.min(cut, tailStart);
  }

  return text.slice(0, cut);
}

/**
 * Pattern descriptor. Each `regex` MUST carry the `g` flag so replaceAll and
 * per-match enumeration work. With a capture group, group 1 is the slice
 * redacted (the `api_key=` prefix stays visible); without one, the whole
 * match goes.
 */
export interface SecretPattern {
  /** Stable name for messages and tests. Never the secret itself. */
  name: string;
  regex: RegExp;
  /**
   * Optional: choose the reported name from the captured VALUE.
   *
   * Exists so a pattern whose key half is broad can still separate a real
   * credential from an identifier that happens to sit after the same label.
   * The tier stays a property of the NAME — {@link SECRET_TIERS} is a total
   * map and a test asserts that — so a classifier selects which name is
   * reported, never what a name means.
   */
  classify?: (value: string) => string;
}

function characterClassCount(value: string): number {
  // Letters and digits only. Counting `[+/=_-]` as a class is what let any
  // kebab-case or path-like value of 24 characters containing a digit reach
  // three classes — a branch name, a repo path, a UUID and a snapshot ref all
  // refused on punctuation they could not avoid carrying.
  return Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value));
}

/** Shannon entropy in bits per character. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A run of six or more identical characters. Padding, never a credential: a
 * `0000…` filler clears the length and class bars on repetition alone.
 */
const PADDING_RUN = /(.)\1{5,}/u;

const SOLID_ALNUM_RUN = /^[A-Za-z0-9]+$/;

/**
 * Does the value assigned to a credential-ish key look like a real credential
 * rather than an identifier that happens to follow the same label?
 *
 * Measured against three corpora before the thresholds were chosen. Two
 * findings shaped it:
 *
 * - **This predicate is only safe DOWNSTREAM of the key-name alternation.**
 *   Applied to raw text it matches a few percent of every string in a real
 *   capture archive — measured at 4.7% over 874,000 string values in one —
 *   and what it matches is UUIDv7 ids, blake3 manifest hashes and snapshot
 *   refs, the tool's own bookkeeping. Widening `generic-assignment`'s key half
 *   to `key`, `id`, `hash`, `digest` or `sig` would therefore fire on it.
 * - **24, not 20.** At 20 characters the rule sits one character class away
 *   from a dense population of kebab-case fixtures (`expired-access-token` is
 *   exactly 20). The extra four characters are structural margin for
 *   repositories nobody has measured, and cost one short human-chosen
 *   password — which still warns, and is still redacted at every output.
 *
 * The entropy branch exists for the lowercase-hex API key: 64 characters,
 * only two character classes, so the first branch structurally cannot see it.
 */
function isCredentialShapedValue(value: string): boolean {
  if (PADDING_RUN.test(value)) return false;
  if (value.length >= 24 && characterClassCount(value) >= 3) return true;
  // Solid alphanumeric, because that is what a hex or base32 key is. A long
  // path or dotted identifier can clear the entropy bar on its separators
  // alone, and separators are exactly what a key does not contain.
  return value.length >= 32 && SOLID_ALNUM_RUN.test(value) && shannonEntropy(value) >= 3.0;
}

/** Reported when a generic assignment's VALUE has credential shape. */
export const STRONG_ASSIGNMENT_PATTERN_NAME = 'generic-assignment-strong';

export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  // ── Transport/authentication shapes ────────────────────────────────
  {
    // Standalone "Bearer <prose>" is common in authored content, so require
    // a digit or token punctuation beyond `-`. Alphabetic-only opaque tokens
    // remain covered in an Authorization header at a line boundary and on
    // diagnostic paths. Comma- or semicolon-delimited copies stay diagnostic-
    // only because those boundaries are indistinguishable from authored prose.
    name: 'bearer-token',
    regex: /\bBearer\s+((?=[A-Za-z0-9._\-+/=]*[0-9._+/=])[A-Za-z0-9._\-+/=]{16,})/g,
  },
  {
    name: 'jwt',
    regex:
      /(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
  },
  {
    name: 'authorization-header',
    regex:
      /\b(?:authorization)\s*:\s*((?:bearer|basic|token|api[-_]?key)\s+(?=[A-Za-z0-9._~+\-/=]*(?:[0-9_+/=]|\.[A-Za-z0-9_~+\-/=]))[A-Za-z0-9._~+\-/=]{8,})(?![A-Za-z0-9._~+\-/=])/gi,
  },
  {
    name: 'authorization-header',
    regex:
      /\b(?:authorization)\s*:\s*((?:bearer|basic|token|api[-_]?key)\s+(?![A-Za-z0-9._~+\-/=]*[0-9._+/=])[A-Za-z0-9._~+\-/=]{8,})[ \t]*(?=$|[\r\n])/gim,
  },
  // Scheme-less Authorization values stay diagnostic-only. Treating any long
  // word after `Authorization:` as a credential destroys authored prose.
  {
    name: 'secret-query-param',
    regex: /[?&](?:token|access_token|api_key)=([A-Za-z0-9._~%+\-/=]{16,})/gi,
  },

  // ── Provider tokens (all anchored on prefix; high specificity) ──────
  // Anthropic API key. `sk-ant-` prefix + body (40+ url-safe chars).
  { name: 'anthropic-api-key', regex: /sk-ant-[A-Za-z0-9_-]{40,}/g },
  // OpenAI project keys.
  { name: 'openai-project-key', regex: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  // OpenAI legacy `sk-` keys. Length heuristic + alphabet to reduce
  // false positives on `sk-` test fixtures.
  { name: 'openai-legacy-key', regex: /\bsk-(?!ant-|proj-)[A-Za-z0-9]{32,}\b/g },
  // GitHub fine-grained / personal / OAuth / app / refresh tokens.
  { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // Google API keys use a fixed AIza prefix followed by 35 URL-safe chars.
  {
    name: 'google-api-key',
    regex: /(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  },
  // AWS access key IDs. The secret-key shape (40 base64-ish chars) is
  // too generic to match standalone without false positives, so we
  // catch it via the `aws_secret_access_key=` assignment branch below.
  { name: 'aws-access-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // Slack tokens (bot/app/refresh/personal/scope). `xoxe-` is the refresh
  // token and `xoxe.xoxp-` the rotating user token it mints, whose dot the
  // token character class deliberately does not span.
  { name: 'slack-token', regex: /\b(?:xoxe\.)?xox[baprse]-[A-Za-z0-9-]{10,}\b/g },
  // Slack app-level tokens. Anchored on `xapp-1-` rather than `xapp-`, which is
  // short enough to appear in an ordinary identifier.
  { name: 'slack-app-token', regex: /\bxapp-1-[A-Za-z0-9-]{10,}\b/g },
  // npm automation and granular access tokens: prefix plus 36 base62 chars.
  { name: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // Microsoft Entra client secrets. The `8Q~` infix is the format marker; the
  // value is 40 characters of a URL-safe alphabet that includes `~`. Anchoring
  // on the marker is what keeps this off ordinary text — the length and
  // alphabet alone describe a great deal of prose.
  {
    name: 'azure-client-secret',
    // The leading run is bounded, not open: an unbounded prefix in front of a
    // literal makes the scan quadratic on a long unbroken run of the same
    // alphabet, which evaluator output can supply.
    regex: /(?<![A-Za-z0-9._~-])[A-Za-z0-9._~-]{1,8}8Q~[A-Za-z0-9._~-]{30,}(?![A-Za-z0-9._~-])/g,
  },

  // ── Generic key=value assignments (lowest specificity; last) ────────
  // Captures the *value* portion (group 1) so the prefix stays visible
  // in the redacted output — `api_key=[REDACTED_SECRET]` is more
  // useful than `[REDACTED_SECRET]`. Length floor (8 chars) and an
  // alphanumeric-only character class suppress obvious test fixtures
  // like `password=foo`. The `["']?` after the key name accepts both
  // bare (`api_key=v`) and JSON-quoted (`"client_secret": "v"`)
  // shapes.
  {
    name: 'generic-assignment',
    classify: (value) =>
      isCredentialShapedValue(value) ? STRONG_ASSIGNMENT_PATTERN_NAME : 'generic-assignment',
    regex:
      /(?<![A-Za-z0-9])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|aws[_-]?secret[_-]?access[_-]?key|client[_-]?secret|private[_-]?token|auth[_-]?token|bearer[_-]?token|password|secret|token)(?:[_-]?key)?["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{8,})["']?/gi,
  },
];

const DIAGNOSTIC_SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    name: 'diagnostic-bearer-token',
    regex: /\bBearer\s+([A-Za-z0-9._\-+/=]{8,})/g,
  },
  {
    name: 'diagnostic-authorization-header',
    regex: /\b(?:authorization)\s*:\s*([^\r\n,;]+)/gi,
  },
  {
    name: 'diagnostic-secret-query-param',
    regex: /[?&](?:token|access_token|api_key|key)=([^&\s"']+)/gi,
  },
];

/**
 * Replace every secret-shaped run in `text` with {@link REDACTION_MARKER}.
 * Redacting the capture group where one exists keeps the surrounding context
 * legible, which is the difference between a useful diagnostic and an opaque
 * one.
 */
export function redactSecrets(text: string): string {
  return redactBothPasses(text, SECRET_PATTERNS);
}

/**
 * Every run the direct and the normalized pass find, merged. The normalized
 * pass is what sees a credential an invisible character or a terminal escape
 * has split into fragments — see {@link normalizeForDetection}.
 *
 * Both are collected in the ORIGINAL coordinate space, so nothing shifts
 * underneath them and detection and redaction can be built on the same answer.
 * Running the direct pass as a REWRITE first instead destroys the vendor prefix
 * the normalized pass matches on: a token split by a terminal escape lost only
 * the fragment the direct pass could see, while the detector — which already
 * merged — reported the whole span as handled.
 */
function secretRanges(
  text: string,
  patterns: ReadonlyArray<SecretPattern>
): readonly RedactionRange[] {
  const direct = collectRedactionRanges(text, patterns);
  const normalized = normalizeForDetection(text);
  const obfuscated =
    normalized === null
      ? []
      : mapNormalizedRanges(normalized, collectRedactionRanges(normalized.text, patterns));
  const found = mergeRedactionRanges([...direct, ...obfuscated]);
  if (found.length === 0) return found;
  // A run that ends exactly where the next one begins hides its own boundary:
  // every vendor pattern refuses to match with a token character hard against
  // it, so `AIza…` followed immediately by `sk-ant-…` was reported and redacted
  // as the second alone while the first was printed in full. Rescan with what
  // is already found masked out. The mask is the same length as what it
  // replaces, so the offsets still address `text`, and it is a character no
  // pattern accepts, which is the boundary the runs were hiding from one
  // another.
  const rescanned = collectPatternRanges(maskFoundRanges(text, found), patterns);
  return rescanned.length === 0 ? found : mergeRedactionRanges([...found, ...rescanned]);
}

function maskFoundRanges(text: string, ranges: readonly RedactionRange[]): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    chunks.push(text.slice(cursor, range.start), '\u0000'.repeat(range.end - range.start));
    cursor = range.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}

function redactBothPasses(text: string, patterns: ReadonlyArray<SecretPattern>): string {
  const ranges = secretRanges(text, patterns);
  return ranges.length === 0 ? text : redactRanges(text, ranges);
}

/**
 * Canonical name for a run found by the PEM block scanner. Private keys are
 * matched structurally rather than by a {@link SECRET_PATTERNS} entry, so they
 * have no pattern name of their own to report.
 */
export const PRIVATE_KEY_PATTERN_NAME = 'pem-private-key';

/**
 * How severely a write boundary may act on a detected shape.
 *
 * `refuse` covers vendor-issued prefixes; private key material, whether bare or
 * inside a service-account envelope; and a generic assignment whose VALUE
 * carries credential shape — see
 * {@link STRONG_ASSIGNMENT_PATTERN_NAME}. Being reproducible is not what
 * spares a shape, and key material is where that shows: a throwaway test PEM
 * has a perfectly legitimate synthetic form and refuses anyway. What earns
 * `warn` is a shape ordinary authored text carries often enough that refusing
 * it would block writes quoting test evidence — a JWT is a base64 triple
 * indistinguishable from a fixture, and `generic-assignment`, absent such a
 * value, matches quoted code such as a TypeScript type annotation.
 *
 * The tier governs ENFORCEMENT only. Detection and output-time redaction are
 * unchanged by it — a `warn` shape is still found and still redacted.
 */
export type SecretTier = 'refuse' | 'warn';

/**
 * Every name {@link findSecretLocations} can report, mapped to its tier.
 *
 * Deliberately a total map rather than a predicate with a default: an
 * unclassified name defaulting to `refuse` would silently promote a new
 * pattern into blocking writes, and defaulting to `warn` would silently
 * demote one. `secrets.test.ts` fails if a reportable name is missing here.
 */
const SECRET_TIERS: Readonly<Record<string, SecretTier>> = {
  'bearer-token': 'warn',
  jwt: 'warn',
  'authorization-header': 'warn',
  'secret-query-param': 'warn',
  'generic-assignment': 'warn',
  [STRONG_ASSIGNMENT_PATTERN_NAME]: 'refuse',
  'anthropic-api-key': 'refuse',
  'openai-project-key': 'refuse',
  'openai-legacy-key': 'refuse',
  'github-token': 'refuse',
  'google-api-key': 'refuse',
  'aws-access-key-id': 'refuse',
  'slack-token': 'refuse',
  'slack-app-token': 'refuse',
  'npm-token': 'refuse',
  'azure-client-secret': 'refuse',
  [PRIVATE_KEY_PATTERN_NAME]: 'refuse',
};

/** The tier for `name`, or undefined if it is not a reportable pattern name. */
export function secretTierOf(name: string): SecretTier | undefined {
  // Own-property check: a bare index resolves inherited members too, so
  // `secretTierOf('toString')` answered with a function typed as SecretTier.
  return Object.hasOwn(SECRET_TIERS, name) ? SECRET_TIERS[name] : undefined;
}

/** One detected run. Carries where and what, never the matched text. */
export interface SecretLocation {
  /** Contributing pattern names, in first-match order. Never empty. */
  readonly patterns: readonly string[];
  /** Strongest tier among {@link patterns} — `refuse` if any pattern refuses. */
  readonly tier: SecretTier;
  readonly start: number;
  readonly end: number;
}

/**
 * Locate every secret-shaped run in `text` without altering or echoing it.
 *
 * Reads the very same {@link secretRanges} {@link redactSecrets} rewrites, so
 * the span reported here is by construction the span that gets replaced. A
 * detector that missed what the redactor catches would let a secret hidden
 * behind terminal escapes pass a write boundary and then be caught at render
 * time, leaving the two layers disagreeing about the same bytes. The invariant
 * — a non-empty result exactly when `redactSecrets` would change the string —
 * is asserted over the shared corpus.
 *
 * Offsets are into `text` as given.
 */
export function findSecretLocations(text: string): readonly SecretLocation[] {
  if (typeof text !== 'string' || text.length === 0) return [];

  return secretRanges(text, SECRET_PATTERNS).map((range) => ({
    patterns: [...range.names],
    tier: range.names.some((n) => secretTierOf(n) === 'refuse') ? 'refuse' : 'warn',
    start: range.start,
    end: range.end,
  }));
}

/**
 * Lines a unified diff carries between hunks: file headers and mode changes.
 *
 * Only meaningful OUTSIDE a hunk body. Inside one every line carries a sign
 * column, so these prefixes describe the SIGNED line rather than its content —
 * a deleted line whose body begins `-- ` renders as `--- ` and an added one
 * beginning `++ ` renders as `+++ `. Reading those as file headers skipped them
 * unscanned, and `--` is the comment token in SQL, Lua, Haskell, Elm and Ada,
 * where "delete the hardcoded credential" is exactly the diff most likely to
 * carry one.
 */
const DIFF_HEADER_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  '@@',
  'old mode',
  'new mode',
  'deleted file mode',
  'new file mode',
  'similarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'Binary files',
];

function isDiffHeaderLine(line: string): boolean {
  return DIFF_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/**
 * True while `line` still belongs to the hunk body that precedes it. A body
 * line carries a sign column; `\` introduces `\ No newline at end of file`,
 * which annotates the line before it. Git renders an empty context line as a
 * single space, so a bare newline ends the hunk.
 */
function continuesHunkBody(line: string): boolean {
  const sign = line.charAt(0);
  return sign === ' ' || sign === '+' || sign === '-' || sign === '\\';
}

/**
 * Redact a unified diff without changing its shape.
 *
 * {@link redactSecrets} cannot be used on a diff. It replaces a whole
 * multi-line PEM block with one marker, and the `authorization-header` patterns
 * capture across a newline, so both collapse lines. In a diff that shifts every
 * subsequent line number, which breaks the range round-trip a review payload is
 * validated against and silently strips the `+`/`-` column from the rows below.
 *
 * So the body of each hunk line is separated from its sign, the bodies are
 * scanned as one document — otherwise a PEM spanning several lines would go
 * unrecognized — and every matched range is written back per line. Structure
 * lines are never touched: a token-shaped fragment inside a path would
 * otherwise corrupt the header grammar the parser depends on.
 *
 * Line count, sign column, and headers are all preserved exactly. Idempotent,
 * because the marker matches no pattern.
 */
export function redactSecretsInUnifiedDiff(
  diff: string,
  /**
   * Set when `diff` is hunk body rows lifted out of a diff rather than a whole
   * one. Without it the rows read as a preamble, where `---` and `+++` are file
   * headers — so a quoted `-- api_key=…` row went through unscanned.
   */
  opts: { hunkBody?: boolean } = {}
): string {
  if (typeof diff !== 'string' || diff.length === 0) return diff;

  const lines = diff.split('\n');
  // Offset of each body within the joined document, or null for a structure
  // line that is passed through untouched.
  const offsets: (number | null)[] = [];
  const bodies: string[] = [];
  let cursor = 0;

  let inHunk = opts.hunkBody === true;
  for (const line of lines) {
    if (inHunk && !continuesHunkBody(line)) inHunk = false;
    if (!inHunk && line.startsWith('@@')) {
      inHunk = true;
      offsets.push(null);
      continue;
    }
    const structure = inHunk ? line.startsWith('\\') : isDiffHeaderLine(line);
    if (structure || line.length === 0) {
      offsets.push(null);
      continue;
    }
    const body = line.slice(1);
    offsets.push(cursor);
    bodies.push(body);
    cursor += body.length + 1;
  }

  const joined = bodies.join('\n');
  // The same runs `redactSecrets` and `findSecretLocations` see. Without the
  // control-obfuscation half, a token split by terminal escapes was reported by
  // the detector and emitted intact by this redactor — and the review payload
  // is the one place those two must not disagree.
  const ranges = secretRanges(joined, SECRET_PATTERNS);
  if (ranges.length === 0) return diff;

  let bodyIndex = 0;
  const out = lines.map((line, i) => {
    const start = offsets[i];
    if (start === null) return line;
    const body = bodies[bodyIndex++]!;
    const end = start + body.length;
    // Clip each range to this line, so a match spanning a newline lands on
    // every line it covers rather than collapsing them into one.
    const local = ranges
      .filter((range) => range.start < end && range.end > start)
      .map((range) => ({
        start: Math.max(0, range.start - start),
        end: Math.min(body.length, range.end - start),
        names: range.names,
      }))
      .filter((range) => range.end > range.start);
    if (local.length === 0) return line;
    return line.charAt(0) + redactRanges(body, local);
  });

  return out.join('\n');
}

/**
 * Error and failed-runtime diagnostics favor containment over preserving prose.
 * These surfaces retain the legacy short bearer, broad Authorization-header,
 * and short query-parameter checks that would be too destructive in plans,
 * search indexes, digests, and successful evaluator bodies.
 */
function redactDiagnosticSecrets(text: string): string {
  // One pass over both pattern sets rather than the diagnostic set layered on
  // an already-redacted string: layering reintroduces the ordering defect that
  // {@link redactBothPasses} exists to close, one set lower down. A short
  // bearer split by a terminal escape lost only its head, because the marker
  // the direct pass wrote is what the normalized pass then had to match on.
  return redactBothPasses(text, [...SECRET_PATTERNS, ...DIAGNOSTIC_SECRET_PATTERNS]);
}

function redactPatternMatches(text: string, patterns: ReadonlyArray<SecretPattern>): string {
  let out = text;
  for (const { regex } of patterns) {
    regex.lastIndex = 0;
    out = out.replace(regex, (match, group1?: string) => {
      if (typeof group1 !== 'string' || group1.length === 0) return REDACTION_MARKER;
      const capturedAt = match.lastIndexOf(group1);
      return (
        match.slice(0, capturedAt) + REDACTION_MARKER + match.slice(capturedAt + group1.length)
      );
    });
    regex.lastIndex = 0;
  }
  return out;
}

/**
 * Redact before truncating so a recognized secret that straddles the output
 * bound is replaced as a whole rather than disclosed as an unmatched prefix.
 */
export function redactSecretsAndBound(text: string, maxLength: number): string {
  const redacted = redactDiagnosticSecrets(text);
  return boundRedactedText(redacted, maxLength);
}

/**
 * Scrub text received from an evaluator process before persistence.
 *
 * This is intentionally separate from generic secret redaction: snapshots,
 * exports, and other byte-sensitive data must not lose carriage returns merely
 * because secret redaction is enabled.
 */
export function scrubEvaluatorOutput(text: string): string {
  return redactSecrets(stripTerminalFormatting(text));
}

/** Apply the stricter diagnostic patterns at the evaluator trust boundary. */
export function scrubEvaluatorDiagnostic(text: string): string {
  return redactPatternMatches(scrubEvaluatorOutput(text), DIAGNOSTIC_SECRET_PATTERNS);
}

/** Scrub an evaluator diagnostic before applying its persistence bound. */
export function scrubEvaluatorDiagnosticAndBound(text: string, maxLength: number): string {
  return boundRedactedText(scrubEvaluatorDiagnostic(text), maxLength);
}

function boundRedactedText(redacted: string, maxLength: number): string {
  if (redacted.length <= maxLength) return redacted;
  const marker = '…[truncated]';
  if (maxLength <= marker.length) return marker.slice(0, Math.max(0, maxLength));
  return `${redacted.slice(0, maxLength - marker.length)}${marker}`;
}

/** Redact every string in a JSON-shaped value without mutating the input. */
export function redactSecretsInValue<T>(value: T): T {
  return walkRedact(value, false) as T;
}

/**
 * Redact string values and attacker-controlled object keys in evaluator output.
 *
 * Evaluator envelopes permit arbitrary `raw` and metric keys. Unlike ordinary
 * captured JSON, those keys cross a hostile process boundary and are persisted.
 */
export function scrubEvaluatorOutputInValue(value: Record<string, number>): Record<string, number>;
export function scrubEvaluatorOutputInValue(value: unknown): unknown;
export function scrubEvaluatorOutputInValue(value: unknown): unknown {
  return walkRedact(value, true, true);
}

interface RedactionRange {
  start: number;
  end: number;
  /**
   * Pattern names that produced this run. A merged range can span more than
   * one pattern, so this is a set rather than a single name — dropping the
   * extras would let the reported classification depend on sort order.
   * Redaction ignores it; only detection reads it.
   */
  names: string[];
}

function collectRedactionRanges(
  text: string,
  patterns: ReadonlyArray<SecretPattern>
): RedactionRange[] {
  return mergeRedactionRanges([
    ...privateKeyRanges(text).map(({ start, end }) => ({
      start,
      end,
      names: [PRIVATE_KEY_PATTERN_NAME],
    })),
    ...collectPatternRanges(text, patterns),
  ]);
}

function collectPatternRanges(
  text: string,
  patterns: ReadonlyArray<SecretPattern>
): RedactionRange[] {
  const ranges: RedactionRange[] = [];
  for (const { name, regex, classify } of patterns) {
    regex.lastIndex = 0;
    for (;;) {
      const match = regex.exec(text);
      if (match === null) break;
      const captured = match[1];
      if (typeof captured === 'string' && captured.length > 0) {
        const capturedAt = match[0].lastIndexOf(captured);
        ranges.push({
          start: match.index + capturedAt,
          end: match.index + capturedAt + captured.length,
          names: [classify === undefined ? name : classify(captured)],
        });
      } else {
        ranges.push({ start: match.index, end: match.index + match[0].length, names: [name] });
      }
    }
    regex.lastIndex = 0;
  }
  return mergeRedactionRanges(ranges);
}

function mergeRedactionRanges(ranges: RedactionRange[]): RedactionRange[] {
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: RedactionRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
      for (const name of range.names) {
        if (!previous.names.includes(name)) previous.names.push(name);
      }
    } else {
      merged.push({ ...range, names: [...range.names] });
    }
  }
  return merged;
}

/**
 * Carry ranges found in normalized text back to the original coordinates.
 *
 * The normalizer records the source range of every code unit it kept, so this
 * is two lookups rather than a second walk that has to re-derive the same
 * answer — and the two cannot disagree about where a match sat.
 */
function mapNormalizedRanges(
  normalized: NormalizedText,
  ranges: readonly RedactionRange[]
): RedactionRange[] {
  const mapped: RedactionRange[] = [];
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    mapped.push({
      start: normalized.start[range.start]!,
      end: normalized.end[range.end - 1]!,
      names: [...range.names],
    });
  }
  return mapped;
}

function redactRanges(text: string, ranges: readonly RedactionRange[]): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    chunks.push(text.slice(cursor, range.start), REDACTION_MARKER);
    cursor = range.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}

interface PrivateKeyRange {
  start: number;
  end: number;
  terminated: boolean;
}

interface PrivateKeyHeader {
  end: number;
  label: string;
  /** Which of {@link PRIVATE_KEY_HEADER_SUFFIXES} closed the marker. */
  suffix: string;
}

const PRIVATE_KEY_BEGIN = '-----BEGIN ';
const PRIVATE_KEY_END = '-----END ';
/**
 * How a private-key marker closes. OpenPGP armors its secret keyring as
 * `PRIVATE KEY BLOCK`, which the single-suffix form could not parse — so a PGP
 * secret key never paired with its terminator and was never claimed at all.
 * Longest first, so `PRIVATE KEY BLOCK` is not read as `PRIVATE KEY` with a
 * stray `BLOCK` behind it.
 */
const PRIVATE_KEY_HEADER_SUFFIXES = ['PRIVATE KEY BLOCK-----', 'PRIVATE KEY-----'];

const PEM_BODY_TOKEN_LINE = /^[A-Za-z0-9+/=_\\-]+$/;
const PEM_MARKER_LINE = /^-----(?:BEGIN|END)\s/;
/**
 * A full-width base64 run: key material that survived per-line decoration.
 *
 * Decoration is what varies between embeddings — a log timestamp, a quoted
 * string literal, a JSON array element — and key material is what does not. A
 * run this long appears on every line of a real PEM body and in no prose.
 */
const PEM_BASE64_RUN = /[A-Za-z0-9+/=]{40,}/;
/** The same shape, enumerable: `g` makes `.test` stateful, so it needs its own. */
const PEM_BASE64_RUNS = /[A-Za-z0-9+/=]{40,}/g;
/** A line that is a full-width run and nothing else once decoration is set aside. */
const PEM_BASE64_RUN_LINE = /^[A-Za-z0-9+/=]{40,}$/;
const PEM_BASE64_CHAR = /[A-Za-z0-9+/=]/;
/**
 * A key's final line is a partial block, so continuation accepts a shorter run
 * — but judged by PROPORTION, not length. Key material dominates the line it
 * sits on; an ordinary word like `unrelated` is nine base64-legal characters
 * adrift in prose, and a length threshold alone cannot tell them apart.
 */
const PEM_BASE64_TAIL = /[A-Za-z0-9+/=]{8,}/g;

/**
 * Where the material sat on the line that opened the block: the width of the
 * decoration in front of it, and the wrap width of the material itself.
 *
 * Both are fixed for the whole of one key — PEM wraps at a constant width, and
 * whatever embeds it does so identically on every line — which is what
 * separates more of THIS key from whatever text merely follows it.
 */
interface PemMaterialShape {
  prefix: number;
  width: number;
}

/**
 * True when the run at `at` is an encapsulated header's VALUE rather than key
 * material. `Comment: SHA256:…`, `Hash:`, `MIC-Info:` and `Key-Info:` all carry
 * base64 of their own, and it is a different width from the body's.
 *
 * Position-anchored rather than line-anchored: under decoration the header is
 * no longer at the start of its line, and that is exactly where it was mistaken
 * for the body.
 */
const PEM_HEADER_VALUE_AT = /(?<=[A-Za-z][A-Za-z0-9-]*:[ \t]*)/y;

function isPemHeaderValueRun(line: string, at: number): boolean {
  PEM_HEADER_VALUE_AT.lastIndex = at;
  return PEM_HEADER_VALUE_AT.test(line);
}

function pemMaterialShape(line: string, trimmed: string): PemMaterialShape | null {
  if (PEM_BODY_TOKEN_LINE.test(trimmed)) {
    return { prefix: line.indexOf(trimmed), width: trimmed.length };
  }
  // The LAST full-width run, not the first: decoration comes in front of the
  // content it wraps, so when the decoration carries a run of its own — a
  // container sha is 64 hex characters, as wide as the key's own lines — the
  // key material is the run behind it.
  let shape: PemMaterialShape | null = null;
  for (const run of line.matchAll(PEM_BASE64_RUNS)) {
    // A header's value fixes the width at the header's own, and every body line
    // is then wider than the block believes it wraps and is dropped — leaving
    // the block reporting refuse over the header alone while its body prints.
    // No shape at all is the safe answer: the block then judges its lines by
    // the same full-width threshold that opened it.
    if (isPemHeaderValueRun(line, run.index)) continue;
    shape = { prefix: run.index, width: run[0].length };
  }
  return shape;
}

/** True when material dominates `line` once the decoration before `prefix` is set aside. */
function pemMaterialDominates(line: string, prefix: number, width: number): boolean {
  // Measured behind the decoration, not across it. A ratio over the whole line
  // makes detection depend on how wide the log prefix happens to be: a key
  // under a Spring Boot or k8s JSON prefix wider than its own wrap width lost
  // every line after the first while the finding still claimed refuse.
  const tail = line.slice(prefix);
  const rest = tail.trim();
  if (rest.length === 0) return false;
  // A line that is nothing but a full-width run behind the decoration is more
  // of the same key whatever it wraps at. The recorded width is one line's
  // guess: taken from an encapsulated header carrying a base64 value, or from
  // a body line a character short of the rest, it makes every real body line
  // look too wide, and the block dies four lines later having reported refuse
  // over a span that stops before the material it was meant to remove.
  //
  // Only where the run STARTS, though. An offset landing inside a longer run
  // leaves a base64-dense tail — the back of a lockfile digest — looking like
  // a line of key.
  if (
    PEM_BASE64_RUN_LINE.test(rest) &&
    (prefix === 0 || tail.length > rest.length || !PEM_BASE64_CHAR.test(line[prefix - 1]))
  ) {
    return true;
  }
  let longest = 0;
  for (const run of rest.matchAll(PEM_BASE64_TAIL)) {
    // A run WIDER than this key's wrap width cannot be part of it. Without that
    // bound an unterminated block feeds on anything base64-dense that follows —
    // a lockfile `integrity` hunk keeps it alive line after line — and the diff
    // redactor scans every hunk body as one document, so it crosses files.
    if (run[0].length > width) continue;
    if (run[0].length > longest) longest = run[0].length;
  }
  return longest * 2 >= rest.length;
}

/** True when a maximal run of exactly `width` starts at `at` on `line`. */
function pemRunAt(line: string, at: number, width: number): boolean {
  if (at + width > line.length) return false;
  if (at > 0 && PEM_BASE64_CHAR.test(line[at - 1]!)) return false;
  if (at + width < line.length && PEM_BASE64_CHAR.test(line[at + width]!)) return false;
  for (let cursor = at; cursor < at + width; cursor += 1) {
    if (!PEM_BASE64_CHAR.test(line[cursor]!)) return false;
  }
  return true;
}

function isPemContinuationLine(line: string, shape: PemMaterialShape): boolean {
  if (pemMaterialDominates(line, shape.prefix, shape.width)) return true;
  // The line that opened the block can carry a full-width run inside its own
  // decoration — a container sha is 64 characters, exactly as wide as the key
  // wraps — leaving the recorded offset pointing at the decoration. Re-anchor
  // on a full-width run this line offers rather than lose the body to that.
  //
  // Only the tail can anchor anything: material has to be half of what follows
  // the anchor and can be no wider than the key wraps, so a run further back
  // than twice that width cannot pass. The bound is also what keeps this
  // linear — without it a single long line packed with full-width runs is
  // rescanned in full from every one of them. Clamped, because the width is
  // the input's to choose: one long token line sets it past the length of any
  // line, the window then covers everything, and the scan is quadratic again.
  const earliest = line.trimEnd().length - 2 * Math.min(shape.width, PEM_MAX_ANCHOR_WIDTH);
  // The recorded run being HERE TOO, at the same offset, is what identifies it
  // as the decoration rather than the key: decoration repeats line for line and
  // a key's material does not. Whatever sits behind it is then this key's, at
  // whatever width — a container sha is 64 characters wide and the key it
  // decorates may wrap at 70, and measuring the body against the sha dropped
  // every line of it.
  const decorating = pemRunAt(line, shape.prefix, shape.width);
  for (const run of line.matchAll(PEM_BASE64_RUNS)) {
    if (run.index < earliest) continue;
    const width =
      decorating && run.index > shape.prefix ? Math.max(shape.width, run[0].length) : shape.width;
    if (run[0].length > width) continue;
    if (pemMaterialDominates(line, run.index, width)) return true;
  }
  return false;
}
/**
 * Non-material lines tolerated AFTER material, before the block is judged over.
 * Decoration splits a literal-wrapped key into alternating material and
 * fragment lines, so this has to absorb a fragment plus a blank line.
 */
const PEM_MAX_DRY_LINES = 4;
/**
 * Non-material lines tolerated BEFORE any material is seen, while looking for
 * the start of the body. RFC 1421 allows `Proc-Type` and `DEK-Info` plus a
 * blank line, and decoration makes those unrecognisable as headers — an
 * encrypted key under a log prefix spent the entire post-material budget on its
 * own headers and was never detected at all. Bounded, so a marker named in the
 * middle of a sentence is out of budget before the paragraph after it.
 */
const PEM_MAX_HEADER_LINES = 4;
/**
 * Non-material lines tolerated between a recognized header block and the body.
 * RFC 1421 puts them next to each other, so a wider gap is a definition list in
 * prose rather than a key: `Rotation:`, `Storage:`, `Owner:` under a docs
 * mention of a marker reached the next file's lockfile hunk, since the diff
 * redactor scans every hunk body as one document.
 */
const PEM_MAX_HEADER_GAP = 2;
/**
 * Encapsulated headers admitted free of the dry budget, per block. Free of that
 * budget is not free of every bound: a line can be both a header and a
 * `-----BEGIN` marker, so an unbounded free pass let every marker in the input
 * rescan the whole tail, which is quadratic in reachable evaluator output.
 */
const PEM_MAX_ENCAPSULATED_HEADERS = 8;
/**
 * Widest wrap the re-anchor window looks back over. The recorded width belongs
 * to the input — a single long token line, a data URI, sets it arbitrarily high
 * — and RFC 1421 wraps at 64 with no tool going past 76.
 */
const PEM_MAX_ANCHOR_WIDTH = 128;
const PEM_ENCAPSULATED_HEADER = /^[A-Za-z][A-Za-z0-9-]*:[ \t]*\S/;

/** Non-material lines this block still tolerates before it is judged over. */
function pemDryBudget(shape: PemMaterialShape | null, headerLines: number): number {
  if (shape !== null) return PEM_MAX_DRY_LINES;
  return headerLines > 0 ? PEM_MAX_HEADER_GAP : PEM_MAX_HEADER_LINES;
}

/**
 * A PEM body carries no internal whitespace: base64, optional RFC 1421
 * encapsulated headers, and marker lines. That is the discriminator between a
 * real key and prose that merely names a `-----BEGIN` marker, because prose and
 * code always break across spaces. Without it, one mention in a comment
 * swallows every following line to the end of the input — and since the diff
 * redactor scans all hunk bodies as a single joined document, that reaches
 * across unrelated files.
 */
function pemBodyLines(span: string): string[] {
  return span.replace(/\\r\\n|\\n|\\r/g, '\n').split(/\r\n|\n|\r/);
}

/** True when every line of `span` is PEM body material and at least one is base64. */
function isPrivateKeyBody(span: string): boolean {
  let sawMaterial = false;
  let clean = true;
  for (const line of pemBodyLines(span)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Either the whole line is key material, or a full-width run of it survived
    // inside whatever decoration wrapped the key.
    if (PEM_BASE64_RUN.test(line) || PEM_BODY_TOKEN_LINE.test(trimmed)) {
      sawMaterial = true;
      continue;
    }
    if (PEM_MARKER_LINE.test(trimmed)) continue;
    if (!sawMaterial && PEM_ENCAPSULATED_HEADER.test(trimmed)) continue;
    clean = false;
  }
  return sawMaterial && clean;
}

function privateKeyBodyRunEnd(text: string, from: number): number {
  let cursor = from;
  let end = -1;
  let dryLines = 0;
  let headerLines = 0;
  let shape: PemMaterialShape | null = null;
  while (cursor <= text.length) {
    let lineEnd = cursor;
    while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') {
      if (startsWithEscapedLineBreak(text, lineEnd)) break;
      lineEnd += 1;
    }
    const line = text.slice(cursor, lineEnd);
    const trimmed = line.trim();
    // A full-width run STARTS a block — that threshold is what stops prose
    // naming a marker from claiming anything. Once material is in hand a
    // shorter run CONTINUES it, because a key's last line is a partial block.
    const material =
      shape === null
        ? PEM_BODY_TOKEN_LINE.test(trimmed) || PEM_BASE64_RUN.test(line)
        : PEM_BODY_TOKEN_LINE.test(trimmed) || isPemContinuationLine(line, shape);
    if (trimmed.length > 0) {
      // A terminator anywhere on the line closes the block inclusively, even
      // when decoration stops it being a complete terminator line. That is what
      // carries a decorated key's short final block, which is too small to
      // qualify as material on its own.
      if (end >= 0 && line.includes(PRIVATE_KEY_END)) {
        end = lineEnd;
        break;
      }
      if (material) {
        end = lineEnd;
        dryLines = 0;
        shape ??= pemMaterialShape(line, trimmed);
      } else if (
        shape === null &&
        dryLines === 0 &&
        headerLines < PEM_MAX_ENCAPSULATED_HEADERS &&
        PEM_ENCAPSULATED_HEADER.test(trimmed)
      ) {
        // RFC 1421 encapsulated headers precede the material rather than being
        // it, and a key carries several. Spending the pre-material budget on
        // them ended the scan before it ever reached base64, and a complete
        // encrypted key went undetected in full. Only in an unbroken run from
        // the marker, though: reached across prose, the same free pass walks a
        // mention of a marker into whatever is base64-dense further down.
        headerLines += 1;
      } else if (++dryLines >= pemDryBudget(shape, headerLines)) {
        break;
      }
    }
    if (lineEnd >= text.length) break;
    cursor = startsWithEscapedLineBreak(text, lineEnd) ? lineEnd + 2 : lineEnd + 1;
  }
  return end;
}

/**
 * Scan private-key blocks once from left to right, rather than retrying a
 * multi-line regex from every BEGIN marker, which is quadratic. An unterminated
 * block is bounded by its body run: where no run follows, the marker claims
 * nothing.
 */
function privateKeyRanges(text: string): PrivateKeyRange[] {
  const ranges: PrivateKeyRange[] = [];
  let cursor = 0;
  // Once no terminator remains after some offset, none remains after any later
  // begin either. Without this, input that is nothing but begin markers makes
  // every one of them rescan the same tail, which is quadratic.
  let terminatorsExhausted = false;

  while (cursor < text.length) {
    const start = text.indexOf(PRIVATE_KEY_BEGIN, cursor);
    if (start < 0) break;
    const beginHeader = parsePrivateKeyHeader(text, start, PRIVATE_KEY_BEGIN);
    if (beginHeader === null) {
      cursor = start + PRIVATE_KEY_BEGIN.length;
      continue;
    }

    let endSearch = beginHeader.end;
    let end = text.length;
    let terminated = false;
    while (!terminatorsExhausted) {
      const candidate = text.indexOf(PRIVATE_KEY_END, endSearch);
      if (candidate < 0) {
        terminatorsExhausted = true;
        break;
      }
      const candidateHeader = parsePrivateKeyHeader(text, candidate, PRIVATE_KEY_END);
      if (
        candidateHeader !== null &&
        candidateHeader.label === beginHeader.label &&
        candidateHeader.suffix === beginHeader.suffix &&
        isPrivateKeyTerminatorLine(text, candidate, candidateHeader.end)
      ) {
        // A non-body line between the markers rules out every LATER end too,
        // since a longer span still contains it. Stop rather than pairing this
        // begin with a further-away end.
        if (!isPrivateKeyBody(text.slice(beginHeader.end, candidate))) break;
        end = candidateHeader.end;
        terminated = true;
        break;
      }
      endSearch = candidate + PRIVATE_KEY_END.length;
    }

    if (!terminated) {
      const runEnd = privateKeyBodyRunEnd(text, beginHeader.end);
      if (runEnd < 0) {
        // The marker is a mention, not a key. Claim nothing.
        cursor = beginHeader.end;
        continue;
      }
      end = runEnd;
    }

    ranges.push({ start, end, terminated });
    cursor = end;
  }

  return ranges;
}

function parsePrivateKeyHeader(
  text: string,
  start: number,
  prefix: string
): PrivateKeyHeader | null {
  if (!text.startsWith(prefix, start)) return null;
  let cursor = start + prefix.length;
  const labelStart = cursor;
  while (cursor < text.length) {
    for (const suffix of PRIVATE_KEY_HEADER_SUFFIXES) {
      if (text.startsWith(suffix, cursor)) {
        return { end: cursor + suffix.length, label: text.slice(labelStart, cursor), suffix };
      }
    }
    const code = text.charCodeAt(cursor);
    if (code !== 32 && (code < 65 || code > 90)) return null;
    cursor += 1;
  }
  return null;
}

function isPrivateKeyTerminatorLine(text: string, start: number, end: number): boolean {
  let before = start;
  while (before > 0 && (text[before - 1] === ' ' || text[before - 1] === '\t')) before -= 1;
  const startsLine =
    before === 0 ||
    text[before - 1] === '\n' ||
    text[before - 1] === '\r' ||
    endsWithEscapedLineBreak(text, before);
  if (!startsLine) return false;

  let after = end;
  while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after += 1;
  return (
    after === text.length ||
    text[after] === '\n' ||
    text[after] === '\r' ||
    startsWithEscapedLineBreak(text, after)
  );
}

function endsWithEscapedLineBreak(text: string, end: number): boolean {
  const marker = text[end - 1];
  if (marker !== 'n' && marker !== 'r') return false;
  let cursor = end - 2;
  let backslashes = 0;
  while (cursor >= 0 && text[cursor] === '\\') {
    backslashes += 1;
    cursor -= 1;
  }
  return backslashes % 2 === 1;
}

function startsWithEscapedLineBreak(text: string, start: number): boolean {
  let cursor = start;
  while (cursor < text.length && text[cursor] === '\\') cursor += 1;
  const backslashes = cursor - start;
  return backslashes === 1 && (text[cursor] === 'n' || text[cursor] === 'r');
}

function walkRedact(value: unknown, redactKeys: boolean, scrubControls = false): unknown {
  const redactText = scrubControls ? scrubEvaluatorOutput : redactSecrets;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    return value.map((child) => walkRedact(child, redactKeys, scrubControls));
  }
  if (isPlainJsonObject(value)) {
    const usedKeys = new Set<string>();
    const nextSuffixes = new Map<string, number>();
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const candidate = redactKeys ? redactText(key) : key;
        const outputKey = redactKeys
          ? uniqueOutputKey(candidate, usedKeys, nextSuffixes)
          : candidate;
        usedKeys.add(outputKey);
        return [outputKey, walkRedact(child, redactKeys, scrubControls)];
      })
    );
  }
  return value;
}

function uniqueOutputKey(
  candidate: string,
  usedKeys: ReadonlySet<string>,
  nextSuffixes: Map<string, number>
): string {
  if (!usedKeys.has(candidate)) return candidate;
  let suffix = nextSuffixes.get(candidate) ?? 2;
  while (usedKeys.has(`${candidate}#${suffix}`)) suffix += 1;
  nextSuffixes.set(candidate, suffix + 1);
  return `${candidate}#${suffix}`;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
