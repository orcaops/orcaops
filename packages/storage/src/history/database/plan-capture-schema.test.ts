import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { CapturePlanInputSchema } from '../../schema/capture-input.js';
import { digest } from '../event-integrity.js';
import {
  planCaptureCommand,
  preparePlanCaptureCommand,
  preparePlanCaptureInput,
} from './plan-capture-input.js';
import { PROJECT_DATABASE_SCHEMA } from './schema.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  db.exec(PROJECT_DATABASE_SCHEMA);
  return db;
}
function receipt(db: Database.Database, id: string) {
  db.prepare(
    "INSERT INTO operations VALUES (?, 'fixture.capture', 0, '{}', '{}', ?, 'null', '{}', 1, 0)"
  ).run(id, 'a'.repeat(64));
}
function command(key = 'new:plan') {
  const input = preparePlanCaptureInput(
    {
      authored: CapturePlanInputSchema.parse({
        idempotency_key: key,
        task: 'Retain original command',
        label: 'Original command',
        plan_steps: [
          {
            text: 'Retain original input',
            label: 'Retain input',
            acceptance_criteria: [{ text: 'Original command survives retry' }],
          },
        ],
      }),
      sourcePlan: null,
    },
    []
  );
  const data = planCaptureCommand(
    preparePlanCaptureCommand(input, {
      originalOperationId: uuidv7(),
      admissionOperationId: uuidv7(),
      artifactId: uuidv7(),
      planEventId: uuidv7(),
    })
  );
  return {
    idempotency_key: data.idempotencyKey,
    original_operation_id: data.originalOperationId,
    admission_operation_id: data.admissionOperationId,
    artifact_id: data.artifactId,
    plan_event_id: data.planEventId,
    request_bytes: Buffer.from(data.requestBytes),
    request_hash: data.requestHash,
  };
}
function insert(
  db: Database.Database,
  table: string,
  row: Record<string, unknown>,
  replace = false
) {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
  ).run(...Object.values(row));
}
function publish(db: Database.Database, row: ReturnType<typeof command>) {
  db.exec('BEGIN IMMEDIATE');
  insert(db, 'plan_capture_commands', row);
  receipt(db, row.admission_operation_id);
  db.exec('COMMIT');
}
function historical(db: Database.Database, key: string) {
  const artifactId = uuidv7(),
    operationId = uuidv7(),
    eventId = uuidv7();
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO artifacts VALUES (?, 1)').run(artifactId);
  db.prepare(
    "INSERT INTO artifact_events VALUES (?, ?, 1, ?, NULL, ?, ?, 'plan_captured', 'original')"
  ).run(artifactId, eventId, Buffer.from('{}'), 'a'.repeat(64), 'a'.repeat(64));
  db.prepare('INSERT INTO artifact_revisions VALUES (?, 1, ?, ?, 1, 2, ?)').run(
    artifactId,
    operationId,
    'a'.repeat(64),
    eventId
  );
  receipt(db, operationId);
  db.exec('COMMIT');
  const record = { idempotency_key: key, artifact_id: artifactId, created_at: 'original' };
  const bytes = Buffer.from(' ' + JSON.stringify(record) + '\n');
  return {
    ...record,
    publication_operation_id: operationId,
    artifact_generation: 1,
    source_kind: 'historical',
    source_identity: 'sqlite:original/row',
    source_locator: '/original#7',
    source_profile: '0.2.0-rc.2',
    source_revision_id: null,
    source_event_id: null,
    source_operation_id: null,
    source_sha256: digest(bytes),
    record_bytes: bytes,
    record_hash: digest(bytes),
  };
}

it('adds inactive command tables without changing retained records or the active version', () => {
  const db = fixture();
  insert(db, 'plan_idempotency_records', historical(db, 'original:key'));
  const tables = [
    'plan_idempotency_records',
    'artifact_events',
    'artifact_revisions',
    'operations',
    'project_counters',
  ];
  const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  const version = db.pragma('user_version', { simple: true });
  expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(db.pragma('user_version', { simple: true })).toBe(version);
  expect(db.prepare('SELECT * FROM plan_capture_commands').all()).toEqual([]);
});

it('refuses key ownership collisions in both historical and new command directions', () => {
  const db = fixture();
  const old = historical(db, 'original:key');
  insert(db, 'plan_idempotency_records', old);
  expect(() => publish(db, command('original:key'))).toThrow('committed record');
  db.exec('ROLLBACK');
  publish(db, command('new:key'));
  const another = historical(db, 'new:key');
  expect(() => insert(db, 'plan_idempotency_records', another)).toThrow('command request');
  expect(db.prepare('SELECT idempotency_key FROM plan_capture_commands').all()).toEqual([
    { idempotency_key: 'new:key' },
  ]);
  expect(db.prepare('SELECT idempotency_key FROM plan_idempotency_records').all()).toEqual([
    { idempotency_key: 'original:key' },
  ]);
});

it('requires the admission receipt at commit while permitting original terminal settlement later', () => {
  const db = fixture();
  const row = command();
  db.exec('BEGIN IMMEDIATE');
  insert(db, 'plan_capture_commands', row);
  expect(() => db.exec('COMMIT')).toThrow('FOREIGN KEY');
  db.exec('ROLLBACK');
  expect(db.prepare('SELECT * FROM plan_capture_commands').all()).toEqual([]);
  publish(db, row);
  expect(
    db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(row.original_operation_id)
  ).toBeUndefined();
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('binds the indexed key to original request bytes and refuses missing source-plan input', () => {
  const db = fixture();
  const row = command();
  for (const changed of [
    { ...row, idempotency_key: 'other' },
    {
      ...row,
      request_bytes: Buffer.from(
        JSON.stringify({ authored: { idempotency_key: row.idempotency_key } })
      ),
    },
  ]) {
    db.exec('BEGIN IMMEDIATE');
    expect(() => insert(db, 'plan_capture_commands', changed)).toThrow('CHECK');
    db.exec('ROLLBACK');
  }
});

it('retains command inputs and prevents replacement or cross-role identity reassignment', () => {
  const db = fixture();
  const row = command();
  publish(db, row);
  const before = db.prepare('SELECT * FROM plan_capture_commands').all();
  expect(() =>
    insert(db, 'plan_capture_commands', { ...row, request_hash: 'b'.repeat(64) }, true)
  ).toThrow('immutable');
  expect(() => db.exec("UPDATE plan_capture_commands SET request_hash = 'changed'")).toThrow(
    'immutable'
  );
  expect(() => db.exec('DELETE FROM plan_capture_commands')).toThrow('retained');
  for (const collision of [
    { original_operation_id: row.admission_operation_id },
    { admission_operation_id: row.original_operation_id },
    { artifact_id: row.artifact_id },
    { plan_event_id: row.plan_event_id },
  ]) {
    db.exec('BEGIN IMMEDIATE');
    expect(() =>
      insert(db, 'plan_capture_commands', { ...command('other:key'), ...collision })
    ).toThrow('immutable');
    db.exec('ROLLBACK');
  }
  expect(db.prepare('SELECT * FROM plan_capture_commands').all()).toEqual(before);
});
