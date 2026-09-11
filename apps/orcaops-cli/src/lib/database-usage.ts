import {
  type HistoryFilters,
  HistoryScopeError,
  type HistorySelector,
  normalizeHistoryFilters,
  validateHistorySelector,
} from '@orcaops/project-scope/history';
import {
  collectDatabaseHistory,
  type DatabaseHistoryScope,
  resolveDatabaseHistoryOverview,
} from '@orcaops/project-scope/history/database';
import { type Config, redactSecretsInObject } from '@orcaops/storage';
import {
  discoverProjectUsageSessions,
  ProjectDatabaseError,
  type ProjectUsageAccountingInput,
  readProjectUsageAccounting,
} from '@orcaops/storage/history/database';
import {
  aggregateCanonicalUsage,
  estimateArtifactUsage,
  type UsageAccountingInput,
  usageSessionKey,
} from '@orcaops/storage/history/usage-accounting';

import { aggregateUsageModels, type UsageScopeIssue } from './canonical-usage-display.js';

export interface DatabaseUsageOptions {
  artifact?: string;
  scope?: HistorySelector['scope'];
  project?: string;
  branch?: string;
  origin?: HistoryFilters['origin'];
  state?: HistoryFilters['state'];
  touching?: string;
  json?: boolean;
}
export function validateDatabaseUsage(input: DatabaseUsageOptions = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide usage options as an object');
  const allowed = ['artifact', 'scope', 'project', 'branch', 'origin', 'state', 'touching', 'json'];
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key))
      throw new HistoryScopeError('INVALID_INPUT', 'Unsupported or retired usage option');
    if (value !== undefined && typeof value !== (key === 'json' ? 'boolean' : 'string'))
      throw new HistoryScopeError(
        'INVALID_INPUT',
        'Usage selectors must be strings and JSON output boolean'
      );
  }
  if (input.artifact !== undefined && !input.artifact.trim())
    throw new HistoryScopeError('INVALID_INPUT', 'Provide an artifact identity or prefix');
  if (
    input.artifact !== undefined &&
    [input.scope, input.branch, input.origin, input.state, input.touching].some(
      (value) => value !== undefined
    )
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'Exact artifact usage accepts project qualification, not collection filters'
    );
  const selector: HistorySelector = {
    scope: input.scope,
    projectId: input.project,
    branch: input.branch,
  };
  const profile = input.artifact === undefined ? 'collection' : 'exact';
  validateHistorySelector({ profile, selector });
  const filters = normalizeHistoryFilters({
    origin: input.origin,
    state: input.state,
    touching: input.touching,
  });
  return { selector, profile, filters } as const;
}
export function readDatabaseUsage(
  context: { scope: DatabaseHistoryScope; config: Pick<Config, 'digest'> },
  input: DatabaseUsageOptions = {}
) {
  const options = validateDatabaseUsage(input);
  const scope = context.scope;
  if (
    (options.selector.scope !== undefined && options.selector.scope !== scope.kind) ||
    (options.selector.branch !== undefined && options.selector.branch !== scope.branch.value) ||
    (options.selector.projectId !== undefined &&
      (scope.projects.length !== 1 || scope.projects[0].projectId !== options.selector.projectId))
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'Usage options differ from the opened history scope'
    );
  const issues: UsageScopeIssue[] = [];
  const inputs: UsageAccountingInput[] = [];
  const sources: Array<{
    project_id: string;
    store_instance_id: string;
    write_sequence: number;
    intent_change_counter: number;
  }> = [];
  const estimates: Array<{
    project_id: string;
    artifact_id: string;
    estimate: ReturnType<typeof estimateArtifactUsage>;
  }> = [];
  let artifactId: string | null = null;
  const accept = (accounting: ProjectUsageAccountingInput, storeInstanceId: string) => {
    inputs.push(accounting);
    sources.push({
      project_id: accounting.projectId,
      store_instance_id: storeInstanceId,
      write_sequence: accounting.counters.writeSequence,
      intent_change_counter: accounting.counters.intentChangeCounter,
    });
  };
  if (input.artifact !== undefined) {
    const selected = resolveDatabaseHistoryOverview(scope, input.artifact);
    artifactId = selected.artifactId;
    accept(selected.usage, selected.authority.storeInstanceId);
    issues.push(...scope.completeness.issues);
    estimates.push({
      project_id: selected.projectId,
      artifact_id: selected.artifactId,
      estimate: estimateArtifactUsage(selected.usage.events, selected.artifactId),
    });
  } else {
    const collection = collectDatabaseHistory(scope, options.filters, 'versions');
    issues.push(...collection.completeness.issues);
    const filtered =
      scope.kind === 'worktree' ||
      scope.branch.value !== null ||
      options.filters.origin !== 'all' ||
      input.state !== undefined ||
      input.touching !== undefined;
    const discoveries: Array<{
      project: DatabaseHistoryScope['projects'][number];
      artifactIds: string[] | undefined;
      selected: ReturnType<typeof discoverProjectUsageSessions>;
    }> = [];
    const unavailable = (projectId: string, cause: unknown) => {
      if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
      issues.push({
        project_id: projectId,
        code: cause instanceof ProjectDatabaseError ? cause.code : 'HISTORY_INACCESSIBLE',
        message:
          cause instanceof Error
            ? cause.message
            : 'Usage cannot be read; check access and repeat the original scope',
      });
    };
    for (const source of collection.sources) {
      const project = scope.projects.find((project) => project.projectId === source.projectId)!;
      const artifactIds = filtered
        ? collection.entries
            .filter((entry) => entry.projectId === source.projectId)
            .map((entry) => entry.row.artifactId)
        : undefined;
      try {
        discoveries.push({
          project,
          artifactIds,
          selected: discoverProjectUsageSessions(project.database!, {
            artifactIds,
            expectedWriteSequence: source.counters.writeSequence,
          }),
        });
      } catch (cause) {
        unavailable(source.projectId, cause);
      }
    }
    const sessions = [
      ...new Map(
        discoveries
          .flatMap(({ selected }) => selected.sessions)
          .map((session) => [usageSessionKey(session.agent, session.sessionId), session])
      ).values(),
    ];
    for (const { project, artifactIds, selected } of discoveries) {
      try {
        accept(
          readProjectUsageAccounting(project.database!, {
            artifactIds,
            sessions,
            expectedWriteSequence: selected.counters.writeSequence,
          }),
          project.database!.authority.storeInstanceId
        );
      } catch (cause) {
        unavailable(project.projectId, cause);
      }
    }
  }
  if (!scope.completeness.complete && !issues.length)
    issues.push({
      code: 'HISTORY_INCOMPLETE',
      project_id: null,
      message: 'Selected history scope is incomplete',
    });
  if (issues.length)
    inputs.push({ projectId: '', events: [], unavailable: issues.map((issue) => issue.message) });
  const accounting = aggregateCanonicalUsage(inputs);
  const output = {
    schema_version: 3 as const,
    scope: {
      kind: scope.kind,
      selection: scope.selection,
      root_key: scope.root.rootKey,
      worktree_id: scope.gitContext?.worktreeId ?? null,
      branch: { ...scope.branch },
    },
    artifact_id: artifactId,
    filters: options.filters,
    usage: {
      accounting,
      model_totals: aggregateUsageModels(accounting),
      projects: sources,
      issues,
      estimates,
    },
    completeness: { complete: issues.length === 0 && scope.completeness.complete, issues },
    usd: 'priced_by_cloud' as const,
  };
  return context.config.digest.redact_secrets ? redactSecretsInObject(output) : output;
}
