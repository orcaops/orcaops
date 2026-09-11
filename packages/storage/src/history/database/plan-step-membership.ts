import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { assertQueryMetadataComplete } from './query-metadata-records.js';
import {
  hydrateProjectArtifactRows,
  type ProjectArtifactQueryRow,
  selectProjectArtifactRows,
} from './query.js';

export interface ProjectStepMembership {
  stepId: string;
  /** Version rows of every artifact whose retained plan revisions contain the step, in artifact order. */
  artifacts: ProjectArtifactQueryRow[];
  counters: ProjectCounters;
}

export function prepareStepIdentifier(stepId: string): string {
  if (typeof stepId !== 'string' || stepId.trim().length === 0 || stepId.includes('\0'))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select a nonempty plan step identifier');
  return stepId;
}

export function selectProjectStepMembership(view: ProjectReadView, stepId: string) {
  // Membership is derived; a missing or stale row must refuse rather than read as absence.
  assertQueryMetadataComplete(view);
  const lookup =
    'SELECT artifact_id AS artifactId FROM artifact_plan_step_history WHERE step_id=? ORDER BY artifact_id COLLATE BINARY';
  const hits = view.all<{ artifactId: string }>(lookup, stepId).map((hit) => hit.artifactId);
  const rows = hits.length
    ? selectProjectArtifactRows(view, { artifactIds: hits, profile: 'versions' }).rows
    : [];
  return { hits, rows };
}

export function hydrateProjectStepMembership(
  stepId: string,
  snapshot: { value: ReturnType<typeof selectProjectStepMembership>; counters: ProjectCounters }
): ProjectStepMembership {
  const hydrated = hydrateProjectArtifactRows({
    value: {
      rows: snapshot.value.rows,
      counts: { captured: 0, imported: 0 },
      unknownAssociations: 0,
    },
    counters: snapshot.counters,
  });
  const byId = new Map(hydrated.rows.map((row) => [row.artifactId, row]));
  const artifacts = snapshot.value.hits.map((artifactId) => {
    const row = byId.get(artifactId);
    if (!row)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Historical step membership names an artifact without a selectable revision; preserve history for explicit repair'
      );
    return row;
  });
  return { stepId, artifacts, counters: snapshot.counters };
}

export function readProjectStepMembership(
  handle: ProjectDatabase,
  stepId: string
): ProjectStepMembership {
  const selected = prepareStepIdentifier(stepId);
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => selectProjectStepMembership(view, selected));
  return hydrateProjectStepMembership(selected, snapshot);
}
