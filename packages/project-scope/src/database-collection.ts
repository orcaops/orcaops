import {
  type ArtifactRevision,
  type ProjectArtifactQuery,
  type ProjectArtifactQueryRow,
  type ProjectCounters,
  ProjectDatabaseError,
  queryProjectArtifacts,
  readProjectArtifactDetails,
} from '@orcaops/storage/history/database';

import type { DatabaseHistoryScope } from './database-scope.js';
import { type HistoryFilters, normalizeHistoryFilters } from './history-filters.js';
import { type HistoryCompleteness, type HistoryIssue, HistoryScopeError } from './history-types.js';

export interface DatabaseHistorySelection {
  projectId: string;
  storeInstanceId: string;
  row: ProjectArtifactQueryRow;
}
export interface DatabaseHistoryCollection {
  entries: DatabaseHistorySelection[];
  sources: Array<{ projectId: string; storeInstanceId: string; counters: ProjectCounters }>;
  counts: { captured: number | null; imported: number | null };
  availableCounts: { captured: number; imported: number };
  completeness: HistoryCompleteness;
  hasMore: boolean | null;
}
function compare(a: DatabaseHistorySelection, b: DatabaseHistorySelection) {
  const left = a.row.startedMs;
  const right = b.row.startedMs;
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  }
  for (const [left, right] of [
    [a.projectId, b.projectId],
    [a.row.artifactId, b.row.artifactId],
  ]) {
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
function selectionQuery(raw: HistoryFilters, profile: ProjectArtifactQuery['profile']) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide a history filter object');
  for (const key of ['touching', 'since', 'until', 'activeSince', 'activeUntil'] as const)
    if (raw[key] !== undefined && typeof raw[key] !== 'string')
      throw new HistoryScopeError('INVALID_INPUT', 'History path and time filters must be strings');
  if (!['watch', 'details', 'provenance', 'versions'].includes(profile ?? ''))
    throw new HistoryScopeError('INVALID_INPUT', 'Select a supported history row profile');
  const filters = normalizeHistoryFilters(raw);
  const limit = filters.limit === undefined ? undefined : filters.offset + filters.limit;
  if (limit !== undefined && !Number.isSafeInteger(limit))
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'History offset plus limit must be a safe integer'
    );
  const query: ProjectArtifactQuery = {
    origin: filters.origin,
    state: filters.state,
    touching: filters.touching,
    sinceMs: filters.since === undefined ? undefined : Date.parse(filters.since),
    untilMs: filters.until === undefined ? undefined : Date.parse(filters.until),
    activeSinceMs: filters.activeSince === undefined ? undefined : Date.parse(filters.activeSince),
    activeUntilMs: filters.activeUntil === undefined ? undefined : Date.parse(filters.activeUntil),
    profile,
    limit,
    offset: 0,
  };
  return { filters, query };
}

