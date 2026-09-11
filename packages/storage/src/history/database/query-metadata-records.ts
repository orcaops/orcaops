import type { ArtifactThread } from '../../events/artifact-thread.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { CounterSchema } from '../event-integrity.js';
import { type ExecutionState, ExecutionStateSchema } from '../execution-schema.js';
import { historyMetadataDetails, HistoryMetadataDetailsSchema } from '../metadata-details.js';
import { historyProvenanceMetadata } from '../metadata-provenance.js';
import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { ArtifactActivitySchema, prepareArtifactActivity } from './query-activity.js';
import { ArtifactStatisticsSchema, prepareArtifactStatistics } from './query-statistics.js';
import type { ProjectSettlement } from './transactions.js';

export const QUERY_METADATA_COMPILER_VERSION = 3;
export const ArtifactQueryDetailsSchema = HistoryMetadataDetailsSchema.omit({
  watch: true,
  execution: true,
}).extend({
  activity: ArtifactActivitySchema,
  statistics: ArtifactStatisticsSchema,
  historicalStepCount: CounterSchema,
});

export interface PreparedArtifactQueryMetadata {
  readonly artifactId: string;
  readonly generation: number;
  readonly branchCount: number;
  readonly touchedFileCount: number;
  readonly planStepCount: number;
  readonly completedPlanStepCount: number;
  readonly watchJson: string;
  readonly detailsJson: string;
  readonly provenanceJson: string;
  readonly historicalPlanStepIds: readonly string[];
}

export async function prepareArtifactQueryMetadata(
  thread: ArtifactThread,
  generation: number
): Promise<PreparedArtifactQueryMetadata> {
  thread = structuredClone(thread);
  if (!isUuidV7(thread.artifactId) || !Number.isSafeInteger(generation) || generation < 1)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select an exact retained artifact revision');
  const details = historyMetadataDetails(thread, null);
  const { watch, execution: _execution, ...artifactDetails } = details;
  const branches = new Set(thread.artifactJson!.branch_lineage.map((entry) => entry.branch));
  const files = new Set(
    thread.checkpoints.flatMap((checkpoint) =>
      checkpoint.status === 'closed' ? checkpoint.files_changed : []
    )
  );
  const completedSteps = new Set(
    details.closedCheckpoints.flatMap((checkpoint) => checkpoint.completed_step_ids)
  );
  const provenance = await historyProvenanceMetadata(thread);
  const { statistics, historicalPlanStepIds } = prepareArtifactStatistics(thread);
  return Object.freeze({
    artifactId: thread.artifactId,
    generation,
    branchCount: branches.size,
    touchedFileCount: files.size,
    planStepCount: details.planStepIds.length,
    completedPlanStepCount: details.planStepIds.filter((id) => completedSteps.has(id)).length,
    watchJson: canonicalJson(watch),
    detailsJson: canonicalJson({
      ...artifactDetails,
      activity: prepareArtifactActivity(thread),
      statistics,
      historicalStepCount: historicalPlanStepIds.length,
    }),
    provenanceJson: canonicalJson(provenance),
    historicalPlanStepIds: Object.freeze(historicalPlanStepIds),
  });
}

export interface PreparedExecutionQueryMetadata {
  readonly artifactId: string;
  readonly version: number;
  readonly branches: readonly string[];
  readonly stateJson: string;
  readonly bindingUpdatedAt: string | null;
  readonly bindingBranch: string | null;
}

export function prepareExecutionQueryMetadata(
  input: ExecutionState,
  version: number
): PreparedExecutionQueryMetadata {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select the exact execution version');
  const state = ExecutionStateSchema.parse(input);
  const branches = new Set<string>();
  for (const transition of state.binding_history)
    for (const binding of [transition.prior_binding, transition.binding])
      if (binding?.git_context.branch) branches.add(binding.git_context.branch);
  return Object.freeze({
    artifactId: state.artifact_id,
    version,
    branches: Object.freeze([...branches].sort()),
    stateJson: canonicalJson(state),
    bindingUpdatedAt: state.binding_history.at(-1)?.ts ?? null,
    bindingBranch: state.current_binding?.git_context.branch ?? null,
  });
}

