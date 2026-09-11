import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

import { getDefaultConfig } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { createDatabaseListAction } from './database-list.js';
import { type DatabaseListContext, type DatabaseListOptions } from '../lib/database-list.js';

afterEach(() => vi.restoreAllMocks());
function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stdout, stderr };
}
function context(close = () => {}): DatabaseListContext {
  return {
    config: getDefaultConfig(),
    scope: {
      root: { rootKey: 'root', resolvedRoot: '/disposable' },
      kind: 'project',
      selection: 'explicit',
      branch: { value: null, source: 'all' },
      gitContext: null,
      contextIssues: [],
      projects: [],
      completeness: { complete: true, issues: [] },
      close,
    },
  };
}
it('rejects malformed and retired options before creating context', async () => {
  output();
  const openContext = vi.fn();
  const action = createDatabaseListAction({ openContext });
  for (const options of [
    null,
    [],
    5,
    { branch: 5 },
    { scope: 'wrong' },
    { project: 'wrong' },
    { allProjects: true },
    { allBranches: true },
    { imported: true },
    { cursor: 'old' },
    { state: 'complete' },
    { touching: '../secret' },
    { since: 'yesterday' },
    { limit: 0 },
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER, limit: 1 },
    { json: 'yes' },
    { between: 'one...two' },
    { between: 'one..two', branch: 'main' },
    { between: 'one..two', touching: 'src/**' },
    { between: 'one..two', activeSince: '2026-01-01' },
    { between: 'one..two', scope: 'all-projects' },
    { between: '--help..main' },
  ])
    await expect(action(options as DatabaseListOptions)).rejects.toMatchObject({ code: 1 });
  expect(openContext).not.toHaveBeenCalled();
});
it.each([true, false])(
  'preserves genuine database code and safe finite reason with JSON=%s',
  async (json) => {
    const captured = output();
    const failure = new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Restore access to the original store',
      { cause: new Database.SqliteError('private SQL data', 'SQLITE_BUSY') }
    );
    await expect(
      createDatabaseListAction({
        async openContext() {
          throw failure;
        },
      })({ json })
    ).rejects.toMatchObject({ code: 1 });
    const text = [...captured.stdout, ...captured.stderr].join('');
    expect(text).not.toContain('private SQL');
    if (json)
      expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
        ok: false,
        error: { code: 'HISTORY_INACCESSIBLE', reason: 'contention' },
      });
    else expect(text).toContain('[HISTORY_INACCESSIBLE; contention]');
  }
);
it('keeps forged codes untrusted and does not expose raw causes', async () => {
  const captured = output();
  await expect(
    createDatabaseListAction({
      async openContext() {
        throw Object.assign(new Error('private'), { code: 'HISTORY_MISSING' });
      },
    })({ json: true })
  ).rejects.toMatchObject({ code: 1 });
  expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
    ok: false,
    error: { code: 'INTERNAL' },
  });
});
it('closes before emitting one success and retains complete empty totals', async () => {
  const captured = output();
  const close = vi.fn(() => expect(captured.stdout).toEqual([]));
  await createDatabaseListAction({
    async openContext() {
      return context(close);
    },
  })({ json: true });
  expect(close).toHaveBeenCalledTimes(1);
  expect(captured.stdout).toHaveLength(1);
  expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
    ok: true,
    schema_version: 3,
    results: [],
    completeness: { complete: true },
    page: { offset: 0, limit: 50, returned: 0, truncated: false },
    origin_counts: { matching: { captured: 0, imported: 0 } },
  });
});
it('reports cleanup-only failure without first emitting successful rows', async () => {
  const captured = output();
  await expect(
    createDatabaseListAction({
      async openContext() {
        return context(() => {
          throw new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Reader could not close');
        });
      },
    })({ json: true })
  ).rejects.toMatchObject({ code: 1 });
  expect(captured.stdout).toHaveLength(1);
  expect(JSON.parse(captured.stdout[0])).toMatchObject({
    ok: false,
    error: { code: 'HISTORY_INACCESSIBLE' },
  });
});
it('preserves the primary scope failure when cleanup and its diagnostic fail', async () => {
  const captured = output();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => {
    throw new Error('diagnostic unavailable');
  });
  await expect(
    createDatabaseListAction({
      async openContext() {
        return context(() => {
          throw new Error('private cleanup');
        });
      },
    })({ json: true, branch: 'other' })
  ).rejects.toMatchObject({ code: 1 });
  expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
    ok: false,
    error: { code: 'SCOPE_CONFLICT' },
  });
  expect(captured.stdout.join('')).not.toContain('private cleanup');
});
it('detaches selectors and pagination before asynchronous context resolution', async () => {
  const captured = output();
  const options: DatabaseListOptions = { json: true, branch: 'main', limit: 1, offset: 2 };
  await createDatabaseListAction({
    async openContext(selector) {
      expect(selector.branch).toBe('main');
      options.branch = 'other';
      options.limit = 0;
      options.offset = -1;
      const result = context();
      result.scope.branch = { value: 'main', source: 'explicit' };
      return result;
    },
  })(options);
  expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
    ok: true,
    filters: { limit: 1, offset: 2 },
    scope: { branch: { value: 'main' } },
  });
});
