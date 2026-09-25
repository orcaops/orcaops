export const PROJECT_RATIONALE_SCHEMA = `
CREATE TABLE rationale_index_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL
) STRICT;
CREATE TABLE rationale_pending_artifacts (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id)
) STRICT;
CREATE TABLE rationale_events (
  event_id TEXT PRIMARY KEY REFERENCES artifact_events(event_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  ordinal INTEGER NOT NULL,
  omitted_accounts INTEGER NOT NULL CHECK (omitted_accounts >= 0),
  omitted_terms INTEGER NOT NULL CHECK (omitted_terms >= 0)
) STRICT;
CREATE INDEX rationale_events_artifact ON rationale_events(artifact_id, ordinal, event_id);
CREATE TABLE rationale_accounts (
  event_id TEXT NOT NULL REFERENCES rationale_events(event_id) ON DELETE CASCADE,
  field_path TEXT NOT NULL,
  account_json TEXT NOT NULL CHECK (json_valid(account_json)),
  PRIMARY KEY (event_id, field_path)
) STRICT;
CREATE TABLE rationale_terms (
  term TEXT NOT NULL,
  event_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  PRIMARY KEY (term, event_id, field_path),
  FOREIGN KEY (event_id, field_path) REFERENCES rationale_accounts(event_id, field_path) ON DELETE CASCADE
) STRICT;
CREATE INDEX rationale_terms_account ON rationale_terms(event_id, field_path);
CREATE TRIGGER rationale_index_initialize AFTER INSERT ON activation BEGIN
  INSERT INTO rationale_index_state VALUES (1, 1);
END;
CREATE TRIGGER rationale_artifact_created AFTER INSERT ON artifacts BEGIN
  INSERT OR IGNORE INTO rationale_pending_artifacts VALUES (NEW.artifact_id);
END;
CREATE TRIGGER rationale_artifact_changed AFTER UPDATE OF current_generation ON artifacts BEGIN
  INSERT OR IGNORE INTO rationale_pending_artifacts VALUES (NEW.artifact_id);
END;
CREATE TRIGGER rationale_event_removed AFTER DELETE ON rationale_events BEGIN
  INSERT OR IGNORE INTO rationale_pending_artifacts VALUES (OLD.artifact_id);
END;
`;
