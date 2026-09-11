import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));

function database() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  db.prepare('INSERT INTO project_counters VALUES (1, 0, 0)').run();
  return db;
}

function receipt(db: Database.Database, id = uuidv7()) {
  db.prepare(
    "INSERT INTO operations VALUES (?, 'exact-revision.fixture', 1, '{}', '{}', ?, 'null', '{}', 1, 1)"
  ).run(id, 'a'.repeat(64));
  return id;
}

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function claim(db: Database.Database, previous: { claimId: string; revisionId: string } | null) {
  const claimId = previous?.claimId ?? uuidv7();
  const revisionId = uuidv7();
  const record = bytes({ claim: 'the reader drops a retained row', revision: revisionId });
  // The continuing entity and its first revision reference each other, so they are published
  // together and the deferred constraints resolve at commit.
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO claim_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    revisionId,
    claimId,
    previous?.revisionId ?? null,
    uuidv7(),
    'checkpoint.claims',
    0,
    'claude-code',
    JSON.stringify({ event_id: uuidv7() }),
    JSON.stringify({ command: 'pnpm test', exit_code: 0 }),
    'agent_reported',
    record,
    hash(record),
    receipt(db)
  );
  if (!previous)
    db.prepare('INSERT INTO claims VALUES (?,?,?)').run(claimId, revisionId, receipt(db));
  db.exec('COMMIT');
  return { claimId, revisionId };
}

function decision(
  db: Database.Database,
  previous: { decisionId: string; revisionId: string } | null
) {
  const decisionId = previous?.decisionId ?? uuidv7();
  const revisionId = uuidv7();
  const record = bytes({
    decision: 'store exact revisions',
    reason: 'the gate asks for survival, not resolution',
    alternatives: [{ option: 'governing views', rejected_because: 'separately gated' }],
  });
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO decision_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    revisionId,
    decisionId,
    previous?.revisionId ?? null,
    uuidv7(),
    'plan.decisions',
    0,
    'claude-code',
    1,
    record,
    hash(record),
    receipt(db)
  );
  if (!previous)
    db.prepare('INSERT INTO decisions VALUES (?,?,?)').run(decisionId, revisionId, receipt(db));
  db.exec('COMMIT');
  return { decisionId, revisionId };
}

function relationship(
  db: Database.Database,
  from: { kind: string; id: string; revisionId: string },
  to: { kind: string; id: string; revisionId: string },
  relation = 'supersedes'
) {
  const relationshipId = uuidv7();
  db.prepare('INSERT INTO record_relationships VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    relationshipId,
    relation,
    from.kind,
    from.id,
    from.revisionId,
    to.kind,
    to.id,
    to.revisionId,
    'project',
    null,
    'author',
    'claude-code',
    '[]',
    receipt(db)
  );
  return relationshipId;
}

it('keeps continuing entities, their immutable revisions and the frozen occurrence tuple', () => {
  const db = database();
  const first = claim(db, null);
  const second = claim(db, { claimId: first.claimId, revisionId: first.revisionId });
  expect(second.claimId).toBe(first.claimId);
  expect(
    db.prepare('SELECT count(*) AS n FROM claim_revisions WHERE claim_id=?').get(first.claimId)
  ).toEqual({ n: 2 });

  const revision = db
    .prepare(
      'SELECT source_event_id, field_path, position FROM claim_revisions WHERE revision_id=?'
    )
    .get(first.revisionId) as { source_event_id: string; field_path: string; position: number };
  // A second record cannot claim an occurrence another record already holds.
  expect(() =>
    db
      .prepare('INSERT INTO claim_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        uuidv7(),
        first.claimId,
        second.revisionId,
        revision.source_event_id,
        revision.field_path,
        revision.position,
        'claude-code',
        '{}',
        null,
        null,
        bytes({}),
        hash(bytes({})),
        receipt(db)
      )
  ).toThrow();
  // The same text at a different original occurrence stays a separate record.
  const other = uuidv7();
  db.prepare('INSERT INTO claim_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    other,
    first.claimId,
    second.revisionId,
    revision.source_event_id,
    revision.field_path,
    revision.position + 1,
    'claude-code',
    '{}',
    null,
    null,
    bytes({}),
    hash(bytes({})),
    receipt(db)
  );
  expect(other).not.toBe(first.revisionId);
});

