import { describe, expect, it } from 'vitest';

import { nativeModuleHint } from './sqlite.js';

describe('nativeModuleHint', () => {
  it('names the blocked-script cause and the reinstall remediation', () => {
    const message = nativeModuleHint('Could not locate the bindings file.');
    expect(message).toContain('install script');
    expect(message).toContain('allow-scripts');
    expect(message).toContain('npm install -g --allow-scripts=better-sqlite3 @orcaops/cli');
    expect(message).toContain('Could not locate the bindings file.');
  });
});
