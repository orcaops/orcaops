import { execFile } from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import * as durability from './durability.js';
import {
  prepareDatabaseGitClosure,
  requireOwnedDatabaseGitObjects,
  unpairedPackFiles,
} from './object-closure.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

vi.mock('./durability.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./durability.js')>()),
}));

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]) {
  const result = await execute('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  return result.stdout.trim();
}
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'retention-publication-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Retained object');
  const root = path.join(directory, 'history');
  await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: ['Create disposable history'],
    secretAllow: [],
  });
  const context = await requireDatabaseExecutionContext({ cwd, root });
  const publication = {
    fullRef:
      'refs/orcaops/snap/01900000-0000-7000-8000-000000000001/1/open-01900000-0000-7000-8000-000000000002',
    objectOid: await git(cwd, 'rev-parse', 'HEAD'),
    treeOid: await git(cwd, 'rev-parse', 'HEAD^{tree}'),
    objectFormat: 'sha1' as const,
  };
  return { directory, cwd, root, context, publication };
}
function recordSyncs() {
  const files: string[] = [];
  const original = filesystem.open;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      files.push(String(args[0]));
      await sync();
    };
    return handle;
  });
  return files;
}
async function withBlob() {
  const f = await fixture();
  await writeFile(path.join(f.cwd, 'retained.txt'), 'Exact retained historical blob\n');
  await git(f.cwd, 'add', 'retained.txt');
  await git(f.cwd, 'commit', '-qm', 'Child retaining an original ancestor');
  const context = await requireDatabaseExecutionContext(f);
  const objectOid = await git(f.cwd, 'rev-parse', 'HEAD');
  const blobOid = await git(f.cwd, 'rev-parse', 'HEAD:retained.txt');
  const blobFile = path.join(f.cwd, '.git', 'objects', blobOid.slice(0, 2), blobOid.slice(2));
  return { ...f, context, objectOid, blobOid, blobFile };
}
it('synchronizes the exact original commit, its ancestor, tree and blob closure without publishing refs', async () => {
  const f = await withBlob();
  const synced = recordSyncs();
  const expected = (
    await git(f.cwd, 'rev-list', '--objects', '--no-object-names', f.objectOid)
  ).split('\n');
  const result = await prepareDatabaseGitClosure(f.context, f.objectOid);
  expect(result).toMatchObject({
    objectOid: f.objectOid,
    objectFormat: 'sha1',
    objectCount: expected.length,
  });
  expect(expected).toContain(f.publication.objectOid);
  for (const id of expected)
    expect(synced).toContain(path.join(f.cwd, '.git', 'objects', id.slice(0, 2), id.slice(2)));
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops')).toBe('');
});
it.each([
  'pack-' + 'a'.repeat(40),
  'loose-' + 'b'.repeat(40),
  'pack-' + 'a'.repeat(64),
  'custom',
  'some pack.name',
])('accepts paired files with stem %s', (stem) =>
  expect(unpairedPackFiles([`${stem}.pack`, `${stem}.idx`])).toEqual([])
);
it('reports both orphan directions in sorted order and ignores unrelated entries', () => {
  expect(unpairedPackFiles(['z.pack', 'a.idx', 'z.rev', 'a.keep', 'multi-pack-index'])).toEqual([
    'a.idx',
    'z.pack',
  ]);
  expect(unpairedPackFiles([])).toEqual([]);
});
it.each(['original', 'loose', 'custom'])(
  'synchronizes %s packed representations without rewriting or unpacking them',
  async (stem) => {
    const f = await withBlob();
    await git(f.cwd, 'repack', '-ad');
    const directory = path.join(f.cwd, '.git', 'objects', 'pack');
    const originalNames = (await filesystem.readdir(directory)).filter((name) =>
      /\.(pack|idx)$/.test(name)
    );
    const names = originalNames.map((name) =>
      stem === 'original'
        ? name
        : stem === 'loose'
          ? name.replace(/^pack-/, 'loose-')
          : `custom${path.extname(name)}`
    );
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== originalNames[i])
        await filesystem.rename(
          path.join(directory, originalNames[i]!),
          path.join(directory, names[i]!)
        );
    }
    const before = await Promise.all(names.map((name) => readFile(path.join(directory, name))));
    const synced = recordSyncs();
    expect(await prepareDatabaseGitClosure(f.context, f.objectOid)).toMatchObject({
      objectOid: f.objectOid,
    });
    for (const name of names) expect(synced).toContain(path.join(directory, name));
    expect(await Promise.all(names.map((name) => readFile(path.join(directory, name))))).toEqual(
      before
    );
    await expect(readFile(f.blobFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(f.cwd, 'cat-file', '-p', f.blobOid)).toBe('Exact retained historical blob');
  }
);
it.each(['pack', 'idx'])('refuses an orphan .%s with filename detail', async (extension) => {
  const f = await withBlob();
  const directory = path.join(f.cwd, '.git', 'objects', 'pack');
  await writeFile(path.join(directory, `orphan.${extension}`), '');
  await expect(requireOwnedDatabaseGitObjects(f.context)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
    message: expect.stringContaining(`orphan.${extension}`),
  });
});
it.each(['objects/info/alternates', 'shallow', 'info/grafts'])(
  'refuses incomplete or borrowed ancestry metadata %s without writing an acknowledgement',
  async (name) => {
    const f = await withBlob();
    const file = path.join(f.cwd, '.git', name);
    await mkdir(path.dirname(file), { recursive: true });
    const content = name.endsWith('alternates')
      ? path.join(f.directory, 'borrowed-objects') + '\n'
      : f.objectOid + '\n';
    await writeFile(file, content);
    const flush = vi.spyOn(durability, 'hardwareFlush');
    await expect(requireOwnedDatabaseGitObjects(f.context)).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
    });
    expect(flush).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(content);
    await rm(file);
    expect(await prepareDatabaseGitClosure(f.context, f.objectOid)).toMatchObject({
      objectOid: f.objectOid,
    });
  }
);
it('refuses promisor configuration before an object lookup can fetch borrowed content', async () => {
  const f = await withBlob();
  await git(f.cwd, 'config', 'remote.origin.promisor', 'true');
  const flush = vi.spyOn(durability, 'hardwareFlush');
  await expect(prepareDatabaseGitClosure(f.context, f.objectOid)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  expect(flush).not.toHaveBeenCalled();
  await git(f.cwd, 'config', '--unset', 'remote.origin.promisor');
  expect(await prepareDatabaseGitClosure(f.context, f.objectOid)).toMatchObject({
    objectOid: f.objectOid,
  });
});
it('refuses a missing original blob and succeeds only after fixture restoration', async () => {
  const f = await withBlob();
  const bytes = await readFile(f.blobFile);
  await rm(f.blobFile);
  await expect(prepareDatabaseGitClosure(f.context, f.objectOid)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  await writeFile(f.blobFile, bytes);
  expect(await prepareDatabaseGitClosure(f.context, f.objectOid)).toMatchObject({
    objectOid: f.objectOid,
  });
});
it('refuses failed object writeout and pre-cancellation without promising closure durability', async () => {
  const f = await withBlob();
  const original = filesystem.open;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    if (args[0] === f.blobFile)
      throw Object.assign(new Error('Disposable object writeout failure'), { code: 'EIO' });
    return original(...args);
  });
  await expect(prepareDatabaseGitClosure(f.context, f.objectOid)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  vi.restoreAllMocks();
  const flush = vi.spyOn(durability, 'hardwareFlush');
  await expect(
    prepareDatabaseGitClosure(f.context, f.objectOid, { signal: AbortSignal.abort() })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(flush).not.toHaveBeenCalled();
  expect(await prepareDatabaseGitClosure(f.context, f.objectOid)).toMatchObject({
    objectOid: f.objectOid,
  });
});
it('refuses a new unsynchronized loose representation after packed closure writeout', async () => {
  const f = await withBlob();
  const bytes = await readFile(f.blobFile);
  await git(f.cwd, 'repack', '-ad');
  const writeout = durability.writeout;
  let recreated = false;
  vi.spyOn(durability, 'writeout').mockImplementation(async (...args) => {
    await writeout(...args);
    if (args[0] === f.context.git.commonDir) {
      await mkdir(path.dirname(f.blobFile), { recursive: true });
      await writeFile(f.blobFile, bytes);
      recreated = true;
    }
  });
  await expect(prepareDatabaseGitClosure(f.context, f.objectOid)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  expect(recreated).toBe(true);
  vi.restoreAllMocks();
  expect(await prepareDatabaseGitClosure(f.context, f.objectOid)).toMatchObject({
    objectOid: f.objectOid,
  });
});
