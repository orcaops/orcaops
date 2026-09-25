import { PROJECT_ARTIFACT_PUSH_SCHEMA } from './artifact-push-schema.js';
import { PROJECT_CAPTURE_OPERATION_SCHEMA } from './capture-operation-schema.js';
import { PROJECT_CLOUD_SYNC_SCHEMA } from './cloud-sync-schema.js';
import { PROJECT_DOMAIN_OPERATION_INDEX_SCHEMA } from './domain-operation-index-schema.js';
import { PROJECT_EVALUATOR_FINDINGS_SCHEMA } from './evaluator-findings-schema.js';
import { PROJECT_EXACT_REVISION_SCHEMA } from './exact-revision-schema.js';
import { PROJECT_EXECUTION_FOCUS_SCHEMA } from './execution-focus-schema.js';
import { PROJECT_EXECUTION_SCHEMA } from './execution-schema.js';
import { PROJECT_GROUPED_REMOTE_TRANSPORT_SCHEMA } from './grouped-remote-schema.js';
import { PROJECT_KNOWLEDGE_EVIDENCE_SCHEMA } from './knowledge-evidence-schema.js';
import { PROJECT_KNOWLEDGE_RECONSIDERATION_SCHEMA } from './knowledge-reconsideration-schema.js';
import { PROJECT_KNOWLEDGE_SCHEMA } from './knowledge-schema.js';
import { PROJECT_LEGACY_IMPORT_SCHEMA } from './legacy-import-schema.js';
import { PROJECT_OPERATION_RECEIPT_INDEX_SCHEMA } from './operation-receipt-schema.js';
import { PROJECT_PLAN_CAPTURE_SCHEMA } from './plan-capture-schema.js';
import { PROJECT_QUERY_METADATA_SCHEMA } from './query-metadata-schema.js';
import { PROJECT_QUERY_STATISTICS_SCHEMA } from './query-statistics-schema.js';
import { PROJECT_RATIONALE_SCHEMA } from './rationale-schema.js';
import { PROJECT_RETAINED_INSERT_SCHEMA } from './retained-insert-schema.js';
import { PROJECT_RETENTION_BINDING_SCHEMA } from './retention-binding-schema.js';
import { PROJECT_RETENTION_PUBLICATION_SCHEMA } from './retention-publication-schema.js';
import { PROJECT_REVIEW_FEEDBACK_CURSOR_SCHEMA } from './review-feedback-cursor-schema.js';
import { PROJECT_REVIEW_FINALIZATION_SCHEMA } from './review-finalization-schema.js';
import { PROJECT_PENDING_REVIEW_SCHEMA } from './review-retention-schema.js';
import { PROJECT_REVIEW_SCHEMA } from './review-schema.js';
import { PROJECT_REVIEW_SEMANTIC_SCHEMA } from './review-semantic-schema.js';
import { PROJECT_SEARCH_SCHEMA } from './search-schema.js';
import { PROJECT_SEED_SCHEMA } from './seed-schema.js';
import { PROJECT_SESSION_BRANCH_SCHEMA } from './session-branch-schema.js';
import { PROJECT_SOURCE_PLAN_SCHEMA } from './source-plan-schema.js';
import { PROJECT_SOURCE_PLAN_UPLOAD_SCHEMA } from './source-plan-upload-schema.js';
import { PROJECT_USAGE_SCHEMA } from './usage-schema.js';

// Upgrades from the released format are explicit.
export const PROJECT_DATABASE_SCHEMA_VERSION = 33;

export const PROJECT_DATABASE_BASE_SCHEMA = `
CREATE TABLE store_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  resolved_root TEXT NOT NULL,
  root_key TEXT NOT NULL,
  project_id TEXT NOT NULL UNIQUE,
  store_instance_id TEXT NOT NULL UNIQUE,
  repository_instance_id TEXT NOT NULL,
  initialization_operation_id TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE activation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_identity_id INTEGER NOT NULL UNIQUE REFERENCES store_identity(singleton),
  initialized_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state = 'active')
) STRICT;
CREATE TABLE project_counters (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  write_sequence INTEGER NOT NULL CHECK (write_sequence BETWEEN 0 AND 9007199254740991),
  intent_change_counter INTEGER NOT NULL CHECK (intent_change_counter BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL,
  intent_change INTEGER NOT NULL CHECK (intent_change IN (0, 1)),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  expected_state_json TEXT NOT NULL CHECK (json_valid(expected_state_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  committed_write_sequence INTEGER NOT NULL CHECK (committed_write_sequence BETWEEN 1 AND 9007199254740991),
  committed_intent_counter INTEGER NOT NULL CHECK (committed_intent_counter BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TRIGGER store_identity_no_update BEFORE UPDATE ON store_identity BEGIN
  SELECT RAISE(ABORT, 'Store identity is immutable');
END;
CREATE TRIGGER store_identity_no_delete BEFORE DELETE ON store_identity BEGIN
  SELECT RAISE(ABORT, 'Store identity is retained');
END;
CREATE TRIGGER activation_no_update BEFORE UPDATE ON activation BEGIN
  SELECT RAISE(ABORT, 'Activation is immutable');
END;
CREATE TRIGGER activation_no_delete BEFORE DELETE ON activation BEGIN
  SELECT RAISE(ABORT, 'Activation is retained');
END;
CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations BEGIN
  SELECT RAISE(ABORT, 'Original operation results are immutable');
END;
CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations BEGIN
  SELECT RAISE(ABORT, 'Original operation results are retained');
END;
`;

