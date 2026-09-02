import { describe, expect, it } from 'vitest';

import { parsePersistedOAuthCredentials } from './persisted-credentials.js';

const validCredentials = () => ({
  v: 1 as const,
  loginMethod: 'oauth' as const,
  baseUrl: 'https://api.test',
  userId: 'usr_1',
  orgId: '',
  orgName: null,
  orgSlug: null,
  email: '',
  accessToken: 'at_1',
  refreshToken: 'rt_1',
  expiresAt: 1_700_000_000,
});

describe('parsePersistedOAuthCredentials', () => {
  it('accepts an OAuth login without an organization or email', () => {
    expect(parsePersistedOAuthCredentials(validCredentials())).toEqual(validCredentials());
  });

  it('rejects unknown fields and environment credentials', () => {
    expect(() =>
      parsePersistedOAuthCredentials({ ...validCredentials(), unexpected: true })
    ).toThrow();
    expect(() =>
      parsePersistedOAuthCredentials({ ...validCredentials(), loginMethod: 'env' })
    ).toThrow();
  });

  it.each(['userId', 'accessToken', 'refreshToken'] as const)('rejects an empty %s', (field) => {
    expect(() => parsePersistedOAuthCredentials({ ...validCredentials(), [field]: '' })).toThrow();
  });
});
