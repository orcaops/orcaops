import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabaseSetupDirectory } from './directories.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, open: vi.fn(original.open) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open)
    .mockReset()
    .mockImplementation((await vi.importActual<typeof fs>('node:fs/promises')).open);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'database-setup-directories-'))
  );
  roots.push(directory);
  return directory;
}

describe('setup directory durability retry', () => {
  it.each(['history', 'retained/ancestor/history'])(
    'syncs retained ancestor entries when retrying %s after a parent failure',
    async (relative) => {
      const directory = await fixture();
      const root = path.join(directory, relative);
      const destination = path.join(root, 'projects', 'project');
      const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
      let fail = true;
      const synced: string[] = [];
      vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          synced.push(String(args[0]));
          if (String(args[0]) === directory && fail) {
            fail = false;
            throw new Error('Injected parent-directory sync failure');
          }
          return sync();
        });
        return handle;
      });
      await expect(createDatabaseSetupDirectory(root, destination)).rejects.toThrow(
        'Injected parent-directory sync failure'
      );
      const retained = await fs.lstat(root, { bigint: true });
      expect(retained.isDirectory()).toBe(true);
      synced.length = 0;
      await createDatabaseSetupDirectory(root, destination);
      const retried = await fs.lstat(root, { bigint: true });
      expect([retried.dev, retried.ino, retried.mode]).toEqual([
        retained.dev,
        retained.ino,
        retained.mode,
      ]);
      expect(synced).toContain(directory);
      expect(synced).toContain(root);
      expect(synced).toContain(path.dirname(destination));
      expect(await fs.readdir(path.dirname(destination))).toEqual(['project']);
    }
  );
  it('retains the sync failure and close diagnostic without leaking the directory handle', async () => {
    const directory = await fixture();
    const root = path.join(directory, 'history');
    const destination = path.join(root, 'projects');
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
    const syncFailure = new Error('Injected directory sync failure');
    const closeFailure = new Error('Injected directory close failure');
    let closed = false;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(syncFailure);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close();
        closed = true;
        throw closeFailure;
      });
      return handle;
    });
    const failure = await createDatabaseSetupDirectory(root, destination).catch(
      (cause: unknown) => cause
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([syncFailure, closeFailure]);
    expect(closed).toBe(true);
    await createDatabaseSetupDirectory(root, destination);
    expect((await fs.lstat(destination)).isDirectory()).toBe(true);
  });
  it('refuses cancellation before creation and preserves an occupied symlink', async () => {
    const directory = await fixture();
    const root = path.join(directory, 'history');
    await expect(
      createDatabaseSetupDirectory(root, path.join(root, 'projects'), AbortSignal.abort())
    ).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
    const target = path.join(directory, 'target');
    await fs.mkdir(target);
    await fs.symlink(target, root);
    await expect(createDatabaseSetupDirectory(root, path.join(root, 'projects'))).rejects.toThrow();
    expect((await fs.lstat(root)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(target)).toEqual([]);
  });
});
