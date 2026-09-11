const provenance = `
  publication_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  artifact_id TEXT NOT NULL,
  artifact_generation INTEGER NOT NULL CHECK (artifact_generation BETWEEN 1 AND 9007199254740991),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('authored', 'historical')),
  source_identity TEXT NOT NULL CHECK (length(source_identity) > 0),
  source_locator TEXT NOT NULL CHECK (length(source_locator) > 0),
  source_profile TEXT,
  source_revision_id TEXT,
  source_event_id TEXT,
  source_operation_id TEXT,
  source_sha256 TEXT,
`;
const references = `
  CHECK ((source_kind = 'authored' AND source_profile IS NULL) OR
    (source_kind = 'historical' AND source_profile IS NOT NULL AND source_profile = '0.2.0-rc.2')),
  CHECK (source_sha256 IS NULL OR (record_hash IS NOT NULL AND source_sha256 = record_hash)),
  FOREIGN KEY (artifact_id, artifact_generation) REFERENCES artifact_revisions(artifact_id, generation) DEFERRABLE INITIALLY DEFERRED
`;
const bytes = `
  record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_hash TEXT NOT NULL CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
`;
const retainedTables = [
  ['artifact_lifecycle_revisions', 'revision_id = NEW.revision_id'],
  ['artifact_attempt_revisions', 'revision_id = NEW.revision_id'],
  ['plan_idempotency_records', 'idempotency_key = NEW.idempotency_key'],
  ['source_time_revisions', 'revision_id = NEW.revision_id'],
] as const;
const selections = [
  [
    'artifact_lifecycle_current',
    'artifact_lifecycle_revisions',
    ['artifact_id', 'fires_at', 'cp_n'],
  ],
  [
    'artifact_attempt_current',
    'artifact_attempt_revisions',
    ['artifact_id', 'event_type', 'idempotency_key'],
  ],
  ['source_time_current', 'source_time_revisions', ['artifact_id']],
] as const;

