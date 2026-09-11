// Operational state the frozen 0.2.0-rc.2 profile recorded without any identity a live
// typed table requires — a cloud server, an account, a push identity — lands here instead
// of in the session, cloud and account-scoped source-plan tables. Unknown provenance stays
// unknown: these rows are retained history, never a fabricated live owner.
const tables = `
CREATE TABLE legacy_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_identity_id INTEGER NOT NULL UNIQUE REFERENCES store_identity(singleton),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  source_profile TEXT NOT NULL CHECK (source_profile = 'orcaops-0.2.0-rc.2'),
  source_revision TEXT NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
  omissions_json TEXT NOT NULL CHECK (json_valid(omissions_json)),
  git_resources_json TEXT NOT NULL CHECK (json_valid(git_resources_json))
) STRICT;
CREATE TABLE legacy_session_branch_state (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  repo_url TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  current_branch TEXT NOT NULL,
  branch_history_json TEXT NOT NULL CHECK (json_valid(branch_history_json)),
  base_commit_sha TEXT,
  acked_at TEXT,
  -- The frozen profile records no session update time. The column stays so a reader can see
  -- the absence rather than guess at it, and it is always NULL: inventing one would be a fact
  -- the legacy writer never wrote.
  updated_at TEXT,
  source_location TEXT NOT NULL,
  account_provenance TEXT NOT NULL CHECK (account_provenance = 'unknown'),
  UNIQUE (repo_url, working_dir)
) STRICT;
-- The frozen writer keeps a successful sync and a later failed push side by side on the same
-- artifact row, with a running failure count. Both are retained here; collapsing them into one
-- mutually exclusive state would discard history the source still holds.
CREATE TABLE legacy_artifact_cloud_facts (
  artifact_id TEXT PRIMARY KEY,
  synced_at TEXT,
  sync_hash TEXT,
  external_id TEXT,
  org_id TEXT,
  last_push_attempt_at TEXT,
  last_push_error_kind TEXT,
  last_push_error_message TEXT,
  consecutive_failures INTEGER CHECK (
    consecutive_failures IS NULL OR consecutive_failures BETWEEN 0 AND 9007199254740991
  ),
  source_location TEXT NOT NULL,
  account_provenance TEXT NOT NULL CHECK (account_provenance = 'unknown'),
  CHECK (
    synced_at IS NOT NULL
    OR last_push_error_kind IS NOT NULL
    OR last_push_attempt_at IS NOT NULL
    OR (consecutive_failures IS NOT NULL AND consecutive_failures > 0)
  )
) STRICT;
CREATE TABLE legacy_source_plan_records (
  source_location TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('approved', 'review', 'locator')),
  namespace_base_url TEXT NOT NULL,
  namespace_org_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  slug TEXT,
  version_number INTEGER CHECK (version_number IS NULL OR version_number BETWEEN 1 AND 9007199254740991),
  version_id TEXT,
  target TEXT,
  title TEXT,
  content_hash TEXT,
  body_bytes BLOB,
  real_path TEXT,
  pulled_at TEXT,
  record_bytes BLOB NOT NULL,
  record_sha256 TEXT NOT NULL,
  account_provenance TEXT NOT NULL CHECK (account_provenance = 'unknown')
) STRICT;
CREATE TABLE legacy_sqlite_images (
  source_location TEXT NOT NULL,
  part TEXT NOT NULL CHECK (part IN ('main', 'wal', 'shm')),
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 9007199254740991),
  baseline_version INTEGER NOT NULL CHECK (baseline_version IN (20, 22, 23, 24, 25)),
  wal_frames INTEGER NOT NULL CHECK (wal_frames BETWEEN 0 AND 9007199254740991),
  committed_frames INTEGER NOT NULL CHECK (committed_frames BETWEEN 0 AND 9007199254740991),
  table_counts_json TEXT NOT NULL CHECK (json_valid(table_counts_json)),
  PRIMARY KEY (source_location, part)
) STRICT;
`;

const retained = [
  'legacy_import',
  'legacy_session_branch_state',
  'legacy_artifact_cloud_facts',
  'legacy_source_plan_records',
  'legacy_sqlite_images',
] as const;

const guards = retained
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Imported legacy history is immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Imported legacy history is retained');
END;`
  )
  .join('');

const collisions = {
  legacy_import: 'singleton = NEW.singleton OR operation_id = NEW.operation_id',
  legacy_session_branch_state:
    'ordinal = NEW.ordinal OR (repo_url = NEW.repo_url AND working_dir = NEW.working_dir)',
  legacy_artifact_cloud_facts: 'artifact_id = NEW.artifact_id',
  legacy_source_plan_records: 'source_location = NEW.source_location',
  legacy_sqlite_images: 'source_location = NEW.source_location AND part = NEW.part',
} as const;

// INSERT OR REPLACE deletes the colliding row without firing the DELETE guard while recursive
// triggers are off, so every retained table needs this alongside its update and delete guards.
const replacements = Object.entries(collisions)
  .map(
    ([table, collision]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision}) BEGIN
  SELECT RAISE(ABORT, 'Original retained rows cannot be replaced');
END;`
  )
  .join('');

// The conversion writes every legacy row in the same transaction that creates the store, so
// nothing may be added afterwards: a later insert would be new content wearing an imported
// label. The receipt row is written last and is the witness these guards test against.
const closure = retained
  .filter((table) => table !== 'legacy_import')
  .map(
    (table) => `
CREATE TRIGGER ${table}_import_only BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM legacy_import) BEGIN
  SELECT RAISE(ABORT, 'Legacy rows belong to the original conversion transaction');
END;`
  )
  .join('');

export const PROJECT_LEGACY_IMPORT_SCHEMA =
  tables +
  guards +
  replacements +
  closure +
  `
CREATE INDEX legacy_source_plan_namespace ON legacy_source_plan_records(
  namespace_base_url, namespace_org_id, kind, external_id
);
`;
