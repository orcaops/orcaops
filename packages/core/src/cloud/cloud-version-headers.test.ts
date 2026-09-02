import { afterEach, describe, expect, it, vi } from 'vitest';

import { OSS_PROTOCOL_VERSION, OSS_VERSION_HEADERS } from '@orcaops/protocol';
import type { CredentialStore, StoredCredentials } from '@orcaops/sdk';

import { resetDefaultCliVersion, setDefaultCliVersion } from './cli-version.js';
import { createCloudClient } from './client.js';

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

const ME_ENVELOPE = JSON.stringify({
  result: {
    data: { json: { user: { id: 'u1', email: null, name: null }, organization: null } },
  },
});

/** Run `user.me` (a non-ping procedure) and capture the request headers. */
async function captureMeHeaders(cliVersion?: string): Promise<Record<string, string>> {
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(ME_ENVELOPE, { status: 200 }));
  const { client } = await createCloudClient({
    baseUrl: BASE,
    store: storeWithCredentials(),
    ...(cliVersion === undefined ? {} : { cliVersion }),
  });
  await client.user.me();
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
}

describe('cloud request version headers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetDefaultCliVersion();
  });

  it('refuses to construct a cloud client when no CLI version was configured', async () => {
    await expect(captureMeHeaders()).rejects.toThrow(/CLI version is required/);
  });

  it('sends both headers on a non-ping procedure once the bootstrap default is set', async () => {
    setDefaultCliVersion('9.9.9-test');
    const headers = await captureMeHeaders();
    expect(headers[OSS_VERSION_HEADERS.PROTOCOL_VERSION]).toBe(OSS_PROTOCOL_VERSION);
    expect(headers[OSS_VERSION_HEADERS.CLI_VERSION]).toBe('9.9.9-test');
  });

  it('prefers an explicit cliVersion option over the process-wide default', async () => {
    setDefaultCliVersion('9.9.9-test');
    const headers = await captureMeHeaders('1.2.3-explicit');
    expect(headers[OSS_VERSION_HEADERS.CLI_VERSION]).toBe('1.2.3-explicit');
  });
});
