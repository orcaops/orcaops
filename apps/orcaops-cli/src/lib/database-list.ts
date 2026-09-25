import {
  type HistoryFilters,
  HistoryScopeError,
  type HistorySelector,
  normalizeHistoryFilters,
  validateHistorySelector,
} from '@orcaops/project-scope/history';
import {
  collectDatabaseHistory,
  type DatabaseHistoryCollection,
  type DatabaseHistoryScope,
} from '@orcaops/project-scope/history/database';
import { type Config, redactSecretsInObject } from '@orcaops/storage';

import { parseBetweenRange, TOUCHING_NOTE } from './list-provenance.js';

export interface DatabaseListOptions {
  scope?: HistorySelector['scope'];
  project?: string;
  branch?: string;
  origin?: HistoryFilters['origin'];
  state?: HistoryFilters['state'];
  touching?: string;
  between?: string;
  since?: string;
  until?: string;
  activeSince?: string;
  activeUntil?: string;
  limit?: number;
  offset?: number;
  json?: boolean;
}
export interface DatabaseListContext {
  scope: DatabaseHistoryScope;
  config: Pick<Config, 'digest'>;
}
export const DEFAULT_BARE_LIST_LIMIT = 50;
export function resolveListLimit(options: DatabaseListOptions): number | undefined {
  const bare = Object.entries(options).every(
    ([key, value]) => key === 'json' || value === undefined
  );
  return options.limit ?? (bare ? DEFAULT_BARE_LIST_LIMIT : undefined);
}
export function validateDatabaseList(input: DatabaseListOptions = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide list options as an object');
  const allowed = [
    'scope',
    'project',
    'branch',
    'origin',
    'state',
    'touching',
    'between',
    'since',
    'until',
    'activeSince',
    'activeUntil',
    'limit',
    'offset',
    'json',
  ];
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key))
      throw new HistoryScopeError('INVALID_INPUT', 'Unsupported or retired list option');
    if (
      value !== undefined &&
      !['json', 'limit', 'offset'].includes(key) &&
      typeof value !== 'string'
    )
      throw new HistoryScopeError(
        'INVALID_INPUT',
        'List selectors and time filters must be strings'
      );
  }
  if (input.json !== undefined && typeof input.json !== 'boolean')
    throw new HistoryScopeError('INVALID_INPUT', 'JSON output must be boolean');
  const selector: HistorySelector = {
    scope: input.scope,
    projectId: input.project,
    branch: input.branch,
  };
  validateHistorySelector({
    selector,
    profile: input.between === undefined ? 'collection' : 'git-history',
    gitRange: input.between,
  });
  if (input.between !== undefined) {
    const range = parseBetweenRange(input.between);
    if ([range.from, range.to].some((ref) => ref.startsWith('-') || /[\r\n\0]/u.test(ref)))
      throw new HistoryScopeError(
        'INVALID_INPUT',
        'Git range endpoints must be literal revision expressions'
      );
    if (
      input.branch !== undefined ||
      input.touching !== undefined ||
      input.since !== undefined ||
      input.until !== undefined ||
      input.activeSince !== undefined ||
      input.activeUntil !== undefined
    )
      throw new HistoryScopeError(
        'INVALID_INPUT',
        'Git range conflicts with branch, touching and time-window filters'
      );
  }
  const filters = normalizeHistoryFilters({
    origin: input.origin,
    state: input.state,
    touching: input.touching,
    since: input.since,
    until: input.until,
    activeSince: input.activeSince,
    activeUntil: input.activeUntil,
    limit: resolveListLimit(input),
    offset: input.offset,
  });
  if (filters.limit !== undefined && !Number.isSafeInteger(filters.offset + filters.limit))
    throw new HistoryScopeError('INVALID_INPUT', 'List offset plus limit must be a safe integer');
  return { selector, filters };
}

