import { describe, expect, it } from 'vitest';

import { fallbackState } from './lifecycle-state.js';

describe('fallbackState', () => {
  it('maps complete storage rows to summarized lifecycle state', () => {
    expect(fallbackState('complete')).toBe('summarized');
  });

  it('maps active storage rows to active lifecycle state', () => {
    expect(fallbackState('active')).toBe('active');
  });
});
