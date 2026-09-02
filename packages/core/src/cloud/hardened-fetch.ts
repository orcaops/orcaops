import { assertSafeCloudUrl } from './url.js';

export const HARDENED_FETCH_TIMEOUT_MS = 30_000;

/**
 * Outbound network policy for every cloud/OAuth request.
 *
 * The vendored SDK takes endpoint URLs from OAuth discovery metadata and
 * uses them verbatim, following redirects — so a compromised or
 * misconfigured discovery response could steer tokens (grant codes,
 * refresh tokens, bearer headers) to an attacker origin. The supported
 * deployment topology is same-origin: discovery lives at
 * `<baseUrl>/.well-known/oauth-authorization-server` and every endpoint it
 * returns is built from that same base. These guards pin exactly that.
 */

export class OutboundPolicyError extends Error {
  override readonly name = 'OutboundPolicyError';
}

function parsePinnedOrigin(baseUrl: string): string {
  return new URL(assertSafeCloudUrl(baseUrl)).origin;
}

/**
 * Reject the URL shapes that are unsafe to hand to a browser at all, whatever
 * host they name. For a destination whose origin IS pinned, use
 * `assertSameOriginUrl`, which adds that check on top.
 */
export function assertBrowserSafeUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundPolicyError(`${label} is not a valid URL: ${JSON.stringify(raw)}.`);
  }
  // Scheme first: an origin check alone is not enough, because some schemes
  // INHERIT an origin. `blob:https://cloud.example/x` reports origin
  // `https://cloud.example` and empty username/password, so it would clear
  // both checks below while naming something that is not an https request.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundPolicyError(`${label} must be http(s); got ${url.protocol} in ${raw}.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new OutboundPolicyError(`${label} must not carry embedded credentials: "${url.origin}".`);
  }
  return url;
}

/**
 * For a browser URL that sits BESIDE the API rather than on it. The plan web
 * surface is `app.*` while the API is `api.*`, so an origin pin would reject
 * every real URL, and scheme alone would accept the `evil.example` a
 * compromised cloud answers with.
 *
 * "Parent domain" is the host minus its first label, not a public-suffix
 * lookup, so it is too permissive against a base host one label deep under a
 * multi-label suffix. Defence in depth over a compromised response; the primary
 * control is that the base URL is operator-chosen.
 */
export function assertSiblingHostUrl(value: string, baseUrl: string, label: string): URL {
  const url = assertBrowserSafeUrl(value, label);
  const base = new URL(assertSafeCloudUrl(baseUrl));
  if (url.hostname === base.hostname) return url;

  const parent = base.hostname.split('.').slice(1).join('.');
  if (parent.includes('.') && url.hostname.endsWith(`.${parent}`)) return url;

  throw new OutboundPolicyError(
    `${label} (${url.origin}) is not the cloud host or a sibling of it (${base.hostname}); refusing.`
  );
}

function assertUrlAgainstOrigin(raw: string, origin: string, label: string): URL {
  const url = assertBrowserSafeUrl(raw, label);
  if (url.origin !== origin) {
    throw new OutboundPolicyError(
      `${label} (${url.origin}) is not same-origin with the cloud base URL (${origin}); refusing.`
    );
  }
  return url;
}

/**
 * Validate that a URL is same-origin with the (transport-validated) cloud
 * base URL and free of embedded credentials. Returns the parsed URL. Use at
 * the seams the hardened fetch cannot see — the authorization URL handed to
 * the BROWSER immediately before launch.
 */
export function assertSameOriginUrl(value: string, baseUrl: string, label: string): URL {
  return assertUrlAgainstOrigin(value, parsePinnedOrigin(baseUrl), label);
}

/** The four discovery endpoints the CLI's OAuth flows consume. */
export interface DiscoveryEndpoints {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
}

/**
 * Validate discovery metadata BEFORE it is acted on — in particular before
 * `authorization_endpoint` is opened in a browser. The SDK's own schema
 * only requires non-empty strings, so `file:///x`, `javascript:` or an
 * attacker origin would pass it. Every endpoint (and the issuer) must be
 * same-origin with the base URL the discovery document was fetched from.
 */
export function assertSameOriginDiscovery(meta: DiscoveryEndpoints, baseUrl: string): void {
  const origin = parsePinnedOrigin(baseUrl);
  assertUrlAgainstOrigin(meta.issuer, origin, 'discovery issuer');
  assertUrlAgainstOrigin(meta.authorization_endpoint, origin, 'discovery authorization_endpoint');
  assertUrlAgainstOrigin(meta.token_endpoint, origin, 'discovery token_endpoint');
  assertUrlAgainstOrigin(meta.revocation_endpoint, origin, 'discovery revocation_endpoint');
}

/**
 * A `fetch` pinned to the cloud base URL's origin, for injection at every
 * SDK entry point (`options.fetch ?? fetch` — an un-injected site silently
 * falls back to global fetch, so injection coverage is the load-bearing
 * guard). Every request must be same-origin with the validated base URL and
 * carries `redirect: 'error'` — token endpoints must never be reached via a
 * redirect the policy did not examine. Every individual request has a
 * deterministic 30-second deadline, including requests made while a
 * credential lock is held.
 *
 * Resolves `globalThis.fetch` at CALL time, not construction: tests spy on
 * the global, and a module-scope capture would silently bypass them.
 */
export function createHardenedFetch(baseUrl: string, operationSignal?: AbortSignal): typeof fetch {
  const origin = parsePinnedOrigin(baseUrl);
  const hardenedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    try {
      assertUrlAgainstOrigin(raw, origin, 'outbound request URL');
    } catch (err) {
      return Promise.reject(err);
    }
    const timeoutSignal = AbortSignal.timeout(HARDENED_FETCH_TIMEOUT_MS);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signals = [callerSignal, operationSignal, timeoutSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    return globalThis.fetch(input, { ...init, redirect: 'error', signal });
  };
  return hardenedFetch as typeof fetch;
}
