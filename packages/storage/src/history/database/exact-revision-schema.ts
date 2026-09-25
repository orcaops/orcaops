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
// never merge. A revision authored outside a task names its knowledge source in that tuple.
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
  // delete the retained row without firing the delete guard. A relationship and an adoption have
  // no secondary tuple: the row id is the identity, because a later act may repeat an earlier
  // one, a relationship established after it was only suggested or an adoption made again after
  // a withdrawal.
  ['record_relationships', 'relationship_id=NEW.relationship_id'],
  ['adoptions', 'adoption_id=NEW.adoption_id'],
  ['assessments', 'assessment_id=NEW.assessment_id'],
] as const;

export const sha256 = (column: string) =>
  `length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;

export const ATTRIBUTION_BASES =
  "'authenticated','source_attributed','agent_reported_user_instruction','other_assertion','unknown'";
export const SOURCE_STANDINGS = "'explicit_instruction','agent_proposal','extracted_candidate'";
// An instruction embedded in an act is the only authorization an act records one of its own for.
export const INSTRUCTION_KINDS = "'informed_instruction','explicit_instruction'";
export const AUTHORIZATION_KINDS = `${INSTRUCTION_KINDS},'approval_binding','reused_authorization','assignment'`;

// A CHECK passes when its expression is NULL, so a missing kind has to be made false.
//
// authorization_id names the authorization record written for this very act, which is how a
// revocation of that authorization reaches what was published under it. Exactly when the act cited
// an embedded instruction: an adoption and an established replacement each adopt or depart from
// something, so the authorization recorded for one is never over an empty footprint. A released row
// rests on no retained instruction and has both absent, so it passes.
const authorization = `authorization_json TEXT CHECK (authorization_json IS NULL OR (json_valid(authorization_json) AND coalesce(json_extract(authorization_json,'$.kind') IN (${AUTHORIZATION_KINDS}), 0))),
  authorization_id TEXT REFERENCES knowledge_authorizations(authorization_id) CHECK (
    (authorization_id IS NULL OR length(authorization_id)>0)
    AND ((authorization_id IS NOT NULL) = coalesce(json_extract(authorization_json,'$.kind') IN (${INSTRUCTION_KINDS}), 0))
  )`;

// A released row names whoever it is attributed to and records no basis, so it reads as that
// name on an unknown basis. A CHECK cannot tell such a row from a new one, which is why a name
// beside an unknown basis is legal here and only the writers refuse it. What the tables can hold
// to: a detector is always named, and only an unknown actor has no name.
const releasedAttribution = (actorKind: string, name: string) =>
  `CHECK ((attributed_kind='detector' AND ${name} IS NOT NULL AND attributed_basis IS NULL) OR (attributed_kind='${actorKind}' AND attributed_basis IS NOT NULL AND (${name} IS NOT NULL OR attributed_basis='unknown')))`;
const revisionAttribution = (
  name: string
) => `${name} TEXT CHECK (${name} IS NULL OR length(${name})>0),
  attributed_kind TEXT NOT NULL CHECK (attributed_kind IN ('actor','detector')),
  attributed_basis TEXT CHECK (attributed_basis IS NULL OR attributed_basis IN (${ATTRIBUTION_BASES}))`;

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
-- running something. assertion_source_json carries two shapes, told apart by source_standing being
-- NULL: a released row's exact assertion source, and a continuing row's array of the ids of the
-- sources its assertion rests on. Verification is agent-supplied evidence, never proof, so the column that
-- carries it can hold nothing else: there is no reproduced or confirmed provenance to record.
-- Like a decision revision it takes the standing and the subject a released row never recorded,
-- both nullable, under the same detector rule: what background processing wrote is an extracted
-- candidate, and reading a statement out of a source verifies nothing.
-- The self-reference check below is a CHECK rather than a lineage trigger because the deferred
-- foreign key is satisfied by a row that names itself, and a BEFORE INSERT trigger cannot see
-- the row it is about to admit.
CREATE TABLE claim_revisions (
  revision_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) DEFERRABLE INITIALLY DEFERRED,
  previous_revision_id TEXT,
  source_event_id TEXT NOT NULL CHECK (length(source_event_id)>0),
  field_path TEXT NOT NULL CHECK (length(field_path)>0),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  ${revisionAttribution('asserted_by')},
  source_standing TEXT CHECK (source_standing IS NULL OR source_standing IN (${SOURCE_STANDINGS})),
  subject_id TEXT,
  subject_revision_id TEXT,
  assertion_source_json TEXT NOT NULL CHECK (json_valid(assertion_source_json)),
  verification_json TEXT CHECK (verification_json IS NULL OR json_valid(verification_json)),
  verification_provenance TEXT CHECK (verification_provenance IS NULL OR verification_provenance='agent_reported'),
  record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (claim_id, revision_id),
  UNIQUE (source_event_id, field_path, position),
  CHECK ((verification_json IS NULL AND verification_provenance IS NULL) OR (verification_json IS NOT NULL AND verification_provenance IS NOT NULL)),
  CHECK (previous_revision_id IS NULL OR previous_revision_id<>revision_id),
  ${releasedAttribution('actor', 'asserted_by')},
  CHECK (attributed_kind<>'detector' OR (source_standing IS NOT NULL AND source_standing='extracted_candidate')),
  CHECK (attributed_kind<>'detector' OR verification_json IS NULL),
  CHECK ((subject_id IS NULL) = (subject_revision_id IS NULL)),
  FOREIGN KEY (claim_id, previous_revision_id) REFERENCES claim_revisions(claim_id, revision_id),
  FOREIGN KEY (subject_id, subject_revision_id) REFERENCES subject_revisions(subject_id, revision_id)
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
-- reassemble something the author never wrote. A released row records no standing, no subject
-- and no derivation, so all three are absent there; a detector's revision is always an extracted
-- candidate. A decision's identity row carries nothing, so where a derived decision came from
-- lives on the revision that mints the identity and on no later one, which is what the
-- previous_revision_id check below holds it to.
CREATE TABLE decision_revisions (
  revision_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id) DEFERRABLE INITIALLY DEFERRED,
  previous_revision_id TEXT,
  source_event_id TEXT NOT NULL CHECK (length(source_event_id)>0),
  field_path TEXT NOT NULL CHECK (length(field_path)>0),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  ${revisionAttribution('authored_by')},
  source_standing TEXT CHECK (source_standing IS NULL OR source_standing IN (${SOURCE_STANDINGS})),
  subject_id TEXT,
  subject_revision_id TEXT,
  derived_from_kind TEXT CHECK (derived_from_kind IS NULL OR derived_from_kind IN ('requirement','decision')),
  derived_from_id TEXT CHECK (derived_from_id IS NULL OR length(derived_from_id)>0),
  derived_from_revision_id TEXT CHECK (derived_from_revision_id IS NULL OR length(derived_from_revision_id)>0),
  alternative_count INTEGER NOT NULL CHECK (alternative_count BETWEEN 0 AND 9007199254740991),
  record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (decision_id, revision_id),
  UNIQUE (source_event_id, field_path, position),
  CHECK (previous_revision_id IS NULL OR previous_revision_id<>revision_id),
  ${releasedAttribution('actor', 'authored_by')},
  CHECK (attributed_kind<>'detector' OR (source_standing IS NOT NULL AND source_standing='extracted_candidate')),
  CHECK ((subject_id IS NULL) = (subject_revision_id IS NULL)),
  CHECK ((derived_from_kind IS NULL) = (derived_from_id IS NULL) AND (derived_from_kind IS NULL) = (derived_from_revision_id IS NULL)),
  CHECK (derived_from_kind IS NULL OR (previous_revision_id IS NULL AND derived_from_id<>decision_id)),
  FOREIGN KEY (decision_id, previous_revision_id) REFERENCES decision_revisions(decision_id, revision_id),
  FOREIGN KEY (subject_id, subject_revision_id) REFERENCES subject_revisions(subject_id, revision_id)
) STRICT;
CREATE INDEX decision_revision_derived_from ON decision_revisions(derived_from_kind, derived_from_id, derived_from_revision_id) WHERE derived_from_kind IS NOT NULL;
-- A row names both endpoints down to the revision, so a later revision of either entity leaves
-- this edge pointing where its author pointed it. 'supersedes' is the stored word for replacement,
-- and 'author' the stored word for an actor. Released rows are established and unauthorized
-- whoever they are attributed to, which is why a detector row may be established and branch scope
-- stays legal here. New writers refuse both.
CREATE TABLE record_relationships (
  relationship_id TEXT PRIMARY KEY,
  relation TEXT NOT NULL CHECK (relation IN ('supersedes','challenges','depends_on','motivates')),
  from_entity_kind TEXT NOT NULL CHECK (from_entity_kind IN ('claim','decision','requirement')),
  from_entity_id TEXT NOT NULL CHECK (length(from_entity_id)>0),
  from_revision_id TEXT NOT NULL CHECK (length(from_revision_id)>0),
  to_entity_kind TEXT NOT NULL CHECK (to_entity_kind IN ('claim','decision','requirement')),
  to_entity_id TEXT NOT NULL CHECK (length(to_entity_id)>0),
  to_revision_id TEXT NOT NULL CHECK (length(to_revision_id)>0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project','branch','artifact')),
  scope_value TEXT,
  attributed_kind TEXT NOT NULL CHECK (attributed_kind IN ('author','detector')),
  attributed_to TEXT CHECK (attributed_to IS NULL OR length(attributed_to)>0),
  attributed_basis TEXT CHECK (attributed_basis IS NULL OR attributed_basis IN (${ATTRIBUTION_BASES})),
  standing TEXT NOT NULL CHECK (standing IN ('suggested','established')),
  explanation TEXT CHECK (explanation IS NULL OR length(explanation)>0),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  ${authorization},
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((scope_kind='project' AND scope_value IS NULL) OR (scope_kind<>'project' AND scope_value IS NOT NULL AND length(scope_value)>0)),
  CHECK (from_revision_id<>to_revision_id),
  ${releasedAttribution('author', 'attributed_to')}
) STRICT;
CREATE INDEX record_relationship_endpoints ON record_relationships(to_entity_kind, to_entity_id, to_revision_id, relation);
-- A read of one identity asks for the relationships on either side of it, so the side the
-- endpoints index does not lead with needs one of its own.
CREATE INDEX record_relationship_from_entity ON record_relationships(from_entity_kind, from_entity_id);
CREATE INDEX record_relationship_edge ON record_relationships(relation, from_entity_kind, from_revision_id, to_entity_kind, to_revision_id, scope_kind, scope_value);
CREATE INDEX record_relationship_authorization ON record_relationships(authorization_id) WHERE authorization_id IS NOT NULL;
-- Adoption records who approved which exact target revision and where it applies. It never
-- writes to the target: asserted_by stays with the author, and an approval is a separate row
-- rather than an upgrade of the authorship it approves. Rows written before designation, basis
-- and authorization existed are adopted, approved on an unknown basis by the name they carry,
-- and unauthorized; new writers refuse that combination and branch scope. A relationship has no
-- revisions of its own, so an adoption of one names it as its own revision.
CREATE TABLE adoptions (
  adoption_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('claim','decision','relationship','requirement')),
  target_id TEXT NOT NULL CHECK (length(target_id)>0),
  target_revision_id TEXT NOT NULL CHECK (length(target_revision_id)>0),
  approver TEXT CHECK (approver IS NULL OR length(approver)>0),
  approver_basis TEXT NOT NULL CHECK (approver_basis IN (${ATTRIBUTION_BASES})),
  approved_at TEXT NOT NULL CHECK (length(approved_at)>0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project','branch','artifact')),
  scope_value TEXT,
  designation TEXT NOT NULL CHECK (designation IN ('adopted','background')),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  ${authorization},
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((scope_kind='project' AND scope_value IS NULL) OR (scope_kind<>'project' AND scope_value IS NOT NULL AND length(scope_value)>0)),
  CHECK (target_kind<>'relationship' OR target_revision_id=target_id),
  CHECK (approver IS NOT NULL OR approver_basis='unknown')
) STRICT;
CREATE INDEX adoption_target_scope ON adoptions(target_kind, target_revision_id, scope_kind, scope_value, approver);
CREATE INDEX adoption_target_entity ON adoptions(target_kind, target_id);
CREATE INDEX adoption_authorization ON adoptions(authorization_id) WHERE authorization_id IS NOT NULL;
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

// Several revisions may continue the same predecessor; what a continuing record never has is a
// second root.
export const firstRevisionGuard = (entity: string) => `
CREATE TRIGGER ${entity}_revision_first BEFORE INSERT ON ${entity}_revisions
WHEN NEW.previous_revision_id IS NULL AND EXISTS (SELECT 1 FROM ${entity}_revisions WHERE ${entity}_id=NEW.${entity}_id) BEGIN
  SELECT RAISE(ABORT, 'A continuing record has exactly one first revision');
