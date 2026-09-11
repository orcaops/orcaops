const immutableKeys = {
  pending_review_requests:
    'original_operation_id = NEW.original_operation_id OR selected_transition_id = NEW.selected_transition_id OR (NEW.base_revision_id IS NOT NULL AND base_revision_id = NEW.base_revision_id) OR (NEW.floor_publication_id IS NOT NULL AND floor_publication_id = NEW.floor_publication_id)',
  pending_review_base_records: 'original_operation_id = NEW.original_operation_id',
  pending_review_floor_inputs: 'original_operation_id = NEW.original_operation_id',
  pending_review_untracked_paths:
    'original_operation_id = NEW.original_operation_id AND ordinal = NEW.ordinal',
  pending_review_evidence_members:
    'original_operation_id = NEW.original_operation_id AND name = NEW.name',
} as const;

export const PROJECT_PENDING_REVIEW_SCHEMA = `
CREATE TABLE pending_review_requests (
  original_operation_id TEXT PRIMARY KEY REFERENCES git_retention_review_targets(original_operation_id),
  kind TEXT NOT NULL CHECK (kind IN ('base', 'floor')),
  selected_transition_id TEXT NOT NULL UNIQUE,
  base_revision_id TEXT UNIQUE,
  floor_publication_id TEXT UNIQUE,
  base_record_id TEXT REFERENCES pending_review_base_records(original_operation_id) DEFERRABLE INITIALLY DEFERRED,
  floor_input_id TEXT REFERENCES pending_review_floor_inputs(original_operation_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((kind = 'floor') = (floor_publication_id IS NOT NULL)),
  CHECK (kind != 'base' OR base_revision_id IS NOT NULL),
  CHECK ((base_revision_id IS NULL) = (base_record_id IS NULL)),
  CHECK (base_record_id IS NULL OR base_record_id = original_operation_id),
  CHECK ((kind = 'floor') = (floor_input_id IS NOT NULL)),
  CHECK (floor_input_id IS NULL OR floor_input_id = original_operation_id)
) STRICT;
CREATE TRIGGER pending_review_request_admission BEFORE INSERT ON pending_review_requests BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_current c
      JOIN git_retention_transitions t ON t.original_operation_id = c.original_operation_id AND t.transition_id = c.transition_id
    WHERE c.original_operation_id = NEW.original_operation_id AND t.kind = 'prepared'
      AND t.transition_id != NEW.selected_transition_id
  ) THEN RAISE(ABORT, 'Pending review input requires its original prepared admission') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM git_retention_transitions WHERE transition_id = NEW.selected_transition_id
  ) THEN RAISE(ABORT, 'Pending review selection identity is already retained') END;
  SELECT CASE WHEN NEW.base_revision_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM review_base_revisions WHERE revision_id = NEW.base_revision_id
  ) THEN RAISE(ABORT, 'Pending review base requires a new original revision identity') END;
  SELECT CASE WHEN NEW.floor_publication_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM review_evidence_publications WHERE publication_id = NEW.floor_publication_id
  ) THEN RAISE(ABORT, 'Pending review floor requires a new original publication identity') END;
END;
CREATE TABLE pending_review_base_records (
  original_operation_id TEXT PRIMARY KEY REFERENCES pending_review_requests(original_operation_id),
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TRIGGER pending_review_base_owner BEFORE INSERT ON pending_review_base_records BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM pending_review_requests WHERE original_operation_id = NEW.original_operation_id
      AND base_record_id = NEW.original_operation_id AND base_revision_id IS NOT NULL
  ) THEN RAISE(ABORT, 'Pending base bytes require the same original authored revision') END;
END;
CREATE TABLE pending_review_floor_inputs (
  original_operation_id TEXT PRIMARY KEY REFERENCES pending_review_requests(original_operation_id),
  base_sha TEXT NOT NULL CHECK (length(base_sha) IN (40, 64) AND base_sha NOT GLOB '*[^0-9a-f]*' AND base_sha GLOB '*[1-9a-f]*'),
  pinned_tree_sha TEXT NOT NULL CHECK (length(pinned_tree_sha) = length(base_sha) AND pinned_tree_sha NOT GLOB '*[^0-9a-f]*' AND pinned_tree_sha GLOB '*[1-9a-f]*'),
  worktree_head TEXT CHECK (worktree_head IS NULL OR (length(worktree_head) = length(base_sha) AND worktree_head NOT GLOB '*[^0-9a-f]*' AND worktree_head GLOB '*[1-9a-f]*')),
  default_branch TEXT,
  fingerprint_max_diff_bytes INTEGER NOT NULL CHECK (fingerprint_max_diff_bytes BETWEEN 1 AND 9007199254740991),
  review_max_diff_bytes INTEGER NOT NULL CHECK (review_max_diff_bytes BETWEEN 1 AND 9007199254740991),
  observed_write_sequence INTEGER NOT NULL CHECK (observed_write_sequence BETWEEN 0 AND 9007199254740991),
  floor_member_name TEXT NOT NULL CHECK (floor_member_name = 'floor.json'),
  diff_member_name TEXT NOT NULL CHECK (diff_member_name = 'diff.patch'),
  FOREIGN KEY (original_operation_id, floor_member_name) REFERENCES pending_review_evidence_members(original_operation_id, name) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (original_operation_id, diff_member_name) REFERENCES pending_review_evidence_members(original_operation_id, name) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER pending_review_floor_owner BEFORE INSERT ON pending_review_floor_inputs BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM pending_review_requests r
      JOIN git_retention_operations o ON o.original_operation_id = r.original_operation_id
    WHERE r.original_operation_id = NEW.original_operation_id
      AND r.kind = 'floor' AND r.floor_input_id = NEW.original_operation_id
      AND length(NEW.base_sha) = CASE o.object_format WHEN 'sha1' THEN 40 ELSE 64 END
  ) THEN RAISE(ABORT, 'Pending floor basis requires its exact original floor request') END;
END;
CREATE TABLE pending_review_untracked_paths (
  original_operation_id TEXT NOT NULL REFERENCES pending_review_floor_inputs(original_operation_id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  path TEXT NOT NULL,
  PRIMARY KEY (original_operation_id, ordinal)
) STRICT;
CREATE TABLE pending_review_evidence_members (
  original_operation_id TEXT NOT NULL REFERENCES pending_review_floor_inputs(original_operation_id) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL CHECK (name IN ('floor.json', 'diff.patch')),
  kind TEXT NOT NULL CHECK (kind IN ('floor', 'diff')),
  schema_version INTEGER CHECK (schema_version BETWEEN 1 AND 9007199254740991),
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (original_operation_id, name),
  CHECK ((name = 'floor.json') = (kind = 'floor')),
  CHECK ((kind = 'floor') = (schema_version IS NOT NULL))
) STRICT;
CREATE TRIGGER pending_review_evidence_owner BEFORE INSERT ON pending_review_evidence_members BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM pending_review_requests WHERE original_operation_id = NEW.original_operation_id
      AND kind = 'floor' AND NEW.relative_path = 'evidence/' || floor_publication_id || '/' || NEW.name
  ) THEN RAISE(ABORT, 'Pending evidence must retain its original floor publication path') END;
END;
${Object.entries(immutableKeys)
  .map(
    ([table, key]) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Original pending review input is immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Original pending review input is retained');
END;
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${key}) BEGIN
  SELECT RAISE(ABORT, 'Original pending review input is immutable');
END;`
  )
  .join('')}
`;
