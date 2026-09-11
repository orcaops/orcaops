import {
  type ProjectDatabase,
  resolveProjectArtifactDetails,
  resolveProjectArtifactOverview,
} from '@orcaops/storage/history/database';

import type { DatabaseHistoryScope } from './database-scope.js';
import { HistoryScopeError } from './history-types.js';

function exactProjectDatabase(scope: DatabaseHistoryScope) {
  if (scope.kind === 'all-projects' || scope.projects.length !== 1)
    throw new HistoryScopeError(
      'PROJECT_REQUIRED',
      'Exact artifact reads require one selected project'
    );
  const project = scope.projects[0];
  const { database, authority } = project;
  if (!database || !authority)
    throw new HistoryScopeError(
      project.completeness.issues[0]?.code ?? 'HISTORY_INACCESSIBLE',
      'Selected project history is unavailable',
      { issues: project.completeness.issues }
    );
  if (
    authority.projectId !== project.projectId ||
    database.authority.projectId !== project.projectId ||
    (['storeInstanceId', 'repositoryInstanceId', 'rootKey', 'resolvedRoot'] as const).some(
      (key) => database.authority[key] !== authority[key]
    ) ||
    database.authority.rootKey !== scope.root.rootKey ||
    database.authority.resolvedRoot !== scope.root.resolvedRoot
  )
    throw new HistoryScopeError(
      'AUTHORITY_MISMATCH',
      'Resolve the original project and store before reading this artifact'
    );
  return database;
}
function withProjectIdentity<T extends { kind: 'resolved'; artifactId: string }>(
  database: ProjectDatabase,
  result: T
) {
  const { kind: _kind, ...value } = result;
  return {
    ...value,
    projectId: database.authority.projectId,
    authority: { ...database.authority },
    followup: `orcaops show ${result.artifactId} --project ${database.authority.projectId}`,
  };
}
function requireArtifact<T extends ReturnType<typeof resolveProjectArtifactDetails>>(
  projectId: string,
  result: T
): asserts result is T & { kind: 'resolved' } {
  if (result.kind === 'missing')
    throw new HistoryScopeError('UNKNOWN_ARTIFACT', 'Artifact is absent from the selected project');
  if (result.kind === 'ambiguous')
    throw new HistoryScopeError(
      'AMBIGUOUS_ARTIFACT',
      'Use a longer prefix or an exact artifact UUID',
      {
        candidates: result.candidates.map((artifactId) => ({
          project_id: projectId,
          artifact_id: artifactId,
          command: `orcaops show ${artifactId} --project ${projectId}`,
        })),
        truncated: result.truncated,
      }
    );
}
export function resolveDatabaseHistoryArtifact(scope: DatabaseHistoryScope, requested: string) {
  const database = exactProjectDatabase(scope);
  const result = resolveProjectArtifactDetails(database, requested);
  requireArtifact(database.authority.projectId, result);
  return withProjectIdentity(database, result);
}
export type DatabaseHistoryOverview = Omit<
  Extract<ReturnType<typeof resolveProjectArtifactOverview>, { kind: 'resolved' }>,
  'kind'
> & {
  projectId: string;
  authority: ProjectDatabase['authority'];
  followup: string;
};
export function resolveDatabaseHistoryOverview(
  scope: DatabaseHistoryScope,
  requested: string
): DatabaseHistoryOverview {
  const database = exactProjectDatabase(scope);
  const result = resolveProjectArtifactOverview(database, requested);
  requireArtifact(database.authority.projectId, result);
  return withProjectIdentity(database, result);
}
