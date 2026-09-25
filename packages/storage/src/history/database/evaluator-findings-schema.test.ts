import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

type Row = Record<string, unknown>;

const AT = '2026-09-01T00:00:00.000Z';
const EVIDENCE_TABLES = [
  'evaluator_run_contexts',
  'evaluator_run_findings',
  'evaluator_findings',
  'evaluator_findings_unreadable',
];

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));

function database() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  return db;
}

function insert(db: Database.Database, table: string, row: Row, verb = 'INSERT') {
  const columns = Object.keys(row);
  return db
    .prepare(
      `${verb} INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    .run(...Object.values(row));
}

function receipt(db: Database.Database): string {
  const id = uuidv7();
  db.prepare(
    "INSERT INTO operations VALUES (?, 'evaluator.fixture', 0, '{}', '{}', ?, 'null', '{}', 1, 1)"
  ).run(id, 'a'.repeat(64));
  return id;
}

function artifact(db: Database.Database): string {
  const artifactId = uuidv7();
  const eventId = uuidv7();
  const operationId = receipt(db);
  db.exec('BEGIN');
  db.prepare('INSERT INTO artifacts VALUES (?, 1)').run(artifactId);
  db.prepare('INSERT INTO artifact_events VALUES (?,?,1,?,NULL,?,?,?,?)').run(
    artifactId,
    eventId,
    Buffer.from('{}'),
    'checksum',
    'a'.repeat(64),
    'plan_captured',
    AT
  );
  db.prepare('INSERT INTO artifact_revisions VALUES (?,1,?,?,1,2,?)').run(
    artifactId,
    operationId,
    'a'.repeat(64),
    eventId
  );
  db.exec('COMMIT');
  return artifactId;
}

const authored = (db: Database.Database) => ({
  record_bytes: Buffer.from('{"handed_over":true}'),
  record_sha256: 'b'.repeat(64),
  operation_id: receipt(db),
});

interface RetainedRun {
  runId: string;
  artifactId: string;
  evaluatorRef: string;
}

function retainContext(db: Database.Database, artifactId?: string): RetainedRun {
  const run = {
    runId: uuidv7(),
    artifactId: artifactId ?? artifact(db),
    evaluatorRef: 'core/step-coverage',
  };
  insert(db, 'evaluator_run_contexts', {
    run_id: run.runId,
    artifact_id: run.artifactId,
    evaluator_ref: run.evaluatorRef,
    evaluator_version: null,
    context_sha256: null,
    base_sha: null,
    head_sha: null,
    producer_payload_bytes: null,
    producer_payload_sha256: null,
    ...authored(db),
  });
  return run;
}

function retainFindings(db: Database.Database, run: RetainedRun, keys: (string | null)[]): void {
  insert(db, 'evaluator_run_findings', {
    run_id: run.runId,
    artifact_id: run.artifactId,
    evaluator_ref: run.evaluatorRef,
    finding_count: keys.length,
    notice_json: null,
    ...authored(db),
  });
  keys.forEach((key, position) =>
    insert(db, 'evaluator_findings', {
      run_id: run.runId,
      position,
      artifact_id: run.artifactId,
      evaluator_ref: run.evaluatorRef,
      finding_key: key,
      title: `Finding ${position}`,
      detail: null,
      locations_json: null,
      conclusion: null,
      operation_id: receipt(db),
    })
  );
}

it('keeps every retained finding: no update, no delete and no replacement', () => {
  const db = database();
  const run = retainContext(db);
  retainFindings(db, run, ['rule/one']);
  insert(db, 'evaluator_findings_unreadable', {
    run_id: retainContext(db, run.artifactId).runId,
    artifact_id: run.artifactId,
    evaluator_ref: run.evaluatorRef,
    source: 'markdown-block',
    detail: 'the block was never closed',
    ...authored(db),
  });

  for (const table of EVIDENCE_TABLES) {
    const before = db.prepare(`SELECT * FROM ${table}`).all() as Row[];
    expect(before.length, table).toBeGreaterThan(0);
    const replacement =
      table === 'evaluator_findings'
        ? { ...before[0]!, operation_id: receipt(db) }
        : { ...before[0]!, ...authored(db) };
    expect(() => insert(db, table, replacement, 'INSERT OR REPLACE'), table).toThrow(
      'Retained evaluator findings cannot be replaced'
    );
    expect(() => db.exec(`UPDATE ${table} SET run_id = run_id`)).toThrow(
      'Retained evaluator findings are immutable'
    );
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(
      'Retained evaluator findings are retained'
    );
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
  }
});

it('requires the settlement receipt on every retained finding', () => {
  const db = database();
  const run = retainContext(db);
  const rows = {
    evaluator_run_findings: {
      run_id: run.runId,
      artifact_id: run.artifactId,
      evaluator_ref: run.evaluatorRef,
      finding_count: 1,
      notice_json: null,
      record_bytes: Buffer.from('{}'),
      record_sha256: 'b'.repeat(64),
    },
    evaluator_findings_unreadable: {
      run_id: run.runId,
      artifact_id: run.artifactId,
      evaluator_ref: run.evaluatorRef,
      source: 'envelope',
      detail: 'the envelope carried findings that could not be read',
      record_bytes: Buffer.from('{}'),
      record_sha256: 'b'.repeat(64),
    },
  };
  for (const [table, row] of Object.entries(rows)) {
    expect(() => insert(db, table, { ...row, operation_id: null }), table).toThrow(/NOT NULL/);
    expect(() => insert(db, table, { ...row, operation_id: uuidv7() }), table).toThrow(
      /FOREIGN KEY/
    );
  }
});

it('lets a run hand over what became of its findings exactly once', () => {
  const db = database();
  const run = retainContext(db);
  retainFindings(db, run, ['rule/one']);

  expect(() =>
    insert(db, 'evaluator_findings_unreadable', {
      run_id: run.runId,
      artifact_id: run.artifactId,
      evaluator_ref: run.evaluatorRef,
      source: 'envelope',
      detail: 'offered twice',
      ...authored(db),
    })
  ).toThrow('A run hands over what became of its findings once');

  const other = retainContext(db, run.artifactId);
  insert(db, 'evaluator_findings_unreadable', {
    run_id: other.runId,
    artifact_id: other.artifactId,
    evaluator_ref: other.evaluatorRef,
    source: 'envelope',
    detail: 'offered and unreadable',
    ...authored(db),
  });
  expect(() => retainFindings(db, other, ['rule/one'])).toThrow(
    'A run hands over what became of its findings once'
  );
});

it('refuses findings for a run whose context was never retained', () => {
  const db = database();
  const artifactId = artifact(db);
  const unknown = { runId: uuidv7(), artifactId, evaluatorRef: 'core/step-coverage' };
  expect(() => retainFindings(db, unknown, ['rule/one'])).toThrow(
    'Retained findings require the context the run was given'
  );
  expect(() =>
    insert(db, 'evaluator_findings_unreadable', {
      run_id: unknown.runId,
      artifact_id: artifactId,
      evaluator_ref: unknown.evaluatorRef,
      source: 'envelope',
      detail: 'offered for a run nothing establishes',
      ...authored(db),
    })
  ).toThrow('Retained findings require the context the run was given');
});

it('refuses a finding filed under another artifact or another evaluator', () => {
  const db = database();
  const run = retainContext(db);
  retainFindings(db, run, ['rule/one']);
  const elsewhere = artifact(db);
  for (const row of [
    { artifact_id: elsewhere },
    { evaluator_ref: 'core/completion-claims' },
  ] as Row[])
    expect(() =>
      insert(db, 'evaluator_findings', {
        run_id: run.runId,
        position: 1,
        artifact_id: run.artifactId,
        evaluator_ref: run.evaluatorRef,
        finding_key: 'rule/two',
        title: 'Filed somewhere its run is not',
        detail: null,
        locations_json: null,
        conclusion: null,
        operation_id: receipt(db),
        ...row,
      })
    ).toThrow('A finding belongs to the artifact and evaluator of the run that established it');
});

it('answers a recurrence from the index rather than a scan, and only for a keyed finding', () => {
  const db = database();
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT run_id, position FROM evaluator_findings
       WHERE artifact_id = ? AND evaluator_ref = ? AND finding_key = ?`
    )
    .all(uuidv7(), 'core/step-coverage', 'rule/one') as { detail: string }[];

  expect(plan).toHaveLength(1);
  expect(plan[0]!.detail).toContain('USING INDEX evaluator_finding_recurrence');
  expect(plan[0]!.detail).not.toContain('SCAN');

  // A finding with no key is not in the index, so nothing can look one up for it.
  const run = retainContext(db);
  retainFindings(db, run, [null, 'rule/one']);
  expect(
    db
      .prepare('SELECT count(*) AS n FROM evaluator_findings WHERE finding_key IS NULL')
      .get() as Row
  ).toEqual({ n: 1 });
  expect(() => retainFindings(db, retainContext(db, run.artifactId), ['rule/one'])).not.toThrow();
});

