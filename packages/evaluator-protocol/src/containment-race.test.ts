import { lstatSync as actualLstatSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let base: string | undefined;

afterEach(async () => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  if (base !== undefined) await rm(base, { recursive: true, force: true });
  base = undefined;
});

describe('resolveCanonicalPath filesystem races', () => {
  it('walks to the parent when a path disappears between inspection and realpath', async () => {
    base = await mkdtemp(path.join(tmpdir(), 'orcaops-containment-race-'));
    const target = path.join(base, 'disappeared');
    let targetInspections = 0;

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        lstatSync: ((candidate: Parameters<typeof actualLstatSync>[0]) => {
          if (path.resolve(String(candidate)) === target) {
            targetInspections += 1;
            if (targetInspections === 1) return actualLstatSync(base!);
          }
          return actualLstatSync(candidate);
        }) as typeof actualLstatSync,
      };
    });

    const { resolveCanonicalPath } = await import('./containment.js');

    expect(resolveCanonicalPath(target, 'race target')).toBe(
      path.join(await realpath(base), path.basename(target))
    );
    expect(targetInspections).toBe(2);
  });
});
