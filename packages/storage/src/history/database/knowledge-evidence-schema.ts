// Observations and task-independent assessments: what a tool or a person recorded about
// identified inputs, and what somebody concluded from it about exact expectation revisions.
//
// Two rules live in the tables rather than in a writer, because both are the kind of claim a
// convention cannot be trusted with. A snapshot-bound observation is impossible without an
// execution that consumed exactly the inputs the observation names, and a satisfaction claim is
// impossible against unidentified software. Everything else a writer enforces.
//
// Like the rest of the knowledge family a row keeps the authored record once as record_bytes and
// every other column is a lookup copy the writer keeps equal to it in the publishing transaction.
import {
  ATTRIBUTION_BASES,
  insertOnlyGuards,
  retainedRevision,
  sha256,
} from './exact-revision-schema.js';

const EXECUTION_KINDS = "'agent_reported','runner_established','human_observation'";
const INPUT_BASES = "'snapshot_bound','partial','unknown'";
const OUTCOMES = "'passed','failed','errored','skipped','observed'";
const CONCLUSIONS = "'supported','contradicted','unresolved','not_assessed'";
const CHECK_STATES = "'errored','skipped','missing_inputs','stale_evidence'";
const EVIDENCE_ROLES = "'supports','contradicts','context'";
const EVIDENCE_KINDS = "'observation','assessment'";
const EXPECTATION_KINDS = "'requirement','decision'";

const authored = `record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED`;
const receipt = `operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED`;
const position = `position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991)`;
const named = (column: string) => `${column} TEXT NOT NULL CHECK (length(${column})>0)`;
const optional = (column: string) =>
  `${column} TEXT CHECK (${column} IS NULL OR length(${column})>0)`;

// An unknown actor has no name, and a named actor says how the name is known.
const actor = (column: string) => `${optional(column)},
  ${column}_basis TEXT NOT NULL CHECK (${column}_basis IN (${ATTRIBUTION_BASES}) AND (${column} IS NULL) = (${column}_basis='unknown'))`;

// The method somebody used and the exact configuration it ran under, which is a digest because a
// configuration is not a name.
const method = `${named('method_name')},
  method_configuration_sha256 TEXT CHECK (method_configuration_sha256 IS NULL OR (${sha256('method_configuration_sha256')}))`;

const tables = `
CREATE TABLE knowledge_observations (
  observation_id TEXT PRIMARY KEY CHECK (length(observation_id)>0),
  source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id) DEFERRABLE INITIALLY DEFERRED CHECK (length(source_id)>0),
  ${actor('observed_by')},
  ${method},
  execution_kind TEXT NOT NULL CHECK (execution_kind IN (${EXECUTION_KINDS})),
  runner TEXT CHECK ((runner IS NOT NULL) = (execution_kind='runner_established') AND (runner IS NULL OR length(runner)>0)),
  consumed_inputs_json TEXT CHECK (
    (consumed_inputs_json IS NOT NULL) = (execution_kind='runner_established')
    AND (consumed_inputs_json IS NULL OR (json_valid(consumed_inputs_json) AND json_array_length(consumed_inputs_json)>0))
  ),
  input_basis TEXT NOT NULL CHECK (input_basis IN (${INPUT_BASES})),
  known_inputs_json TEXT NOT NULL CHECK (json_valid(known_inputs_json)),
  outcome TEXT NOT NULL CHECK (outcome IN (${OUTCOMES})),
  ${optional('started_at')},
  ${optional('finished_at')},
  evaluator_run_id TEXT REFERENCES evaluator_run_contexts(run_id) CHECK (evaluator_run_id IS NULL OR length(evaluator_run_id)>0),
  ${authored},
  CHECK (
    input_basis<>'snapshot_bound'
    OR (execution_kind='runner_established' AND json_array_length(known_inputs_json)>0 AND consumed_inputs_json=known_inputs_json)
  )
) STRICT;
CREATE INDEX knowledge_observation_source ON knowledge_observations(source_id);
CREATE INDEX knowledge_observation_run ON knowledge_observations(evaluator_run_id) WHERE evaluator_run_id IS NOT NULL;
CREATE TABLE knowledge_assessments (
  assessment_id TEXT PRIMARY KEY CHECK (length(assessment_id)>0),
  ${actor('assessed_by')},
  ${method},
  implementation_kind TEXT NOT NULL CHECK (implementation_kind IN ('selected','none_selected')),
  implementation_inputs_json TEXT CHECK (
    (implementation_inputs_json IS NOT NULL) = (implementation_kind='selected')
    AND (implementation_inputs_json IS NULL OR (json_valid(implementation_inputs_json) AND json_array_length(implementation_inputs_json)>0))
  ),
  environment TEXT CHECK (environment IS NULL OR (length(environment)>0 AND implementation_kind='selected')),
  observed_write_sequence INTEGER NOT NULL CHECK (observed_write_sequence BETWEEN 0 AND 9007199254740991),
  observed_intent_counter INTEGER NOT NULL CHECK (observed_intent_counter BETWEEN 0 AND 9007199254740991),
  ${authored}
) STRICT;
CREATE TABLE knowledge_assessment_conclusions (
  assessment_id TEXT NOT NULL REFERENCES knowledge_assessments(assessment_id) DEFERRABLE INITIALLY DEFERRED,
  ${position},
  expectation_kind TEXT NOT NULL CHECK (expectation_kind IN (${EXPECTATION_KINDS})),
  ${named('expectation_id')},
  ${named('expectation_revision_id')},
  conclusion TEXT NOT NULL CHECK (conclusion IN (${CONCLUSIONS})),
  ${receipt},
  PRIMARY KEY (assessment_id, position),
  UNIQUE (assessment_id, expectation_kind, expectation_revision_id)
) STRICT;
CREATE INDEX knowledge_assessment_expectation ON knowledge_assessment_conclusions(expectation_kind, expectation_id, expectation_revision_id, assessment_id);
CREATE TABLE knowledge_assessment_evidence (
  assessment_id TEXT NOT NULL REFERENCES knowledge_assessments(assessment_id) DEFERRABLE INITIALLY DEFERRED,
  ${position},
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (${EVIDENCE_KINDS})),
  ${named('evidence_id')},
  role TEXT NOT NULL CHECK (role IN (${EVIDENCE_ROLES})),
  ${receipt},
  PRIMARY KEY (assessment_id, position)
) STRICT;
CREATE INDEX knowledge_assessment_evidence_source ON knowledge_assessment_evidence(evidence_kind, evidence_id);
CREATE TABLE knowledge_assessment_check_states (
  assessment_id TEXT NOT NULL REFERENCES knowledge_assessments(assessment_id) DEFERRABLE INITIALLY DEFERRED,
  ${position},
  ${named('check_name')},
  state TEXT NOT NULL CHECK (state IN (${CHECK_STATES})),
  ${receipt},
  PRIMARY KEY (assessment_id, position)
) STRICT;
`;

