import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { inspectDatabaseFilesystem, parseDarwinMounts } from './filesystem.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, statfs: vi.fn(original.statfs), stat: vi.fn(original.stat) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('supported database filesystem evidence', () => {
  it('parses mountpoints with spaces and retains filesystem type and locality', () => {
    expect(
      parseDarwinMounts(
        '/dev/disk3s1 on /Volumes/local data (apfs, local, journaled)\nserver:/share on /Volumes/remote data (nfs, nosuid)\n'
      )
    ).toEqual([
      { mountpoint: '/Volumes/local data', type: 'apfs', local: true },
      { mountpoint: '/Volumes/remote data', type: 'nfs', local: false },
    ]);
  });
  it.each([
    'malformed',
    '/dev/disk on /Volumes/ambiguous on /other (apfs, local)',
    '/dev/disk on relative (apfs, local)',
    '/dev/disk on /Volumes/../other (apfs, local)',
  ])('refuses ambiguous mount output %s', (text) => {
    expect(() => parseDarwinMounts(text)).toThrow();
  });
  it('establishes this actual supported fixture filesystem without creating its requested child', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'database-filesystem-'));
    roots.push(root);
    await inspectDatabaseFilesystem(path.join(root, 'absent', 'data'));
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('honors cancellation before storage observation', async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = vi.spyOn(fs, 'statfs').mockClear();
    await expect(inspectDatabaseFilesystem('/missing', controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(spy).not.toHaveBeenCalled();
  });
  it('reports an uninspectable mount as unavailable, without a missing-history inference', async () => {
    if (process.platform !== 'darwin') return;
    const root = await fs.mkdtemp(path.join(tmpdir(), 'database-filesystem-'));
    roots.push(root);
    const cause = new Error('Unavailable mount');
    vi.mocked(fs.stat).mockRejectedValueOnce(cause);
    await expect(inspectDatabaseFilesystem(root)).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
      cause,
    });
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('does not stat unrelated ineligible mountpoints', async () => {
    if (process.platform !== 'darwin') return;
    const root = await fs.mkdtemp(path.join(tmpdir(), 'database-filesystem-'));
    roots.push(root);
    vi.mocked(fs.stat).mockClear();
    await inspectDatabaseFilesystem(root);
    expect(vi.mocked(fs.stat).mock.calls.map(([file]) => file)).not.toContain('/dev');
    expect(vi.mocked(fs.stat).mock.calls.map(([file]) => file)).not.toContain(
      '/System/Volumes/Data/home'
    );
  });
  it('returns cancellation while a readonly mount observation remains pending', async () => {
    if (process.platform !== 'darwin') return;
    const root = await fs.mkdtemp(path.join(tmpdir(), 'database-filesystem-'));
    roots.push(root);
    const controller = new AbortController();
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.stat).mockImplementationOnce((async (file: string) => {
      observed();
      await delayed;
      return original.stat(file, { bigint: true });
    }) as never);
    const pending = inspectDatabaseFilesystem(root, controller.signal);
    await started;
    controller.abort();
    try {
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      release();
    }
  });
  it.each([0x01021994n, 0x794c7630n, 0x6969n, 0n])(
    'refuses Linux filesystem type %s without claiming network or corruption',
    async (type) => {
      const root = await fs.mkdtemp(path.join(tmpdir(), 'database-filesystem-'));
      roots.push(root);
      vi.stubGlobal('process', { ...process, platform: 'linux' });
      const original = await vi.importActual<typeof fs>('node:fs/promises');
      const observed = await original.statfs(root, { bigint: true });
      vi.mocked(fs.statfs).mockResolvedValueOnce({ ...observed, type } as never);
      await expect(inspectDatabaseFilesystem(root)).rejects.toMatchObject({
        code: 'HISTORY_INACCESSIBLE',
      });
      expect(await fs.readdir(root)).toEqual([]);
    }
  );
});