it('keeps one key of one evaluator in one artifact to one finding of one run', () => {
  const db = database();
  const run = retainContext(db);
  insert(db, 'evaluator_run_findings', {
    run_id: run.runId,
    artifact_id: run.artifactId,
    evaluator_ref: run.evaluatorRef,
    finding_count: 2,
    notice_json: null,
    ...authored(db),
  });
  const finding = (position: number) => ({
    run_id: run.runId,
    position,
    artifact_id: run.artifactId,
    evaluator_ref: run.evaluatorRef,
    finding_key: 'rule/one',
    title: `Finding ${position}`,
    detail: null,
    locations_json: null,
    conclusion: null,
    operation_id: receipt(db),
  });
  insert(db, 'evaluator_findings', finding(0));
  expect(() => insert(db, 'evaluator_findings', finding(1))).toThrow(/UNIQUE/);
});

it('names its producer payload by a hash whenever it keeps one', () => {
  const db = database();
  const artifactId = artifact(db);
  const row = {
    run_id: uuidv7(),
    artifact_id: artifactId,
    evaluator_ref: 'core/step-coverage',
    evaluator_version: null,
    context_sha256: null,
    base_sha: null,
    head_sha: null,
    ...authored(db),
  };
  expect(() =>
    insert(db, 'evaluator_run_contexts', {
      ...row,
      producer_payload_bytes: Buffer.from('PASS'),
      producer_payload_sha256: null,
    })
  ).toThrow(/CHECK/);
  expect(() =>
    insert(db, 'evaluator_run_contexts', {
      ...row,
      producer_payload_bytes: null,
      producer_payload_sha256: 'c'.repeat(64),
    })
  ).toThrow(/CHECK/);
});
