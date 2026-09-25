import type { KnowledgeProcessingCoverage, ResolvedConfigSource } from '@orcaops/core';
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

import { processingCoverageOf } from './knowledge-processing-coverage.js';
import { readProjectProcessingHistory } from './knowledge-processing-queue.js';
import {
  knowledgeForSearchHits,
  SEARCH_KNOWLEDGE_IDENTITIES_PER_HIT,
  searchKnowledgeBudget,
  type SearchKnowledgeGroup,
  type SearchKnowledgeProject,
  type SearchKnowledgeRecord,
} from './knowledge-search-context.js';

export interface CanonicalSearchOptions {
  scope?: HistorySelector['scope'];
  project?: string;
  branch?: string;
  origin?: HistoryFilters['origin'];
  touching?: string;
  type?: string;
  limit?: number;
  offset?: number;
  knowledgeBytes?: number;
  json?: boolean;
}
export interface CanonicalSearchContext {
  scope: DatabaseHistoryScope;
  config: Pick<Config, 'digest' | 'knowledge_processing'>;
  /** The file the configuration came from; null outside a checkout, where nothing governs it. */
  configSource?: ResolvedConfigSource | null;
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
    'knowledgeBytes',
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
  // The default is the page limit times a fixed per-entry allowance, so asking for more results
  // buys room for their knowledge too; zero is a page that reports every entry incomplete rather
  // than one that quietly drops them.
  const knowledgeBytes = input.knowledgeBytes ?? searchKnowledgeBudget(limit);
  if (!Number.isSafeInteger(knowledgeBytes) || knowledgeBytes < 0)
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Search knowledge budget must be a nonnegative integer number of bytes'
    );
  return {
    selector,
    filters,
    limit,
    offset,
    knowledgeBytes,
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
  const readable = scope.projects.flatMap((project) =>
    project.database === null ? [] : [{ projectId: project.projectId, database: project.database }]
  );
  const knowledge = knowledgeForSearchHits({
    hits: result.results,
    projects: readable,
    budgetBytes: options.knowledgeBytes,
    maxIdentitiesPerEvent: SEARCH_KNOWLEDGE_IDENTITIES_PER_HIT,
  });
  const output = {
    schema_version: 4 as const,
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
    results: result.results.map((row, index) => ({
      ...row,
      project: row.project_id,
      knowledge: knowledge.byHit.get(index) ?? null,
    })),
    knowledge: {
      boundaries: knowledge.boundaries,
      coverage: { processing: processingCoverage(scope, context, readable) },
      groups: knowledge.groups,
      budget: {
        bytes: options.knowledgeBytes,
        spent: knowledge.spentBytes,
        entries_omitted: knowledge.omitted.length,
      },
      limits: knowledge.limits,
    },
    completeness: { complete, issues },
    sources,
    integrity: { source_observation: 'read-transaction' as const },
  };
  return redact ? redactSecretsInObject(output) : output;
}

/**
 * What background processing has interpreted here, through the one function that derives the
 * claim. It is read only when this search reads exactly one project from inside a checkout, for
 * two reasons: reading several at once crosses repositories whose configuration this command never
 * loaded, and outside a checkout no configuration governs the answer at all. Anywhere else it is
 * `null` — nothing knows, which is never a shorthand for "processed".
 *
 * Search resolves no provider, so it names no pause reason and evaluates no consent: probing for
 * providers would spawn subprocesses on a passive read, and neither input can change the claim.
 */
function processingCoverage(
  scope: DatabaseHistoryScope,
  context: CanonicalSearchContext,
  readable: readonly SearchKnowledgeProject[]
): KnowledgeProcessingCoverage | null {
  const only = readable.length === 1 ? readable[0]! : null;
  if (only === null || scope.gitContext === null) return null;
  const history = readProjectProcessingHistory(only.database);
  return processingCoverageOf({
    enabled: context.config.knowledge_processing.enabled,
    source: {
      kind: context.configSource?.kind ?? 'none',
      path: context.configSource?.configPath ?? '',
    },
    history,
    consent: null,
    boundary: history.boundary,
  });
}

type CanonicalSearchResult = Awaited<ReturnType<typeof readCanonicalSearch>>;

const quoted = (statement: string | null) =>
  statement === null ? 'wording this store does not hold' : `"${statement}"`;

/** What stands for a group now, as the composer answered it — never as this line decides it. */
export function knowledgeStandingLine(
  record: SearchKnowledgeRecord,
  groups: readonly SearchKnowledgeGroup[]
): string {
  const group = groups.find((entry) => entry.key === record.group);
  const standing = group?.revisions.filter((revision) =>
    group.governing.includes(revision.revision_id)
  );
  const stands =
    standing === undefined || standing.length === 0
      ? null
      : standing.map((revision) => quoted(revision.statement)).join('; ');
  if (record.wording === 'stands') return `${record.group}: stands`;
  if (record.wording === 'background')
    return `${record.group}: background, not a rule this work has to meet; what stands: ${stands ?? 'nothing'}`;
  if (record.wording === 'superseded')
    return `${record.group}: superseded by ${stands ?? 'a revision this read cannot state'}`;
  // Withdrawn is about THIS wording. Another revision of the same identity may be adopted, and a
  // line that said nothing stands would send a reader away from the rule that does.
  if (record.wording === 'withdrawn')
    return `${record.group}: withdrawn; what stands: ${stands ?? 'nothing'}`;
  return `${record.group}: wording not tied to a revision; what stands: ${stands ?? 'nothing'}`;
}

export function formatCanonicalSearch(result: CanonicalSearchResult): string {
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
    lines.push(`    ${row.snippet}`);
    for (const record of row.knowledge?.records ?? [])
      lines.push(`    ${knowledgeStandingLine(record, result.knowledge.groups)}`);
    for (const missing of row.knowledge?.incomplete ?? [])
      lines.push(`    ${missing.identity}: incomplete entry. ${missing.reason}`);
    lines.push('');
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
  const budget = result.knowledge.budget;
  if (budget.entries_omitted > 0)
    lines.push(
      `${budget.entries_omitted} knowledge entr(y/ies) did not fit the ${budget.bytes}-byte ` +
        'budget and are marked incomplete above; raise --knowledge-bytes or narrow --limit.'
    );
  const processing = result.knowledge.coverage.processing;
  lines.push(
    processing === null
      ? 'Processing coverage: unread here, so nothing is claimed about interpreted knowledge.'
      : `Processing coverage: ${processing.claim}. ${processing.statement}`
  );
  for (const issue of result.completeness.issues)
    lines.push(`${issue.project_id ?? 'scope'}: ${issue.code}: ${issue.message}`);
  if (result.page.next_offset !== null)
    lines.push(`Next page: --offset ${result.page.next_offset}`);
  return lines.join('\n') + '\n';
}
