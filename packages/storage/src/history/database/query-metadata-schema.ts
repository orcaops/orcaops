export const PROJECT_QUERY_METADATA_SCHEMA = `
CREATE TABLE artifact_query_metadata (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id),
  generation INTEGER NOT NULL,
  compiler_version INTEGER NOT NULL CHECK (compiler_version > 0),
  artifact_branch_count INTEGER NOT NULL CHECK (artifact_branch_count >= 0),
  touched_file_count INTEGER NOT NULL CHECK (touched_file_count >= 0),
  plan_step_count INTEGER NOT NULL CHECK (plan_step_count >= 0),
  completed_plan_step_count INTEGER NOT NULL CHECK (completed_plan_step_count BETWEEN 0 AND plan_step_count),
  watch_json TEXT NOT NULL CHECK (json_valid(watch_json)),
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  FOREIGN KEY (artifact_id, generation) REFERENCES artifact_revisions(artifact_id, generation)
) STRICT;
CREATE TABLE execution_query_metadata (
  artifact_id TEXT PRIMARY KEY REFERENCES execution_initializations(artifact_id),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  branch_count INTEGER NOT NULL CHECK (branch_count >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  binding_updated_at TEXT,
  binding_branch TEXT
) STRICT;
CREATE TABLE execution_query_branches (
  artifact_id TEXT NOT NULL REFERENCES execution_initializations(artifact_id),
  branch TEXT NOT NULL CHECK (length(branch) > 0),
  PRIMARY KEY (artifact_id, branch)
) STRICT;
CREATE INDEX execution_query_branch_lookup ON execution_query_branches(branch, artifact_id);
`;
