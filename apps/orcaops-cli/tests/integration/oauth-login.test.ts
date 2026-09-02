import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileStore } from '@orcaops/core';

import { loginAction } from '../../src/commands/login.js';
import { CliExit } from '../../src/io/exit.js';
import { type MockOAuthServer, startMockOAuthServer } from '../fixtures/mock-oauth-server.js';

/**
 * E2E for `orcaops login` against the in-process mock AS. Drives the real
 * loginAction (loopback server, fetchDiscovery, exchangeCode, decodeJwt,
 * store.write); only the browser-launch step is replaced with the
 * onAuthorizeUrl hook that fetches the authorize URL ourselves and chases
 * the 302 to the loopback callback.
 */
describe('orcaops login (OAuth 2.1 E2E)', () => {
  let mock: MockOAuthServer;
  let dir: string;
  let store: FileStore;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    // Direct-action tests run OUTSIDE the in-process agent's cwd sandbox, so
    // loginAction's post-login drain would buildContext against the REAL repo
    // this suite runs in. Kill the drain up front so the test cannot touch it.
    vi.stubEnv('ORCAOPS_DISABLE_DRAIN', '1');
    mock = await startMockOAuthServer();
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-login-e2e-'));
    store = new FileStore({ dir });
    originalExit = process.exit;
    // Guard: loginAction signals errors by throwing CliExit, not process.exit —
    // but if anything ever did call exit, turn it into a catchable throw rather
    // than killing the vitest worker.
    Object.defineProperty(process, 'exit', {
      value: ((code?: number) => {
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never,
      configurable: true,
      writable: true,
    });
  });

  afterEach(async () => {
    await mock.shutdown();
    await rm(dir, { recursive: true, force: true });
    Object.defineProperty(process, 'exit', {
      value: originalExit,
      configurable: true,
      writable: true,
    });
    vi.unstubAllEnvs();
  });

  /**
   * Drive the browser-side flow: hit the printed authorize URL ourselves,
   * follow the 302 to the loopback callback. The mock AS validates state
   * and returns a real code; the loopback then resolves the awaiting
   * loginAction.
   */
  function driveBrowser(authzUrl: string): Promise<void> {
    return (async () => {
      const authResponse = await fetch(authzUrl, { redirect: 'manual' });
      if (authResponse.status !== 302) {
        throw new Error(`mock AS /authorize returned ${authResponse.status} (expected 302)`);
      }
      const callbackUrl = authResponse.headers.get('location');
      if (!callbackUrl) throw new Error('mock AS /authorize missing Location header');
      const callback = await fetch(callbackUrl, { redirect: 'manual' });
      if (callback.status !== 200 && callback.status !== 400) {
        throw new Error(`loopback callback returned ${callback.status}`);
      }
    })();
  }

  it('completes the OAuth flow and writes credentials to the store', async () => {
    await loginAction({
      baseUrl: mock.baseUrl,
      store,
      openBrowser: false,
      onAuthorizeUrl: driveBrowser,
    });

    const creds = store.read(mock.baseUrl);
    expect(creds).not.toBeNull();
    expect(creds?.userId).toBe('usr_test');
    expect(creds?.orgId).toBe('org_test');
    expect(creds?.email).toBe('jane@test');
    expect(creds?.orgName).toBe('Acme');
    expect(creds?.refreshToken).toMatch(/^rt_/);
    expect(creds?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const lastBody = mock.lastTokenRequestBody();
    expect(lastBody?.get('grant_type')).toBe('authorization_code');
    expect(lastBody?.get('resource')).toBe(mock.validResource);
    expect(lastBody?.get('client_id')).toBe('orcaops-cli');
  });

  it('refuses when ORCAOPS_TOKEN is set', async () => {
    vi.stubEnv('ORCAOPS_TOKEN', 'tok_xyz');
    // loginAction surfaces errors by throwing CliExit (the program top-level
    // maps it to process.exit) — assert the throw + that nothing was persisted.
    await expect(loginAction({ baseUrl: mock.baseUrl, store })).rejects.toBeInstanceOf(CliExit);
    expect(store.read(mock.baseUrl)).toBeNull();
  });

  it('greets-then-stops when already logged in (without --reauth)', async () => {
    const baseUrl = mock.baseUrl;
    store.write(baseUrl, {
      v: 1,
      loginMethod: 'oauth',
      baseUrl,
      userId: 'usr_existing',
      orgId: 'org_existing',
      orgName: 'ExistingOrg',
      orgSlug: 'existing-org',
      email: 'existing@test',
      accessToken: 'eyJ.fake',
      refreshToken: 'rt_existing',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await loginAction({ baseUrl, store, openBrowser: false });
    // Credentials unchanged
    expect(store.read(baseUrl)?.userId).toBe('usr_existing');
  });

  it('refreshes an expired login and stops without opening OAuth again', async () => {
    const baseUrl = mock.baseUrl;
    await loginAction({
      baseUrl,
      store,
      openBrowser: false,
      onAuthorizeUrl: driveBrowser,
    });
    const expired = store.read(baseUrl);
    expect(expired).not.toBeNull();
    store.write(baseUrl, {
      ...expired!,
      accessToken: 'expired-access-token',
      expiresAt: Math.floor(Date.now() / 1000) - 120,
    });

    await loginAction({ baseUrl, store, openBrowser: false });

    expect(mock.lastTokenRequestBody()?.get('grant_type')).toBe('refresh_token');
    expect(store.read(baseUrl)?.accessToken).not.toBe('expired-access-token');
    expect(store.read(baseUrl)?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('starts OAuth when an expired login cannot be refreshed', async () => {
    const baseUrl = mock.baseUrl;
    store.write(baseUrl, {
      v: 1,
      loginMethod: 'oauth',
      baseUrl,
      userId: 'usr_expired',
      orgId: 'org_expired',
      orgName: null,
      orgSlug: null,
      email: 'expired@test',
      accessToken: 'expired-access-token',
      refreshToken: 'invalid-refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) - 120,
    });

    await loginAction({
      baseUrl,
      store,
      openBrowser: false,
      onAuthorizeUrl: driveBrowser,
    });

    expect(mock.lastTokenRequestBody()?.get('grant_type')).toBe('authorization_code');
    expect(store.read(baseUrl)?.userId).toBe('usr_test');
  });

  it('--reauth forces the OAuth flow even when credentials exist', async () => {
    const baseUrl = mock.baseUrl;
    store.write(baseUrl, {
      v: 1,
      loginMethod: 'oauth',
      baseUrl,
      userId: 'usr_old',
      orgId: 'org_old',
      orgName: null,
      orgSlug: null,
      email: 'old@test',
      accessToken: 'eyJ.fake',
      refreshToken: 'rt_old',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await loginAction({
      baseUrl,
      store,
      reauth: true,
      openBrowser: false,
      onAuthorizeUrl: driveBrowser,
    });
    expect(store.read(baseUrl)?.userId).toBe('usr_test');
  });

  it('surfaces an error and does not persist credentials when the user denies consent', async () => {
    mock.setNextConsent({ accept: false });
    await expect(
      loginAction({
        baseUrl: mock.baseUrl,
        store,
        openBrowser: false,
        onAuthorizeUrl: driveBrowser,
      })
    ).rejects.toBeInstanceOf(CliExit);
    expect(store.read(mock.baseUrl)).toBeNull();
  });

  it('refuses hostile discovery metadata BEFORE the browser step fires', async () => {
    // A server whose discovery document points authorization off-origin —
    // the SDK schema accepts it (non-empty strings), so the CLI's own
    // same-origin validation is the only thing between this response and a
    // browser navigation to an attacker page.
    const { createServer } = await import('node:http');
    const hostile = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: hostileBase,
          authorization_endpoint: 'https://attacker.example/authorize',
          token_endpoint: `${hostileBase}/oauth2/token`,
          revocation_endpoint: `${hostileBase}/oauth2/revoke`,
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['cli:full'],
        })
      );
    });
    await new Promise<void>((resolve) => hostile.listen(0, '127.0.0.1', resolve));
    const hostileBase = `http://127.0.0.1:${(hostile.address() as { port: number }).port}`;
    const browserUrls: string[] = [];
    try {
      await expect(
        loginAction({
          baseUrl: hostileBase,
          store,
          openBrowser: false,
          onAuthorizeUrl: (url) => {
            browserUrls.push(url);
          },
        })
      ).rejects.toThrow();
      expect(browserUrls).toEqual([]);
      expect(store.read(hostileBase)).toBeNull();
    } finally {
      await new Promise<void>((resolve) => hostile.close(() => resolve()));
    }
  });
});