// The rule with teeth on the assessment side, and it has to be a trigger because the conclusions
// live in a table of their own: an assessment that concludes supported or contradicted about any
// expectation has identified the software it judged, or it is a satisfaction claim against
// unidentified software and the store refuses it.
const satisfactionNeedsSoftware = `
CREATE TRIGGER knowledge_assessment_conclusion_requires_inputs BEFORE INSERT ON knowledge_assessment_conclusions
WHEN NEW.conclusion IN ('supported','contradicted') AND NOT EXISTS (
  SELECT 1 FROM knowledge_assessments WHERE assessment_id=NEW.assessment_id AND implementation_kind='selected'
) BEGIN
  SELECT RAISE(ABORT, 'No satisfaction claim is made against unidentified software');
END;`;

// An assessment weighs observations and earlier assessments this history holds. SQLite resolves
// the kind at insert time, so the reference cannot be a foreign key.
const evidenceIsRetained = `
CREATE TRIGGER knowledge_assessment_evidence_requires_source BEFORE INSERT ON knowledge_assessment_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM knowledge_observations WHERE NEW.evidence_kind='observation' AND observation_id=NEW.evidence_id
  UNION ALL
  SELECT 1 FROM knowledge_assessments WHERE NEW.evidence_kind='assessment' AND assessment_id=NEW.evidence_id
) BEGIN
  SELECT RAISE(ABORT, 'An assessment weighs evidence this history holds');
END;`;

const expectationIsRetained = `
CREATE TRIGGER knowledge_assessment_conclusion_requires_expectation BEFORE INSERT ON knowledge_assessment_conclusions
WHEN NOT EXISTS (${retainedRevision('NEW.expectation_kind', 'NEW.expectation_id', 'NEW.expectation_revision_id')}
) BEGIN
  SELECT RAISE(ABORT, 'An assessment requires the exact expectation revision it concludes about');
END;`;

const retained = [
  ['knowledge_observations', 'observation_id=NEW.observation_id'],
  ['knowledge_assessments', 'assessment_id=NEW.assessment_id'],
  [
    'knowledge_assessment_conclusions',
    'assessment_id=NEW.assessment_id AND (position=NEW.position OR (expectation_kind=NEW.expectation_kind AND expectation_revision_id=NEW.expectation_revision_id))',
  ],
  ['knowledge_assessment_evidence', 'assessment_id=NEW.assessment_id AND position=NEW.position'],
  [
    'knowledge_assessment_check_states',
    'assessment_id=NEW.assessment_id AND position=NEW.position',
  ],
] as const;

export const PROJECT_KNOWLEDGE_EVIDENCE_SCHEMA =
  tables +
  satisfactionNeedsSoftware +
  evidenceIsRetained +
  expectationIsRetained +
  insertOnlyGuards(retained, 'Evidence records');
