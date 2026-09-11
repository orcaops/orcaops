import {
  type HistorySearchProject,
  normalizeSearchQuery,
  queryHistorySearch,
  SEARCH_SOURCE_KINDS,
} from '@orcaops/core/history/search';
import {
  type HistoryFilters,
  type HistoryIssue,
  HistoryScopeError,
  type HistorySelector,
  normalizeHistoryFilters,
  validateHistorySelector,
} from '@orcaops/project-scope/history';
import type { DatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { type Config, redactSecretsInObject } from '@orcaops/storage';
import {
  type ProjectCounters,
  ProjectDatabaseError,
  queryProjectSearch,
} from '@orcaops/storage/history/database';

export interface CanonicalSearchOptions {
  scope?: HistorySelector['scope'];
  project?: string;
  branch?: string;
  origin?: HistoryFilters['origin'];
  touching?: string;
  type?: string;
  limit?: number;
  offset?: number;
  json?: boolean;
}
export interface CanonicalSearchContext {
  scope: DatabaseHistoryScope;
  config: Pick<Config, 'digest'>;
}

export function validateCanonicalSearch(query: string, input: CanonicalSearchOptions = {}) {
  const allowed = [
    'scope',
    'project',
    'branch',
    'origin',
    'touching',
    'type',
    'limit',
    'offset',
    'json',
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new HistoryScopeError('INVALID_INPUT', 'Unsupported or retired search option');
  normalizeSearchQuery(query);
  const selector: HistorySelector = {
    scope: input.scope,
    projectId: input.project,
    branch: input.branch,
  };
  validateHistorySelector({ selector, profile: 'collection' });
  const filters = normalizeHistoryFilters({ origin: input.origin, touching: input.touching });
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new HistoryScopeError('INVALID_INPUT', 'Search limit must be a positive integer');
  if (input.type !== undefined && !SEARCH_SOURCE_KINDS.some((kind) => kind === input.type))
    throw new HistoryScopeError(
      'INVALID_INPUT',
      `Search type must be one of: ${SEARCH_SOURCE_KINDS.join(', ')}`
    );
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + limit + 1))
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Search offset must be a nonnegative integer within the supported page range'
    );
  return {
    selector,
    filters,
    limit,
    offset,
    sourceKinds:
      input.type === undefined ? undefined : [input.type as (typeof SEARCH_SOURCE_KINDS)[number]],
  };
}

function searchIssue(cause: unknown, projectId: string): HistoryIssue {
  return {
    code:
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      typeof cause.code === 'string'
        ? cause.code
        : 'SEARCH_UNAVAILABLE',
    project_id: projectId,
    message: cause instanceof Error ? cause.message : 'Selected project search is unavailable',
  };
}

