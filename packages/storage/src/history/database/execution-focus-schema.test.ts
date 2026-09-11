import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { PROJECT_DATABASE_SCHEMA } from './schema.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((value) => value.close()));
function fixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.pragma('recursive_triggers = OFF');
  database.exec(PROJECT_DATABASE_SCHEMA);
  databases.push(database);
  return database;
}
function scope(session = 'original') {
  return JSON.stringify({
    rootKey: 'a'.repeat(64),
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
    worktreeId: uuidv7(),
    shellKey: { kind: 'codex_session', value: session },
  });
}
function receipt(database: Database.Database, operationId: string) {
  database
    .prepare(
      "INSERT INTO operations VALUES (?, 'focus.fixture', 0, '{}', '{}', ?, 'null', '{}', 1, 0)"
    )
    .run(operationId, 'a'.repeat(64));
}
function record(database: Database.Database, namespace: string, bytes: Buffer | null) {
  const operationId = uuidv7();
  database
    .prepare('INSERT INTO execution_focus_records VALUES (?, ?, ?, ?)')
    .run(operationId, namespace, bytes, bytes === null ? null : digest(bytes));
  return operationId;
}
function selected(database: Database.Database) {
  const namespace = scope();
  database.exec('BEGIN IMMEDIATE');
  const operationId = record(database, namespace, Buffer.from(' {"original": true}\n'));
  database
    .prepare('INSERT INTO execution_focus_current VALUES (?, ?, 1)')
    .run(namespace, operationId);
  receipt(database, operationId);
  database.exec('COMMIT');
  return { namespace, operationId };
}
function snapshot(database: Database.Database) {
  return {
    records: database.prepare('SELECT * FROM execution_focus_records ORDER BY rowid').all(),
    selections: database.prepare('SELECT * FROM execution_focus_current ORDER BY rowid').all(),
  };
}

it('retains exact bytes and explicit clear while advancing only current selection', () => {
  const database = fixture();
  const initial = selected(database);
  const original = snapshot(database).records;
  database.exec('BEGIN IMMEDIATE');
  const clear = record(database, initial.namespace, null);
  database
    .prepare(
      'UPDATE execution_focus_current SET operation_id = ?, version = 2 WHERE scope_json = ? AND version = 1'
    )
    .run(clear, initial.namespace);
  receipt(database, clear);
  database.exec('COMMIT');
  expect(snapshot(database).records).toEqual([
    ...original,
    {
      operation_id: clear,
      scope_json: initial.namespace,
      pin_bytes: null,
      pin_hash: null,
    },
  ]);
  expect(snapshot(database).selections).toEqual([
    { scope_json: initial.namespace, operation_id: clear, version: 2 },
  ]);
  expect(database.pragma('foreign_key_check')).toEqual([]);
});

it('refuses immutable record update, deletion and replacement with recursive triggers disabled', () => {
  const database = fixture();
  const initial = selected(database);
  const before = snapshot(database);
  expect(() =>
    database
      .prepare('UPDATE execution_focus_records SET pin_bytes = ? WHERE operation_id = ?')
      .run(Buffer.from('changed'), initial.operationId)
  ).toThrow('Focus history is immutable');
  expect(() => database.exec('DELETE FROM execution_focus_records')).toThrow(
    'Focus history is retained'
  );
  expect(() =>
    database
      .prepare('INSERT OR REPLACE INTO execution_focus_records VALUES (?, ?, NULL, NULL)')
      .run(initial.operationId, scope('foreign'))
  ).toThrow('Focus history is immutable');
  expect(snapshot(database)).toEqual(before);
});

it('protects current selection from deletion, replacement, namespace changes and version skips', () => {
  const database = fixture();
  const initial = selected(database);
  const before = snapshot(database);
  expect(() => database.exec('DELETE FROM execution_focus_current')).toThrow(
    'publish an explicit clear'
  );
  expect(() =>
    database
      .prepare('INSERT OR REPLACE INTO execution_focus_current VALUES (?, ?, 1)')
      .run(initial.namespace, initial.operationId)
  ).toThrow('exact version update');
  for (const [namespace, operationId, version] of [
    [scope(), uuidv7(), 2],
    [initial.namespace, uuidv7(), 3],
    [initial.namespace, initial.operationId, 2],
    [initial.namespace, uuidv7(), 0],
  ] as const) {
    expect(() =>
      database
        .prepare('UPDATE execution_focus_current SET scope_json = ?, operation_id = ?, version = ?')
        .run(namespace, operationId, version)
    ).toThrow();
  }
  expect(snapshot(database)).toEqual(before);
});

it('requires exact scoped record and operation references at commit and rolls back the whole selection', () => {
  const database = fixture();
  const initial = selected(database);
  const before = snapshot(database);
  database.exec('BEGIN IMMEDIATE');
  const pending = record(database, initial.namespace, null);
  database.prepare('UPDATE execution_focus_current SET operation_id = ?, version = 2').run(pending);
  expect(() => database.exec('COMMIT')).toThrow('FOREIGN KEY constraint failed');
  database.exec('ROLLBACK');
  expect(snapshot(database)).toEqual(before);

  database.exec('BEGIN IMMEDIATE');
  const foreign = record(database, scope(), null);
  receipt(database, foreign);
  database.prepare('UPDATE execution_focus_current SET operation_id = ?, version = 2').run(foreign);
  expect(() => database.exec('COMMIT')).toThrow('FOREIGN KEY constraint failed');
  database.exec('ROLLBACK');
  expect(snapshot(database)).toEqual(before);
});

it('keeps full session values distinct and rejects half-clear records', () => {
  const database = fixture();
  const namespace = JSON.parse(scope('shared-prefix-' + 'a'.repeat(200))) as {
    shellKey: { value: string };
  };
  database.exec('BEGIN IMMEDIATE');
  for (const suffix of ['one', 'two']) {
    const key = JSON.stringify({
      ...namespace,
      shellKey: { kind: 'codex_session', value: namespace.shellKey.value + suffix },
    });
    const id = record(database, key, null);
    receipt(database, id);
    database.prepare('INSERT INTO execution_focus_current VALUES (?, ?, 1)').run(key, id);
  }
  database.exec('COMMIT');
  expect(snapshot(database).selections).toHaveLength(2);
  for (const [bytes, hash] of [
    [null, 'a'.repeat(64)],
    [Buffer.from('{}'), null],
    [Buffer.from('{}'), 'invalid'],
  ] as const) {
    expect(() =>
      database
        .prepare('INSERT INTO execution_focus_records VALUES (?, ?, ?, ?)')
        .run(uuidv7(), scope(), bytes, hash)
    ).toThrow('CHECK constraint failed');
  }
});