export function replaceArtifactQueryMetadata(
  transaction: Pick<ProjectSettlement, 'run'>,
  row: PreparedArtifactQueryMetadata
): void {
  transaction.run('DELETE FROM artifact_plan_step_history WHERE artifact_id=?', row.artifactId);
  for (const stepId of row.historicalPlanStepIds)
    transaction.run(
      'INSERT INTO artifact_plan_step_history VALUES (?, ?, ?)',
      row.artifactId,
      row.generation,
      stepId
    );
  transaction.run(
    `INSERT INTO artifact_query_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_id) DO UPDATE SET generation=excluded.generation,
      compiler_version=excluded.compiler_version, artifact_branch_count=excluded.artifact_branch_count,
      touched_file_count=excluded.touched_file_count, plan_step_count=excluded.plan_step_count,
      completed_plan_step_count=excluded.completed_plan_step_count, watch_json=excluded.watch_json,
      details_json=excluded.details_json, provenance_json=excluded.provenance_json`,
    row.artifactId,
    row.generation,
    QUERY_METADATA_COMPILER_VERSION,
    row.branchCount,
    row.touchedFileCount,
    row.planStepCount,
    row.completedPlanStepCount,
    row.watchJson,
    row.detailsJson,
    row.provenanceJson
  );
}

export function replaceExecutionQueryMetadata(
  transaction: Pick<ProjectSettlement, 'run'>,
  row: PreparedExecutionQueryMetadata
): void {
  transaction.run('DELETE FROM execution_query_branches WHERE artifact_id=?', row.artifactId);
  for (const branch of row.branches)
    transaction.run('INSERT INTO execution_query_branches VALUES (?, ?)', row.artifactId, branch);
  transaction.run(
    `INSERT INTO execution_query_metadata VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_id) DO UPDATE SET version=excluded.version,
      branch_count=excluded.branch_count, state_json=excluded.state_json,
      binding_updated_at=excluded.binding_updated_at, binding_branch=excluded.binding_branch`,
    row.artifactId,
    row.version,
    row.branches.length,
    row.stateJson,
    row.bindingUpdatedAt,
    row.bindingBranch
  );
}

export function assertQueryMetadataComplete(
  view: ProjectReadView,
  input: { artifactIds?: readonly string[]; worktreeId?: string } = {}
): void {
  const ids = input.artifactIds === undefined ? null : JSON.stringify([...input.artifactIds]);
  for (const table of ['artifact_events', 'artifact_revisions']) {
    if (
      view.get(
        `SELECT e.artifact_id FROM ${table} e WHERE
        (? IS NULL OR e.artifact_id IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.artifact_id=e.artifact_id) LIMIT 1`,
        ids,
        ids
      )
    )
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Artifact header is missing while retained history remains; preserve history for explicit repair'
      );
  }
  const worktree = input.worktreeId ?? null;
  const invalid = view.get(
    `SELECT a.artifact_id FROM artifacts a
    LEFT JOIN artifact_metadata m ON m.artifact_id=a.artifact_id
    LEFT JOIN artifact_query_metadata q ON q.artifact_id=a.artifact_id
    LEFT JOIN execution_initializations i ON i.artifact_id=a.artifact_id
    LEFT JOIN execution_current c ON c.artifact_id=a.artifact_id
    LEFT JOIN execution_query_metadata e ON e.artifact_id=a.artifact_id
    WHERE (? IS NULL OR a.artifact_id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM execution_associations s
        WHERE s.artifact_id=a.artifact_id AND s.worktree_id=?))
      AND (m.artifact_id IS NULL OR q.artifact_id IS NULL
        OR q.generation<>a.current_generation OR q.compiler_version<>?
        OR q.artifact_branch_count<>(SELECT count(*) FROM artifact_branches b WHERE b.artifact_id=a.artifact_id)
        OR q.touched_file_count<>(SELECT count(*) FROM artifact_touched_files f WHERE f.artifact_id=a.artifact_id)
        OR json_extract(q.details_json,'$.historicalStepCount') IS NULL
        OR json_extract(q.details_json,'$.historicalStepCount')<>(SELECT count(*) FROM artifact_plan_step_history h WHERE h.artifact_id=a.artifact_id)
        OR EXISTS (SELECT 1 FROM artifact_plan_step_history h WHERE h.artifact_id=a.artifact_id AND h.generation<>a.current_generation)
        OR (i.artifact_id IS NULL AND (c.artifact_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM execution_transitions t WHERE t.artifact_id=a.artifact_id)
          OR EXISTS (SELECT 1 FROM execution_associations s WHERE s.artifact_id=a.artifact_id)
          OR EXISTS (SELECT 1 FROM execution_checkpoint_attributions p WHERE p.artifact_id=a.artifact_id)
          OR EXISTS (SELECT 1 FROM execution_checkpoint_recoveries r WHERE r.artifact_id=a.artifact_id)))
        OR (i.artifact_id IS NOT NULL AND (c.artifact_id IS NULL OR e.artifact_id IS NULL
          OR e.version<>c.version
          OR e.branch_count<>(SELECT count(*) FROM execution_query_branches b WHERE b.artifact_id=a.artifact_id))))
    LIMIT 1`,
    ids,
    ids,
    worktree,
    worktree,
    QUERY_METADATA_COMPILER_VERSION
  );
  if (invalid)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Query metadata is missing or incompatible; run an explicit index rebuild before listing or searching'
    );
}
