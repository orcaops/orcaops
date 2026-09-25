// The two rules the evidence tables hold themselves, proved by inserting straight into them: a
// writer is a convention, and neither of these may rest on one.
//
// A snapshot-bound observation is impossible without an execution that consumed exactly the
// identified inputs the observation names, and a supported or contradicted conclusion is
// impossible against unidentified software.
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

type Row = Record<string, unknown>;

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));

// No foreign key and no trigger in the way, so a refusal can only be the table's own CHECK.
function constraintsOnly() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  db.pragma('foreign_keys = OFF');
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_schema WHERE type='trigger'")
    .all() as { name: string }[])
    db.exec(`DROP TRIGGER ${name}`);
  return db;
}

// Everything but the trigger that requires the expectation revision, which a whole retained
// requirement would be needed for and which is not what this is about.
function withTriggers() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  db.pragma('foreign_keys = OFF');
  db.pragma('recursive_triggers = OFF');
  db.exec('DROP TRIGGER knowledge_assessment_conclusion_requires_expectation');
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

const INPUTS = JSON.stringify([
  { identity: `src/upload.ts@sha256:${'1'.repeat(64)}`, kind: 'file' },
]);
const MORE = JSON.stringify([
  { identity: `src/retry.ts@sha256:${'2'.repeat(64)}`, kind: 'file' },
  { identity: `src/upload.ts@sha256:${'1'.repeat(64)}`, kind: 'file' },
]);

const observation = (change: Row = {}): Row => ({
  observation_id: uuidv7(),
  source_id: uuidv7(),
  observed_by: null,
  observed_by_basis: 'unknown',
  method_name: 'vitest',
  method_configuration_sha256: null,
  execution_kind: 'runner_established',
  runner: 'orcaops-observed-run',
  consumed_inputs_json: INPUTS,
  input_basis: 'snapshot_bound',
  known_inputs_json: INPUTS,
  outcome: 'passed',
  started_at: null,
  finished_at: null,
  evaluator_run_id: null,
  ...authored,
  ...change,
});

it('refuses a snapshot-bound observation that no execution consumed the inputs of', () => {
  const db = constraintsOnly();
  insert(db, 'knowledge_observations', observation());
  for (const change of [
    // An agent reporting a command, however carefully worded.
    {
      execution_kind: 'agent_reported',
      runner: null,
      consumed_inputs_json: null,
    },
    { execution_kind: 'human_observation', runner: null, consumed_inputs_json: null },
    // Knowing more than it consumed, which is what equal before and after hashes look like.
    { known_inputs_json: MORE },
    // An execution that consumed nothing identified at all.
    { consumed_inputs_json: '[]', known_inputs_json: '[]' },
  ])
    expect(
      () => insert(db, 'knowledge_observations', observation(change)),
      JSON.stringify(change)
    ).toThrow(/CHECK constraint failed/);
  expect(db.prepare('SELECT count(*) AS n FROM knowledge_observations').get()).toEqual({ n: 1 });
});

it('lets the same observation record a partial or unknown basis instead', () => {
  const db = constraintsOnly();
  for (const change of [
    { input_basis: 'partial', known_inputs_json: MORE },
    {
      execution_kind: 'agent_reported',
      runner: null,
      consumed_inputs_json: null,
      input_basis: 'unknown',
      known_inputs_json: '[]',
    },
  ])
    insert(db, 'knowledge_observations', observation(change));
  expect(db.prepare('SELECT count(*) AS n FROM knowledge_observations').get()).toEqual({ n: 2 });
});

it('holds a runner to its consumed inputs and everything else to none', () => {
  const db = constraintsOnly();
  for (const change of [
    { runner: null, input_basis: 'partial' },
    { consumed_inputs_json: null, input_basis: 'partial' },
    {
      execution_kind: 'agent_reported',
      input_basis: 'unknown',
      known_inputs_json: '[]',
      consumed_inputs_json: null,
    },
    {
      execution_kind: 'agent_reported',
      runner: null,
      input_basis: 'unknown',
      known_inputs_json: '[]',
    },
  ])
    expect(
      () => insert(db, 'knowledge_observations', observation(change)),
      JSON.stringify(change)
    ).toThrow(/CHECK constraint failed/);
});