it('refuses to update, delete or replace any retained exact-revision row', () => {
  const db = database();
  const one = claim(db, null);
  const two = decision(db, null);
  const edge = relationship(
    db,
    { kind: 'claim', id: one.claimId, revisionId: one.revisionId },
    { kind: 'decision', id: two.decisionId, revisionId: two.revisionId },
    'challenges'
  );
  db.prepare('INSERT INTO adoptions VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    uuidv7(),
    'decision',
    two.decisionId,
    two.revisionId,
    'owner',
    '2026-09-01T00:00:00.000Z',
    'project',
    null,
    '[]',
    receipt(db)
  );
  const record = bytes({ assessment: 'eligible' });
  db.prepare('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    uuidv7(),
    one.claimId,
    one.revisionId,
    'claude-code',
    4,
    2,
    JSON.stringify({ command: 'pnpm test', exit_code: 0 }),
    'agent_reported',
    record,
    hash(record),
    receipt(db)
  );
  const families = [
    'criterion_lineage',
    'claims',
    'claim_revisions',
    'decisions',
    'decision_revisions',
    'record_relationships',
    'adoptions',
    'assessments',
  ];
  const triggers = new Set(
    (
      db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all() as { name: string }[]
    ).map((row) => row.name)
  );
  for (const table of families)
    for (const guard of ['no_update', 'no_delete', 'no_replace'])
      expect(triggers.has(`${table}_${guard}`), `${table}_${guard}`).toBe(true);
  for (const table of families.filter((name) => name !== 'criterion_lineage')) {
    expect(() => db.prepare(`DELETE FROM ${table}`).run(), table).toThrow(/retained/);
    expect(() => db.prepare(`UPDATE ${table} SET operation_id=operation_id`).run(), table).toThrow(
      /immutable/
    );
  }
  const retainedEdge = db
    .prepare('SELECT * FROM record_relationships WHERE relationship_id=?')
    .get(edge);
  const retainedAdoption = db.prepare('SELECT * FROM adoptions').get() as Record<string, unknown>;
  const replaceEdge = (relationshipId: string, scope: string, scopeValue: string | null) =>
    db
      .prepare('INSERT OR REPLACE INTO record_relationships VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        relationshipId,
        'challenges',
        'claim',
        one.claimId,
        one.revisionId,
        'decision',
        two.decisionId,
        two.revisionId,
        scope,
        scopeValue,
        'detector',
        'someone-else',
        '[]',
        receipt(db)
      );
  const replaceAdoption = (adoptionId: string, scope: string, scopeValue: string | null) =>
    db
      .prepare('INSERT OR REPLACE INTO adoptions VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(
        adoptionId,
        'decision',
        two.decisionId,
        two.revisionId,
        'owner',
        '2099-01-01T00:00:00.000Z',
        scope,
        scopeValue,
        '[]',
        receipt(db)
      );
  // The primary key is not the only way in: a fresh ID colliding on a secondary unique tuple or
  // on the partial project-scope index would replace the retained row just as silently.
  expect(() => replaceEdge(edge, 'project', null)).toThrow(/cannot be replaced/);
  expect(() => replaceEdge(uuidv7(), 'project', null)).toThrow(/cannot be replaced/);
  expect(() => replaceAdoption(uuidv7(), 'project', null)).toThrow(/cannot be replaced/);
  expect(
    db.prepare('SELECT * FROM record_relationships WHERE relationship_id=?').get(edge)
  ).toEqual(retainedEdge);
  expect(db.prepare('SELECT * FROM adoptions').get()).toEqual(retainedAdoption);

  const branch = 'history-database-gate-second-half';
  db.prepare('INSERT INTO record_relationships VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    uuidv7(),
    'challenges',
    'claim',
    one.claimId,
    one.revisionId,
    'decision',
    two.decisionId,
    two.revisionId,
    'branch',
    branch,
    'author',
    'claude-code',
    '[]',
    receipt(db)
  );
  db.prepare('INSERT INTO adoptions VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    uuidv7(),
    'decision',
    two.decisionId,
    two.revisionId,
    'owner',
    '2026-09-01T00:00:00.000Z',
    'branch',
    branch,
    '[]',
    receipt(db)
  );
  const branchEdge = db
    .prepare('SELECT * FROM record_relationships WHERE scope_kind=?')
    .get('branch');
  const branchAdoption = db.prepare('SELECT * FROM adoptions WHERE scope_kind=?').get('branch');
  expect(() => replaceEdge(uuidv7(), 'branch', branch)).toThrow(/cannot be replaced/);
  expect(() => replaceAdoption(uuidv7(), 'branch', branch)).toThrow(/cannot be replaced/);
  expect(db.prepare('SELECT * FROM record_relationships WHERE scope_kind=?').get('branch')).toEqual(
    branchEdge
  );
  expect(db.prepare('SELECT * FROM adoptions WHERE scope_kind=?').get('branch')).toEqual(
    branchAdoption
  );
});

