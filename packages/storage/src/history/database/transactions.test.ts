import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  claimProjectConnection,
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  readProjectDisplayName,
  repositoryDisplayName,
  retainProjectDisplayName,
} from './project-name.js';
import {
  type ProjectOperation,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const rawConnections: Database.Database[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const raw of rawConnections.splice(0)) if (raw.open) raw.close();
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'project-operation-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
  });
  handles.push(handle);
  const raw = new Database(handle.databasePath);
  raw.exec('CREATE TABLE accepted_records (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT');
  rawConnections.push(raw);
  const operation: ProjectOperation = {
    operationId: uuidv7(),
    kind: 'capture.plan',
    target: { artifactId: uuidv7() },
    payload: { text: 'original accepted text' },
    expectedState: { revision: 1 },
    intentChange: true,
  };
  return { authority, handle, raw, operation };
}

function accepted(transaction: ProjectSettlement) {
  transaction.run('INSERT INTO accepted_records VALUES (?, ?)', 'event-original', 'body');
  return { eventId: 'event-original' };
}

describe('idempotent project settlement', () => {
  it('replays original results after reopening without repeating writes or counters', async () => {
    const { authority, handle, operation } = await fixture();
    const first = await runProjectOperation(handle, operation, accepted);
    const reopened = await openProjectDatabase({ authority, mode: 'writer' });
    handles.push(reopened);
    const replay = await runProjectOperation(reopened, operation, () => {
      throw new Error('must not run');
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first.counters).toEqual({ writeSequence: 2, intentChangeCounter: 1 });
    expect(handle.read((view) => view.all('SELECT * FROM accepted_records')).value).toEqual([
      { id: 'event-original', body: 'body' },
    ]);
    expect(handle.read(() => null).counters).toEqual(first.counters);
  });

  it.each(['target', 'payload', 'expectedState', 'intentChange', 'kind'] as const)(
    'refuses reuse with changed %s',
    async (field) => {
      const { handle, operation } = await fixture();
      await runProjectOperation(handle, operation, accepted);
      const changed = {
        ...operation,
        [field]:
          field === 'intentChange'
            ? false
            : field === 'kind'
              ? 'capture.summary'
              : { different: true },
      };
      await expect(runProjectOperation(handle, changed, () => null)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(handle.read(() => null).counters).toEqual({
        writeSequence: 2,
        intentChangeCounter: 1,
      });
    }
  );

  it('advances write sequence for authoritative non-intent results only once', async () => {
    const { handle, operation } = await fixture();
    await runProjectOperation(
      handle,
      { ...operation, kind: 'usage.record', intentChange: false },
      () => ({ usageId: 'source-original' })
    );
    expect(handle.read(() => null).counters).toEqual({ writeSequence: 2, intentChangeCounter: 0 });
  });

  it('rolls back a stale authored target without re-preparing it', async () => {
    const { handle, operation } = await fixture();
    const cause = Object.assign(new Error('domain revision changed'), { code: 'REVISION_CHANGED' });
    const translated = new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Run A is no longer current; create a new operation for new authored inputs',
      { cause }
    );
    const settle = vi.fn((tx: ProjectSettlement) => {
      accepted(tx);
      throw translated;
    });
    await expect(runProjectOperation(handle, operation, settle)).rejects.toBe(translated);
    expect(translated.cause).toBe(cause);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(handle.read((view) => view.all('SELECT * FROM accepted_records')).value).toEqual([]);
    expect(handle.read((view) => view.all('SELECT * FROM operations')).value).toEqual([]);
    expect(handle.read(() => null).counters).toEqual({ writeSequence: 1, intentChangeCounter: 0 });
  });

  it('retains detached immutable preparation while waiting', async () => {
    const { handle, raw, operation } = await fixture();
    raw.exec('BEGIN IMMEDIATE');
    const mutable = { ...operation, payload: { text: 'before wait' } };
    const result = await runProjectOperation(
      handle,
      mutable,
      (_tx, prepared) => {
        expect(Object.isFrozen(prepared.payload)).toBe(true);
        return prepared.payload;
      },
      {
        onWait() {
          mutable.payload.text = 'after wait';
          raw.exec('ROLLBACK');
        },
      }
    );
    expect(result.value).toEqual({ text: 'before wait' });
  });

  it('invalidates escaped settlement views permanently', async () => {
    const { handle, operation } = await fixture();
    let escaped: ProjectSettlement | undefined;
    await runProjectOperation(handle, operation, (tx) => {
      escaped = tx;
      return null;
    });
    await expect(
      runProjectOperation(handle, { ...operation, operationId: uuidv7() }, () =>
        escaped!.get<null>('SELECT 1')
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(() => handle.read(() => escaped!.all('SELECT 1'))).toThrow('transaction ended');
  });

  it('rolls back invalid asynchronous or mutable-handle results', async () => {
    const { handle, operation } = await fixture();
    await expect(
      runProjectOperation(handle, operation, ((tx: ProjectSettlement) => {
        accepted(tx);
        return Promise.resolve(null);
      }) as never)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(handle.read((view) => view.all('SELECT * FROM accepted_records')).value).toEqual([]);
    expect(handle.read(() => null).counters.writeSequence).toBe(1);
  });

  it('refuses counter overflow and preserves the original committed rows', async () => {
    const { handle, raw, operation } = await fixture();
    raw.prepare('UPDATE project_counters SET write_sequence = ?').run(Number.MAX_SAFE_INTEGER);
    await expect(runProjectOperation(handle, operation, accepted)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    expect(handle.read((view) => view.all('SELECT * FROM accepted_records')).value).toEqual([]);
    expect(handle.read(() => null).counters.writeSequence).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('transaction failure classification', () => {
  it.each(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE'])(
    'bounds active %s retries with rollback and original identity',
    async (code) => {
      const { handle, operation } = await fixture();
      const settle = vi.fn((tx: ProjectSettlement) => {
        accepted(tx);
        if (settle.mock.calls.length < 3)
          throw new Database.SqliteError('injected active failure', code);
        return { eventId: 'event-original' };
      });
      const waits = vi.fn();
      const result = await runProjectOperation(handle, operation, settle, { onWait: waits });
      expect(settle).toHaveBeenCalledTimes(3);
      expect(waits).toHaveBeenCalledTimes(2);
      expect(result.counters).toEqual({ writeSequence: 2, intentChangeCounter: 1 });
      expect(handle.read((view) => view.all('SELECT * FROM accepted_records')).value).toHaveLength(
        1
      );
    }
  );

  it.each([
    ['SQLITE_CONSTRAINT_UNIQUE', 'constraint'],
    ['SQLITE_ERROR', 'invalid-sql'],
    ['SQLITE_READONLY', 'read-only'],
    ['SQLITE_FULL', 'disk-full'],
    ['SQLITE_CORRUPT', 'integrity'],
    ['SQLITE_NOTADB', 'integrity'],
    ['SQLITE_IOERR', 'io'],
    ['SQLITE_IOERR_WRITE', 'io'],
    ['SQLITE_IOERR_BLOCKED', 'io'],
  ])('never retries terminal %s', async (code, reason) => {
    const { handle, operation } = await fixture();
    const settle = vi.fn((tx: ProjectSettlement) => {
      accepted(tx);
      throw new Database.SqliteError('injected terminal failure', code);
    });
    await expect(runProjectOperation(handle, operation, settle)).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      reason,
      cause: { code },
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(handle.read((view) => view.all('SELECT * FROM accepted_records')).value).toEqual([]);
    expect(handle.read(() => null).counters.writeSequence).toBe(1);
  });

  it.each([
    Object.assign(new Error('private application failure'), { code: 'SQLITE_BUSY' }),
    Object.assign(new Error('private application failure'), { code: 'SQLITE_FULL' }),
    new Database.SqliteError('unrecognized driver code', 'SQLITE_BUSY_UNKNOWN'),
  ])('does not infer retryability or a reason from unrecognized failure %s', async (cause) => {
    const { handle, operation } = await fixture();
    const settle = vi.fn((tx: ProjectSettlement) => {
      accepted(tx);
      throw cause;
    });
    await expect(runProjectOperation(handle, operation, settle)).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      reason: undefined,
      cause,
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(handle.read((view) => view.all('SELECT * FROM accepted_records')).value).toEqual([]);
    expect(handle.read((view) => view.all('SELECT * FROM operations')).value).toEqual([]);
    expect(handle.read(() => null).counters).toEqual({ writeSequence: 1, intentChangeCounter: 0 });
  });

  it('returns retry exhaustion after three active attempts', async () => {
    const { handle, operation } = await fixture();
    const settle = vi.fn(() => {
      throw new Database.SqliteError('busy', 'SQLITE_BUSY');
    });
    await expect(
      runProjectOperation(handle, operation, settle, { onWait() {} })
    ).rejects.toMatchObject({ code: 'TRANSACTION_RETRY_EXHAUSTED' });
    expect(settle).toHaveBeenCalledTimes(3);
    expect(handle.read(() => null).counters.writeSequence).toBe(1);
  });

  it('explicitly rolls back a busy COMMIT before retrying', async () => {
    const { handle, operation } = await fixture();
    const state = claimProjectConnection(handle);
    state.busy = false;
    const original = state.database.exec.bind(state.database);
    let commits = 0;
    let rolledBack = false;
    vi.spyOn(state.database, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT' && commits++ === 0) {
        expect(state.database.inTransaction).toBe(true);
        throw new Database.SqliteError('busy commit', 'SQLITE_BUSY');
      }
      if (sql === 'ROLLBACK') rolledBack = true;
      if (sql === 'BEGIN IMMEDIATE' && commits > 0) expect(rolledBack).toBe(true);
      return original(sql);
    });
    const result = await runProjectOperation(handle, operation, accepted, { onWait() {} });
    expect(result.value).toEqual({ eventId: 'event-original' });
    expect(handle.read(() => null).counters.writeSequence).toBe(2);
  });

  it('closes a connection after rollback failure and preserves both errors', async () => {
    const { handle, operation } = await fixture();
    const state = claimProjectConnection(handle);
    state.busy = false;
    const original = state.database.exec.bind(state.database);
    vi.spyOn(state.database, 'exec').mockImplementation((sql) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return original(sql);
    });
    await expect(
      runProjectOperation(handle, operation, () => {
        throw new Error('settlement failed');
      })
    ).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      cause: {
        errors: [
          expect.objectContaining({ message: 'settlement failed' }),
          expect.objectContaining({ message: 'rollback failed' }),
        ],
      },
    });
    expect(state.database.open).toBe(false);
    expect(() => handle.read(() => null)).toThrow('connection is poisoned');
  });
});

describe('connection protection', () => {
  it('poisons a connection even when rollback and close both fail', async () => {
    const { handle, operation } = await fixture();
    const state = claimProjectConnection(handle);
    state.busy = false;
    const original = state.database.exec.bind(state.database);
    vi.spyOn(state.database, 'exec').mockImplementation((sql) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return original(sql);
    });
    vi.spyOn(state.database, 'close').mockImplementation(() => {
      throw new Error('close failed');
    });
    await expect(
      runProjectOperation(handle, operation, () => {
        throw new Error('settlement failed');
      })
    ).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      cause: {
        errors: [
          expect.objectContaining({ message: 'settlement failed' }),
          expect.objectContaining({ message: 'rollback failed' }),
          expect.objectContaining({ message: 'close failed' }),
        ],
      },
    });
    expect(state.database.open).toBe(true);
    expect(() => handle.read(() => null)).toThrow('connection is poisoned');
    await expect(runProjectOperation(handle, operation, () => null)).rejects.toThrow(
      'connection is poisoned'
    );
  });

  it('preserves a genuine driver reason through rollback and close failures', async () => {
    const { handle, raw, operation } = await fixture();
    raw.prepare('INSERT INTO accepted_records VALUES (?, ?)').run('event-original', 'retained');
    const state = claimProjectConnection(handle);
    state.busy = false;
    const original = state.database.exec.bind(state.database);
    const rollbackFailure = new Database.SqliteError('Injected rollback I/O', 'SQLITE_IOERR');
    const closeFailure = new Error('Injected close failure');
    vi.spyOn(state.database, 'exec').mockImplementation((sql) => {
      if (sql === 'ROLLBACK') throw rollbackFailure;
      return original(sql);
    });
    vi.spyOn(state.database, 'close').mockImplementation(() => {
      throw closeFailure;
    });
    const onWait = vi.fn();
    const error = await runProjectOperation(handle, operation, accepted, { onWait }).catch(
      (cause: unknown) => cause
    );
    expect(error).toMatchObject({
      code: 'TRANSACTION_FAILED',
      reason: 'constraint',
      cause: expect.any(AggregateError),
    });
    const causes = (error as Error & { cause: AggregateError }).cause.errors;
    expect(causes[0]).toBeInstanceOf(Database.SqliteError);
    expect(causes[0]).toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    expect(causes.slice(1)).toEqual([rollbackFailure, closeFailure]);
    expect(onWait).not.toHaveBeenCalled();
    expect(() => handle.read(() => null)).toThrow('connection is poisoned');
    await expect(runProjectOperation(handle, operation, () => null)).rejects.toThrow(
      'connection is poisoned'
    );
    vi.restoreAllMocks();
    handle.close();
    expect(raw.prepare('SELECT * FROM accepted_records').all()).toEqual([
      { id: 'event-original', body: 'retained' },
    ]);
    expect(raw.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
    expect(
      raw.prepare('SELECT write_sequence, intent_change_counter FROM project_counters').get()
    ).toEqual({ write_sequence: 1, intent_change_counter: 0 });
  });

  it('never settles authoritative operations on a readonly reader', async () => {
    const { authority, operation } = await fixture();
    const reader = await openProjectDatabase({ authority, mode: 'reader' });
    handles.push(reader);
    await expect(runProjectOperation(reader, operation, accepted)).rejects.toThrow(
      'connection is readonly'
    );
    expect(reader.read(() => null).counters.writeSequence).toBe(1);
  });

  it('revalidates the schema before a previously opened writer settles', async () => {
    const { handle, raw, operation } = await fixture();
    raw.pragma('user_version = 99');
    const callback = vi.fn(() => null);
    await expect(runProjectOperation(handle, operation, callback)).rejects.toMatchObject({
      code: 'HISTORY_FORMAT_NEWER',
    });
    expect(callback).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT * FROM operations').all()).toEqual([]);
  });
});

describe('cancellable admission', () => {
  it('names contention, cancels without rows and permits the original retry', async () => {
    const { handle, raw, operation } = await fixture();
    raw.exec('BEGIN IMMEDIATE');
    const controller = new AbortController();
    const waits = vi.fn(() => controller.abort());
    await expect(
      runProjectOperation(handle, operation, accepted, { signal: controller.signal, onWait: waits })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(waits).toHaveBeenCalledWith({
      operation: 'capture.plan',
      reason: 'admission',
      attempt: 1,
    });
    expect(handle.read((view) => view.all('SELECT * FROM operations')).value).toEqual([]);
    raw.exec('ROLLBACK');
    await expect(runProjectOperation(handle, operation, accepted)).resolves.toMatchObject({
      replayed: false,
    });
  });

  it('honors cancellation before settlement commit without deleting existing history', async () => {
    const { handle, operation } = await fixture();
    const controller = new AbortController();
    await expect(
      runProjectOperation(
        handle,
        operation,
        (tx) => {
          accepted(tx);
          controller.abort();
          return null;
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(handle.read((view) => view.all('SELECT * FROM accepted_records')).value).toEqual([]);
    expect(handle.read(() => null).counters.writeSequence).toBe(1);
  });

  it('returns a known committed result when cancellation arrives after COMMIT', async () => {
    const { handle, operation } = await fixture();
    const controller = new AbortController();
    const state = claimProjectConnection(handle);
    state.busy = false;
    const original = state.database.exec.bind(state.database);
    vi.spyOn(state.database, 'exec').mockImplementation((sql) => {
      const value = original(sql);
      if (sql === 'COMMIT') controller.abort();
      return value;
    });
    await expect(
      runProjectOperation(handle, operation, accepted, { signal: controller.signal })
    ).resolves.toMatchObject({ value: { eventId: 'event-original' }, replayed: false });
  });
});

it('retains the original project name across retries and passive opens', async () => {
  const { handle, authority } = await fixture();
  expect(readProjectDisplayName(handle)).toBeNull();
  const input = { operationId: uuidv7(), displayName: 'Orcaops' };
  await retainProjectDisplayName(handle, input);
  const before = handle.read(() => null).counters;
  await retainProjectDisplayName(handle, input);
  expect(handle.read(() => null).counters).toEqual(before);
  await expect(
    retainProjectDisplayName(handle, { ...input, displayName: 'Changed' })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await retainProjectDisplayName(handle, { operationId: uuidv7(), displayName: 'Renamed folder' });
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  const retained = reader.read(() => null).counters;
  expect(readProjectDisplayName(reader)).toBe('Orcaops');
  expect(reader.read(() => null).counters).toEqual(retained);
  expect(retained.intentChangeCounter).toBe(0);
  expect(repositoryDisplayName('/deleted/main-repo/.git')).toBe('main-repo');
  expect(repositoryDisplayName('/deleted/bare-repo.git')).toBe('bare-repo');
});
