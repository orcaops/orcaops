import {
  type HistoryFilters,
  type HistoryIssue,
  HistoryScopeError,
  type HistorySelector,
  normalizeHistoryFilters,
  validateHistorySelector,
} from '@orcaops/project-scope/history';
import type { DatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { type Config, type EvaluatorRunStatsRow, redactSecretsInObject } from '@orcaops/storage';
import {
  ProjectDatabaseError,
  type ProjectStatistics,
  type ProjectUsageAccountingInput,
  readProjectStatistics,
  readProjectUsageAccounting,
  type UsageSession,
} from '@orcaops/storage/history/database';
import {
  aggregateCanonicalUsage,
  type UsageAccountingInput,
  usageSessionKey,
} from '@orcaops/storage/history/usage-accounting';

import { aggregateUsageModels } from './canonical-usage-display.js';
import type { DiffAttributionOutcome } from './database-diff.js';
import {
  computeDurationStats,
  computeEvaluatorRates,
  computeRevisionChurn,
} from './history-views.js';

export interface DatabaseStatsOptions {
  scope?: HistorySelector['scope'];
  project?: string;
  branch?: string;
  origin?: HistoryFilters['origin'];
  state?: HistoryFilters['state'];
  touching?: string;
  json?: boolean;
}
export interface DatabaseStatsContext {
  scope: DatabaseHistoryScope;
  config: Pick<Config, 'digest' | 'capture' | 'diff_fingerprint'>;
}

const DIFF_ATTRIBUTION_NOTE =
  "unambiguous hunk-level attribution of the current branch's latest artifact window " +
  '(base_sha → worktree, including untracked files), measured through the same worktree tree ' +
  'capture `diff --attribution` uses: it writes unreferenced Git tree objects and leaves the real ' +
  'index and every ref untouched; null when the window has no hunks or the measurement was not ' +
  'available, see diff_attribution';

export function validateDatabaseStats(input: DatabaseStatsOptions = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide stats options as an object');
  const allowed = ['scope', 'project', 'branch', 'origin', 'state', 'touching', 'json'];
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key))
      throw new HistoryScopeError('INVALID_INPUT', 'Unsupported or retired stats option');
    if (value !== undefined && typeof value !== (key === 'json' ? 'boolean' : 'string'))
      throw new HistoryScopeError(
        'INVALID_INPUT',
        'Stats selectors must be strings and JSON output boolean'
      );
  }
  const selector: HistorySelector = {
    scope: input.scope,
    projectId: input.project,
    branch: input.branch,
  };
  validateHistorySelector({ profile: 'collection', selector });
  const filters = normalizeHistoryFilters({
    origin: input.origin,
    state: input.state,
    touching: input.touching,
  });
  return { selector, profile: 'collection' as const, filters, json: input.json === true };
}