export function readDatabaseList(context: DatabaseListContext, input: DatabaseListOptions) {
  const options = validateDatabaseList(input);
  const scope = context.scope;
  if (
    (options.selector.scope !== undefined && options.selector.scope !== scope.kind) ||
    (options.selector.branch !== undefined && options.selector.branch !== scope.branch.value) ||
    (options.selector.projectId !== undefined &&
      (scope.projects.length !== 1 || scope.projects[0].projectId !== options.selector.projectId))
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'List options differ from the opened history scope'
    );
  if (input.between !== undefined)
    throw new HistoryScopeError('INVALID_INPUT', 'Git range listing requires the range reader');
  const collection = collectDatabaseHistory(scope, options.filters, 'watch');
  return buildDatabaseListResult(context, options, collection, input.touching);
}

export function buildDatabaseListResult(
  context: DatabaseListContext,
  options: ReturnType<typeof validateDatabaseList>,
  collection: DatabaseHistoryCollection,
  touching?: string
) {
  const scope = context.scope;
  const results = collection.entries.map(({ projectId, row }) => ({
    id: row.artifactId,
    artifact_id: row.artifactId,
    label: row.label,
    task: row.task,
    branch: row.branch,
    state: row.state,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    checkpoint_count: row.checkpointCount,
    origin: row.origin,
    project_id: projectId,
    project: projectId,
  }));
  const returned = {
    captured: results.filter((row) => row.origin === 'captured').length,
    imported: results.filter((row) => row.origin === 'git-import').length,
  };
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
      branch: { ...scope.branch },
    },
    filters: options.filters,
    code_revision: scope.gitContext?.headOid ?? null,
    results,
    completeness: collection.completeness,
    page: {
      offset: options.filters.offset,
      limit: options.filters.limit ?? null,
      returned: results.length,
      next_offset:
        collection.hasMore === true && options.filters.limit !== undefined
          ? options.filters.offset + results.length
          : null,
      truncated: collection.hasMore !== false,
      ranking_complete: collection.completeness.complete,
    },
    origin_counts: { returned, matching: collection.counts },
    sources: collection.sources,
    ...(touching === undefined ? {} : { note: TOUCHING_NOTE }),
  };
  return context.config.digest.redact_secrets ? redactSecretsInObject(output) : output;
}
export function formatDatabaseList(result: ReturnType<typeof readDatabaseList>): string {
  const lines: string[] = [];
  const cell = (value: string, width: number) =>
    value.length > width ? value.slice(0, width - 1) + '…' : value.padEnd(width);
  if (result.results.length === 0)
    lines.push(
      result.completeness.complete
        ? 'No artifacts captured.'
        : 'No artifacts in available history; results are incomplete.'
    );
  else {
    lines.push(
      'ID       PROJECT             STATE        CPS  BRANCH                     LABEL — TASK'
    );
    for (const row of result.results) {
      const task = (row.task ?? '').replace(/\s/gu, ' ').trim();
      lines.push(
        `${row.id.slice(0, 8)} ${cell(row.project, 19)} ${cell(row.state, 12)} ${String(row.checkpoint_count).padStart(3)}  ${cell(row.branch, 26)} ${row.origin === 'git-import' ? '[imported] ' : ''}${row.label ?? 'unlabelled'} — ${task.length > 100 ? task.slice(0, 99) + '…' : task}`
      );
    }
  }
  lines.push(
    `Returned: ${result.origin_counts.returned.captured} captured, ${result.origin_counts.returned.imported} imported.`
  );
  const counts = result.origin_counts.matching;
  lines.push(
    counts.captured === null || counts.imported === null
      ? 'Matching totals unavailable.'
      : `Matching: ${counts.captured} captured, ${counts.imported} imported.`
  );
  if (!result.completeness.complete)
    lines.push('Results are incomplete; missing history may change the order.');
  for (const issue of result.completeness.issues)
    lines.push(`${issue.project_id ?? 'scope'}: ${issue.code}: ${issue.message}`);
  if (result.page.next_offset !== null)
    lines.push(`Next page: --offset ${result.page.next_offset}`);
  if ('note' in result) lines.push(result.note!);
  return lines.join('\n') + '\n';
}
