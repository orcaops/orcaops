import { describe, expect, it } from 'vitest';

import { nativeModuleHint } from './sqlite.js';

describe('nativeModuleHint', () => {
  it('names the reinstall remediation and carries the cause', () => {
    const message = nativeModuleHint('Could not locate the bindings file.');
    expect(message).toContain('npm install -g @orcaops/cli');
    expect(message).toContain('Could not locate the bindings file.');
  });

  // The CLI bounds an unauthored error's message at 200 characters. The remedy
  // must survive that cut, and enough of the cause with it to be diagnostic —
  // an earlier wording spent 193 of the 200 on prose and showed none of it.
  it('fits the remedy and a usable slice of the cause inside 200 characters', () => {
    const visible = nativeModuleHint('E'.repeat(500)).slice(0, 200);
    expect(visible).toContain('npm install -g @orcaops/cli');
    expect(visible.match(/E+/)?.[0].length ?? 0).toBeGreaterThan(80);
  });

  it('no longer blames a blocked install script, which 13.x cannot have', () => {
    const message = nativeModuleHint('boom');
    expect(message).not.toContain('allow-scripts');
    expect(message).not.toContain('install script');
  });
});
