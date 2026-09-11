import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const handles: Database.Database[] = [];
afterEach(() => handles.splice(0).forEach((database) => database.close()));
function fixture() {
  const database = new Database(':memory:');
  handles.push(database);
  database.pragma('foreign_keys = ON');
  database.exec(PROJECT_DATABASE_SCHEMA);
  const operation = uuidv7();
  database
    .prepare('INSERT INTO operations VALUES (?, ?, 0, ?, ?, ?, ?, ?, 1, 0)')
    .run(operation, 'review.fixture', '{}', '{}', 'retained-hash', '{}', '{}');
  const review = uuidv7();
  const membership = uuidv7();
  const floor = uuidv7();
  database
    .prepare('INSERT INTO reviews VALUES (?, ?, ?, ?, ?, NULL)')
    .run(review, Buffer.from('{"retained":"identity"}\n'), 'identity-hash', operation, 'topic');
  database
    .prepare('INSERT INTO review_membership_revisions VALUES (?, ?, NULL, ?, ?, ?)')
    .run(
      membership,
      review,
      operation,
      Buffer.from('{"retained":"membership"}\n'),
      'membership-hash'
    );
  database
    .prepare(
      'INSERT INTO review_evidence_publications VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)'
    )
    .run(floor, review, 'floor', operation, membership, 'original-floor-input', '{}');
  return { database, operation, review, membership, floor };
}
function run(f: ReturnType<typeof fixture>) {
  const id = uuidv7();
  const revision = uuidv7();
  const bytes = Buffer.from('{ "run_id": "original-run", "attempts": [] }\n');
  f.database.prepare('INSERT INTO review_runs VALUES (?, ?, ?, 1)').run(id, f.review, revision);
  f.database
    .prepare('INSERT INTO review_run_revisions VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?, ?)')
    .run(revision, f.review, id, f.operation, bytes, 'run-hash', f.floor, f.membership);
  return { id, revision, bytes };
}
function publication(
  f: ReturnType<typeof fixture>,
  kind: 'run-input' | 'run-attempt',
  target: { id: string | null; revision: string | null },
  floor: string | null = f.floor
) {
  const id = uuidv7();
  f.database
    .prepare('INSERT INTO review_evidence_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(
      id,
      f.review,
      kind,
      f.operation,
      f.membership,
      floor,
      'original-floor-input',
      target.id,
      target.revision,
      '{}'
    );
  return id;
}

describe('review run evidence constraints', () => {
  it('settles cyclic initial run selection before binding immutable inputs to its exact revision', () => {
    const f = fixture();
    f.database.exec('BEGIN IMMEDIATE');
    const target = run(f);
    const inputs = publication(f, 'run-input', target);
    f.database.exec('COMMIT');
    expect(f.database.pragma('foreign_key_check')).toEqual([]);
    expect(
      f.database
        .prepare(
          'SELECT run_id, run_revision_id, floor_publication_id FROM review_evidence_publications WHERE publication_id = ?'
        )
        .get(inputs)
    ).toEqual({
      run_id: target.id,
      run_revision_id: target.revision,
      floor_publication_id: f.floor,
    });
    expect(
      f.database
        .prepare('SELECT record_bytes FROM review_run_revisions WHERE revision_id = ?')
        .get(target.revision)
    ).toEqual({ record_bytes: target.bytes });
  });
  it.each(['run-input', 'run-attempt'] as const)(
    'requires complete run and floor associations for %s',
    (kind) => {
      const f = fixture();
      f.database.exec('BEGIN IMMEDIATE');
      const target = run(f);
      expect(() => publication(f, kind, { id: null, revision: null })).toThrow(
        expect.objectContaining({ code: 'SQLITE_CONSTRAINT_CHECK' })
      );
      expect(() => publication(f, kind, target, null)).toThrow(
        expect.objectContaining({ code: 'SQLITE_CONSTRAINT_CHECK' })
      );
      f.database.exec('COMMIT');
    }
  );
  it('retains one original input bundle per run and one attempt bundle per exact revision', () => {
    const f = fixture();
    f.database.exec('BEGIN IMMEDIATE');
    const target = run(f);
    publication(f, 'run-input', target);
    publication(f, 'run-attempt', target);
    expect(() => publication(f, 'run-input', target)).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_TRIGGER' })
    );
    expect(() => publication(f, 'run-attempt', target)).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_TRIGGER' })
    );
    const next = { id: target.id, revision: uuidv7() };
    f.database
      .prepare('INSERT INTO review_run_revisions VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?)')
      .run(
        next.revision,
        f.review,
        target.id,
        target.revision,
        f.operation,
        target.bytes,
        'next-hash',
        f.floor,
        f.membership
      );
    expect(() => publication(f, 'run-input', next)).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_TRIGGER' })
    );
    publication(f, 'run-attempt', next);
    f.database.exec('COMMIT');
    expect(
      f.database
        .prepare(
          'SELECT kind, count(*) AS count FROM review_evidence_publications WHERE run_id = ? GROUP BY kind ORDER BY kind'
        )
        .all(target.id)
    ).toEqual([
      { kind: 'run-attempt', count: 2 },
      { kind: 'run-input', count: 1 },
    ]);
  });
  it.each(['run-input', 'run-attempt'] as const)(
    'rejects a different run revision under %s',
    (kind) => {
      const f = fixture();
      f.database.exec('BEGIN IMMEDIATE');
      const left = run(f);
      const right = run(f);
      expect(() => publication(f, kind, { id: left.id, revision: right.revision })).toThrow(
        expect.objectContaining({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
      );
      f.database.exec('COMMIT');
    }
  );
});
