// Exact-revision rows for the records the storage gate seeds: criterion lineage, claims,
// decisions, the relationships between their revisions, adoptions and assessments. This family
// stores records; it resolves nothing. There is deliberately no governing or current view, no
// adoption ordering and no dispute or supersession outcome — the separately gated correction
// branch owns that behaviour, and a current-view column here would be a resolution nobody has
// approved.
//
// Every retained identity is an existing one: a criterion keeps the ID its plan minted, and a
// claim or decision revision is located by the frozen occurrence tuple (source event ID, field
// path, position) so a carried copy keeps its identity and two occurrences of identical text
// never merge.
const retained = [
  [
    'criterion_lineage',
    'source_event_id=NEW.source_event_id AND field_path=NEW.field_path AND position=NEW.position',
  ],
  ['claims', 'claim_id=NEW.claim_id'],
  [
    'claim_revisions',
    'revision_id=NEW.revision_id OR (source_event_id=NEW.source_event_id AND field_path=NEW.field_path AND position=NEW.position)',
  ],
  ['decisions', 'decision_id=NEW.decision_id'],
  [
    'decision_revisions',
    'revision_id=NEW.revision_id OR (source_event_id=NEW.source_event_id AND field_path=NEW.field_path AND position=NEW.position)',
  ],
  // A replace guard has to name every unique tuple its table carries, not just the primary key:
  // INSERT OR REPLACE with a fresh primary key and a colliding secondary tuple would otherwise
  // delete the retained row without firing the delete guard. `IS` compares the nullable scope
  // value null-safely, so one clause covers both the table constraint and the partial
  // project-scope index.
  [
    'record_relationships',
    'relationship_id=NEW.relationship_id OR (relation=NEW.relation AND from_entity_kind=NEW.from_entity_kind AND from_revision_id=NEW.from_revision_id AND to_entity_kind=NEW.to_entity_kind AND to_revision_id=NEW.to_revision_id AND scope_kind=NEW.scope_kind AND scope_value IS NEW.scope_value)',
  ],
  [
    'adoptions',
    'adoption_id=NEW.adoption_id OR (target_kind=NEW.target_kind AND target_revision_id=NEW.target_revision_id AND scope_kind=NEW.scope_kind AND scope_value IS NEW.scope_value AND approver=NEW.approver)',
  ],
  ['assessments', 'assessment_id=NEW.assessment_id'],
] as const;

