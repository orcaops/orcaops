import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { STORAGE_OWNED_TABLES } from './transactions.js';
import { uuidv7 } from '../../ids/uuidv7.js';

type Row = Record<string, unknown>;
interface Definition {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

const AUTHORED_TABLES = [
  'knowledge_sources',
  'subjects',
  'subject_revisions',
  'requirements',
  'requirement_revisions',
  'task_uses',
  'recorded_choices',
  'approval_bindings',
  'approval_binding_targets',
  'approval_binding_departures',
  'selector_resolutions',
  'knowledge_exceptions',
  'knowledge_authorizations',
  'conflict_answers',
  'assignments',
  'assignment_members',
  'knowledge_revocations',
  'correction_actions',
  'correction_targets',
  'passage_restatements',
  'claim_revision_observations',
];
const INTERPRETATION_TABLES = [
  'knowledge_interpretations',
  'knowledge_interpretation_evidence',
  'knowledge_equivalence_dispositions',
];
const SCHEDULING_TABLES = [
  'processing_jobs',
  'processing_model_confirmations',
  'processing_job_reopenings',
  'processing_attempts',
  'processing_lease',
  'processing_usage',
  'processing_control',
];
// What an evaluator run established beside itself, and the handover a pending capture retains so
// the settlement that finishes it writes what the interrupted one would have. Their own guards
// and readers are covered by `evaluator-findings.test.ts`; they are named here because this test
// is what fixes everything the current schema adds to the released definition.
const EVIDENCE_TABLES = [
  'evaluator_run_contexts',
  'evaluator_run_findings',
  'evaluator_findings',
  'evaluator_findings_unreadable',
  'pending_capture_evaluator_evidence',
];
// Observations and task-independent assessments. Their own rules — a snapshot-bound claim without
// identified consumed inputs, and a satisfaction claim against unidentified software — are covered
// by `knowledge-evidence-schema.test.ts`; they are named here because this test is what fixes
// everything the current schema adds to the released definition.
const KNOWLEDGE_EVIDENCE_TABLES = [
  'knowledge_observations',
  'knowledge_assessments',
  'knowledge_assessment_conclusions',
  'knowledge_assessment_evidence',
  'knowledge_assessment_check_states',
];
// Reconsideration items and their dispositions. Their own rules — one item per affected thing and
// cause, and a decided item taking no second disposition — are covered by
// `knowledge-reconsideration-schema.test.ts`; they are named here because this test is what fixes
// everything schema 31 adds to the released definition.
const RECONSIDERATION_TABLES = ['reconsideration_items', 'reconsideration_dispositions'];
const REBUILT_TABLES = [
  'adoptions',
  'claim_revisions',
  'decision_revisions',
  'pending_capture_requests',
  'record_relationships',
];
const AT = '2026-09-01T00:00:00.000Z';

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

// Constraints alone: with no trigger and no foreign key in the way, a refusal can only be the
// table's own CHECK, NOT NULL or UNIQUE.
function constraintsOnly() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  db.pragma('foreign_keys = OFF');
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_schema WHERE type='trigger'")
    .all() as {
    name: string;
  }[])
    db.exec(`DROP TRIGGER ${name}`);
  return db;
}

const definitions = (db: Database.Database) =>
  db
    .prepare(
      'SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name'
    )
    .all() as Definition[];

