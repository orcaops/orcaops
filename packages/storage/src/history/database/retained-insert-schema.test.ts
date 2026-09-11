import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

import { PROJECT_RETAINED_INSERT_SCHEMA } from './retained-insert-schema.js';
import { PROJECT_DATABASE_SCHEMA } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys=ON');
  db.pragma('recursive_triggers=OFF');
  db.exec(
    process.env.ORCAOPS_TEST_ORIGINAL_RETAINED_GUARDS === '1'
      ? PROJECT_DATABASE_SCHEMA.replace(PROJECT_RETAINED_INSERT_SCHEMA, '')
      : PROJECT_DATABASE_SCHEMA
  );
  const saved = JSON.parse(
    readFileSync(new URL('./fixtures/retention-inputs.json', import.meta.url), 'utf8')
  );
  db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
  for (const [table, rows] of Object.entries(saved.rows) as [string, Record<string, unknown>[]][])
    for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
      ).run(
        ...Object.values(row).map((value) =>
          value && typeof value === 'object' && 'blobHex' in value
            ? Buffer.from(value.blobHex as string, 'hex')
            : value
        )
      );
    }
  db.exec('COMMIT');
  return db;
}
function replace(db: Database.Database, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...Object.values(row));
}
it.each([
  ['operations', 'result_json', '{"lost":"original"}'],
  ['reviews', 'identity_bytes', Buffer.from('{}')],
  ['review_run_revisions', 'record_bytes', Buffer.from('{}')],
  ['usage_events', 'record_bytes', Buffer.from('{}')],
] as const)('protects original %s content from replacement', (table, column, value) => {
  const db = fixture();
  const before = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const row = before[0] as Record<string, unknown>;
  expect(() => replace(db, table, { ...row, [column]: value })).toThrow(
    'Original retained rows cannot be replaced'
  );
  expect(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before);
});
it.each([
  ['usage_events', 'event_id'],
  ['usage_revisions', 'generation'],
  ['review_run_revisions', 'revision_id'],
  ['review_evidence_publications', 'publication_id'],
  ['review_evidence_members', 'name'],
] as const)('protects an alternate unique key in %s', (table, key) => {
  const db = fixture();
  db.pragma('foreign_keys=OFF');
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<
    string,
    unknown
  >[];
  const original =
    table === 'review_evidence_publications' ? rows.find((r) => r.kind === 'run-input')! : rows[0]!;
  const value = key === 'generation' ? Number(original[key]) + 1 : uuidv7();
  expect(() => replace(db, table, { ...original, [key]: value })).toThrow(
    'Original retained rows cannot be replaced'
  );
  expect(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(rows);
});
it('covers every retained table with update protection and preserves rebuildable row writes', () => {
  const db = fixture();
  const tables = db
    .prepare(
      "SELECT tbl_name AS name FROM sqlite_schema WHERE type='trigger' AND name LIKE '%_no_update'"
    )
    .all() as { name: string }[];
  for (const { name } of tables)
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?")
        .get(`${name}_no_replace`)
    ).toBeDefined();
  expect(() => db.exec('DELETE FROM artifact_metadata')).not.toThrow();
  expect(db.pragma('recursive_triggers', { simple: true })).toBe(0);
});
it('rolls back the rest of a transaction after a refused replacement while allowing new receipts', () => {
  const db = fixture();
  const before = db.prepare('SELECT * FROM operations ORDER BY operation_id').all() as Record<
    string,
    unknown
  >[];
  const added = { ...before[0]!, operation_id: uuidv7() };
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    `INSERT INTO operations (${Object.keys(added).join(',')}) VALUES (${Object.keys(added)
      .map(() => '?')
      .join(',')})`
  ).run(...Object.values(added));
  expect(() => replace(db, 'operations', { ...before[0], result_json: '{}' })).toThrow(
    'Original retained rows cannot be replaced'
  );
  db.exec('ROLLBACK');
  expect(db.prepare('SELECT * FROM operations ORDER BY operation_id').all()).toEqual(before);
});
