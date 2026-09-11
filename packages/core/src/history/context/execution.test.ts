import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

import { openProjectDatabase, projectDatabasePath } from '@orcaops/storage/history/database';

import {
  readRegisteredDatabaseContext,
  requireDatabaseExecutionContext,
  revalidateDatabaseExecutionContext,
} from './execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]) {
  return execute('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
}
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'registered-context-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  const root = path.join(directory, 'history');
  return { directory, cwd, root };
}
async function setup() {
  const f = await fixture();
  const result = await setupProjectDatabase({
    ...f,
    authoredPayloads: ['Create disposable history'],
    secretAllow: [],
  });
  expect(result.status).toBe('complete');
  return { ...f, result };
}
it('returns no registered context without creating history or registration files', async () => {
  const f = await fixture();
  const before = await readdir(path.join(f.cwd, '.git'));
  expect(await readRegisteredDatabaseContext(f)).toBeNull();
  expect(await readdir(f.directory)).toEqual(['repository']);
  expect(await readdir(path.join(f.cwd, '.git'))).toEqual(before);
  await expect(requireDatabaseExecutionContext(f)).rejects.toMatchObject({
    code: 'HISTORY_MISSING',
    message: expect.stringMatching(
      /doctor.*first-use setup only after confirming no prior history/
    ),
  });
  expect(await readdir(f.directory)).toEqual(['repository']);
});
it('reads a registered unborn branch without changing application rows or marker bytes', async () => {
  const f = await setup();
  const database = await openProjectDatabase({
    authority: f.result.initialization.authority,
    mode: 'reader',
  });
  try {
    const before = database.read((v) => v.all('SELECT * FROM operations'));
    const marker = path.join(f.cwd, '.git', 'orcaops', 'registration.json');
    const bytes = await readFile(marker);
    const current = await requireDatabaseExecutionContext(f);
    expect(current.authority).toEqual(f.result.initialization.authority);
    expect(current.binding).toMatchObject({
      worktree_id: f.result.worktree!.worktree_id,
      git_context: { branch: 'topic', head_sha: null },
    });
    expect((await revalidateDatabaseExecutionContext(current)).binding).toEqual(current.binding);
    expect(database.read((v) => v.all('SELECT * FROM operations'))).toEqual(before);
    expect(await readFile(marker)).toEqual(bytes);
  } finally {
    database.close();
  }
});
it('retains detached commit identity and refuses an operation prepared before branch change', async () => {
  const f = await setup();
  await git(f.cwd, 'commit', '--allow-empty', '-qm', 'Retained fixture');
  const before = await requireDatabaseExecutionContext(f);
  await git(f.cwd, 'checkout', '--detach', '-q');
  const detached = await requireDatabaseExecutionContext(f);
  expect(detached.binding.git_context).toEqual({
    branch: null,
    head_sha: before.binding.git_context.head_sha,
  });
  await expect(revalidateDatabaseExecutionContext(before)).rejects.toMatchObject({
    code: 'EXECUTION_CONTEXT_CHANGED',
  });
  expect((await revalidateDatabaseExecutionContext(detached)).binding).toEqual(detached.binding);
});
it('reports deleted expected database history and creates no replacement', async () => {
  const f = await setup();
  const file = projectDatabasePath(f.result.initialization.authority);
  const marker = await readFile(path.join(f.cwd, '.git', 'orcaops', 'registration.json'));
  await rm(file);
  const before = await readdir(path.dirname(file));
  await expect(readRegisteredDatabaseContext(f)).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(await readdir(path.dirname(file))).toEqual(before);
  expect(await readFile(path.join(f.cwd, '.git', 'orcaops', 'registration.json'))).toEqual(marker);
});
it('does not create a linked worktree registration while viewing its existing project', async () => {
  const f = await setup();
  await git(f.cwd, 'commit', '--allow-empty', '-qm', 'Retained fixture');
  const linked = path.join(f.directory, 'linked');
  await git(f.cwd, 'worktree', 'add', '-qb', 'linked-topic', linked);
  const current = await readRegisteredDatabaseContext({ cwd: linked, root: f.root });
  expect(current!.authority).toEqual(f.result.initialization.authority);
  expect(current!.binding).toBeNull();
  const before = await readdir(current!.git.gitDir);
  await expect(
    requireDatabaseExecutionContext({ cwd: linked, root: f.root })
  ).rejects.toMatchObject({ code: 'IDENTITY_RECOVERY_REQUIRED' });
  expect(await readdir(current!.git.gitDir)).toEqual(before);
  expect(before).not.toContain('orcaops');
});

it('rejects invalid identity and cancellation before creating history or starting setup', async () => {
  const f = await fixture();
  await expect(
    readRegisteredDatabaseContext({ ...f, projectId: 'not-an-identity' })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    readRegisteredDatabaseContext(f, { signal: AbortSignal.abort() })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await readdir(f.directory)).toEqual(['repository']);
});

it('retains the originally selected registered checkout while its caller object changes', async () => {
  const first = await setup();
  const second = await fixture();
  const secondSetup = await setupProjectDatabase({
    ...second,
    root: first.root,
    authoredPayloads: ['Create another disposable project'],
    secretAllow: [],
  });
  expect(secondSetup.status).toBe('complete');
  const original = await requireDatabaseExecutionContext(first);
  const selectors = { cwd: first.cwd, root: first.root, projectId: original.authority.projectId };
  const pending = requireDatabaseExecutionContext(selectors);
  selectors.cwd = second.cwd;
  selectors.projectId = secondSetup.initialization.authority.projectId;
  const observed = await pending;
  expect(observed.authority).toEqual(original.authority);
  expect(observed.binding).toEqual(original.binding);
});

it('compares the original prepared binding after a caller mutates its expected snapshot', async () => {
  const f = await setup();
  await git(f.cwd, 'commit', '--allow-empty', '-qm', 'Retained fixture');
  const expected = await requireDatabaseExecutionContext(f);
  await git(f.cwd, 'checkout', '-qb', 'changed-topic');
  const current = await requireDatabaseExecutionContext(f);
  const pending = revalidateDatabaseExecutionContext(expected);
  expected.binding.git_context.branch = current.binding.git_context.branch;
  expected.binding.git_context.head_sha = current.binding.git_context.head_sha;
  await expect(pending).rejects.toMatchObject({ code: 'EXECUTION_CONTEXT_CHANGED' });
  expect((await revalidateDatabaseExecutionContext(current)).binding).toEqual(current.binding);
});
