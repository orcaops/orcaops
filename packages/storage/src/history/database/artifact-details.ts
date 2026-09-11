import {
  type ArtifactRevision,
  copyArtifactRevision,
  hydrateProjectArtifactRecords,
  selectProjectArtifactRecords,
} from './artifacts.js';
import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  hydrateProjectExecutionRecords,
  selectProjectExecutionRecords,
} from './execution-records.js';
import { isUuidV7 } from '../../ids/uuidv7.js';

export interface ProjectArtifactDetailRequest {
  artifactId: string;
  revision?: ArtifactRevision;
  executionVersion?: number | null;
}

function assertRetainedPrefixHeaders(view: ProjectReadView, prefix: string, upper: string) {
  for (const table of [
    'artifact_events',
    'artifact_revisions',
    'execution_initializations',
    'execution_current',
    'execution_transitions',
    'execution_associations',
    'execution_checkpoint_attributions',
    'execution_checkpoint_recoveries',
  ]) {
    if (
      view.get(
        `SELECT retained.artifact_id FROM ${table} AS retained
         WHERE retained.artifact_id >= ? AND retained.artifact_id < ?
           AND NOT EXISTS (SELECT 1 FROM artifacts AS original WHERE original.artifact_id = retained.artifact_id)
         LIMIT 1`,
        prefix,
        upper
      )
    )
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Matching retained history is missing its original artifact header; preserve history for explicit repair'
      );
  }
}

export function readProjectArtifactDetails(
  handle: ProjectDatabase,
  requested: readonly ProjectArtifactDetailRequest[]
) {
  if (!Array.isArray(requested))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide explicit artifact detail requests');
  const seen = new Set<string>();
  const requests = Array.from(requested, (request) => {
    if (
      !request ||
      !isUuidV7(request.artifactId) ||
      seen.has(request.artifactId) ||
      (request.executionVersion !== undefined &&
        request.executionVersion !== null &&
        (!Number.isSafeInteger(request.executionVersion) || request.executionVersion < 1))
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Select unique exact artifact IDs and valid expected execution versions'
      );
    seen.add(request.artifactId);
    return {
      artifactId: request.artifactId,
      revision: request.revision === undefined ? undefined : copyArtifactRevision(request.revision),
      executionVersion: request.executionVersion,
    };
  });
  assertProjectDatabasePath(handle);
  const selected = handle.read((view) => requests.map((request) => selectDetail(view, request)));
  return {
    artifacts: selected.value.map((row) => ({
      artifactId: row.artifactId,
      artifact: hydrateProjectArtifactRecords(row.artifactId, row.artifact, selected.counters),
      execution: hydrateProjectExecutionRecords(row.artifactId, row.execution, selected.counters),
    })),
    counters: selected.counters,
  };
}

interface SelectedArtifactDetail {
  artifactId: string;
  artifact: ReturnType<typeof selectProjectArtifactRecords>;
  execution: ReturnType<typeof selectProjectExecutionRecords>;
}
function selectDetail(
  view: ProjectReadView,
  request: ProjectArtifactDetailRequest
): SelectedArtifactDetail {
  const artifact = selectProjectArtifactRecords(view, request.artifactId, request.revision);
  if (!artifact && request.revision !== undefined)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The expected retained artifact revision is missing; preserve history for explicit repair'
    );
  const execution = selectProjectExecutionRecords(view, request.artifactId);
  if (
    request.executionVersion !== undefined &&
    (execution?.current.version ?? null) !== request.executionVersion
  )
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Execution changed after selection; read the intended artifact again without retargeting'
    );
  if (!artifact && execution && request.revision === undefined)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Execution exists without its original artifact; preserve history for explicit repair'
    );
  return { artifactId: request.artifactId, artifact, execution };
}

type ArtifactResolutionSelection =
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: string[]; truncated: boolean }
  | { kind: 'resolved'; records: SelectedArtifactDetail };
export function selectProjectArtifactResolution(
  view: ProjectReadView,
  requested: string
): ArtifactResolutionSelection {
  if (typeof requested !== 'string' || !/^[0-9a-f-]{1,36}$/i.test(requested))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide an artifact UUID or hexadecimal prefix'
    );
  const prefix = requested.toLowerCase();
  if (isUuidV7(prefix)) {
    const records = selectDetail(view, { artifactId: prefix });
    return records.artifact === null
      ? { kind: 'missing' as const }
      : { kind: 'resolved' as const, records };
  }
  // ASCII bounds use the primary-key index without LIKE collation rules.
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  assertRetainedPrefixHeaders(view, prefix, upper);
  const matches = view.all<{ artifactId: string }>(
    'SELECT artifact_id AS artifactId FROM artifacts WHERE artifact_id >= ? AND artifact_id < ? ORDER BY artifact_id COLLATE BINARY LIMIT 3',
    prefix,
    upper
  );
  if (matches.length === 0) return { kind: 'missing' as const };
  if (matches.length > 1)
    return {
      kind: 'ambiguous' as const,
      candidates: matches.slice(0, 2).map((match) => match.artifactId),
      truncated: matches.length > 2,
    };
  return {
    kind: 'resolved' as const,
    records: selectDetail(view, { artifactId: matches[0].artifactId }),
  };
}

export function hydrateProjectArtifactResolution(
  value: ReturnType<typeof selectProjectArtifactResolution>,
  counters: ProjectCounters
) {
  if (value.kind !== 'resolved') return { ...value, counters };
  const row = value.records;
  const artifact = hydrateProjectArtifactRecords(row.artifactId, row.artifact, counters);
  if (!artifact)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The selected artifact history is missing; preserve it for explicit repair'
    );
  return {
    kind: 'resolved' as const,
    artifactId: row.artifactId,
    artifact,
    execution: hydrateProjectExecutionRecords(row.artifactId, row.execution, counters),
    counters,
  };
}

export function resolveProjectArtifactDetails(handle: ProjectDatabase, requested: string) {
  assertProjectDatabasePath(handle);
  const selected = handle.read((view) => selectProjectArtifactResolution(view, requested));
  return hydrateProjectArtifactResolution(selected.value, selected.counters);
}
