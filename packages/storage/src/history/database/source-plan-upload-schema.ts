export const PROJECT_SOURCE_PLAN_UPLOAD_SCHEMA = `
CREATE TABLE source_plan_upload_commands (
  command_id TEXT PRIMARY KEY,
  admission_operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  terminal_operation_id TEXT NOT NULL UNIQUE,
  request_operation_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  locator_operation_id TEXT NOT NULL UNIQUE,
  locator_revision_id TEXT NOT NULL UNIQUE,
  namespace_id TEXT NOT NULL REFERENCES source_plan_namespaces(namespace_id) DEFERRABLE INITIALLY DEFERRED,
  server_url TEXT NOT NULL CHECK (length(server_url) > 0),
  org_id TEXT NOT NULL CHECK (length(org_id) > 0),
  account_id TEXT NOT NULL CHECK (length(account_id) > 0),
  real_path TEXT NOT NULL CHECK (length(real_path) > 0),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  external_id TEXT NOT NULL CHECK (length(external_id) > 0),
  expected_locator_revision_id TEXT REFERENCES source_plan_locator_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED,
  expected_locator_version INTEGER CHECK (expected_locator_version BETWEEN 1 AND 9007199254740991),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  prepared_at TEXT NOT NULL CHECK (length(prepared_at) > 0),
  CHECK ((expected_locator_revision_id IS NULL) = (expected_locator_version IS NULL)),
  CHECK (command_id != admission_operation_id AND command_id != terminal_operation_id AND
    command_id != request_operation_id AND command_id != request_id AND
    command_id != locator_operation_id AND command_id != locator_revision_id),
  CHECK (admission_operation_id != terminal_operation_id AND
    admission_operation_id != request_operation_id AND admission_operation_id != request_id AND
    admission_operation_id != locator_operation_id AND admission_operation_id != locator_revision_id),
  CHECK (terminal_operation_id != request_operation_id AND terminal_operation_id != request_id AND
    terminal_operation_id != locator_operation_id AND terminal_operation_id != locator_revision_id),
  CHECK (request_operation_id != request_id AND request_operation_id != locator_operation_id AND
    request_operation_id != locator_revision_id),
  CHECK (request_id != locator_operation_id AND request_id != locator_revision_id),
  CHECK (locator_operation_id != locator_revision_id),
  UNIQUE (server_url, org_id, account_id, real_path, fingerprint),
  UNIQUE (command_id, terminal_operation_id),
  UNIQUE (command_id, request_id),
  UNIQUE (command_id, locator_revision_id)
) STRICT;
CREATE INDEX source_plan_upload_commands_path ON source_plan_upload_commands(
  server_url, org_id, account_id, real_path, prepared_at, command_id
);
CREATE TRIGGER source_plan_upload_commands_no_replace BEFORE INSERT ON source_plan_upload_commands
WHEN EXISTS (SELECT 1 FROM source_plan_upload_commands WHERE
  command_id=NEW.command_id OR admission_operation_id IN
    (NEW.admission_operation_id,NEW.terminal_operation_id,NEW.request_operation_id,NEW.locator_operation_id) OR
  terminal_operation_id IN
    (NEW.admission_operation_id,NEW.terminal_operation_id,NEW.request_operation_id,NEW.locator_operation_id) OR
  request_operation_id IN
    (NEW.admission_operation_id,NEW.terminal_operation_id,NEW.request_operation_id,NEW.locator_operation_id) OR
  locator_operation_id IN
    (NEW.admission_operation_id,NEW.terminal_operation_id,NEW.request_operation_id,NEW.locator_operation_id) OR
  request_id=NEW.request_id OR locator_revision_id=NEW.locator_revision_id OR
  (server_url=NEW.server_url AND org_id=NEW.org_id AND account_id=NEW.account_id AND
    real_path=NEW.real_path AND fingerprint=NEW.fingerprint))
BEGIN SELECT RAISE(ABORT, 'Source Plan upload identities and original input cannot be replaced'); END;
CREATE TRIGGER source_plan_upload_commands_existing_owner BEFORE INSERT ON source_plan_upload_commands
WHEN EXISTS (SELECT 1 FROM operations WHERE operation_id IN
    (NEW.admission_operation_id,NEW.terminal_operation_id,NEW.request_operation_id,NEW.locator_operation_id)) OR
  EXISTS (SELECT 1 FROM remote_requests WHERE request_id=NEW.request_id OR operation_id=NEW.request_operation_id) OR
  EXISTS (SELECT 1 FROM source_plan_locator_revisions WHERE revision_id=NEW.locator_revision_id OR
    publication_operation_id=NEW.locator_operation_id)
BEGIN SELECT RAISE(ABORT, 'Source Plan upload identity already belongs to retained history'); END;
CREATE TRIGGER source_plan_upload_commands_no_update BEFORE UPDATE ON source_plan_upload_commands
BEGIN SELECT RAISE(ABORT, 'Source Plan upload inputs are immutable'); END;
CREATE TRIGGER source_plan_upload_commands_no_delete BEFORE DELETE ON source_plan_upload_commands
BEGIN SELECT RAISE(ABORT, 'Source Plan upload inputs are retained'); END;

CREATE TRIGGER operations_source_plan_upload_owner BEFORE INSERT ON operations
WHEN EXISTS (SELECT 1 FROM source_plan_upload_commands c WHERE
  NEW.operation_id IN (c.admission_operation_id,c.terminal_operation_id,c.request_operation_id,c.locator_operation_id) AND
  ((NEW.operation_id=c.admission_operation_id AND NEW.operation_kind!='source_plan.upload.begin') OR
   (NEW.operation_id=c.terminal_operation_id AND NEW.operation_kind!='source_plan.upload.complete') OR
   (NEW.operation_id=c.request_operation_id AND NEW.operation_kind!='remote.request') OR
   (NEW.operation_id=c.locator_operation_id AND NEW.operation_kind!='source_plan.locator')))
BEGIN SELECT RAISE(ABORT, 'Source Plan upload child operation belongs to its original command'); END;

CREATE TRIGGER remote_requests_source_plan_upload_owner BEFORE INSERT ON remote_requests
WHEN EXISTS (SELECT 1 FROM source_plan_upload_commands c WHERE
  (c.request_operation_id=NEW.operation_id OR c.request_id=NEW.request_id) AND
  (NEW.operation_id!=c.request_operation_id OR NEW.owner_kind!='standalone' OR
   NEW.request_id!=c.request_id OR NEW.push_id IS NOT NULL OR
   NEW.call_ordinal IS NOT NULL OR NEW.server_url!=c.server_url OR NEW.org_id!=c.org_id OR
   NEW.account_id!=c.account_id OR NEW.artifact_id IS NOT NULL OR NEW.artifact_scope!='' OR
   NEW.method!='sourcePlan.create' OR NEW.target_external_id!=c.external_id OR
   NEW.idempotency_key!=c.command_id OR NEW.payload_sha256!=c.payload_sha256 OR
   NEW.prepared_at!=c.prepared_at))
BEGIN SELECT RAISE(ABORT, 'Remote request must match its original Source Plan upload command'); END;

CREATE TRIGGER source_plan_locator_source_plan_upload_owner BEFORE INSERT ON source_plan_locator_revisions
WHEN EXISTS (SELECT 1 FROM source_plan_upload_commands c WHERE
  (c.locator_operation_id=NEW.publication_operation_id OR c.locator_revision_id=NEW.revision_id) AND
  (NEW.publication_operation_id!=c.locator_operation_id OR
   NEW.revision_id!=c.locator_revision_id OR NEW.namespace_id!=c.namespace_id OR NEW.kind!='upload' OR
   NEW.real_path!=c.real_path OR NEW.fingerprint!=c.fingerprint OR NEW.external_id!=c.external_id OR
   NEW.approved_record_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'Upload locator must match its original Source Plan upload command'); END;
`;
