export const pushTables = [
  'artifact_push_current',
  'artifact_push_requests',
  'artifact_push_terminal_calls',
  'artifact_push_terminals',
  'cloud_sync_current',
  'cloud_sync_records',
  'session_branch_acknowledgements',
  'session_branch_current',
  'session_branch_revisions',
];
export const legacyImportTables = [
  'legacy_artifact_cloud_facts',
  'legacy_import',
  'legacy_session_branch_state',
  'legacy_source_plan_records',
  'legacy_sqlite_images',
];
export const exactRevisionTables = [
  'adoptions',
  'assessments',
  'claim_revisions',
  'claims',
  'criterion_lineage',
  'decision_revisions',
  'decisions',
  'record_relationships',
];
export function unchangedRemoteSchema<T>(objects: readonly T[]): T[] {
  return objects.filter(
    (object) => (object as { tbl_name: string }).tbl_name !== 'remote_requests'
  );
}
