export const PROJECT_EXECUTION_SCHEMA = `
CREATE TABLE execution_initializations (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('captured', 'git-import')),
  associations_unknown INTEGER NOT NULL CHECK (associations_unknown IN (0, 1)),
  publication_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE execution_transitions (
  artifact_id TEXT NOT NULL REFERENCES execution_initializations(artifact_id),
  operation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
  publication_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  PRIMARY KEY (artifact_id, operation_id),
  UNIQUE (artifact_id, ordinal),
  UNIQUE (artifact_id, generation),
  UNIQUE (artifact_id, operation_id, generation)
) STRICT;
CREATE TABLE execution_associations (
  artifact_id TEXT NOT NULL REFERENCES execution_initializations(artifact_id),
  worktree_id TEXT NOT NULL,
  repository_instance_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  association_position INTEGER NOT NULL CHECK (association_position > 0),
  publication_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  PRIMARY KEY (artifact_id, worktree_id),
  UNIQUE (artifact_id, association_position),
  UNIQUE (artifact_id, ordinal)
) STRICT;
CREATE INDEX execution_association_lookup ON execution_associations(worktree_id, artifact_id);
CREATE TABLE execution_checkpoint_attributions (
  artifact_id TEXT NOT NULL REFERENCES execution_initializations(artifact_id),
  checkpoint_event_id TEXT NOT NULL,
  binding_generation INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  publication_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  PRIMARY KEY (artifact_id, checkpoint_event_id),
  UNIQUE (artifact_id, ordinal),
  FOREIGN KEY (artifact_id, checkpoint_event_id) REFERENCES artifact_events(artifact_id, event_id),
  FOREIGN KEY (artifact_id, binding_generation) REFERENCES execution_transitions(artifact_id, generation)
) STRICT;
CREATE TABLE execution_checkpoint_recoveries (
  artifact_id TEXT NOT NULL REFERENCES execution_initializations(artifact_id),
  operation_id TEXT NOT NULL,
  checkpoint_event_id TEXT NOT NULL,
  takeover_operation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  publication_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  PRIMARY KEY (artifact_id, operation_id),
  UNIQUE (artifact_id, ordinal),
  FOREIGN KEY (artifact_id, checkpoint_event_id) REFERENCES artifact_events(artifact_id, event_id),
  FOREIGN KEY (artifact_id, takeover_operation_id) REFERENCES execution_transitions(artifact_id, operation_id)
) STRICT;
CREATE TABLE execution_current (
  artifact_id TEXT PRIMARY KEY REFERENCES execution_initializations(artifact_id),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  publication_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  transition_operation_id TEXT NOT NULL,
  binding_generation INTEGER NOT NULL,
  current_worktree_id TEXT,
  FOREIGN KEY (artifact_id, transition_operation_id, binding_generation) REFERENCES execution_transitions(artifact_id, operation_id, generation)
) STRICT;
CREATE INDEX execution_current_worktree ON execution_current(current_worktree_id, artifact_id);
${[
  'execution_initializations',
  'execution_transitions',
  'execution_associations',
  'execution_checkpoint_attributions',
  'execution_checkpoint_recoveries',
]
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Original execution records are immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Original execution records are retained');
END;`
  )
  .join('')}
`;
