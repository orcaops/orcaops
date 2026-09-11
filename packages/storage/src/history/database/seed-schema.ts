const immutableTables = [
  ['seed_state_sources', 'source_id = NEW.source_id'],
  [
    'seed_state_revisions',
    'revision_id = NEW.revision_id OR generation = NEW.generation OR operation_id = NEW.operation_id',
  ],
  [
    'seed_state_members',
    'revision_id = NEW.revision_id AND (ordinal = NEW.ordinal OR source_id = NEW.source_id)',
  ],
  [
    'seed_bundle_revisions',
    'revision_id = NEW.revision_id OR (bundle_key = NEW.bundle_key AND generation = NEW.generation) OR operation_id = NEW.operation_id',
  ],
  ['seed_bundle_sources', 'source_id = NEW.source_id'],
  [
    'seed_bundle_members',
    'revision_id = NEW.revision_id AND (ordinal = NEW.ordinal OR source_id = NEW.source_id)',
  ],
] as const;

export const PROJECT_SEED_SCHEMA = `
CREATE TABLE seed_state_sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('precious', 'journal', 'coverage')),
  source_identity TEXT NOT NULL,
  source_location TEXT NOT NULL,
  source_revision_id TEXT,
  source_operation_id TEXT,
  source_sha256 TEXT,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2))
) STRICT;
CREATE TABLE seed_state_revisions (
  revision_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE CHECK (generation BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  previous_revision_id TEXT REFERENCES seed_state_revisions(revision_id),
  precious_source_id TEXT REFERENCES seed_state_sources(source_id),
  journal_source_id TEXT REFERENCES seed_state_sources(source_id),
  coverage_source_id TEXT REFERENCES seed_state_sources(source_id),
  content_hash TEXT NOT NULL,
  CHECK ((generation = 1 AND previous_revision_id IS NULL) OR (generation > 1 AND previous_revision_id IS NOT NULL)),
  FOREIGN KEY (revision_id, precious_source_id) REFERENCES seed_state_members(revision_id, source_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (revision_id, journal_source_id) REFERENCES seed_state_members(revision_id, source_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (revision_id, coverage_source_id) REFERENCES seed_state_members(revision_id, source_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE seed_state_members (
  revision_id TEXT NOT NULL REFERENCES seed_state_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  source_id TEXT NOT NULL REFERENCES seed_state_sources(source_id),
  PRIMARY KEY (revision_id, ordinal),
  UNIQUE (revision_id, source_id)
) STRICT;
CREATE TABLE seed_state_selection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision_id TEXT NOT NULL REFERENCES seed_state_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE seed_state_details (
  revision_id TEXT PRIMARY KEY REFERENCES seed_state_revisions(revision_id),
  install_nonce TEXT,
  options_hash TEXT,
  updated_at TEXT,
  pr_context INTEGER CHECK (pr_context IN (0, 1)),
  pending_importance INTEGER CHECK (pending_importance IN (0, 1)),
  commit_graph_hint_shown INTEGER CHECK (commit_graph_hint_shown IN (0, 1)),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  issues_json TEXT NOT NULL CHECK (json_valid(issues_json)),
  cluster_count INTEGER NOT NULL CHECK (cluster_count BETWEEN 0 AND 9007199254740991),
  job_count INTEGER NOT NULL CHECK (job_count BETWEEN 0 AND 9007199254740991),
  discovery_area_count INTEGER NOT NULL CHECK (discovery_area_count BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE seed_clusters (
  revision_id TEXT NOT NULL REFERENCES seed_state_revisions(revision_id),
  cluster_key TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'writing', 'complete', 'covered', 'failed')),
  error TEXT,
  PRIMARY KEY (revision_id, cluster_key)
) STRICT;
CREATE INDEX seed_cluster_artifact_lookup ON seed_clusters(artifact_id, revision_id, cluster_key);
CREATE TABLE seed_jobs (
  revision_id TEXT NOT NULL REFERENCES seed_state_revisions(revision_id),
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'importance', 'commit', 'path', 'resume')),
  invoked_by TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  wall_time_ms INTEGER CHECK (wall_time_ms BETWEEN 0 AND 9007199254740991),
  budget_json TEXT CHECK (json_valid(budget_json)),
  skipped_covered INTEGER CHECK (skipped_covered BETWEEN 0 AND 9007199254740991),
  skips_json TEXT CHECK (json_valid(skips_json)),
  PRIMARY KEY (revision_id, job_id)
) STRICT;
CREATE TABLE seed_discovery_areas (
  revision_id TEXT NOT NULL REFERENCES seed_state_revisions(revision_id),
  area TEXT NOT NULL,
  declined_at TEXT,
  has_declined_at INTEGER NOT NULL CHECK (has_declined_at IN (0, 1)),
  offered_at TEXT,
  declined_paths_json TEXT CHECK (json_valid(declined_paths_json)),
  PRIMARY KEY (revision_id, area),
  CHECK (has_declined_at = 1 OR declined_at IS NULL)
) STRICT;
CREATE TABLE seed_bundle_revisions (
  revision_id TEXT PRIMARY KEY,
  bundle_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pending', 'amend', 'accepted')),
  artifact_id TEXT,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  previous_revision_id TEXT,
  content_hash TEXT NOT NULL,
  CHECK ((kind = 'pending' AND artifact_id IS NULL) OR (kind <> 'pending' AND artifact_id IS NOT NULL)),
  CHECK (bundle_key = json_array(kind, artifact_id)),
  CHECK ((generation = 1 AND previous_revision_id IS NULL) OR (generation > 1 AND previous_revision_id IS NOT NULL)),
  UNIQUE (bundle_key, revision_id),
  UNIQUE (bundle_key, generation),
  FOREIGN KEY (bundle_key, previous_revision_id) REFERENCES seed_bundle_revisions(bundle_key, revision_id)
) STRICT;
CREATE TABLE seed_bundle_sources (
  source_id TEXT PRIMARY KEY,
  bundle_key TEXT NOT NULL,
  key TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  source_location TEXT NOT NULL,
  source_revision_id TEXT,
  source_operation_id TEXT,
  source_sha256 TEXT,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  UNIQUE (bundle_key, source_id)
) STRICT;
CREATE TABLE seed_bundle_members (
  revision_id TEXT NOT NULL,
  bundle_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  source_id TEXT NOT NULL,
  PRIMARY KEY (revision_id, ordinal),
  UNIQUE (revision_id, source_id),
  FOREIGN KEY (bundle_key, revision_id) REFERENCES seed_bundle_revisions(bundle_key, revision_id),
  FOREIGN KEY (bundle_key, source_id) REFERENCES seed_bundle_sources(bundle_key, source_id)
) STRICT;
CREATE TABLE seed_bundle_selection (
  bundle_key TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL,
  FOREIGN KEY (bundle_key, revision_id) REFERENCES seed_bundle_revisions(bundle_key, revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE seed_bundle_details (
  revision_id TEXT PRIMARY KEY REFERENCES seed_bundle_revisions(revision_id),
  options_hash TEXT,
  prior_enrichment_event_id TEXT,
  member_shas_hash TEXT,
  decision_mode TEXT CHECK (decision_mode IN ('preserve', 'replace')),
  pr_context_consented INTEGER CHECK (pr_context_consented IN (0, 1)),
  enriched_at TEXT,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  issues_json TEXT NOT NULL CHECK (json_valid(issues_json)),
  entry_count INTEGER NOT NULL CHECK (entry_count BETWEEN 0 AND 9007199254740991),
  authoring_count INTEGER NOT NULL CHECK (authoring_count BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE seed_bundle_entries (
  revision_id TEXT NOT NULL REFERENCES seed_bundle_revisions(revision_id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  filename TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('merge', 'squash', 'run', 'release')),
  label TEXT NOT NULL,
  date TEXT NOT NULL,
  commit_count INTEGER NOT NULL CHECK (commit_count BETWEEN 1 AND 9007199254740991),
  checkpoint_count INTEGER NOT NULL CHECK (checkpoint_count BETWEEN 1 AND 9007199254740991),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  nomination_count INTEGER NOT NULL CHECK (nomination_count BETWEEN 0 AND 9007199254740991),
  distinct_task_count INTEGER NOT NULL CHECK (distinct_task_count BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (revision_id, ordinal),
  UNIQUE (revision_id, filename),
  UNIQUE (revision_id, artifact_id),
  UNIQUE (revision_id, cluster_key)
) STRICT;
CREATE TABLE seed_bundle_authoring (
  revision_id TEXT NOT NULL REFERENCES seed_bundle_revisions(revision_id),
  source_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  options_hash TEXT NOT NULL,
  selection TEXT NOT NULL CHECK (selection IN ('matching', 'unmatched', 'rejected')),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
  PRIMARY KEY (revision_id, source_id),
  FOREIGN KEY (revision_id, source_id) REFERENCES seed_bundle_members(revision_id, source_id)
) STRICT;
CREATE INDEX seed_bundle_artifact_lookup ON seed_bundle_revisions(artifact_id, kind, generation);
CREATE INDEX seed_authoring_cluster_lookup ON seed_bundle_authoring(revision_id, cluster_key);
${immutableTables
  .map(
    ([table, collision]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision}) BEGIN
  SELECT RAISE(ABORT, 'Seed history is immutable');
END;
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Seed history is immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Seed history is retained');
END;
`
  )
  .join('')}
