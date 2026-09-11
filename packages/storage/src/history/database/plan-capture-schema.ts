export const PROJECT_PLAN_CAPTURE_SCHEMA = `
CREATE INDEX pending_capture_plan_membership ON pending_capture_events(event_id, original_operation_id)
WHERE event_type = 'plan_captured';
CREATE TABLE pending_plan_keys (
  event_id TEXT PRIMARY KEY REFERENCES pending_capture_events(event_id),
  original_operation_id TEXT NOT NULL REFERENCES pending_capture_requests(original_operation_id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0)
) STRICT;
CREATE INDEX pending_plan_key_lookup ON pending_plan_keys(idempotency_key, event_id, original_operation_id);
CREATE TRIGGER pending_plan_key_insert BEFORE INSERT ON pending_plan_keys BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pending_capture_events
    WHERE event_id = NEW.event_id AND original_operation_id = NEW.original_operation_id
      AND event_type = 'plan_captured')
    THEN RAISE(ABORT, 'Pending plan key must retain its exact original event owner') END;
END;
CREATE TRIGGER pending_plan_key_update BEFORE UPDATE ON pending_plan_keys BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pending_capture_events
    WHERE event_id = NEW.event_id AND original_operation_id = NEW.original_operation_id
      AND event_type = 'plan_captured')
    THEN RAISE(ABORT, 'Pending plan key must retain its exact original event owner') END;
END;
CREATE TABLE plan_capture_commands (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) > 0),
  original_operation_id TEXT NOT NULL UNIQUE,
  admission_operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  artifact_id TEXT NOT NULL UNIQUE,
  plan_event_id TEXT NOT NULL UNIQUE,
  request_bytes BLOB NOT NULL CHECK (json_valid(CAST(request_bytes AS TEXT))),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_type(CAST(request_bytes AS TEXT), '$.authored') IS 'object'),
  CHECK (idempotency_key IS json_extract(CAST(request_bytes AS TEXT), '$.authored.idempotency_key')),
  CHECK (json_type(CAST(request_bytes AS TEXT), '$.sourcePlan') IS 'object' OR json_type(CAST(request_bytes AS TEXT), '$.sourcePlan') IS 'null')
) STRICT;
CREATE TRIGGER plan_capture_commands_no_replace BEFORE INSERT ON plan_capture_commands
WHEN EXISTS (SELECT 1 FROM plan_capture_commands WHERE idempotency_key = NEW.idempotency_key
  OR original_operation_id IN (NEW.original_operation_id, NEW.admission_operation_id)
  OR admission_operation_id IN (NEW.original_operation_id, NEW.admission_operation_id)
  OR artifact_id = NEW.artifact_id OR plan_event_id = NEW.plan_event_id) BEGIN
  SELECT RAISE(ABORT, 'Original plan command input and identities are immutable');
END;
CREATE TRIGGER plan_capture_commands_no_update BEFORE UPDATE ON plan_capture_commands BEGIN
  SELECT RAISE(ABORT, 'Original plan command input is immutable');
END;
CREATE TRIGGER plan_capture_commands_no_delete BEFORE DELETE ON plan_capture_commands BEGIN
  SELECT RAISE(ABORT, 'Original plan command input is retained');
END;
CREATE TRIGGER plan_capture_commands_committed_key BEFORE INSERT ON plan_capture_commands
WHEN EXISTS (SELECT 1 FROM plan_idempotency_records WHERE idempotency_key = NEW.idempotency_key) BEGIN
  SELECT RAISE(ABORT, 'The original plan key already belongs to a committed record');
END;
CREATE TRIGGER plan_idempotency_records_command_key BEFORE INSERT ON plan_idempotency_records
WHEN EXISTS (SELECT 1 FROM plan_capture_commands WHERE idempotency_key = NEW.idempotency_key) BEGIN
  SELECT RAISE(ABORT, 'The original plan key already belongs to a command request');
END;
`;