function insert(db: Database.Database, table: string, row: Row, verb = 'INSERT') {
  const columns = Object.keys(row);
  return db
    .prepare(
      `${verb} INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    .run(...Object.values(row));
}

function receipt(db: Database.Database) {
  const id = uuidv7();
  db.prepare(
    "INSERT INTO operations VALUES (?, 'knowledge.fixture', 1, '{}', '{}', ?, 'null', '{}', 1, 1)"
  ).run(id, 'a'.repeat(64));
  return id;
}

const authored = (db: Database.Database) => ({
  record_bytes: Buffer.from('{"authored":true}'),
  record_sha256: 'b'.repeat(64),
  operation_id: receipt(db),
});

const project = { scope_kind: 'project', scope_value: null };
const owner = (column: string) => ({
  [column]: 'owner@example.test',
  [`${column}_basis`]: 'authenticated',
});
const byOwner = {
  attributed_kind: 'actor',
  attributed_to: 'owner@example.test',
  attributed_basis: 'authenticated',
};
const ref = (prefix: string, kind: string, id: string, revisionId: string) => ({
  [`${prefix}_kind`]: kind,
  [`${prefix}_id`]: id,
  [`${prefix}_revision_id`]: revisionId,
});
const noRef = (prefix: string) => ({
  [`${prefix}_kind`]: null,
  [`${prefix}_id`]: null,
  [`${prefix}_revision_id`]: null,
});

function planEvent(db: Database.Database) {
  const artifactId = uuidv7();
  const eventId = uuidv7();
  db.exec('BEGIN');
  db.prepare('INSERT INTO artifacts VALUES (?, 1)').run(artifactId);
  db.prepare('INSERT INTO artifact_events VALUES (?,?,1,?,NULL,?,?,?,?)').run(
    artifactId,
    eventId,
    Buffer.from('{}'),
    'checksum',
    'hash',
    'plan_captured',
    AT
  );
  db.prepare('INSERT INTO artifact_revisions VALUES (?,1,?,?,1,2,?)').run(
    artifactId,
    receipt(db),
    'ordered',
    eventId
  );
  db.exec('COMMIT');
  return { artifactId, eventId };
}

const noOrigin = {
  derived_from_kind: null,
  criterion_artifact_id: null,
  criterion_plan_event_id: null,
  criterion_id: null,
  ...noRef('expectation'),
  passage_source_id: null,
  passage_location: null,
  passage_sha256: null,
};

const requirementRevisionRow = (
  db: Database.Database,
  requirementId: string,
  revisionId: string,
  previous: string | null
) => ({
  revision_id: revisionId,
  requirement_id: requirementId,
  previous_revision_id: previous,
  subject_id: null,
  subject_revision_id: null,
  source_standing: 'explicit_instruction',
  duration_kind: 'continuing',
  ...byOwner,
  ...authored(db),
});

function requirement(db: Database.Database, origin: Row = { origin_kind: 'authored' }) {
  const requirementId = (origin.requirement_id as string | undefined) ?? uuidv7();
  const revisionId = uuidv7();
  db.exec('BEGIN');
  try {
    insert(
      db,
      'requirement_revisions',
      requirementRevisionRow(db, requirementId, revisionId, null)
    );
    insert(db, 'requirements', {
      requirement_id: requirementId,
      first_revision_id: revisionId,
      ...noOrigin,
      ...origin,
      ...authored(db),
    });
    db.exec('COMMIT');
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  }
  return { kind: 'requirement', id: requirementId, revisionId };
}

const revisionRow = (
  db: Database.Database,
  entity: 'claim' | 'decision' | 'subject',
  id: string,
  previous: string | null,
  changes: Row = {}
): Row => ({
  revision_id: uuidv7(),
  [`${entity}_id`]: id,
  previous_revision_id: previous,
  ...(entity === 'subject'
    ? { subject_kind: 'service', ...owner('authored_by') }
    : {
        source_event_id: uuidv7(),
        field_path: 'summary.statements',
        position: 0,
        [entity === 'claim' ? 'asserted_by' : 'authored_by']: 'claude-code',
        attributed_kind: 'actor',
        attributed_basis: 'source_attributed',
      }),
  ...(entity === 'claim'
    ? { assertion_source_json: '{}', verification_json: null, verification_provenance: null }
    : {}),
  ...(entity === 'decision' ? { alternative_count: 0 } : {}),
  ...authored(db),
  ...changes,
});

function continuing(
  db: Database.Database,
  entity: 'claim' | 'decision' | 'subject',
  previous: { id: string; revisionId: string | null } | null,
  changes: Row = {}
) {
  const id = previous?.id ?? uuidv7();
  const row = revisionRow(db, entity, id, previous?.revisionId ?? null, changes);
  db.exec('BEGIN');
  try {
    insert(db, `${entity}_revisions`, row);
    if (!previous)
      db.prepare(`INSERT INTO ${entity}s VALUES (?,?,?)`).run(id, row.revision_id, receipt(db));
    db.exec('COMMIT');
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  }
  return { kind: entity, id, revisionId: row.revision_id as string };
}

const relationshipRow = (db: Database.Database, from: Row, to: Row, changes: Row = {}) => ({
  relationship_id: uuidv7(),
  relation: 'depends_on',
  from_entity_kind: from.kind,
  from_entity_id: from.id,
  from_revision_id: from.revisionId,
  to_entity_kind: to.kind,
  to_entity_id: to.id,
  to_revision_id: to.revisionId,
  ...project,
  attributed_kind: 'author',
  attributed_to: 'owner@example.test',
  attributed_basis: 'authenticated',
  standing: 'established',
  explanation: 'the limit only matters once the endpoint is public',
  source_refs_json: '[]',
  authorization_json: null,
  authorization_id: null,
  operation_id: receipt(db),
  ...changes,
});

const adoptionRow = (db: Database.Database, target: Row, changes: Row = {}) => ({
  adoption_id: uuidv7(),
  ...ref('target', target.kind as string, target.id as string, target.revisionId as string),
  ...owner('approver'),
  approved_at: AT,
  ...project,
  designation: 'adopted',
  source_refs_json: '[]',
  authorization_json: JSON.stringify({ kind: 'approval_binding', binding_id: uuidv7() }),
  authorization_id: null,
  operation_id: receipt(db),
  ...changes,
});

// One valid row in every knowledge table, inserted through the real triggers and foreign keys.
function populate(db: Database.Database) {
  const { artifactId, eventId } = planEvent(db);
  const rows: Record<string, Row> = {};
  const add = (table: string, row: Row) => {
    insert(db, table, row);
    rows[table] = row;
    return row;
  };

  add('knowledge_sources', {
    source_id: uuidv7(),
    source_kind: 'user_instruction',
    artifact_id: null,
    event_id: null,
    field_path: null,
    position: null,
    retention_kind: 'bytes',
    retained_bytes: Buffer.from('Keep the endpoint available offline.'),
    retained_reference: null,
    content_sha256: 'c'.repeat(64),
    ...owner('source_author'),
    recorded_by: 'claude-code',
    recorded_by_basis: 'source_attributed',
    interpreted_by: null,
    interpreted_by_basis: null,
    access_restriction: null,
    ...authored(db),
  });
  const sourceId = rows.knowledge_sources!.source_id as string;

  const subject = continuing(db, 'subject', null);
  rows.subjects = db.prepare('SELECT * FROM subjects').get() as Row;
  rows.subject_revisions = db.prepare('SELECT * FROM subject_revisions').get() as Row;

  const kept = requirement(db);
  rows.requirements = db.prepare('SELECT * FROM requirements').get() as Row;
  rows.requirement_revisions = db.prepare('SELECT * FROM requirement_revisions').get() as Row;
  const target = ref('target', 'requirement', kept.id, kept.revisionId);

  add('approval_bindings', {
    binding_id: uuidv7(),
    source_plan_ref: 'plans/offline',
    approved_version: '2',
    plan_content_sha256: 'd'.repeat(64),
    ...owner('approved_by'),
    authorization_evidence_source_id: sourceId,
    ...authored(db),
  });
  const bindingId = rows.approval_bindings!.binding_id as string;
  add('approval_binding_targets', {
    binding_id: bindingId,
    position: 0,
    bound_kind: 'revision',
    ...target,
    selector_source_id: null,
    selector_location: null,
    selector_passage_sha256: null,
    ...project,
    designation: 'adopted',
    operation_id: receipt(db),
  });
  add('approval_binding_departures', {
    binding_id: bindingId,
    position: 0,
    ...project,
    ...ref('rule', 'requirement', kept.id, kept.revisionId),
    how: 'withdraws',
    exception_id: null,
    ...noRef('replaced_by'),
    operation_id: receipt(db),
  });
  add('selector_resolutions', {
    binding_id: bindingId,
    selector_source_id: sourceId,
    selector_location: 'line 1',
    selector_passage_sha256: 'e'.repeat(64),
    ...ref('resolved', 'requirement', kept.id, kept.revisionId),
    ...project,
    designation: 'adopted',
    ...authored(db),
  });
  add('knowledge_authorizations', {
    authorization_id: uuidv7(),
    instruction_kind: 'informed_instruction',
    instruction_source_id: sourceId,
    ...project,
    ...owner('granted_by'),
    ...authored(db),
  });
  add('knowledge_exceptions', {
    exception_id: uuidv7(),
    ...ref('expectation', 'requirement', kept.id, kept.revisionId),
    ...project,
    ...owner('granted_by'),
    authorization_kind: 'informed_instruction',
    end_kind: 'until_revoked',
    end_behavior: 'none_recorded',
    ...authored(db),
  });
  add('task_uses', {
    artifact_id: artifactId,
    plan_event_id: eventId,
    ...target,
    role: 'implement',
    step_id: null,
    criterion_id: null,
    exception_id: null,
    selection_kind: 'selected_with_plan',
    discovered_at: null,
    discovered_by: null,
    discovered_by_basis: null,
    ...authored(db),
  });
  add('recorded_choices', {
    selection_id: uuidv7(),
    selection_kind: 'working',
    ...target,
    ...project,
    ...owner('selected_by'),
    ...authored(db),
  });
  add('conflict_answers', {
    answer_id: uuidv7(),
    ...ref('rule', 'requirement', kept.id, kept.revisionId),
    outcome: 'declined',
    ...project,
    ...owner('answered_by'),
    authorization_id: null,
    ...authored(db),
  });
  add('assignments', {
    assignment_id: uuidv7(),
    objective: 'Keep the offline endpoint working',
    ...owner('responsible'),
    ...owner('assigned_by'),
    ...project,
    authorization_kind: 'informed_instruction',
    source_id: sourceId,
    valid_until: null,
    ...authored(db),
  });
  add('assignment_members', {
    assignment_id: rows.assignments!.assignment_id,
    member_kind: 'requirement',
    member_id: kept.id,
    operation_id: receipt(db),
  });
  add('knowledge_revocations', {
    revocation_id: uuidv7(),
    revoked_kind: 'exception',
    revoked_id: rows.knowledge_exceptions!.exception_id,
    ...project,
    ...owner('revoked_by'),
    instruction_kind: 'explicit_instruction',
    ...authored(db),
  });
  add('correction_actions', {
    action_id: uuidv7(),
    action_kind: 'challenge',
    ...project,
    ...byOwner,
    authorization_kind: null,
    authorization_id: null,
    follows_action_id: null,
    resulting_selection_kind: null,
    ...noRef('adopted'),
    adopted_designation: null,
    change_class: 'proposal',
    changed_what_stands: 0,
    ...authored(db),
  });
  add('correction_targets', {
    action_id: rows.correction_actions!.action_id,
    position: 0,
    ...target,
    operation_id: receipt(db),
  });
  const observationId = uuidv7();
  add('knowledge_observations', {
    observation_id: observationId,
    source_id: sourceId,
    ...owner('observed_by'),
    method_name: 'vitest',
    method_configuration_sha256: null,
    execution_kind: 'agent_reported',
    runner: null,
    consumed_inputs_json: null,
    input_basis: 'unknown',
    known_inputs_json: '[]',
    outcome: 'passed',
    started_at: null,
    finished_at: null,
    evaluator_run_id: null,
    ...authored(db),
  });
  add('claim_revision_observations', {
    revision_id: continuing(db, 'claim', null).revisionId,
    position: 0,
    observation_id: observationId,
    operation_id: receipt(db),
  });
  const assessmentId = uuidv7();
  add('knowledge_assessments', {
    assessment_id: assessmentId,
    ...owner('assessed_by'),
    method_name: 'release review',
    method_configuration_sha256: null,
    implementation_kind: 'selected',
    implementation_inputs_json: JSON.stringify([{ kind: 'release', identity: '0.2.1' }]),
    environment: 'macOS 15.3',
    observed_write_sequence: 1,
    observed_intent_counter: 1,
    ...authored(db),
  });
  add('knowledge_assessment_conclusions', {
    assessment_id: assessmentId,
    position: 0,
    expectation_kind: 'requirement',
    expectation_id: kept.id,
    expectation_revision_id: kept.revisionId,
    conclusion: 'supported',
    operation_id: receipt(db),
  });
  add('knowledge_assessment_evidence', {
    assessment_id: assessmentId,
    position: 0,
    evidence_kind: 'observation',
    evidence_id: observationId,
    role: 'supports',
    operation_id: receipt(db),
  });
  add('knowledge_assessment_check_states', {
    assessment_id: assessmentId,
    position: 0,
    check_name: 'the integration suite',
    state: 'skipped',
    operation_id: receipt(db),
  });
  add('passage_restatements', {
    restatement_id: uuidv7(),
    passage_source_id: sourceId,
    passage_location: 'paragraph 2',
    passage_sha256: 'a'.repeat(64),
    restates_kind: 'requirement',
    restates_id: kept.id,
    restates_revision_id: kept.revisionId,
    ...byOwner,
    ...authored(db),
  });

  add('processing_jobs', {
    job_id: uuidv7(),
    source_kind: 'knowledge_source',
    source_id: sourceId,
    processor_contract: 'knowledge-interpretation@1',
    admitting_operation_id: rows.knowledge_sources!.operation_id,
    admission_json: '{}',
    without_model: 1,
    admitted_at: AT,
    state: 'pending',
    wait_reason: null,
    retry_at: null,
    claimed_generation: null,
    result_json: null,
    model_resumed_at: null,
    model_resumed_by: null,
    model_resumed_by_basis: null,
    model_resume_grant_id: null,
    updated_at: AT,
  });
  add('processing_model_confirmations', {
    confirmation_id: uuidv7(),
    job_id: rows.processing_jobs!.job_id,
    confirmation_sequence: 1,
    confirmed_at: AT,
    ...owner('confirmed_by'),
    grant_id: 'grant-1',
    terms_json: '{}',
  });
  // A reopening needs a job that gave up, and this one is pending again once it is reopened.
  db.prepare("UPDATE processing_jobs SET state='terminal_failure' WHERE job_id=?").run(
    rows.processing_jobs!.job_id
  );
  add('processing_job_reopenings', {
    reopening_id: uuidv7(),
    job_id: rows.processing_jobs!.job_id,
    reopening_sequence: 1,
    attempts_before: 0,
    attempts_allowed: 3,
    gave_up_json: '{"outcome":"attempts_exhausted"}',
    grant_id: 'grant-1',
    reopened_at: AT,
    ...owner('reopened_by'),
  });
  db.prepare("UPDATE processing_jobs SET state='pending' WHERE job_id=?").run(
    rows.processing_jobs!.job_id
  );
  add('processing_attempts', {
    attempt_id: uuidv7(),
    job_id: rows.processing_jobs!.job_id,
    attempt_number: 1,
    owner_generation: 1,
    configuration_sha256: 'f'.repeat(64),
    configuration_json: '{}',
    grant_id: 'grant-1',
    started_at: AT,
    outcome: null,
    finished_at: null,
    usage_json: null,
    detail_json: null,
    process_json: null,
    publishing_operation_id: null,
  });
  add('processing_lease', {
    singleton: 1,
    owner_generation: 1,
    owner_id: 'worker-1',
    acquired_at: AT,
    renewed_at: AT,
    expires_at: AT,
  });
  add('processing_control', {
    singleton: 1,
    paused: 1,
    changed_at: AT,
    ...owner('changed_by'),
    reason: 'the provider is being replaced',
  });
  add('processing_usage', {
    usage_id: uuidv7(),
    attempt_id: rows.processing_attempts!.attempt_id,
    reserved_at: AT,
    reserved_cost_usd: 0.25,
    state: 'reserved',
    settled_at: null,
    reported_cost_usd: null,
    usage_json: null,
  });
  return { rows, artifactId, eventId, sourceId, bindingId, subject, kept, target };
}

it('preserves released definitions outside the rebuilt tables and sibling refusal', () => {
  const db = database();
  expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
  expect(PROJECT_DATABASE_SCHEMA_VERSION).toBe(33);

  const normalized = (objects: Definition[]) =>
    new Map(objects.map((object) => [object.name, object.sql.replace(/\s+/g, ' ').trim()]));
  const released = normalized(
    JSON.parse(readFileSync(new URL('./fixtures/released/schema.json', import.meta.url), 'utf8'))
      .definitions
  );
  const current = normalized(definitions(db));
  const tableOf = new Map(definitions(db).map((object) => [object.name, object.tbl_name]));

  // The two secondary unique indexes are gone with the tuples they enforced: a row id is the
  // identity of a relationship and of an adoption, so a later act may repeat an earlier one.
  expect([...released.keys()].filter((name) => !current.has(name)).sort()).toEqual([
    'adoption_project_identity',
    'claim_revision_continues',
    'decision_revision_continues',
    'record_relationship_project_identity',
  ]);
  expect(
    [...released.keys()]
      .filter((name) => current.has(name) && current.get(name) !== released.get(name))
      .sort()
  ).toEqual([
    'adoption_target',
    'adoptions',
    'adoptions_no_replace',
    'claim_revisions',
    'decision_revisions',
    // A released staged capture records no invocation choice about a model, and the column that
    // holds one is what an explicit consented resume lifts.
    'pending_capture_requests',
    'record_relationship_from_endpoint',
    'record_relationship_to_endpoint',
    'record_relationships',
    'record_relationships_no_replace',
    'remote_requests',
  ]);
  const added = [...current.keys()].filter((name) => !released.has(name));
  expect([...new Set(added.map((name) => tableOf.get(name)!))].sort()).toEqual(
    [
      ...AUTHORED_TABLES,
      ...INTERPRETATION_TABLES,
      ...SCHEDULING_TABLES,
      ...EVIDENCE_TABLES,
      ...KNOWLEDGE_EVIDENCE_TABLES,
      ...RECONSIDERATION_TABLES,
      'activation',
      'artifacts',
      'rationale_accounts',
      'rationale_events',
      'rationale_index_state',
      'rationale_pending_artifacts',
      'rationale_terms',
      'adoptions',
      'decision_revisions',
      'record_relationships',
    ].sort()
  );
  for (const table of [
    ...AUTHORED_TABLES,
    ...INTERPRETATION_TABLES,
    ...SCHEDULING_TABLES,
    ...EVIDENCE_TABLES,
    ...KNOWLEDGE_EVIDENCE_TABLES,
    ...RECONSIDERATION_TABLES,
    ...REBUILT_TABLES,
  ])
    expect(
      db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table),
      table
    ).toEqual({ strict: 1 });
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='view'").get()).toEqual({
    n: 0,
  });
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('keeps every authored knowledge row: no update, no delete and no replacement', () => {
  const db = database();
  const { rows } = populate(db);
  for (const table of AUTHORED_TABLES) {
    const before = db.prepare(`SELECT * FROM ${table}`).all();
    expect(before.length, table).toBeGreaterThan(0);
    expect(() => db.prepare(`DELETE FROM ${table}`).run(), table).toThrow(
      /Knowledge records are retained/
    );
    expect(() => db.prepare(`UPDATE ${table} SET operation_id=operation_id`).run(), table).toThrow(
      /Knowledge records are immutable/
    );
    expect(() => insert(db, table, rows[table]!, 'INSERT OR REPLACE'), table).toThrow(
      /Knowledge records cannot be replaced/
    );
    expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(before);
  }
});

it('keeps every evidence row: no update, no delete and no replacement', () => {
  const db = database();
  const { rows } = populate(db);
  for (const table of KNOWLEDGE_EVIDENCE_TABLES) {
    const before = db.prepare(`SELECT * FROM ${table}`).all();
    expect(before.length, table).toBeGreaterThan(0);
    expect(() => db.prepare(`DELETE FROM ${table}`).run(), table).toThrow(
      /Evidence records are retained/
    );
    expect(() => db.prepare(`UPDATE ${table} SET operation_id=operation_id`).run(), table).toThrow(
      /Evidence records are immutable/
    );
    expect(() => insert(db, table, rows[table]!, 'INSERT OR REPLACE'), table).toThrow(
      /Evidence records cannot be replaced/
    );
    expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(before);
  }
});

it('refuses a fresh identity that collides on a secondary unique tuple, whatever is null in it', () => {
  const db = database();
  const { rows, kept, sourceId, artifactId, eventId } = populate(db);
  const replaced = (table: string, changes: Row) => () =>
    insert(
      db,
      table,
      {
        ...rows[table]!,
        ...changes,
        ...('operation_id' in rows[table]! ? { operation_id: receipt(db) } : {}),
      },
      'INSERT OR REPLACE'
    );

  expect(replaced('task_uses', { role: 'implement' })).toThrow(/cannot be replaced/);
  expect(replaced('approval_binding_targets', { position: 1 })).toThrow(/cannot be replaced/);
  expect(replaced('approval_binding_targets', { position: 1, designation: 'background' })).toThrow(
    /cannot be replaced/
  );
  expect(replaced('selector_resolutions', { designation: 'background' })).toThrow(
    /cannot be replaced/
  );
  expect(replaced('processing_jobs', { job_id: uuidv7() })).toThrow(/cannot be replaced/);
  // Settled first, so the refusal can only be the replace guard and not the admission trigger.
  db.prepare("UPDATE processing_attempts SET outcome='unknown', finished_at=?").run(AT);
  expect(replaced('processing_attempts', { attempt_id: uuidv7() })).toThrow(/cannot be replaced/);
  expect(() =>
    insert(
      db,
      'processing_lease',
      { ...rows.processing_lease!, owner_generation: 9 },
      'INSERT OR REPLACE'
    )
  ).toThrow(/cannot be replaced/);

  const passage = {
    origin_kind: 'promoted_source',
    passage_source_id: sourceId,
    passage_location: 'line 1',
    passage_sha256: 'e'.repeat(64),
  };
  requirement(db, passage);
  expect(() => requirement(db, passage)).toThrow(/cannot be replaced/);
  requirement(db, { ...passage, passage_location: 'line 2' });

  // One capture field occurrence has one source id, so a second id for it is refused however it
  // arrives; the next position in the same field is a different occurrence.
  const captureSource = (changes: Row = {}) => ({
    ...rows.knowledge_sources!,
    source_id: uuidv7(),
    source_kind: 'capture_field',
    artifact_id: artifactId,
    event_id: eventId,
    field_path: 'summary.statements',
    position: 0,
    retention_kind: null,
    retained_bytes: null,
    retained_reference: null,
    content_sha256: null,
    operation_id: receipt(db),
    ...changes,
  });
  insert(db, 'knowledge_sources', captureSource());
  expect(() => insert(db, 'knowledge_sources', captureSource())).toThrow(/cannot be replaced/);
  expect(() => insert(db, 'knowledge_sources', captureSource(), 'INSERT OR REPLACE')).toThrow(
    /cannot be replaced/
  );
  insert(db, 'knowledge_sources', captureSource({ position: 1 }));
  expect(
    db
      .prepare("SELECT count(*) AS n FROM knowledge_sources WHERE source_kind='capture_field'")
      .get()
  ).toEqual({ n: 2 });

  // The same use under an exception, or tied to a step, is a different use.
  insert(db, 'task_uses', {
    ...rows.task_uses!,
    exception_id: rows.knowledge_exceptions!.exception_id,
    operation_id: receipt(db),
  });
  insert(db, 'task_uses', { ...rows.task_uses!, step_id: 'step-1', operation_id: receipt(db) });
  expect(replaced('task_uses', { step_id: 'step-1' })).toThrow(/cannot be replaced/);
  expect(db.prepare('SELECT count(*) AS n FROM task_uses').get()).toEqual({ n: 3 });

  // The same bound target in another scope is a different binding target.
  insert(db, 'approval_binding_targets', {
    ...rows.approval_binding_targets!,
    position: 1,
    scope_kind: 'artifact',
    scope_value: kept.id,
    operation_id: receipt(db),
  });
  insert(db, 'selector_resolutions', {
    ...rows.selector_resolutions!,
    scope_kind: 'artifact',
    scope_value: kept.id,
    operation_id: receipt(db),
  });
});

const VOCABULARIES: Array<[table: string, column: string, refused: unknown]> = [
  ['record_relationships', 'relation', 'refutes'],
  ['record_relationships', 'from_entity_kind', 'relationship'],
  ['record_relationships', 'to_entity_kind', 'subject'],
  ['record_relationships', 'scope_kind', 'worktree'],
  ['record_relationships', 'attributed_kind', 'actor'],
  ['record_relationships', 'attributed_basis', 'verified'],
  ['record_relationships', 'standing', 'adopted'],
  ['record_relationships', 'authorization_json', '{"kind":"delegation"}'],
  ['record_relationships', 'authorization_json', '{}'],
  ['adoptions', 'target_kind', 'subject'],
  ['adoptions', 'approver_basis', 'verified'],
  ['adoptions', 'scope_kind', 'worktree'],
  ['adoptions', 'designation', 'working'],
  ['adoptions', 'authorization_json', '{"kind":"delegation"}'],
  ['claim_revisions', 'attributed_kind', 'author'],
  ['claim_revisions', 'attributed_basis', 'verified'],
  ['decision_revisions', 'attributed_kind', 'author'],
  ['decision_revisions', 'attributed_basis', 'verified'],
  ['decision_revisions', 'source_standing', 'adopted'],
  ['knowledge_sources', 'source_kind', 'web_page'],
  ['knowledge_sources', 'retention_kind', 'url'],
  ['knowledge_sources', 'source_author_basis', 'verified'],
  ['knowledge_sources', 'recorded_by_basis', 'verified'],
  ['knowledge_sources', 'interpreted_kind', 'author'],
  ['knowledge_sources', 'interpreted_by_basis', 'verified'],
  ['claim_revisions', 'source_standing', 'adopted'],
  ['decision_revisions', 'derived_from_kind', 'claim'],
  ['passage_restatements', 'restates_kind', 'subject'],
  ['passage_restatements', 'attributed_kind', 'author'],
  ['passage_restatements', 'attributed_basis', 'verified'],
  ['passage_restatements', 'passage_sha256', 'C'.repeat(64)],
  ['subject_revisions', 'subject_kind', 'path'],
  ['subject_revisions', 'authored_by_basis', 'verified'],
  ['requirements', 'origin_kind', 'imported'],
  ['requirements', 'derived_from_kind', 'claim'],
  ['requirements', 'expectation_kind', 'claim'],
  ['requirement_revisions', 'source_standing', 'adopted'],
  ['requirement_revisions', 'duration_kind', 'forever'],
  ['requirement_revisions', 'attributed_kind', 'author'],
  ['requirement_revisions', 'attributed_basis', 'verified'],
  ['task_uses', 'target_kind', 'claim'],
  ['task_uses', 'role', 'complete'],
  ['task_uses', 'selection_kind', 'working'],
  ['task_uses', 'discovered_kind', 'author'],
  ['task_uses', 'discovered_by_basis', 'verified'],
  ['recorded_choices', 'selection_kind', 'accepted'],
  ['recorded_choices', 'target_kind', 'subject'],
  ['recorded_choices', 'scope_kind', 'branch'],
  ['recorded_choices', 'selected_by_basis', 'verified'],
  ['approval_bindings', 'approved_by_basis', 'verified'],
  ['approval_binding_targets', 'bound_kind', 'path'],
  ['approval_binding_targets', 'target_kind', 'subject'],
  ['approval_binding_targets', 'scope_kind', 'branch'],
  ['approval_binding_targets', 'designation', 'working'],
  ['approval_binding_departures', 'scope_kind', 'branch'],
  ['approval_binding_departures', 'rule_kind', 'claim'],
  ['approval_binding_departures', 'how', 'ignores'],
  ['approval_binding_departures', 'replaced_by_kind', 'subject'],
  ['selector_resolutions', 'resolved_kind', 'subject'],
  ['selector_resolutions', 'scope_kind', 'branch'],
  ['selector_resolutions', 'designation', 'working'],
  ['knowledge_exceptions', 'expectation_kind', 'claim'],
  ['knowledge_exceptions', 'scope_kind', 'branch'],
  ['knowledge_exceptions', 'granted_by_basis', 'verified'],
  ['knowledge_exceptions', 'authorization_kind', 'delegation'],
  ['knowledge_exceptions', 'end_kind', 'never'],
  ['knowledge_exceptions', 'end_behavior', 'expectation_retired'],
  ['knowledge_authorizations', 'instruction_kind', 'approval_binding'],
  ['knowledge_authorizations', 'scope_kind', 'branch'],
  ['knowledge_authorizations', 'granted_by_basis', 'verified'],
  ['conflict_answers', 'rule_kind', 'claim'],
  ['conflict_answers', 'outcome', 'deferred'],
  ['conflict_answers', 'scope_kind', 'branch'],
  ['conflict_answers', 'answered_by_basis', 'verified'],
  ['assignments', 'responsible_basis', 'verified'],
  ['assignments', 'assigned_by_basis', 'verified'],
  ['assignments', 'scope_kind', 'branch'],
  ['assignments', 'authorization_kind', 'delegation'],
  ['assignment_members', 'member_kind', 'subject'],
  ['knowledge_revocations', 'revoked_kind', 'adoption'],
  ['knowledge_revocations', 'scope_kind', 'branch'],
  ['knowledge_revocations', 'revoked_by_basis', 'verified'],
  ['knowledge_revocations', 'instruction_kind', 'reused_authorization'],
  ['correction_actions', 'action_kind', 'refutation'],
  ['correction_actions', 'scope_kind', 'branch'],
  ['correction_actions', 'attributed_kind', 'author'],
  ['correction_actions', 'attributed_basis', 'verified'],
  ['correction_actions', 'authorization_kind', 'delegation'],
  ['correction_actions', 'resulting_selection_kind', 'earlier'],
  ['correction_actions', 'adopted_kind', 'subject'],
  ['correction_actions', 'adopted_designation', 'working'],
  ['correction_actions', 'change_class', 'retraction'],
  ['correction_actions', 'changed_what_stands', 2],
  ['correction_targets', 'target_kind', 'subject'],
  ['processing_jobs', 'source_kind', 'git_commit'],
  ['processing_jobs', 'state', 'paused'],
  ['processing_jobs', 'model_resumed_by_basis', 'verified'],
  ['processing_attempts', 'outcome', 'retried'],
  ['processing_usage', 'state', 'refunded'],
  ['processing_control', 'paused', 2],
  ['processing_control', 'changed_by_basis', 'verified'],
];

// Built once: every case below leaves the constraints-only database as empty as it found it.
let vocabularyCase: { db: Database.Database; rows: Record<string, Row> } | undefined;
function vocabularyRows() {
  if (vocabularyCase) return vocabularyCase;
  const source = database();
  const { rows, kept } = populate(source);
  rows.record_relationships = relationshipRow(source, kept, continuing(source, 'claim', null));
  rows.adoptions = adoptionRow(source, kept);
  rows.claim_revisions = revisionRow(source, 'claim', uuidv7(), null);
  rows.decision_revisions = revisionRow(source, 'decision', uuidv7(), null);
  opened.splice(opened.indexOf(source), 1);
  source.close();
  const db = constraintsOnly();
  opened.splice(opened.indexOf(db), 1);
  vocabularyCase = { db, rows };
  return vocabularyCase;
}
afterAll(() => vocabularyCase?.db.close());

it.each(VOCABULARIES)('refuses %s.%s outside its vocabulary: %s', (table, column, refused) => {
  const { db, rows } = vocabularyRows();
  insert(db, table, rows[table]!);
  db.prepare(`DELETE FROM ${table}`).run();
  expect(() => insert(db, table, { ...rows[table]!, [column]: refused })).toThrow(
    /CHECK constraint failed/
  );
});

it('refuses the half-filled shapes that a NULL comparison would otherwise let through', () => {
  const source = database();
  const { rows, kept, artifactId, eventId } = populate(source);
  rows.adoptions = adoptionRow(source, kept);
  rows.record_relationships = relationshipRow(source, kept, continuing(source, 'claim', null));
  rows.claim_revisions = revisionRow(source, 'claim', uuidv7(), null);
  rows.decision_revisions = revisionRow(source, 'decision', uuidv7(), null);
  const db = constraintsOnly();
  const refused = (table: string, changes: Row) =>
    expect(
      () => insert(db, table, { ...rows[table]!, ...changes }),
      JSON.stringify(changes)
    ).toThrow(/CHECK constraint failed|NOT NULL constraint failed/);
  const capture = {
    artifact_id: artifactId,
    event_id: eventId,
    field_path: 'summary',
    position: 0,
  };
  const noRetention = { retention_kind: null, retained_bytes: null, content_sha256: null };

  const captured = {
    ...rows.knowledge_sources!,
    source_kind: 'capture_field',
    ...capture,
    ...noRetention,
  };
  insert(db, 'knowledge_sources', captured);
  // The occurrence index carries the one-source-per-occurrence rule on its own, with the replace
  // guard that also enforces it dropped.
  expect(() => insert(db, 'knowledge_sources', { ...captured, source_id: uuidv7() })).toThrow(
    /UNIQUE constraint failed/
  );
  insert(db, 'knowledge_sources', { ...captured, source_id: uuidv7(), position: 1 });
  db.exec('DELETE FROM knowledge_sources');
  refused('knowledge_sources', { source_kind: 'capture_field', ...capture });
  refused('knowledge_sources', { source_kind: 'capture_field', ...noRetention });
  refused('knowledge_sources', { retention_kind: null });
  refused('knowledge_sources', { content_sha256: null });
  refused('knowledge_sources', { retained_bytes: null });
  refused('knowledge_sources', { retained_reference: 'retained/instruction-1' });
  refused('knowledge_sources', { content_sha256: 'C'.repeat(64) });
  refused('knowledge_sources', { source_author: null });
  refused('knowledge_sources', { source_author_basis: 'unknown' });
  refused('knowledge_sources', { interpreted_by: 'claude-code' });
  refused('knowledge_sources', { interpreted_by_basis: 'unknown', interpreted_by: 'claude-code' });
  // Interpreting is an actor's or a detector's, and a source nobody interpreted names nobody.
  refused('knowledge_sources', { interpreted_kind: 'detector' });
  refused('knowledge_sources', { interpreted_kind: 'actor', interpreted_by: 'claude-code' });
  refused('knowledge_sources', {
    interpreted_kind: 'detector',
    interpreted_by: 'knowledge-processor',
    interpreted_by_basis: 'authenticated',
  });

  const criterion = {
    criterion_artifact_id: artifactId,
    criterion_plan_event_id: eventId,
    criterion_id: rows.requirements!.requirement_id,
  };
  insert(db, 'requirements', {
    ...rows.requirements!,
    origin_kind: 'promoted_criterion',
    ...criterion,
  });
  db.exec('DELETE FROM requirements');
  refused('requirements', { origin_kind: 'promoted_criterion' });
  refused('requirements', {
    origin_kind: 'promoted_criterion',
    ...criterion,
    criterion_id: uuidv7(),
  });
  refused('requirements', { origin_kind: 'derived', derived_from_kind: 'criterion', ...criterion });
  refused('requirements', { origin_kind: 'derived' });
  refused('requirements', { origin_kind: 'derived', derived_from_kind: 'expectation' });
  refused('requirements', {
    origin_kind: 'derived',
    derived_from_kind: 'expectation',
    ...ref('expectation', 'requirement', rows.requirements!.requirement_id as string, uuidv7()),
  });
  refused('requirements', { origin_kind: 'promoted_source' });
  refused('requirements', { origin_kind: 'promoted_source', passage_source_id: uuidv7() });
  refused('requirements', { ...criterion });

  refused('requirement_revisions', { attributed_basis: null });
  refused('requirement_revisions', { attributed_to: null });
  refused('requirement_revisions', {
    attributed_kind: 'detector',
    attributed_to: 'knowledge-processor',
  });
  refused('requirement_revisions', {
    attributed_kind: 'detector',
    attributed_to: 'knowledge-processor',
    attributed_basis: null,
  });
  refused('requirement_revisions', { subject_id: uuidv7() });
  refused('requirement_revisions', {
    previous_revision_id: rows.requirement_revisions!.revision_id,
  });

  refused('task_uses', { criterion_id: 'criterion-1' });
  refused('task_uses', { selection_kind: 'connected_later' });
  refused('task_uses', { selection_kind: 'connected_later', discovered_at: AT });
  refused('task_uses', { discovered_at: AT });
  refused('task_uses', { discovered_kind: 'detector', discovered_by: 'knowledge-processor' });
  refused('task_uses', {
    selection_kind: 'connected_later',
    discovered_at: AT,
    discovered_by: 'knowledge-processor',
  });
  refused('task_uses', {
    selection_kind: 'connected_later',
    discovered_at: AT,
    discovered_kind: 'detector',
    discovered_by: 'knowledge-processor',
    discovered_by_basis: 'authenticated',
  });

  refused('approval_binding_targets', { target_revision_id: null });
  refused('approval_binding_targets', { selector_source_id: uuidv7() });
  refused('approval_binding_targets', { bound_kind: 'source_selector' });
  refused('approval_binding_departures', { how: 'excepts' });
  refused('approval_binding_departures', { how: 'replaces' });
  refused('approval_binding_departures', { exception_id: uuidv7() });
  refused('approval_binding_departures', { replaced_by_kind: 'requirement' });

  refused('knowledge_exceptions', { end_kind: 'until_time' });
  refused('conflict_answers', { outcome: 'authorized' });
  refused('conflict_answers', { authorization_id: uuidv7() });

  refused('correction_actions', { action_kind: 'acceptance' });
  refused('correction_actions', { follows_action_id: uuidv7() });
  refused('correction_actions', { action_kind: 'reversal', follows_action_id: uuidv7() });
  refused('correction_actions', { action_kind: 'accepted_replacement' });
  refused('correction_actions', {
    action_kind: 'accepted_replacement',
    ...ref('adopted', 'requirement', uuidv7(), uuidv7()),
  });
  refused('correction_actions', { authorization_kind: 'informed_instruction' });
  refused('correction_actions', { changed_what_stands: 1 });
  refused('correction_actions', {
    action_kind: 'withdrawal',
    attributed_kind: 'detector',
    attributed_to: 'knowledge-processor',
    attributed_basis: null,
  });
  refused('correction_targets', { target_kind: 'relationship', target_revision_id: uuidv7() });

  for (const table of ['recorded_choices', 'knowledge_authorizations', 'adoptions']) {
    refused(table, { scope_kind: 'artifact' });
    refused(table, { scope_value: 'an-artifact' });
  }
  refused('adoptions', { approver: null });
  refused('record_relationships', { attributed_basis: null });
  refused('record_relationships', { attributed_to: null });
  refused('record_relationships', { attributed_kind: 'detector' });

  for (const [table, name] of [
    ['claim_revisions', 'asserted_by'],
    ['decision_revisions', 'authored_by'],
  ] as const) {
    refused(table, { attributed_basis: null });
    refused(table, { [name]: null });
    refused(table, { [name]: '' });
    refused(table, { attributed_kind: 'detector' });
    refused(table, { attributed_kind: 'detector', [name]: null, attributed_basis: null });
    refused(table, { attributed_kind: null });
  }
  // A detector's revision is an extracted candidate and verifies nothing, and a subject is named
  // by identity and revision together.
  for (const table of ['claim_revisions', 'decision_revisions']) {
    refused(table, { attributed_kind: 'detector', attributed_basis: null });
    refused(table, {
      attributed_kind: 'detector',
      attributed_basis: null,
      source_standing: 'explicit_instruction',
    });
    refused(table, { subject_id: uuidv7() });
    refused(table, { subject_revision_id: uuidv7() });
  }
  refused('claim_revisions', {
    attributed_kind: 'detector',
    attributed_basis: null,
    source_standing: 'extracted_candidate',
    verification_json: '{}',
    verification_provenance: 'agent_reported',
  });
  // A decision's derivation is named whole, on the revision that mints the identity, and never
  // names the identity it mints.
  refused('decision_revisions', { derived_from_kind: 'requirement' });
  refused('decision_revisions', {
    derived_from_kind: 'requirement',
    derived_from_id: uuidv7(),
    derived_from_revision_id: uuidv7(),
    previous_revision_id: rows.decision_revisions!.revision_id,
  });
  refused('decision_revisions', {
    derived_from_kind: 'decision',
    derived_from_id: rows.decision_revisions!.decision_id,
    derived_from_revision_id: uuidv7(),
    decision_id: rows.decision_revisions!.decision_id,
  });

  refused('passage_restatements', { restates_kind: 'relationship' });
  refused('passage_restatements', { passage_location: '' });
  refused('passage_restatements', { attributed_kind: 'detector' });
  refused('passage_restatements', { attributed_basis: null });

  refused('processing_control', { changed_by: null });
  refused('processing_control', { changed_by_basis: 'unknown' });
  refused('processing_control', { changed_at: null });
  refused('processing_control', { reason: '' });
  refused('processing_control', { singleton: 2 });
  refused('processing_jobs', { state: 'running' });
  refused('processing_jobs', { claimed_generation: 1 });
  refused('processing_attempts', { outcome: 'failed' });
  refused('processing_lease', { owner_id: null });
  refused('processing_lease', { owner_generation: 0 });
  refused('processing_usage', { reported_cost_usd: 0.1 });
  refused('processing_usage', { state: 'settled' });
  refused('processing_usage', { reserved_cost_usd: -1 });
});

it('lets several revisions continue one predecessor and refuses a second first revision', () => {
  const db = database();
  for (const entity of ['claim', 'decision', 'subject'] as const) {
    const first = continuing(db, entity, null);
    const second = continuing(db, entity, first);
    continuing(db, entity, first);
    continuing(db, entity, second);
    expect(
      db
        .prepare(
          `SELECT count(*) AS n FROM ${entity}_revisions WHERE ${entity}_id=? AND previous_revision_id=?`
        )
        .get(first.id, first.revisionId),
      entity
    ).toEqual({ n: 2 });
    expect(() => continuing(db, entity, { id: first.id, revisionId: null }), entity).toThrow(
      /exactly one first revision/
    );
  }

  const first = requirement(db);
  const sibling = (previous: string | null) =>
    insert(db, 'requirement_revisions', requirementRevisionRow(db, first.id, uuidv7(), previous));
  sibling(first.revisionId);
  sibling(first.revisionId);
  expect(() => sibling(null)).toThrow(/exactly one first revision/);
  const other = requirement(db);
  expect(() => sibling(other.revisionId)).toThrow(/FOREIGN KEY constraint failed/);
  expect(
    db
      .prepare('SELECT count(*) AS n FROM requirement_revisions WHERE requirement_id=?')
      .get(first.id)
  ).toEqual({ n: 3 });
});

it("keeps a claim or decision revision nobody can name the author of, a detector's, and a released one named on no basis", () => {
  const db = database();
  for (const [entity, name, detected] of [
    ['claim', 'asserted_by', { source_standing: 'extracted_candidate' }],
    ['decision', 'authored_by', { source_standing: 'extracted_candidate' }],
  ] as const) {
    const unnamed = continuing(db, entity, null, { [name]: null, attributed_basis: 'unknown' });
    const derived = continuing(db, entity, unnamed, {
      [name]: 'knowledge-processor',
      attributed_kind: 'detector',
      attributed_basis: null,
      ...detected,
    });
    const released = continuing(db, entity, unnamed, { attributed_basis: 'unknown' });
    expect(
      db
        .prepare(
          `SELECT ${name} AS name, attributed_kind, attributed_basis FROM ${entity}_revisions WHERE ${entity}_id=? ORDER BY rowid`
        )
        .all(unnamed.id),
      entity
    ).toEqual([
      { name: null, attributed_kind: 'actor', attributed_basis: 'unknown' },
      { name: 'knowledge-processor', attributed_kind: 'detector', attributed_basis: null },
      { name: 'claude-code', attributed_kind: 'actor', attributed_basis: 'unknown' },
    ]);

    const table = `${entity}_revisions`;
    const retained = db
      .prepare(`SELECT * FROM ${table} WHERE revision_id=?`)
      .get(derived.revisionId);
    const replaced = (changes: Row) => () =>
      insert(
        db,
        table,
        revisionRow(db, entity, unnamed.id, released.revisionId, changes),
        'INSERT OR REPLACE'
      );
    expect(replaced({ revision_id: derived.revisionId }), entity).toThrow(/cannot be replaced/);
    expect(
      replaced({
        source_event_id: (retained as Row).source_event_id,
        field_path: (retained as Row).field_path,
        position: (retained as Row).position,
      }),
      entity
    ).toThrow(/cannot be replaced/);
    expect(() => db.prepare(`UPDATE ${table} SET attributed_basis='authenticated'`).run()).toThrow(
      /immutable/
    );
    expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(/retained/);
    expect(
      db.prepare(`SELECT * FROM ${table} WHERE revision_id=?`).get(derived.revisionId)
    ).toEqual(retained);
  }
});

it('takes a decision revision with the standing and subject a released one never records', () => {
  const db = database();
  const subject = continuing(db, 'subject', null);
  const released = continuing(db, 'decision', null);
  expect(
    db
      .prepare(
        'SELECT source_standing, subject_id, subject_revision_id FROM decision_revisions WHERE revision_id=?'
      )
      .get(released.revisionId)
  ).toEqual({ source_standing: null, subject_id: null, subject_revision_id: null });

  continuing(db, 'decision', released, {
    source_standing: 'explicit_instruction',
    subject_id: subject.id,
    subject_revision_id: subject.revisionId,
  });
  expect(() =>
    continuing(db, 'decision', released, {
      source_standing: 'agent_proposal',
      subject_id: subject.id,
      subject_revision_id: uuidv7(),
    })
  ).toThrow(/FOREIGN KEY constraint failed/);
  // Everything background processing writes is an extracted candidate, whatever it was read from.
  expect(() =>
    continuing(db, 'decision', released, {
      attributed_kind: 'detector',
      attributed_basis: null,
      source_standing: 'agent_proposal',
    })
  ).toThrow(/CHECK constraint failed/);
  continuing(db, 'decision', released, {
    attributed_kind: 'detector',
    attributed_basis: null,
    source_standing: 'extracted_candidate',
  });
  expect(
    db.prepare('SELECT count(*) AS n FROM decision_revisions WHERE decision_id=?').get(released.id)
  ).toEqual({ n: 3 });
});

it('accepts requirement revisions as relationship endpoints and adoption targets, and refuses a missing one', () => {
  const db = database();
  const kept = requirement(db);
  const motive = requirement(db);
  const decided = continuing(db, 'decision', null);
  const missing = { ...kept, revisionId: uuidv7() };

  insert(db, 'record_relationships', relationshipRow(db, kept, motive, { relation: 'motivates' }));
  insert(db, 'record_relationships', relationshipRow(db, decided, kept));
  expect(() => insert(db, 'record_relationships', relationshipRow(db, missing, decided))).toThrow(
    /exact endpoint revisions/
  );
  expect(() => insert(db, 'record_relationships', relationshipRow(db, decided, missing))).toThrow(
    /exact endpoint revisions/
  );
  expect(() =>
    insert(db, 'record_relationships', relationshipRow(db, { ...kept, kind: 'decision' }, decided))
  ).toThrow(/exact endpoint revisions/);

  insert(db, 'adoptions', adoptionRow(db, kept));
  insert(db, 'adoptions', adoptionRow(db, kept, { scope_kind: 'artifact', scope_value: uuidv7() }));
  expect(() => insert(db, 'adoptions', adoptionRow(db, missing))).toThrow(
    /exact approval target revision/
  );
  // The adoption id is the identity, so the same approver adopts the same revision again.
  insert(db, 'adoptions', adoptionRow(db, kept));
  expect(db.prepare('SELECT count(*) AS n FROM adoptions').get()).toEqual({ n: 3 });
});

it('still holds what a released relationship or adoption row says, and an approver nobody can name', () => {
  const db = database();
  const claimed = continuing(db, 'claim', null);
  const decided = continuing(db, 'decision', null);
  const released = { authorization_json: null, scope_kind: 'branch', scope_value: 'rate-limit' };

  insert(
    db,
    'record_relationships',
    relationshipRow(db, claimed, decided, {
      ...released,
      relation: 'challenges',
      attributed_to: 'claude-code',
      attributed_basis: 'unknown',
      explanation: null,
    })
  );
  insert(
    db,
    'record_relationships',
    relationshipRow(db, decided, claimed, {
      ...released,
      relation: 'challenges',
      attributed_kind: 'detector',
      attributed_to: 'overlap-detector',
      attributed_basis: null,
      explanation: null,
    })
  );
  insert(db, 'adoptions', adoptionRow(db, decided, { ...released, approver_basis: 'unknown' }));

  // An approver nobody can name has no name to record, and the row is kept all the same.
  const unnamed = { approver: null, approver_basis: 'unknown' };
  insert(db, 'adoptions', adoptionRow(db, decided, unnamed));
  insert(db, 'adoptions', adoptionRow(db, decided, unnamed));
  expect(db.prepare('SELECT count(*) AS n FROM adoptions').get()).toEqual({ n: 3 });
});

it('requires the rows a knowledge record names', () => {
  const db = database();
  const { rows, kept } = populate(db);
  const absent = uuidv7();
  const fresh = (table: string, changes: Row) => () =>
    insert(db, table, { ...rows[table]!, ...changes, operation_id: receipt(db) });
  const foreignKey = /FOREIGN KEY constraint failed/;

  expect(fresh('task_uses', { plan_event_id: absent })).toThrow(/keyed to a plan event/);
  expect(fresh('task_uses', { role: 'assess', exception_id: absent })).toThrow(foreignKey);
  expect(fresh('task_uses', { role: 'assess', target_revision_id: absent })).toThrow(
    /exact requirement or decision revision/
  );
  expect(
    fresh('knowledge_sources', {
      source_id: uuidv7(),
      source_kind: 'capture_field',
      artifact_id: rows.task_uses!.artifact_id,
      event_id: absent,
      field_path: 'summary',
      position: 0,
      retention_kind: null,
      retained_bytes: null,
      content_sha256: null,
    })
  ).toThrow(foreignKey);
  expect(() =>
    requirement(db, {
      origin_kind: 'promoted_criterion',
      requirement_id: absent,
      criterion_artifact_id: rows.task_uses!.artifact_id,
      criterion_plan_event_id: uuidv7(),
      criterion_id: absent,
    })
  ).toThrow(foreignKey);
  const derived = {
    origin_kind: 'derived',
    derived_from_kind: 'expectation',
    ...ref('expectation', 'requirement', kept.id, kept.revisionId),
  };
  requirement(db, derived);
  expect(() => requirement(db, { ...derived, expectation_revision_id: absent })).toThrow(
    /exact expectation revision it derives from/
  );
  expect(
    fresh('requirement_revisions', {
      revision_id: uuidv7(),
      previous_revision_id: kept.revisionId,
      subject_id: rows.subjects!.subject_id,
      subject_revision_id: absent,
    })
  ).toThrow(foreignKey);

  expect(fresh('approval_binding_targets', { binding_id: absent })).toThrow(foreignKey);
  expect(fresh('approval_binding_departures', { binding_id: absent })).toThrow(foreignKey);
  expect(fresh('selector_resolutions', { binding_id: absent })).toThrow(foreignKey);
  expect(fresh('selector_resolutions', { resolved_revision_id: absent })).toThrow(
    /resolves to an exact retained revision/
  );
  expect(fresh('correction_targets', { action_id: absent })).toThrow(foreignKey);
  expect(fresh('correction_targets', { position: 1, target_revision_id: absent })).toThrow(
    /every exact revision it names/
  );
  expect(
    fresh('correction_actions', {
      action_id: uuidv7(),
      action_kind: 'acceptance',
      follows_action_id: absent,
    })
  ).toThrow(foreignKey);
  expect(
    fresh('correction_actions', {
      action_id: uuidv7(),
      action_kind: 'accepted_replacement',
      authorization_kind: 'informed_instruction',
      ...ref('adopted', 'requirement', kept.id, absent),
      adopted_designation: 'adopted',
    })
  ).toThrow(/exact revision it makes stand/);
  expect(fresh('recorded_choices', { selection_id: uuidv7(), target_revision_id: absent })).toThrow(
    /exact target revision/
  );
  expect(fresh('knowledge_exceptions', { exception_id: uuidv7(), expectation_id: absent })).toThrow(
    /exact expectation revision/
  );
  expect(fresh('conflict_answers', { answer_id: uuidv7(), rule_revision_id: absent })).toThrow(
    /exact rule it was asked about/
  );
  expect(
    fresh('conflict_answers', {
      answer_id: uuidv7(),
      outcome: 'authorized',
      authorization_id: absent,
    })
  ).toThrow(foreignKey);
  expect(
    fresh('passage_restatements', {
      restatement_id: uuidv7(),
      passage_location: 'paragraph 5',
      restates_revision_id: absent,
    })
  ).toThrow(/exact revision it restates/);
  expect(
    fresh('passage_restatements', { restatement_id: uuidv7(), passage_source_id: absent })
  ).toThrow(foreignKey);
  expect(fresh('knowledge_revocations', { revocation_id: uuidv7(), revoked_id: absent })).toThrow(
    /authorization, exception, conflict answer or assignment it ends/
  );
  expect(
    fresh('knowledge_revocations', { revocation_id: uuidv7(), revoked_kind: 'authorization' })
  ).toThrow(/authorization, exception, conflict answer or assignment it ends/);

  const job = (changes: Row) => () =>
    insert(db, 'processing_jobs', { ...rows.processing_jobs!, job_id: uuidv7(), ...changes });
  expect(job({ processor_contract: 'other@1', source_id: absent })).toThrow(/retained source/);
  expect(job({ processor_contract: 'other@1', source_kind: 'capture_event' })).toThrow(
    /retained source/
  );
  job({ source_kind: 'capture_event', source_id: rows.task_uses!.plan_event_id })();
  expect(job({ processor_contract: 'other@1', admitting_operation_id: absent })).toThrow(
    foreignKey
  );
  expect(() =>
    insert(db, 'processing_attempts', {
      ...rows.processing_attempts!,
      attempt_id: uuidv7(),
      attempt_number: 2,
      job_id: absent,
    })
  ).toThrow(foreignKey);
});

// An act published under an embedded instruction records an authorization of its own and names
// it; an act under anything else records none.
it('names the authorization recorded for an act only when it was published on an instruction', () => {
  const db = database();
  const { rows, kept } = populate(db);
  const granted = rows.knowledge_authorizations!.authorization_id as string;
  const finding = continuing(db, 'claim', null);
  const instruction = JSON.stringify({ kind: 'informed_instruction' });
  const binding = JSON.stringify({ kind: 'approval_binding', binding_id: uuidv7() });
  const withdrawal = (changes: Row) => ({
    ...rows.correction_actions!,
    action_id: uuidv7(),
    action_kind: 'withdrawal',
    change_class: 'intent_change',
    changed_what_stands: 1,
    operation_id: receipt(db),
    ...changes,
  });
  const act = (
    authorization_json: string | null,
    authorization_kind: string | null,
    id: unknown
  ) => [
    () =>
      insert(
        db,
        'record_relationships',
        relationshipRow(db, kept, finding, { authorization_json, authorization_id: id })
      ),
    () =>
      insert(db, 'adoptions', adoptionRow(db, kept, { authorization_json, authorization_id: id })),
    () =>
      insert(db, 'correction_actions', withdrawal({ authorization_kind, authorization_id: id })),
  ];

  for (const published of act(instruction, 'informed_instruction', granted)) published();
  expect(
    db
      .prepare(
        `SELECT count(*) AS n FROM (
           SELECT authorization_id FROM record_relationships
           UNION ALL SELECT authorization_id FROM adoptions
           UNION ALL SELECT authorization_id FROM correction_actions)
         WHERE authorization_id=?`
      )
      .get(granted)
  ).toEqual({ n: 3 });
  // An act on an approval binding records no authorization of its own.
  for (const refused of act(binding, 'approval_binding', granted))
    expect(refused).toThrow(/CHECK constraint failed/);
  for (const refused of act(instruction, 'informed_instruction', uuidv7()))
    expect(refused).toThrow(/FOREIGN KEY constraint failed/);
  // A proposal changes nothing that stands, so it names no authorization either way.
  expect(() =>
    insert(db, 'correction_actions', {
      ...rows.correction_actions!,
      action_id: uuidv7(),
      authorization_id: granted,
      operation_id: receipt(db),
    })
  ).toThrow(/CHECK constraint failed/);
});

// The other direction, for the two rows whose act always authorizes something: an adoption adopts
// its target and an established replacement departs from what it replaces, so leaving the column
// empty would be an act published on an instruction that recorded no authorization for it. A
// correction is held to one direction only, because a reversal of somebody else's proposal is
// published on an instruction and adopts, departs from and restates nothing, and an authorization
// over an empty footprint is one the contract refuses.
it('requires an adoption and a relationship on an instruction to name the authorization recorded for it', () => {
  const db = database();
  const { rows, kept } = populate(db);
  const finding = continuing(db, 'claim', null);
  const instruction = JSON.stringify({ kind: 'explicit_instruction' });
  expect(() =>
    insert(
      db,
      'record_relationships',
      relationshipRow(db, kept, finding, {
        authorization_json: instruction,
        authorization_id: null,
      })
    )
  ).toThrow(/CHECK constraint failed/);
  expect(() =>
    insert(
      db,
      'adoptions',
      adoptionRow(db, kept, { authorization_json: instruction, authorization_id: null })
    )
  ).toThrow(/CHECK constraint failed/);
  expect(() =>
    insert(db, 'correction_actions', {
      ...rows.correction_actions!,
      action_id: uuidv7(),
      action_kind: 'withdrawal',
      change_class: 'intent_change',
      changed_what_stands: 1,
      authorization_kind: 'explicit_instruction',
      authorization_id: null,
      operation_id: receipt(db),
    })
  ).not.toThrow();
});

it('keys a task use to a plan event and to no other event of its artifact', () => {
  const db = database();
  const { rows, artifactId } = populate(db);
  const event = (eventType: string, ordinal: number) => {
    const eventId = uuidv7();
    db.prepare('INSERT INTO artifact_events VALUES (?,?,?,?,NULL,?,?,?,?)').run(
      artifactId,
      eventId,
      ordinal,
      Buffer.from('{}'),
      'checksum',
      'hash',
      eventType,
      AT
    );
    return eventId;
  };
  const use = (planEventId: string) => () =>
    insert(db, 'task_uses', {
      ...rows.task_uses!,
      plan_event_id: planEventId,
      operation_id: receipt(db),
    });

  use(event('plan_revised', 2))();
  expect(use(event('checkpoint_opened', 3))).toThrow(/keyed to a plan event/);
  expect(use(event('summary_captured', 4))).toThrow(/keyed to a plan event/);
  expect(db.prepare('SELECT count(*) AS n FROM task_uses').get()).toEqual({ n: 2 });
});

it('starts one processing attempt at a time and none for a job that has finished', () => {
  const db = database();
  const { rows } = populate(db);
  const attempt = (changes: Row) => () =>
    insert(db, 'processing_attempts', {
      ...rows.processing_attempts!,
      attempt_id: uuidv7(),
      ...changes,
    });

  expect(attempt({ attempt_number: 2 })).toThrow(/unsettled attempt is settled/);
  db.prepare("UPDATE processing_attempts SET outcome='unknown', finished_at=?").run(AT);
  attempt({ attempt_number: 2 })();

  // What an attempt published is recorded as it settles, never while it is still running.
  const published = receipt(db);
  expect(() =>
    db
      .prepare('UPDATE processing_attempts SET publishing_operation_id=? WHERE outcome IS NULL')
      .run(published)
  ).toThrow(/CHECK constraint failed/);
  db.prepare(
    "UPDATE processing_attempts SET outcome='succeeded', finished_at=?, publishing_operation_id=? WHERE outcome IS NULL"
  ).run(AT, published);
  expect(
    db
      .prepare('SELECT publishing_operation_id FROM processing_attempts WHERE attempt_number=2')
      .get()
  ).toEqual({ publishing_operation_id: published });

  const failed = uuidv7();
  insert(db, 'processing_jobs', {
    ...rows.processing_jobs!,
    job_id: failed,
    processor_contract: 'knowledge-interpretation@2',
  });
  db.prepare("UPDATE processing_jobs SET state='terminal_failure' WHERE job_id=?").run(failed);
  expect(attempt({ attempt_number: 1, job_id: failed })).toThrow(/takes no further attempt/);
  db.prepare("UPDATE processing_jobs SET state='completed', result_json='{}' WHERE job_id=?").run(
    rows.processing_jobs!.job_id
  );
  expect(attempt({ attempt_number: 3 })).toThrow(/takes no further attempt/);
  expect(db.prepare('SELECT count(*) AS n FROM processing_attempts').get()).toEqual({ n: 2 });
});

it('reopens only a job that gave up, after every attempt it made, and keeps each reopening as recorded', () => {
  const db = database();
  const { rows } = populate(db);
  const jobId = rows.processing_jobs!.job_id as string;
  const reopen = (changes: Row) => () =>
    insert(db, 'processing_job_reopenings', {
      ...rows.processing_job_reopenings!,
      reopening_id: uuidv7(),
      reopening_sequence: 2,
      attempts_before: 1,
      ...changes,
    });

  expect(reopen({})).toThrow(/Only a processing job that gave up is reopened/);
  db.prepare("UPDATE processing_attempts SET outcome='failed', finished_at=?").run(AT);
  db.prepare("UPDATE processing_jobs SET state='terminal_failure' WHERE job_id=?").run(jobId);
  expect(reopen({ attempts_before: 0 })).toThrow(/starts after every attempt the job has made/);
  expect(reopen({ reopening_id: rows.processing_job_reopenings!.reopening_id as string })).toThrow(
    /cannot be replaced/
  );
  // A repeated sequence is also a replacement, so either guard may be the one that refuses it.
  expect(reopen({ reopening_sequence: 1 })).toThrow(
    /cannot be replaced|takes the sequence after the job's last one/
  );
  expect(reopen({ reopening_sequence: 3 })).toThrow(/takes the sequence after the job's last one/);
  expect(reopen({ attempts_allowed: 0 })).toThrow(/CHECK constraint failed/);
  expect(reopen({ reopened_by: null })).toThrow(/CHECK constraint failed/);
  reopen({})();
  expect(
    db
      .prepare(
        'SELECT reopening_sequence, attempts_before FROM processing_job_reopenings ORDER BY reopening_sequence'
      )
      .all()
  ).toEqual([
    { reopening_sequence: 1, attempts_before: 0 },
    { reopening_sequence: 2, attempts_before: 1 },
  ]);
  expect(() => db.prepare('UPDATE processing_job_reopenings SET attempts_allowed=9').run()).toThrow(
    /append-only/
  );
  expect(() => db.prepare('DELETE FROM processing_job_reopenings').run()).toThrow(
    /Processing records are retained/
  );
  db.prepare("UPDATE processing_jobs SET state='completed', result_json='{}' WHERE job_id=?").run(
    jobId
  );
  expect(reopen({ reopening_sequence: 3 })).toThrow(
    /Only a processing job that gave up is reopened/
  );
});

it('records a consented model resume once, and only for a job admitted without a model', () => {
  const db = database();
  const { rows } = populate(db);
  const admitted = rows.processing_jobs!.job_id as string;
  const withModel = uuidv7();
  insert(db, 'processing_jobs', {
    ...rows.processing_jobs!,
    job_id: withModel,
    processor_contract: 'knowledge-interpretation@2',
    without_model: 0,
  });
  const resume = (jobId: string, changes: Row) => () =>
    db
      .prepare(
        `UPDATE processing_jobs SET ${Object.keys(changes)
          .map((column) => `${column}=?`)
          .join(', ')} WHERE job_id=?`
      )
      .run(...Object.values(changes), jobId);
  const consented = {
    model_resumed_at: AT,
    model_resumed_by: 'owner@example.test',
    model_resumed_by_basis: 'authenticated',
    model_resume_grant_id: uuidv7(),
  };
  const recorded = () =>
    db
      .prepare(
        'SELECT model_resumed_at, model_resumed_by, model_resumed_by_basis, model_resume_grant_id FROM processing_jobs WHERE job_id=?'
      )
      .get(admitted);

  expect(resume(admitted, { model_resumed_at: AT })).toThrow(/CHECK constraint failed/);
  expect(resume(admitted, { model_resume_grant_id: uuidv7() })).toThrow(/CHECK constraint failed/);
  expect(resume(admitted, { ...consented, model_resumed_by: null })).toThrow(
    /CHECK constraint failed/
  );
  expect(resume(admitted, { ...consented, model_resumed_by_basis: 'unknown' })).toThrow(
    /CHECK constraint failed/
  );
  expect(resume(withModel, consented)).toThrow(/CHECK constraint failed/);

  resume(admitted, consented)();
  expect(recorded()).toEqual(consented);
  expect(resume(admitted, { model_resume_grant_id: uuidv7() })).toThrow(/recorded once/);
  expect(
    resume(admitted, {
      model_resumed_at: null,
      model_resumed_by: null,
      model_resumed_by_basis: null,
      model_resume_grant_id: null,
    })
  ).toThrow(/recorded once/);
  db.prepare("UPDATE processing_jobs SET state='running', claimed_generation=1 WHERE job_id=?").run(
    admitted
  );
  expect(recorded()).toEqual(consented);
});

it('lets scheduling state move while the facts settled at insert, and a row that has ended, stay fixed', () => {
  const db = database();
  const { rows } = populate(db);
  const update =
    (table: string, assignment: string, ...values: unknown[]) =>
    () =>
      db.prepare(`UPDATE ${table} SET ${assignment}`).run(...values);

  for (const table of SCHEDULING_TABLES)
    expect(() => db.prepare(`DELETE FROM ${table}`).run(), table).toThrow(
      /Processing records are retained/
    );
  for (const [table, column, value] of [
    ['processing_jobs', 'source_id', uuidv7()],
    ['processing_jobs', 'processor_contract', 'other@2'],
    ['processing_jobs', 'admitting_operation_id', receipt(db)],
    ['processing_jobs', 'admission_json', '{"changed":true}'],
    ['processing_jobs', 'without_model', 0],
    ['processing_attempts', 'job_id', uuidv7()],
    ['processing_attempts', 'owner_generation', 2],
    ['processing_attempts', 'configuration_sha256', '0'.repeat(64)],
    ['processing_attempts', 'grant_id', 'grant-2'],
    ['processing_attempts', 'started_at', '2026-09-02T00:00:00.000Z'],
    ['processing_usage', 'attempt_id', uuidv7()],
    ['processing_usage', 'reserved_cost_usd', 9],
  ] as const)
    expect(update(table, `${column}=?`, value), `${table}.${column}`).toThrow(
      /fixed at insert are immutable/
    );

  update('processing_jobs', "state='running', claimed_generation=1, updated_at=?", AT)();
  update(
    'processing_jobs',
    "state='retryable_failure', claimed_generation=NULL, retry_at=?, wait_reason='provider_unavailable'",
    AT
  )();
  update('processing_jobs', "state='completed', result_json='{}'")();
  expect(update('processing_jobs', "state='pending'")).toThrow(/never run again/);

  update('processing_attempts', "outcome='unknown', finished_at=?", AT)();
  expect(update('processing_attempts', "outcome='succeeded'")).toThrow(/retained as it ended/);
  update('processing_usage', "state='unknown', settled_at=?", AT)();
  expect(update('processing_usage', "state='released'")).toThrow(/retained as it ended/);
  expect(
    db.prepare('SELECT reserved_cost_usd, reported_cost_usd FROM processing_usage').get()
  ).toEqual({
    reserved_cost_usd: rows.processing_usage!.reserved_cost_usd,
    reported_cost_usd: null,
  });
});

it('holds one project-wide pause that can be lifted and set again without touching a job', () => {
  const db = database();
  const { rows } = populate(db);
  const jobs = db.prepare('SELECT * FROM processing_jobs').all();
  const control = () =>
    db.prepare('SELECT paused, changed_by, reason FROM processing_control').all();

  expect(() => insert(db, 'processing_control', rows.processing_control!)).toThrow(
    /cannot be replaced/
  );
  expect(() =>
    insert(
      db,
      'processing_control',
      { ...rows.processing_control!, paused: 0 },
      'INSERT OR REPLACE'
    )
  ).toThrow(/cannot be replaced/);
  expect(() => db.prepare('DELETE FROM processing_control').run()).toThrow(/retained/);
  expect(control()).toEqual([
    { paused: 1, changed_by: 'owner@example.test', reason: 'the provider is being replaced' },
  ]);

  db.prepare(
    "UPDATE processing_control SET paused=0, changed_at=?, changed_by=NULL, changed_by_basis='unknown', reason=NULL"
  ).run('2026-09-02T00:00:00.000Z');
  expect(control()).toEqual([{ paused: 0, changed_by: null, reason: null }]);
  db.prepare('UPDATE processing_control SET paused=1').run();
  expect(db.prepare('SELECT * FROM processing_jobs').all()).toEqual(jobs);
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='processing_control' AND sql LIKE '%processing_jobs%'"
      )
      .get()
  ).toEqual({ n: 0 });
});

it('hands the lease to a new owner only under a later generation', () => {
  const db = database();
  populate(db);
  const lease = (assignment: string) => () =>
    db.prepare(`UPDATE processing_lease SET ${assignment}`).run();

  lease("renewed_at='2026-09-01T00:00:30.000Z', expires_at='2026-09-01T00:01:30.000Z'")();
  expect(lease("owner_id='worker-2'")).toThrow(/later generation/);
  expect(lease('owner_generation=0')).toThrow();
  lease('owner_id=NULL, acquired_at=NULL, renewed_at=NULL, expires_at=NULL')();
  expect(lease("owner_id='worker-1', acquired_at='x', renewed_at='x', expires_at='x'")).toThrow(
    /later generation/
  );
  lease(
    "owner_generation=2, owner_id='worker-2', acquired_at='x', renewed_at='x', expires_at='x'"
  )();
  expect(lease('owner_generation=1')).toThrow(/later generation/);
  expect(db.prepare('SELECT owner_generation, owner_id FROM processing_lease').get()).toEqual({
    owner_generation: 2,
    owner_id: 'worker-2',
  });
});

it('names no table or column that the settlement guard would refuse in a domain write', () => {
  const db = database();
  const storageOwned = [
    'store_identity',
    'activation',
    'repository_creation',
    'project_counters',
    'operations',
  ];
  expect(
    storageOwned.every((table) => STORAGE_OWNED_TABLES.test(`INSERT INTO ${table} VALUES (1)`))
  ).toBe(true);
  const tables = (
    db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !storageOwned.includes(name));
  expect(tables).toEqual(
    expect.arrayContaining([
      ...AUTHORED_TABLES,
      ...SCHEDULING_TABLES,
      ...KNOWLEDGE_EVIDENCE_TABLES,
      ...REBUILT_TABLES,
    ])
  );
  for (const table of tables) {
    const columns = (db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[]).map(
      (column) => column.name
    );
    const statement = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    expect(STORAGE_OWNED_TABLES.test(statement), statement).toBe(false);
  }
});

it('requires a consent grant on every attempt and looks attempts up by it', () => {
  const db = constraintsOnly();
  const { rows } = populate(database());
  expect(() =>
    insert(db, 'processing_attempts', { ...rows.processing_attempts!, grant_id: null })
  ).toThrow(/NOT NULL/);
  expect(() =>
    insert(db, 'processing_attempts', { ...rows.processing_attempts!, grant_id: '' })
  ).toThrow(/CHECK/);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='processing_attempts' AND name='processing_attempt_grant'"
      )
      .get()
  ).toEqual({ name: 'processing_attempt_grant' });
});

it('records what an open attempt spawned once and never again', () => {
  const db = database();
  const { rows } = populate(db);
  const attemptId = rows.processing_attempts!.attempt_id;
  const record = (value: string | null) =>
    db
      .prepare('UPDATE processing_attempts SET process_json=? WHERE attempt_id=?')
      .run(value, attemptId);
  expect(() => record('{"group":')).toThrow(/CHECK/);
  record('{"process_group":4242}');
  expect(() => record('{"process_group":77}')).toThrow(/records its provider process once/);
  expect(() => record(null)).toThrow(/records its provider process once/);
  // A settlement keeps what the start and the process record wrote.
  db.prepare(
    "UPDATE processing_attempts SET outcome='unknown', finished_at=? WHERE attempt_id=?"
  ).run(AT, attemptId);
  expect(
    db
      .prepare('SELECT process_json, grant_id FROM processing_attempts WHERE attempt_id=?')
      .get(attemptId)
  ).toEqual({ process_json: '{"process_group":4242}', grant_id: 'grant-1' });
  expect(() => record('{"process_group":77}')).toThrow(
    /records its provider process once|retained as it ended/
  );
  expect(
    db.prepare('SELECT process_json FROM processing_attempts WHERE attempt_id=?').get(attemptId)
  ).toEqual({ process_json: '{"process_group":4242}' });
});
