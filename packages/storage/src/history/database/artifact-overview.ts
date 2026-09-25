import {
  hydrateProjectArtifactResolution,
  selectProjectArtifactResolution,
} from './artifact-details.js';
import { selectArtifactRepoEvidence } from './artifact-repo-evidence.js';
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import type { ProjectKnowledgeContext } from './knowledge-context.js';
import type { KnowledgeBoundary } from './knowledge-read-boundary.js';
import { readProjectArtifactTaskUses } from './knowledge-read-task-uses.js';
import { projectTaskKnowledgeContext } from './knowledge-task-context.js';
import { hydrateProjectUsageAccounting, selectProjectUsageAccounting } from './usage-accounting.js';

/**
 * What an overview reads about continuing knowledge. Omitted, none is read at all: `checkout`,
 * `diff` and `usage` take this overview for the thread alone and would otherwise pay to resolve
 * every adopted identity of the project for an answer they never print.
 */
export interface ProjectArtifactOverviewKnowledge {
  /** A write sequence, or `now`. Named by the caller: nothing here defaults a boundary. */
  readonly boundary: KnowledgeBoundary;
}

export function resolveProjectArtifactOverview(
  handle: ProjectDatabase,
  requested: string,
  knowledge?: ProjectArtifactOverviewKnowledge
) {
  assertProjectDatabasePath(handle);
  const boundary = knowledge?.boundary ?? 'now';
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
      // Read here, in the one snapshot this overview is taken in: a surface that read the uses
      // again while rendering would put two observations of the store in one account.
      knowledgeUses:
        artifact.kind === 'resolved'
          ? readProjectArtifactTaskUses(
              view,
              artifact.records.artifactId,
              handle.authority.projectId,
              boundary
            )
          : null,
      // The same snapshot and the same boundary again: what the thread's uses name and what the
      // answer beside them says must be one observation, or a use would cite a revision the
      // answer cannot see.
      knowledgeContext:
        artifact.kind === 'resolved' && knowledge !== undefined
          ? projectTaskKnowledgeContext(view, {
              projectId: handle.authority.projectId,
              artifactId: artifact.records.artifactId,
              boundary,
              plan: { kind: 'latest_visible' },
            }).knowledge
          : null,
    };
  });
  const artifact = hydrateProjectArtifactResolution(selected.value.artifact, selected.counters);
  if (artifact.kind !== 'resolved') return artifact;
  return {
    ...artifact,
    knowledgeUses: selected.value.knowledgeUses!,
    knowledgeContext: selected.value.knowledgeContext as ProjectKnowledgeContext | null,
    repoEvidence: selected.value.repoEvidence!,
    usage: hydrateProjectUsageAccounting(handle.authority.projectId, [artifact.artifactId], {
      value: selected.value.usage!,
      counters: selected.counters,
    }),
  };
}
