import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@orcaops/storage', () => {
  it('exports its package name marker', () => {
    expect(PACKAGE_NAME).toBe('@orcaops/storage');
  });
});
