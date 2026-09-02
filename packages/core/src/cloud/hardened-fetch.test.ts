import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAuthedCloudClient,
  createOrcaCloudClient,
  type CredentialStore,
  exchangeCode,
  fetchDiscovery,
  refreshTokens,
  type StoredCredentials,
} from '@orcaops/sdk';

import {
  assertSameOriginDiscovery,
  assertSameOriginUrl,
  createHardenedFetch,
  HARDENED_FETCH_TIMEOUT_MS,
  OutboundPolicyError,
} from './hardened-fetch.js';
import { REFRESH_LOCK_STALE_MS } from '../credentials/refresh-lock.js';

const BASE = 'https://cloud.example';

function goodMeta(base: string): {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
} {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth2/authorize`,
    token_endpoint: `${base}/oauth2/token`,
    revocation_endpoint: `${base}/oauth2/revoke`,
  };
}

describe('createHardenedFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a cross-origin request before any network I/O', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const hardened = createHardenedFetch(BASE);
    await expect(hardened('https://attacker.example/oauth2/token')).rejects.toThrow(
      OutboundPolicyError
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a same-host different-port request (origin includes the port)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const hardened = createHardenedFetch(BASE);
    await expect(hardened('https://cloud.example:8443/api')).rejects.toThrow(OutboundPolicyError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an embedded-credentials URL even when same-origin', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const hardened = createHardenedFetch(BASE);
    await expect(hardened('https://user:pass@cloud.example/api')).rejects.toThrow(
      /embedded credentials/
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects malformed and non-http(s) scheme URLs', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const hardened = createHardenedFetch(BASE);
    await expect(hardened('not a url')).rejects.toThrow(OutboundPolicyError);
    await expect(hardened('file:///etc/passwd')).rejects.toThrow(OutboundPolicyError);
    await expect(hardened('javascript:alert(1)')).rejects.toThrow(OutboundPolicyError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an origin-INHERITING scheme that would otherwise pass the origin check', async () => {
    // `blob:https://cloud.example/x` reports origin `https://cloud.example`
    // and empty username/password — an origin-only check passes it. Schemes
    // that inherit an origin must be refused on the scheme itself.
    const spy = vi.spyOn(globalThis, 'fetch');
    const hardened = createHardenedFetch(BASE);
    expect(new URL(`blob:${BASE}/x`).origin).toBe(new URL(BASE).origin);
    await expect(hardened(`blob:${BASE}/x`)).rejects.toThrow(/http\(s\)/);
    await expect(hardened(`blob:https://user:pass@cloud.example/x`)).rejects.toThrow(/http\(s\)/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes a same-origin request through with redirect forced to error', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const hardened = createHardenedFetch(BASE);
    const res = await hardened(`${BASE}/api/trpc/cli.ping`, { method: 'GET', redirect: 'follow' });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('applies the bounded request signal to network calls', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const pending = createHardenedFetch(BASE)(`${BASE}/oauth2/token`);

    expect(timeoutSpy).toHaveBeenCalledWith(HARDENED_FETCH_TIMEOUT_MS);
    timeout.abort(new Error('request deadline reached'));
    await expect(pending).rejects.toThrow('request deadline reached');
  });

  it('propagates an operation abort through the network signal', async () => {
    const operation = new AbortController();
    let networkSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          networkSignal = init?.signal;
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const pending = createHardenedFetch(BASE, operation.signal)(`${BASE}/oauth2/token`);

    operation.abort(new Error('eager push deadline reached'));
    await expect(pending).rejects.toThrow('eager push deadline reached');
    expect(networkSignal?.aborted).toBe(true);
  });

  it('keeps each locked OAuth request deadline below the stale threshold', () => {
    expect(HARDENED_FETCH_TIMEOUT_MS).toBeLessThan(REFRESH_LOCK_STALE_MS);
  });

  it('resolves globalThis.fetch at call time, not construction', async () => {
    const hardened = createHardenedFetch(BASE);
    // The spy is installed AFTER the wrapper exists — the whoami --verify
    // e2e tests rely on exactly this ordering.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await hardened(`${BASE}/api/trpc/user.me`);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('supports a loopback http base URL without any override', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const hardened = createHardenedFetch('http://127.0.0.1:8123');
    await hardened('http://127.0.0.1:8123/oauth2/token');
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(hardened('http://127.0.0.1:9999/oauth2/token')).rejects.toThrow(
      OutboundPolicyError
    );
  });

  it('rejects non-loopback http without an escape hatch', () => {
    expect(() => createHardenedFetch('http://staging.internal')).toThrow(/https/);
  });
});