it('refuses a revision that names itself as its own previous revision', () => {
  const db = database();
  const first = claim(db, null);
  const revisionId = uuidv7();
  expect(() =>
    db
      .prepare('INSERT INTO claim_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        revisionId,
        first.claimId,
        revisionId,
        uuidv7(),
        'checkpoint.claims',
        7,
        'claude-code',
        '{}',
        null,
        null,
        bytes({}),
        hash(bytes({})),
        receipt(db)
      )
  ).toThrow(/CHECK constraint failed/);
  const decided = decision(db, null);
  const decisionRevisionId = uuidv7();
  expect(() =>
    db
      .prepare('INSERT INTO decision_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        decisionRevisionId,
        decided.decisionId,
        decisionRevisionId,
        uuidv7(),
        'plan.decisions',
        7,
        'claude-code',
        0,
        bytes({}),
        hash(bytes({})),
        receipt(db)
      )
  ).toThrow(/CHECK constraint failed/);
  expect(
    db.prepare('SELECT count(*) AS n FROM claim_revisions WHERE claim_id=?').get(first.claimId)
  ).toEqual({ n: 1 });
  expect(
    db
      .prepare('SELECT count(*) AS n FROM decision_revisions WHERE decision_id=?')
      .get(decided.decisionId)
  ).toEqual({ n: 1 });
});

it('requires both exact endpoint revisions and leaves an older edge on the revision it named', () => {
  const db = database();
  const claimOne = claim(db, null);
  const first = decision(db, null);
  const edge = relationship(
    db,
    { kind: 'claim', id: claimOne.claimId, revisionId: claimOne.revisionId },
    { kind: 'decision', id: first.decisionId, revisionId: first.revisionId },
    'challenges'
  );
  const second = decision(db, {
    decisionId: first.decisionId,
    revisionId: first.revisionId,
  });
  expect(
    db.prepare('SELECT to_revision_id FROM record_relationships WHERE relationship_id=?').get(edge)
  ).toEqual({ to_revision_id: first.revisionId });
  expect(second.revisionId).not.toBe(first.revisionId);

  expect(() =>
    relationship(
      db,
      { kind: 'claim', id: claimOne.claimId, revisionId: claimOne.revisionId },
      { kind: 'decision', id: first.decisionId, revisionId: uuidv7() }
    )
  ).toThrow(/exact endpoint revisions/);
  expect(() =>
    relationship(
      db,
      { kind: 'claim', id: claimOne.claimId, revisionId: claimOne.revisionId },
      { kind: 'decision', id: second.decisionId, revisionId: second.revisionId },
      'depends_on'
    )
  ).toThrow();
});

it('refuses an adoption without its exact target revision and keeps approval out of authorship', () => {
  const db = database();
  const authored = decision(db, null);
  expect(() =>
    db
      .prepare('INSERT INTO adoptions VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(
        uuidv7(),
        'decision',
        authored.decisionId,
        uuidv7(),
        'owner',
        '2026-09-01T00:00:00.000Z',
        'project',
        null,
        '[]',
        receipt(db)
      )
  ).toThrow(/exact approval target revision/);
  db.prepare('INSERT INTO adoptions VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    uuidv7(),
    'decision',
    authored.decisionId,
    authored.revisionId,
    'owner',
    '2026-09-01T00:00:00.000Z',
    'branch',
    'history-database-gate-second-half',
    '[]',
    receipt(db)
  );
  expect(
    db
      .prepare('SELECT authored_by FROM decision_revisions WHERE revision_id=?')
      .get(authored.revisionId)
  ).toEqual({ authored_by: 'claude-code' });
});

it('declares no governing view, current selection or resolution row', () => {
  const db = database();
  const declared = (
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type IN ('table','view') AND name IN ('criterion_lineage','claims','claim_revisions','decisions','decision_revisions','record_relationships','adoptions','assessments')"
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  expect(declared.sort()).toEqual([
    'adoptions',
    'assessments',
    'claim_revisions',
    'claims',
    'criterion_lineage',
    'decision_revisions',
    'decisions',
    'record_relationships',
  ]);
  for (const table of declared) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name
    );
    expect(
      columns.filter((column) =>
        /governing|current|refuted|disputed|superseded_by|depends_on/.test(column)
      ),
      table
    ).toEqual([]);
  }
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='view'").get()).toEqual({
    n: 0,
  });
});
