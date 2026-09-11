import Database from 'better-sqlite3';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { runProjectOperation } from './transactions.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'project-writers-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const writer = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
  });
  handles.push(writer);
  return { authority, writer };
}

it('keeps reads responsive and another project writable while a writer is suspended', async () => {
  const { authority, writer } = await fixture();
  const independent = await fixture();
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  const driver = createRequire(import.meta.url).resolve('better-sqlite3');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const Database = require(process.argv[1]);
    const database = new Database(process.argv[2]);
    database.exec('BEGIN IMMEDIATE');
    database.prepare('UPDATE project_counters SET write_sequence = 99').run();
    process.send('holding');
    process.on('message', () => { database.exec('ROLLBACK'); database.close(); process.exit(0); });
  `,
      driver,
      writer.databasePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  children.push(child);
  expect(await once(child, 'message')).toEqual(['holding', undefined]);
  child.kill('SIGSTOP');
  expect(reader.read(() => 'snapshot').counters.writeSequence).toBe(1);
  const operation = {
    operationId: uuidv7(),
    kind: 'capture.plan',
    target: { project: authority.projectId },
    payload: { accepted: true },
    expectedState: null,
    intentChange: true,
  };
  const elsewhere = await runProjectOperation(independent.writer, operation, () => ({
    independent: true,
  }));
  expect(elsewhere.value).toEqual({ independent: true });
  const controller = new AbortController();
  const waits = vi.fn(() => controller.abort());
  await expect(
    runProjectOperation(writer, operation, () => ({ retainedId: 'original' }), {
      signal: controller.signal,
      onWait: waits,
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(waits).toHaveBeenCalledWith({
    operation: 'capture.plan',
    reason: 'admission',
    attempt: 1,
  });
  expect(reader.read((view) => view.all('SELECT * FROM operations')).value).toEqual([]);
  const exited = once(child, 'exit');
  child.kill('SIGCONT');
  child.send('release');
  expect(await exited).toEqual([0, null]);
  const committed = await runProjectOperation(writer, operation, () => ({
    retainedId: 'original',
  }));
  expect(committed.counters).toEqual({ writeSequence: 2, intentChangeCounter: 1 });
  expect(reader.read((view) => view.all('SELECT operation_id FROM operations')).value).toEqual([
    { operation_id: operation.operationId },
  ]);
});

it('shows the operation and cancellation guidance while waiting on the default progress path', async () => {
  const { writer } = await fixture();
  const raw = new Database(writer.databasePath);
  raw.exec('BEGIN IMMEDIATE');
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
    raw.exec('ROLLBACK');
    return true;
  });
  try {
    await runProjectOperation(
      writer,
      {
        operationId: uuidv7(),
        kind: 'capture.summary',
        target: null,
        payload: null,
        expectedState: null,
        intentChange: false,
      },
      () => null
    );
    expect(output.mock.calls[0]![0]).toContain('Waiting for capture.summary; Ctrl-C to cancel.');
  } finally {
    raw.close();
  }
});

it.each(['deleted', 'replaced'] as const)(
  'refuses an old handle whose main file was %s',
  async (mode) => {
    const { authority, writer } = await fixture();
    const reader = await openProjectDatabase({ authority, mode: 'reader' });
    handles.push(reader);
    expect(reader.read(() => null).counters.writeSequence).toBe(1);
    const original = `${writer.databasePath}.retained`;
    renameSync(writer.databasePath, original);
    if (mode === 'replaced') writeFileSync(writer.databasePath, 'different occupied file');
    const before = await readdir(path.dirname(writer.databasePath));
    const operation = {
      operationId: uuidv7(),
      kind: 'capture.plan',
      target: null,
      payload: null,
      expectedState: null,
      intentChange: false,
    };
    expect(() => reader.read(() => null)).toThrow(
      expect.objectContaining({ code: 'HISTORY_MISSING' })
    );
    await expect(runProjectOperation(writer, operation, () => null)).rejects.toMatchObject({
      code: 'HISTORY_MISSING',
    });
    expect(await readdir(path.dirname(writer.databasePath))).toEqual(before);
  }
);

it.each(['deleted', 'replaced'] as const)(
  'refuses a waiting operation after its main file is %s',
  async (mode) => {
    const { writer } = await fixture();
    const raw = new Database(writer.databasePath);
    raw.exec('BEGIN IMMEDIATE');
    const callback = vi.fn(() => null);
    try {
      const operation = {
        operationId: uuidv7(),
        kind: 'capture.plan',
        target: null,
        payload: null,
        expectedState: null,
        intentChange: false,
      };
      await expect(
        runProjectOperation(writer, operation, callback, {
          onWait() {
            if (mode === 'deleted') unlinkSync(writer.databasePath);
            else {
              renameSync(writer.databasePath, `${writer.databasePath}.retained`);
              writeFileSync(writer.databasePath, 'different occupied file');
            }
            raw.exec('ROLLBACK');
          },
        })
      ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
      expect(callback).not.toHaveBeenCalled();
      expect(raw.prepare('SELECT * FROM operations').all()).toEqual([]);
    } finally {
      raw.close();
    }
  }
);

it('rolls back settlement when the main file disappears before COMMIT', async () => {
  const { writer } = await fixture();
  const raw = new Database(writer.databasePath);
  raw.exec('CREATE TABLE accepted_records (id TEXT PRIMARY KEY) STRICT');
  const operation = {
    operationId: uuidv7(),
    kind: 'capture.plan',
    target: null,
    payload: null,
    expectedState: null,
    intentChange: true,
  };
  try {
    await expect(
      runProjectOperation(writer, operation, (transaction) => {
        transaction.run('INSERT INTO accepted_records VALUES (?)', 'candidate');
        unlinkSync(writer.databasePath);
        return { eventId: 'candidate' };
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
    expect(raw.prepare('SELECT * FROM accepted_records').all()).toEqual([]);
    expect(raw.prepare('SELECT * FROM operations').all()).toEqual([]);
    expect(
      raw.prepare('SELECT write_sequence, intent_change_counter FROM project_counters').get()
    ).toEqual({ write_sequence: 1, intent_change_counter: 0 });
  } finally {
    raw.close();
  }
});

it('refuses a read result if its main file disappears during materialization', async () => {
  const { authority, writer } = await fixture();
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  expect(reader.read(() => 'before removal').value).toBe('before removal');
  expect(() =>
    reader.read((view) => {
      const result = view.get('SELECT project_id FROM store_identity');
      unlinkSync(writer.databasePath);
      return result;
    })
  ).toThrow(expect.objectContaining({ code: 'HISTORY_MISSING' }));
});
