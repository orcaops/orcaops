export const PROJECT_ARTIFACT_PUSH_SCHEMA = `
CREATE TABLE artifact_push_requests (
  push_id TEXT PRIMARY KEY NOT NULL,
  admission_operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  terminal_operation_id TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) DEFERRABLE INITIALLY DEFERRED,
  server_url TEXT NOT NULL CHECK (length(server_url) > 0),
  org_id TEXT NOT NULL CHECK (length(org_id) > 0),
  account_id TEXT NOT NULL CHECK (length(account_id) > 0),
  artifact_generation INTEGER NOT NULL CHECK (artifact_generation BETWEEN 1 AND 9007199254740991),
  usage_generation INTEGER REFERENCES usage_revisions(generation) DEFERRABLE INITIALLY DEFERRED
    CHECK (usage_generation BETWEEN 1 AND 9007199254740991),
  previous_push_id TEXT,
  previous_push_version INTEGER CHECK (previous_push_version BETWEEN 1 AND 9007199254740991),
  expected_cloud_revision_id TEXT,
  expected_cloud_version INTEGER CHECK (expected_cloud_version BETWEEN 1 AND 9007199254740991),
  session_repo_url TEXT,
  session_working_dir TEXT,
  session_revision_id TEXT,
  session_version INTEGER CHECK (session_version BETWEEN 1 AND 9007199254740991),
  session_acknowledgement_id TEXT UNIQUE,
  session_result_revision_id TEXT UNIQUE,
  cloud_acknowledgement_id TEXT NOT NULL UNIQUE,
  prepared_at TEXT NOT NULL CHECK (length(prepared_at) > 0),
  result_checkpoints INTEGER NOT NULL CHECK (result_checkpoints BETWEEN 0 AND 9007199254740991),
  result_summary INTEGER NOT NULL CHECK (result_summary IN (0,1)),
  result_evaluators INTEGER NOT NULL CHECK (result_evaluators BETWEEN 0 AND 9007199254740991),
  result_source_plan_pinned TEXT CHECK (result_source_plan_pinned IN ('A','B')),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  call_count INTEGER NOT NULL CHECK (call_count BETWEEN 2 AND 9007199254740991),
  artifact_payload_hash TEXT NOT NULL CHECK (length(artifact_payload_hash) = 64 AND artifact_payload_hash NOT GLOB '*[^a-f0-9]*'),
  CHECK (admission_operation_id != terminal_operation_id),
  CHECK ((previous_push_id IS NULL) = (previous_push_version IS NULL)),
  CHECK ((expected_cloud_revision_id IS NULL) = (expected_cloud_version IS NULL)),
  CHECK ((session_repo_url IS NULL AND session_working_dir IS NULL AND session_revision_id IS NULL AND
    session_version IS NULL AND session_acknowledgement_id IS NULL AND session_result_revision_id IS NULL) OR
    (session_repo_url IS NOT NULL AND length(session_repo_url) > 0 AND session_working_dir IS NOT NULL AND
    length(session_working_dir) > 0 AND session_revision_id IS NOT NULL AND session_version IS NOT NULL AND
    session_acknowledgement_id IS NOT NULL AND session_result_revision_id IS NOT NULL)),
  UNIQUE (artifact_id, server_url, org_id, account_id, push_id),
  UNIQUE (push_id, terminal_operation_id),
  FOREIGN KEY (artifact_id, artifact_generation) REFERENCES artifact_revisions(artifact_id, generation)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (artifact_id, server_url, org_id, account_id, previous_push_id)
    REFERENCES artifact_push_requests(artifact_id, server_url, org_id, account_id, push_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (artifact_id, server_url, org_id, account_id, expected_cloud_revision_id)
    REFERENCES cloud_sync_records(artifact_id, server_url, org_id, account_id, revision_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (server_url, org_id, account_id, session_repo_url, session_working_dir, session_revision_id)
    REFERENCES session_branch_revisions(target_server_url, target_org_id, target_account_id, repo_url, working_dir, revision_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX artifact_push_requests_scope ON artifact_push_requests(artifact_id, server_url, org_id, account_id);
CREATE TRIGGER artifact_push_requests_cloud_target BEFORE INSERT ON artifact_push_requests
WHEN NEW.expected_cloud_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cloud_sync_records c WHERE
  c.revision_id = NEW.expected_cloud_revision_id AND c.applied = 1 AND
  coalesce(c.previous_version, 0) + 1 = NEW.expected_cloud_version)
BEGIN SELECT RAISE(ABORT, 'push must retain the original cloud selection version'); END;
CREATE TRIGGER artifact_push_requests_predecessor BEFORE INSERT ON artifact_push_requests
WHEN NEW.previous_push_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artifact_push_requests p
  JOIN artifact_push_terminals t ON t.push_id = p.push_id WHERE p.push_id = NEW.previous_push_id AND
  p.artifact_id = NEW.artifact_id AND p.server_url = NEW.server_url AND p.org_id = NEW.org_id AND
  p.account_id = NEW.account_id AND coalesce(p.previous_push_version, 0) + 1 = NEW.previous_push_version)
BEGIN SELECT RAISE(ABORT, 'push must retain its completed predecessor'); END;
CREATE TRIGGER artifact_push_requests_no_replace BEFORE INSERT ON artifact_push_requests
WHEN EXISTS (SELECT 1 FROM artifact_push_requests WHERE push_id = NEW.push_id OR
  admission_operation_id IN (NEW.admission_operation_id, NEW.terminal_operation_id) OR
  terminal_operation_id IN (NEW.admission_operation_id, NEW.terminal_operation_id) OR
  session_acknowledgement_id = NEW.session_acknowledgement_id OR session_result_revision_id = NEW.session_result_revision_id OR
  cloud_acknowledgement_id = NEW.cloud_acknowledgement_id)
BEGIN SELECT RAISE(ABORT, 'push inputs and original identities cannot be replaced'); END;
CREATE TRIGGER artifact_push_requests_existing_owner BEFORE INSERT ON artifact_push_requests
WHEN EXISTS (SELECT 1 FROM operations WHERE operation_id IN (NEW.admission_operation_id, NEW.terminal_operation_id)) OR
  EXISTS (SELECT 1 FROM git_retention_operations WHERE original_operation_id IN (NEW.admission_operation_id, NEW.terminal_operation_id)) OR
  EXISTS (SELECT 1 FROM operations WHERE operation_kind = 'git.retention.cleanup.begin' AND
    json_extract(payload_json, '$.terminalOperationId') IN (NEW.admission_operation_id, NEW.terminal_operation_id)) OR
  EXISTS (SELECT 1 FROM session_branch_acknowledgements WHERE acknowledgement_id = NEW.session_acknowledgement_id) OR
  EXISTS (SELECT 1 FROM session_branch_revisions WHERE revision_id = NEW.session_result_revision_id) OR
  EXISTS (SELECT 1 FROM cloud_sync_records WHERE revision_id = NEW.cloud_acknowledgement_id)
BEGIN SELECT RAISE(ABORT, 'push identity already belongs to retained original history'); END;
CREATE TRIGGER artifact_push_requests_no_update BEFORE UPDATE ON artifact_push_requests
BEGIN SELECT RAISE(ABORT, 'push inputs are immutable'); END;
CREATE TRIGGER artifact_push_requests_no_delete BEFORE DELETE ON artifact_push_requests
BEGIN SELECT RAISE(ABORT, 'push inputs are retained'); END;

CREATE TABLE artifact_push_current (
  artifact_id TEXT NOT NULL,
  server_url TEXT NOT NULL,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  push_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (artifact_id, server_url, org_id, account_id),
  FOREIGN KEY (artifact_id, server_url, org_id, account_id, push_id)
    REFERENCES artifact_push_requests(artifact_id, server_url, org_id, account_id, push_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER artifact_push_current_initial BEFORE INSERT ON artifact_push_current
WHEN NEW.version != 1 OR EXISTS (SELECT 1 FROM artifact_push_current WHERE
  artifact_id = NEW.artifact_id AND server_url = NEW.server_url AND org_id = NEW.org_id AND account_id = NEW.account_id) OR
  NOT EXISTS (SELECT 1 FROM artifact_push_requests p WHERE p.push_id = NEW.push_id AND p.previous_push_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'push selection must start once'); END;
CREATE TRIGGER artifact_push_current_advance BEFORE UPDATE ON artifact_push_current
WHEN NEW.artifact_id != OLD.artifact_id OR NEW.server_url != OLD.server_url OR NEW.org_id != OLD.org_id OR
  NEW.account_id != OLD.account_id OR NEW.version != OLD.version + 1 OR
  NOT EXISTS (SELECT 1 FROM artifact_push_requests p JOIN artifact_push_terminals t ON t.push_id = OLD.push_id
    WHERE p.push_id = NEW.push_id AND p.previous_push_id = OLD.push_id AND p.previous_push_version = OLD.version)
BEGIN SELECT RAISE(ABORT, 'push selection must advance from its completed original request'); END;
CREATE TRIGGER artifact_push_current_no_delete BEFORE DELETE ON artifact_push_current
BEGIN SELECT RAISE(ABORT, 'push selection is retained'); END;

CREATE TABLE artifact_push_terminals (
  push_id TEXT PRIMARY KEY NOT NULL REFERENCES artifact_push_requests(push_id) DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  acknowledged_at TEXT NOT NULL CHECK (length(acknowledged_at) > 0),
  session_applied INTEGER CHECK (session_applied IN (0,1)),
  cloud_applied INTEGER NOT NULL CHECK (cloud_applied IN (0,1)),
  outcome_count INTEGER NOT NULL CHECK (outcome_count BETWEEN 2 AND 9007199254740991),
  FOREIGN KEY (push_id, operation_id) REFERENCES artifact_push_requests(push_id, terminal_operation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER artifact_push_terminals_owner BEFORE INSERT ON artifact_push_terminals
WHEN NOT EXISTS (SELECT 1 FROM artifact_push_requests p WHERE p.push_id = NEW.push_id AND
  p.terminal_operation_id = NEW.operation_id AND p.call_count = NEW.outcome_count AND
  (p.session_revision_id IS NULL) = (NEW.session_applied IS NULL)) OR
  NEW.outcome_count != (SELECT count(*) FROM artifact_push_terminal_calls WHERE push_id = NEW.push_id) OR
  NOT EXISTS (SELECT 1 FROM cloud_sync_records c JOIN artifact_push_requests p ON p.cloud_acknowledgement_id = c.revision_id
    WHERE p.push_id = NEW.push_id AND c.operation_id = NEW.operation_id AND c.kind = 'acknowledgement' AND
    c.acknowledged_at = NEW.acknowledged_at AND c.applied = NEW.cloud_applied) OR
  (NEW.session_applied IS NOT NULL AND NOT EXISTS (SELECT 1 FROM session_branch_acknowledgements s
    JOIN artifact_push_requests p ON p.session_acknowledgement_id = s.acknowledgement_id WHERE p.push_id = NEW.push_id AND
    s.operation_id = NEW.operation_id AND s.acked_at = NEW.acknowledged_at AND s.applied = NEW.session_applied))
BEGIN SELECT RAISE(ABORT, 'push terminal requires all original outcomes and local results'); END;
CREATE TRIGGER artifact_push_terminals_no_replace BEFORE INSERT ON artifact_push_terminals
WHEN EXISTS (SELECT 1 FROM artifact_push_terminals WHERE push_id = NEW.push_id OR operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'push terminal cannot be replaced'); END;
CREATE TRIGGER artifact_push_terminals_no_update BEFORE UPDATE ON artifact_push_terminals
BEGIN SELECT RAISE(ABORT, 'push terminal is immutable'); END;
CREATE TRIGGER artifact_push_terminals_no_delete BEFORE DELETE ON artifact_push_terminals
BEGIN SELECT RAISE(ABORT, 'push terminal is retained'); END;

CREATE TABLE artifact_push_terminal_calls (
  push_id TEXT NOT NULL REFERENCES artifact_push_terminals(push_id) DEFERRABLE INITIALLY DEFERRED,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  request_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL UNIQUE,
  outcome_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (push_id, ordinal),
  FOREIGN KEY (push_id, ordinal, request_id) REFERENCES remote_requests(push_id, call_ordinal, request_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (request_id, attempt_id, outcome_id) REFERENCES remote_outcomes(request_id, attempt_id, outcome_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER artifact_push_terminal_calls_outcome BEFORE INSERT ON artifact_push_terminal_calls
WHEN NOT EXISTS (SELECT 1 FROM remote_outcomes o JOIN remote_requests r ON r.request_id = o.request_id
  JOIN artifact_push_requests p ON p.push_id = r.push_id WHERE r.push_id = NEW.push_id AND
  r.owner_kind = 'artifact_push' AND r.call_ordinal = NEW.ordinal AND p.call_count >= NEW.ordinal AND
  o.request_id = NEW.request_id AND o.attempt_id = NEW.attempt_id AND o.outcome_id = NEW.outcome_id AND o.kind = 'acknowledged')
BEGIN SELECT RAISE(ABORT, 'push terminal call requires its original acknowledged outcome'); END;
CREATE TRIGGER artifact_push_terminal_calls_no_replace BEFORE INSERT ON artifact_push_terminal_calls
WHEN EXISTS (SELECT 1 FROM artifact_push_terminal_calls WHERE (push_id = NEW.push_id AND ordinal = NEW.ordinal) OR
  request_id = NEW.request_id OR attempt_id = NEW.attempt_id OR outcome_id = NEW.outcome_id)
BEGIN SELECT RAISE(ABORT, 'push terminal calls cannot be replaced'); END;
CREATE TRIGGER artifact_push_terminal_calls_no_update BEFORE UPDATE ON artifact_push_terminal_calls
BEGIN SELECT RAISE(ABORT, 'push terminal calls are immutable'); END;
CREATE TRIGGER artifact_push_terminal_calls_no_delete BEFORE DELETE ON artifact_push_terminal_calls
BEGIN SELECT RAISE(ABORT, 'push terminal calls are retained'); END;

CREATE TRIGGER operations_push_terminal_owner BEFORE INSERT ON operations
WHEN EXISTS (SELECT 1 FROM artifact_push_requests p WHERE p.terminal_operation_id = NEW.operation_id AND
  (NEW.operation_kind != 'artifact.push.complete' OR NOT EXISTS
    (SELECT 1 FROM artifact_push_terminals t WHERE t.push_id = p.push_id AND t.operation_id = NEW.operation_id)))
BEGIN SELECT RAISE(ABORT, 'operation identity belongs to its original artifact push'); END;
CREATE TRIGGER operations_push_cleanup_owner BEFORE INSERT ON operations
WHEN NEW.operation_kind = 'git.retention.cleanup.begin' AND EXISTS (SELECT 1 FROM artifact_push_requests p WHERE
  json_extract(NEW.payload_json, '$.terminalOperationId') IN (p.admission_operation_id, p.terminal_operation_id))
BEGIN SELECT RAISE(ABORT, 'cleanup terminal identity belongs to an original artifact push'); END;
CREATE TRIGGER git_retention_operations_push_owner BEFORE INSERT ON git_retention_operations
WHEN EXISTS (SELECT 1 FROM artifact_push_requests p WHERE NEW.original_operation_id IN (p.admission_operation_id, p.terminal_operation_id))
BEGIN SELECT RAISE(ABORT, 'Git terminal identity belongs to an original artifact push'); END;
`;
