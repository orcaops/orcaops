import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type StoredCredentials } from '@orcaops/sdk';

import { resetDefaultCliVersion, setDefaultCliVersion } from './cli-version.js';
import { isAuthReady } from './client.js';
import { FileStore } from '../credentials/file-store.js';

/**
 * End-to-end proactive-refresh check against a real loopback OAuth server.
 * Exercises the full chain: isAuthReady → ensureFreshToken → discovery +
 * /oauth2/token POST → FileStore.write (under the real withRefreshLock). Models
 * the "1-minute access-token TTL" scenario by writing already-expired creds
 * with a still-valid refresh token.
 */
interface MockCloud {
  baseUrl: string;
  tokenPosts: number;
  mode: 'ok' | 'invalid_grant';
  close: () => Promise<void>;
}

async function startMockCloud(): Promise<MockCloud> {
  const state = { tokenPosts: 0, mode: 'ok' as 'ok' | 'invalid_grant', baseUrl: '' };
  const server: Server = createServer((req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: state.baseUrl,
          authorization_endpoint: `${state.baseUrl}/oauth2/authorize`,
          token_endpoint: `${state.baseUrl}/oauth2/token`,
          revocation_endpoint: `${state.baseUrl}/oauth2/revoke`,
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['cli:full', 'offline_access'],
        })
      );
      return;
    }
    if (req.url === '/oauth2/token' && req.method === 'POST') {
      state.tokenPosts += 1;
      if (state.mode === 'invalid_grant') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ access_token: 'fresh_at', refresh_token: 'rotated_rt', expires_in: 3600 })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server address');
  state.baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    get baseUrl() {
      return state.baseUrl;
    },
    get tokenPosts() {
      return state.tokenPosts;
    },
    set mode(m: 'ok' | 'invalid_grant') {
      state.mode = m;
    },
    get mode() {
      return state.mode;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const EXPIRED = Math.floor(Date.now() / 1000) - 600;

function expiredCreds(baseUrl: string): StoredCredentials {
  return {
    v: 1,
    loginMethod: 'oauth',
    baseUrl,
    userId: 'usr_1',
    orgId: 'org_1',
    orgName: null,
    orgSlug: null,
    email: 'e@test',
    accessToken: 'stale_at',
    refreshToken: 'rt_valid',
    expiresAt: EXPIRED,
  };
}

describe('proactive refresh (integration)', () => {
  let dir: string;
  let cloud: MockCloud;

  beforeEach(async () => {
    setDefaultCliVersion('0.0.5');
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-refresh-int-'));
    cloud = await startMockCloud();
  });
  afterEach(async () => {
    resetDefaultCliVersion();
    await cloud.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('isAuthReady renews an expired token via the refresh token and reports ready', async () => {
    const store = new FileStore({ dir });
    store.write(cloud.baseUrl, expiredCreds(cloud.baseUrl));

    const ready = await isAuthReady({ store, baseUrl: cloud.baseUrl });

    expect(ready).toBe(true);
    expect(cloud.tokenPosts).toBe(1);
    // The refresh token was actually spent and the rotated creds persisted.
    expect(store.read(cloud.baseUrl)?.accessToken).toBe('fresh_at');
    expect(store.read(cloud.baseUrl)?.refreshToken).toBe('rotated_rt');
  });

  it('isAuthReady reports not-ready when the refresh token is also dead (invalid_grant)', async () => {
    cloud.mode = 'invalid_grant';
    const store = new FileStore({ dir });
    store.write(cloud.baseUrl, expiredCreds(cloud.baseUrl));

    const ready = await isAuthReady({ store, baseUrl: cloud.baseUrl });

    // Refresh was attempted but failed; ensureFreshToken swallows, state stays
    // expired, gate returns false (this is the "now you really must re-login" case).
    expect(ready).toBe(false);
    expect(cloud.tokenPosts).toBe(1);
  });
});
