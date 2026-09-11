import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialStore, StoredCredentials } from '@orcaops/sdk';

import { createCanonicalCloudClient } from './canonical-client.js';
import * as clientModule from './client.js';
import { ORCAOPS_CAPABILITIES } from './handshake.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const target = { server_url: 'https://cloud.example', org_id: 'org', account_id: 'account' };
  let current: StoredCredentials | null = {
    v: 1,
    loginMethod: 'oauth',
    baseUrl: target.server_url,
    userId: target.account_id,
    orgId: target.org_id,
    orgName: null,
    orgSlug: null,
    email: 'fixture@example.test',
    accessToken: 'fixture-token',
    refreshToken: 'fixture-refresh',
    expiresAt: 0,
  };
  const store: CredentialStore = {
    kind: 'file',
    read: async () => current,
    write: async (_url, value) => {
      current = value;
    },
    clear: async () => {
      current = null;
    },
  };
  const ping = vi.fn(async () => ({
    ok: true,
    orgId: target.org_id,
    userId: target.account_id,
    handshake: {
      server_version: '1.4.0',
      protocol_version: '0.0.26',
      min_cli_version: '0.0.0',
      min_protocol_version: '0.0.0',
      capabilities: Object.values(ORCAOPS_CAPABILITIES),
    },
  }));
  let guarded: CredentialStore | null = null;
  vi.spyOn(clientModule, 'createCloudClient').mockImplementation(async (options) => {
    guarded = options.store;
    return {
      client: { cli: { ping } } as never,
      credentials: (await options.store.read(options.baseUrl))!,
    };
  });
  return {
    target,
    store,
    ping,
    guarded: () => guarded!,
    options: {
      baseUrl: target.server_url,
      store,
      target: { ...target },
      requires: [],
      operation: 'source-plan review',
      cliVersion: '0.2.0-rc.2',
    },
  };
}

describe('qualified canonical cloud client', () => {
  it('returns a handshake-qualified immutable target and a bound credential store', async () => {
    const f = fixture();
    const connected = await createCanonicalCloudClient(f.options);
    expect(connected.target).toEqual(f.target);
    expect(Object.isFrozen(connected.target)).toBe(true);
    const original = (await f.store.read(f.target.server_url))!;
    await connected.credentialStore.write(f.target.server_url, {
      ...original,
      accessToken: 'renewed-token',
    });
    expect((await connected.credentialStore.read(f.target.server_url))?.accessToken).toBe(
      'renewed-token'
    );
    await f.store.write(f.target.server_url, { ...original, userId: 'different-account' });
    await expect(connected.credentialStore.read(f.target.server_url)).rejects.toMatchObject({
      code: 'CLOUD_TARGET_CHANGED',
    });
    expect(f.ping).toHaveBeenCalledTimes(1);
  });

  it('evaluates target-dependent capabilities from the authenticated ping without another call', async () => {
    const f = fixture();
    const requires = vi.fn(() => [ORCAOPS_CAPABILITIES.SOURCE_PLAN_OWNER_REF]);
    await createCanonicalCloudClient({ ...f.options, requires });

    expect(requires).toHaveBeenCalledWith(f.target);
    expect(f.ping).toHaveBeenCalledOnce();
  });

  it('refuses a handshake for a different selected account', async () => {
    const f = fixture();
    f.options.target.account_id = 'other-account';
    await expect(createCanonicalCloudClient(f.options)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('allows the original account to refresh during qualification', async () => {
    const f = fixture();
    const originalPing = f.ping.getMockImplementation()!;
    f.ping.mockImplementationOnce(async () => {
      const original = (await f.guarded().read(f.target.server_url))!;
      await f
        .guarded()
        .write(f.target.server_url, { ...original, accessToken: 'handshake-refresh' });
      return originalPing();
    });
    const connected = await createCanonicalCloudClient(f.options);
    expect((await connected.credentialStore.read(f.target.server_url))?.accessToken).toBe(
      'handshake-refresh'
    );
  });

  it.each(['logout', 'org switch'])('refuses %s occurring during the handshake', async (change) => {
    const f = fixture();
    const originalPing = f.ping.getMockImplementation()!;
    f.ping.mockImplementationOnce(async () => {
      const original = (await f.store.read(f.target.server_url))!;
      if (change === 'logout') await f.store.clear(f.target.server_url);
      else await f.store.write(f.target.server_url, { ...original, orgId: 'other-org' });
      return originalPing();
    });
    await expect(createCanonicalCloudClient(f.options)).rejects.toMatchObject({
      code: 'CLOUD_TARGET_CHANGED',
    });
  });

  it('freezes selected input before awaiting the handshake', async () => {
    const f = fixture();
    const originalPing = f.ping.getMockImplementation()!;
    f.ping.mockImplementationOnce(async () => {
      f.options.target.account_id = 'changed-after-start';
      f.options.baseUrl = 'https://other.example';
      return originalPing();
    });
    expect((await createCanonicalCloudClient(f.options)).target).toEqual(f.target);
  });

  it.each(['logout', 'org switch'])(
    'does not overwrite %s with a handshake refresh',
    async (change) => {
      const f = fixture();
      const originalPing = f.ping.getMockImplementation()!;
      f.ping.mockImplementationOnce(async () => {
        const original = (await f.store.read(f.target.server_url))!;
        if (change === 'logout') await f.store.clear(f.target.server_url);
        else await f.store.write(f.target.server_url, { ...original, orgId: 'other-org' });
        await f
          .guarded()
          .write(f.target.server_url, { ...original, accessToken: 'handshake-refresh' });
        return originalPing();
      });
      await expect(createCanonicalCloudClient(f.options)).rejects.toMatchObject({
        code: 'CLOUD_TARGET_CHANGED',
      });
      const after = await f.store.read(f.target.server_url);
      if (change === 'logout') expect(after).toBeNull();
      else expect(after?.orgId).toBe('other-org');
    }
  );
});