interface StatusBreakdown {
  total: number;
  by_status: Record<string, number>;
}
interface CountedProject {
  projectId: string;
  storeInstanceId: string;
  statistics: ProjectStatistics;
  usage: UsageAccountingInput;
  accountingWriteSequence: number | null;
}
function count(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
function artifactStatus(state: string): 'active' | 'complete' {
  return state === 'summarized' ? 'complete' : 'active';
}
function checkpointBreakdown(artifacts: ProjectStatistics['artifacts']): StatusBreakdown {
  const by_status: Record<string, number> = {};
  for (const status of ['open', 'closed', 'abandoned'] as const) {
    const total = artifacts.reduce(
      (sum, artifact) => sum + artifact.details.statistics.checkpointCounts[status],
      0
    );
    if (total > 0) by_status[status] = total;
  }
  return { total: Object.values(by_status).reduce((sum, value) => sum + value, 0), by_status };
}
function baseSections(artifacts: ProjectStatistics['artifacts']) {
  return {
    artifacts: {
      total: artifacts.length,
      by_status: count(artifacts.map(({ row }) => artifactStatus(row.state))),
      by_state: count(artifacts.map(({ row }) => row.state)),
    },
    checkpoints: checkpointBreakdown(artifacts),
    summaries: { total: artifacts.filter(({ row }) => row.completedAt !== null).length },
    imported_artifacts: artifacts.filter(({ row }) => row.origin === 'git-import').length,
  };
}
function evaluatorRows(artifacts: ProjectStatistics['artifacts']): EvaluatorRunStatsRow[] {
  const rows = new Map<string, EvaluatorRunStatsRow>();
  for (const artifact of artifacts)
    for (const run of artifact.details.evaluatorRuns) {
      const key = JSON.stringify([run.evaluator_ref, run.phase]);
      const row = rows.get(key) ?? {
        evaluator_ref: run.evaluator_ref,
        phase: run.phase,
        total: 0,
        completed: 0,
        pass: 0,
        violation: 0,
        info: 0,
        error: 0,
        skipped: 0,
      };
      row.total += 1;
      if (
        run.run_status === 'completed' ||
        run.run_status === 'error' ||
        run.run_status === 'skipped'
      )
        row[run.run_status] += 1;
      if (
        run.run_status === 'completed' &&
        (run.verdict === 'pass' || run.verdict === 'violation' || run.verdict === 'info')
      )
        row[run.verdict] += 1;
      rows.set(key, row);
    }
  return [...rows.values()].sort(
    (a, b) => a.evaluator_ref.localeCompare(b.evaluator_ref) || a.phase.localeCompare(b.phase)
  );
}
function hygieneCounts(artifacts: ProjectStatistics['artifacts']) {
  const captured = artifacts.filter(({ row }) => row.origin === 'captured');
  const finished = captured.filter(({ row }) => row.completedAt !== null);
  const sum = (
    select: (statistics: ProjectStatistics['artifacts'][number]['details']['statistics']) => number
  ) => captured.reduce((total, artifact) => total + select(artifact.details.statistics), 0);
  return {
    open_checkpoints_on_finished_artifacts: finished.reduce(
      (total, artifact) => total + artifact.details.statistics.checkpointCounts.open,
      0
    ),
    // A zero-run pre-PR dispatch still records a lifecycle completion, so the
    // completion row is the fact, never the evaluator run count.
    summaries_without_pre_pr_run: finished.some((artifact) => artifact.lifecycles === null)
      ? null
      : finished.filter(
          (artifact) =>
            !artifact.lifecycles!.some((completion) => completion.record.fires_at === 'pre-pr')
        ).length,
    closed_cp_without_completed_steps: sum((statistics) => statistics.closedWithoutCompletedSteps),
    closed_cp_without_uncertainty: sum((statistics) => statistics.closedWithoutUncertainty),
    closed_cp_without_decisions: sum((statistics) => statistics.closedWithoutDecisions),
    closed_cp_without_files_changed: sum((statistics) => statistics.closedWithoutFiles),
  };
}

/**
 * The passive statistics read. `attribution` is measured by the caller before
 * this read, because it is the one number here that is not a project-database
 * read: it captures the live worktree tree through Git. Passing it in keeps
 * every read below synchronous and transaction-free of awaits, and keeps a
 * caller that measured nothing reporting the absence instead of a number.
 */
export function readDatabaseStats(
  context: DatabaseStatsContext,
  input: DatabaseStatsOptions = {},
  attribution: DiffAttributionOutcome
) {
  const options = validateDatabaseStats(input);
  const scope = context.scope;
  if (
    (options.selector.scope !== undefined && options.selector.scope !== scope.kind) ||
    (options.selector.branch !== undefined && options.selector.branch !== scope.branch.value) ||
    (options.selector.projectId !== undefined &&
      (scope.projects.length !== 1 || scope.projects[0].projectId !== options.selector.projectId))
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'Stats options differ from the opened history scope'
    );
  const issues: HistoryIssue[] = structuredClone(scope.completeness.issues);
  const counted: CountedProject[] = [];
  const unknown = new Set<string>();
  const unavailable = (projectId: string, cause: unknown) => {
    if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
    unknown.add(projectId);
    issues.push({
      code: cause instanceof ProjectDatabaseError ? cause.code : 'HISTORY_INACCESSIBLE',
      project_id: projectId,
      message:
        cause instanceof Error
          ? cause.message
          : 'Project statistics cannot be read; check access and repeat the original scope',
    });
  };
  if (scope.branch.source === 'unavailable') {
    issues.push({
      code: 'BRANCH_SELECTION_UNAVAILABLE',
      project_id: null,
      message: 'Current branch is unavailable; select an explicit branch or project collection',
    });
    for (const project of scope.projects) unknown.add(project.projectId);
  } else
    for (const project of scope.projects) {
      const database = project.database;
      if (!database) {
        unknown.add(project.projectId);
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
          database.authority.projectId !== project.projectId ||
          database.authority.storeInstanceId !== project.authority?.storeInstanceId ||
          database.authority.rootKey !== scope.root.rootKey ||
          database.authority.resolvedRoot !== scope.root.resolvedRoot
        )
          throw new ProjectDatabaseError(
            'AUTHORITY_MISMATCH',
            'Selected project differs from its opened database; resolve the original scope again'
          );
        const statistics = readProjectStatistics(database, {
          branch: scope.branch.value ?? undefined,
          worktreeId:
            scope.kind === 'worktree' ? (scope.gitContext?.worktreeId ?? undefined) : undefined,
          origin: options.filters.origin,
          state: options.filters.state,
          touching: options.filters.touching,
        });
        for (const issue of statistics.issues)
          issues.push({
            code: issue.code,
            project_id: project.projectId,
            resource: issue.resource,
            ...(issue.artifactId === undefined ? {} : { artifact_id: issue.artifactId }),
            message: issue.message,
          });
        if (statistics.unknownAssociations)
          issues.push({
            code: 'UNKNOWN_WORKTREE_ASSOCIATION',
            project_id: project.projectId,
            count: statistics.unknownAssociations,
            message:
              'Some matching artifacts have unknown worktree associations; use project scope to inspect them',
          });
        counted.push({
          projectId: project.projectId,
          storeInstanceId: database.authority.storeInstanceId,
          statistics,
          usage: statistics.usage ?? {
            projectId: project.projectId,
            events: [],
            unavailable: statistics.issues
              .filter((issue) => issue.resource === 'usage')
              .map((issue) => issue.message),
          },
          accountingWriteSequence:
            statistics.usage === null ? null : statistics.counters.writeSequence,
        });
      } catch (cause) {
        unavailable(project.projectId, cause);
      }
    }
  // Session tuples observed by one project select that session's complete
  // observations in every other counted project, as the usage command does.
  const union = new Map<string, UsageSession>();
  for (const project of counted)
    for (const session of project.statistics.sessions)
      union.set(usageSessionKey(session.agent, session.sessionId), session);
  for (const project of counted) {
    if (project.statistics.usage === null) continue;
    const own = new Set(
      project.statistics.sessions.map((session) =>
        usageSessionKey(session.agent, session.sessionId)
      )
    );
    if ([...union.keys()].every((key) => own.has(key))) continue;
    const database = scope.projects.find(
      (entry) => entry.projectId === project.projectId
    )!.database!;
    try {
      const accounting: ProjectUsageAccountingInput = readProjectUsageAccounting(database, {
        artifactIds: project.statistics.filtered
          ? project.statistics.artifacts.map(({ row }) => row.artifactId)
          : undefined,
        sessions: [...union.values()],
        expectedWriteSequence: project.statistics.counters.writeSequence,
      });
      project.usage = accounting;
      project.accountingWriteSequence = accounting.counters.writeSequence;
    } catch (cause) {
      if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
      const message =
        cause instanceof Error
          ? cause.message
          : 'Usage cannot be read; check access and repeat the original scope';
      issues.push({
        code: cause instanceof ProjectDatabaseError ? cause.code : 'HISTORY_INACCESSIBLE',
        project_id: project.projectId,
        resource: 'usage',
        message,
      });
      project.usage = { projectId: project.projectId, events: [], unavailable: [message] };
      project.accountingWriteSequence = null;
    }
  }
  if (!scope.completeness.complete && !issues.length)
    issues.push({
      code: 'HISTORY_INCOMPLETE',
      project_id: null,
      message: 'Selected history scope is incomplete',
    });
  const inputs = counted.map((project) => project.usage);
  if (issues.length)
    inputs.push({ projectId: '', events: [], unavailable: issues.map((issue) => issue.message) });
  const accounting = aggregateCanonicalUsage(inputs);
  const artifacts = counted.flatMap((project) => project.statistics.artifacts);
  const captured = artifacts.filter(({ row }) => row.origin === 'captured');
  const complete = scope.completeness.complete && issues.length === 0;
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
    ...baseSections(artifacts),
    coding_sessions: { total: accounting.sessions.length, tokens: accounting.totals },
    evaluators: { by_evaluator: computeEvaluatorRates(evaluatorRows(artifacts)) },
    plan_revisions: computeRevisionChurn(
      captured.map((artifact) => ({
        max_revision_n: artifact.details.statistics.maximumPlanRevision,
      }))
    ),
    checkpoint_durations: computeDurationStats(
      captured.flatMap((artifact) =>
        artifact.details.statistics.closedIntervals.map((interval) => ({
          opened_at: interval.openedAt,
          closed_at: interval.closedAt,
        }))
      )
    ),
    hygiene: {
      ...hygieneCounts(artifacts),
      diff_attributed_pct: attribution.state === 'measured' ? attribution.attributed_pct : null,
      diff_attribution: { ...attribution },
      notes: { diff_attributed_pct: DIFF_ATTRIBUTION_NOTE },
    },
    usage: {
      accounting,
      model_totals: aggregateUsageModels(accounting),
      projects: counted.map((project) => ({
        project_id: project.projectId,
        store_instance_id: project.storeInstanceId,
        write_sequence: project.statistics.counters.writeSequence,
        intent_change_counter: project.statistics.counters.intentChangeCounter,
        accounting_write_sequence: project.accountingWriteSequence,
      })),
      issues: issues.filter((issue) => issue.resource === 'usage'),
    },
    projects: scope.projects.map((project) => {
      const entry = counted.find((candidate) => candidate.projectId === project.projectId);
      const rows = entry?.statistics.artifacts ?? [];
      const projectIssues = issues.filter((issue) => issue.project_id === project.projectId);
      return {
        project_id: project.projectId,
        project: project.projectId,
        state: entry ? ('counted' as const) : ('unknown' as const),
        completeness: {
          complete: projectIssues.length === 0 && entry !== undefined,
          issues: projectIssues,
        },
        ...baseSections(rows),
        coding_sessions: { total: entry?.statistics.sessions.length ?? 0 },
      };
    }),
    coverage: {
      counted_projects: counted.map((project) => project.projectId),
      unknown_projects: [...unknown].sort(),
    },
    sources: counted.map((project) => ({
      project_id: project.projectId,
      store_instance_id: project.storeInstanceId,
      counters: { ...project.statistics.counters },
    })),
    completeness: { complete, issues },
    integrity: { source_observation: 'read-transaction' as const },
  };
  return context.config.digest.redact_secrets ? redactSecretsInObject(output) : output;
}
export type DatabaseStatsResult = ReturnType<typeof readDatabaseStats>;

