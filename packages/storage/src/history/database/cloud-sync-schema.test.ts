import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { PROJECT_CLOUD_SYNC_SCHEMA } from './cloud-sync-schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const scope = {
  artifact_id: uuidv7(),
  server_url: 'https://example.test',
  org_id: 'org',
  account_id: 'account',
};
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  // These owner tables isolate finite constraints; they do not fabricate an admitted push.
  db.exec(`CREATE TABLE operations(operation_id TEXT PRIMARY KEY);
    CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY);
    CREATE TABLE artifact_revisions(artifact_id TEXT, generation INTEGER, PRIMARY KEY(artifact_id,generation));
    CREATE TABLE usage_revisions(generation INTEGER PRIMARY KEY);
    CREATE TABLE artifact_push_requests(push_id TEXT PRIMARY KEY, terminal_operation_id TEXT,
      cloud_acknowledgement_id TEXT, artifact_id TEXT, server_url TEXT, org_id TEXT, account_id TEXT,
      artifact_generation INTEGER, usage_generation INTEGER, expected_cloud_revision_id TEXT, expected_cloud_version INTEGER);`);
  db.prepare('INSERT INTO artifacts VALUES (?)').run(scope.artifact_id);
  db.prepare('INSERT INTO artifact_revisions VALUES (?, 1)').run(scope.artifact_id);
  db.exec('INSERT INTO usage_revisions VALUES (1)');
  db.exec(PROJECT_CLOUD_SYNC_SCHEMA);
  return db;
}
function put(db: Database.Database, table: string, row: Record<string, unknown>, replace = false) {
  db.prepare(
    `INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(
      row
    )
      .map(() => '?')
      .join(',')})`
  ).run(...Object.values(row));
}
function record(
  db: Database.Database,
  previous?: { revision_id: string; previous_version: number | null }
) {
  const operationId = uuidv7();
  db.prepare('INSERT INTO operations VALUES (?)').run(operationId);
  return {
    revision_id: uuidv7(),
    operation_id: operationId,
    kind: 'failure',
    ...scope,
    previous_revision_id: previous?.revision_id ?? null,
    previous_version: previous ? (previous.previous_version ?? 0) + 1 : null,
    applied: 1,
    push_id: null as string | null,
    artifact_generation: null as number | null,
    usage_generation: null as number | null,
    acknowledged_at: null as string | null,
    failure_kind: 'network' as string | null,
    failure_message: 'Original message' as string | null,
    attempted_at: 'original time' as string | null,
    attempt_started_at: 'original start' as string | null,
    record_sha256: 'a'.repeat(64),
  };
}
function select(db: Database.Database, row: ReturnType<typeof record>) {
  put(db, 'cloud_sync_current', { ...scope, revision_id: row.revision_id, version: 1 });
}
function acknowledge(db: Database.Database, previous?: ReturnType<typeof record>) {
  const row = {
    ...record(db, previous),
    kind: 'acknowledgement',
    push_id: uuidv7(),
    artifact_generation: 1,
    usage_generation: null,
    acknowledged_at: 'original success',
    failure_kind: null,
    failure_message: null,
    attempted_at: null,
    attempt_started_at: null,
  };
  put(db, 'artifact_push_requests', {
    push_id: row.push_id,
    terminal_operation_id: row.operation_id,
    cloud_acknowledgement_id: row.revision_id,
    ...scope,
    artifact_generation: 1,
    usage_generation: null,
    expected_cloud_revision_id: row.previous_revision_id,
    expected_cloud_version: row.previous_version,
  });
  return row;
}