describe('assertSameOriginDiscovery', () => {
  it('accepts all-same-origin metadata', () => {
    expect(() => assertSameOriginDiscovery(goodMeta(BASE), BASE)).not.toThrow();
  });

  it.each(['issuer', 'authorization_endpoint', 'token_endpoint', 'revocation_endpoint'] as const)(
    'rejects a cross-origin %s naming the offending field',
    (field) => {
      const meta = { ...goodMeta(BASE), [field]: 'https://attacker.example/x' };
      expect(() => assertSameOriginDiscovery(meta, BASE)).toThrow(
        new RegExp(`${field}.*not same-origin`)
      );
    }
  );

  it('rejects non-URL and dangerous-scheme endpoints', () => {
    expect(() =>
      assertSameOriginDiscovery({ ...goodMeta(BASE), token_endpoint: '' }, BASE)
    ).toThrow(OutboundPolicyError);
    expect(() =>
      assertSameOriginDiscovery(
        { ...goodMeta(BASE), authorization_endpoint: 'javascript:alert(1)' },
        BASE
      )
    ).toThrow(OutboundPolicyError);
    expect(() =>
      assertSameOriginDiscovery({ ...goodMeta(BASE), issuer: 'file:///etc/passwd' }, BASE)
    ).toThrow(OutboundPolicyError);
  });

  it('rejects an origin-inheriting blob: authorization_endpoint', () => {
    // The browser seam: this endpoint is handed to open(). An origin-only
    // check would pass it because blob: inherits the origin.
    expect(() =>
      assertSameOriginDiscovery(
        { ...goodMeta(BASE), authorization_endpoint: `blob:${BASE}/authorize` },
        BASE
      )
    ).toThrow(/http\(s\)/);
  });
});

describe('assertSameOriginUrl', () => {
  it('accepts the same-origin authorization URL and rejects a cross-origin one', () => {
    expect(() =>
      assertSameOriginUrl(`${BASE}/oauth2/authorize?client_id=x`, BASE, 'authorization URL')
    ).not.toThrow();
    expect(() =>
      assertSameOriginUrl('https://attacker.example/authorize', BASE, 'authorization URL')
    ).toThrow(/authorization URL/);
  });
});

/**
 * Redirect refusal, one test per flow. The server 302s the flow's endpoint
 * toward `/moved`; `redirect: 'error'` must refuse BEFORE following, so the
 * flow fails (or reports failure) and `/moved` records zero hits.
 */
