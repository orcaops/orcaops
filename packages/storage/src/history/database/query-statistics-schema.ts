export const PROJECT_QUERY_STATISTICS_SCHEMA = `
CREATE TABLE artifact_plan_step_history (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  step_id TEXT NOT NULL CHECK (length(step_id) > 0),
  PRIMARY KEY (artifact_id, step_id),
  FOREIGN KEY (artifact_id, generation) REFERENCES artifact_revisions(artifact_id, generation)
) STRICT;
CREATE INDEX artifact_plan_step_history_lookup ON artifact_plan_step_history(step_id, artifact_id);
CREATE INDEX operations_checkout_focus_lookup ON operations(json_extract(payload_json, '$.focus.operationId'))
  WHERE operation_kind = 'execution.checkout';
`;