it('retains exact scoped predecessors and refuses missing or wrong-version links', () => {
  const db = fixture();
  const first = record(db);
  put(db, 'cloud_sync_records', first);
  select(db, first);
  const next = record(db, first);
  for (const change of [
    { previous_version: 2 },
    { previous_revision_id: uuidv7() },
    { account_id: 'other' },
  ]) {
    expect(() => put(db, 'cloud_sync_records', { ...next, ...change })).toThrow(
      'exact selected predecessor'
    );
  }
  put(db, 'cloud_sync_records', next);
  db.prepare('UPDATE cloud_sync_current SET revision_id = ?, version = 2').run(next.revision_id);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('never selects a stale false result or a divergent chain', () => {
  const db = fixture();
  const first = record(db);
  put(db, 'cloud_sync_records', first);
  select(db, first);
  const stale = { ...record(db, first), applied: 0 };
  put(db, 'cloud_sync_records', stale);
  expect(() =>
    db.prepare('UPDATE cloud_sync_current SET revision_id = ?, version = 2').run(stale.revision_id)
  ).toThrow('original applied chain');
  const child = record(db, stale);
  expect(() => put(db, 'cloud_sync_records', child)).toThrow('exact selected predecessor');
  const fresh = record(db);
  put(db, 'cloud_sync_records', fresh);
  expect(() =>
    db.prepare('UPDATE cloud_sync_current SET revision_id = ?, version = 2').run(fresh.revision_id)
  ).toThrow('original applied chain');
});

it('preserves immutable original messages and current selection under replacement attempts', () => {
  const db = fixture();
  const row = record(db);
  put(db, 'cloud_sync_records', row);
  select(db, row);
  expect(() => put(db, 'cloud_sync_records', { ...row, failure_message: 'changed' }, true)).toThrow(
    'cannot be replaced'
  );
  expect(() => put(db, 'cloud_sync_records', { ...row, revision_id: uuidv7() }, true)).toThrow(
    'cannot be replaced'
  );
  expect(() => db.exec('DELETE FROM cloud_sync_records')).toThrow('retained');
  expect(() => db.exec("UPDATE cloud_sync_records SET failure_message = 'changed'")).toThrow(
    'immutable'
  );
  expect(() =>
    put(db, 'cloud_sync_current', { ...scope, revision_id: row.revision_id, version: 1 }, true)
  ).toThrow('start');
  expect(db.prepare('SELECT failure_message FROM cloud_sync_records').get()).toEqual({
    failure_message: row.failure_message,
  });
});

it('binds acknowledgment to the original terminal, source pair and nullable usage', () => {
  const db = fixture();
  const row = acknowledge(db);
  for (const change of [
    { usage_generation: 1 },
    { artifact_generation: 2 },
    { revision_id: uuidv7() },
    { operation_id: uuidv7() },
    { account_id: 'other' },
  ]) {
    expect(() => put(db, 'cloud_sync_records', { ...row, ...change })).toThrow(
      'original push target'
    );
  }
  put(db, 'cloud_sync_records', row);
  select(db, row);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('keeps failure and acknowledgment fields exclusive', () => {
  const db = fixture();
  const row = record(db);
  for (const change of [
    { failure_kind: 'NotConnected' },
    { attempted_at: null },
    { failure_kind: null },
    { artifact_generation: 1 },
  ]) {
    expect(() => put(db, 'cloud_sync_records', { ...row, ...change })).toThrow('CHECK');
  }
  put(db, 'cloud_sync_records', row);
  const success = acknowledge(db, row);
  expect(() =>
    put(db, 'cloud_sync_records', { ...success, failure_message: 'invented failure' })
  ).toThrow('CHECK');
  put(db, 'cloud_sync_records', success);
});

it('rejects current scope retargeting while permitting an applied success after failures', () => {
  const db = fixture();
  const first = record(db);
  put(db, 'cloud_sync_records', first);
  select(db, first);
  const success = acknowledge(db, first);
  put(db, 'cloud_sync_records', success);
  expect(() =>
    db
      .prepare("UPDATE cloud_sync_current SET account_id = 'other', revision_id = ?, version = 2")
      .run(success.revision_id)
  ).toThrow('original applied chain');
  db.prepare('UPDATE cloud_sync_current SET revision_id = ?, version = 2').run(success.revision_id);
  expect(db.prepare('SELECT revision_id, version FROM cloud_sync_current').get()).toEqual({
    revision_id: success.revision_id,
    version: 2,
  });
});
