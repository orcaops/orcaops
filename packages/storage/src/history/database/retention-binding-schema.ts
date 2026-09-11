const immutableKeys = {
  pending_capture_requests: 'original_operation_id = NEW.original_operation_id',
  pending_capture_events:
    '(original_operation_id = NEW.original_operation_id AND ordinal = NEW.ordinal) OR event_id = NEW.event_id',
  artifact_retention_selections:
    "publication_id = NEW.publication_id OR (NEW.role = 'checkpoint' AND artifact_id = NEW.artifact_id AND event_id = NEW.event_id AND role = NEW.role)",
  review_retention_bindings:
    'publication_id = NEW.publication_id OR (review_id = NEW.review_id AND target_id = NEW.target_id AND role = NEW.role)',
  git_retention_reclamations: 'cleanup_operation_id = NEW.cleanup_operation_id',
} as const;

export const PROJECT_RETENTION_BINDING_SCHEMA = `
CREATE TABLE pending_capture_requests (
  original_operation_id TEXT PRIMARY KEY REFERENCES git_retention_capture_targets(original_operation_id),
  capture_kind TEXT NOT NULL CHECK (capture_kind IN ('create', 'task', 'summary_amendment', 'historical_maintenance')),
  repository_instance_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  branch TEXT,
  head_oid TEXT,
  created_at TEXT,
  explicit_target INTEGER CHECK (explicit_target IN (0, 1)),
  FOREIGN KEY (original_operation_id, repository_instance_id) REFERENCES git_retention_operations(original_operation_id, repository_instance_id),
  CHECK ((capture_kind = 'create') = (created_at IS NOT NULL)),
  CHECK ((capture_kind = 'create') = (explicit_target IS NULL)),
  CHECK (branch IS NOT NULL OR head_oid IS NOT NULL),
  CHECK (head_oid IS NULL OR (length(head_oid) IN (40, 64) AND head_oid NOT GLOB '*[^0-9a-f]*' AND head_oid GLOB '*[1-9a-f]*'))
) STRICT;
CREATE TRIGGER pending_capture_request_expectation BEFORE INSERT ON pending_capture_requests BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_capture_targets t WHERE t.original_operation_id = NEW.original_operation_id
      AND ((NEW.capture_kind = 'create') = (t.expected_generation IS NULL))
  ) THEN RAISE(ABORT, 'Original capture input must match its exact creation or retained target') END;
END;
CREATE TABLE pending_capture_events (
  original_operation_id TEXT NOT NULL REFERENCES pending_capture_requests(original_operation_id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  event_bytes BLOB NOT NULL,
  sidecar_bytes BLOB,
  event_checksum TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  sidecar_hash TEXT,
  PRIMARY KEY (original_operation_id, ordinal),
  CHECK ((sidecar_bytes IS NULL) = (sidecar_hash IS NULL))
) STRICT;
CREATE TABLE artifact_retention_selections (
  publication_id TEXT PRIMARY KEY,
  original_operation_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_generation INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('checkpoint', 'baseline')),
  FOREIGN KEY (original_operation_id, publication_id) REFERENCES git_retention_publications(original_operation_id, publication_id),
  FOREIGN KEY (artifact_id, artifact_generation) REFERENCES artifact_revisions(artifact_id, generation),
  FOREIGN KEY (artifact_id, event_id) REFERENCES artifact_events(artifact_id, event_id),
  UNIQUE (artifact_id, publication_id, role)
) STRICT;
CREATE UNIQUE INDEX artifact_retention_checkpoint_event ON artifact_retention_selections(artifact_id, event_id) WHERE role = 'checkpoint';
CREATE TRIGGER artifact_retention_selection_target BEFORE INSERT ON artifact_retention_selections BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_publications p
    JOIN git_retention_capture_targets t ON t.original_operation_id = p.original_operation_id
    JOIN artifact_revisions r ON r.artifact_id = NEW.artifact_id AND r.generation = NEW.artifact_generation
    JOIN artifact_events e ON e.artifact_id = NEW.artifact_id AND e.event_id = NEW.event_id
    WHERE p.publication_id = NEW.publication_id AND p.role = NEW.role AND p.target_id = NEW.event_id
      AND t.artifact_id = NEW.artifact_id AND e.ordinal <= r.event_count
      AND EXISTS (SELECT 1 FROM git_retention_current c JOIN git_retention_transitions s ON s.transition_id = c.transition_id
        WHERE c.original_operation_id = NEW.original_operation_id AND s.kind = 'selected')
  ) THEN RAISE(ABORT, 'Artifact retention must bind its exact owner, event and retained revision') END;
END;
CREATE TABLE artifact_baseline_current (
  artifact_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'baseline'),
  FOREIGN KEY (artifact_id, publication_id, role) REFERENCES artifact_retention_selections(artifact_id, publication_id, role)
) STRICT;
CREATE TRIGGER artifact_baseline_current_insert BEFORE INSERT ON artifact_baseline_current
WHEN EXISTS (SELECT 1 FROM artifact_baseline_current WHERE artifact_id = NEW.artifact_id) BEGIN
  SELECT RAISE(ABORT, 'Current baseline requires an explicit selection update');
END;
CREATE TRIGGER artifact_baseline_current_update BEFORE UPDATE ON artifact_baseline_current
WHEN OLD.artifact_id != NEW.artifact_id BEGIN
  SELECT RAISE(ABORT, 'Current baseline cannot change its original artifact');
END;
CREATE TRIGGER artifact_baseline_current_selected_insert BEFORE INSERT ON artifact_baseline_current BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_publications p JOIN git_retention_current c ON c.original_operation_id = p.original_operation_id
      JOIN git_retention_transitions s ON s.transition_id = c.transition_id
    WHERE p.publication_id = NEW.publication_id AND s.kind = 'selected'
  ) THEN RAISE(ABORT, 'A retired or pending publication cannot become the current baseline') END;
END;
CREATE TRIGGER artifact_baseline_current_selected_update BEFORE UPDATE ON artifact_baseline_current BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_publications p JOIN git_retention_current c ON c.original_operation_id = p.original_operation_id
      JOIN git_retention_transitions s ON s.transition_id = c.transition_id
    WHERE p.publication_id = NEW.publication_id AND s.kind = 'selected'
  ) THEN RAISE(ABORT, 'A retired or pending publication cannot become the current baseline') END;
END;
CREATE TRIGGER artifact_baseline_current_expectation_insert BEFORE INSERT ON artifact_baseline_current BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_publications p JOIN git_retention_capture_targets t ON t.original_operation_id = p.original_operation_id
    WHERE p.publication_id = NEW.publication_id AND t.expected_baseline_publication_id IS NULL
  ) THEN RAISE(ABORT, 'Baseline selection changed from its original expectation') END;
END;
CREATE TRIGGER artifact_baseline_current_expectation_update BEFORE UPDATE ON artifact_baseline_current BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_publications p JOIN git_retention_capture_targets t ON t.original_operation_id = p.original_operation_id
    WHERE p.publication_id = NEW.publication_id AND t.expected_baseline_publication_id IS OLD.publication_id
  ) THEN RAISE(ABORT, 'Baseline selection changed from its original expectation') END;
END;
CREATE TRIGGER artifact_baseline_current_no_delete BEFORE DELETE ON artifact_baseline_current BEGIN
  SELECT RAISE(ABORT, 'Baseline selection is retained');
END;
CREATE TABLE review_retention_bindings (
  publication_id TEXT PRIMARY KEY,
  original_operation_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('review-floor', 'review-floor-base', 'review-base')),
  target_id TEXT NOT NULL,
  floor_publication_id TEXT,
  base_revision_id TEXT,
  FOREIGN KEY (original_operation_id, publication_id) REFERENCES git_retention_publications(original_operation_id, publication_id),
  FOREIGN KEY (review_id, floor_publication_id) REFERENCES review_evidence_publications(review_id, publication_id),
  FOREIGN KEY (review_id, base_revision_id) REFERENCES review_base_revisions(review_id, revision_id),
  CHECK ((role IN ('review-floor', 'review-floor-base')) = (floor_publication_id IS NOT NULL)),
  CHECK ((role = 'review-base') = (base_revision_id IS NOT NULL)),
  CHECK (target_id = coalesce(floor_publication_id, base_revision_id)),
  UNIQUE (review_id, target_id, role)
) STRICT;
CREATE TRIGGER review_retention_binding_target BEFORE INSERT ON review_retention_bindings BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_publications p
    JOIN git_retention_review_targets t ON t.original_operation_id = p.original_operation_id
    WHERE p.publication_id = NEW.publication_id AND p.role = NEW.role AND p.target_id = NEW.target_id
      AND t.review_id = NEW.review_id
      AND EXISTS (SELECT 1 FROM git_retention_current c JOIN git_retention_transitions s ON s.transition_id = c.transition_id
        WHERE c.original_operation_id = NEW.original_operation_id AND s.kind = 'selected')
  ) THEN RAISE(ABORT, 'Review retention must bind its exact owner and publication target') END;
  SELECT CASE WHEN NEW.role IN ('review-floor', 'review-floor-base') AND NOT EXISTS (
    SELECT 1 FROM review_evidence_publications WHERE publication_id = NEW.floor_publication_id AND kind = 'floor'
  ) THEN RAISE(ABORT, 'Review Git floor retention requires original floor evidence') END;
END;
CREATE TABLE git_retention_reclamations (
  cleanup_operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  publication_id TEXT NOT NULL,
  original_operation_id TEXT NOT NULL,
  retired_transition_id TEXT NOT NULL,
  expected_oid TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('removed', 'absent')),
  FOREIGN KEY (original_operation_id, publication_id) REFERENCES git_retention_publications(original_operation_id, publication_id),
  FOREIGN KEY (original_operation_id, retired_transition_id) REFERENCES git_retention_transitions(original_operation_id, transition_id)
) STRICT;
CREATE TRIGGER git_retention_reclamation_owner BEFORE INSERT ON git_retention_reclamations BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM git_retention_transitions t
    JOIN git_retention_current c ON c.original_operation_id = t.original_operation_id AND c.transition_id = t.transition_id
    JOIN git_retention_publications p ON p.original_operation_id = t.original_operation_id
    WHERE t.transition_id = NEW.retired_transition_id AND t.kind = 'retired'
      AND p.publication_id = NEW.publication_id AND p.object_oid = NEW.expected_oid
      AND NOT EXISTS (SELECT 1 FROM git_retention_transitions WHERE original_operation_id = NEW.original_operation_id AND kind = 'selected')
      AND NOT EXISTS (SELECT 1 FROM artifact_retention_selections WHERE publication_id = NEW.publication_id)
      AND NOT EXISTS (SELECT 1 FROM review_retention_bindings WHERE publication_id = NEW.publication_id)
  ) THEN RAISE(ABORT, 'Only exact retired publications without retained dependencies can be reclaimed') END;
END;
${Object.entries(immutableKeys)
  .map(
    ([table, key]) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Original retention input and associations are immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Original retention input and associations are retained');
END;
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${key}) BEGIN
  SELECT RAISE(ABORT, 'Original retention input and associations are immutable');
END;`
  )
  .join('')}
`;
