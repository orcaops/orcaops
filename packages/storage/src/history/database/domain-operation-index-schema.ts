export const PROJECT_DOMAIN_OPERATION_INDEX_SCHEMA = `
CREATE INDEX operations_artifact_target_lookup ON operations (
  operation_kind, json_extract(target_json, '$.artifactId'), operation_id
);
CREATE INDEX review_semantic_generations_operation ON review_semantic_generations(created_operation_id);
CREATE INDEX review_semantic_attempts_operation ON review_semantic_attempts(operation_id);
CREATE INDEX review_semantic_terminals_operation ON review_semantic_terminals(operation_id);
CREATE INDEX review_semantic_current_operation ON review_semantic_current(operation_id);
`;
