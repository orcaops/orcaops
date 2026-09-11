import { describe, expect, it, vi } from 'vitest';

import type { StoredCredentials } from '@orcaops/sdk';

import { createCanonicalCredentialGuard } from './canonical-credentials.js';
const target = { server_url: 'https://cloud.example', org_id: 'org', account_id: 'account' };
const credentials = (): StoredCredentials => ({
  v: 1,
  loginMethod: 'oauth',
  baseUrl: target.server_url,
  userId: target.account_id,
  orgId: target.org_id,
  orgName: null,
  orgSlug: null,
  email: 'fixture@example.test',
  accessToken: 'original-token',
  refreshToken: 'original-refresh',
  expiresAt: 0,
});
function fixture() {
  let current: StoredCredentials | null = credentials();
  const source = {
    kind: 'file' as const,
    read: vi.fn(async () => current),
    write: vi.fn(async (_url: string, value: StoredCredentials) => {
      current = value;
    }),
    clear: vi.fn(async () => {
      current = null;
    }),
  };
  return {
    source,
    switchTo: (value: StoredCredentials) => {
      current = value;
    },
    guard: createCanonicalCredentialGuard(source, target.server_url),
  };
}
describe('qualified cloud credentials', () => {
  it('allows same-account refresh reads and writes after qualification', async () => {
    const f = fixture();
    const original = await f.guard.store.read(target.server_url);
    f.guard.bind(target, original!);
    const fresh = { ...original!, accessToken: 'fresh-token', refreshToken: 'fresh-refresh' };
    await f.guard.store.write(target.server_url, fresh);
    expect(await f.guard.store.read(target.server_url)).toEqual(fresh);
    expect(f.source.write).toHaveBeenCalledTimes(1);
  });
  it('does not restore credentials when logout completes during refresh', async () => {
    const f = fixture();
    const original = await f.guard.store.read(target.server_url);
    f.guard.bind(target, original!);
    await f.source.clear();
    await expect(
      f.guard.store.write(target.server_url, { ...original!, accessToken: 'refreshed-token' })
    ).rejects.toMatchObject({ code: 'CLOUD_TARGET_CHANGED' });
    expect(f.source.write).not.toHaveBeenCalled();
    expect(await f.guard.store.read(target.server_url)).toBeNull();
    await f.guard.store.clear(target.server_url);
    expect(f.source.clear).toHaveBeenCalledTimes(2);
  });
  it.each(['userId', 'orgId', 'baseUrl'] as const)(
    'refuses a mid-operation %s switch before sending or persisting refresh',
    async (key) => {
      const f = fixture();
      const original = await f.guard.store.read(target.server_url);
      f.guard.bind(target, original!);
      f.switchTo({
        ...original!,
        [key]: key === 'baseUrl' ? 'https://other.example' : 'different',
      });
      await expect(f.guard.store.read(target.server_url)).rejects.toMatchObject({
        code: 'CLOUD_TARGET_CHANGED',
      });
      await expect(
        f.guard.store.write(target.server_url, { ...original!, accessToken: 'refresh' })
      ).rejects.toMatchObject({ code: 'CLOUD_TARGET_CHANGED' });
      expect(f.source.write).not.toHaveBeenCalled();
    }
  );
  it('binds blank-ID environment auth to its original in-memory token without logging it', async () => {
    const f = fixture();
    const env = { ...credentials(), loginMethod: 'env' as const, orgId: '', userId: '' };
    f.switchTo(env);
    const original = await f.guard.store.read(target.server_url);
    f.guard.bind(target, original!);
    expect(await f.guard.store.read(target.server_url)).toEqual(env);
    f.switchTo({ ...env, accessToken: 'different-secret-token' });
    try {
      await f.guard.store.read(target.server_url);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('secret-token');
      expect(error).toMatchObject({ code: 'CLOUD_TARGET_CHANGED' });
    }
    expect(f.source.write).not.toHaveBeenCalled();
  });
});
