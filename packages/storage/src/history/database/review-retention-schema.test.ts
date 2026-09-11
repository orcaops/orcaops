import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/retention-inputs.json', import.meta.url), 'utf8')
) as { rows: Record<string, Record<string, string | number | null | { blobHex: string }>[]> };
function database() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  db.exec('BEGIN IMMEDIATE');
  db.pragma('defer_foreign_keys = ON');
  for (const [table, rows] of Object.entries(fixture.rows))
    for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
      ).run(
        ...Object.values(row).map((value) =>
          value && typeof value === 'object' ? Buffer.from(value.blobHex, 'hex') : value
        )
      );
    }
  db.exec('COMMIT');
  return db;
}
function receipt(db: Database.Database, id = uuidv7()) {
  db.prepare(
    "INSERT INTO operations VALUES (?, 'retention.fixture', 0, '{}', '{}', ?, 'null', '{}', 1, 0)"
  ).run(id, 'a'.repeat(64));
  return id;
}
function admission(db: Database.Database) {
  const operation = uuidv7(),
    admitted = receipt(db),
    prepared = uuidv7(),
    repository = uuidv7();
  const review = fixture.rows.reviews![0]!.review_id as string;
  const membership = fixture.rows.review_membership_revisions![0]!.revision_id as string;
  const floor = fixture.rows.review_evidence_publications!.find((row) => row.kind === 'floor')!
    .publication_id as string;
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    "INSERT INTO git_retention_operations VALUES (?, ?, ?, 'review', NULL, ?, 'sha1', 'time', 'hash')"
  ).run(operation, admitted, repository, operation);
  db.prepare(
    "INSERT INTO git_retention_review_targets VALUES (?, 'review', ?, ?, NULL, ?, NULL, NULL, 1, 0, 1, 0)"
  ).run(operation, review, membership, floor);
  db.prepare(
    "INSERT INTO git_retention_transitions VALUES (?, ?, NULL, 0, 'prepared', ?, NULL)"
  ).run(prepared, operation, admitted);
  db.prepare('INSERT INTO git_retention_current VALUES (?, ?)').run(operation, prepared);
  db.exec('COMMIT');
  return { operation, prepared, repository, review, floor };
}
type Admission = ReturnType<typeof admission>;
type Role = 'review-floor' | 'review-floor-base' | 'review-base';
function publication(
  db: Database.Database,
  a: Admission,
  role: Role,
  target = a.floor,
  ref?: string
) {
  const id = uuidv7();
  db.prepare(
    'INSERT INTO git_retention_publications VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)'
  ).run(
    id,
    a.operation,
    a.repository,
    role,
    target,
    ref ?? `refs/orcaops/review/${a.review}-${id}${role === 'review-floor' ? '' : '-base'}`,
    'a'.repeat(40),
    'b'.repeat(40)
  );
  return id;
}
function selected(db: Database.Database, a: Admission) {
  const id = uuidv7();
  receipt(db, a.operation);
  db.prepare("INSERT INTO git_retention_transitions VALUES (?, ?, ?, 1, 'selected', ?, NULL)").run(
    id,
    a.operation,
    a.prepared,
    a.operation
  );
  db.prepare(
    'UPDATE git_retention_current SET transition_id = ? WHERE original_operation_id = ?'
  ).run(id, a.operation);
}
function bind(
  db: Database.Database,
  a: Admission,
  id: string,
  role: Role,
  target = a.floor,
  review = a.review
) {
  db.prepare('INSERT INTO review_retention_bindings VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    a.operation,
    review,
    role,
    target,
    role === 'review-base' ? null : target,
    role === 'review-base' ? target : null
  );
}
it('binds distinct target and resolved-base publications to the same original floor without a policy revision', () => {
  const db = database(),
    a = admission(db);
  const before = db.prepare('SELECT * FROM review_selections').all();
  expect(db.prepare('SELECT * FROM review_base_revisions').all()).toEqual([]);
  const target = publication(db, a, 'review-floor'),
    base = publication(db, a, 'review-floor-base');
  expect(() => bind(db, a, target, 'review-floor')).toThrow(/exact owner/);
  selected(db, a);
  bind(db, a, target, 'review-floor');
  bind(db, a, base, 'review-floor-base');
  expect(
    db.prepare('SELECT target_id, base_revision_id FROM review_retention_bindings').all()
  ).toEqual([
    { target_id: a.floor, base_revision_id: null },
    { target_id: a.floor, base_revision_id: null },
  ]);
  expect(db.prepare('SELECT * FROM review_selections').all()).toEqual(before);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('keeps explicit policy and resolved floor-base row ownership separate', () => {
  const db = database(),
    a = admission(db),
    base = uuidv7(),
    op = receipt(db);
  db.prepare('INSERT INTO review_base_revisions VALUES (?, ?, NULL, ?, ?, ?)').run(
    base,
    a.review,
    op,
    Buffer.from(
      '{"kind":"explicit","ref":"main","oid":"' +
        'a'.repeat(40) +
        '","recordedAt":"2026-09-01T00:00:00.000Z","source":null}'
    ),
    'c'.repeat(64)
  );
  const floorPin = publication(db, a, 'review-floor-base'),
    policyPin = publication(db, a, 'review-base', base);
  selected(db, a);
  bind(db, a, floorPin, 'review-floor-base');
  bind(db, a, policyPin, 'review-base', base);
  expect(() => bind(db, a, policyPin, 'review-floor-base', base)).toThrow();
  expect(
    db.prepare('SELECT role, target_id FROM review_retention_bindings ORDER BY role').all()
  ).toEqual([
    { role: 'review-base', target_id: base },
    { role: 'review-floor-base', target_id: a.floor },
  ]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
it.each(['wrong-review', 'wrong-target', 'wrong-role', 'missing-floor'] as const)(
  'refuses %s resolved-base associations',
  (kind) => {
    const db = database(),
      a = admission(db),
      id = publication(db, a, 'review-floor-base');
    selected(db, a);
    if (kind === 'missing-floor') {
      const absent = uuidv7(),
        other = publication(db, a, 'review-floor-base', absent);
      expect(() => bind(db, a, other, 'review-floor-base', absent)).toThrow(/floor evidence/);
    } else
      expect(() =>
        bind(
          db,
          a,
          id,
          kind === 'wrong-role' ? 'review-base' : 'review-floor-base',
          kind === 'wrong-target' ? uuidv7() : a.floor,
          kind === 'wrong-review' ? uuidv7() : a.review
        )
      ).toThrow();
    expect(db.prepare('SELECT * FROM review_retention_bindings').all()).toEqual([]);
  }
);
it('refuses a resolved-base ref without its original immutable suffix and a duplicate binding', () => {
  const db = database(),
    a = admission(db);
  expect(() =>
    publication(db, a, 'review-floor-base', a.floor, `refs/orcaops/review/${a.review}-${uuidv7()}`)
  ).toThrow(/exact owner/);
  const id = publication(db, a, 'review-floor-base');
  selected(db, a);
  bind(db, a, id, 'review-floor-base');
  const b = admission(db),
    another = publication(db, b, 'review-floor-base');
  selected(db, b);
  expect(() => bind(db, b, another, 'review-floor-base')).toThrow(/immutable/);
});
it.each(['git_retention_publications', 'review_retention_bindings'] as const)(
  'retains new-role %s rows against update deletion and replacement',
  (table) => {
    const db = database(),
      a = admission(db),
      id = publication(db, a, 'review-floor-base');
    selected(db, a);
    bind(db, a, id, 'review-floor-base');
    const rows = db.prepare(`SELECT * FROM ${table}`).all(),
      row = rows[0] as Record<string, unknown>,
      keys = Object.keys(row);
    expect(() => db.exec(`UPDATE ${table} SET publication_id = publication_id`)).toThrow(
      /immutable/
    );
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/retained|immutable/);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
        )
        .run(...Object.values(row))
    ).toThrow(/immutable/);
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
  }
);
