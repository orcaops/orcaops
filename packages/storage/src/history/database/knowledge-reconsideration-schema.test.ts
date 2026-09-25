// The rules the reconsideration tables hold themselves, proved by inserting straight into them: a
// writer is a convention, and neither of these may rest on one.
//
// One affected thing and one cause is one item, and an item somebody has already reconsidered,
// declined or superseded takes no further disposition.
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

type Row = Record<string, unknown>;

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));

function store(withTriggers: boolean) {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  db.pragma('foreign_keys = OFF');
  db.pragma('recursive_triggers = OFF');
  if (!withTriggers)
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_schema WHERE type='trigger'")
      .all() as { name: string }[])
      db.exec(`DROP TRIGGER ${name}`);
  return db;
}

const insert = (db: Database.Database, table: string, row: Row) =>
  db
    .prepare(
      `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
        .map(() => '?')
        .join(',')})`
    )
    .run(...Object.values(row));

const authored = {
  record_bytes: Buffer.from('{"authored":true}'),
  record_sha256: 'b'.repeat(64),
  operation_id: uuidv7(),
};

const item = (change: Row = {}): Row => ({
  item_id: '1'.repeat(64),
  affected_kind: 'plan_event',
  affected_id: 'plan-event-1',
  cause_kind: 'revision',
  cause_id: '2'.repeat(64),
  opened_at_boundary: 12,
  owner: null,
  owner_basis: 'unknown',
  owner_from: null,
  ...authored,
  ...change,
});

const disposition = (change: Row = {}): Row => ({
  item_id: '1'.repeat(64),
  position: 0,
  disposition: 'acknowledged',
  outcome_kind: null,
  outcome_id: null,
  reason: null,
  superseded_by_item_id: null,
  disposed_by: 'owner@example.test',
  disposed_by_basis: 'agent_reported_user_instruction',
  disposed_at: '2026-09-18T09:00:00.000Z',
  ...authored,
  ...change,
});

it('holds one item for one affected thing and cause, whatever id it is offered under', () => {
  const db = store(false);
  insert(db, 'reconsideration_items', item());

  expect(() => insert(db, 'reconsideration_items', item({ item_id: '3'.repeat(64) }))).toThrow(
    /UNIQUE constraint failed/
  );
  expect(() =>
    insert(db, 'reconsideration_items', item({ item_id: '3'.repeat(64), cause_id: '4'.repeat(64) }))
  ).not.toThrow();
});

it('refuses a disposition of an item somebody has already decided', () => {
  const db = store(true);
  insert(db, 'reconsideration_items', item());
  insert(db, 'reconsideration_dispositions', disposition());
  insert(
    db,
    'reconsideration_dispositions',
    disposition({ position: 1, disposition: 'declined', reason: 'the queue was removed' })
  );

  for (const next of [
    disposition({ position: 2 }),
    disposition({ position: 2, disposition: 'reconsidered', outcome_kind: 'unchanged' }),
  ])
    expect(() => insert(db, 'reconsideration_dispositions', next)).toThrow(
      /takes no further disposition/
    );
});

it('pairs every disposition with exactly the fields that disposition carries', () => {
  const db = store(false);
  for (const wrong of [
    // Reconsidered without an outcome, and an outcome on something that is not a reconsideration.
    disposition({ disposition: 'reconsidered' }),
    disposition({ outcome_kind: 'unchanged' }),
    // A revision outcome with nothing named, and a named outcome on `unchanged`.
    disposition({ disposition: 'reconsidered', outcome_kind: 'revision' }),
    disposition({ disposition: 'reconsidered', outcome_kind: 'unchanged', outcome_id: 'r-1' }),
    // Declined with no reason, and a reason on an acknowledgement.
    disposition({ disposition: 'declined' }),
    disposition({ reason: 'because' }),
    // Superseded by nothing, by itself, and a superseding item on an acknowledgement.
    disposition({ disposition: 'superseded' }),
    disposition({ disposition: 'superseded', superseded_by_item_id: '1'.repeat(64) }),
    disposition({ superseded_by_item_id: '5'.repeat(64) }),
  ])
    expect(() => insert(db, 'reconsideration_dispositions', wrong), JSON.stringify(wrong)).toThrow(
      /CHECK constraint failed/
    );
});

it('keeps an owner’s name and basis together, or names nobody at all', () => {
  const db = store(false);
  for (const wrong of [
    item({ owner: 'owner@example.test' }),
    item({ owner_basis: 'other_assertion' }),
    item({ owner: 'owner@example.test', owner_basis: 'other_assertion' }),
  ])
    expect(() => insert(db, 'reconsideration_items', wrong), JSON.stringify(wrong)).toThrow(
      /CHECK constraint failed/
    );
  expect(() =>
    insert(
      db,
      'reconsideration_items',
      item({
        owner: 'owner@example.test',
        owner_basis: 'other_assertion',
        owner_from: 'the assessor this assessment records',
      })
    )
  ).not.toThrow();
});

it('keeps every reconsideration row: no update, no delete and no replacement', () => {
  const db = store(true);
  insert(db, 'reconsideration_items', item());
  insert(db, 'reconsideration_dispositions', disposition());
  for (const [table, row] of [
    ['reconsideration_items', item()],
    ['reconsideration_dispositions', disposition()],
  ] as const) {
    const before = db.prepare(`SELECT * FROM ${table}`).all();
    expect(() => db.prepare(`DELETE FROM ${table}`).run(), table).toThrow(
      /Reconsideration records are retained/
    );
    expect(() => db.prepare(`UPDATE ${table} SET operation_id=operation_id`).run(), table).toThrow(
      /Reconsideration records are immutable/
    );
    expect(
      () =>
        db
          .prepare(
            `INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(
              row
            )
              .map(() => '?')
              .join(',')})`
          )
          .run(...Object.values(row)),
      table
    ).toThrow(/Reconsideration records cannot be replaced/);
    expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(before);
  }
});
