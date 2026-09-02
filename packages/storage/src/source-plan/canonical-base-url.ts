/**
 * Normalize a cloud base URL for equality comparison — lowercases the host,
 * drops a default port and any trailing slash(es) — so a trailing-slash /
 * scheme-case / raw injected origin compares equal to its canonical
 * form. Pure (`new URL` + string ops), so it lives in `@orcaops/storage`:
 * the pull-cache namespace hash (write/read/scan agreement), the push's
 * Branch-A wrong-origin guard, and the Branch-B `derived_from` lineage lookup
 * must ALL fold base_url through the identical rule or they key under split
 * namespaces. Keeping the one implementation in the lowest shared layer is
 * what makes that agreement structural rather than coincidental.
 *
 * On an unparseable input (not a valid URL) it degrades to a trimmed,
 * trailing-slash-stripped, LOWERCASED passthrough rather than throwing — the
 * caller's own URL validation is the real gate; this is a normalizer, not a
 * validator. The fallback lowercases the whole string (vs the parse path, which
 * only lowercases the host and preserves path case) so two case-variants of an
 * unparseable base_url still canonicalize equal — safe because the output is
 * only ever a hash key / origin comparison, never a fetched URL.
 *
 * Distinct from core's `assertSafeCloudUrl` (cloud/url.ts) — keep them straight:
 * that one is a security GATE that returns the validated input with ONLY trailing
 * slashes trimmed (host case + default port PRESERVED), so it must never key a
 * cache namespace. This is the inverse — a full identity canonicalizer with no
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
