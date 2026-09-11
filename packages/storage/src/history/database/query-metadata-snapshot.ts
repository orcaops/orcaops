import type { ProjectArtifactSnapshot } from './artifacts.js';
import { readProjectArtifact } from './artifacts.js';
import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { readProjectExecution } from './execution-records.js';
import {
  prepareArtifactQueryMetadata,
  type PreparedArtifactQueryMetadata,
  type PreparedExecutionQueryMetadata,
  prepareExecutionQueryMetadata,
} from './query-metadata-records.js';
import { type ArtifactSearchRows, prepareArtifactSearchRows } from './search-records.js';
import { sourceMembership } from './source-time-membership.js';
import { hydrateProjectSourceTime, snapshotProjectSourceTime } from './source-time-records.js';

export interface PreparedProjectQueryMetadata {
  readonly schemaVersion: number;
  readonly counters: ProjectCounters;
  readonly artifacts: readonly {
    readonly snapshot: ProjectArtifactSnapshot;
    readonly query: PreparedArtifactQueryMetadata;
    readonly search: ArtifactSearchRows;
  }[];
  readonly executions: readonly PreparedExecutionQueryMetadata[];
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'Query preparation cancelled; no indexes changed');
}
function sameSequence(actual: number, expected: number): void {
  if (actual !== expected)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'History changed while preparing query indexes; retry explicit preparation against current history'
    );
}

export async function prepareProjectQueryMetadata(
  handle: ProjectDatabase,
  signal?: AbortSignal
): Promise<PreparedProjectQueryMetadata> {
  cancelled(signal);
  assertProjectDatabasePath(handle);
  const selected = handle.read((view) => {
    const schemaVersion = view.get<{ version: number }>(
      'SELECT user_version AS version FROM pragma_user_version'
    )!.version;
    for (const table of ['artifact_events', 'artifact_revisions']) {
      if (
        view.get(`SELECT artifact_id FROM ${table} e WHERE NOT EXISTS
        (SELECT 1 FROM artifacts a WHERE a.artifact_id=e.artifact_id) LIMIT 1`)
      )
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'Artifact header is missing while retained history remains; preserve history for explicit repair'
        );
    }
    for (const table of [
      'execution_current',
      'execution_transitions',
      'execution_associations',
      'execution_checkpoint_attributions',
      'execution_checkpoint_recoveries',
    ]) {
      if (
        view.get(`SELECT artifact_id FROM ${table} e WHERE NOT EXISTS
        (SELECT 1 FROM execution_initializations i WHERE i.artifact_id=e.artifact_id) LIMIT 1`)
      )
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'Execution initialization is missing while retained history remains; preserve history for explicit repair'
        );
    }
    if (
      view.get(`SELECT artifact_id FROM execution_initializations e WHERE NOT EXISTS
      (SELECT 1 FROM artifacts a WHERE a.artifact_id=e.artifact_id) LIMIT 1`)
    )
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Execution refers to missing artifact history; preserve history for explicit repair'
      );
    return {
      schemaVersion,
      artifactIds: view.all<{ id: string }>(
        'SELECT artifact_id AS id FROM artifacts ORDER BY artifact_id'
      ),
    };
  });
  const { schemaVersion } = selected.value;
  const counters = Object.freeze(selected.counters);
  const writeSequence = counters.writeSequence;
  const artifacts: PreparedProjectQueryMetadata['artifacts'][number][] = [];
  const executions: PreparedExecutionQueryMetadata[] = [];
  for (const { id } of selected.value.artifactIds) {
    cancelled(signal);
    const snapshot = readProjectArtifact(handle, id);
    if (!snapshot)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Selected artifact history is missing; preserve history for explicit repair'
      );
    sameSequence(snapshot.counters.writeSequence, writeSequence);
    const source = handle.read((view) => snapshotProjectSourceTime(view, id));
    sameSequence(source.counters.writeSequence, writeSequence);
    const member = hydrateProjectSourceTime(source.value, id);
    if (member) sourceMembership(snapshot.thread, member, true);
    const search = prepareArtifactSearchRows(
      handle.authority.projectId,
      snapshot.thread,
      snapshot.revision.generation,
      member
    );
    const query = await prepareArtifactQueryMetadata(snapshot.thread, snapshot.revision.generation);
    cancelled(signal);
    const execution = readProjectExecution(handle, id);
    if (execution) {
      sameSequence(execution.counters.writeSequence, writeSequence);
      executions.push(prepareExecutionQueryMetadata(execution.state, execution.version));
    }
    artifacts.push(Object.freeze({ snapshot, query, search }));
  }
  sameSequence(handle.read(() => null).counters.writeSequence, writeSequence);
  cancelled(signal);
  return Object.freeze({
    schemaVersion,
    counters,
    artifacts: Object.freeze(artifacts),
    executions: Object.freeze(executions),
  });
}
