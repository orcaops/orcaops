import { describe, expect, it } from 'vitest';

import { canonicalizeBaseUrl } from './canonical-base-url.js';

describe('canonicalizeBaseUrl', () => {
  it('normalizes trailing slash, case, and default port', () => {
    const c = canonicalizeBaseUrl('https://cloud.example');
    expect(canonicalizeBaseUrl('https://cloud.example/')).toBe(c);
    expect(canonicalizeBaseUrl('https://Cloud.Example')).toBe(c);
    expect(canonicalizeBaseUrl('https://cloud.example:443/')).toBe(c);
    expect(canonicalizeBaseUrl('https://other.example')).not.toBe(c);
  });

  it('keeps a non-default port and a non-empty path (but strips trailing slashes)', () => {
    expect(canonicalizeBaseUrl('https://cloud.example:8443')).not.toBe(
      canonicalizeBaseUrl('https://cloud.example')
    );
    expect(canonicalizeBaseUrl('https://cloud.example/staging/')).toBe(
      canonicalizeBaseUrl('https://cloud.example/staging')
    );
  });

  it('lowercases its trimmed, trailing-slash-stripped fallback for an unparseable input', () => {
    expect(canonicalizeBaseUrl('  Not A URL//  ')).toBe('not a url');
    // Case-variants of an unparseable base_url canonicalize equal (key-only output).
    expect(canonicalizeBaseUrl('FOO BAR')).toBe(canonicalizeBaseUrl('foo bar'));
  });
});
