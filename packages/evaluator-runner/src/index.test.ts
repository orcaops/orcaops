import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@orcaops/evaluator-runner package smoke', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('@orcaops/evaluator-runner');
  });
});
