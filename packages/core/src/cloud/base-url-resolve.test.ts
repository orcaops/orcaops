import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL, resolveCloudTarget } from './client.js';
import { EnvStore } from '../credentials/env-store.js';

const DEV = 'http://localhost:3001';

describe('resolveCloudTarget', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses an explicit injected target', () => {
    expect(resolveCloudTarget(DEV)).toBe(DEV);
  });

  it('uses the official cloud without an injected target', () => {
    expect(resolveCloudTarget()).toBe(DEFAULT_CLOUD_BASE_URL);
  });

  it('binds an environment token to the official target by default', () => {
    vi.stubEnv('ORCAOPS_TOKEN', 'opaque-token');
    expect(new EnvStore().read(resolveCloudTarget())).toMatchObject({
      baseUrl: DEFAULT_CLOUD_BASE_URL,
      accessToken: 'opaque-token',
    });
  });

  it('rejects an unsafe injected URL', () => {
    expect(() => resolveCloudTarget('http://attacker.example')).toThrow(/https/);
  });
});
