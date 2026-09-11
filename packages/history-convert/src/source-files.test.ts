import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertLegacyDirectoryUnchanged,
  inventoryLegacySource,
  observeLegacySourceFile,
} from './source-files.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const roots: string[] = [];
async function temporary() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'orcaops-source-')));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('bounded source file observation', () => {
  it('reports hashes and stat identities without returning source payloads by default', async () => {
    const root = await temporary();
    await fs.mkdir(path.join(root, 'nested'));
    const bytes = Buffer.from('retained source text');
    const file = path.join(root, 'nested', 'evidence.json');
    await fs.writeFile(file, bytes);
    const before = await fs.stat(file, { bigint: true });
    const result = await inventoryLegacySource({ root });
    expect(result.complete).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      relativePath: 'nested/evidence.json',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(JSON.stringify(result)).not.toContain('retained source text');
    const after = await fs.stat(file, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ]);
    expect(
      (await observeLegacySourceFile({ root, relativePath: 'nested/evidence.json' })).bytes
    ).toBeNull();
    expect(
      (
        await observeLegacySourceFile({
          root,
          relativePath: 'nested/evidence.json',
          includeBytes: true,
        })
      ).bytes
    ).toEqual(bytes);
  });

  it('does not follow nested or final symlinks outside the selected source', async () => {
    const root = await temporary();
    const outside = await temporary();
    await fs.writeFile(path.join(outside, 'private.json'), 'private unrelated payload');
    await fs.symlink(outside, path.join(root, 'linked'));
    await fs.symlink(path.join(outside, 'private.json'), path.join(root, 'file.json'));
    const opened = vi.spyOn(fs, 'open');
    const result = await inventoryLegacySource({ root });
    expect(result.complete).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.issues.map((issue) => issue.relativePath)).toEqual(['file.json', 'linked']);
    expect(opened).not.toHaveBeenCalled();
    await expect(
      observeLegacySourceFile({ root, relativePath: 'linked/private.json' })
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await expect(
      observeLegacySourceFile({ root, relativePath: '../private.json' })
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });

  it('detects same-size source mutation during descriptor reads', async () => {
    const root = await temporary();
    const file = path.join(root, 'evidence.json');
    await fs.writeFile(file, 'before');
    const open = fs.open;
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        if (!changed) {
          changed = true;
          await fs.writeFile(file, 'after!');
        }
        return result;
      });
      return handle;
    });
    await expect(
      observeLegacySourceFile({ root, relativePath: 'evidence.json' })
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('revalidates earlier file identities before returning the complete source vector', async () => {
    const root = await temporary();
    await fs.writeFile(path.join(root, 'a.json'), 'before');
    await fs.writeFile(path.join(root, 'b.json'), 'second');
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('b.json'))
        await fs.writeFile(path.join(root, 'a.json'), 'after!');
      return open(...args);
    });
    await expect(inventoryLegacySource({ root })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('copies caller path and byte-selection options before asynchronous work', async () => {
    const root = await temporary();
    await fs.writeFile(path.join(root, 'selected.json'), 'selected');
    await fs.writeFile(path.join(root, 'other.json'), 'other');
    const input = { root, relativePath: 'selected.json', includeBytes: true };
    const pending = observeLegacySourceFile(input);
    input.relativePath = 'other.json';
    input.includeBytes = false;
    expect((await pending).bytes?.toString()).toBe('selected');
  });

  it('honors cancellation before opening source files', async () => {
    const root = await temporary();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const opened = vi.spyOn(fs, 'open');
    await expect(inventoryLegacySource({ root, signal: controller.signal })).rejects.toThrow(
      'cancelled'
    );
    expect(opened).not.toHaveBeenCalled();
  });
  it('omits fixed review trees before stat or payload reads while retaining exact shared files', async () => {
    const root = await temporary();
    const scope = { kind: 'checkout' as const, root };
    await fs.mkdir(path.join(root, '.orcaops/cache'), { recursive: true });
    await fs.writeFile(path.join(root, '.orcaops/retained.json'), 'retained');
    await fs.symlink('/missing-excluded-target', path.join(root, '.orcaops/reviews'));
    await fs.writeFile(
      path.join(root, '.orcaops/cache/review-feedback'),
      'malformed excluded bytes'
    );
    const stat = vi.spyOn(fs, 'lstat');
    const opened = vi.spyOn(fs, 'open');
    const result = await inventoryLegacySource({ root: path.join(root, '.orcaops'), scope });
    expect(result.complete).toBe(true);
    expect(result.files.map((file) => file.relativePath)).toEqual(['retained.json']);
    expect(stat.mock.calls.some(([file]) => String(file).includes('review'))).toBe(false);
    expect(opened.mock.calls.map(([file]) => String(file))).toEqual([
      path.join(root, '.orcaops/retained.json'),
    ]);
  });

  it('ignores omitted directory additions and removals but retains in-scope membership and bytes', async () => {
    const root = await temporary();
    const scope = { kind: 'archive' as const, root };
    await fs.writeFile(path.join(root, 'retained.json'), 'retained');
    const before = await inventoryLegacySource({ root, scope });
    await fs.mkdir(path.join(root, 'reviews'));
    await fs.writeFile(path.join(root, 'reviews/broken'), 'not JSON');
    expect(await inventoryLegacySource({ root, scope })).toEqual(before);
    await fs.rm(path.join(root, 'reviews'), { recursive: true });
    expect(await inventoryLegacySource({ root, scope })).toEqual(before);
    await fs.writeFile(path.join(root, 'included.json'), 'included');
    expect(await inventoryLegacySource({ root, scope })).not.toEqual(before);
    await fs.rm(path.join(root, 'included.json'));
    await fs.writeFile(path.join(root, 'retained.json'), 'modified');
    expect(await inventoryLegacySource({ root, scope })).not.toEqual(before);
  });

  it('detects included child addition during an ancestor comparison that ignores review timestamps', async () => {
    const root = await temporary();
    const scope = { kind: 'archive' as const, root };
    await fs.writeFile(path.join(root, 'retained.json'), 'retained');
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      await fs.writeFile(path.join(root, 'added.json'), 'new in-scope file');
      return open(...args);
    });
    await expect(inventoryLegacySource({ root, scope })).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
  });
  it('rejects replacement of an omitted-tree ancestor even when included names and bytes match', async () => {
    const root = await temporary();
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'retained'), 'retained');
    const scope = { kind: 'archive' as const, root: source };
    const before = await inventoryLegacySource({ root: source, scope });
    await fs.rename(source, path.join(root, 'original'));
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'retained'), 'retained');
    await expect(
      assertLegacyDirectoryUnchanged(source, before.directories[0]!, scope)
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });
  it('treats only the fixed empty or excluded-only cache ancestor as absent', async () => {
    const root = await temporary();
    const source = path.join(root, '.orcaops');
    const scope = { kind: 'checkout' as const, root };
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'retained'), 'retained');
    const before = await inventoryLegacySource({ root: source, scope });
    await fs.mkdir(path.join(source, 'cache'));
    expect(await inventoryLegacySource({ root: source, scope })).toEqual(before);
    await fs.mkdir(path.join(source, 'cache/review-feedback'));
    await fs.writeFile(path.join(source, 'cache/review-feedback/invalid'), 'excluded');
    expect(await inventoryLegacySource({ root: source, scope })).toEqual(before);
    await fs.rm(path.join(source, 'cache'), { recursive: true });
    expect(await inventoryLegacySource({ root: source, scope })).toEqual(before);
    await fs.mkdir(path.join(source, 'other'));
    expect(await inventoryLegacySource({ root: source, scope })).not.toEqual(before);
  });

  it('preserves stable shared cache identity and content while excluded feedback changes', async () => {
    const root = await temporary();
    const source = path.join(root, '.orcaops');
    const scope = { kind: 'checkout' as const, root };
    await fs.mkdir(path.join(source, 'cache'), { recursive: true });
    await fs.writeFile(path.join(source, 'cache/shared.json'), 'shared');
    const before = await inventoryLegacySource({ root: source, scope });
    expect(before.files.map((file) => file.relativePath)).toEqual(['cache/shared.json']);
    await fs.mkdir(path.join(source, 'cache/review-feedback'));
    await fs.writeFile(path.join(source, 'cache/review-feedback/invalid'), 'excluded');
    expect(await inventoryLegacySource({ root: source, scope })).toEqual(before);
    await fs.rm(path.join(source, 'cache/review-feedback'), { recursive: true });
    expect(await inventoryLegacySource({ root: source, scope })).toEqual(before);
    await fs.writeFile(path.join(source, 'cache/shared.json'), 'changed');
    expect(await inventoryLegacySource({ root: source, scope })).not.toEqual(before);
  });

  it.each(['symlink', 'file', 'inaccessible'] as const)(
    'does not normalize an unsafe cache ancestor: %s',
    async (kind) => {
      const root = await temporary();
      const source = path.join(root, '.orcaops');
      const scope = { kind: 'checkout' as const, root };
      await fs.mkdir(source);
      const before = await inventoryLegacySource({ root: source, scope });
      const cache = path.join(source, 'cache');
      if (kind === 'symlink') await fs.symlink('/missing-shared-history', cache);
      else if (kind === 'file') await fs.writeFile(cache, 'unknown shared content');
      else {
        await fs.mkdir(cache);
        const readdir = fs.readdir;
        vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
          if (String(args[0]) === cache)
            throw Object.assign(new Error('inaccessible fixture'), { code: 'EACCES' });
          return readdir(...args);
        });
      }
      const observed = await inventoryLegacySource({ root: source, scope });
      expect(observed).not.toEqual(before);
      if (kind === 'file')
        expect(observed.files.map((file) => file.relativePath)).toEqual(['cache']);
      else expect(observed.complete).toBe(false);
    }
  );
});
