export const PROJECT_SESSION_BRANCH_SCHEMA = `
CREATE TABLE session_branch_revisions (
  revision_id TEXT PRIMARY KEY NOT NULL,
  publication_operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  state_bytes BLOB NOT NULL CHECK (typeof(state_bytes) = 'blob' AND json_valid(CAST(state_bytes AS TEXT))),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('observation', 'acknowledgement')),
  acknowledgement_id TEXT UNIQUE,
  target_server_url TEXT NOT NULL CHECK (length(target_server_url) > 0),
  target_org_id TEXT NOT NULL CHECK (length(target_org_id) > 0),
  target_account_id TEXT NOT NULL CHECK (length(target_account_id) > 0),
  repo_url TEXT NOT NULL CHECK (length(repo_url) > 0),
  working_dir TEXT NOT NULL CHECK (length(working_dir) > 0),
  state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^a-f0-9]*'),
  current_branch TEXT NOT NULL CHECK (length(current_branch) > 0),
  base_commit_sha TEXT,
  last_acked_at TEXT,
  CHECK ((origin_kind = 'observation' AND acknowledgement_id IS NULL) OR
         (origin_kind = 'acknowledgement' AND acknowledgement_id IS NOT NULL)),
  UNIQUE (target_server_url, target_org_id, target_account_id, repo_url, working_dir, revision_id),
  UNIQUE (revision_id, acknowledgement_id),
  FOREIGN KEY (publication_operation_id, acknowledgement_id)
    REFERENCES session_branch_acknowledgements(operation_id, acknowledgement_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER session_branch_revisions_no_replace BEFORE INSERT ON session_branch_revisions
WHEN EXISTS (SELECT 1 FROM session_branch_revisions WHERE revision_id = NEW.revision_id OR
  publication_operation_id = NEW.publication_operation_id OR acknowledgement_id = NEW.acknowledgement_id)
BEGIN SELECT RAISE(ABORT, 'session revisions cannot be replaced'); END;
CREATE TRIGGER session_branch_revisions_no_update BEFORE UPDATE ON session_branch_revisions
BEGIN SELECT RAISE(ABORT, 'session revisions are immutable'); END;
CREATE TRIGGER session_branch_revisions_no_delete BEFORE DELETE ON session_branch_revisions
BEGIN SELECT RAISE(ABORT, 'session revisions are retained'); END;

CREATE TABLE session_branch_current (
  target_server_url TEXT NOT NULL,
  target_org_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  PRIMARY KEY (target_server_url, target_org_id, target_account_id, repo_url, working_dir),
  FOREIGN KEY (target_server_url, target_org_id, target_account_id, repo_url, working_dir, revision_id)
    REFERENCES session_branch_revisions(target_server_url, target_org_id, target_account_id, repo_url, working_dir, revision_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER session_branch_current_initial BEFORE INSERT ON session_branch_current
WHEN NEW.version != 1 OR EXISTS (SELECT 1 FROM session_branch_current WHERE
  target_server_url = NEW.target_server_url AND target_org_id = NEW.target_org_id AND
  target_account_id = NEW.target_account_id AND repo_url = NEW.repo_url AND working_dir = NEW.working_dir)
BEGIN SELECT RAISE(ABORT, 'session selection must start once'); END;
CREATE TRIGGER session_branch_current_advance BEFORE UPDATE ON session_branch_current
WHEN NEW.target_server_url != OLD.target_server_url OR NEW.target_org_id != OLD.target_org_id OR
  NEW.target_account_id != OLD.target_account_id OR NEW.repo_url != OLD.repo_url OR
  NEW.working_dir != OLD.working_dir OR NEW.version != OLD.version + 1 OR NEW.revision_id = OLD.revision_id
BEGIN SELECT RAISE(ABORT, 'session selection must advance within its scope'); END;
CREATE TRIGGER session_branch_current_no_delete BEFORE DELETE ON session_branch_current
BEGIN SELECT RAISE(ABORT, 'session selection is retained'); END;

CREATE TABLE session_branch_acknowledgements (
  acknowledgement_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  target_server_url TEXT NOT NULL CHECK (length(target_server_url) > 0),
  target_org_id TEXT NOT NULL CHECK (length(target_org_id) > 0),
  target_account_id TEXT NOT NULL CHECK (length(target_account_id) > 0),
  repo_url TEXT NOT NULL CHECK (length(repo_url) > 0),
  working_dir TEXT NOT NULL CHECK (length(working_dir) > 0),
  expected_revision_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  push_id TEXT NOT NULL UNIQUE,
  acked_at TEXT NOT NULL CHECK (length(acked_at) > 0),
  applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
  result_revision_id TEXT UNIQUE,
  CHECK ((applied = 0 AND result_revision_id IS NULL) OR (applied = 1 AND result_revision_id IS NOT NULL)),
  UNIQUE (operation_id, acknowledgement_id),
  FOREIGN KEY (target_server_url, target_org_id, target_account_id, repo_url, working_dir, expected_revision_id)
    REFERENCES session_branch_revisions(target_server_url, target_org_id, target_account_id, repo_url, working_dir, revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (target_server_url, target_org_id, target_account_id, repo_url, working_dir, result_revision_id)
    REFERENCES session_branch_revisions(target_server_url, target_org_id, target_account_id, repo_url, working_dir, revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (result_revision_id, acknowledgement_id)
    REFERENCES session_branch_revisions(revision_id, acknowledgement_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (push_id, operation_id) REFERENCES artifact_push_requests(push_id, terminal_operation_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER session_branch_acknowledgements_no_replace BEFORE INSERT ON session_branch_acknowledgements
WHEN EXISTS (SELECT 1 FROM session_branch_acknowledgements WHERE acknowledgement_id = NEW.acknowledgement_id OR
  operation_id = NEW.operation_id OR push_id = NEW.push_id OR result_revision_id = NEW.result_revision_id)
BEGIN SELECT RAISE(ABORT, 'session acknowledgements cannot be replaced'); END;
CREATE TRIGGER session_branch_acknowledgements_owner BEFORE INSERT ON session_branch_acknowledgements
WHEN NOT EXISTS (SELECT 1 FROM artifact_push_requests p WHERE p.push_id = NEW.push_id AND
  p.terminal_operation_id = NEW.operation_id AND p.session_acknowledgement_id = NEW.acknowledgement_id AND
  p.server_url = NEW.target_server_url AND p.org_id = NEW.target_org_id AND p.account_id = NEW.target_account_id AND
  p.session_repo_url = NEW.repo_url AND p.session_working_dir = NEW.working_dir AND
  p.session_revision_id = NEW.expected_revision_id AND p.session_version = NEW.expected_version AND
  (NEW.applied = 0 OR p.session_result_revision_id = NEW.result_revision_id))
BEGIN SELECT RAISE(ABORT, 'session acknowledgement must retain its original push target'); END;
CREATE TRIGGER session_branch_acknowledgements_no_update BEFORE UPDATE ON session_branch_acknowledgements
BEGIN SELECT RAISE(ABORT, 'session acknowledgements are immutable'); END;
CREATE TRIGGER session_branch_acknowledgements_no_delete BEFORE DELETE ON session_branch_acknowledgements
BEGIN SELECT RAISE(ABORT, 'session acknowledgements are retained'); END;
`;
