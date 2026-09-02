import { Entry } from '@napi-rs/keyring';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type StoredCredentials } from '@orcaops/sdk';

import { KeyringStore, KeyringStoreError } from './keyring-store.js';

const sample = (over: Partial<StoredCredentials> = {}): StoredCredentials => ({
  v: 1,
  loginMethod: 'oauth',
  baseUrl: 'https://api.test',
  userId: 'usr_1',
  orgId: 'org_1',
  orgName: 'Acme',
  orgSlug: 'acme',
  email: 'jane@test',
  accessToken: 'eyJ.fake',
  refreshToken: 'rt_fake',
  expiresAt: 1700000000,
  ...over,
});

// Service-name suffix unique per test run keeps parallel CI runs and dev
// machines from clobbering each other's keychain entries. Cleaned up in
// afterEach.
const TEST_SERVICE = `orcaops-test-${randomUUID()}`;

// Module-time probe — describe.skipIf needs the value before describe runs.
const keyringAvailable = KeyringStore.isAvailable({ serviceName: TEST_SERVICE });

const writtenAccounts: string[] = [];
afterEach(() => {
  for (const account of writtenAccounts) {
    try {
      new Entry(TEST_SERVICE, account).deletePassword();
    } catch {
      // best-effort cleanup
    }
  }
  writtenAccounts.length = 0;
});

function track(account: string): string {
  writtenAccounts.push(account);
  return account;
}

describe.skipIf(!keyringAvailable)('KeyringStore (real OS keychain)', () => {
  it('round-trips a credential blob through the keychain', () => {
    const baseUrl = `https://round-trip-${randomUUID()}.test`;
    track(baseUrl);
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    const creds = sample({ baseUrl });
    store.write(baseUrl, creds);
    expect(store.read(baseUrl)).toEqual(creds);
  });

  it('returns null when the entry is absent', () => {
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    expect(store.read(`https://nope-${randomUUID()}.test`)).toBeNull();
  });

  it('overwrites an existing entry on second write', () => {
    const baseUrl = `https://overwrite-${randomUUID()}.test`;
    track(baseUrl);
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    store.write(baseUrl, sample({ baseUrl, accessToken: 'first' }));
    store.write(baseUrl, sample({ baseUrl, accessToken: 'second' }));
    expect(store.read(baseUrl)?.accessToken).toBe('second');
  });

  it('clear removes the entry', () => {
    const baseUrl = `https://clear-${randomUUID()}.test`;
    track(baseUrl);
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    store.write(baseUrl, sample({ baseUrl }));
    store.clear(baseUrl);
    expect(store.read(baseUrl)).toBeNull();
  });

  it('clear is idempotent when the entry is absent', () => {
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    expect(() => store.clear(`https://idempotent-${randomUUID()}.test`)).not.toThrow();
  });

  it('rejects writes whose credentials.baseUrl mismatches the key', () => {
    const baseUrl = `https://mismatch-${randomUUID()}.test`;
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    expect(() => store.write(baseUrl, sample({ baseUrl: 'https://other.test' }))).toThrow(
      KeyringStoreError
    );
  });

  it('rejects non-OAuth and unknown fields before writing', () => {
    const baseUrl = `https://strict-${randomUUID()}.test`;
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    expect(() => store.write(baseUrl, { ...sample({ baseUrl }), loginMethod: 'env' })).toThrow(
      KeyringStoreError
    );
    expect(() =>
      store.write(baseUrl, { ...sample({ baseUrl }), unexpected: true } as StoredCredentials)
    ).toThrow(KeyringStoreError);
  });

  it('rejects an entry whose account disagrees with its base URL', () => {
    const baseUrl = `https://account-${randomUUID()}.test`;
    track(baseUrl);
    new Entry(TEST_SERVICE, baseUrl).setPassword(
      JSON.stringify(sample({ baseUrl: 'https://other.test' }))
    );
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    expect(() => store.read(baseUrl)).toThrow(/contains credentials for/);
  });

  it('throws KeyringStoreError when an existing entry contains non-JSON', () => {
    const baseUrl = `https://corrupt-${randomUUID()}.test`;
    track(baseUrl);
    new Entry(TEST_SERVICE, baseUrl).setPassword('not json');
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    expect(() => store.read(baseUrl)).toThrow(/not valid JSON/);
  });

  it('throws KeyringStoreError on schema-invalid stored payload', () => {
    const baseUrl = `https://schema-${randomUUID()}.test`;
    track(baseUrl);
    new Entry(TEST_SERVICE, baseUrl).setPassword(JSON.stringify({ v: 1 }));
    const store = new KeyringStore({ serviceName: TEST_SERVICE });
    expect(() => store.read(baseUrl)).toThrow(/failed validation/);
  });
});

describe('KeyringStore.isAvailable', () => {
  it('returns a boolean (host-dependent value)', () => {
    expect(typeof KeyringStore.isAvailable({ serviceName: TEST_SERVICE })).toBe('boolean');
  });
});

describe('KeyringStore refresh locking', () => {
  it.skipIf(process.platform === 'win32')(
    'places the lock under the current user config home',
    async () => {
      const configDir = await mkdtemp(path.join(tmpdir(), 'orcaops-keyring-lock-'));
      vi.stubEnv('ORCAOPS_CONFIG_HOME', configDir);
      try {
        const baseUrl = 'https://api.test';
        const serviceKey = createHash('sha256').update(TEST_SERVICE).digest('hex').slice(0, 16);
        const urlKey = createHash('sha256').update(baseUrl).digest('hex').slice(0, 16);
        const lockDir = path.join(configDir, 'keyring-refresh-locks', serviceKey, urlKey);
        const store = new KeyringStore({ serviceName: TEST_SERVICE });

        await store.withRefreshLock(baseUrl, async () => {
          expect((await stat(lockDir)).mode & 0o077).toBe(0);
          const lockPath = path.join(lockDir, '.credentials.lock');
          expect((await stat(lockPath)).isDirectory()).toBe(true);
          const entries = await readdir(lockPath);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatch(/^owner\..+\.json$/);
          expect((await stat(path.join(lockPath, entries[0]))).mode & 0o777).toBe(0o600);
        });
      } finally {
        vi.unstubAllEnvs();
        await rm(configDir, { recursive: true, force: true });
      }
    }
  );
});
