import { afterEach, describe, expect, it, vi } from 'vitest';

import { EnvStore } from './env-store.js';
import { FileStore } from './file-store.js';
import { KeyringStore } from './keyring-store.js';
import { resolveCredentialStore } from './store.js';

describe('resolveCredentialStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns EnvStore when ORCAOPS_TOKEN is set', () => {
    vi.stubEnv('ORCAOPS_TOKEN', 'tok_xyz');
    expect(resolveCredentialStore()).toBeInstanceOf(EnvStore);
  });

  it('defaults to FileStore even when the keychain is reachable', () => {
    vi.stubEnv('ORCAOPS_TOKEN', '');
    vi.stubEnv('ORCAOPS_CREDENTIAL_STORE', '');
    vi.spyOn(KeyringStore, 'isAvailable').mockReturnValue(true);
    expect(resolveCredentialStore()).toBeInstanceOf(FileStore);
  });

  it('returns KeyringStore only when ORCAOPS_CREDENTIAL_STORE=keyring AND reachable', () => {
    vi.stubEnv('ORCAOPS_TOKEN', '');
    vi.stubEnv('ORCAOPS_CREDENTIAL_STORE', 'keyring');
    vi.spyOn(KeyringStore, 'isAvailable').mockReturnValue(true);
    expect(resolveCredentialStore()).toBeInstanceOf(KeyringStore);
  });

  it('falls back to FileStore when keyring opted-in but unreachable', () => {
    vi.stubEnv('ORCAOPS_TOKEN', '');
    vi.stubEnv('ORCAOPS_CREDENTIAL_STORE', 'keyring');
    vi.spyOn(KeyringStore, 'isAvailable').mockReturnValue(false);
    expect(resolveCredentialStore()).toBeInstanceOf(FileStore);
  });

  it('treats empty-string ORCAOPS_TOKEN as unset (does NOT pick EnvStore)', () => {
    vi.stubEnv('ORCAOPS_TOKEN', '');
    vi.spyOn(KeyringStore, 'isAvailable').mockReturnValue(true);
    expect(resolveCredentialStore()).not.toBeInstanceOf(EnvStore);
  });
});

describe('EnvStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when ORCAOPS_TOKEN is unset', () => {
    vi.stubEnv('ORCAOPS_TOKEN', '');
    expect(new EnvStore().read('https://api.test')).toBeNull();
  });

  it('synthesizes StoredCredentials from a plain (non-JWT) token', () => {
    vi.stubEnv('ORCAOPS_TOKEN', 'opaque-token');
    const creds = new EnvStore().read('https://api.test');
    expect(creds).not.toBeNull();
    expect(creds?.accessToken).toBe('opaque-token');
    expect(creds?.refreshToken).toBe('');
    expect(creds?.userId).toBe('');
    expect(creds?.orgId).toBe('');
    expect(creds?.loginMethod).toBe('env');
  });

  it('decodes a JWT and populates user/org metadata from claims', () => {
    const header = btoa('{"alg":"none"}')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const payload = btoa(
      JSON.stringify({
        sub: 'usr_env_1',
        reference_id: 'org_env_1',
        email: 'env@test',
        org_name: 'EnvOrg',
        org_slug: 'env-org',
      })
    )
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    vi.stubEnv('ORCAOPS_TOKEN', `${header}.${payload}.signature`);
    const creds = new EnvStore().read('https://api.test');
    expect(creds?.userId).toBe('usr_env_1');
    expect(creds?.orgId).toBe('org_env_1');
    expect(creds?.email).toBe('env@test');
    expect(creds?.orgName).toBe('EnvOrg');
    expect(creds?.orgSlug).toBe('env-org');
  });

  it('write() throws — env-mode is read-only', () => {
    const store = new EnvStore();
    expect(() => store.write()).toThrow(/read-only/);
  });

  it('clear() throws — env-mode is read-only', () => {
    const store = new EnvStore();
    expect(() => store.clear()).toThrow(/read-only/);
  });

  it('reports kind = env (so getAuthState takes the cloud-managed-expiry branch)', () => {
    expect(new EnvStore().kind).toBe('env');
  });
});
