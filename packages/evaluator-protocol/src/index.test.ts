import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@orcaops/evaluator-protocol package smoke', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('@orcaops/evaluator-protocol');
  });
});
