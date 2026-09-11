const immutableKeys = {
  git_retention_operations:
    'original_operation_id = NEW.original_operation_id OR admission_operation_id = NEW.admission_operation_id',
  git_retention_capture_targets: 'original_operation_id = NEW.original_operation_id',
  git_retention_review_targets: 'original_operation_id = NEW.original_operation_id',
  git_retention_publications:
    "publication_id = NEW.publication_id OR (repository_instance_id = NEW.repository_instance_id AND full_ref = NEW.full_ref) OR (original_operation_id = NEW.original_operation_id AND role = NEW.role AND target_id = NEW.target_id) OR (NEW.role = 'checkpoint' AND original_operation_id = NEW.original_operation_id AND role = NEW.role AND checkpoint_number = NEW.checkpoint_number AND checkpoint_phase = NEW.checkpoint_phase)",
  git_retention_transitions:
    'transition_id = NEW.transition_id OR command_operation_id = NEW.command_operation_id OR (original_operation_id = NEW.original_operation_id AND ordinal = NEW.ordinal)',
} as const;

export const PROJECT_RETENTION_PUBLICATION_SCHEMA = `
CREATE TABLE git_retention_operations (
  original_operation_id TEXT PRIMARY KEY,
  admission_operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  repository_instance_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('capture', 'review')),
  capture_target_id TEXT REFERENCES git_retention_capture_targets(original_operation_id) DEFERRABLE INITIALLY DEFERRED,
  review_target_id TEXT REFERENCES git_retention_review_targets(original_operation_id) DEFERRABLE INITIALLY DEFERRED,
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  created_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  CHECK (original_operation_id != admission_operation_id),
  CHECK ((target_kind = 'capture' AND capture_target_id = original_operation_id AND review_target_id IS NULL)
    OR (target_kind = 'review' AND review_target_id = original_operation_id AND capture_target_id IS NULL)),
  CHECK ((target_kind = 'capture') = (capture_target_id IS NOT NULL)),
  CHECK ((target_kind = 'review') = (review_target_id IS NOT NULL)),
  UNIQUE (original_operation_id, repository_instance_id),
  UNIQUE (original_operation_id, target_kind)
) STRICT;
CREATE TABLE git_retention_capture_targets (
  original_operation_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind = 'capture'),
  artifact_id TEXT NOT NULL,
  expected_generation INTEGER CHECK (expected_generation BETWEEN 1 AND 9007199254740991),
  expected_ordered_hash TEXT,
  expected_event_count INTEGER CHECK (expected_event_count BETWEEN 1 AND 9007199254740991),
  expected_byte_length INTEGER CHECK (expected_byte_length BETWEEN 1 AND 9007199254740991),
  expected_tail_event_id TEXT,
  expected_execution_version INTEGER CHECK (expected_execution_version BETWEEN 1 AND 9007199254740991),
  expected_binding_generation INTEGER CHECK (expected_binding_generation BETWEEN 0 AND 9007199254740991),
  expected_baseline_publication_id TEXT REFERENCES git_retention_publications(publication_id),
  FOREIGN KEY (original_operation_id, target_kind) REFERENCES git_retention_operations(original_operation_id, target_kind) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((expected_generation IS NULL) = (expected_ordered_hash IS NULL)),
  CHECK ((expected_generation IS NULL) = (expected_event_count IS NULL)),
  CHECK ((expected_generation IS NULL) = (expected_byte_length IS NULL)),
  CHECK ((expected_generation IS NULL) = (expected_tail_event_id IS NULL)),
  CHECK ((expected_generation IS NULL) = (expected_execution_version IS NULL)),
  CHECK ((expected_generation IS NULL) = (expected_binding_generation IS NULL))
) STRICT;
CREATE TRIGGER git_retention_baseline_expectation BEFORE INSERT ON git_retention_capture_targets
WHEN NEW.expected_baseline_publication_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_publications p
    JOIN git_retention_capture_targets t ON t.original_operation_id = p.original_operation_id
    WHERE p.publication_id = NEW.expected_baseline_publication_id AND p.role = 'baseline'
      AND t.artifact_id = NEW.artifact_id
  ) THEN RAISE(ABORT, 'Expected baseline must retain its exact original artifact owner') END;
END;
CREATE TABLE git_retention_review_targets (
  original_operation_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind = 'review'),
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  membership_revision_id TEXT NOT NULL,
  base_revision_id TEXT,
  floor_publication_id TEXT,
  run_id TEXT,
  run_revision_id TEXT,
  membership_version INTEGER NOT NULL CHECK (membership_version BETWEEN 1 AND 9007199254740991),
  base_version INTEGER NOT NULL CHECK (base_version BETWEEN 0 AND 9007199254740991),
  floor_version INTEGER NOT NULL CHECK (floor_version BETWEEN 0 AND 9007199254740991),
  run_selection_version INTEGER NOT NULL CHECK (run_selection_version BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (original_operation_id, target_kind) REFERENCES git_retention_operations(original_operation_id, target_kind) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (review_id, membership_revision_id) REFERENCES review_membership_revisions(review_id, revision_id),
  FOREIGN KEY (review_id, base_revision_id) REFERENCES review_base_revisions(review_id, revision_id),
  FOREIGN KEY (review_id, floor_publication_id) REFERENCES review_evidence_publications(review_id, publication_id),
  FOREIGN KEY (review_id, run_id) REFERENCES review_runs(review_id, run_id),
  FOREIGN KEY (run_id, run_revision_id) REFERENCES review_run_revisions(run_id, revision_id),
  CHECK ((run_id IS NULL) = (run_revision_id IS NULL))
) STRICT;
CREATE INDEX git_retention_artifact_lookup ON git_retention_capture_targets(artifact_id, original_operation_id);
CREATE INDEX git_retention_review_lookup ON git_retention_review_targets(review_id, original_operation_id);
CREATE TABLE git_retention_publications (
  publication_id TEXT PRIMARY KEY,
  original_operation_id TEXT NOT NULL,
  repository_instance_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('checkpoint', 'baseline', 'review-floor', 'review-floor-base', 'review-base')),
  target_id TEXT NOT NULL,
  checkpoint_number INTEGER CHECK (checkpoint_number BETWEEN 1 AND 9007199254740991),
  checkpoint_phase TEXT CHECK (checkpoint_phase IN ('open', 'close', 'abandon')),
  full_ref TEXT NOT NULL,
  object_oid TEXT NOT NULL CHECK (length(object_oid) IN (40, 64) AND object_oid NOT GLOB '*[^0-9a-f]*' AND object_oid GLOB '*[1-9a-f]*'),
  tree_oid TEXT NOT NULL CHECK (length(tree_oid) = length(object_oid) AND tree_oid NOT GLOB '*[^0-9a-f]*' AND tree_oid GLOB '*[1-9a-f]*'),
  FOREIGN KEY (original_operation_id, repository_instance_id) REFERENCES git_retention_operations(original_operation_id, repository_instance_id),
  CHECK ((role = 'checkpoint') = (checkpoint_number IS NOT NULL)),
  CHECK ((role = 'checkpoint') = (checkpoint_phase IS NOT NULL)),
  UNIQUE (repository_instance_id, full_ref),
  UNIQUE (original_operation_id, role, target_id),
  UNIQUE (original_operation_id, publication_id)
) STRICT;
CREATE UNIQUE INDEX git_retention_operation_boundary ON git_retention_publications(original_operation_id, checkpoint_number, checkpoint_phase) WHERE role = 'checkpoint';
CREATE TRIGGER git_retention_publication_target BEFORE INSERT ON git_retention_publications BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_operations o
    LEFT JOIN git_retention_capture_targets c ON c.original_operation_id = o.original_operation_id
    LEFT JOIN git_retention_review_targets r ON r.original_operation_id = o.original_operation_id
    WHERE o.original_operation_id = NEW.original_operation_id
      AND length(NEW.object_oid) = CASE o.object_format WHEN 'sha1' THEN 40 ELSE 64 END
      AND NEW.full_ref = CASE NEW.role
        WHEN 'checkpoint' THEN 'refs/orcaops/snap/' || c.artifact_id || '/' || NEW.checkpoint_number || '/' || NEW.checkpoint_phase || '-' || NEW.publication_id
        WHEN 'baseline' THEN 'refs/orcaops/baseline/' || c.artifact_id || '-' || NEW.publication_id
        WHEN 'review-floor' THEN 'refs/orcaops/review/' || r.review_id || '-' || NEW.publication_id
        WHEN 'review-floor-base' THEN 'refs/orcaops/review/' || r.review_id || '-' || NEW.publication_id || '-base'
        WHEN 'review-base' THEN 'refs/orcaops/review/' || r.review_id || '-' || NEW.publication_id || '-base' END
  ) THEN RAISE(ABORT, 'Retention ref must match its exact owner and object format') END;
END;
CREATE TABLE git_retention_transitions (
  transition_id TEXT PRIMARY KEY,
  original_operation_id TEXT NOT NULL REFERENCES git_retention_operations(original_operation_id),
  predecessor_transition_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 2),
  kind TEXT NOT NULL CHECK (kind IN ('prepared', 'selected', 'retired')),
  command_operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  retirement_reason TEXT,
  FOREIGN KEY (original_operation_id, predecessor_transition_id) REFERENCES git_retention_transitions(original_operation_id, transition_id),
  CHECK ((kind = 'prepared') = (predecessor_transition_id IS NULL)),
  CHECK ((kind = 'prepared') = (ordinal = 0)),
  CHECK ((kind = 'retired') = (retirement_reason IS NOT NULL)),
  CHECK (retirement_reason IS NULL OR length(retirement_reason) > 0),
  UNIQUE (original_operation_id, ordinal),
  UNIQUE (original_operation_id, transition_id)
) STRICT;
CREATE TRIGGER git_retention_transition_predecessor BEFORE INSERT ON git_retention_transitions BEGIN
  SELECT CASE WHEN NEW.predecessor_transition_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM git_retention_transitions p
    WHERE p.original_operation_id = NEW.original_operation_id AND p.transition_id = NEW.predecessor_transition_id
      AND p.ordinal + 1 = NEW.ordinal AND p.kind != 'retired'
      AND (p.kind = 'prepared' OR NEW.kind = 'retired')
  ) THEN RAISE(ABORT, 'Retention transition requires its exact nonretired predecessor') END;
  SELECT CASE WHEN NEW.kind = 'prepared' AND NOT EXISTS (
    SELECT 1 FROM git_retention_operations o WHERE o.original_operation_id = NEW.original_operation_id
      AND o.admission_operation_id = NEW.command_operation_id
  ) THEN RAISE(ABORT, 'Prepared retention requires its original admission receipt') END;
  SELECT CASE WHEN NEW.kind = 'selected' AND NEW.command_operation_id != NEW.original_operation_id
    THEN RAISE(ABORT, 'Selected retention requires its original terminal receipt') END;
END;
CREATE TRIGGER git_retention_retirement_identity BEFORE INSERT ON git_retention_transitions
WHEN NEW.kind = 'retired' AND NEW.command_operation_id = NEW.original_operation_id BEGIN
  SELECT RAISE(ABORT, 'Retirement cannot consume the original terminal operation identity');
END;
CREATE TABLE git_retention_current (
  original_operation_id TEXT PRIMARY KEY REFERENCES git_retention_operations(original_operation_id),
  transition_id TEXT NOT NULL,
  FOREIGN KEY (original_operation_id, transition_id) REFERENCES git_retention_transitions(original_operation_id, transition_id)
) STRICT;
CREATE TRIGGER git_retention_current_insert BEFORE INSERT ON git_retention_current BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM git_retention_current WHERE original_operation_id = NEW.original_operation_id)
    OR NOT EXISTS (SELECT 1 FROM git_retention_transitions WHERE transition_id = NEW.transition_id AND kind = 'prepared')
    THEN RAISE(ABORT, 'Retention selection starts once at its prepared transition') END;
END;
CREATE TRIGGER git_retention_current_update BEFORE UPDATE ON git_retention_current BEGIN
  SELECT CASE WHEN OLD.original_operation_id != NEW.original_operation_id OR NOT EXISTS (
    SELECT 1 FROM git_retention_transitions n WHERE n.original_operation_id = OLD.original_operation_id
      AND n.transition_id = NEW.transition_id AND n.predecessor_transition_id = OLD.transition_id
  ) THEN RAISE(ABORT, 'Retention current state must advance from its exact predecessor') END;
END;
CREATE TRIGGER git_retention_current_no_delete BEFORE DELETE ON git_retention_current BEGIN
  SELECT RAISE(ABORT, 'Retention state is retained');
END;
${Object.entries(immutableKeys)
  .map(
    ([table, key]) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Retention history is immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Retention history is retained');
END;
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${key}) BEGIN
  SELECT RAISE(ABORT, 'Retention history is immutable');
END;`
  )
  .join('')}
`;
