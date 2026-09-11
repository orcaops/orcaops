import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  initializeRepositoryDatabase,
  type ProjectDatabase,
  projectDatabasePath,
  readProjectInitializationCandidate,
  readProjectInitializationObservation,
} from './connection.js';
import { PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { runProjectOperation } from './transactions.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'repository-creation-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const file = projectDatabasePath(authority);
  await mkdir(path.dirname(file), { recursive: true });
  const input = {
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
    repositoryCreation: {
      commonDirectory: path.join(root.resolvedRoot, 'repository', '.git'),
      device: '123',
      inode: '9007199254740993',
      birthtimeNs: '1730000000000000001' as string | null,
    },
  };
  return { input, file, selected: { root: root.resolvedRoot, projectId: authority.projectId } };
}
async function created() {
  const value = await fixture();
  const handle = await initializeRepositoryDatabase(value.input);
  handles.push(handle);
  return { ...value, handle };
}

describe('original repository initialization', () => {
  it('retains exact creation and initialization facts and retries the same inputs', async () => {
    const { input, selected, handle } = await created();
    const candidate = await readProjectInitializationCandidate(selected);
    expect(candidate).toEqual({
      authority: input.authority,
      initializationOperationId: input.initializationOperationId,
      initializedAt: input.initializedAt,
      state: 'active',
      schemaVersion: PROJECT_DATABASE_SCHEMA_VERSION,
      repositoryCreation: input.repositoryCreation,
    });
    const retry = await initializeRepositoryDatabase(input);
    handles.push(retry);
    expect(retry.read(() => null).counters).toEqual({ writeSequence: 1, intentChangeCounter: 0 });
    expect(handle.read((view) => view.all('SELECT * FROM operations')).value).toEqual([]);
    expect(Object.isFrozen(candidate.repositoryCreation)).toBe(true);
  });
  it.each([
    'device',
    'inode',
    'birthtimeNs',
    'commonDirectory',
    'initializationOperationId',
    'initializedAt',
  ] as const)(
    'refuses existing initialization with changed %s before writer configuration',
    async (field) => {
      const { input, selected } = await created();
      const changed = { ...input, repositoryCreation: { ...input.repositoryCreation } };
      if (field === 'initializationOperationId') changed.initializationOperationId = uuidv7();
      else if (field === 'initializedAt') changed.initializedAt = '2000-01-01T00:00:00.000Z';
      else changed.repositoryCreation[field] = field === 'commonDirectory' ? '/another/git' : '42';
      const pragma = vi.spyOn(Database.prototype, 'pragma');
      await expect(initializeRepositoryDatabase(changed)).rejects.toMatchObject({
        code: 'IDENTITY_CONFLICT',
      });
      expect(
        pragma.mock.calls.some(([sql]) => /^journal_mode\s*=|^synchronous\s*=/i.test(sql))
      ).toBe(false);
      expect((await readProjectInitializationCandidate(selected)).repositoryCreation).toEqual(
        input.repositoryCreation
      );
    }
  );
  it('detaches inputs before authorization and asynchronous preparation', async () => {
    const { input, selected } = await fixture();
    const original = structuredClone({
      authority: input.authority,
      creation: input.repositoryCreation,
    });
    input.authorize = () => {
      input.authority.projectId = uuidv7();
      input.repositoryCreation.inode = '7';
    };
    const initializing = initializeRepositoryDatabase(input);
    input.repositoryCreation.device = '9';
    const handle = await initializing;
    handles.push(handle);
    const candidate = await readProjectInitializationCandidate(selected);
    expect(candidate.authority).toEqual(original.authority);
    expect(candidate.repositoryCreation).toEqual(original.creation);
  });
  it('refuses missing creation and asynchronous or throwing authorization without creating a database', async () => {
    const { input, file } = await fixture();
    expect(() =>
      initializeRepositoryDatabase({ ...input, repositoryCreation: undefined } as never)
    ).toThrow();
    await expect(
      initializeRepositoryDatabase({ ...input, authorize: (() => Promise.resolve()) as never })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      initializeRepositoryDatabase({
        ...input,
        authorize() {
          throw new Error('refused');
        },
      })
    ).rejects.toThrow('refused');
    expect(await readdir(path.dirname(file))).toEqual([]);
  });
  it('rolls back identity and activation if creation cannot be inserted', async () => {
    const { input, file } = await fixture();
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (sql.startsWith('INSERT INTO repository_creation'))
        throw new Error('injected creation failure');
      return prepare.call(this, sql);
    });
    await expect(initializeRepositoryDatabase(input)).rejects.toThrow('injected creation failure');
    const raw = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(raw.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([]);
    } finally {
      raw.close();
    }
  });
  it('protects original creation from mutation and forbids adding provenance after generic initialization', async () => {
    const { input, handle } = await created();
    const raw = new Database(handle.databasePath);
    try {
      expect(() => raw.prepare('UPDATE repository_creation SET inode=?').run('4')).toThrow(
        'immutable'
      );
      expect(() => raw.prepare('DELETE FROM repository_creation').run()).toThrow('retained');
    } finally {
      raw.close();
    }
    const other = await fixture();
    const generic = await initializeProjectDatabase(other.input);
    handles.push(generic);
    await expect(initializeRepositoryDatabase(other.input)).rejects.toMatchObject({
      code: 'IDENTITY_RECOVERY_REQUIRED',
    });
    const operation = {
      operationId: uuidv7(),
      kind: 'capture.plan',
      target: {},
      payload: {},
      expectedState: {},
      intentChange: false,
    };
    await expect(
      runProjectOperation(generic, operation, (tx) => {
        tx.run(
          'INSERT INTO repository_creation VALUES (1,1,?,?,?,?)',
          input.repositoryCreation.commonDirectory,
          '1',
          '2',
          null
        );
        return null;
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(generic.read((view) => view.all('SELECT * FROM repository_creation')).value).toEqual([]);
    expect(generic.read((view) => view.all('SELECT * FROM operations')).value).toEqual([]);
  });
  it('reads only canonical initialization facts without loading artifact rows or checking domain references', async () => {
    const { selected } = await created();
    const queries = vi.spyOn(Database.prototype, 'prepare');
    const pragmas = vi.spyOn(Database.prototype, 'pragma');
    await readProjectInitializationCandidate(selected);
    expect(
      queries.mock.calls.some(([sql]) =>
        /\bFROM\s+(artifact_events|artifacts|artifact_revisions|operations|project_counters)\b/i.test(
          sql
        )
      )
    ).toBe(false);
    expect(pragmas.mock.calls.some(([sql]) => /foreign_key_check/.test(sql))).toBe(false);
  });
  it('reports absent expected candidates without initializing missing files or directories', async () => {
    const { selected, file } = await fixture();
    await expect(readProjectInitializationCandidate(selected)).rejects.toMatchObject({
      code: 'HISTORY_MISSING',
    });
    expect(await readdir(path.dirname(file))).toEqual([]);
    await rm(path.dirname(file), { recursive: true });
    await expect(readProjectInitializationCandidate(selected)).rejects.toMatchObject({
      code: 'HISTORY_MISSING',
    });
    expect(await readdir(path.dirname(path.dirname(file)))).toEqual([]);
  });
  it('refuses malformed creation and occupied sidecar paths without a write-capable open', async () => {
    const { input, selected, file } = await fixture();
    await mkdir(`${file}-wal`);
    await expect(initializeRepositoryDatabase(input)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    expect(await readdir(path.dirname(file))).toEqual(['history.sqlite3-wal']);
    await rm(`${file}-wal`, { recursive: true });
    const handle = await initializeRepositoryDatabase(input);
    handles.push(handle);
    const raw = new Database(file);
    raw.exec('DROP TRIGGER repository_creation_no_update');
    raw.prepare('UPDATE repository_creation SET inode=?').run('rounded');
    raw.close();
    const pragmas = vi.spyOn(Database.prototype, 'pragma');
    await expect(readProjectInitializationCandidate(selected)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    expect(pragmas.mock.calls.some(([sql]) => /^(journal_mode|synchronous)\s*=/i.test(sql))).toBe(
      false
    );
  });
  it('protects symlinked candidate directories with a typed path refusal', async () => {
    const { selected, file } = await fixture();
    await rm(path.dirname(file), { recursive: true });
    const unrelated = path.join(selected.root, 'protected');
    await mkdir(unrelated);
    await symlink(unrelated, path.dirname(file));
    await expect(readProjectInitializationCandidate(selected)).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
      name: 'ProjectDatabaseError',
    });
    expect(await readdir(unrelated)).toEqual([]);
  });
  it('reports genuine exclusive contention as unavailable and reads original identity after release', async () => {
    const { input, selected, file } = await fixture();
    (await initializeRepositoryDatabase(input)).close();
    const exclusive = new Database(file);
    try {
      exclusive.pragma('locking_mode = EXCLUSIVE');
      exclusive.exec('BEGIN EXCLUSIVE');
      await expect(readProjectInitializationCandidate(selected)).rejects.toMatchObject({
        code: 'HISTORY_INACCESSIBLE',
        reason: 'contention',
      });
    } finally {
      if (exclusive.inTransaction) exclusive.exec('ROLLBACK');
      exclusive.close();
    }
    expect((await readProjectInitializationCandidate(selected)).authority).toEqual(input.authority);
  });
  it.each(['SQLITE_IOERR', 'SQLITE_CANTOPEN', 'SQLITE_LOCKED'])(
    'preserves genuine %s as unavailable without broadening retry',
    async (code) => {
      const { selected } = await created();
      const original = Database.prototype.pragma;
      const cause = new Database.SqliteError('injected driver failure', code);
      const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
        this: Database.Database,
        sql: string,
        options?: Database.PragmaOptions
      ) {
        if (sql === 'user_version') throw cause;
        return original.call(this, sql, options);
      });
      await expect(readProjectInitializationCandidate(selected)).rejects.toMatchObject({
        code: 'HISTORY_INACCESSIBLE',
        cause,
        reason:
          code === 'SQLITE_IOERR' ? 'io' : code === 'SQLITE_LOCKED' ? 'contention' : undefined,
      });
      expect(spy.mock.calls.filter(([sql]) => sql === 'user_version')).toHaveLength(1);
    }
  );
  it('does not trust corruption-looking properties on an unknown failure', async () => {
    const { selected } = await created();
    const original = Database.prototype.pragma;
    const cause = Object.assign(new Error('unknown observation failure'), {
      code: 'SQLITE_CORRUPT',
    });
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      options?: Database.PragmaOptions
    ) {
      if (sql === 'user_version') throw cause;
      return original.call(this, sql, options);
    });
    await expect(readProjectInitializationCandidate(selected)).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
      cause,
      reason: undefined,
    });
  });
  it('distinguishes actual invalid database bytes from temporary unavailability', async () => {
    const { selected, file } = await fixture();
    await writeFile(file, 'Retained invalid database evidence');
    await expect(readProjectInitializationCandidate(selected)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
      reason: 'integrity',
    });
  });
  it('reports empty version-zero initialization as pending without adopting or writing', async () => {
    const { selected, file } = await fixture();
    await writeFile(file, Buffer.alloc(0));
    const identity = await stat(file, { bigint: true });
    const before = await readFile(file);
    const failure = await readProjectInitializationCandidate(selected).catch((cause) => cause);
    expect(failure).toMatchObject({ code: 'ACTIVATION_PENDING' });
    expect(readProjectInitializationObservation(failure)).toEqual({
      path: file,
      dev: identity.dev,
      ino: identity.ino,
    });
    expect(await readFile(file)).toEqual(before);
    expect(await readdir(path.dirname(file))).toEqual(['history.sqlite3']);
  });
  it('refuses a candidate whose main file differs from the caller observation', async () => {
    const { selected, file } = await created();
    const observed = await stat(file, { bigint: true });
    await expect(
      readProjectInitializationCandidate({
        ...selected,
        expectedMainFileIdentity: { dev: observed.dev, ino: observed.ino + 1n },
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  });
  it('keeps version-zero databases with objects unsupported and preserves their bytes', async () => {
    const { selected, file } = await fixture();
    const raw = new Database(file);
    raw.exec('CREATE TABLE unrelated(value TEXT)');
    raw.close();
    const before = await readFile(file);
    await expect(readProjectInitializationCandidate(selected)).rejects.toMatchObject({
      code: 'HISTORY_FORMAT_UNSUPPORTED',
    });
    expect(await readFile(file)).toEqual(before);
  });
});
