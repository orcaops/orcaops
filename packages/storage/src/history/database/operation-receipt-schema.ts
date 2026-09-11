export const PROJECT_OPERATION_RECEIPT_INDEX_SCHEMA = `
CREATE INDEX operations_review_scope ON operations (
  operation_kind,
  json_extract(target_json, '$.reviewId'),
  json_extract(target_json, '$.runId')
);
CREATE INDEX operations_source_plan_record_scope ON operations (
  json_extract(target_json, '$.namespaceId'),
  json_extract(target_json, '$.kind'),
  json_extract(target_json, '$.subjectId'),
  json_extract(target_json, '$.approvedVersion')
) WHERE operation_kind = 'source_plan.record';
CREATE INDEX operations_source_plan_locator_scope ON operations (
  json_extract(target_json, '$.namespaceId'),
  json_extract(target_json, '$.kind'),
  json_extract(target_json, '$.realPath')
) WHERE operation_kind = 'source_plan.locator';
`;