CREATE TRIGGER seed_state_selection_no_delete BEFORE DELETE ON seed_state_selection BEGIN
  SELECT RAISE(ABORT, 'Seed selection is retained');
END;
CREATE TRIGGER seed_bundle_selection_no_delete BEFORE DELETE ON seed_bundle_selection BEGIN
  SELECT RAISE(ABORT, 'Seed selection is retained');
END;
CREATE TRIGGER seed_state_revision_sources BEFORE INSERT ON seed_state_revisions
WHEN (NEW.precious_source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seed_state_sources WHERE source_id = NEW.precious_source_id AND kind = 'precious'))
  OR (NEW.journal_source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seed_state_sources WHERE source_id = NEW.journal_source_id AND kind = 'journal'))
  OR (NEW.coverage_source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seed_state_sources WHERE source_id = NEW.coverage_source_id AND kind = 'coverage'))
  OR (NEW.previous_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seed_state_revisions WHERE revision_id = NEW.previous_revision_id AND generation = NEW.generation - 1))
  OR EXISTS (SELECT 1 FROM seed_bundle_revisions WHERE revision_id = NEW.revision_id)
BEGIN
  SELECT RAISE(ABORT, 'Seed revision must retain its exact source and predecessor');
END;
CREATE TRIGGER seed_bundle_revision_source BEFORE INSERT ON seed_bundle_revisions
WHEN (NEW.previous_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seed_bundle_revisions WHERE revision_id = NEW.previous_revision_id AND bundle_key = NEW.bundle_key AND generation = NEW.generation - 1))
  OR EXISTS (SELECT 1 FROM seed_state_revisions WHERE revision_id = NEW.revision_id)
BEGIN
  SELECT RAISE(ABORT, 'Seed bundle revision must retain its exact identity and predecessor');
END;
CREATE TRIGGER seed_state_source_identity BEFORE INSERT ON seed_state_sources
WHEN EXISTS (SELECT 1 FROM seed_bundle_sources WHERE source_id = NEW.source_id) BEGIN
  SELECT RAISE(ABORT, 'Original seed source identity cannot be retargeted');
END;
CREATE TRIGGER seed_bundle_source_identity BEFORE INSERT ON seed_bundle_sources
WHEN EXISTS (SELECT 1 FROM seed_state_sources WHERE source_id = NEW.source_id) BEGIN
  SELECT RAISE(ABORT, 'Original seed source identity cannot be retargeted');
END;
`;
