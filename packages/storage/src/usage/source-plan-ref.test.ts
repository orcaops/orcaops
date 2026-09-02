import { describe, expect, it } from 'vitest';

import { canonicalRefIdFrom, canonicalSourcePlanRefId } from './source-plan-ref.js';

describe('canonicalSourcePlanRefId', () => {
  it('cloud → cloud:<externalId>, independent of version', () => {
    expect(
      canonicalSourcePlanRefId({
        source_ref: {
          kind: 'cloud',
          locator: 'ext1',
          version: '2',
          base_url: 'https://x',
          org_id: 'o',
        },
        hash: 'deadbeef',
      })
    ).toBe('cloud:ext1');
    expect(
      canonicalSourcePlanRefId({
        source_ref: {
          kind: 'cloud',
          locator: 'ext1',
          version: '9',
          base_url: 'https://x',
          org_id: 'o',
        },
        hash: 'deadbeef',
      })
    ).toBe('cloud:ext1');
  });

  it('local → local:<contentHash>, independent of path', () => {
    expect(
      canonicalSourcePlanRefId({
        source_ref: { kind: 'local', locator: './a/plan.md' },
        hash: 'abc123',
      })
    ).toBe('local:abc123');
    expect(
      canonicalSourcePlanRefId({
        source_ref: { kind: 'local', locator: './b/other.md' },
        hash: 'abc123',
      })
    ).toBe('local:abc123');
  });

  it('canonicalRefIdFrom mirrors the pin form', () => {
    expect(
      canonicalRefIdFrom(
        { kind: 'cloud', locator: 'ext1', version: '2', base_url: 'u', org_id: 'o' },
        'h'
      )
    ).toBe('cloud:ext1');
    expect(canonicalRefIdFrom({ kind: 'local', locator: 'p' }, 'h')).toBe('local:h');
  });
});
