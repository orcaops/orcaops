import { describe, expect, it } from 'vitest';

import { baseVersionOf, distTagFor, isPrerelease } from './release-channel.mjs';

describe('release channel', () => {
  it('sends release candidates to a tag nobody installs by default', () => {
    for (const version of ['0.2.0-rc.1', '1.0.0-beta.3', '0.1.1-next.0']) {
      expect(isPrerelease(version), version).toBe(true);
      expect(distTagFor(version), version).toBe('next');
    }
  });

  it('sends stable versions to latest', () => {
    for (const version of ['0.1.0', '1.2.3', '10.0.0']) {
      expect(isPrerelease(version), version).toBe(false);
      expect(distTagFor(version), version).toBe('latest');
    }
  });

  it('resolves the base version a candidate is heading toward', () => {
    expect(baseVersionOf('0.2.0-rc.1')).toBe('0.2.0');
    expect(baseVersionOf('0.2.0')).toBe('0.2.0');
  });

  it('refuses a version it cannot parse rather than guessing a channel', () => {
    expect(() => baseVersionOf('not-a-version')).toThrow(/unparseable/);
  });
});
