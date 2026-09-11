import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  claimProjectConnection,
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  projectDatabasePath,
  type ProjectReadView,
} from './connection.js';
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, lstatSync: vi.fn(original.lstatSync) };
});
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const selected = await mkdtemp(path.join(tmpdir(), 'project-database-'));
  const root = await normalizeHistoryRoot({ root: selected });
  roots.push(root.resolvedRoot);
  const authority: ProjectDatabaseAuthority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const directory = path.dirname(projectDatabasePath(authority));
  await mkdir(directory, { recursive: true });
  const input = {
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
  };
  return { authority, directory, input };
}
async function initialized() {
  const result = await fixture();
  const handle = await initializeProjectDatabase(result.input);
  handles.push(handle);
  return { ...result, handle };
}
describe('project database authority', () => {
  it.each(['reader', 'writer'] as const)(
    'refuses a missing retained-history trigger before opening a %s',
    async (mode) => {
      const { authority, input } = await fixture();
      (await initializeProjectDatabase(input)).close();
      const file = projectDatabasePath(authority);
      const raw = new Database(file);
      const before = raw.prepare('SELECT * FROM operations').all();
      const counters = raw.prepare('SELECT * FROM project_counters').all();
      raw.exec('DROP TRIGGER review_run_finalizations_no_replace');
      raw.close();
      const pragma = vi.spyOn(Database.prototype, 'pragma');
      await expect(openProjectDatabase({ authority, mode })).rejects.toMatchObject({
        code: 'HISTORY_INTEGRITY_REQUIRED',
      });
      expect(pragma.mock.calls.some(([sql]) => sql === 'journal_mode = WAL')).toBe(false);
      const observed = new Database(file, { readonly: true, fileMustExist: true });
      try {
        expect(observed.prepare('SELECT * FROM operations').all()).toEqual(before);
        expect(observed.prepare('SELECT * FROM project_counters').all()).toEqual(counters);
        expect(
          observed
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE name='review_run_finalizations_no_replace'"
            )
            .get()
        ).toBeUndefined();
      } finally {
        observed.close();
      }
    }
  );
  it('validates ordinary open definitions without a retained-row foreign key scan', async () => {
    const { authority, input } = await fixture();
    (await initializeProjectDatabase(input)).close();
    const pragma = vi.spyOn(Database.prototype, 'pragma');
    const reader = await openProjectDatabase({ authority, mode: 'reader' });
    handles.push(reader);
    expect(reader.read(() => null).counters).toEqual({ writeSequence: 1, intentChangeCounter: 0 });
    expect(pragma.mock.calls.some(([sql]) => /foreign_key_check/i.test(sql))).toBe(false);
  });

  it.each(['before validation', 'before the writer handle'] as const)(
    'refuses an open cancelled %s without returning a handle',
    async (moment) => {
      const { authority, input } = await fixture();
      (await initializeProjectDatabase(input)).close();
      const controller = new AbortController();
      const originalClose = Database.prototype.close;
      if (moment === 'before validation') controller.abort();
      // The validating reader is closed immediately before the writer handle is opened,
      // which is the last moment an interrupt can be observed without stranding one.
      else
        vi.spyOn(Database.prototype, 'close').mockImplementationOnce(function (
          this: Database.Database
        ) {
          controller.abort();
          return originalClose.call(this);
        });
      await expect(
        openProjectDatabase({ authority, mode: 'writer', signal: controller.signal })
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      vi.restoreAllMocks();
      const reader = await openProjectDatabase({ authority, mode: 'reader' });
      handles.push(reader);
      expect(reader.read(() => null).counters).toEqual({
        writeSequence: 1,
        intentChangeCounter: 0,
      });
    }
  );

  it('reports known database contention without diagnosing corruption', async () => {
    const { authority, input } = await fixture();
    (await initializeProjectDatabase(input)).close();
    const exclusive = new Database(projectDatabasePath(authority));
    try {
      exclusive.pragma('locking_mode = EXCLUSIVE');
      exclusive.exec('BEGIN EXCLUSIVE');
      await expect(openProjectDatabase({ authority, mode: 'reader' })).rejects.toMatchObject({
        code: 'HISTORY_INACCESSIBLE',
        reason: 'contention',
      });
    } finally {
      if (exclusive.inTransaction) exclusive.exec('ROLLBACK');
      exclusive.close();
    }
    const reader = await openProjectDatabase({ authority, mode: 'reader' });
    handles.push(reader);
    expect(reader.authority).toEqual(authority);
    expect(reader.read(() => null).counters).toEqual({ writeSequence: 1, intentChangeCounter: 0 });
  });

  it.each(['rollback', 'close', 'both'] as const)(
    'preserves missing expected history when %s cleanup fails',
    async (failure) => {
      const { authority } = await initialized();
      const rollbackFailure = new Error('Injected rollback failure');
      const closeFailure = new Error('Injected close failure');
      const originalExec = Database.prototype.exec;
      const originalClose = Database.prototype.close;
      const exec = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
        this: Database.Database,
        sql
      ) {
        if (sql === 'ROLLBACK' && failure !== 'close') throw rollbackFailure;
        return originalExec.call(this, sql);
      });
      const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
        this: Database.Database
      ) {
        const result = originalClose.call(this);
        if (failure !== 'rollback') throw closeFailure;
        return result;
      });
      const error = await openProjectDatabase({
        authority: { ...authority, storeInstanceId: uuidv7() },
        mode: 'reader',
      }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: 'HISTORY_MISSING', cause: expect.any(AggregateError) });
      expect((error as Error).cause).toMatchObject({
        errors: [
          expect.objectContaining({ code: 'HISTORY_MISSING' }),
          ...(failure !== 'close' ? [rollbackFailure] : []),
          ...(failure !== 'rollback' ? [closeFailure] : []),
        ],
      });
      expect(close).toHaveBeenCalledOnce();
      exec.mockRestore();
      close.mockRestore();
      const reader = await openProjectDatabase({ authority, mode: 'reader' });
      handles.push(reader);
      expect(reader.read(() => null).counters).toEqual({
        writeSequence: 1,
        intentChangeCounter: 0,
      });
    }
  );

  it('does not open a writer when its readonly validation handle cannot close', async () => {
    const { authority } = await initialized();
    const originalClose = Database.prototype.close;
    const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
      this: Database.Database
    ) {
      originalClose.call(this);
      throw new Error('Injected close failure');
    });
    const pragma = vi.spyOn(Database.prototype, 'pragma');
    await expect(openProjectDatabase({ authority, mode: 'writer' })).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
      cause: expect.any(AggregateError),
    });
    expect(pragma.mock.calls.some(([sql]) => sql === 'journal_mode = WAL')).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ['ENOENT', 'HISTORY_MISSING'],
    ['ENOTDIR', 'HISTORY_MISSING'],
    ['EACCES', 'HISTORY_INACCESSIBLE'],
    ['EPERM', 'HISTORY_INACCESSIBLE'],
    ['EIO', 'HISTORY_INACCESSIBLE'],
    [undefined, 'HISTORY_INACCESSIBLE'],
  ])(
    'classifies failed main-file inspection %s without querying history',
    async (code, expected) => {
      const { handle } = await initialized();
      const cause = Object.assign(new Error('injected filesystem failure'), { code });
      const inspection = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
        throw cause;
      });
      const queries = vi.spyOn(Database.prototype, 'exec');
      expect(() => handle.read(() => null)).toThrow(
        expect.objectContaining({ code: expected, cause })
      );
      expect(() => claimProjectConnection(handle)).toThrow(
        expect.objectContaining({ code: expected, cause })
      );
      expect(queries).not.toHaveBeenCalled();
      inspection.mockRestore();
      expect(handle.read(() => null).counters).toEqual({
        writeSequence: 1,
        intentChangeCounter: 0,
      });
    }
  );

  it('requires integrity repair when the main path becomes nonregular', async () => {
    const { handle } = await initialized();
    const directory = fs.lstatSync(path.dirname(handle.databasePath), { bigint: true });
    const inspection = vi.spyOn(fs, 'lstatSync').mockReturnValue(directory);
    const queries = vi.spyOn(Database.prototype, 'exec');
    expect(() => handle.read(() => null)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(() => claimProjectConnection(handle)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(queries).not.toHaveBeenCalled();
    inspection.mockRestore();
    expect(handle.read(() => null).counters).toEqual({ writeSequence: 1, intentChangeCounter: 0 });
  });

  it.each([undefined, null, 'read-only', 'write', ''])(
    'rejects invalid access mode %s before opening the database',
    async (mode) => {
      const { authority, handle } = await initialized();
      const before = await readFile(handle.databasePath);
      const pragmas = vi.spyOn(Database.prototype, 'pragma');
      await expect(openProjectDatabase({ authority, mode } as never)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(pragmas).not.toHaveBeenCalled();
      expect(await readFile(handle.databasePath)).toEqual(before);
    }
  );

  it('keeps the accepted readonly mode when the caller mutates its request', async () => {
    const { authority } = await initialized();
    const input: { authority: ProjectDatabaseAuthority; mode: 'reader' | 'writer' } = {
      authority,
      mode: 'reader',
    };
    const opening = openProjectDatabase(input);
    input.mode = 'writer';
    const reader = await opening;
    handles.push(reader);
    const state = claimProjectConnection(reader, 'reader');
    expect(state.database.readonly).toBe(true);
    state.busy = false;
    expect(reader.read(() => null).counters.writeSequence).toBe(1);
  });

  it('commits original identity and activation with WAL FULL durability', async () => {
    const { authority, handle, input } = await initialized();
    const result = handle.read((view) => ({
      identity: view.get<Record<string, unknown>>('SELECT * FROM store_identity'),
      activation: view.get<Record<string, unknown>>('SELECT * FROM activation'),
      journal: view.get<Record<string, unknown>>('SELECT * FROM pragma_journal_mode'),
      synchronous: view.get<Record<string, unknown>>('SELECT * FROM pragma_synchronous'),
      foreignKeys: view.get<Record<string, unknown>>('SELECT * FROM pragma_foreign_keys'),
    }));
    expect(result.value.identity).toMatchObject({
      project_id: authority.projectId,
      store_instance_id: authority.storeInstanceId,
      initialization_operation_id: input.initializationOperationId,
    });
    expect(result.value.activation).toMatchObject({
      state: 'active',
      initialized_at: input.initializedAt,
    });
    expect(result.value.journal).toEqual({ journal_mode: 'wal' });
    expect(result.value.synchronous).toEqual({ synchronous: 2 });
    expect(result.value.foreignKeys).toEqual({ foreign_keys: 1 });
    expect(result.counters).toEqual({ writeSequence: 1, intentChangeCounter: 0 });
  });
  it('refuses before creating a database or sidecars', async () => {
    const { input, directory } = await fixture();
    await expect(
      initializeProjectDatabase({
        ...input,
        authorize() {
          throw new Error('refused input');
        },
      })
    ).rejects.toThrow('refused input');
    expect(await readdir(directory)).toEqual([]);
  });
  it('never initializes missing expected history', async () => {
    const { authority, directory } = await fixture();
    for (const mode of ['reader', 'writer'] as const) {
      await expect(openProjectDatabase({ authority, mode })).rejects.toMatchObject({
        code: 'HISTORY_MISSING',
      });
    }
    expect(await readdir(directory)).toEqual([]);
  });
  it('does not direct a missing expected project directory into setup', async () => {
    const { authority, directory } = await fixture();
    await rm(directory, { recursive: true });
    const error = await openProjectDatabase({ authority, mode: 'reader' }).catch(
      (cause: unknown) => cause
    );
    expect(error).toMatchObject({
      code: 'HISTORY_MISSING',
      message: expect.stringContaining('run `orcaops doctor`'),
    });
    expect((error as Error).message).toContain('setup cannot replace missing history');
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses different project, repository and store identities', async () => {
    const { authority } = await initialized();
    await expect(
      openProjectDatabase({
        authority: { ...authority, storeInstanceId: uuidv7() },
        mode: 'writer',
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
    await expect(
      openProjectDatabase({
        authority: { ...authority, repositoryInstanceId: uuidv7() },
        mode: 'writer',
      })
    ).rejects.toMatchObject({ code: 'AUTHORITY_MISMATCH' });
    await expect(
      openProjectDatabase({ authority: { ...authority, projectId: uuidv7() }, mode: 'writer' })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  });
  it('does not adopt an occupied empty database or unsupported schema', async () => {
    const { input, authority } = await fixture();
    await writeFile(projectDatabasePath(authority), '');
    await expect(initializeProjectDatabase(input)).rejects.toMatchObject({
      code: 'HISTORY_FORMAT_UNSUPPORTED',
    });
    const raw = new Database(projectDatabasePath(authority));
    raw.pragma('user_version = 200');
    raw.close();
    await expect(openProjectDatabase({ authority, mode: 'writer' })).rejects.toMatchObject({
      code: 'HISTORY_FORMAT_UNSUPPORTED',
    });
  });
  it('refuses internal symlinks before opening SQLite', async () => {
    const { input, authority, directory } = await fixture();
    await symlink(path.join(directory, 'elsewhere'), projectDatabasePath(authority));
    await expect(initializeProjectDatabase(input)).rejects.toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
    });
    expect(await readdir(directory)).toEqual(['history.sqlite3']);
  });
  it('reads existing history readonly after the last writer removes sidecars', async () => {
    const { authority, handle, directory } = await initialized();
    handle.close();
    handles.splice(handles.indexOf(handle), 1);
    const before = await readFile(projectDatabasePath(authority));
    const reader = await openProjectDatabase({ authority, mode: 'reader' });
    handles.push(reader);
    const state = claimProjectConnection(reader, 'reader');
    expect(state.database.readonly).toBe(true);
    expect(() =>
      state.database.prepare('UPDATE project_counters SET write_sequence = 5').run()
    ).toThrow();
    state.busy = false;
    expect(reader.read(() => 'materialized').counters).toEqual({
      writeSequence: 1,
      intentChangeCounter: 0,
    });
    expect((await readFile(projectDatabasePath(authority))).equals(before)).toBe(true);
    expect(
      (await readdir(directory)).filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))
    ).toEqual(['history.sqlite3']);
  });

  it('preserves database and WAL history when rejecting a different instance readonly', async () => {
    const { authority } = await initialized();
    const file = projectDatabasePath(authority);
    const before = await Promise.all([readFile(file), readFile(`${file}-wal`)]);
    await expect(
      openProjectDatabase({
        authority: { ...authority, storeInstanceId: uuidv7() },
        mode: 'reader',
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
    const after = await Promise.all([readFile(file), readFile(`${file}-wal`)]);
    for (const [index, bytes] of after.entries()) expect(bytes.equals(before[index]!)).toBe(true);
  });

  it('holds a consistent short readonly snapshot across a concurrent committed update', async () => {
    const { authority, handle } = await initialized();
    const reader = await openProjectDatabase({ authority, mode: 'reader' });
    handles.push(reader);
    const writer = new Database(handle.databasePath);
    try {
      const observed = reader.read((view) => {
        const first = view.get<{ write_sequence: number }>(
          'SELECT write_sequence FROM project_counters'
        );
        writer.exec('UPDATE project_counters SET write_sequence = 2');
        const second = view.get<{ write_sequence: number }>(
          'SELECT write_sequence FROM project_counters'
        );
        return { first, second };
      });
      expect(observed.value).toEqual({
        first: { write_sequence: 1 },
        second: { write_sequence: 1 },
      });
      expect(observed.counters.writeSequence).toBe(1);
      expect(reader.read(() => null).counters.writeSequence).toBe(2);
    } finally {
      writer.close();
    }
  });
});
describe('materialized project reads', () => {
  it.each([
    'PRAGMA optimize(0x10002)',
    '  PRAGMA optimize(0x10002)',
    '/* leading comment */ PRAGMA optimize(0x10002)',
    'WITH selected AS (SELECT 1) DELETE FROM project_counters RETURNING *',
  ])('rejects write-adjacent query %s before returning rows', async (sql) => {
    const { handle } = await initialized();
    expect(() => handle.read((view) => view.all(sql))).toThrow();
    expect(handle.read(() => null).counters).toEqual({ writeSequence: 1, intentChangeCounter: 0 });
    expect(
      handle.read((view) => view.all("SELECT name FROM sqlite_schema WHERE name = 'sqlite_stat1'"))
        .value
    ).toEqual([]);
  });

  it('ends each read before returning and copies the observed counters', async () => {
    const { handle } = await initialized();
    const first = handle.read((view) =>
      view.all<{ project_id: string }>('SELECT project_id FROM store_identity')
    );
    first.value[0]!.project_id = 'changed local copy';
    expect(
      handle.read((view) => view.all('SELECT project_id FROM store_identity')).value
    ).not.toEqual(first.value);
    expect(handle.read((view) => view.get('SELECT 1 AS value')).value).toEqual({ value: 1 });
  });
  it('does not expose write statements or capabilities after read completion', async () => {
    const { handle } = await initialized();
    let escaped: ProjectReadView | undefined;
    handle.read((view) => {
      escaped = view;
      return null;
    });
    expect(() => escaped!.all('SELECT 1')).toThrow('transaction ended');
    expect(() => handle.read(() => escaped!.all('SELECT 1'))).toThrow('transaction ended');
    expect(() =>
      handle.read((view) => view.get('DELETE FROM project_counters RETURNING *'))
    ).toThrow('readonly row queries');
    expect(() => handle.read((view) => view.get('PRAGMA foreign_keys = OFF'))).toThrow(
      'readonly row queries'
    );
    expect(handle.read((view) => view.get('SELECT * FROM pragma_foreign_keys')).value).toEqual({
      foreign_keys: 1,
    });
    expect(handle.read(() => null).counters.writeSequence).toBe(1);
  });
  it('rejects promises and iterators instead of retaining a read transaction', async () => {
    const { handle } = await initialized();
    expect(() => handle.read(() => Promise.resolve('later'))).toThrow('materialized JSON');
    expect(() => handle.read(() => [1, 2].values())).toThrow('materialized JSON');
    expect(handle.read(() => 'next read').value).toBe('next read');
  });
});
