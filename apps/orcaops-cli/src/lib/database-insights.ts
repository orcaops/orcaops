import {
  type HistoryFilters,
  type HistoryIssue,
  HistoryScopeError,
  type HistorySelector,
  normalizeHistoryFilters,
  validateHistorySelector,
} from '@orcaops/project-scope/history';
import {
  collectDatabaseHistory,
  type DatabaseHistoryScope,
  hydrateDatabaseHistorySelection,
  resolveDatabaseHistoryArtifact,
} from '@orcaops/project-scope/history/database';
import {
  type ArtifactOriginKind,
  type Config,
  PlanSchema,
  redactSecretsInObject,
} from '@orcaops/storage';
import {
  ProjectDatabaseError,
  readProjectArtifactDetails,
} from '@orcaops/storage/history/database';

import {
  type ArtifactLooseEnds,
  collectArtifactDecisions,
  collectLooseEnds,
  type DecisionRecord,
  recordWindowFromFlags,
} from './history-views.js';

export interface DatabaseInsightOptions extends Omit<HistoryFilters, 'state'> {
  scope?: HistorySelector['scope'];
  project?: string;
  branch?: string;
  artifact?: string[];
  json?: boolean;
}
export interface DatabaseInsightContext {
  scope: DatabaseHistoryScope;
  config: Pick<Config, 'digest'>;
}
export function validateDatabaseInsight(
  kind: 'decisions' | 'loose-ends',
  input: DatabaseInsightOptions
) {
  const allowed = [
    'scope',
    'project',
    'branch',
    'origin',
    'touching',
    'artifact',
    'since',
    'until',
    'activeSince',
    'activeUntil',
    'limit',
    'offset',
    'json',
  ];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw new HistoryScopeError('INVALID_INPUT', 'Unsupported or retired history insight option');
  if (input.json !== undefined && typeof input.json !== 'boolean')
    throw new HistoryScopeError('INVALID_INPUT', 'JSON output selection must be a boolean');
  const options = structuredClone(input);
  if (
    options.artifact !== undefined &&
    (!Array.isArray(options.artifact) ||
      options.artifact.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{1,36}$/i.test(id)))
  )
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Select artifact UUIDs or unambiguous UUID prefixes'
    );
  for (const key of ['since', 'until', 'activeSince', 'activeUntil', 'touching', 'branch'] as const)
    if (options[key] !== undefined && typeof options[key] !== 'string')
      throw new HistoryScopeError(
        'INVALID_INPUT',
        'History path, branch and time filters must be strings'
      );
  const artifactIds = [...new Set(options.artifact ?? [])];
  const profile = artifactIds.length ? ('exact' as const) : ('collection' as const);
  const selector = { scope: options.scope, projectId: options.project, branch: options.branch };
  validateHistorySelector({ selector, profile });
  if (
    profile === 'exact' &&
    ['origin', 'touching', 'limit', 'offset'].some(
      (key) => options[key as keyof DatabaseInsightOptions] !== undefined
    )
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'Exact artifact reads accept project qualification and decision record windows only'
    );
  if (
    profile === 'exact' &&
    kind === 'loose-ends' &&
    ['since', 'until', 'activeSince', 'activeUntil'].some(
      (key) => options[key as keyof DatabaseInsightOptions] !== undefined
    )
  )
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Loose ends are current findings; window flags have no effect with --artifact'
    );
  const filters = normalizeHistoryFilters({
    origin: options.origin,
    touching: options.touching,
    since: options.since,
    until: options.until,
    activeSince: options.activeSince,
    activeUntil: options.activeUntil,
    limit: options.limit,
    offset: options.offset,
  });
  if (filters.limit !== undefined && !Number.isSafeInteger(filters.offset + filters.limit))
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'History offset plus limit must be a safe integer'
    );
  return { kind, selector, profile, filters, artifactIds, json: options.json ?? false };
}
type PreparedInsight = ReturnType<typeof validateDatabaseInsight>;
type Detail = ReturnType<typeof readProjectArtifactDetails>['artifacts'][number];
type InsightArtifact = Detail & { projectId: string; storeInstanceId: string };