function renderByStatus(byStatus: Record<string, number>): string {
  const parts = Object.entries(byStatus).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
function tokens(value: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}): string {
  return `in ${value.input_tokens} / out ${value.output_tokens} / cache-write ${value.cache_creation_input_tokens} / cache-read ${value.cache_read_input_tokens} tokens`;
}
export function formatDatabaseStats(result: DatabaseStatsResult): string {
  const lines = [
    result.scope.kind === 'all-projects' ? 'Store stats (all projects)' : 'Store stats',
    `  artifacts:   ${result.artifacts.total}${renderByStatus(result.artifacts.by_status)}`,
    ...(result.imported_artifacts > 0
      ? [`  imported:    ${result.imported_artifacts} (excluded from duration aggregates)`]
      : []),
    `  checkpoints: ${result.checkpoints.total}${renderByStatus(result.checkpoints.by_status)}`,
    `  summaries:   ${result.summaries.total}`,
    `  coding sessions: ${result.coding_sessions.total}` +
      (result.coding_sessions.tokens
        ? ` (${tokens(result.coding_sessions.tokens)})`
        : result.coding_sessions.total > 0 || result.usage.accounting.status !== 'exact'
          ? ` (exact totals ${result.usage.accounting.status}` +
            (result.usage.accounting.known_exact_totals
              ? `; known complete sessions only: ${tokens(result.usage.accounting.known_exact_totals)})`
              : ')')
          : ''),
  ];
  const rates = result.evaluators.by_evaluator;
  if (rates.length > 0) {
    lines.push('  evaluator pass rates (pass / graded):');
    for (const rate of rates)
      lines.push(
        `    ${rate.evaluator_ref} [${rate.phase}]: ${rate.pass_rate === null ? 'n/a' : `${Math.round(rate.pass_rate * 100)}%`} (${rate.pass}/${rate.pass + rate.violation} graded, ${rate.total} runs)`
      );
  }
  const churn = result.plan_revisions;
  if (churn.artifacts_with_plan > 0)
    lines.push(
      `  plan revisions: ${churn.revised_artifacts}/${churn.artifacts_with_plan} artifacts revised (max ${churn.max_revisions})`
    );
  const durations = result.checkpoint_durations;
  if (durations.closed_total > 0) {
    const seconds = (ms: number | null): string =>
      ms === null ? 'n/a' : `${Math.round(ms / 1000)}s`;
    lines.push(
      `  checkpoint durations: median ${seconds(durations.median_ms)} · p90 ${seconds(durations.p90_ms)} · max ${seconds(durations.max_ms)} (${durations.closed_total} closed)`
    );
  }
  const hygiene = Object.entries(result.hygiene).filter(
    (entry): entry is [string, number] =>
      entry[0] !== 'diff_attributed_pct' && typeof entry[1] === 'number' && entry[1] > 0
  );
  if (hygiene.length > 0) {
    lines.push('  hygiene flags:');
    for (const [key, value] of hygiene) lines.push(`    ${key}: ${value}`);
  }
  if (result.hygiene.summaries_without_pre_pr_run === null)
    lines.push(
      '  hygiene: summaries_without_pre_pr_run is unknown; lifecycle history is unreadable'
    );
  const attribution = result.hygiene.diff_attribution;
  lines.push(
    `  diff attribution: ` +
      (attribution.state === 'measured'
        ? attribution.attributed_pct === null
          ? 'measured (no hunks in the window)'
          : `${attribution.attributed_pct}% of hunks attributed`
        : `unavailable (${attribution.reason})`)
  );
  if (result.scope.kind === 'all-projects' || result.projects.length > 1) {
    lines.push('  projects:');
    for (const project of result.projects)
      lines.push(
        project.state === 'counted'
          ? `    ${project.project}: ${project.artifacts.total} artifacts, ${project.checkpoints.total} checkpoints, ${project.summaries.total} summaries, ${project.coding_sessions.total} sessions`
          : `    ${project.project}: unknown (${project.completeness.issues.map((issue) => issue.code).join(', ') || 'unavailable'})`
      );
  }
  if (result.coverage.unknown_projects.length > 0)
    lines.push(
      `  Unknown contributions: ${result.coverage.unknown_projects.length} project(s) unavailable; counts are known contributions only.`
    );
  for (const issue of result.completeness.issues)
    lines.push(`  ${issue.project_id ?? 'scope'}: ${issue.code}: ${issue.message}`);
  lines.push('');
  return lines.join('\n');
}
