import {
  findSecretLocations,
  redactSecrets,
  type SecretTier,
} from '@orcaops/evaluator-protocol/secrets';

import { stripControlChars } from './control-chars.js';

/**
 * Secret detection over a parsed capture payload, reported by JSON path.
 *
 * Deliberate sibling of `./control-chars.ts`, and it borrows that module's
 * shape on purpose: the same value walk, the same path grammar, the same
 * collect-then-assert split. A caller that already knows how to act on a
 * control-char report knows how to act on this one.
 *
 * Two properties this module is responsible for:
 *
 * - **It never carries the secret.** A finding is a path plus pattern names.
 *   The offsets that {@link findSecretLocations} returns are dropped here —
 *   they are right for a library primitive and wrong for a report that ends up
 *   in an agent transcript, where a position is a partial oracle on the value.
 * - **It never mutates.** Unlike control chars, which are stripped and healed,
 *   a secret is not something to silently clean out of a payload: three
 *   content-identity systems hash capture payloads, so rewriting one turns a
 *   byte-identical retry into an unresolvable idempotency conflict. Detect,
 *   report, and let the caller refuse.
 */

/** One secret-shaped string found in a payload, located by JSON path. */
export interface SecretFinding {
  /** JSON path of the offending string, e.g. `plan_steps[0].text`. */
  readonly path: string;
  /** Contributing pattern names. Never empty, never the matched text. */
  readonly patterns: readonly string[];
  /** Strongest tier across {@link patterns} — `refuse` if any refuses. */
  readonly tier: SecretTier;
  /**
   * The assignment token immediately before the match (`token:`, `api_key=`),
   * when there is one. Present so a caller can point at the offending line in
   * a long field; absent for shapes that are their own prefix, such as a
   * bare `ghp_` token.
   *
   * Bounded and shape-checked rather than sliced freely: it is emitted only
   * when it ends in `:` or `=`, which keeps it to the label an author wrote
   * and never to a leading fragment of the secret itself.
   */
  readonly keyPrefix?: string;
}

/** Longest label we will echo back. Long enough for `aws_secret_access_key=`. */
const MAX_KEY_PREFIX = 32;

/**
 * Matches an author-written assignment label at the very end of a string:
 * an identifier run, optional space, then `:` or `=`.
 *
 * The identifier class deliberately excludes `/`, `?` and `&` so a URL cannot
 * be swallowed whole — without that, a token in a query string reported its
 * entire path as the "label", which is the value-disclosure this field exists
 * to avoid. Structurally, the result can only ever be text the author wrote
 * BEFORE the match, never a fragment of the match itself.
 */
const KEY_PREFIX_PATTERN = /([A-Za-z0-9_.$-]{1,30})\s*([:=])$/u;

/**
 * The author-written label immediately preceding a match, or undefined.
 *
 * The identifier must begin at a token boundary. Without that check the run
 * before a match can be the tail of an adjacent secret rather than a label —
 * base64 body ending in `=` immediately before a token reads as `key=` and
 * would echo the neighbouring credential into the finding.
 */