const sha256 = (column: string) => `length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;

const tables = `
CREATE TABLE criterion_lineage (
  source_event_id TEXT NOT NULL CHECK (length(source_event_id)>0),
  field_path TEXT NOT NULL CHECK (length(field_path)>0),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  criterion_id TEXT NOT NULL CHECK (length(criterion_id)>0),
  step_id TEXT NOT NULL CHECK (length(step_id)>0),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  artifact_generation INTEGER NOT NULL CHECK (artifact_generation BETWEEN 1 AND 9007199254740991),
  lineage TEXT NOT NULL CHECK (lineage IN ('added','carried','rewritten')),
  prior_criterion_id TEXT CHECK (prior_criterion_id IS NULL OR length(prior_criterion_id)>0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project','branch','artifact')),
  scope_value TEXT,
  record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (source_event_id, field_path, position),
  CHECK ((scope_kind='project' AND scope_value IS NULL) OR (scope_kind<>'project' AND scope_value IS NOT NULL AND length(scope_value)>0)),
  CHECK ((lineage='added' AND prior_criterion_id IS NULL) OR (lineage<>'added' AND prior_criterion_id IS NOT NULL)),
  FOREIGN KEY (artifact_id, artifact_generation) REFERENCES artifact_revisions(artifact_id, generation),
  FOREIGN KEY (artifact_id, source_event_id) REFERENCES artifact_events(artifact_id, event_id)
) STRICT;
CREATE INDEX criterion_lineage_identity ON criterion_lineage(criterion_id, artifact_id, artifact_generation);
CREATE TABLE claims (
  claim_id TEXT PRIMARY KEY,
  first_revision_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (claim_id, first_revision_id),
  FOREIGN KEY (claim_id, first_revision_id) REFERENCES claim_revisions(claim_id, revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- A claim revision states what an agent asserted and, separately, what an agent reported about
-- running something. Verification is agent-supplied evidence, never proof, so the column that
-- carries it can hold nothing else: there is no reproduced or confirmed provenance to record.
CREATE TABLE claim_revisions (
  revision_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) DEFERRABLE INITIALLY DEFERRED,
  previous_revision_id TEXT,
  source_event_id TEXT NOT NULL CHECK (length(source_event_id)>0),
  field_path TEXT NOT NULL CHECK (length(field_path)>0),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  asserted_by TEXT NOT NULL CHECK (length(asserted_by)>0),
  assertion_source_json TEXT NOT NULL CHECK (json_valid(assertion_source_json)),
  verification_json TEXT CHECK (verification_json IS NULL OR json_valid(verification_json)),
  verification_provenance TEXT CHECK (verification_provenance IS NULL OR verification_provenance='agent_reported'),
  record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (claim_id, revision_id),
  UNIQUE (source_event_id, field_path, position),
  CHECK ((verification_json IS NULL AND verification_provenance IS NULL) OR (verification_json IS NOT NULL AND verification_provenance IS NOT NULL)),
  -- The deferred foreign key below is satisfied by a row that names itself, and a BEFORE INSERT
  -- trigger cannot see the row it is about to admit, so the lineage guard cannot catch this.
  CHECK (previous_revision_id IS NULL OR previous_revision_id<>revision_id),
  FOREIGN KEY (claim_id, previous_revision_id) REFERENCES claim_revisions(claim_id, revision_id)
) STRICT;
CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  first_revision_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (decision_id, first_revision_id),
  FOREIGN KEY (decision_id, first_revision_id) REFERENCES decision_revisions(decision_id, revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- record_bytes is the authored payload exactly as written — the decision, its reason and its
-- rejected alternatives together — because splitting it into columns would let a later reader
-- reassemble something the author never wrote.
CREATE TABLE decision_revisions (
  revision_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id) DEFERRABLE INITIALLY DEFERRED,
  previous_revision_id TEXT,
  source_event_id TEXT NOT NULL CHECK (length(source_event_id)>0),
  field_path TEXT NOT NULL CHECK (length(field_path)>0),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  authored_by TEXT NOT NULL CHECK (length(authored_by)>0),
  alternative_count INTEGER NOT NULL CHECK (alternative_count BETWEEN 0 AND 9007199254740991),
  record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (decision_id, revision_id),
  UNIQUE (source_event_id, field_path, position),
  CHECK (previous_revision_id IS NULL OR previous_revision_id<>revision_id),
  FOREIGN KEY (decision_id, previous_revision_id) REFERENCES decision_revisions(decision_id, revision_id)
) STRICT;
-- Phase 1 allows exactly two relations. A row names both endpoints down to the revision, so a
-- later revision of either entity leaves this edge pointing where its author pointed it.
CREATE TABLE record_relationships (
  relationship_id TEXT PRIMARY KEY,
  relation TEXT NOT NULL CHECK (relation IN ('supersedes','challenges')),
  from_entity_kind TEXT NOT NULL CHECK (from_entity_kind IN ('claim','decision')),
  from_entity_id TEXT NOT NULL CHECK (length(from_entity_id)>0),
  from_revision_id TEXT NOT NULL CHECK (length(from_revision_id)>0),
  to_entity_kind TEXT NOT NULL CHECK (to_entity_kind IN ('claim','decision')),
  to_entity_id TEXT NOT NULL CHECK (length(to_entity_id)>0),
  to_revision_id TEXT NOT NULL CHECK (length(to_revision_id)>0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project','branch')),
  scope_value TEXT,
  attributed_kind TEXT NOT NULL CHECK (attributed_kind IN ('author','detector')),
  attributed_to TEXT NOT NULL CHECK (length(attributed_to)>0),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((scope_kind='project' AND scope_value IS NULL) OR (scope_kind='branch' AND scope_value IS NOT NULL AND length(scope_value)>0)),
  CHECK (from_revision_id<>to_revision_id),
  UNIQUE (relation, from_entity_kind, from_revision_id, to_entity_kind, to_revision_id, scope_kind, scope_value)
) STRICT;
CREATE INDEX record_relationship_endpoints ON record_relationships(to_entity_kind, to_entity_id, to_revision_id, relation);
-- SQLite treats NULLs in a UNIQUE constraint as distinct, so project scope needs its own index
-- or the table-level UNIQUE would admit duplicate project-scoped edges.
CREATE UNIQUE INDEX record_relationship_project_identity ON record_relationships(relation, from_entity_kind, from_revision_id, to_entity_kind, to_revision_id) WHERE scope_kind='project';
-- Adoption records who approved which exact target revision and where it applies. It never
-- writes to the target: asserted_by stays with the author, and an approval is a separate row
-- rather than an upgrade of the authorship it approves.
CREATE TABLE adoptions (
  adoption_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('claim','decision','relationship')),
  target_id TEXT NOT NULL CHECK (length(target_id)>0),
  target_revision_id TEXT NOT NULL CHECK (length(target_revision_id)>0),
  approver TEXT NOT NULL CHECK (length(approver)>0),
  approved_at TEXT NOT NULL CHECK (length(approved_at)>0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project','branch')),
  scope_value TEXT,
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((scope_kind='project' AND scope_value IS NULL) OR (scope_kind='branch' AND scope_value IS NOT NULL AND length(scope_value)>0)),
  -- A relationship row is immutable and has no revisions of its own, so it is its own revision.
  CHECK (target_kind<>'relationship' OR target_revision_id=target_id),
  UNIQUE (target_kind, target_revision_id, scope_kind, scope_value, approver)
) STRICT;
CREATE UNIQUE INDEX adoption_project_identity ON adoptions(target_kind, target_revision_id, approver) WHERE scope_kind='project';
-- An assessment stamps the counters it observed when it read its input. It never advances the
-- intent-change counter itself, and it adds no context receipt, reproduction observation or
-- dependency record.
CREATE TABLE assessments (
  assessment_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  claim_revision_id TEXT NOT NULL,
  assessed_by TEXT NOT NULL CHECK (length(assessed_by)>0),
  observed_write_sequence INTEGER NOT NULL CHECK (observed_write_sequence BETWEEN 0 AND 9007199254740991),
  observed_intent_counter INTEGER NOT NULL CHECK (observed_intent_counter BETWEEN 0 AND 9007199254740991),
  verification_json TEXT NOT NULL CHECK (json_valid(verification_json)),
  verification_provenance TEXT NOT NULL CHECK (verification_provenance='agent_reported'),
  record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (claim_id, claim_revision_id) REFERENCES claim_revisions(claim_id, revision_id)
) STRICT;
CREATE INDEX assessment_subject ON assessments(claim_id, claim_revision_id, observed_intent_counter);
`;

// A revision that continues a lineage has to continue its own: the previous revision has to be
// the one the continuing entity already holds, not an arbitrary sibling.
const lineage = ['claim', 'decision']
  .map(
    (entity) => `
CREATE TRIGGER ${entity}_revision_first BEFORE INSERT ON ${entity}_revisions
WHEN NEW.previous_revision_id IS NULL AND EXISTS (SELECT 1 FROM ${entity}_revisions WHERE ${entity}_id=NEW.${entity}_id) BEGIN
  SELECT RAISE(ABORT, 'A continuing record has exactly one first revision');
END;
CREATE TRIGGER ${entity}_revision_continues BEFORE INSERT ON ${entity}_revisions
WHEN NEW.previous_revision_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM ${entity}_revisions WHERE ${entity}_id=NEW.${entity}_id AND previous_revision_id IS NEW.previous_revision_id
) BEGIN
  SELECT RAISE(ABORT, 'A revision continues the latest retained revision of its record');
END;`
  )
  .join('');

// SQLite resolves an endpoint kind at insert time, so the reference cannot be a foreign key.
const endpoints = ['from', 'to']
  .map(
    (side) => `
CREATE TRIGGER record_relationship_${side}_endpoint BEFORE INSERT ON record_relationships
WHEN NOT EXISTS (
  SELECT 1 FROM claim_revisions WHERE NEW.${side}_entity_kind='claim' AND claim_id=NEW.${side}_entity_id AND revision_id=NEW.${side}_revision_id
  UNION ALL
  SELECT 1 FROM decision_revisions WHERE NEW.${side}_entity_kind='decision' AND decision_id=NEW.${side}_entity_id AND revision_id=NEW.${side}_revision_id
) BEGIN
  SELECT RAISE(ABORT, 'A relationship requires both exact endpoint revisions');
END;`
  )
  .join('');

const adoptionTarget = `
CREATE TRIGGER adoption_target BEFORE INSERT ON adoptions
WHEN NOT EXISTS (
  SELECT 1 FROM claim_revisions WHERE NEW.target_kind='claim' AND claim_id=NEW.target_id AND revision_id=NEW.target_revision_id
  UNION ALL
  SELECT 1 FROM decision_revisions WHERE NEW.target_kind='decision' AND decision_id=NEW.target_id AND revision_id=NEW.target_revision_id
  UNION ALL
  SELECT 1 FROM record_relationships WHERE NEW.target_kind='relationship' AND relationship_id=NEW.target_id
) BEGIN
  SELECT RAISE(ABORT, 'An adoption requires its exact approval target revision');
END;
`;

// INSERT OR REPLACE deletes the colliding row without firing the DELETE guard while recursive
// triggers are off, so every table needs the replace guard beside its update and delete guards.
const guards = retained
  .map(
    ([table, collision]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision}) BEGIN
  SELECT RAISE(ABORT, 'Exact-revision records cannot be replaced');
END;
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Exact-revision records are immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Exact-revision records are retained');
END;`
  )
  .join('');

export const PROJECT_EXACT_REVISION_SCHEMA = tables + lineage + endpoints + adoptionTarget + guards;
