import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { openProjectDatabase } from '@orcaops/storage/history/database';

import { prepareDatabaseGitClosure } from './object-closure.js';
import { prepareDatabaseSnapshot } from './snapshot.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]) {
  const result = await execute('git', ['-C', cwd, ...args], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  return result.stdout.trim();
}
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'snapshot-authority-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  const root = path.join(directory, 'history');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await writeFile(path.join(cwd, 'original.txt'), 'Original retained bytes\n');
  await git(cwd, 'add', 'original.txt');
  await git(cwd, 'commit', '-qm', 'Original retained content');
  await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: ['Disposable fixture'],
    secretAllow: [],
  });
  const context = await requireDatabaseExecutionContext({ cwd, root });
  return { directory, cwd, context };
}
it('keeps snapshot objects in the registered repository despite ambient object redirection', async () => {
  const f = await fixture();
  const foreign = path.join(f.directory, 'foreign-objects');
  await mkdir(foreign);
  await writeFile(path.join(f.cwd, 'captured.txt'), 'Selected worktree bytes\n');
  const reader = await openProjectDatabase({ authority: f.context.authority, mode: 'reader' });
  try {
    const observe = () =>
      reader.read((view) => ({
        operations: view.all('SELECT * FROM operations ORDER BY operation_id'),
        artifacts: view.all('SELECT * FROM artifacts ORDER BY artifact_id'),
      }));
    const before = observe();
    vi.stubEnv('GIT_OBJECT_DIRECTORY', foreign);
    vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', foreign);
    const result = await prepareDatabaseSnapshot(f.context, {
      label: 'Selected snapshot',
      source: { kind: 'worktree' },
      authoredPayloads: ['Original authored capture'],
      secretAllow: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error_message);
    expect(await git(f.cwd, 'show', `${result.commit_sha}:captured.txt`)).toBe(
      'Selected worktree bytes'
    );
    expect(await readdir(foreign)).toEqual([]);
    expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops')).toBe('');
    expect(observe()).toEqual(before);
  } finally {
    reader.close();
  }
});
it('refuses missing original evidence even when a replacement commit presents a complete tree', async () => {
  const f = await fixture();
  const original = await git(f.cwd, 'rev-parse', 'HEAD');
  const blob = await git(f.cwd, 'rev-parse', 'HEAD:original.txt');
  const blobFile = path.join(f.cwd, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  const bytes = await readFile(blobFile);
  await rm(path.join(f.cwd, 'original.txt'));
  await writeFile(path.join(f.cwd, 'replacement.txt'), 'Replacement content\n');
  await git(f.cwd, 'add', '-A');
  const tree = await git(f.cwd, 'write-tree');
  const replacement = await git(f.cwd, 'commit-tree', tree, '-m', 'Replacement presentation');
  await git(f.cwd, 'replace', original, replacement);
  await rm(blobFile);
  expect(await git(f.cwd, 'show', `${original}:replacement.txt`)).toBe('Replacement content');
  await expect(prepareDatabaseGitClosure(f.context, original)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  await writeFile(blobFile, bytes);
  const closure = await prepareDatabaseGitClosure(f.context, original);
  expect(closure.objectOid).toBe(original);
  expect(closure.treeOid).not.toBe(tree);
  expect(await git(f.cwd, 'rev-parse', `refs/replace/${original}`)).toBe(replacement);
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops')).toBe('');
});
