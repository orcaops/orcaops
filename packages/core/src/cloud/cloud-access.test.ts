import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { StoredCredentials } from '@orcaops/sdk';

import { hasCloudCredentials } from './cloud-access.js';

/** A config home holding a credentials file with the given raw contents. */
function configHomeWith(contents: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orcaops-cloud-access-'));
  if (contents !== null)
    writeFileSync(path.join(dir, 'credentials.json'), contents, { mode: 0o600 });
  return dir;
}

const credential = (baseUrl: string): StoredCredentials =>
  ({
    v: 1,
    loginMethod: 'oauth',
    baseUrl,
    userId: 'u1',
    orgId: 'o1',
    orgName: null,
    orgSlug: null,
    email: 'a@b.c',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 0,
  }) as StoredCredentials;

const storeFile = (...baseUrls: string[]): string =>
  JSON.stringify(Object.fromEntries(baseUrls.map((u) => [u, credential(u)])));

describe('hasCloudCredentials', () => {
  it('is false with no credentials file', () => {
    const env = { ORCAOPS_CONFIG_HOME: configHomeWith(null) };
    expect(hasCloudCredentials(env)).toBe(false);
  });

  it('is true with one stored cloud', () => {
    const env = { ORCAOPS_CONFIG_HOME: configHomeWith(storeFile('https://api.orcaops.ai')) };
    expect(hasCloudCredentials(env)).toBe(true);
  });

  it('is true with several stored clouds — a multi-cloud user is logged in', () => {
    const env = {
      ORCAOPS_CONFIG_HOME: configHomeWith(
        storeFile('https://api.orcaops.ai', 'https://staging.orcaops.ai')
      ),
    };
    expect(hasCloudCredentials(env)).toBe(true);
  });

  it('counts an expired session — the skill is what tells you to re-login', () => {
    const expired = JSON.parse(storeFile('https://api.orcaops.ai')) as Record<
      string,
      StoredCredentials
    >;
    expired['https://api.orcaops.ai'].expiresAt = 1;
    const env = { ORCAOPS_CONFIG_HOME: configHomeWith(JSON.stringify(expired)) };
    expect(hasCloudCredentials(env)).toBe(true);
  });

  it('is true for an env token', () => {
    const env = { ORCAOPS_CONFIG_HOME: configHomeWith(null), ORCAOPS_TOKEN: 'tok' };
    expect(hasCloudCredentials(env)).toBe(true);
  });

  it('ignores an empty env token', () => {
    const env = { ORCAOPS_CONFIG_HOME: configHomeWith(null), ORCAOPS_TOKEN: '' };
    expect(hasCloudCredentials(env)).toBe(false);
  });

  it('trusts the keyring opt-in without probing the keychain', () => {
    const env = {
      ORCAOPS_CONFIG_HOME: configHomeWith(null),
      ORCAOPS_CREDENTIAL_STORE: 'keyring',
    };
    expect(hasCloudCredentials(env)).toBe(true);
  });

  it('lets ORCAOPS_CLOUD_FEATURES force the answer both ways', () => {
    const withCreds = configHomeWith(storeFile('https://api.orcaops.ai'));
    expect(
      hasCloudCredentials({ ORCAOPS_CONFIG_HOME: withCreds, ORCAOPS_CLOUD_FEATURES: '0' })
    ).toBe(false);
    expect(
      hasCloudCredentials({
        ORCAOPS_CONFIG_HOME: configHomeWith(null),
        ORCAOPS_CLOUD_FEATURES: '1',
      })
    ).toBe(true);
  });

  it('returns false rather than throwing on a corrupt credentials file', () => {
    const env = { ORCAOPS_CONFIG_HOME: configHomeWith('{ not json') };
    expect(() => hasCloudCredentials(env)).not.toThrow();
    expect(hasCloudCredentials(env)).toBe(false);
  });

  it('counts a schema-invalid ENTRY as present — the user does have a session', () => {
    const env = { ORCAOPS_CONFIG_HOME: configHomeWith('{"https://a.example":{"v":99}}') };
    expect(hasCloudCredentials(env)).toBe(true);
  });

  it('is false for an empty credentials object', () => {
    expect(hasCloudCredentials({ ORCAOPS_CONFIG_HOME: configHomeWith('{}') })).toBe(false);
  });

  it('does not chmod the config dir — this gate must not mutate the filesystem', async () => {
    const { chmodSync, statSync, mkdirSync } = await import('node:fs');
    const dir = configHomeWith(storeFile('https://api.orcaops.ai'));
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    hasCloudCredentials({ ORCAOPS_CONFIG_HOME: dir });
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('reads the supplied env, not process.env', () => {
    const real = process.env.ORCAOPS_CONFIG_HOME;
    try {
      process.env.ORCAOPS_CONFIG_HOME = configHomeWith(storeFile('https://api.orcaops.ai'));
      expect(hasCloudCredentials({ ORCAOPS_CONFIG_HOME: configHomeWith(null) })).toBe(false);
    } finally {
      if (real === undefined) delete process.env.ORCAOPS_CONFIG_HOME;
      else process.env.ORCAOPS_CONFIG_HOME = real;
    }
  });
});
