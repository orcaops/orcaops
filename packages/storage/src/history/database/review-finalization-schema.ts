export const PROJECT_REVIEW_FINALIZATION_SCHEMA = `
CREATE TABLE review_run_finalizations (
  run_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  run_revision_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  record_bytes BLOB NOT NULL,
  record_hash TEXT NOT NULL,
  FOREIGN KEY (review_id, run_id) REFERENCES review_runs(review_id, run_id),
  FOREIGN KEY (run_id, run_revision_id) REFERENCES review_run_revisions(run_id, revision_id)
) STRICT;
CREATE TRIGGER review_run_finalizations_no_replace BEFORE INSERT ON review_run_finalizations
WHEN EXISTS (
  SELECT 1 FROM review_run_finalizations
  WHERE run_id = NEW.run_id OR run_revision_id = NEW.run_revision_id
) BEGIN
  SELECT RAISE(ABORT, 'Review history is immutable');
END;
CREATE TRIGGER review_run_finalizations_no_update BEFORE UPDATE ON review_run_finalizations BEGIN
  SELECT RAISE(ABORT, 'Review history is immutable');
END;
CREATE TRIGGER review_run_finalizations_no_delete BEFORE DELETE ON review_run_finalizations BEGIN
  SELECT RAISE(ABORT, 'Review history is retained');
END;
`;
