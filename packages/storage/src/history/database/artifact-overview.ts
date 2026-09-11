import {
  hydrateProjectArtifactResolution,
  selectProjectArtifactResolution,
} from './artifact-details.js';
import { selectArtifactRepoEvidence } from './artifact-repo-evidence.js';
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { hydrateProjectUsageAccounting, selectProjectUsageAccounting } from './usage-accounting.js';

export function resolveProjectArtifactOverview(handle: ProjectDatabase, requested: string) {
  assertProjectDatabasePath(handle);
  const selected = handle.read((view) => {
    const artifact = selectProjectArtifactResolution(view, requested);
    return {
      artifact,
      repoEvidence:
        artifact.kind === 'resolved'
          ? selectArtifactRepoEvidence(view, artifact.records.artifactId)
          : null,
      usage:
        artifact.kind === 'resolved'
          ? selectProjectUsageAccounting(view, [artifact.records.artifactId])
          : null,
    };
  });
  const artifact = hydrateProjectArtifactResolution(selected.value.artifact, selected.counters);
  if (artifact.kind !== 'resolved') return artifact;
  return {
    ...artifact,
    repoEvidence: selected.value.repoEvidence!,
    usage: hydrateProjectUsageAccounting(handle.authority.projectId, [artifact.artifactId], {
      value: selected.value.usage!,
      counters: selected.counters,
    }),
  };
}