export const PROJECT_ARTIFACT_SCHEMA = `
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  current_generation INTEGER NOT NULL CHECK (current_generation BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY (artifact_id, current_generation) REFERENCES artifact_revisions(artifact_id, generation) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE artifact_events (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  event_id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  record_bytes BLOB NOT NULL,
  sidecar_payload_bytes BLOB,
  checksum TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (artifact_id, ordinal),
  UNIQUE (artifact_id, event_id)
) STRICT;
CREATE TABLE artifact_revisions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  ordered_hash TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count BETWEEN 1 AND 9007199254740991),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 9007199254740991),
  tail_event_id TEXT NOT NULL,
  FOREIGN KEY (artifact_id, tail_event_id) REFERENCES artifact_events(artifact_id, event_id),
  PRIMARY KEY (artifact_id, generation)
) STRICT;
CREATE TABLE artifact_metadata (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id),
  label TEXT NOT NULL,
  task TEXT NOT NULL,
  agent TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  checkpoint_count INTEGER NOT NULL,
  open_checkpoint_count INTEGER NOT NULL,
  plan_revision_count INTEGER NOT NULL
) STRICT;
CREATE INDEX artifact_listing ON artifact_metadata(started_at DESC, artifact_id ASC);
CREATE TABLE artifact_branches (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  branch TEXT NOT NULL,
  PRIMARY KEY (artifact_id, branch)
) STRICT;
CREATE TRIGGER artifact_events_no_update BEFORE UPDATE ON artifact_events BEGIN
  SELECT RAISE(ABORT, 'Original artifact events are immutable');
END;
CREATE TRIGGER artifact_events_no_delete BEFORE DELETE ON artifact_events BEGIN
  SELECT RAISE(ABORT, 'Original artifact events are retained');
END;
CREATE TRIGGER artifact_revisions_no_update BEFORE UPDATE ON artifact_revisions BEGIN
  SELECT RAISE(ABORT, 'Artifact publication revisions are immutable');
END;
CREATE TRIGGER artifact_revisions_no_delete BEFORE DELETE ON artifact_revisions BEGIN
  SELECT RAISE(ABORT, 'Artifact publication revisions are retained');
END;
`;

export const PROJECT_BRANCH_INDEX_SCHEMA = `
CREATE INDEX artifact_branch_lookup ON artifact_branches(branch, artifact_id);
`;
export const PROJECT_REPOSITORY_CREATION_SCHEMA = `
CREATE TABLE repository_creation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_identity_id INTEGER NOT NULL UNIQUE REFERENCES store_identity(singleton),
  common_directory TEXT NOT NULL,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  birthtime_ns TEXT
) STRICT;
CREATE TRIGGER repository_creation_initialization_only BEFORE INSERT ON repository_creation
WHEN EXISTS (SELECT 1 FROM activation) BEGIN
  SELECT RAISE(ABORT, 'repository creation belongs to original initialization');
END;
CREATE TRIGGER repository_creation_no_update BEFORE UPDATE ON repository_creation BEGIN
  SELECT RAISE(ABORT, 'Original repository creation is immutable');
END;
CREATE TRIGGER repository_creation_no_delete BEFORE DELETE ON repository_creation BEGIN
  SELECT RAISE(ABORT, 'Original repository creation is retained');
END;
`;

export const PROJECT_DATABASE_SCHEMA =
  PROJECT_DATABASE_BASE_SCHEMA +
  PROJECT_ARTIFACT_SCHEMA +
  PROJECT_BRANCH_INDEX_SCHEMA +
  PROJECT_REPOSITORY_CREATION_SCHEMA +
  PROJECT_REVIEW_SCHEMA +
  PROJECT_SEARCH_SCHEMA +
  PROJECT_EXECUTION_SCHEMA +
  PROJECT_USAGE_SCHEMA +
  PROJECT_REVIEW_FINALIZATION_SCHEMA +
  PROJECT_SEED_SCHEMA +
  PROJECT_EXECUTION_FOCUS_SCHEMA +
  PROJECT_RETENTION_PUBLICATION_SCHEMA +
  PROJECT_RETENTION_BINDING_SCHEMA +
  PROJECT_RETAINED_INSERT_SCHEMA +
  PROJECT_CAPTURE_OPERATION_SCHEMA +
  PROJECT_QUERY_METADATA_SCHEMA +
  PROJECT_PENDING_REVIEW_SCHEMA +
  PROJECT_GROUPED_REMOTE_TRANSPORT_SCHEMA +
  PROJECT_PLAN_CAPTURE_SCHEMA +
  PROJECT_SOURCE_PLAN_SCHEMA +
  PROJECT_REVIEW_SEMANTIC_SCHEMA +
  PROJECT_OPERATION_RECEIPT_INDEX_SCHEMA +
  PROJECT_SESSION_BRANCH_SCHEMA +
  PROJECT_CLOUD_SYNC_SCHEMA +
  PROJECT_ARTIFACT_PUSH_SCHEMA +
  PROJECT_DOMAIN_OPERATION_INDEX_SCHEMA +
  PROJECT_QUERY_STATISTICS_SCHEMA +
  PROJECT_LEGACY_IMPORT_SCHEMA +
  PROJECT_EXACT_REVISION_SCHEMA +
  PROJECT_KNOWLEDGE_SCHEMA +
  PROJECT_SOURCE_PLAN_UPLOAD_SCHEMA +
  PROJECT_REVIEW_FEEDBACK_CURSOR_SCHEMA +
  PROJECT_EVALUATOR_FINDINGS_SCHEMA +
  // Observations reference both a knowledge source and an evaluator run's retained context, so
  // they are created after each of them.
  PROJECT_KNOWLEDGE_EVIDENCE_SCHEMA +
  PROJECT_KNOWLEDGE_RECONSIDERATION_SCHEMA +
  PROJECT_RATIONALE_SCHEMA +
  `PRAGMA user_version = ${PROJECT_DATABASE_SCHEMA_VERSION};`;
