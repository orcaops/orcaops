import { describe, expect, it } from 'vitest';

import { canonicalRemoteTarget, RemoteTargetSchema } from './remote-target.js';

describe('remote target', () => {
  it('canonicalizes the server URL without changing account ownership', () => {
    expect(
      canonicalRemoteTarget({
        server_url: 'HTTPS://Cloud.Example.test:443/path/',
        org_id: 'org',
        account_id: 'account',
      })
    ).toEqual({
      server_url: 'https://cloud.example.test/path',
      org_id: 'org',
      account_id: 'account',
    });
  });

  it('refuses missing identity and unknown target fields', () => {
    expect(
      RemoteTargetSchema.safeParse({
        server_url: 'https://cloud.example',
        org_id: '',
        account_id: 'a',
      }).success
    ).toBe(false);
    expect(
      RemoteTargetSchema.safeParse({
        server_url: 'https://cloud.example',
        org_id: 'o',
        account_id: 'a',
        token: 'secret',
      }).success
    ).toBe(false);
  });
});
