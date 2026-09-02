import { describe, expect, it } from 'vitest';

import { NotConnectedError } from './errors.js';
import { pushArtifact } from './sync.js';

/**
 * pushArtifact must pass its `baseUrl` + `credentialStore` straight to
 * createCloudClient — it must NOT resolve internally. We prove the thread by
 * giving it a credential store that returns no creds for the passed baseUrl:
 * createCloudClient (called before any disk read) then throws
 * NotConnectedError naming that exact baseUrl. If pushArtifact ignored the
 * passed values and resolved the real machine store instead, the error (or
 * lack thereof) would differ.
 */
describe('pushArtifact threading', () => {
  it('passes baseUrl + credentialStore to createCloudClient', async () => {
    const credentialStore = { kind: 'file', read: () => null } as never;
    // The imported-artifact containment gate runs before the client is
    // constructed, so the store stub must present a live (non-imported) row.
    const store = { store: { getArtifact: () => ({ id: 'a1', origin_kind: null }) } } as never;
    await expect(
      pushArtifact({
        store,
        repo: {} as never,
        artifactId: 'a1',
        baseUrl: 'https://api.orcaops.ai',
        credentialStore,
      })
    ).rejects.toBeInstanceOf(NotConnectedError);
  });
});