export function collectDatabaseHistory(
  scope: DatabaseHistoryScope,
  raw: HistoryFilters = {},
  profile: ProjectArtifactQuery['profile'] = 'watch'
): DatabaseHistoryCollection {
  const { filters, query } = selectionQuery(raw, profile);
  const entries: DatabaseHistorySelection[] = [];
  const sources: DatabaseHistoryCollection['sources'] = [];
  const issues: HistoryIssue[] = structuredClone(scope.completeness.issues);
  const availableCounts = { captured: 0, imported: 0 };
  if (scope.branch.source === 'unavailable')
    issues.push({
      code: 'BRANCH_SELECTION_UNAVAILABLE',
      project_id: null,
      message: 'Current branch is unavailable; select an explicit branch or project collection',
    });
  else {
    if (scope.branch.value !== null) query.branch = scope.branch.value;
    if (scope.kind === 'worktree') {
      if (!scope.gitContext?.worktreeId)
        throw new HistoryScopeError(
          'WORKTREE_SCOPE_UNAVAILABLE',
          'Select an existing registered worktree'
        );
      query.worktreeId = scope.gitContext.worktreeId;
    }
    const seen = new Set<string>();
    for (const project of scope.projects) {
      const database = project.database;
      if (!database) {
        if (!issues.some((issue) => issue.project_id === project.projectId))
          issues.push({
            code: 'HISTORY_INACCESSIBLE',
            project_id: project.projectId,
            message: 'Selected project has no available reader; resolve the original scope again',
          });
        continue;
      }
      try {
        if (
          seen.has(project.projectId) ||
          database.authority.projectId !== project.projectId ||
          database.authority.storeInstanceId !== project.authority?.storeInstanceId ||
          database.authority.rootKey !== scope.root.rootKey ||
          database.authority.resolvedRoot !== scope.root.resolvedRoot
        )
          throw new ProjectDatabaseError(
            'AUTHORITY_MISMATCH',
            'Selected project differs from its opened database; resolve the original scope again'
          );
        seen.add(project.projectId);
        const result = queryProjectArtifacts(database, query);
        const identity = {
          projectId: database.authority.projectId,
          storeInstanceId: database.authority.storeInstanceId,
        };
        sources.push({ ...identity, counters: result.counters });
        entries.push(...result.rows.map((row) => ({ ...identity, row })));
        availableCounts.captured += result.counts.captured;
        availableCounts.imported += result.counts.imported;
        if (result.unknownAssociations)
          issues.push({
            code: 'UNKNOWN_WORKTREE_ASSOCIATION',
            project_id: identity.projectId,
            count: result.unknownAssociations,
            message:
              'Some matching artifacts have unknown worktree associations; use project scope to inspect them',
          });
      } catch (cause) {
        if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
        issues.push({
          code: cause instanceof ProjectDatabaseError ? cause.code : 'HISTORY_INACCESSIBLE',
          project_id: project.projectId,
          message:
            cause instanceof Error
              ? cause.message
              : 'Project history cannot be read; check access and retry',
        });
      }
    }
  }
  const complete = scope.completeness.complete && issues.length === 0;
  entries.sort(compare);
  const selected = entries.slice(
    filters.offset,
    filters.limit === undefined ? undefined : filters.offset + filters.limit
  );
  return {
    entries: selected,
    sources,
    availableCounts,
    counts: complete ? { ...availableCounts } : { captured: null, imported: null },
    completeness: { complete, issues },
    hasMore: complete
      ? filters.offset + selected.length < availableCounts.captured + availableCounts.imported
      : null,
  };
}

export function hydrateDatabaseHistorySelection(
  scope: DatabaseHistoryScope,
  selected: readonly DatabaseHistorySelection[]
) {
  if (!Array.isArray(selected))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide selected history rows');
  let requests: DatabaseHistorySelection[];
  try {
    requests = Array.from(selected, (entry) => {
      const copy = structuredClone(entry);
      if (
        !copy ||
        !copy.row ||
        (copy.row.executionVersion !== null &&
          (!Number.isSafeInteger(copy.row.executionVersion) || copy.row.executionVersion! < 1))
      )
        throw new HistoryScopeError(
          'INVALID_INPUT',
          'Retain each selected execution version as a positive integer or null'
        );
      return copy;
    });
  } catch (cause) {
    if (cause instanceof HistoryScopeError) throw cause;
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide copyable selected history rows', {
      cause,
    });
  }
  const groups = new Map<string, DatabaseHistorySelection[]>();
  for (const entry of requests) {
    const group = groups.get(entry.projectId) ?? [];
    group.push(entry);
    groups.set(entry.projectId, group);
  }
  const results = new Map<string, ReturnType<typeof readProjectArtifactDetails>>();
  for (const [projectId, group] of groups) {
    const projects = scope.projects.filter((project) => project.projectId === projectId);
    const database = projects.length === 1 ? projects[0].database : null;
    if (
      !database ||
      database.authority.projectId !== projectId ||
      database.authority.rootKey !== scope.root.rootKey ||
      database.authority.resolvedRoot !== scope.root.resolvedRoot ||
      group.some((entry) => entry.storeInstanceId !== database.authority.storeInstanceId)
    )
      throw new ProjectDatabaseError(
        'AUTHORITY_MISMATCH',
        'Selected history belongs to another store; resolve its original scope again'
      );
    results.set(
      projectId,
      readProjectArtifactDetails(
        database,
        group.map(({ row }) => {
          const revision: ArtifactRevision = {
            generation: row.generation,
            orderedHash: row.orderedHash,
            eventCount: row.eventCount,
            byteLength: row.byteLength,
            tailEventId: row.tailEventId,
          };
          return { artifactId: row.artifactId, revision, executionVersion: row.executionVersion };
        })
      )
    );
  }
  return requests.map((entry) => {
    const result = results.get(entry.projectId)!;
    return {
      projectId: entry.projectId,
      storeInstanceId: entry.storeInstanceId,
      ...result.artifacts.find((artifact) => artifact.artifactId === entry.row.artifactId)!,
      counters: result.counters,
    };
  });
}
