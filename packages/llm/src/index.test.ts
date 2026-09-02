import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@orcaops/llm', () => {
  it('exports its package name marker', () => {
    expect(PACKAGE_NAME).toBe('@orcaops/llm');
  });
});
