const collisions = {
  store_identity:
    'singleton = NEW.singleton OR project_id = NEW.project_id OR store_instance_id = NEW.store_instance_id OR initialization_operation_id = NEW.initialization_operation_id',
  activation: 'singleton = NEW.singleton OR store_identity_id = NEW.store_identity_id',
  operations: 'operation_id = NEW.operation_id',
  artifact_events:
    'event_id = NEW.event_id OR (artifact_id = NEW.artifact_id AND ordinal = NEW.ordinal)',
  artifact_revisions: 'artifact_id = NEW.artifact_id AND generation = NEW.generation',
  repository_creation: 'singleton = NEW.singleton OR store_identity_id = NEW.store_identity_id',
  reviews: 'review_id = NEW.review_id',
  review_membership_revisions: 'revision_id = NEW.revision_id',
  review_base_revisions: 'revision_id = NEW.revision_id',
  review_evidence_publications:
    "publication_id = NEW.publication_id OR (kind = 'run-input' AND NEW.kind = 'run-input' AND run_id = NEW.run_id) OR (kind = 'run-attempt' AND NEW.kind = 'run-attempt' AND run_id = NEW.run_id AND run_revision_id = NEW.run_revision_id)",
  review_evidence_members:
    '(publication_id = NEW.publication_id AND name = NEW.name) OR relative_path = NEW.relative_path',
  review_run_revisions:
    'revision_id = NEW.revision_id OR (run_id = NEW.run_id AND version = NEW.version)',
  review_comment_revisions:
    'revision_id = NEW.revision_id OR (review_id = NEW.review_id AND comment_id = NEW.comment_id AND version = NEW.version)',
  review_workflow_transitions:
    'revision_id = NEW.revision_id OR (review_id = NEW.review_id AND target_key = NEW.target_key AND version = NEW.version) OR (review_id = NEW.review_id AND sequence = NEW.sequence)',
  review_comment_claim_links: 'link_id = NEW.link_id',
  execution_initializations: 'artifact_id = NEW.artifact_id',
  execution_transitions:
    'artifact_id = NEW.artifact_id AND (operation_id = NEW.operation_id OR ordinal = NEW.ordinal OR generation = NEW.generation)',
  execution_associations:
    'artifact_id = NEW.artifact_id AND (worktree_id = NEW.worktree_id OR association_position = NEW.association_position OR ordinal = NEW.ordinal)',
  execution_checkpoint_attributions:
    'artifact_id = NEW.artifact_id AND (checkpoint_event_id = NEW.checkpoint_event_id OR ordinal = NEW.ordinal)',
  execution_checkpoint_recoveries:
    'artifact_id = NEW.artifact_id AND (operation_id = NEW.operation_id OR ordinal = NEW.ordinal)',
  usage_events: 'event_id = NEW.event_id OR ordinal = NEW.ordinal',
  usage_revisions: 'generation = NEW.generation OR operation_id = NEW.operation_id',
} as const;

// SQLite replacement bypasses DELETE guards when recursive triggers are disabled.
export const PROJECT_RETAINED_INSERT_SCHEMA = Object.entries(collisions)
  .map(
    ([table, collision]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision}) BEGIN
  SELECT RAISE(ABORT, 'Original retained rows cannot be replaced');
END;`
  )
  .join('');
