import { describe, expect, it } from 'vitest';

import { GitOidSchema, ManagedGitRefSchema } from './git-ref-schema.js';

describe('managed Git references', () => {
  it.each([
    'refs/orcaops/snapshots/main',
    'refs/orcaops/reviews/019fc100-0000-7000-8000-00000000aaa1',
  ])('accepts %s', (value) => {
    expect(ManagedGitRefSchema.parse(value)).toBe(value);
  });

  it.each([
    'refs/heads/main',
    'refs/orcaops/',
    'refs/orcaops/.hidden',
    'refs/orcaops/name.lock',
    'refs/orcaops/a..b',
    'refs/orcaops/a@{b',
    'refs/orcaops/a b',
  ])('refuses %s', (value) => {
    expect(ManagedGitRefSchema.safeParse(value).success).toBe(false);
  });

  it('accepts nonzero SHA-1 and SHA-256 object IDs', () => {
    expect(GitOidSchema.parse('a'.repeat(40))).toBe('a'.repeat(40));
    expect(GitOidSchema.parse('b'.repeat(64))).toBe('b'.repeat(64));
    expect(GitOidSchema.safeParse('0'.repeat(40)).success).toBe(false);
    expect(GitOidSchema.safeParse('a'.repeat(39)).success).toBe(false);
  });
});
