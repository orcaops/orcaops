import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { openProjectDatabase, type ProjectDatabase } from '@orcaops/storage/history/database';
import { readProjectSessionBranch } from '@orcaops/storage/history/database/session-branch';

import {
  type DatabaseSessionObservationInput,
  observeDatabaseSessionBranch,
} from './session-observation.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  return (
    await execute('git', ['-c', 'gc.auto=0', '-C', cwd, ...args], {
      env: {
        ...env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
        GIT_OPTIONAL_LOCKS: '0',
      },
      timeout: 10_000,
    })
  ).stdout.trim();
}
const target = { server_url: 'https://example.test', org_id: 'org', account_id: 'account' };
const repoUrl = 'ssh://example.test/project';
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-session-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Original fixture');
  const root = path.join(directory, 'history');
  await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: ['Disposable checkout'],
    secretAllow: [],
  });
  const context = await requireDatabaseExecutionContext({ cwd, root });
  const handle = await openProjectDatabase({ authority: context.authority, mode: 'writer' });
  handles.push(handle);
  return {
    directory,
    cwd,
    root,
    handle,
    context,
    key: { target, repoUrl, workingDir: context.git.worktreeRoot },
    async current() {
      return requireDatabaseExecutionContext({ cwd, root });
    },
    rows() {
      return handle.read((view) => ({
        revisions: view.all(
          'SELECT revision_id,publication_operation_id,origin_kind,current_branch,base_commit_sha,last_acked_at FROM session_branch_revisions ORDER BY revision_id'
        ),
        current: view.all('SELECT * FROM session_branch_current'),
        receipts: view.all(
          "SELECT operation_id FROM operations WHERE operation_kind='session.branch.observe' ORDER BY operation_id"
        ),
      })).value;
    },
  };
}
function observation(): DatabaseSessionObservationInput {
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    target,
    repoUrl,
    secretAllow: [],
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function observe(f: Fixture, input = observation(), context = f.context, options = {}) {
  return observeDatabaseSessionBranch(f.handle, context, input, options);
}
it('seeds first sight from the registered branch and HEAD', async () => {
  const f = await fixture();
  const result = await observe(f);
  expect(result!.value).toMatchObject({ changed: true, selection: { version: 1 } });
  expect(readProjectSessionBranch(f.handle, f.key)!.state).toMatchObject({
    current_branch: 'topic',
    branch_history: [],
    base_commit_sha: f.context.git.headOid,
    last_acked_at: null,
  });
});
it('returns the original selection unchanged without a second revision or receipt', async () => {
  const f = await fixture();
  const first = await observe(f);
  const before = f.rows();
  const again = await observe(f);
  expect(again!.value).toEqual({ selection: first!.value.selection, changed: false });
  expect(again!.replayed).toBe(false);
  expect(f.rows()).toEqual(before);
});
it('threads the prior branch into history when the branch was renamed', async () => {
  const f = await fixture();
  await observe(f);
  await git(f.cwd, 'branch', '-m', 'topic', 'renamed');
  const result = await observe(f, observation(), await f.current());
  expect(result!.value).toMatchObject({ changed: true, selection: { version: 2 } });
  expect(readProjectSessionBranch(f.handle, f.key)!.state).toMatchObject({
    current_branch: 'renamed',
    branch_history: ['topic'],
    base_commit_sha: f.context.git.headOid,
  });
});
it('starts a fresh session when the prior branch still exists after a branch-off', async () => {
  const f = await fixture();
  await observe(f);
  await git(f.cwd, 'checkout', '-qb', 'feature');
  await git(f.cwd, 'commit', '--allow-empty', '-qm', 'Branched work');
  const context = await f.current();
  const result = await observe(f, observation(), context);
  expect(result!.value).toMatchObject({ changed: true, selection: { version: 2 } });
  expect(readProjectSessionBranch(f.handle, f.key)!.state).toMatchObject({
    current_branch: 'feature',
    branch_history: [],
    base_commit_sha: context.git.headOid,
    last_acked_at: null,
  });
});
it('observes nothing while HEAD is detached', async () => {
  const f = await fixture();
  await git(f.cwd, 'checkout', '-q', '--detach');
  const before = f.rows();
  expect(await observe(f, observation(), await f.current())).toBeNull();
  expect(f.rows()).toEqual(before);
});
it('replays the original observation by operation ID without reading Git again', async () => {
  const f = await fixture();
  const input = observation();
  const first = await observe(f, input);
  await git(f.cwd, 'branch', '-m', 'topic', 'moved');
  const before = f.rows();
  // Any Git work would run in this absent directory and fail; the committed receipt
  // lookup has to answer first.
  const absent = {
    ...f.context,
    git: { ...f.context.git, worktreeRoot: path.join(f.directory, 'absent') },
  };
  const replay = await observe(f, input, absent);
  expect(replay!.replayed).toBe(true);
  expect(replay!.value).toEqual(first!.value);
  expect(f.rows()).toEqual(before);
  expect(readProjectSessionBranch(f.handle, f.key)!.state.current_branch).toBe('topic');
});
it('refuses a registered context that no longer matches the checkout', async () => {
  const f = await fixture();
  await observe(f);
  await git(f.cwd, 'branch', '-m', 'topic', 'renamed');
  const before = f.rows();
  await expect(observe(f)).rejects.toMatchObject({ code: 'EXECUTION_CONTEXT_CHANGED' });
  expect(f.rows()).toEqual(before);
});
it('cancels before publication and leaves the retained session untouched', async () => {
  const f = await fixture();
  await observe(f);
  await git(f.cwd, 'branch', '-m', 'topic', 'renamed');
  const context = await f.current();
  const before = f.rows();
  const started = new AbortController();
  started.abort();
  await expect(
    observe(f, observation(), context, { signal: started.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  const midflight = new AbortController();
  setTimeout(() => midflight.abort(), 0);
  await expect(
    observe(f, observation(), context, { signal: midflight.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(f.rows()).toEqual(before);
});
