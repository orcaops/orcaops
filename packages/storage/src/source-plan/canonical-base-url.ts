/**
 * Normalize a cloud base URL for equality comparison — lowercases the host,
 * drops a default port and any trailing slash(es) — so a trailing-slash /
 * scheme-case / raw injected origin compares equal to its canonical
 * form. Pure (`new URL` + string ops), so it lives in `@orcaops/storage` and
 * every database namespace, push guard, and lineage lookup uses the same
 * canonical identity.
 *
 * On an unparseable input (not a valid URL) it degrades to a trimmed,
 * trailing-slash-stripped, LOWERCASED passthrough rather than throwing — the
 * caller's own URL validation is the real gate; this is a normalizer, not a
 * validator. The fallback lowercases the whole string (vs the parse path, which
 * only lowercases the host and preserves path case) so two case-variants of an
 * unparseable base_url still canonicalize equal — safe because the output is
 * only ever an identity key / origin comparison, never a fetched URL.
 *
 * Distinct from core's `assertSafeCloudUrl` (cloud/url.ts) — keep them straight:
 * that one is a security GATE that returns the validated input with ONLY trailing
 * slashes trimmed (host case + default port PRESERVED), so it must never key a
 * database namespace. This is the inverse — a full identity canonicalizer with no
 * validation. They operate on the same value but share no code on purpose
 * (different contracts); a change to one's normalization should be cross-checked
 * against the other. Anything keying a namespace uses THIS; anything gating a
 * connection uses THAT.
 */
export function canonicalizeBaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}
