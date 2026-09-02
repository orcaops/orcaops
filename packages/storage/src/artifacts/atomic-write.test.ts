import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWriteFile } from './atomic-write.js';

describe('atomicWriteFile (storage)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-storage-atomic-write-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips content and creates missing parent directories', async () => {
    const target = path.join(dir, 'nested', 'file.txt');
    await atomicWriteFile(target, 'hello');
    expect(await readFile(target, 'utf8')).toBe('hello');
  });

  it('leaves no temp sibling after a successful write', async () => {
    const target = path.join(dir, 'file.txt');
    await atomicWriteFile(target, 'done');
    const entries = await readdir(dir);
    expect(entries).toEqual(['file.txt']);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
  });

  it('cleans up the temp sibling when the write fails', async () => {
    // Point the target at an existing directory so the final rename fails
    // (EISDIR/ENOTEMPTY) after the temp file is already written.
    const target = path.join(dir, 'a-directory');
    await mkdir(target, { recursive: true });

    await expect(atomicWriteFile(target, 'data')).rejects.toThrow();

    const entries = await readdir(dir);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
    expect(entries).toContain('a-directory');
  });

  it('refuses a dangling symlink to an outside target before creating it', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-storage-atomic-outside-'));
    const outsideTarget = path.join(outside, 'future.txt');
    const target = path.join(dir, 'file.txt');
    await symlink(outsideTarget, target);
    try {
      await expect(atomicWriteFile(target, 'secret', dir)).rejects.toThrow(
        /must not contain symlinks/
      );
      await expect(access(outsideTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses an in-root symlink instead of overwriting its target', async () => {
    const realTarget = path.join(dir, 'repository-file.txt');
    const target = path.join(dir, 'projection.txt');
    await writeFile(realTarget, 'unchanged', 'utf8');
    await symlink(realTarget, target);

    await expect(atomicWriteFile(target, 'replacement', dir)).rejects.toThrow(
      /must not contain symlinks/
    );
    expect(await readFile(realTarget, 'utf8')).toBe('unchanged');
  });
});
