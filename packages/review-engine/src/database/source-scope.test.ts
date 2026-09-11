import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import {
  publishProjectCatalogEntry,
  publishRepositoryRegistration,
} from '@orcaops/core/history/registration';
import * as scopes from '@orcaops/project-scope/history/database';
import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import * as store from '@orcaops/storage/history/database';

import { readScopedReviewSourceVersions } from './source-scope.js';

vi.mock('@orcaops/project-scope/history/database', async (original) => ({
  ...(await original<typeof scopes>()),
}));
const execute = promisify(execFile);
const roots: string[] = [];
const handles: store.ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'review-source-scope-')));
  roots.push(base);
  const root = await normalizeHistoryRoot({ root: path.join(base, 'data') });
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(store.projectDatabasePath(authority)), { recursive: true });
  const initializationOperationId = uuidv7();
  const writer = await store.initializeProjectDatabase({
    authority,
    initializationOperationId,
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(writer);
  const { repositoryInstanceId, ...expected } = authority;
  return {
    base,
    authority,
    writer,
    initializationOperationId,
    input: {
      authority: expected,
      repositoryInstanceId,
      checkoutRoot: null as string | null,
      branch: 'main',
    },
  };
}
async function checkout(f: Awaited<ReturnType<typeof fixture>>, registered: boolean) {
  const cwd = path.join(f.base, 'checkout');
  await mkdir(cwd);
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') delete env[key as keyof typeof env];
  await execute('git', ['init', '-q', '-b', 'main', cwd], { env });
  if (registered)
    await publishRepositoryRegistration({
      expected: f.authority,
      initializationOperationId: f.initializationOperationId,
      commonDir: path.join(cwd, '.git'),
    });
  return cwd;
}
it('reads an explicit initialized project outside Git without publishing missing registration or catalog', async () => {
  const f = await fixture();
  const before = f.writer.read(() => null).counters;
  const directories = await readdir(path.join(f.authority.resolvedRoot, 'projects'));
  const result = await readScopedReviewSourceVersions({ ...f.input, repositoryInstanceId: null });
  expect(result.value.authority).toEqual(f.authority);
  expect(result.counters).toEqual(before);
  expect(await readdir(path.join(f.authority.resolvedRoot, 'projects'))).toEqual(directories);
  await expect(
    readFile(
      path.join(f.authority.resolvedRoot, 'projects', 'catalog', `${f.authority.projectId}.json`)
    )
  ).rejects.toMatchObject({ code: 'ENOENT' });
  await publishProjectCatalogEntry({
    expected: f.authority,
    initializationOperationId: f.initializationOperationId,
  });
  expect((await readScopedReviewSourceVersions(f.input)).digest).toBe(result.digest);
});
it('refuses a missing original store and mismatched repository or root tuple', async () => {
  const f = await fixture();
  await expect(
    readScopedReviewSourceVersions({
      ...f.input,
      authority: { ...f.input.authority, storeInstanceId: uuidv7() },
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(
    readScopedReviewSourceVersions({ ...f.input, repositoryInstanceId: uuidv7() })
  ).rejects.toMatchObject({ code: 'AUTHORITY_MISMATCH' });
  await expect(
    readScopedReviewSourceVersions({
      ...f.input,
      authority: { ...f.input.authority, rootKey: 'wrong' },
    })
  ).rejects.toMatchObject({ code: 'AUTHORITY_MISMATCH' });
  const missing = { ...f.input.authority, projectId: uuidv7() };
  await expect(
    readScopedReviewSourceVersions({ ...f.input, authority: missing })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(
    readFile(
      store.projectDatabasePath({
        ...missing,
        repositoryInstanceId: f.authority.repositoryInstanceId,
      })
    )
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('requires matching existing registration when a checkout is supplied', async () => {
  const f = await fixture();
  const cwd = await checkout(f, false);
  await expect(
    readScopedReviewSourceVersions({ ...f.input, checkoutRoot: cwd })
  ).rejects.toMatchObject({ code: 'REVIEW_CONTEXT_MISMATCH' });
  await publishRepositoryRegistration({
    expected: f.authority,
    initializationOperationId: f.initializationOperationId,
    commonDir: path.join(cwd, '.git'),
  });
  expect(
    (await readScopedReviewSourceVersions({ ...f.input, checkoutRoot: cwd })).value.authority
  ).toEqual(f.authority);
});
it('does not detach a supplied differently registered checkout from its original project', async () => {
  const f = await fixture();
  const other = await fixture();
  const cwd = await checkout(other, true);
  await expect(
    readScopedReviewSourceVersions({ ...f.input, checkoutRoot: cwd })
  ).rejects.toMatchObject({ code: 'REVIEW_CONTEXT_MISMATCH' });
});
it('copies the request before scope discovery and preserves the original primary failure on cleanup', async () => {
  const f = await fixture();
  const original = scopes.resolveDatabaseHistoryScope;
  const closing = new Error('controlled scope close failure');
  let closed = false;
  vi.spyOn(scopes, 'resolveDatabaseHistoryScope').mockImplementation(async (input) => {
    const result = await original(input);
    return {
      ...result,
      close() {
        result.close();
        closed = true;
        throw closing;
      },
    };
  });
  const input = { ...f.input, authority: { ...f.input.authority, storeInstanceId: uuidv7() } };
  const promise = readScopedReviewSourceVersions(input);
  input.authority.storeInstanceId = f.authority.storeInstanceId;
  input.branch = 'changed';
  const failure = await promise.catch((error) => error);
  expect(failure).toMatchObject({ code: 'HISTORY_MISSING' });
  expect(failure.cause).toBeInstanceOf(AggregateError);
  expect(failure.cause.errors[1]).toBe(closing);
  expect(closed).toBe(true);
  expect(f.writer.read(() => true).value).toBe(true);
});
it('refuses invalid selectors before scope discovery', async () => {
  const f = await fixture();
  const spy = vi.spyOn(scopes, 'resolveDatabaseHistoryScope');
  await expect(readScopedReviewSourceVersions({ ...f.input, branch: '\n' })).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(spy).not.toHaveBeenCalled();
});
