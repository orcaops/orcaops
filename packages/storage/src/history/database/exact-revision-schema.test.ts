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

// The three NULLs are source_standing, subject_id and subject_revision_id: a released claim
// revision records none of them, and the table still admits one.
const CLAIM_REVISION =
  "INSERT INTO claim_revisions VALUES (?,?,?,?,?,?,?,'actor','source_attributed',NULL,NULL,NULL,?,?,?,?,?,?)";
// The same three, and the three derivation columns a released decision revision never had.
const DECISION_REVISION =
  "INSERT INTO decision_revisions VALUES (?,?,?,?,?,?,?,'actor','source_attributed',NULL,NULL,NULL,NULL,NULL,NULL,?,?,?,?)";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function claim(db: Database.Database, previous: { claimId: string; revisionId: string } | null) {
  const claimId = previous?.claimId ?? uuidv7();
  const revisionId = uuidv7();
  const record = bytes({ claim: 'the reader drops a retained row', revision: revisionId });
  // The continuing entity and its first revision reference each other, so they are published
  // together and the deferred constraints resolve at commit.
  db.exec('BEGIN IMMEDIATE');
  db.prepare(CLAIM_REVISION).run(
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
  db.prepare(DECISION_REVISION).run(
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

interface Endpoint {
  kind: string;
  id: string;
  revisionId: string;
}

function insertRelationship(
  db: Database.Database,
  row: {
    relationshipId?: string;
    relation?: string;
    from: Endpoint;
    to: Endpoint;
    scope?: [kind: string, value: string | null];
    attribution?: [kind: string, to: string | null, basis: string | null];
    standing?: string;
    authorization?: string | null;
  },
  verb = 'INSERT'
) {
  const relationshipId = row.relationshipId ?? uuidv7();
  db.prepare(
    `${verb} INTO record_relationships VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    relationshipId,
    row.relation ?? 'supersedes',
    row.from.kind,
    row.from.id,
    row.from.revisionId,
    row.to.kind,
    row.to.id,
    row.to.revisionId,
    ...(row.scope ?? ['project', null]),
    ...(row.attribution ?? ['author', 'claude-code', 'source_attributed']),
    row.standing ?? 'established',
    'the later revision replaces the earlier one',
    '[]',
    row.authorization ?? null,
    null,
    receipt(db)
  );
  return relationshipId;
}

function relationship(
  db: Database.Database,
  from: Endpoint,
  to: Endpoint,
  relation = 'supersedes'
) {
  return insertRelationship(db, { from, to, relation });
}

function insertAdoption(
  db: Database.Database,
  row: {
    adoptionId?: string;
    target: Endpoint;
    approver?: [name: string | null, basis: string];
    approvedAt?: string;
    scope?: [kind: string, value: string | null];
    designation?: string;
    authorization?: string | null;
  },
  verb = 'INSERT'
) {
  db.prepare(`${verb} INTO adoptions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.adoptionId ?? uuidv7(),
    row.target.kind,
    row.target.id,
    row.target.revisionId,
    ...(row.approver ?? ['owner', 'authenticated']),
    row.approvedAt ?? '2026-09-01T00:00:00.000Z',
    ...(row.scope ?? ['project', null]),
    row.designation ?? 'adopted',
    '[]',
    row.authorization ?? null,
    null,
    receipt(db)
  );
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
      .prepare(CLAIM_REVISION)
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
  db.prepare(CLAIM_REVISION).run(
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
  const decided = { kind: 'decision', id: two.decisionId, revisionId: two.revisionId };
  const claimed = { kind: 'claim', id: one.claimId, revisionId: one.revisionId };
  insertAdoption(db, { target: decided });
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
    insertRelationship(
      db,
      {
        relationshipId,
        relation: 'challenges',
        from: claimed,
        to: decided,
        scope: [scope, scopeValue],
        attribution: ['detector', 'someone-else', null],
        standing: 'suggested',
      },
      'INSERT OR REPLACE'
    );
  const replaceAdoption = (adoptionId: string, scope: string, scopeValue: string | null) =>
    insertAdoption(
      db,
      {
        adoptionId,
        target: decided,
        approvedAt: '2099-01-01T00:00:00.000Z',
        scope: [scope, scopeValue],
        designation: 'background',
      },
      'INSERT OR REPLACE'
    );
  expect(() => replaceEdge(edge, 'project', null)).toThrow(/cannot be replaced/);
  expect(() => replaceAdoption(retainedAdoption.adoption_id as string, 'project', null)).toThrow(
    /cannot be replaced/
  );
  expect(
    db.prepare('SELECT * FROM record_relationships WHERE relationship_id=?').get(edge)
  ).toEqual(retainedEdge);
  expect(db.prepare('SELECT * FROM adoptions').get()).toEqual(retainedAdoption);
});

it('writes the same relationship or adoption again under a new id and keeps every earlier row', () => {
  const db = database();
  const one = claim(db, null);
  const two = decision(db, null);
  const claimed = { kind: 'claim', id: one.claimId, revisionId: one.revisionId };
  const decided = { kind: 'decision', id: two.decisionId, revisionId: two.revisionId };
  const edge = (attribution: [string, string | null, string | null], standing: string) =>
    insertRelationship(db, {
      relation: 'challenges',
      from: claimed,
      to: decided,
      attribution,
      standing,
    });
  const edges = () =>
    db
      .prepare(
        'SELECT relationship_id, standing, attributed_to FROM record_relationships ORDER BY rowid'
      )
      .all();

  // A detector only ever suggests: an actor establishing the same edge is the first act that makes
  // it stand. A withdrawal is a correction action in another table, so putting the edge back is an
  // ordinary insert here.
  const suggested = edge(['detector', 'overlap-detector', null], 'suggested');
  const established = edge(['author', 'owner@example.test', 'authenticated'], 'established');
  const again = edge(['author', 'owner@example.test', 'authenticated'], 'established');
  expect(new Set([suggested, established, again]).size).toBe(3);
  const written = edges();
  expect(written).toHaveLength(3);

  const adopt = (designation: string) =>
    insertAdoption(db, { target: decided, designation, approver: ['owner', 'authenticated'] });
  adopt('adopted');
  adopt('adopted');
  adopt('background');
  const adoptions = () =>
    db.prepare('SELECT adoption_id, designation FROM adoptions ORDER BY rowid').all() as Record<
      string,
      unknown
    >[];
  expect(adoptions()).toHaveLength(3);
  const retained = adoptions();

  // Nothing collides, so INSERT OR REPLACE with a fresh id has nothing to replace and appends.
  insertRelationship(
    db,
    { relation: 'challenges', from: claimed, to: decided, standing: 'established' },
    'INSERT OR REPLACE'
  );
  insertAdoption(db, { target: decided }, 'INSERT OR REPLACE');
  expect(edges().slice(0, 3)).toEqual(written);
  expect(adoptions().slice(0, 3)).toEqual(retained);
  expect(edges()).toHaveLength(4);
  expect(adoptions()).toHaveLength(4);

  expect(() =>
    insertRelationship(
      db,
      {
        relationshipId: established,
        relation: 'challenges',
        from: claimed,
        to: decided,
        standing: 'suggested',
      },
      'INSERT OR REPLACE'
    )
  ).toThrow(/cannot be replaced/);
  expect(() =>
    insertAdoption(
      db,
      { adoptionId: retained[0]!.adoption_id as string, target: decided },
      'INSERT OR REPLACE'
    )
  ).toThrow(/cannot be replaced/);
  expect(edges()).toHaveLength(4);
  expect(adoptions()).toHaveLength(4);
});

it('refuses a revision that names itself as its own previous revision', () => {
  const db = database();
  const first = claim(db, null);
  const revisionId = uuidv7();
  expect(() =>
    db
      .prepare(CLAIM_REVISION)
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
      .prepare(DECISION_REVISION)
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

it('requires the exact revision a derived decision came from', () => {
  const db = database();
  const parent = decision(db, null);
  const derived = (changes: { id?: string; revisionId?: string; decisionId?: string } = {}) => {
    const decisionId = changes.decisionId ?? uuidv7();
    const revisionId = uuidv7();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO decision_revisions (revision_id, decision_id, previous_revision_id, source_event_id,
           field_path, position, authored_by, attributed_kind, attributed_basis,
           derived_from_kind, derived_from_id, derived_from_revision_id, alternative_count,
           record_bytes, record_sha256, operation_id)
         VALUES (?,?,NULL,?,'plan.decisions',0,'claude-code','actor','source_attributed','decision',?,?,0,?,?,?)`
      ).run(
        revisionId,
        decisionId,
        uuidv7(),
        changes.id ?? parent.decisionId,
        changes.revisionId ?? parent.revisionId,
        bytes({ derived: true }),
        hash(bytes({ derived: true })),
        receipt(db)
      );
      db.prepare('INSERT INTO decisions VALUES (?,?,?)').run(decisionId, revisionId, receipt(db));
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
    return decisionId;
  };

  const child = derived();
  expect(
    db
      .prepare(
        'SELECT derived_from_kind, derived_from_id, derived_from_revision_id FROM decision_revisions WHERE decision_id=?'
      )
      .get(child)
  ).toEqual({
    derived_from_kind: 'decision',
    derived_from_id: parent.decisionId,
    derived_from_revision_id: parent.revisionId,
  });
  expect(() => derived({ revisionId: uuidv7() })).toThrow(
    /exact expectation revision it derives from/
  );
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
      'refutes'
    )
  ).toThrow(/CHECK constraint failed/);
});

it('refuses an adoption without its exact target revision and keeps approval out of authorship', () => {
  const db = database();
  const authored = decision(db, null);
  expect(() =>
    insertAdoption(db, {
      target: { kind: 'decision', id: authored.decisionId, revisionId: uuidv7() },
    })
  ).toThrow(/exact approval target revision/);
  insertAdoption(db, {
    target: { kind: 'decision', id: authored.decisionId, revisionId: authored.revisionId },
    scope: ['branch', 'history-database-gate-second-half'],
  });
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
