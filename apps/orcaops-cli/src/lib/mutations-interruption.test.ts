import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publicationFault = vi.hoisted(() => ({
  enabled: false,
  target: '',
}));
const directorySyncFault = vi.hoisted(() => ({
  directory: '',
  failAt: 0,
  calls: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const [target, flags] = args;
      if (
        flags !== 'r' ||
        directorySyncFault.failAt === 0 ||
        path.resolve(String(target)) !== directorySyncFault.directory
      ) {
        return handle;
      }
      return new Proxy(handle, {
        get(inner, property, receiver) {
          if (property === 'sync') {
            return async () => {
              directorySyncFault.calls += 1;
              if (directorySyncFault.calls === directorySyncFault.failAt) {
                const error = new Error(
                  'simulated directory sync failure'
                ) as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
              }
              return inner.sync();
            };
          }
          const value = Reflect.get(inner, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(inner) : value;
        },
      });
    },
    rename: async (source: string, target: string) => {
      if (
        publicationFault.enabled &&
        target === publicationFault.target &&
        source.endsWith('.stage')
      ) {
        throw new Error('simulated publication interruption');
      }
      return actual.rename(source, target);
    },
  };
});

import { executeMutations, writeMutation } from './mutations.js';

describe('mutation interruption convergence', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-mut-interruption-'));
    publicationFault.enabled = false;
    publicationFault.target = '';
    directorySyncFault.directory = '';
    directorySyncFault.failAt = 0;
    directorySyncFault.calls = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the complete old file visible when atomic replacement does not publish', async () => {
    const target = path.join(root, 'AGENTS.md');
    const before = 'user prose\nold managed block\n';
    const after = 'user prose\nnew managed block\n';
    await writeFile(target, before, 'utf8');

    publicationFault.target = await realpath(target);
    publicationFault.enabled = true;
    await expect(
      executeMutations([writeMutation(root, 'AGENTS.md', after, before, true)], 'apply')
    ).rejects.toThrow('simulated publication interruption');

    expect(await readFile(target, 'utf8')).toBe(before);
    expect((await readdir(root)).filter((entry) => entry.includes('.orcaops-mutation-'))).toEqual(
      []
    );

    publicationFault.enabled = false;
    await executeMutations([writeMutation(root, 'AGENTS.md', after, before, true)], 'apply');
    expect(await readFile(target, 'utf8')).toBe(after);
  });

  it('restores the old file when publication directory sync fails', async () => {
    const target = path.join(root, 'AGENTS.md');
    const before = 'old managed block\n';
    const after = 'new managed block\n';
    await writeFile(target, before, 'utf8');
    directorySyncFault.directory = await realpath(root);
    directorySyncFault.failAt = 2;

    await expect(
      executeMutations([writeMutation(root, 'AGENTS.md', after, before, true)], 'apply')
    ).rejects.toThrow('simulated directory sync failure');

    expect(await readFile(target, 'utf8')).toBe(before);
    expect((await readdir(root)).filter((entry) => entry.includes('.orcaops-mutation-'))).toEqual(
      []
    );
  });

  it('converges on retry from reachable replacement residue without trusting it', async () => {
    const target = path.join(root, 'AGENTS.md');
    const before = 'old managed block\n';
    const after = 'new managed block\n';
    const backup = path.join(root, '.AGENTS.md.orcaops-mutation-interrupted.backup');
    const stage = path.join(root, '.AGENTS.md.orcaops-mutation-interrupted.stage');
    await writeFile(target, before, 'utf8');
    await writeFile(backup, before, 'utf8');
    await writeFile(stage, after, 'utf8');

    await executeMutations([writeMutation(root, 'AGENTS.md', after, before, true)], 'apply');

    expect(await readFile(target, 'utf8')).toBe(after);
    expect(await readFile(backup, 'utf8')).toBe(before);
    expect(await readFile(stage, 'utf8')).toBe(after);
  });
});
