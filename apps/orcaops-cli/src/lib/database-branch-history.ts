import { isDeepStrictEqual } from 'node:util';

import { Repo } from '@orcaops/core';
import { readDatabaseHistoryContext } from '@orcaops/core/history/database-read';
import {
  type HistoryFilters,
  HistoryScopeError,
  unavailableProjectError,
} from '@orcaops/project-scope/history';
import {
  collectDatabaseHistory,
  type DatabaseHistoryProject,
  type DatabaseHistoryScope,
  type DatabaseHistorySelection,
  hydrateDatabaseHistorySelection,
} from '@orcaops/project-scope/history/database';
import type { ArtifactThread } from '@orcaops/storage';
import {
  type ArtifactRevision,
  type ProjectArtifactQuery,
  type ProjectCounters,
  type ProjectDatabase,
  ProjectDatabaseError,
  readProjectInitialization,
} from '@orcaops/storage/history/database';

import { getInvocationEnv } from './invocation-context.js';

export function historyGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(getInvocationEnv()).filter(([key]) => !key.startsWith('GIT_'))
    ),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
  };
}

export function historyRepository(worktreeRoot: string): Repo {
  return new Repo(worktreeRoot, { env: historyGitEnvironment() });
}

export interface RepositoryHistoryScope {
  git: NonNullable<DatabaseHistoryScope['gitContext']>;
  project: DatabaseHistoryProject;
  database: ProjectDatabase;
  authority: NonNullable<DatabaseHistoryProject['authority']>;
}
export function requireRepositoryScope(scope: DatabaseHistoryScope): RepositoryHistoryScope {
  const git = scope.gitContext;
  if (!git || scope.kind === 'all-projects' || scope.projects.length !== 1)
    throw new HistoryScopeError(
      'GIT_CONTEXT_UNAVAILABLE',
      'This read requires one selected project and a matching repository checkout'
    );
  const project = scope.projects[0];
  if (!project.database || !project.authority)
    throw unavailableProjectError(project.completeness.issues);
  if (git.repositoryInstanceId !== project.authority.repositoryInstanceId)
    throw new HistoryScopeError(
      'GIT_CONTEXT_UNAVAILABLE',
      'The current repository is not the selected project repository'
    );
  return { git, project, database: project.database, authority: project.authority };
}

export function createContextRevalidator(scope: DatabaseHistoryScope): () => Promise<void> {
  const { git, database, authority } = requireRepositoryScope(scope);
  const initialization = readProjectInitialization(database);
  const registrationAuthority = {
    resolved_root: authority.resolvedRoot,
    root_key: authority.rootKey,
    project_id: authority.projectId,
    store_instance_id: authority.storeInstanceId,
  };
  const expectedGit = structuredClone(git);
  return async () => {
    const observed = await readDatabaseHistoryContext({ cwd: expectedGit.worktreeRoot });
    if (observed.headIssue) throw observed.headIssue;
    if (
      !isDeepStrictEqual(observed.git, expectedGit) ||
      !isDeepStrictEqual(observed.registration?.authority, registrationAuthority) ||
      observed.registration?.repository_instance_id !== authority.repositoryInstanceId ||
      observed.registration?.initialization_operation_id !==
        initialization.initializationOperationId
    )
      throw new ProjectDatabaseError(
        'STALE_CONTEXT',
        'Repository context changed during this read; retry the original selection'
      );
  };
}

export function branchSelectionScope(
  scope: DatabaseHistoryScope,
  branch?: string
): DatabaseHistoryScope {
  return {
    ...scope,
    branch:
      branch !== undefined
        ? { value: branch, source: 'explicit' }
        : {
            value: scope.gitContext?.branch ?? null,
            source: scope.gitContext?.branch ? 'current' : 'unavailable',
          },
  };
}

export function collectBranchHistory(
  scope: DatabaseHistoryScope,
  options: {
    branch?: string;
    filters?: HistoryFilters;
    profile?: ProjectArtifactQuery['profile'];
  } = {}
) {
  return collectDatabaseHistory(
    branchSelectionScope(scope, options.branch),
    { ...options.filters, limit: undefined, offset: 0 },
    options.profile ?? 'watch'
  );
}

export function inFlightEntries<T extends DatabaseHistorySelection>(entries: readonly T[]): T[] {
  return entries.filter((entry) => entry.row.state !== 'summarized');
}
export function liveEntries<T extends DatabaseHistorySelection>(entries: readonly T[]): T[] {
  return entries.filter((entry) => entry.row.origin === 'captured');
}

export interface HydratedHistoryThread {
  projectId: string;
  storeInstanceId: string;
  artifactId: string;
  revision: ArtifactRevision;
  thread: ArtifactThread;
  executionState: unknown | null;
  executionVersion: number | null;
  counters: ProjectCounters;
}
export interface HistoryHydrationFailure {
  artifact_id: string;
  project_id: string;
  code: string;
  message: string;
}
const retainedSourceFailures = new Set(['HISTORY_INTEGRITY_REQUIRED', 'HISTORY_MISSING']);

function toThread(item: ReturnType<typeof hydrateDatabaseHistorySelection>[number]) {
  if (!item.artifact)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The selected artifact revision is missing; preserve history for explicit repair'
    );
  return {
    projectId: item.projectId,
    storeInstanceId: item.storeInstanceId,
    artifactId: item.artifactId,
    revision: item.artifact.revision,
    thread: item.artifact.thread,
    executionState: item.execution?.state ?? null,
    executionVersion: item.execution?.version ?? null,
    counters: item.counters,
  } satisfies HydratedHistoryThread;
}

/**
 * `refuse` hydrates each project's selection in one read transaction and lets any
 * retained-source failure propagate; `skip` hydrates one artifact at a time so a
 * single unavailable artifact is reported instead of hiding the rest. Only
 * retained-source failures skip; authority, input and cancellation errors propagate.
 */
export function hydrateHistoryThreads(
  scope: DatabaseHistoryScope,
  entries: readonly DatabaseHistorySelection[],
  mode: 'refuse' | 'skip' = 'refuse'
): { threads: HydratedHistoryThread[]; skipped: HistoryHydrationFailure[] } {
  const threads: HydratedHistoryThread[] = [];
  const skipped: HistoryHydrationFailure[] = [];
  if (mode === 'refuse') {
    for (const item of hydrateDatabaseHistorySelection(scope, entries))
      threads.push(toThread(item));
    return { threads, skipped };
  }
  for (const entry of entries) {
    try {
      threads.push(toThread(hydrateDatabaseHistorySelection(scope, [entry])[0]));
    } catch (cause) {
      if (!(cause instanceof ProjectDatabaseError) || !retainedSourceFailures.has(cause.code))
        throw cause;
      skipped.push({
        artifact_id: entry.row.artifactId,
        project_id: entry.projectId,
        code: cause.code,
        message: cause.message,
      });
    }
  }
  return { threads, skipped };
}