END;`;

const lineage = ['claim', 'decision'].map(firstRevisionGuard).join('');

// SQLite resolves a revision's kind at insert time, so the reference cannot be a foreign key.
export const retainedRevision = (kind: string, entity: string, revision: string) => `
  SELECT 1 FROM claim_revisions WHERE ${kind}='claim' AND claim_id=${entity} AND revision_id=${revision}
  UNION ALL
  SELECT 1 FROM decision_revisions WHERE ${kind}='decision' AND decision_id=${entity} AND revision_id=${revision}
  UNION ALL
  SELECT 1 FROM requirement_revisions WHERE ${kind}='requirement' AND requirement_id=${entity} AND revision_id=${revision}`;

export const retainedRecord = (
  kind: string,
  entity: string,
  revision: string
) => `${retainedRevision(kind, entity, revision)}
  UNION ALL
  SELECT 1 FROM record_relationships WHERE ${kind}='relationship' AND relationship_id=${entity}`;

const endpoints = ['from', 'to']
  .map(
    (side) => `
CREATE TRIGGER record_relationship_${side}_endpoint BEFORE INSERT ON record_relationships
WHEN NOT EXISTS (${retainedRevision(`NEW.${side}_entity_kind`, `NEW.${side}_entity_id`, `NEW.${side}_revision_id`)}
) BEGIN
  SELECT RAISE(ABORT, 'A relationship requires both exact endpoint revisions');
