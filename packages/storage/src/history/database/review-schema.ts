const retainedTables = [
  'reviews',
  'review_membership_revisions',
  'review_base_revisions',
  'review_evidence_publications',
  'review_evidence_members',
  'review_run_revisions',
  'review_comment_revisions',
  'review_workflow_transitions',
  'review_comment_claim_links',
] as const;

export const PROJECT_REVIEW_SCHEMA = `
CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY,
  identity_bytes BLOB NOT NULL,
  identity_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  branch TEXT,
  repository_instance_id TEXT
) STRICT;
CREATE INDEX review_branch_lookup ON reviews(branch, review_id);
CREATE TABLE review_membership_revisions (
  revision_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  previous_revision_id TEXT,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  FOREIGN KEY (review_id, previous_revision_id) REFERENCES review_membership_revisions(review_id, revision_id),
  UNIQUE (review_id, revision_id)
) STRICT;
CREATE TABLE review_members (
  membership_revision_id TEXT NOT NULL REFERENCES review_membership_revisions(revision_id),
  artifact_id TEXT NOT NULL,
  artifact_generation INTEGER NOT NULL,
  FOREIGN KEY (artifact_id, artifact_generation) REFERENCES artifact_revisions(artifact_id, generation),
  PRIMARY KEY (membership_revision_id, artifact_id)
) STRICT;
CREATE TABLE review_base_revisions (
  revision_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  previous_revision_id TEXT,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  FOREIGN KEY (review_id, previous_revision_id) REFERENCES review_base_revisions(review_id, revision_id),
  UNIQUE (review_id, revision_id)
) STRICT;
CREATE TABLE review_evidence_publications (
  publication_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  kind TEXT NOT NULL CHECK (kind IN ('floor', 'story', 'semantic', 'run-input', 'run-attempt')),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  membership_revision_id TEXT NOT NULL,
  floor_publication_id TEXT,
  floor_input_hash TEXT NOT NULL,
  run_id TEXT,
  run_revision_id TEXT,
  generation TEXT,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  FOREIGN KEY (review_id, membership_revision_id) REFERENCES review_membership_revisions(review_id, revision_id),
  FOREIGN KEY (review_id, floor_publication_id) REFERENCES review_evidence_publications(review_id, publication_id),
  FOREIGN KEY (review_id, run_id) REFERENCES review_runs(review_id, run_id),
  FOREIGN KEY (run_id, run_revision_id) REFERENCES review_run_revisions(run_id, revision_id),
  CHECK ((run_id IS NULL) = (run_revision_id IS NULL)),
  CHECK (kind != 'floor' OR (floor_publication_id IS NULL AND run_id IS NULL AND generation IS NULL)),
  CHECK (kind != 'story' OR (floor_publication_id IS NOT NULL AND run_id IS NOT NULL AND generation IS NOT NULL)),
  CHECK (kind NOT IN ('run-input', 'run-attempt') OR (floor_publication_id IS NOT NULL AND run_id IS NOT NULL AND run_revision_id IS NOT NULL)),
  UNIQUE (review_id, publication_id)
) STRICT;
CREATE UNIQUE INDEX review_original_run_inputs ON review_evidence_publications(run_id) WHERE kind = 'run-input';
CREATE UNIQUE INDEX review_run_attempt_bundle ON review_evidence_publications(run_id, run_revision_id) WHERE kind = 'run-attempt';
CREATE TABLE review_evidence_members (
  publication_id TEXT NOT NULL REFERENCES review_evidence_publications(publication_id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER,
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (publication_id, name)
) STRICT;
CREATE TABLE review_runs (
  run_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  current_revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY (run_id, current_revision_id) REFERENCES review_run_revisions(run_id, revision_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (review_id, run_id)
) STRICT;
CREATE TABLE review_run_revisions (
  revision_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES review_runs(run_id),
  previous_revision_id TEXT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  floor_publication_id TEXT NOT NULL,
  membership_revision_id TEXT NOT NULL,
  FOREIGN KEY (review_id, run_id) REFERENCES review_runs(review_id, run_id),
  FOREIGN KEY (run_id, previous_revision_id) REFERENCES review_run_revisions(run_id, revision_id),
  FOREIGN KEY (review_id, floor_publication_id) REFERENCES review_evidence_publications(review_id, publication_id),
  FOREIGN KEY (review_id, membership_revision_id) REFERENCES review_membership_revisions(review_id, revision_id),
  UNIQUE (run_id, revision_id),
  UNIQUE (run_id, version)
) STRICT;
CREATE TABLE review_attempts (
  run_revision_id TEXT NOT NULL REFERENCES review_run_revisions(revision_id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (run_revision_id, ordinal)
) STRICT;
CREATE TABLE review_selections (
  review_id TEXT PRIMARY KEY REFERENCES reviews(review_id),
  membership_revision_id TEXT NOT NULL,
  base_revision_id TEXT,
  floor_publication_id TEXT,
  current_run_id TEXT,
  story_publication_id TEXT,
  semantic_publication_id TEXT,
  membership_version INTEGER NOT NULL CHECK (membership_version BETWEEN 1 AND 9007199254740991),
  base_version INTEGER NOT NULL CHECK (base_version BETWEEN 0 AND 9007199254740991),
  floor_version INTEGER NOT NULL CHECK (floor_version BETWEEN 0 AND 9007199254740991),
  run_selection_version INTEGER NOT NULL CHECK (run_selection_version BETWEEN 0 AND 9007199254740991),
  story_version INTEGER NOT NULL CHECK (story_version BETWEEN 0 AND 9007199254740991),
  semantic_version INTEGER NOT NULL CHECK (semantic_version BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (review_id, membership_revision_id) REFERENCES review_membership_revisions(review_id, revision_id),
  FOREIGN KEY (review_id, base_revision_id) REFERENCES review_base_revisions(review_id, revision_id),
  FOREIGN KEY (review_id, floor_publication_id) REFERENCES review_evidence_publications(review_id, publication_id),
  FOREIGN KEY (review_id, current_run_id) REFERENCES review_runs(review_id, run_id),
  FOREIGN KEY (review_id, story_publication_id) REFERENCES review_evidence_publications(review_id, publication_id),
  FOREIGN KEY (review_id, semantic_publication_id) REFERENCES review_evidence_publications(review_id, publication_id)
) STRICT;
CREATE TABLE review_comments (
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  comment_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY (review_id, comment_id, current_revision_id) REFERENCES review_comment_revisions(review_id, comment_id, revision_id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (review_id, comment_id)
) STRICT;
CREATE TABLE review_comment_revisions (
  revision_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  previous_revision_id TEXT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  FOREIGN KEY (review_id, comment_id) REFERENCES review_comments(review_id, comment_id),
  FOREIGN KEY (review_id, comment_id, previous_revision_id) REFERENCES review_comment_revisions(review_id, comment_id, revision_id),
  UNIQUE (review_id, comment_id, revision_id),
  UNIQUE (review_id, comment_id, version)
) STRICT;
CREATE TABLE review_workflow_transitions (
  revision_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  target_key TEXT NOT NULL,
  previous_revision_id TEXT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  FOREIGN KEY (review_id, target_key, previous_revision_id) REFERENCES review_workflow_transitions(review_id, target_key, revision_id),
  UNIQUE (review_id, target_key, revision_id),
  UNIQUE (review_id, target_key, version),
  UNIQUE (review_id, sequence)
) STRICT;
CREATE TABLE review_workflow_current (
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  target_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY (review_id, target_key, revision_id) REFERENCES review_workflow_transitions(review_id, target_key, revision_id),
  PRIMARY KEY (review_id, target_key)
) STRICT;
CREATE TABLE review_comment_claim_links (
  link_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  comment_revision_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  endpoint_json TEXT NOT NULL CHECK (json_valid(endpoint_json)),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  FOREIGN KEY (review_id, comment_id, comment_revision_id) REFERENCES review_comment_revisions(review_id, comment_id, revision_id)
) STRICT;
${retainedTables
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Review history is immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Review history is retained');
END;`
  )
  .join('')}
`;