const assessment = (assessmentId: string, implementation: Row): Row => ({
  assessment_id: assessmentId,
  assessed_by: null,
  assessed_by_basis: 'unknown',
  method_name: 'release review',
  method_configuration_sha256: null,
  environment: null,
  observed_write_sequence: 1,
  observed_intent_counter: 1,
  ...implementation,
  ...authored,
});

const conclusion = (assessmentId: string, conclusionValue: string): Row => ({
  assessment_id: assessmentId,
  position: 0,
  expectation_kind: 'requirement',
  expectation_id: uuidv7(),
  expectation_revision_id: uuidv7(),
  conclusion: conclusionValue,
  operation_id: authored.operation_id,
});

const SELECTED = {
  implementation_kind: 'selected',
  implementation_inputs_json: JSON.stringify([{ identity: '0.2.1', kind: 'release' }]),
};
const NONE = { implementation_kind: 'none_selected', implementation_inputs_json: null };

it('refuses a satisfaction claim against unidentified software', () => {
  const db = withTriggers();
  const unidentified = uuidv7();
  insert(db, 'knowledge_assessments', assessment(unidentified, NONE));
  for (const value of ['supported', 'contradicted'])
    expect(() =>
      insert(db, 'knowledge_assessment_conclusions', conclusion(unidentified, value))
    ).toThrow(/No satisfaction claim is made against unidentified software/);

  // The same assessment may still reach the two conclusions that claim no satisfaction.
  for (const [position, value] of ['unresolved', 'not_assessed'].entries())
    insert(db, 'knowledge_assessment_conclusions', {
      ...conclusion(unidentified, value),
      position,
    });

  const identified = uuidv7();
  insert(db, 'knowledge_assessments', assessment(identified, SELECTED));
  insert(db, 'knowledge_assessment_conclusions', conclusion(identified, 'supported'));
  expect(db.prepare('SELECT count(*) AS n FROM knowledge_assessment_conclusions').get()).toEqual({
    n: 3,
  });
});

it('holds an identified implementation to its inputs and an unidentified one to none', () => {
  const db = constraintsOnly();
  for (const implementation of [
    { implementation_kind: 'selected', implementation_inputs_json: null },
    { implementation_kind: 'selected', implementation_inputs_json: '[]' },
    {
      ...NONE,
      implementation_inputs_json: JSON.stringify([{ identity: '0.2.1', kind: 'release' }]),
    },
  ])
    expect(
      () => insert(db, 'knowledge_assessments', assessment(uuidv7(), implementation)),
      JSON.stringify(implementation)
    ).toThrow(/CHECK constraint failed/);
  // An environment says where identified software ran, so there is none to name without it.
  expect(() =>
    insert(db, 'knowledge_assessments', {
      ...assessment(uuidv7(), NONE),
      environment: 'macOS 15.3',
    })
  ).toThrow(/CHECK constraint failed/);
});

it('weighs only evidence this history holds, and concludes once about each expectation', () => {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  db.pragma('foreign_keys = OFF');
  db.pragma('recursive_triggers = OFF');
  const assessmentId = uuidv7();
  insert(db, 'knowledge_assessments', assessment(assessmentId, SELECTED));
  expect(() =>
    insert(db, 'knowledge_assessment_evidence', {
      assessment_id: assessmentId,
      position: 0,
      evidence_kind: 'observation',
      evidence_id: uuidv7(),
      role: 'supports',
      operation_id: authored.operation_id,
    })
  ).toThrow(/An assessment weighs evidence this history holds/);
  expect(() =>
    insert(db, 'knowledge_assessment_conclusions', conclusion(assessmentId, 'unresolved'))
  ).toThrow(/An assessment requires the exact expectation revision it concludes about/);

  const twice = withTriggers();
  insert(twice, 'knowledge_assessments', assessment(assessmentId, SELECTED));
  const first = conclusion(assessmentId, 'supported');
  insert(twice, 'knowledge_assessment_conclusions', first);
  // The replace guard names the unique tuple as well as the primary key, so a second conclusion
  // about one expectation is refused before the index is reached.
  expect(() =>
    insert(twice, 'knowledge_assessment_conclusions', {
      ...first,
      position: 1,
      conclusion: 'contradicted',
    })
  ).toThrow(/Evidence records cannot be replaced/);
});