describe('redirect refusal per flow', () => {
  let server: Server;
  let base: string;
  let movedHits = 0;
  /** Paths served straight (JSON body); everything else 302s to /moved. */
  let serveDirect: Map<string, unknown>;

  async function startRedirectingServer(): Promise<void> {
    movedHits = 0;
    serveDirect = new Map();
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', base).pathname;
      if (path === '/moved') {
        movedHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (serveDirect.has(path)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(serveDirect.get(path)));
        return;
      }
      res.writeHead(302, { location: `${base}/moved` });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function discoveryDoc(): Record<string, unknown> {
    return {
      ...goodMeta(base),
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['cli:full'],
    };
  }

  function storeWith(credentials: StoredCredentials): CredentialStore {
    return {
      kind: 'env',
      read: () => credentials,
      write: () => {},
      clear: () => {},
    };
  }

  function liveCredentials(): StoredCredentials {
    return {
      v: 1,
      loginMethod: 'oauth',
      baseUrl: base,
      userId: 'u1',
      orgId: 'o1',
      orgName: null,
      orgSlug: null,
      email: 'u@example.test',
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('discovery: a redirected well-known document is refused', async () => {
    await startRedirectingServer();
    await expect(fetchDiscovery(base, { fetch: createHardenedFetch(base) })).rejects.toThrow();
    expect(movedHits).toBe(0);
  });

  it('token exchange: a redirected token endpoint is refused', async () => {
    await startRedirectingServer();
    await expect(
      exchangeCode({
        tokenEndpoint: `${base}/oauth2/token`,
        code: 'code',
        verifier: 'verifier',
        clientId: 'orcaops-cli',
        redirectUri: 'http://127.0.0.1:1/callback',
        resource: base,
        fetch: createHardenedFetch(base),
      })
    ).rejects.toThrow();
    expect(movedHits).toBe(0);
  });

  it('refresh: a redirected token endpoint is refused', async () => {
    await startRedirectingServer();
    await expect(
      refreshTokens({
        tokenEndpoint: `${base}/oauth2/token`,
        refreshToken: 'live-refresh-token',
        clientId: 'orcaops-cli',
        resource: base,
        fetch: createHardenedFetch(base),
      })
    ).rejects.toThrow();
    expect(movedHits).toBe(0);
  });

  it('refresh via the PRODUCTION path: ensureFreshToken threads the wrapper into its own discovery + token calls', async () => {
    // The direct refreshTokens test above supplies the wrapper itself, so it
    // cannot see whether the SDK's internal refresh (createAuthedCloudClient
    // → refreshAndPersist → fetchDiscovery + refreshTokens) still threads
    // `userFetch`. This drives the real entry point that isAuthReady and
    // whoami use. ensureFreshToken swallows its own errors, so the proof is
    // that no redirect was followed and no rotated token was persisted.
    await startRedirectingServer();
    serveDirect.set('/.well-known/oauth-authorization-server', discoveryDoc());
    const expired = { ...liveCredentials(), expiresAt: Math.floor(Date.now() / 1000) - 60 };
    const writes: StoredCredentials[] = [];
    const store: CredentialStore = {
      kind: 'file',
      read: () => expired,
      write: (_baseUrl: string, blob: StoredCredentials) => {
        writes.push(blob);
      },
      clear: () => {},
    };
    const authed = createAuthedCloudClient({
      baseUrl: base,
      credentialStore: store,
      fetch: createHardenedFetch(base),
      cliVersion: '0.0.5-test',
    });
    await authed.ensureFreshToken();
    expect(movedHits).toBe(0);
    expect(writes).toEqual([]);
  });

  it('refresh via the PRODUCTION path: a redirected discovery is refused too', async () => {
    await startRedirectingServer();
    const expired = { ...liveCredentials(), expiresAt: Math.floor(Date.now() / 1000) - 60 };
    const writes: StoredCredentials[] = [];
    const store: CredentialStore = {
      kind: 'file',
      read: () => expired,
      write: (_baseUrl: string, blob: StoredCredentials) => {
        writes.push(blob);
      },
      clear: () => {},
    };
    const authed = createAuthedCloudClient({
      baseUrl: base,
      credentialStore: store,
      fetch: createHardenedFetch(base),
      cliVersion: '0.0.5-test',
    });
    await authed.ensureFreshToken();
    expect(movedHits).toBe(0);
    expect(writes).toEqual([]);
  });

  it('revocation: a redirected revoke endpoint is refused', async () => {
    await startRedirectingServer();
    serveDirect.set('/.well-known/oauth-authorization-server', discoveryDoc());
    const authed = createAuthedCloudClient({
      baseUrl: base,
      credentialStore: storeWith(liveCredentials()),
      fetch: createHardenedFetch(base),
      cliVersion: '0.0.5-test',
    });
    const result = await authed.logout();
    expect(result.remoteRevoked).toBe(false);
    expect(movedHits).toBe(0);
  });

  it('authenticated tRPC: a redirected procedure endpoint is refused', async () => {
    await startRedirectingServer();
    // Bearer-bearing, as production tRPC always is — a redirect must be
    // refused with credentials attached, not just on an anonymous request.
    const client = createOrcaCloudClient({
      baseUrl: base,
      fetch: createHardenedFetch(base),
      getAuthHeaders: () => Promise.resolve({ authorization: 'Bearer live-access-token' }),
      cliVersion: '0.0.5-test',
    });
    await expect(client.cli.ping()).rejects.toThrow();
    expect(movedHits).toBe(0);
  });

  it('login probe: a redirected user.me is refused', async () => {
    await startRedirectingServer();
    // The login identity probe's exact construction: ephemeral in-memory
    // store carrying just-exchanged tokens.
    const authed = createAuthedCloudClient({
      baseUrl: base,
      credentialStore: storeWith(liveCredentials()),
      fetch: createHardenedFetch(base),
      cliVersion: '0.0.5-test',
    });
    await expect(authed.client.user.me()).rejects.toThrow();
    expect(movedHits).toBe(0);
  });

  it('logout: a redirected discovery document is refused', async () => {
    await startRedirectingServer();
    const authed = createAuthedCloudClient({
      baseUrl: base,
      credentialStore: storeWith(liveCredentials()),
      fetch: createHardenedFetch(base),
      cliVersion: '0.0.5-test',
    });
    const result = await authed.logout();
    expect(result.remoteRevoked).toBe(false);
    expect(movedHits).toBe(0);
  });
});
