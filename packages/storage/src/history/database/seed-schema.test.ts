import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
function database() {
  const value = new Database(':memory:');
  value.exec(PROJECT_DATABASE_SCHEMA);
  value.pragma('foreign_keys = ON');
  value.pragma('recursive_triggers = OFF');
  databases.push(value);
  return value;
}
function operation(db: Database.Database) {
  const id = uuidv7();
  db.prepare(
    "INSERT INTO operations VALUES (?, 'seed.fixture', 0, '{}', '{}', ?, 'null', '{}', 1, 0)"
  ).run(id, 'a'.repeat(64));
  return id;
}
function state(db: Database.Database) {
  const sourceId = uuidv7();
  const revisionId = uuidv7();
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    "INSERT INTO seed_state_sources VALUES (?, 'precious', 'original', 'precious.json', NULL, NULL, NULL, ?, ?, 1)"
  ).run(sourceId, Buffer.from('{}'), 'a'.repeat(64));
  db.prepare('INSERT INTO seed_state_revisions VALUES (?, 1, ?, NULL, ?, NULL, NULL, ?)').run(
    revisionId,
    operation(db),
    sourceId,
    'a'.repeat(64)
  );
  db.prepare('INSERT INTO seed_state_members VALUES (?, 0, ?)').run(revisionId, sourceId);
  db.prepare('INSERT INTO seed_state_selection VALUES (1, ?)').run(revisionId);
  db.exec('COMMIT');
  return { sourceId, revisionId };
}
function bundle(db: Database.Database, kind = 'pending', artifactId: string | null = null) {
  const sourceId = uuidv7();
  const revisionId = uuidv7();
  const key = JSON.stringify([kind, artifactId]);
  db.prepare('INSERT INTO seed_bundle_revisions VALUES (?, ?, ?, ?, 1, ?, NULL, ?)').run(
    revisionId,
    key,
    kind,
    artifactId,
    operation(db),
    'a'.repeat(64)
  );
  db.prepare(
    "INSERT INTO seed_bundle_sources VALUES (?, ?, 'manifest', 'original', 'manifest.json', NULL, NULL, NULL, ?, ?)"
  ).run(sourceId, key, Buffer.from('{}'), 'a'.repeat(64));
  db.prepare('INSERT INTO seed_bundle_members VALUES (?, ?, 0, ?)').run(revisionId, key, sourceId);
  return { sourceId, revisionId, key };
}
it.each([
  'seed_state_sources',
  'seed_state_revisions',
  'seed_state_members',
  'seed_bundle_sources',
  'seed_bundle_revisions',
  'seed_bundle_members',
])('protects immutable %s from replacement with recursive triggers off', (table) => {
  const db = database();
  state(db);
  bundle(db);
  const before = db.prepare(`SELECT * FROM ${table}`).all();
  const row = { ...(before[0] as Record<string, unknown>) };
  if ('record_bytes' in row) row.record_bytes = Buffer.from('changed');
  else if ('content_hash' in row) row.content_hash = 'b'.repeat(64);
  else row.ordinal = 1;
  expect(() =>
    db
      .prepare(
        `INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
          .map(() => '?')
          .join(',')})`
      )
      .run(...Object.values(row))
  ).toThrow('Seed history is immutable');
  expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
  expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('Seed history is retained');
  expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
});
it('rejects replacement through alternate immutable revision uniqueness', () => {
  const db = database();
  state(db);
  bundle(db);
  for (const table of ['seed_state_revisions', 'seed_bundle_revisions']) {
    const before = db.prepare(`SELECT * FROM ${table}`).all();
    const row = { ...(before[0] as Record<string, unknown>), revision_id: uuidv7() };
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(
            row
          )
            .map(() => '?')
            .join(',')})`
        )
        .run(...Object.values(row))
    ).toThrow('Seed history is immutable');
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
  }
});
it('binds selected state sources to their exact kind and retained revision membership', () => {
  const db = database();
  const original = state(db);
  const revisionId = uuidv7();
  const op = operation(db);
  expect(() =>
    db
      .prepare('INSERT INTO seed_state_revisions VALUES (?, 2, ?, ?, NULL, ?, NULL, ?)')
      .run(revisionId, op, original.revisionId, original.sourceId, 'a'.repeat(64))
  ).toThrow('Seed revision must retain its exact source');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO seed_state_revisions VALUES (?, 2, ?, ?, ?, NULL, NULL, ?)').run(
    revisionId,
    op,
    original.revisionId,
    original.sourceId,
    'a'.repeat(64)
  );
  expect(() => db.exec('COMMIT')).toThrow('FOREIGN KEY constraint failed');
  db.exec('ROLLBACK');
  expect(db.prepare('SELECT count(*) n FROM seed_state_revisions').get()).toEqual({ n: 1 });
});
it('carries one immutable bundle occurrence through revisions without retargeting it', () => {
  const db = database();
  const original = bundle(db);
  const revisionId = uuidv7();
  db.prepare("INSERT INTO seed_bundle_revisions VALUES (?, ?, 'pending', NULL, 2, ?, ?, ?)").run(
    revisionId,
    original.key,
    operation(db),
    original.revisionId,
    'b'.repeat(64)
  );
  db.prepare('INSERT INTO seed_bundle_members VALUES (?, ?, 0, ?)').run(
    revisionId,
    original.key,
    original.sourceId
  );
  expect(db.prepare('SELECT count(*) n FROM seed_bundle_sources').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT count(*) n FROM seed_bundle_members').get()).toEqual({ n: 2 });
  const other = bundle(db, 'accepted', uuidv7());
  expect(() =>
    db
      .prepare('INSERT INTO seed_bundle_members VALUES (?, ?, 1, ?)')
      .run(other.revisionId, other.key, original.sourceId)
  ).toThrow('FOREIGN KEY constraint failed');
});
it('refuses cross-family source or revision identity reuse and preserves pending null identity', () => {
  const db = database();
  const original = state(db);
  expect(() =>
    db
      .prepare(
        "INSERT INTO seed_bundle_sources VALUES (?, ?, 'manifest', 'original', 'manifest.json', NULL, NULL, NULL, ?, ?)"
      )
      .run(original.sourceId, '["pending",null]', Buffer.from('{}'), 'a'.repeat(64))
  ).toThrow('Original seed source identity cannot be retargeted');
  expect(() =>
    db
      .prepare("INSERT INTO seed_bundle_revisions VALUES (?, ?, 'pending', NULL, 1, ?, NULL, ?)")
      .run(original.revisionId, '["pending",null]', operation(db), 'a'.repeat(64))
  ).toThrow('Seed bundle revision must retain its exact identity');
  const pending = bundle(db);
  expect(
    db
      .prepare('SELECT kind, artifact_id FROM seed_bundle_revisions WHERE revision_id=?')
      .get(pending.revisionId)
  ).toEqual({ kind: 'pending', artifact_id: null });
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
