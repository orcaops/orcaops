import { describe, expect, it } from 'vitest';

import { createCloudClient } from './client.js';

const emptyStore = { kind: 'file', read: () => null } as never;

describe('createCloudClient', () => {
  it('throws when baseUrl is omitted', async () => {
    // @ts-expect-error intentionally omitting required baseUrl
    await expect(createCloudClient({ store: emptyStore })).rejects.toThrow();
  });

  it('throws when store is omitted', async () => {
    // @ts-expect-error intentionally omitting required store
    await expect(createCloudClient({ baseUrl: 'https://api.orcaops.ai' })).rejects.toThrow();
  });

  it('throws NotConnectedError naming the baseUrl when the store has no creds', async () => {
    await expect(
      createCloudClient({ baseUrl: 'https://api.orcaops.ai', store: emptyStore })
    ).rejects.toThrow(/api\.orcaops\.ai/);
  });
});
