import { describe, expect, it } from 'vitest';

import { sidecarMissingError } from './sidecarPath';

describe('sidecarMissingError', () => {
  it('names BOTH remediations — build from source and reinstall a release', () => {
    // The absent-sidecar state has two audiences; a message that only says
    // "reinstall" sends a source-runner down a forensic detour (there is no
    // sidecar-less fallback — both transports require dist/sidecar.js).
    const msg = sidecarMissingError().message;
    expect(msg).toContain('dist/sidecar.js');
    expect(msg).toContain('pnpm build');
    expect(msg).toContain('reinstall/upgrade');
  });
});
