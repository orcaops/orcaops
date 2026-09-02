import { describe, expect, it } from 'vitest';

import { slugifyBranch, unslugifyBranch } from './branch-slug.js';

describe('slugifyBranch / unslugifyBranch', () => {
  it('round-trips simple names', () => {
    expect(unslugifyBranch(slugifyBranch('main'))).toBe('main');
  });

  it('round-trips names with slashes', () => {
    expect(unslugifyBranch(slugifyBranch('feat/rate-limit'))).toBe('feat/rate-limit');
  });

  it('round-trips names with percent characters', () => {
    expect(unslugifyBranch(slugifyBranch('weird%branch'))).toBe('weird%branch');
  });

  it('does not produce path separators in the slug', () => {
    expect(slugifyBranch('feat/rate-limit')).not.toContain('/');
  });
});
