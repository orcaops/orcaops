import { describe, expect, it } from 'vitest';

import type { CredentialStore, StoredCredentials } from '@orcaops/sdk';

import { checkCloudAuth } from './doctor.js';

const URL = 'https://api.test';

function creds(over: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    v: 1,
    loginMethod: 'oauth',
    baseUrl: URL,
    userId: 'usr_1',
    orgId: 'org_1',
    orgName: null,
    orgSlug: null,
    email: 'e@test',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}

function fakeStore(opts: {
  kind?: CredentialStore['kind'];
  urls?: string[];
  read?: StoredCredentials | null;
}): CredentialStore & { knownBaseUrls(): string[] } {
  return {
    kind: opts.kind ?? 'file',
    knownBaseUrls: () => opts.urls ?? [],
    read: () => opts.read ?? null,
    write: () => {},
    clear: () => {},
  };
}

const expired = { expiresAt: Math.floor(Date.now() / 1000) - 600 };

describe('doctor cloud-auth check', () => {
  it('classifies expired + refresh token as warn but auto-recoverable', async () => {
    const check = await checkCloudAuth(
      fakeStore({ urls: [URL], read: creds({ ...expired, refreshToken: 'rt_valid' }) })
    );
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/auto-recoverable/);
    expect(check.details?.join(' ')).toMatch(/resync/);
    expect(check.details?.join(' ')).not.toMatch(/orcaops login/);
  });

  it('classifies expired with no refresh token as warn → re-login required', async () => {
    const check = await checkCloudAuth(
      fakeStore({ urls: [URL], read: creds({ ...expired, refreshToken: '' }) })
    );
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/re-login required/);
    expect(check.details?.join(' ')).toMatch(/orcaops login/);
  });

  it('passes when the token is still fresh', async () => {
    const check = await checkCloudAuth(fakeStore({ urls: [URL], read: creds() }));
    expect(check.status).toBe('pass');
    expect(check.summary).toMatch(/connected/);
  });

  it('passes without credentials for the official cloud', async () => {
    const check = await checkCloudAuth(fakeStore({ urls: [] }));
    expect(check.status).toBe('pass');
    expect(check.summary).toBe('not logged in to https://api.orcaops.ai (cloud sync inactive)');
  });
});
