import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileStore } from '@orcaops/core';

import { staleKeyringHint, whoamiAction } from './whoami.js';

describe('staleKeyringHint', () => {
  it('points an expired keyring session at the default file store', () => {
    expect(
      staleKeyringHint('keyring', {
        kind: 'expired',
        reason: 'access_token_expired',
        userId: 'usr_hint',
        orgId: 'org_hint',
      })
    ).toContain('unset ORCAOPS_CREDENTIAL_STORE');
  });

  it('does not infer a hidden keyring login from an empty file store', () => {
    expect(
      staleKeyringHint('file', { kind: 'not_connected', reason: 'no_credentials' })
    ).toBeNull();
  });
});

describe('orcaops whoami', () => {
  let dir: string;
  let store: FileStore;
  let originalExit: typeof process.exit;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitCalled: number | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-whoami-e2e-'));
    store = new FileStore({ dir });
    exitCalled = null;
    originalExit = process.exit;
    Object.defineProperty(process, 'exit', {
      value: ((code?: number) => {
        exitCalled = code ?? 0;
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never,
      configurable: true,
      writable: true,
    });
    vi.spyOn(await import('@orcaops/core'), 'resolveCredentialStore').mockReturnValue(store);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    Object.defineProperty(process, 'exit', {
      value: originalExit,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it('prints "Not logged in" when the store is empty', async () => {
    await whoamiAction({ baseUrl: 'https://api.test' });
    const out = stdoutSpy.mock.calls.flat().join('');
    expect(out).toContain('Not logged in to https://api.test');
  });

  it('prints user/org/expiry on a fresh credential blob', async () => {
    store.write('https://api.test', {
      v: 1,
      loginMethod: 'oauth',
      baseUrl: 'https://api.test',
      userId: 'usr_who',
      orgId: 'org_who',
      orgName: 'Whoami Org',
      orgSlug: 'whoami-org',
      email: 'who@test',
      accessToken: 'eyJ.fake',
      refreshToken: 'rt_who',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await whoamiAction({ baseUrl: 'https://api.test' });
    const out = stdoutSpy.mock.calls.flat().join('');
    expect(out).toContain('who@test');
    expect(out).toContain('Whoami Org (org_who) [whoami-org]');
    expect(out).toMatch(/expires in (59|60) min/);
  });

  it('reports session-expired when expiry is past skew', async () => {
    store.write('https://api.test', {
      v: 1,
      loginMethod: 'oauth',
      baseUrl: 'https://api.test',
      userId: 'usr_old',
      orgId: 'org_old',
      orgName: 'Old',
      orgSlug: null,
      email: 'old@test',
      accessToken: 'eyJ.fake',
      refreshToken: 'rt_old',
      expiresAt: Math.floor(Date.now() / 1000) - 600,
    });
    await whoamiAction({ baseUrl: 'https://api.test' });
    const out = stdoutSpy.mock.calls.flat().join('');
    expect(out).toContain('Session expired');
    expect(out).toContain('access_token_expired');
  });

  it('targets production and reports not-connected with an empty store', async () => {
    await whoamiAction({});
    const out = stdoutSpy.mock.calls.flat().join('');
    expect(out).toContain('https://api.orcaops.ai');
    expect(out).toMatch(/not logged in/i);
    expect(exitCalled).toBeNull();
  });

  it('JSON output emits the AuthState verbatim', async () => {
    store.write('https://api.test', {
      v: 1,
      loginMethod: 'oauth',
      baseUrl: 'https://api.test',
      userId: 'usr_j',
      orgId: 'org_j',
      orgName: null,
      orgSlug: null,
      email: 'j@test',
      accessToken: 'eyJ.fake',
      refreshToken: 'rt_j',
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
    });
    await whoamiAction({ baseUrl: 'https://api.test', json: true });
    const out = stdoutSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(out) as {
      ok: boolean;
      state: { kind: string; userId: string };
      verified: boolean | null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.state.kind).toBe('connected');
    expect(parsed.state.userId).toBe('usr_j');
    expect(parsed.verified).toBeNull();
  });

  it('reports verification as null when no connected session can be probed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await whoamiAction({ baseUrl: 'https://api.test', verify: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.flat().join('')) as {
      verified: boolean | null;
    };
    expect(parsed.verified).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('--verify probes user.me (read-only, no audit-log noise)', () => {
    beforeEach(() => {
      // Connected baseline state for every verify test.
      store.write('https://api.test', {
        v: 1,
        loginMethod: 'oauth',
        baseUrl: 'https://api.test',
        userId: 'usr_v',
        orgId: 'org_v',
        orgName: 'V',
        orgSlug: 'v',
        email: 'v@test',
        accessToken: 'eyJ.verify.token',
        refreshToken: 'rt_v',
        expiresAt: Math.floor(Date.now() / 1000) + 1800,
      });
    });

    it('hits /api/trpc/user.me with Bearer auth and reports server-recognized on 200', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            result: {
              data: {
                json: {
                  user: { id: 'usr_v', email: 'v@test', name: 'V' },
                  organization: { id: 'org_v', slug: 'v', name: 'V' },
                },
              },
            },
          }),
          { status: 200 }
        )
      );
      await whoamiAction({ baseUrl: 'https://api.test', verify: true });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://api.test/api/trpc/user.me');
      expect((init as RequestInit | undefined)?.method).toBe('GET');
      const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer eyJ.verify.token');

      const out = stdoutSpy.mock.calls.flat().join('');
      expect(out).toContain('Verified: server recognizes token');
    });

    it('reports verification as true only when the server recognizes the token', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            result: {
              data: {
                json: {
                  user: { id: 'usr_v', email: 'v@test', name: 'V' },
                  organization: { id: 'org_v', slug: 'v', name: 'V' },
                },
              },
            },
          }),
          { status: 200 }
        )
      );

      await whoamiAction({ baseUrl: 'https://api.test', verify: true, json: true });

      const parsed = JSON.parse(stdoutSpy.mock.calls.flat().join('')) as {
        verified: boolean | null;
      };
      expect(parsed.verified).toBe(true);
    });

    it('reports rejection on 401 (UNAUTHORIZED)', async () => {
      // The SDK maps a 401 to CliAuthError only from a parseable tRPC error
      // envelope — an empty body would surface as an inconclusive wire error.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              json: { message: 'Unauthorized', data: { code: 'UNAUTHORIZED', httpStatus: 401 } },
            },
          }),
          { status: 401 }
        )
      );
      await whoamiAction({ baseUrl: 'https://api.test', verify: true });
      const out = stdoutSpy.mock.calls.flat().join('');
      expect(out).toContain('Verified: server REJECTED the token');
    });

    it('reports rejection on 403 (FORBIDDEN)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { json: { message: 'Forbidden', data: { code: 'FORBIDDEN', httpStatus: 403 } } },
          }),
          { status: 403 }
        )
      );
      await whoamiAction({ baseUrl: 'https://api.test', verify: true });
      const out = stdoutSpy.mock.calls.flat().join('');
      expect(out).toContain('Verified: server REJECTED the token');
    });

    it('reports verification as false for an explicit rejection', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              json: { message: 'Unauthorized', data: { code: 'UNAUTHORIZED', httpStatus: 401 } },
            },
          }),
          { status: 401 }
        )
      );

      await whoamiAction({ baseUrl: 'https://api.test', verify: true, json: true });

      const parsed = JSON.parse(stdoutSpy.mock.calls.flat().join('')) as {
        verified: boolean | null;
      };
      expect(parsed.verified).toBe(false);
    });

    it('reports verification as null when the probe is inconclusive', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unavailable'));

      await whoamiAction({ baseUrl: 'https://api.test', verify: true, json: true });

      const parsed = JSON.parse(stdoutSpy.mock.calls.flat().join('')) as {
        verified: boolean | null;
      };
      expect(parsed.verified).toBeNull();
    });

    it('does NOT call /api/trpc/captureThread.update during whoami', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ result: { data: { json: {} } } }), { status: 200 })
        );
      await whoamiAction({ baseUrl: 'https://api.test', verify: true });

      // No call site should target the captureThread.update probe path.
      for (const [url] of fetchMock.mock.calls) {
        expect(String(url)).not.toContain('captureThread.update');
        expect(String(url)).not.toContain('__whoami-verify');
      }
    });
  });
});
