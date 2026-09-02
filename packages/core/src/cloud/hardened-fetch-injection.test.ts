import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CredentialStore, StoredCredentials } from '@orcaops/sdk';

import { resetDefaultCliVersion, setDefaultCliVersion } from './cli-version.js';
import { OutboundPolicyError } from './hardened-fetch.js';

/**
 * Injection coverage, proved by BEHAVIOR: every SDK network entry point does
 * `options.fetch ?? fetch`, so a construction that omits the option — or
 * passes `undefined`, or passes the bare global — silently bypasses the
 * outbound policy. These tests capture what each production construction
 * actually hands the SDK and assert it enforces the origin pin.
 */

const captured: Array<{ site: string; fetch: unknown }> = [];

vi.mock('@orcaops/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/sdk')>();
  return {
    ...actual,
    createAuthedCloudClient: (opts: { fetch?: typeof fetch }) => {
      captured.push({ site: 'createAuthedCloudClient', fetch: opts.fetch });
      return {
        client: {},
        authState: () => Promise.resolve({ kind: 'connected' }),
        verifyToken: () => Promise.resolve(),
        ensureFreshToken: () => Promise.resolve(),
        logout: () =>
          Promise.resolve({
            remoteRevoked: true,
            remoteFailure: null,
            remoteError: null,
            localCleared: true,
            localClearReason: 'cleared' as const,
            localClearError: null,
            alreadyLoggedOut: false,
          }),
      };
    },
  };
});

const BASE = 'https://cloud.example';

function credentials(): StoredCredentials {
  return {
    v: 1,
    loginMethod: 'oauth',
    baseUrl: BASE,
    userId: 'u1',
    orgId: 'o1',
    orgName: null,
    orgSlug: null,
    email: 'u@example.test',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function storeWithCredentials(): CredentialStore {
  return { kind: 'file', read: () => credentials(), write: () => {}, clear: () => {} };
}

/**
 * A captured fetch must BE the policy wrapper, which takes two assertions.
 *
 * Refusing cross-origin is not enough on its own: a captured bare global
 * would also reject `attacker.example`, with a DNS `TypeError` rather than
 * a policy error, and it would miss a later-installed spy because the
 * reference predates it. So the refusal must be an OutboundPolicyError.
 * And an always-throwing stub would satisfy that if the error were the only
 * check, so a same-origin request must also DELEGATE to the real fetch.
 */
async function expectHardened(entry: { site: string; fetch: unknown }): Promise<void> {
  expect(entry.fetch, `${entry.site} passed no fetch`).toBeTypeOf('function');
  const captured = entry.fetch as typeof fetch;

  await expect(
    captured('https://attacker.example/steal'),
    `${entry.site} did not refuse a cross-origin request with a policy error`
  ).rejects.toThrow(OutboundPolicyError);

  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  try {
    await captured(`${BASE}/api/trpc/cli.ping`);
    expect(spy, `${entry.site} did not delegate a same-origin request`).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  } finally {
    spy.mockRestore();
  }
}

describe('hardened-fetch injection — core cloud constructions', () => {
  beforeEach(() => {
    captured.length = 0;
    setDefaultCliVersion('1.0.0-test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDefaultCliVersion();
  });

  it('createCloudClient hands the SDK a policy-enforcing fetch', async () => {
    const { createCloudClient } = await import('./client.js');
    await createCloudClient({ baseUrl: BASE, store: storeWithCredentials() });
    expect(captured).toHaveLength(1);
    await expectHardened(captured[0]);
  });

  it('isAuthReady hands the SDK a policy-enforcing fetch', async () => {
    const { isAuthReady } = await import('./client.js');
    await isAuthReady({ store: storeWithCredentials(), baseUrl: BASE });
    expect(captured).toHaveLength(1);
    await expectHardened(captured[0]);
  });
});