export const PROJECT_CAPTURE_OPERATION_SCHEMA = `
CREATE TABLE artifact_lifecycle_revisions (
  revision_id TEXT PRIMARY KEY,
${provenance}${bytes}
  fires_at TEXT NOT NULL CHECK (fires_at IN ('post-plan', 'post-plan-revision', 'checkpoint-open', 'checkpoint-close', 'pre-pr')),
  cp_n INTEGER NOT NULL CHECK (cp_n BETWEEN 0 AND 9007199254740991),
  triggered_at TEXT NOT NULL CHECK (length(triggered_at) > 0),
  execution_context_hash TEXT,
  UNIQUE (artifact_id, fires_at, cp_n, revision_id),
  CHECK (source_kind = 'historical' OR cp_n > 0 OR fires_at IN ('post-plan', 'pre-pr')),
  CHECK (fires_at IS json_extract(CAST(record_bytes AS TEXT), '$.fires_at')),
  CHECK (cp_n IS json_extract(CAST(record_bytes AS TEXT), '$.cp_n')),
  CHECK (triggered_at IS json_extract(CAST(record_bytes AS TEXT), '$.triggered_at')),
  CHECK (execution_context_hash IS json_extract(CAST(record_bytes AS TEXT), '$.execution_context_hash')),
${references}
) STRICT;
CREATE TABLE artifact_attempt_revisions (
  revision_id TEXT PRIMARY KEY,
${provenance}
  record_bytes BLOB,
  record_hash TEXT,
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  outcome TEXT CHECK (outcome IN ('soft_blocked', 'hard_rejected')),
  payload_hash TEXT,
  evaluator_fingerprint TEXT,
  envelope TEXT,
  recorded_at TEXT CHECK (recorded_at IS NULL OR length(recorded_at) > 0),
  UNIQUE (artifact_id, event_type, idempotency_key, revision_id),
  CHECK ((action = 'clear' AND record_bytes IS NULL AND record_hash IS NULL AND outcome IS NULL
    AND payload_hash IS NULL AND evaluator_fingerprint IS NULL AND envelope IS NULL AND recorded_at IS NULL)
    OR (action = 'set' AND record_bytes IS NOT NULL AND record_hash IS NOT NULL AND outcome IS NOT NULL
    AND payload_hash IS NOT NULL AND recorded_at IS NOT NULL)),
  CHECK (record_bytes IS NULL OR json_valid(CAST(record_bytes AS TEXT))),
  CHECK (record_hash IS NULL OR (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK (payload_hash IS NULL OR (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK (action = 'clear' OR (
    artifact_id IS json_extract(CAST(record_bytes AS TEXT), '$.artifact_id') AND
    event_type IS json_extract(CAST(record_bytes AS TEXT), '$.event_type') AND
    idempotency_key IS json_extract(CAST(record_bytes AS TEXT), '$.idempotency_key') AND
    outcome IS json_extract(CAST(record_bytes AS TEXT), '$.outcome') AND
    payload_hash IS json_extract(CAST(record_bytes AS TEXT), '$.payload_hash') AND
    evaluator_fingerprint IS json_extract(CAST(record_bytes AS TEXT), '$.evaluator_fingerprint') AND
    envelope IS json_extract(CAST(record_bytes AS TEXT), '$.envelope') AND
    recorded_at IS json_extract(CAST(record_bytes AS TEXT), '$.recorded_at'))),
${references}
) STRICT;
CREATE TABLE plan_idempotency_records (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) > 0),
${provenance}${bytes}
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  CHECK (idempotency_key IS json_extract(CAST(record_bytes AS TEXT), '$.idempotency_key')),
  CHECK (artifact_id IS json_extract(CAST(record_bytes AS TEXT), '$.artifact_id')),
  CHECK (created_at IS json_extract(CAST(record_bytes AS TEXT), '$.created_at')),
${references}
) STRICT;
CREATE TABLE source_time_revisions (
  revision_id TEXT PRIMARY KEY,
${provenance}${bytes}
  source_count INTEGER NOT NULL CHECK (source_count BETWEEN 0 AND 9007199254740991),
  UNIQUE (artifact_id, revision_id),
  CHECK (artifact_id IS json_extract(CAST(record_bytes AS TEXT), '$.artifact_id')),
  CHECK (source_count IS json_array_length(CAST(record_bytes AS TEXT), '$.sources')),
${references}
) STRICT;
CREATE TABLE artifact_lifecycle_current (
  artifact_id TEXT NOT NULL,
  fires_at TEXT NOT NULL,
  cp_n INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (artifact_id, fires_at, cp_n),
  FOREIGN KEY (artifact_id, fires_at, cp_n, revision_id) REFERENCES artifact_lifecycle_revisions(artifact_id, fires_at, cp_n, revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE artifact_attempt_current (
  artifact_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (artifact_id, event_type, idempotency_key),
  FOREIGN KEY (artifact_id, event_type, idempotency_key, revision_id) REFERENCES artifact_attempt_revisions(artifact_id, event_type, idempotency_key, revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE source_time_current (
  artifact_id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY (artifact_id, revision_id) REFERENCES source_time_revisions(artifact_id, revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE source_time_sources (
  revision_id TEXT NOT NULL REFERENCES source_time_revisions(revision_id),
  source_id TEXT NOT NULL CHECK (length(source_id) > 0),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  evidence_time TEXT,
  evidence_time_basis TEXT NOT NULL CHECK (evidence_time_basis IN ('commit', 'commit_set_latest', 'unknown')),
  unknown_reason TEXT CHECK (unknown_reason IN ('missing', 'invalid', 'identity_mismatch', 'incomplete')),
  PRIMARY KEY (revision_id, source_id),
  CHECK (source_id IS json_extract(source_json, '$.source_id')),
  CHECK ((evidence_time_basis = 'unknown' AND evidence_time IS NULL AND unknown_reason IS NOT NULL) OR
    (evidence_time_basis <> 'unknown' AND evidence_time IS NOT NULL AND unknown_reason IS NULL))
) STRICT;
${retainedTables
  .map(
    ([table, collision]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision}) BEGIN
  SELECT RAISE(ABORT, 'Capture operational history is immutable');
END;
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Capture operational history is immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Capture operational history is retained');
END;
`
  )
  .join('')}
${selections
  .map(
    ([table, _records, keys]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN NEW.version <> 1 OR EXISTS (SELECT 1 FROM ${table} WHERE ${keys.map((key) => `${key} = NEW.${key}`).join(' AND ')}) BEGIN
  SELECT RAISE(ABORT, 'Capture operational selection requires an exact version update');
END;
CREATE TRIGGER ${table}_version BEFORE UPDATE ON ${table}
WHEN ${keys.map((key) => `NEW.${key} <> OLD.${key}`).join(' OR ')} OR NEW.version <> OLD.version + 1 OR NEW.revision_id = OLD.revision_id BEGIN
  SELECT RAISE(ABORT, 'Capture operational selection requires a new revision and next version');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Capture operational selection is retained');
END;
`
  )
  .join('')}
CREATE TRIGGER artifact_attempt_clear_requires_selection BEFORE INSERT ON artifact_attempt_revisions
WHEN NEW.action = 'clear' AND NOT EXISTS (
  SELECT 1 FROM artifact_attempt_current WHERE artifact_id = NEW.artifact_id AND event_type = NEW.event_type AND idempotency_key = NEW.idempotency_key
) BEGIN
  SELECT RAISE(ABORT, 'Attempt clear requires its original selected slot');
END;
`;
