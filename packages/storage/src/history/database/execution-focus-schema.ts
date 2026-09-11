export const PROJECT_EXECUTION_FOCUS_SCHEMA = `
CREATE TABLE execution_focus_records (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json) AND json_type(scope_json) = 'object'),
  pin_bytes BLOB,
  pin_hash TEXT,
  CHECK (
    (pin_bytes IS NULL AND pin_hash IS NULL) OR
    (pin_bytes IS NOT NULL AND pin_hash IS NOT NULL AND length(pin_hash) = 64 AND pin_hash NOT GLOB '*[^0-9a-f]*')
  ),
  UNIQUE (scope_json, operation_id)
) STRICT;
CREATE TRIGGER execution_focus_records_no_replace BEFORE INSERT ON execution_focus_records
WHEN EXISTS (SELECT 1 FROM execution_focus_records WHERE operation_id = NEW.operation_id) BEGIN
  SELECT RAISE(ABORT, 'Focus history is immutable');
END;
CREATE TRIGGER execution_focus_records_no_update BEFORE UPDATE ON execution_focus_records BEGIN
  SELECT RAISE(ABORT, 'Focus history is immutable');
END;
CREATE TRIGGER execution_focus_records_no_delete BEFORE DELETE ON execution_focus_records BEGIN
  SELECT RAISE(ABORT, 'Focus history is retained');
END;
CREATE TABLE execution_focus_current (
  scope_json TEXT PRIMARY KEY CHECK (json_valid(scope_json) AND json_type(scope_json) = 'object'),
  operation_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY (scope_json, operation_id) REFERENCES execution_focus_records(scope_json, operation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER execution_focus_current_no_replace BEFORE INSERT ON execution_focus_current
WHEN EXISTS (SELECT 1 FROM execution_focus_current WHERE scope_json = NEW.scope_json) BEGIN
  SELECT RAISE(ABORT, 'Focus selection requires an exact version update');
END;
CREATE TRIGGER execution_focus_current_version BEFORE UPDATE ON execution_focus_current
WHEN NEW.scope_json <> OLD.scope_json OR NEW.version <> OLD.version + 1 OR NEW.operation_id = OLD.operation_id BEGIN
  SELECT RAISE(ABORT, 'Focus selection requires a new publication and the next version');
END;
CREATE TRIGGER execution_focus_current_no_delete BEFORE DELETE ON execution_focus_current BEGIN
  SELECT RAISE(ABORT, 'Focus selection is retained; publish an explicit clear');
END;
`;
