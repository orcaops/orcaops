export const PROJECT_REVIEW_FEEDBACK_CURSOR_SCHEMA = `
CREATE TABLE review_feedback_watch_cursors (
  server_url TEXT NOT NULL CHECK (length(server_url) > 0),
  org_id TEXT NOT NULL CHECK (length(org_id) > 0),
  account_id TEXT NOT NULL CHECK (length(account_id) > 0),
  pull_request_id TEXT NOT NULL CHECK (length(pull_request_id) > 0),
  last_seen_human_activity_at TEXT NOT NULL CHECK (length(last_seen_human_activity_at) > 0),
  last_seen_human_activity_ms INTEGER NOT NULL CHECK (last_seen_human_activity_ms BETWEEN -8640000000000000 AND 8640000000000000),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  advanced_at TEXT NOT NULL CHECK (length(advanced_at) > 0),
  PRIMARY KEY (server_url, org_id, account_id, pull_request_id)
) STRICT;
CREATE TRIGGER review_feedback_watch_cursors_initial BEFORE INSERT ON review_feedback_watch_cursors
WHEN NEW.version != 1 BEGIN
  SELECT RAISE(ABORT, 'Review feedback cursor begins at version one');
END;
CREATE TRIGGER review_feedback_watch_cursors_transition BEFORE UPDATE ON review_feedback_watch_cursors
WHEN NEW.server_url != OLD.server_url OR NEW.org_id != OLD.org_id OR
  NEW.account_id != OLD.account_id OR NEW.pull_request_id != OLD.pull_request_id OR
  NEW.version != OLD.version + 1 OR
  NEW.last_seen_human_activity_ms <= OLD.last_seen_human_activity_ms OR
  NEW.operation_id = OLD.operation_id BEGIN
  SELECT RAISE(ABORT, 'Review feedback cursor requires monotonic exact advancement');
END;
CREATE TRIGGER review_feedback_watch_cursors_no_delete BEFORE DELETE ON review_feedback_watch_cursors BEGIN
  SELECT RAISE(ABORT, 'Review feedback cursors are retained');
END;
`;
