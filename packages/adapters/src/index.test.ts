import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@orcaops/adapters', () => {
  it('exports its package name marker', () => {
    expect(PACKAGE_NAME).toBe('@orcaops/adapters');
  });
});
