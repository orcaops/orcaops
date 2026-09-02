import { describe, expect, it } from 'vitest';

import { assertSafeCloudUrl } from './url.js';

describe('assertSafeCloudUrl', () => {
  it('accepts https', () => {
    expect(assertSafeCloudUrl('https://api.orcaops.ai')).toBe('https://api.orcaops.ai');
  });

  it('accepts http loopback', () => {
    expect(assertSafeCloudUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
    expect(assertSafeCloudUrl('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it('accepts http IPv6 loopback', () => {
    expect(assertSafeCloudUrl('http://[::1]:3001')).toBe('http://[::1]:3001');
  });

  it('trims trailing slashes', () => {
    expect(assertSafeCloudUrl('https://api.orcaops.ai/')).toBe('https://api.orcaops.ai');
  });

  it('rejects http against a non-loopback host', () => {
    expect(() => assertSafeCloudUrl('http://attacker.example')).toThrow(/https/);
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => assertSafeCloudUrl('ftp://host')).toThrow();
  });
});
