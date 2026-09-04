import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveSidecar, sidecarMissingError } from './sidecarPath';

describe('resolveSidecar', () => {
  it('prefers the sidecar the launcher handed over when it exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'watch-sidecar-'));
    const handed = path.join(dir, 'watch-sidecar.js');
    writeFileSync(handed, '');
    expect(resolveSidecar({ ORCAOPS_WATCH_SIDECAR: handed })).toBe(handed);
  });

  it('ignores a handed-over path that does not exist and falls back to the build', () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'watch-sidecar-')), 'nope.js');
    expect(resolveSidecar({ ORCAOPS_WATCH_SIDECAR: missing })).toBe(resolveSidecar({}));
  });

  it('resolves the built sidecar beside src/ when nothing is handed over', () => {
    // vitest runs from source, so the dev candidate (src/data -> dist/) is the
    // one that answers, and only after `pnpm build` has produced it.
    const resolved = resolveSidecar({});
    expect(resolved === null || resolved.endsWith(path.join('dist', 'sidecar.js'))).toBe(true);
  });
});

describe('sidecarMissingError', () => {
  it('names every remediation — build from source, launch through the CLI, reinstall', () => {
    // The absent-sidecar state has three audiences; a message that only says
    // "reinstall" sends a source-runner down a forensic detour (there is no
    // sidecar-less fallback — both transports require dist/sidecar.js).
    const msg = sidecarMissingError().message;
    expect(msg).toContain('dist/sidecar.js');
    expect(msg).toContain('pnpm build');
    expect(msg).toContain('ORCAOPS_WATCH_SIDECAR');
    expect(msg).toContain('reinstall/upgrade');
  });
});
