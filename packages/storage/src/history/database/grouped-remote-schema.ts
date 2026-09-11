import { ARTIFACT_PUSH_METHODS } from './artifact-push-input.js';
import { REMOTE_TRANSPORT_METHODS } from './remote-transport-input.js';

export const PROJECT_GROUPED_REMOTE_TRANSPORT_SCHEMA = `
CREATE TABLE remote_requests (
  request_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  owner_kind TEXT NOT NULL DEFAULT 'standalone' CHECK (owner_kind IN ('standalone', 'artifact_push')),
  push_id TEXT REFERENCES artifact_push_requests(push_id) DEFERRABLE INITIALLY DEFERRED,
  call_ordinal INTEGER CHECK (call_ordinal BETWEEN 1 AND 9007199254740991),
  server_url TEXT NOT NULL CHECK (length(server_url) > 0),
  org_id TEXT NOT NULL CHECK (length(org_id) > 0),
  account_id TEXT NOT NULL CHECK (length(account_id) > 0),
  artifact_id TEXT,
  artifact_scope TEXT NOT NULL CHECK (artifact_scope = coalesce(artifact_id, '')),
  method TEXT NOT NULL CHECK (method IN (${REMOTE_TRANSPORT_METHODS.map((method) => `'${method}'`).join(', ')})),
  target_external_id TEXT NOT NULL CHECK (length(target_external_id) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  payload_bytes BLOB NOT NULL CHECK (json_valid(CAST(payload_bytes AS TEXT))),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_key TEXT NOT NULL CHECK (length(request_key) = 74 AND substr(request_key, 1, 10) = 'operation:' AND substr(request_key, 11) NOT GLOB '*[^0-9a-f]*'),
  prepared_at TEXT NOT NULL CHECK (length(prepared_at) > 0),
  CHECK ((owner_kind = 'standalone' AND push_id IS NULL AND call_ordinal IS NULL) OR
    (owner_kind = 'artifact_push' AND push_id IS NOT NULL AND call_ordinal IS NOT NULL)),
  UNIQUE (push_id, call_ordinal),
  UNIQUE (push_id, call_ordinal, request_id),
  UNIQUE (server_url, org_id, account_id, artifact_scope, method, target_external_id, idempotency_key, request_key),
  UNIQUE (server_url, org_id, account_id, artifact_scope, method, target_external_id, idempotency_key, request_id)
) STRICT;
CREATE UNIQUE INDEX remote_requests_standalone_operation ON remote_requests(operation_id) WHERE owner_kind = 'standalone';
CREATE TRIGGER remote_requests_group_owner BEFORE INSERT ON remote_requests
WHEN NEW.owner_kind = 'artifact_push' AND NOT EXISTS (SELECT 1 FROM artifact_push_requests p WHERE
  p.push_id = NEW.push_id AND p.admission_operation_id = NEW.operation_id AND p.server_url = NEW.server_url AND
  p.org_id = NEW.org_id AND p.account_id = NEW.account_id AND p.artifact_id = NEW.artifact_id AND
  p.prepared_at = NEW.prepared_at AND NEW.idempotency_key = p.push_id AND NEW.call_ordinal <= p.call_count AND
  NEW.method IN (${ARTIFACT_PUSH_METHODS.map((method) => `'${method}'`).join(', ')}) AND
  ((NEW.call_ordinal = 1 AND NEW.method = 'captureThread.start') OR
   (NEW.call_ordinal = 2 AND NEW.method IN ('captureThread.attachPlan', 'captureThread.attachPlanRevision')) OR
   (NEW.call_ordinal > 2 AND NEW.method NOT IN ('captureThread.start', 'captureThread.attachPlan', 'captureThread.attachPlanRevision'))))
BEGIN SELECT RAISE(ABORT, 'remote group member must retain its original push scope and order'); END;
CREATE TRIGGER remote_requests_standalone_owner BEFORE INSERT ON remote_requests
WHEN NEW.owner_kind = 'standalone' AND EXISTS (SELECT 1 FROM artifact_push_requests p WHERE
  NEW.operation_id IN (p.admission_operation_id, p.terminal_operation_id))
BEGIN SELECT RAISE(ABORT, 'standalone request cannot consume an original push operation'); END;
CREATE TRIGGER remote_requests_no_replace BEFORE INSERT ON remote_requests
WHEN EXISTS (SELECT 1 FROM remote_requests WHERE request_id = NEW.request_id OR
  (owner_kind = 'standalone' AND NEW.owner_kind = 'standalone' AND operation_id = NEW.operation_id) OR
  (push_id = NEW.push_id AND call_ordinal = NEW.call_ordinal) OR
  (server_url = NEW.server_url AND org_id = NEW.org_id AND account_id = NEW.account_id AND artifact_scope = NEW.artifact_scope AND method = NEW.method AND target_external_id = NEW.target_external_id AND idempotency_key = NEW.idempotency_key AND request_key = NEW.request_key)) BEGIN
  SELECT RAISE(ABORT, 'Remote requests are immutable');
END;
CREATE TRIGGER remote_requests_no_update BEFORE UPDATE ON remote_requests BEGIN
  SELECT RAISE(ABORT, 'Remote requests are immutable');
END;
CREATE TRIGGER remote_requests_no_delete BEFORE DELETE ON remote_requests BEGIN
  SELECT RAISE(ABORT, 'Remote requests are retained');
END;
CREATE TABLE remote_attempts (
  attempt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES remote_requests(request_id) DEFERRABLE INITIALLY DEFERRED,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  attempted_at TEXT NOT NULL CHECK (length(attempted_at) > 0),
  UNIQUE (request_id, attempt_id)
) STRICT;
CREATE TRIGGER remote_attempts_no_replace BEFORE INSERT ON remote_attempts
WHEN EXISTS (SELECT 1 FROM remote_attempts WHERE attempt_id = NEW.attempt_id OR request_id = NEW.request_id OR operation_id = NEW.operation_id) BEGIN
  SELECT RAISE(ABORT, 'A remote request retains one send admission');
END;
CREATE TRIGGER remote_attempts_no_update BEFORE UPDATE ON remote_attempts BEGIN
  SELECT RAISE(ABORT, 'Remote attempts are immutable');
END;
CREATE TRIGGER remote_attempts_no_delete BEFORE DELETE ON remote_attempts BEGIN
  SELECT RAISE(ABORT, 'Remote attempts are retained');
END;
CREATE TABLE remote_outcomes (
  outcome_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  outcome_n INTEGER NOT NULL CHECK (outcome_n BETWEEN 1 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('ack_unknown', 'acknowledged')),
  observed_at TEXT NOT NULL CHECK (length(observed_at) > 0),
  response_bytes BLOB,
  response_sha256 TEXT,
  failure_kind TEXT,
  failure_message TEXT,
  CHECK ((kind = 'acknowledged' AND response_bytes IS NOT NULL AND response_sha256 IS NOT NULL AND json_valid(CAST(response_bytes AS TEXT)) AND length(response_sha256) = 64 AND response_sha256 NOT GLOB '*[^0-9a-f]*' AND failure_kind IS NULL AND failure_message IS NULL)
    OR (kind = 'ack_unknown' AND response_bytes IS NULL AND response_sha256 IS NULL AND ((failure_kind IS NULL AND failure_message IS NULL) OR (failure_kind IS NOT NULL AND failure_kind = 'unknown' AND failure_message IS NOT NULL)))),
  UNIQUE (request_id, outcome_n),
  UNIQUE (request_id, attempt_id, outcome_id),
  FOREIGN KEY (request_id, attempt_id) REFERENCES remote_attempts(request_id, attempt_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE UNIQUE INDEX remote_outcomes_acknowledged ON remote_outcomes(request_id) WHERE kind = 'acknowledged';
CREATE TRIGGER remote_outcomes_no_replace BEFORE INSERT ON remote_outcomes
WHEN EXISTS (SELECT 1 FROM remote_outcomes WHERE outcome_id = NEW.outcome_id OR operation_id = NEW.operation_id OR
  (request_id = NEW.request_id AND (outcome_n = NEW.outcome_n OR kind = 'acknowledged'))) BEGIN
  SELECT RAISE(ABORT, 'Remote observations and acknowledgments are immutable');
END;
CREATE TRIGGER remote_outcomes_order BEFORE INSERT ON remote_outcomes
WHEN NEW.outcome_n <> coalesce((SELECT max(outcome_n) + 1 FROM remote_outcomes WHERE request_id = NEW.request_id), 1) BEGIN
  SELECT RAISE(ABORT, 'Remote observations require the next retained position');
END;
CREATE TRIGGER remote_outcomes_no_update BEFORE UPDATE ON remote_outcomes BEGIN
  SELECT RAISE(ABORT, 'Remote observations are immutable');
END;
CREATE TRIGGER remote_outcomes_no_delete BEFORE DELETE ON remote_outcomes BEGIN
  SELECT RAISE(ABORT, 'Remote observations are retained');
END;
CREATE TABLE remote_current (
  server_url TEXT NOT NULL,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  artifact_scope TEXT NOT NULL,
  method TEXT NOT NULL,
  target_external_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_id TEXT,
  outcome_id TEXT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  CHECK (outcome_id IS NULL OR attempt_id IS NOT NULL),
  PRIMARY KEY (server_url, org_id, account_id, artifact_scope, method, target_external_id, idempotency_key),
  FOREIGN KEY (server_url, org_id, account_id, artifact_scope, method, target_external_id, idempotency_key, request_id) REFERENCES remote_requests(server_url, org_id, account_id, artifact_scope, method, target_external_id, idempotency_key, request_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (request_id, attempt_id) REFERENCES remote_attempts(request_id, attempt_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (request_id, attempt_id, outcome_id) REFERENCES remote_outcomes(request_id, attempt_id, outcome_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER remote_current_no_replace BEFORE INSERT ON remote_current
WHEN EXISTS (SELECT 1 FROM remote_current WHERE server_url = NEW.server_url AND org_id = NEW.org_id AND account_id = NEW.account_id AND artifact_scope = NEW.artifact_scope AND method = NEW.method AND target_external_id = NEW.target_external_id AND idempotency_key = NEW.idempotency_key) BEGIN
  SELECT RAISE(ABORT, 'Remote selection requires an exact version update');
END;
CREATE TRIGGER remote_current_initial BEFORE INSERT ON remote_current
WHEN NEW.version <> 1 OR NEW.attempt_id IS NOT NULL OR NEW.outcome_id IS NOT NULL OR EXISTS (SELECT 1 FROM remote_attempts WHERE request_id = NEW.request_id) BEGIN
  SELECT RAISE(ABORT, 'Remote selection begins with a prepared request');
END;
CREATE TRIGGER remote_current_transition BEFORE UPDATE ON remote_current
WHEN NEW.server_url <> OLD.server_url OR NEW.org_id <> OLD.org_id OR NEW.account_id <> OLD.account_id OR NEW.artifact_scope <> OLD.artifact_scope OR NEW.method <> OLD.method OR NEW.target_external_id <> OLD.target_external_id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.version <> OLD.version + 1 OR
  (NEW.request_id = OLD.request_id AND (
    (NEW.attempt_id IS OLD.attempt_id AND NEW.outcome_id IS OLD.outcome_id) OR
    (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id) OR
    (OLD.outcome_id IS NOT NULL AND (NEW.outcome_id IS NULL OR
      (SELECT kind FROM remote_outcomes WHERE outcome_id = OLD.outcome_id) = 'acknowledged' OR
      (SELECT outcome_n FROM remote_outcomes WHERE outcome_id = NEW.outcome_id) <= (SELECT outcome_n FROM remote_outcomes WHERE outcome_id = OLD.outcome_id))))) OR
  (NEW.request_id <> OLD.request_id AND (NEW.attempt_id IS NOT NULL OR NEW.outcome_id IS NOT NULL OR EXISTS (SELECT 1 FROM remote_attempts WHERE request_id = NEW.request_id) OR
    coalesce((SELECT kind FROM remote_outcomes WHERE outcome_id = OLD.outcome_id), '') <> 'acknowledged')) BEGIN
  SELECT RAISE(ABORT, 'Remote selection requires the next valid state and version');
END;
CREATE TRIGGER remote_current_no_delete BEFORE DELETE ON remote_current BEGIN
  SELECT RAISE(ABORT, 'Remote selection is retained');
END;
`;