function readInsightHistory(context: DatabaseInsightContext, options: PreparedInsight) {
  const scope = context.scope;
  let artifacts: InsightArtifact[] = [];
  let inspected: number;
  let hasMore: boolean | null;
  let counts: { captured: number | null; imported: number | null };
  let issues: HistoryIssue[];
  const sources: Array<{
    project_id: string;
    store_instance_id: string;
    write_sequence: number;
    selection_write_sequence: number;
    hydration_write_sequence: number | null;
    intent_change: number;
  }> = [];
  if (options.profile === 'exact') {
    const resolved = options.artifactIds.map((id) => resolveDatabaseHistoryArtifact(scope, id));
    const unique = [...new Map(resolved.map((item) => [item.artifactId, item])).values()];
    const project = scope.projects[0];
    // Prefix resolution is provisional; the final batch verifies every retained revision in one read transaction.
    const batch =
      unique.length === 1
        ? { artifacts: unique, counters: unique[0].counters }
        : readProjectArtifactDetails(
            project.database!,
            unique.map((item) => ({
              artifactId: item.artifactId,
              revision: item.artifact.revision,
              executionVersion: item.execution?.version ?? null,
            }))
          );
    artifacts = batch.artifacts.map((item) => ({
      ...item,
      projectId: project.projectId,
      storeInstanceId: project.authority!.storeInstanceId,
    }));
    sources.push({
      project_id: project.projectId,
      store_instance_id: project.authority!.storeInstanceId,
      write_sequence: batch.counters.writeSequence,
      selection_write_sequence: batch.counters.writeSequence,
      hydration_write_sequence: batch.counters.writeSequence,
      intent_change: batch.counters.intentChangeCounter,
    });
    inspected = unique.length;
    hasMore = false;
    issues = structuredClone(scope.completeness.issues);
    counts = {
      captured: artifacts.filter(
        (item) => item.artifact?.thread.plan?.origin?.kind !== 'git-import'
      ).length,
      imported: artifacts.filter(
        (item) => item.artifact?.thread.plan?.origin?.kind === 'git-import'
      ).length,
    };
  } else {
    const selectionFilters =
      options.kind === 'decisions'
        ? {
            ...options.filters,
            since: undefined,
            until: undefined,
            activeSince: undefined,
            activeUntil: undefined,
          }
        : options.filters;
    const collection = collectDatabaseHistory(scope, selectionFilters, 'versions');
    inspected = collection.entries.length;
    hasMore = collection.hasMore;
    counts = collection.counts;
    issues = structuredClone(collection.completeness.issues);
    for (const source of collection.sources)
      sources.push({
        project_id: source.projectId,
        store_instance_id: source.storeInstanceId,
        write_sequence: source.counters.writeSequence,
        selection_write_sequence: source.counters.writeSequence,
        hydration_write_sequence: null,
        intent_change: source.counters.intentChangeCounter,
      });
    for (const projectId of new Set(collection.entries.map((entry) => entry.projectId))) {
      try {
        const hydrated = hydrateDatabaseHistorySelection(
          scope,
          collection.entries.filter((entry) => entry.projectId === projectId)
        );
        artifacts.push(...hydrated);
        const source = sources.find((entry) => entry.project_id === projectId)!;
        // Membership and retained revisions were selected at the earlier sequence.
        source.hydration_write_sequence = hydrated[0].counters.writeSequence;
      } catch (cause) {
        if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
        issues.push({
          code: cause instanceof ProjectDatabaseError ? cause.code : 'HISTORY_INACCESSIBLE',
          project_id: projectId,
          message:
            cause instanceof Error
              ? cause.message
              : 'Selected history could not be read; retry the original selection',
        });
      }
    }
    const order = new Map(
      collection.entries.map((entry, index) => [
        `${entry.projectId}/${entry.row.artifactId}`,
        index,
      ])
    );
    artifacts.sort(
      (a, b) =>
        order.get(`${a.projectId}/${a.artifactId}`)! - order.get(`${b.projectId}/${b.artifactId}`)!
    );
  }
  const complete = scope.completeness.complete && issues.length === 0;
  return {
    artifacts,
    envelope: {
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
      filters: { ...options.filters, artifact_ids: [...options.artifactIds] },
      code_revision: scope.gitContext?.headOid ?? null,
      completeness: { complete, issues },
      sources,
      page: {
        offset: options.filters.offset,
        limit: options.filters.limit ?? null,
        inspected,
        next_offset: complete && hasMore ? options.filters.offset + inspected : null,
        truncated: !complete || hasMore !== false,
        ranking_complete: complete,
      },
      origin_counts: { matching: complete ? counts : { captured: null, imported: null } },
      integrity: {
        source_observation: 'read-transaction' as const,
        selection: 'verified-revisions' as const,
      },
    },
  };
}
interface InsightIdentity {
  artifact_id: string;
  project_id: string;
  project: string;
  store_instance_id: string;
  label: string;
  task: string;
  branch: string;
  origin: ArtifactOriginKind | null;
}
export interface ArtifactDecisions extends InsightIdentity {
  records: DecisionRecord[];
}
export interface ArtifactLooseEndsView extends InsightIdentity, ArtifactLooseEnds {}
function insightIdentity(item: InsightArtifact): InsightIdentity {
  const plan = item.artifact!.thread.plan!;
  return {
    artifact_id: item.artifactId,
    project_id: item.projectId,
    project: item.projectId,
    store_instance_id: item.storeInstanceId,
    label: plan.label ?? 'unlabelled',
    task: plan.task,
    branch: plan.branch,
    origin: plan.origin?.kind ?? null,
  };
}
function insightOutput<T extends InsightIdentity>(
  context: DatabaseInsightContext,
  history: ReturnType<typeof readInsightHistory>,
  results: T[]
) {
  const output = {
    ...history.envelope,
    results,
    page: { ...history.envelope.page, returned: results.length },
    origin_counts: {
      ...history.envelope.origin_counts,
      returned: {
        captured: results.filter((item) => item.origin !== 'git-import').length,
        imported: results.filter((item) => item.origin === 'git-import').length,
      },
    },
  };
  return context.config.digest.redact_secrets ? redactSecretsInObject(output) : output;
}
export function readDatabaseDecisions(context: DatabaseInsightContext, options: PreparedInsight) {
  const history = readInsightHistory(context, options);
  const recordWindow = recordWindowFromFlags(options.filters);
  const results: ArtifactDecisions[] = [];
  for (const item of history.artifacts) {
    const thread = item.artifact!.thread;
    const revisionCapturedAt = new Map<number, string>();
    for (const event of thread.events) {
      if (event.record.type !== 'plan_captured' && event.record.type !== 'plan_revised') continue;
      const plan = PlanSchema.parse({
        ...(event.payload as object),
        source_event_id: event.record.event_id,
      });
      revisionCapturedAt.set(plan.revision_n, plan.revised_at ?? plan.started_at);
    }
    const records = collectArtifactDecisions(
      {
        planDecisions: thread.plan?.decisions ?? [],
        revisionCapturedAt,
        closedCheckpoints: thread.checkpoints.filter((cp) => cp.status === 'closed'),
        deferredDecisions: thread.summary?.deferred_decisions ?? [],
        summaryTs: thread.summary?.ts ?? null,
      },
      recordWindow
    );
    if (records.length) results.push({ ...insightIdentity(item), records });
  }
  return {
    ...insightOutput(context, history, results),
    record_window: Object.keys(recordWindow).length ? recordWindow : null,
  };
}
export function readDatabaseLooseEnds(
  context: DatabaseInsightContext,
  options: PreparedInsight,
  now = new Date().toISOString()
) {
  const history = readInsightHistory(context, options);
  const results: ArtifactLooseEndsView[] = [];
  for (const item of history.artifacts) {
    const thread = item.artifact!.thread;
    const findings = collectLooseEnds({
      planSteps: thread.plan?.plan_steps ?? [],
      closedCheckpoints: thread.checkpoints.filter((cp) => cp.status === 'closed'),
      openCheckpoints: thread.checkpoints.filter((cp) => cp.status === 'open'),
      summary: thread.summary,
      now,
    });
    if (findings.finding_count) results.push({ ...insightIdentity(item), ...findings });
  }
  return {
    ...insightOutput(context, history, results),
    window_semantics: 'selects-artifacts-only' as const,
  };
}
export function formatDatabaseInsightCompleteness(
  result: ReturnType<typeof readDatabaseDecisions> | ReturnType<typeof readDatabaseLooseEnds>
) {
  const lines: string[] = [];
  if (!result.completeness.complete)
    lines.push('Results are incomplete; unavailable history may contain additional findings.');
  for (const issue of result.completeness.issues)
    lines.push(`${issue.project_id ?? 'scope'}: ${issue.code}: ${issue.message}`);
  if (result.page.next_offset !== null)
    lines.push(`Next page: --offset ${result.page.next_offset}`);
  lines.push(
    `Inspected ${result.page.inspected} artifact(s); returned ${result.origin_counts.returned.captured} captured, ${result.origin_counts.returned.imported} imported.`
  );
  return lines.join('\n') + '\n';
}