function keyPrefixBefore(text: string, start: number): string | undefined {
  if (start <= 0) return undefined;
  const before = text.slice(0, start).trimEnd();
  const matched = KEY_PREFIX_PATTERN.exec(before);
  if (matched === null) return undefined;
  const label = `${matched[1]}${matched[2]}`;
  if (label.length > MAX_KEY_PREFIX) return undefined;
  const boundary = before.charAt(before.length - label.length - 1);
  return boundary === '' || /[\s"'`,;([{]/u.test(boundary) ? label : undefined;
}

/**
 * Collect a {@link SecretFinding} for every string in `value` holding a
 * secret-shaped run, keyed by JSON path.
 *
 * Walks values, array items, and object KEYS — a payload can carry a
 * `z.unknown()` record whose keys are author-supplied, and a key holds a token
 * as readily as a value does. `base` prefixes every reported path, for a
 * caller reporting on a fragment of a larger document.
 *
 * One finding per string, not per match: a caller refusing on tier wants one
 * decision per field, so an entry carries the union of the pattern names found
 * in it and the strongest tier among them.
 */
export function collectSecretPaths(
  value: unknown,
  base: string,
  // Both REQUIRED, not defaulted: a default `allow` is how the allowlist
  // shipped dead at every outbound call site — an omitted argument reads as
  // "no exemptions" and nothing catches it. `base` follows because TypeScript
  // forbids a required parameter after an optional one.
  allow: readonly string[]
): SecretFinding[] {
  const out: SecretFinding[] = [];
  // Compared against the DETECTED SUBSTRING below, so an entry names exactly
  // one known-dead string and can never widen to a field, a path or a shape.
  const allowed = new Set(allow);

  const record = (path: string, text: string): void => {
    // Scan the text as written AND as it will be stored. `findSecretLocations`
    // normalizes with `stripTerminalFormatting`, the store with
    // `stripControlChars`, and the two disagree — notably on U+009B (C1 CSI).
    // A token split by a byte only the store removes would otherwise clear
    // this gate and be healed back into a live credential at write time.
    const stripped = stripControlChars(text);
    const locations = [
      ...findSecretLocations(text).map((l) => ({ ...l, source: text })),
      ...(stripped === text
        ? []
        : findSecretLocations(stripped).map((l) => ({ ...l, source: stripped }))),
      // A run allowed by a human is dropped entirely, not demoted to warn: the
      // point of an entry is that someone read that exact string and judged it
      // dead, and re-surfacing it every capture trains people to ignore warns.
    ].filter((l) => !allowed.has(l.source.slice(l.start, l.end)));
    if (locations.length === 0) return;

    const patterns: string[] = [];
    let tier: SecretTier = 'warn';
    for (const location of locations) {
      if (location.tier === 'refuse') tier = 'refuse';
      for (const name of location.patterns) {
        if (!patterns.includes(name)) patterns.push(name);
      }
    }
    const keyPrefix = keyPrefixBefore(text, locations[0]?.start ?? 0);
    out.push({
      path: path === '' ? '(root)' : path,
      patterns,
      tier,
      ...(keyPrefix === undefined ? {} : { keyPrefix }),
    });
  };

  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      record(path, v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        // The key becomes part of a reported path, so it is scrubbed twice
        // over: `stripControlChars` for the same reason
        // `collectControlCharPaths` does it, and `redactSecrets` because a key
        // can itself be a credential — echoing it into the finding would make
        // this module restate the secret it exists to refuse.
        const cleanKey = redactSecrets(stripControlChars(k));
        record(path === '' ? `{key ${cleanKey}}` : `${path}.{key ${cleanKey}}`, k);
        walk(val, path === '' ? cleanKey : `${path}.${cleanKey}`);
      }
    }
  };

  walk(value, base);
  return out;
}

/**
 * Thrown by {@link assertNoSecretsInPayload}. Carries every finding rather
 * than the first: the remedy is an agent rewriting narrative, so surfacing one
 * field at a time costs a round trip per secret.
 *
 * The message names paths and pattern names only. It never contains the
 * matched value — a test asserts this, because this error is designed to be
 * read by the agent that authored the payload and lands in its transcript.
 */
export class SecretInPayloadError extends Error {
  readonly name = 'SecretInPayloadError';
  readonly findings: readonly SecretFinding[];

  constructor(findings: readonly SecretFinding[]) {
    const listed = findings.map((f) => `${f.path} (${f.patterns.join(', ')})`).join('; ');
    super(
      `likely secret(s) in agent-authored content: ${listed}. ` +
        `Rewrite to describe the credential rather than quote it, then retry.`
    );
    this.findings = findings;
  }
}

/**
 * Throw {@link SecretInPayloadError} if `value` holds any `refuse`-tier
 * secret. `warn`-tier findings are returned rather than thrown, so a caller
 * can surface them without blocking the write.
 *
 * Asserts, never strips — see the module docblock.
 */
export function assertNoSecretsInPayload(
  value: unknown,
  /** REQUIRED — see {@link collectSecretPaths}. */
  allow: readonly string[]
): readonly SecretFinding[] {
  const findings = collectSecretPaths(value, '', allow);
  const refusals = findings.filter((f) => f.tier === 'refuse');
  if (refusals.length > 0) throw new SecretInPayloadError(refusals);
  return findings;
}
