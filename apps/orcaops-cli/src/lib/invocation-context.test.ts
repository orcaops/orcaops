import { describe, expect, it } from 'vitest';

import { isCi } from './invocation-context.js';

describe('isCi (truthy CI gate, not bare presence)', () => {
  it('is false for unset / empty / explicitly-falsy values', () => {
    for (const v of [undefined, '', '   ', 'false', 'FALSE', '0', 'no', 'off', 'Off']) {
      expect(isCi(v), `expected isCi(${JSON.stringify(v)}) === false`).toBe(false);
    }
  });

  it('is true for the values CI systems actually set', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', 'github-actions']) {
      expect(isCi(v), `expected isCi(${JSON.stringify(v)}) === true`).toBe(true);
    }
  });
});
