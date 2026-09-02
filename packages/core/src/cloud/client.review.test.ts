import { describe, expect, it } from 'vitest';

import { createOrcaCloudClient } from '@orcaops/sdk';

describe('vendored SDK carries the review namespace', () => {
  it('exposes status/pull/reply/resolve (stale-tarball tripwire)', () => {
    const client = createOrcaCloudClient({
      baseUrl: 'http://localhost:3001',
      cliVersion: '0.0.5-test',
    });
    expect(typeof client.review.status).toBe('function');
    expect(typeof client.review.pull).toBe('function');
    expect(typeof client.review.reply).toBe('function');
    expect(typeof client.review.resolve).toBe('function');
  });
});
