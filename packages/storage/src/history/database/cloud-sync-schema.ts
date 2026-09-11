export const PROJECT_CLOUD_SYNC_SCHEMA = `
CREATE TABLE cloud_sync_records (
  revision_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL CHECK (kind IN ('acknowledgement', 'failure')),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) DEFERRABLE INITIALLY DEFERRED,
  server_url TEXT NOT NULL CHECK (length(server_url) > 0),
  org_id TEXT NOT NULL CHECK (length(org_id) > 0),
  account_id TEXT NOT NULL CHECK (length(account_id) > 0),
  previous_revision_id TEXT,
  previous_version INTEGER CHECK (previous_version BETWEEN 1 AND 9007199254740991),
  applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
  push_id TEXT UNIQUE REFERENCES artifact_push_requests(push_id) DEFERRABLE INITIALLY DEFERRED,
  artifact_generation INTEGER CHECK (artifact_generation BETWEEN 1 AND 9007199254740991),
  usage_generation INTEGER REFERENCES usage_revisions(generation) DEFERRABLE INITIALLY DEFERRED
    CHECK (usage_generation BETWEEN 1 AND 9007199254740991),
  acknowledged_at TEXT CHECK (length(acknowledged_at) > 0),
  failure_kind TEXT CHECK (failure_kind IN ('timeout', 'http-4xx', 'http-5xx', 'network',
    'wire-invalid', 'content-invalid', 'upgrade-required', 'server-behind', 'unknown')),
  failure_message TEXT,
  attempted_at TEXT CHECK (length(attempted_at) > 0),
  attempt_started_at TEXT CHECK (length(attempt_started_at) > 0),
  record_sha256 TEXT NOT NULL CHECK (length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^a-f0-9]*'),
  CHECK ((previous_revision_id IS NULL) = (previous_version IS NULL)),
  CHECK ((kind = 'acknowledgement' AND push_id IS NOT NULL AND artifact_generation IS NOT NULL AND
    acknowledged_at IS NOT NULL AND failure_kind IS NULL AND failure_message IS NULL AND
    attempted_at IS NULL AND attempt_started_at IS NULL) OR
    (kind = 'failure' AND push_id IS NULL AND artifact_generation IS NULL AND usage_generation IS NULL AND
    acknowledged_at IS NULL AND failure_kind IS NOT NULL AND attempted_at IS NOT NULL AND attempt_started_at IS NOT NULL)),
  UNIQUE (artifact_id, server_url, org_id, account_id, revision_id),
  FOREIGN KEY (artifact_id, artifact_generation) REFERENCES artifact_revisions(artifact_id, generation)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (artifact_id, server_url, org_id, account_id, previous_revision_id)
    REFERENCES cloud_sync_records(artifact_id, server_url, org_id, account_id, revision_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX cloud_sync_records_scope ON cloud_sync_records(artifact_id, server_url, org_id, account_id);
CREATE TRIGGER cloud_sync_records_predecessor BEFORE INSERT ON cloud_sync_records
WHEN NEW.previous_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cloud_sync_records p WHERE
  p.revision_id = NEW.previous_revision_id AND p.artifact_id = NEW.artifact_id AND
  p.server_url = NEW.server_url AND p.org_id = NEW.org_id AND p.account_id = NEW.account_id AND
  p.applied = 1 AND coalesce(p.previous_version, 0) + 1 = NEW.previous_version)
BEGIN SELECT RAISE(ABORT, 'cloud record must retain its exact selected predecessor'); END;
CREATE TRIGGER cloud_sync_records_acknowledgement_owner BEFORE INSERT ON cloud_sync_records
WHEN NEW.kind = 'acknowledgement' AND NOT EXISTS (SELECT 1 FROM artifact_push_requests p WHERE
  p.push_id = NEW.push_id AND p.terminal_operation_id = NEW.operation_id AND
  p.cloud_acknowledgement_id = NEW.revision_id AND p.artifact_id = NEW.artifact_id AND
  p.server_url = NEW.server_url AND p.org_id = NEW.org_id AND p.account_id = NEW.account_id AND
  p.artifact_generation = NEW.artifact_generation AND p.usage_generation IS NEW.usage_generation AND
  p.expected_cloud_revision_id IS NEW.previous_revision_id AND p.expected_cloud_version IS NEW.previous_version)
BEGIN SELECT RAISE(ABORT, 'cloud acknowledgement must retain its original push target'); END;
CREATE TRIGGER cloud_sync_records_no_replace BEFORE INSERT ON cloud_sync_records
WHEN EXISTS (SELECT 1 FROM cloud_sync_records WHERE revision_id = NEW.revision_id OR
  operation_id = NEW.operation_id OR push_id = NEW.push_id)
BEGIN SELECT RAISE(ABORT, 'cloud records cannot be replaced'); END;
CREATE TRIGGER cloud_sync_records_no_update BEFORE UPDATE ON cloud_sync_records
BEGIN SELECT RAISE(ABORT, 'cloud records are immutable'); END;
CREATE TRIGGER cloud_sync_records_no_delete BEFORE DELETE ON cloud_sync_records
BEGIN SELECT RAISE(ABORT, 'cloud records are retained'); END;

CREATE TABLE cloud_sync_current (
  artifact_id TEXT NOT NULL,
  server_url TEXT NOT NULL,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (artifact_id, server_url, org_id, account_id),
  FOREIGN KEY (artifact_id, server_url, org_id, account_id, revision_id)
    REFERENCES cloud_sync_records(artifact_id, server_url, org_id, account_id, revision_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER cloud_sync_current_initial BEFORE INSERT ON cloud_sync_current
WHEN NEW.version != 1 OR EXISTS (SELECT 1 FROM cloud_sync_current WHERE
  artifact_id = NEW.artifact_id AND server_url = NEW.server_url AND org_id = NEW.org_id AND account_id = NEW.account_id) OR
  NOT EXISTS (SELECT 1 FROM cloud_sync_records r WHERE r.revision_id = NEW.revision_id AND
    r.applied = 1 AND r.previous_revision_id IS NULL AND r.previous_version IS NULL)
BEGIN SELECT RAISE(ABORT, 'cloud selection must start with an applied original record'); END;
CREATE TRIGGER cloud_sync_current_advance BEFORE UPDATE ON cloud_sync_current
WHEN NEW.artifact_id != OLD.artifact_id OR NEW.server_url != OLD.server_url OR NEW.org_id != OLD.org_id OR
  NEW.account_id != OLD.account_id OR NEW.version != OLD.version + 1 OR
  NOT EXISTS (SELECT 1 FROM cloud_sync_records r WHERE r.revision_id = NEW.revision_id AND r.applied = 1 AND
    r.previous_revision_id = OLD.revision_id AND r.previous_version = OLD.version)
BEGIN SELECT RAISE(ABORT, 'cloud selection must advance through its original applied chain'); END;
CREATE TRIGGER cloud_sync_current_no_delete BEFORE DELETE ON cloud_sync_current
BEGIN SELECT RAISE(ABORT, 'cloud selection is retained'); END;
`;
