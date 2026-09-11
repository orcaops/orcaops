import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { PROJECT_CAPTURE_OPERATION_SCHEMA } from './capture-operation-schema.js';
import { PROJECT_DATABASE_SCHEMA } from './schema.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((value) => value.close()));
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  db.exec(PROJECT_DATABASE_SCHEMA);
  if ((db.pragma('user_version', { simple: true }) as number) < 15)
    db.exec(PROJECT_CAPTURE_OPERATION_SCHEMA);
  const artifactId = uuidv7();
  const operationId = uuidv7();
  const eventId = uuidv7();
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
  return { db, artifactId };
}
function receipt(db: Database.Database, id: string) {
  db.prepare(
    "INSERT INTO operations VALUES (?, 'fixture.capture', 0, '{}', '{}', ?, 'null', '{}', 1, 0)"
  ).run(id, 'a'.repeat(64));
}
function insert(
  db: Database.Database,
  table: string,
  row: Record<string, unknown>,
  replace = false
) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...Object.values(row));
}
function common(artifactId: string, record: unknown) {
  const bytes = Buffer.from(' ' + JSON.stringify(record) + '\n');
  return {
    revision_id: uuidv7(),
    publication_operation_id: uuidv7(),
    artifact_id: artifactId,
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
function lifecycle(artifactId: string) {
  const row = {
    fires_at: 'checkpoint-close',
    cp_n: 0,
    triggered_at: 'original',
    execution_context_hash: null,
  };
  return { ...common(artifactId, row), ...row };
}
function attempt(artifactId: string) {
  const row = {
    artifact_id: artifactId,
    event_type: 'checkpoint_closed',
    idempotency_key: 'original-key',
    outcome: 'soft_blocked',
    payload_hash: 'b'.repeat(64),
    evaluator_fingerprint: null,
    envelope: '{"original":true}',
    recorded_at: 'original',
  };
  return { ...common(artifactId, row), ...row, action: 'set' };
}
function plan(artifactId: string) {
  const row = {
    artifact_id: artifactId,
    idempotency_key: 'original-plan-key',
    created_at: 'original',
  };
  const { revision_id: _revision, ...base } = common(artifactId, row);
  return { ...base, ...row };
}
function sourceTime(artifactId: string) {
  const row = {
    schema_version: 1,
    artifact_id: artifactId,
    member_commits: ['a'.repeat(40)],
    sources: [],
  };
  return { ...common(artifactId, row), source_count: 0 };
}
function publish(
  db: Database.Database,
  table: string,
  row: ReturnType<typeof common> | ReturnType<typeof plan>
) {
  db.exec('BEGIN IMMEDIATE');
  insert(db, table, row);
  receipt(db, row.publication_operation_id);
  db.exec('COMMIT');
}
const families = [
  ['artifact_lifecycle_revisions', lifecycle],
  ['artifact_attempt_revisions', attempt],
  ['plan_idempotency_records', plan],
  ['source_time_revisions', sourceTime],
] as const;
it.each(families)(
  'retains %s original bytes and refuses replacement, deletion and updates',
  (table, make) => {
    const { db, artifactId } = fixture();
    const row = make(artifactId);
    publish(db, table, row);
    const before = db.prepare(`SELECT * FROM ${table}`).all();
    expect(() => insert(db, table, { ...row, source_locator: 'changed' }, true)).toThrow(
      'immutable'
    );
    expect(() => db.exec(`UPDATE ${table} SET source_locator = 'changed'`)).toThrow('immutable');
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('retained');
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  }
);
it.each(families)(
  'defers %s exact artifact and receipt references to the shared transaction',
  (table, make) => {
    const { db, artifactId } = fixture();
    for (const changed of [{}, { artifact_generation: 2 }]) {
      const row = { ...make(artifactId), ...changed };
      db.exec('BEGIN IMMEDIATE');
      insert(db, table, row);
      if ('artifact_generation' in changed) receipt(db, row.publication_operation_id);
      expect(() => db.exec('COMMIT')).toThrow('FOREIGN KEY');
      db.exec('ROLLBACK');
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
  }
);
const selections = [
  [
    'artifact_lifecycle_current',
    'artifact_lifecycle_revisions',
    lifecycle,
    ['artifact_id', 'fires_at', 'cp_n'],
  ],
  [
    'artifact_attempt_current',
    'artifact_attempt_revisions',
    attempt,
    ['artifact_id', 'event_type', 'idempotency_key'],
  ],
  ['source_time_current', 'source_time_revisions', sourceTime, ['artifact_id']],
] as const;
it.each(selections)(
  'protects %s scope, next version and exact selected revision',
  (table, records, make, keys) => {
    const { db, artifactId } = fixture();
    const first = make(artifactId);
    publish(db, records, first);
    const slot = Object.fromEntries(
      keys.map((key) => [key, (first as unknown as Record<string, unknown>)[key]])
    );
    expect(() =>
      insert(db, table, { ...slot, revision_id: first.revision_id, version: 2 })
    ).toThrow('exact version');
    db.exec('BEGIN IMMEDIATE');
    insert(db, table, {
      ...slot,
      artifact_id: uuidv7(),
      revision_id: first.revision_id,
      version: 1,
    });
    expect(() => db.exec('COMMIT')).toThrow('FOREIGN KEY');
    db.exec('ROLLBACK');
    insert(db, table, { ...slot, revision_id: first.revision_id, version: 1 });
    expect(() =>
      insert(db, table, { ...slot, revision_id: first.revision_id, version: 1 }, true)
    ).toThrow('exact version');
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('retained');
    for (const sql of ['version = 3', "artifact_id = 'foreign', version = 2", 'version = 2'])
      expect(() => db.exec(`UPDATE ${table} SET ${sql}`)).toThrow();
    const second = make(artifactId);
    publish(db, records, second);
    db.prepare(`UPDATE ${table} SET revision_id = ?, version = 2`).run(second.revision_id);
    expect(db.prepare(`SELECT revision_id,version FROM ${table}`).get()).toEqual({
      revision_id: second.revision_id,
      version: 2,
    });
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`UPDATE ${table} SET revision_id = ?, version = 3`).run(uuidv7());
    expect(() => db.exec('COMMIT')).toThrow('FOREIGN KEY');
    db.exec('ROLLBACK');
  }
);
it('requires an original selected attempt for clear and rejects half-clear bytes', () => {
  const { db, artifactId } = fixture();
  const first = attempt(artifactId);
  const clear = {
    ...first,
    revision_id: uuidv7(),
    publication_operation_id: uuidv7(),
    action: 'clear',
    record_bytes: null,
    record_hash: null,
    source_sha256: null,
    outcome: null,
    payload_hash: null,
    evaluator_fingerprint: null,
    envelope: null,
    recorded_at: null,
  };
  expect(() => insert(db, 'artifact_attempt_revisions', clear)).toThrow('original selected slot');
  publish(db, 'artifact_attempt_revisions', first);
  insert(db, 'artifact_attempt_current', {
    artifact_id: artifactId,
    event_type: first.event_type,
    idempotency_key: first.idempotency_key,
    revision_id: first.revision_id,
    version: 1,
  });
  expect(() =>
    insert(db, 'artifact_attempt_revisions', { ...clear, record_bytes: Buffer.from('{}') })
  ).toThrow('CHECK');
  db.exec('BEGIN IMMEDIATE');
  insert(db, 'artifact_attempt_revisions', clear);
  db.prepare('UPDATE artifact_attempt_current SET revision_id = ?, version = 2').run(
    clear.revision_id
  );
  receipt(db, clear.publication_operation_id);
  db.exec('COMMIT');
  expect(
    db
      .prepare('SELECT action,record_bytes FROM artifact_attempt_revisions WHERE revision_id = ?')
      .get(clear.revision_id)
  ).toEqual({ action: 'clear', record_bytes: null });
});
it('retains historical zero without admitting authored zero or mismatched typed copies', () => {
  const { db, artifactId } = fixture();
  const first = lifecycle(artifactId);
  expect(() =>
    insert(db, 'artifact_lifecycle_revisions', {
      ...first,
      source_kind: 'authored',
      source_profile: null,
    })
  ).toThrow('CHECK');
  expect(() =>
    insert(db, 'artifact_lifecycle_revisions', { ...first, source_profile: null })
  ).toThrow('CHECK');
  expect(() => insert(db, 'artifact_lifecycle_revisions', { ...first, cp_n: 7 })).toThrow('CHECK');
  expect(() =>
    insert(db, 'artifact_lifecycle_revisions', { ...first, record_bytes: Buffer.from('{}') })
  ).toThrow('CHECK');
  publish(db, 'artifact_lifecycle_revisions', first);
});
it('keeps source rows rebuildable while retaining original members and explicit unknown times', () => {
  const { db, artifactId } = fixture();
  const record = sourceTime(artifactId);
  publish(db, 'source_time_revisions', record);
  const row = {
    revision_id: record.revision_id,
    source_id: 'digest',
    source_json: '{"source_id":"digest"}',
    source_hash: 'a'.repeat(64),
    evidence_time: null,
    evidence_time_basis: 'unknown',
    unknown_reason: 'incomplete',
  };
  insert(db, 'source_time_sources', row);
  expect(() => insert(db, 'source_time_sources', { ...row, source_id: 'other' })).toThrow('CHECK');
  expect(() => insert(db, 'source_time_sources', { ...row, unknown_reason: null }, true)).toThrow(
    'CHECK'
  );
  db.exec('DELETE FROM source_time_sources');
  expect(db.prepare('SELECT * FROM source_time_revisions').all()).toHaveLength(1);
});
