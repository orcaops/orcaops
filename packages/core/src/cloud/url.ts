// `URL.hostname` returns the bracketed form for IPv6 literals (`[::1]`), so
// the loopback set must hold the bracketed spelling to match a real parse.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * Validate a cloud baseUrl: must be http(s); http is allowed only against a
 * loopback host. Returns the trailing-slash-trimmed URL. Production injects the
 * official HTTPS origin; loopback HTTP exists for the source-only development
 * launcher and focused tests. A bearer must never leave over cleartext to a
 * non-loopback host.
 *
 * This is a security GATE, not a namespace canonicalizer: it returns the input
 * with ONLY trailing slashes trimmed (host case + default port PRESERVED), so
 * `https://Cloud.Example` and `https://cloud.example` come back distinct. Never
 * key a cache namespace off this value — use storage's `canonicalizeBaseUrl`
 * (source-plan/canonical-base-url.ts) for identity. See that file for the split.
 */
export function assertSafeCloudUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid cloud base URL: "${value}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Cloud base URL must be http(s) (got ${url.protocol}//).`);
  }
  if (url.protocol === 'http:') {
    const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
    if (!isLoopback) {
      throw new Error(
        `base URL must use https against non-loopback hosts (got http://${url.hostname}).`
      );
    }
  }
  return value.replace(/\/+$/, '');
}
