import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type MockOAuthServer, startMockOAuthServer } from './mock-oauth-server.js';

describe('mock OAuth server fixture (smoke)', () => {
  let server: MockOAuthServer;

  beforeAll(async () => {
    server = await startMockOAuthServer();
  });
  afterAll(async () => {
    await server.shutdown();
  });

  it('serves discovery metadata at the well-known path', async () => {
    const res = await fetch(`${server.baseUrl}/.well-known/oauth-authorization-server`);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.token_endpoint).toBe(`${server.baseUrl}/oauth2/token`);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('serves JWKS at the well-known path', async () => {
    const res = await fetch(`${server.baseUrl}/.well-known/jwks.json`);
    const jwks = (await res.json()) as { keys: { kid: string }[] };
    expect(jwks.keys[0].kid).toBe('mock-oauth-key-1');
  });

  it('completes the full authcode + PKCE + token flow', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const authorize = await fetch(
      `${server.baseUrl}/authorize?response_type=code&client_id=orcaops-cli` +
        `&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback&scope=cli%3Afull+offline_access` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=st`,
      { redirect: 'manual' }
    );
    expect(authorize.status).toBe(302);
    const location = authorize.headers.get('location');
    expect(location).toContain('http://127.0.0.1:12345/callback');
    const code = new URL(location ?? '').searchParams.get('code');
    expect(code).not.toBeNull();

    const tokenResponse = await fetch(`${server.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        code_verifier: verifier,
        client_id: 'orcaops-cli',
        redirect_uri: 'http://127.0.0.1:12345/callback',
        resource: server.validResource,
      }).toString(),
    });
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toMatch(/^eyJ/);
    expect(tokens.refresh_token).toMatch(/^rt_/);
  });

  it('rejects /oauth2/token without resource parameter', async () => {
    const res = await fetch(`${server.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x' }).toString(),
    });
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_target');
  });

  it('rejects /oauth2/token with PKCE verifier mismatch', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = await fetch(
      `${server.baseUrl}/authorize?response_type=code&client_id=orcaops-cli` +
        `&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback&scope=cli%3Afull` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=st`,
      { redirect: 'manual' }
    );
    const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code');
    const res = await fetch(`${server.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        code_verifier: 'wrong-verifier',
        client_id: 'orcaops-cli',
        redirect_uri: 'http://127.0.0.1:12345/callback',
        resource: server.validResource,
      }).toString(),
    });
    const body = (await res.json()) as { error: string; error_description: string };
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toContain('PKCE');
  });

  it('refresh_token grant rotates the refresh token + revokes the prior', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = await fetch(
      `${server.baseUrl}/authorize?response_type=code&client_id=orcaops-cli` +
        `&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback&scope=cli%3Afull` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=st`,
      { redirect: 'manual' }
    );
    const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code');
    const initial = (await (
      await fetch(`${server.baseUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code ?? '',
          code_verifier: verifier,
          client_id: 'orcaops-cli',
          redirect_uri: 'http://127.0.0.1:12345/callback',
          resource: server.validResource,
        }).toString(),
      })
    ).json()) as { refresh_token: string };
    const rotated = await fetch(`${server.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: initial.refresh_token,
        client_id: 'orcaops-cli',
        resource: server.validResource,
      }).toString(),
    });
    const rotatedTokens = (await rotated.json()) as { refresh_token: string };
    expect(rotatedTokens.refresh_token).not.toBe(initial.refresh_token);
    expect(server.isRefreshTokenRevoked(initial.refresh_token)).toBe(true);
  });

  it('redirects with error=access_denied when nextConsent.accept = false', async () => {
    server.setNextConsent({ accept: false });
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const res = await fetch(
      `${server.baseUrl}/authorize?response_type=code&client_id=orcaops-cli` +
        `&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback&scope=cli%3Afull` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=st`,
      { redirect: 'manual' }
    );
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.searchParams.get('error')).toBe('access_denied');
    server.setNextConsent({ accept: true });
  });
});