END;`
  )
  .join('');

const adoptionTarget = `
CREATE TRIGGER adoption_target BEFORE INSERT ON adoptions
WHEN NOT EXISTS (${retainedRecord('NEW.target_kind', 'NEW.target_id', 'NEW.target_revision_id')}
) BEGIN
  SELECT RAISE(ABORT, 'An adoption requires its exact approval target revision');
END;
`;

// A decision that derives from a rule names the exact revision of it, so the rule it came from
// stays what its author pointed at however either identity is revised afterwards.
const decisionDerivation = `
CREATE TRIGGER decision_revision_requires_derived_from BEFORE INSERT ON decision_revisions
WHEN NEW.derived_from_kind IS NOT NULL AND NOT EXISTS (${retainedRevision('NEW.derived_from_kind', 'NEW.derived_from_id', 'NEW.derived_from_revision_id')}
) BEGIN
  SELECT RAISE(ABORT, 'A derived decision requires the exact expectation revision it derives from');
END;
`;

// INSERT OR REPLACE deletes the colliding row without firing the DELETE guard while recursive
// triggers are off, so every table needs the replace guard beside its update and delete guards.
export const insertOnlyGuards = (
  tables: ReadonlyArray<readonly [table: string, collision: string]>,
  records: string
) =>
  tables
    .map(
      ([table, collision]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision}) BEGIN
  SELECT RAISE(ABORT, '${records} cannot be replaced');
END;
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, '${records} are immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, '${records} are retained');
END;`
    )
    .join('');

export const PROJECT_EXACT_REVISION_SCHEMA =
  tables +
  lineage +
  endpoints +
  adoptionTarget +
  decisionDerivation +
  insertOnlyGuards(retained, 'Exact-revision records');