export async function readCanonicalSearch(
  context: CanonicalSearchContext,
  query: string,
  input: CanonicalSearchOptions
) {
  input = { ...input };
  const redact = context.config.digest.redact_secrets;
  const options = validateCanonicalSearch(query, input);
  const scope = {
    ...context.scope,
    root: { ...context.scope.root },
    branch: { ...context.scope.branch },
    gitContext:
      context.scope.gitContext === null ? null : structuredClone(context.scope.gitContext),
    completeness: structuredClone(context.scope.completeness),
    projects: context.scope.projects.map((project) => ({
      ...project,
      authority: project.authority === null ? null : { ...project.authority },
    })),
  };
  if (
    (options.selector.scope !== undefined && options.selector.scope !== scope.kind) ||
    (options.selector.branch !== undefined && options.selector.branch !== scope.branch.value) ||
    (options.selector.projectId !== undefined &&
      (scope.projects.length !== 1 || scope.projects[0]!.projectId !== options.selector.projectId))
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'Search options differ from the opened history scope'
    );
  const issues = structuredClone(scope.completeness.issues);
  const sources: Array<{ projectId: string; storeInstanceId: string; counters: ProjectCounters }> =
    [];
  const projects: HistorySearchProject[] = [];
  const empty = () => ({
    rows: [],
    counts: { captured: null, imported: null },
    rankingComplete: false,
    candidateComplete: true,
    sourceComplete: false,
    scanned: 0,
    elapsedMs: 0,
  });
  if (scope.branch.source === 'unavailable')
    issues.push({
      code: 'BRANCH_SELECTION_UNAVAILABLE',
      project_id: null,
      message: 'Current branch is unavailable; select an explicit branch or project collection',
    });
  else
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
      projects.push({
        projectId: project.projectId,
        async query({ query, sourceKinds, limit }) {
          try {
            if (
              database.authority.projectId !== project.projectId ||
              database.authority.storeInstanceId !== project.authority?.storeInstanceId ||
              database.authority.repositoryInstanceId !== project.authority?.repositoryInstanceId ||
              database.authority.rootKey !== scope.root.rootKey ||
              database.authority.resolvedRoot !== scope.root.resolvedRoot
            )
              throw new ProjectDatabaseError(
                'AUTHORITY_MISMATCH',
                'Search reader differs from its selected project'
              );
            if (scope.kind === 'worktree' && !scope.gitContext?.worktreeId)
              throw new HistoryScopeError(
                'WORKTREE_SCOPE_UNAVAILABLE',
                'Select an existing registered worktree'
              );
            const batch = queryProjectSearch(database, {
              query,
              sourceKinds,
              limit,
              origin: options.filters.origin,
              touching: options.filters.touching,
              ...(scope.branch.value === null ? {} : { branch: scope.branch.value }),
              ...(scope.kind === 'worktree' ? { worktreeId: scope.gitContext!.worktreeId! } : {}),
            });
            sources.push({
              projectId: project.projectId,
              storeInstanceId: database.authority.storeInstanceId,
              counters: batch.counters,
            });
            if (batch.unknownAssociations)
              issues.push({
                code: 'UNKNOWN_WORKTREE_ASSOCIATION',
                project_id: project.projectId,
                count: batch.unknownAssociations,
                message:
                  'Some matching artifacts have unknown worktree associations; inspect them in project scope',
              });
            return batch;
          } catch (cause) {
            if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
            issues.push(searchIssue(cause, project.projectId));
            return empty();
          }
        },
      });
    }
  const result = await queryHistorySearch({
    query,
    projects,
    sourceComplete: scope.completeness.complete && issues.length === 0,
    sourceKinds: options.sourceKinds,
    limit: options.limit,
    offset: options.offset,
  });
  const complete =
    scope.completeness.complete && issues.length === 0 && result.page.source_complete;
  if (!complete) {
    result.page.ranking_complete = false;
    result.page.source_complete = false;
    result.page.truncated = true;
    result.origin_counts.matching = { captured: null, imported: null };
  }
  const output = {
    schema_version: 3 as const,
    scope: {
      kind: scope.kind,
      selection: scope.selection,
      root_key: scope.root.rootKey,
      authorities: scope.projects.map((project) => ({
        project_id: project.projectId,
        store_instance_id: project.authority?.storeInstanceId ?? null,
        state: project.database === null ? 'unavailable' : 'available',
      })),
      worktree_id: scope.gitContext?.worktreeId ?? null,
      branch: structuredClone(scope.branch),
    },
    code_revision: scope.gitContext?.headOid ?? null,
    query,
    filters: { ...options.filters, type: input.type ?? null },
    ...result,
    count: result.results.length,
    results: result.results.map((row) => ({ ...row, project: row.project_id })),
    completeness: { complete, issues },
    sources,
    integrity: { source_observation: 'read-transaction' as const },
  };
  return redact ? redactSecretsInObject(output) : output;
}

export function formatCanonicalSearch(
  result: Awaited<ReturnType<typeof readCanonicalSearch>>
): string {
  const lines = [`search: "${result.query}" (${result.scope.kind})`, ''];
  if (result.results.length === 0)
    lines.push(
      result.page.ranking_complete
        ? 'No matches.'
        : 'No matches in available history; results are incomplete.'
    );
  for (const row of result.results) {
    lines.push(
      `  [${row.project}] ${row.artifact_id} [${row.origin}] [${row.match_class}] [${row.source_kind}] @ ${row.evidence_time ?? 'time unknown'}`
    );
    lines.push(`    ${row.snippet}`, '');
  }
  const counts = result.origin_counts;
  lines.push(
    `Returned: ${counts.returned.captured} captured, ${counts.returned.imported} imported.`
  );
  lines.push(
    counts.matching.captured === null || counts.matching.imported === null
      ? 'Matching totals unavailable.'
      : `Matching: ${counts.matching.captured} captured, ${counts.matching.imported} imported.`
  );
  if (!result.page.ranking_complete)
    lines.push('Results are incomplete; missing history may change the order.');
  for (const issue of result.completeness.issues) lines.push(`${issue.code}: ${issue.message}`);
  if (result.page.next_offset !== null)
    lines.push(`Next page: --offset ${result.page.next_offset}`);
  return lines.join('\n') + '\n';
}
