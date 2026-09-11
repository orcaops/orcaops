import type { z } from 'zod';

import {
  hydrateProjectLifecycleCompletions,
  selectProjectLifecycleCompletions,
} from './capture-lifecycles.js';
import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError, type ProjectDatabaseErrorCode } from './errors.js';
import { ArtifactQueryDetailsSchema } from './query-metadata-records.js';
import {
  hydrateProjectArtifactRows,
  prepareProjectArtifactQuery,
  type ProjectArtifactQuery,
  type ProjectArtifactQueryRow,
  selectProjectArtifactRows,
} from './query.js';
import {
  hydrateProjectUsageAccounting,
  type ProjectUsageAccountingInput,
  selectProjectUsageAccounting,
  type UsageSession,
} from './usage-accounting.js';
import { usageSessionKey } from '../usage-accounting.js';

export type ArtifactQueryDetails = z.infer<typeof ArtifactQueryDetailsSchema>;
export type ProjectStatisticsQuery = Pick<
  ProjectArtifactQuery,
  'branch' | 'worktreeId' | 'origin' | 'state' | 'touching'
>;
export type ProjectLifecycleCompletion = ReturnType<
  typeof hydrateProjectLifecycleCompletions
>['records'][number];
export interface ProjectStatisticsArtifact {
  row: ProjectArtifactQueryRow;
  details: ArtifactQueryDetails;
  /** Null when this artifact's retained lifecycle selections could not be read. */
  lifecycles: ProjectLifecycleCompletion[] | null;
}
export interface ProjectStatisticsIssue {
  code: ProjectDatabaseErrorCode;
  resource: 'lifecycle' | 'usage';
  artifactId?: string;
  message: string;
}
export interface ProjectStatistics {
  artifacts: ProjectStatisticsArtifact[];
  counts: { captured: number; imported: number };
  unknownAssociations: number;
  /** True when any selector narrowed the collection, so usage follows the selected artifacts. */
  filtered: boolean;
  sessions: UsageSession[];
  usage: ProjectUsageAccountingInput | null;
  issues: ProjectStatisticsIssue[];
  counters: ProjectCounters;
}

const selectorKeys = ['branch', 'worktreeId', 'origin', 'state', 'touching'] as const;

export function prepareProjectStatisticsQuery(raw: ProjectStatisticsQuery = {}) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !(selectorKeys as readonly string[]).includes(key))
  )
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide fixed statistics selectors');
  const query = prepareProjectArtifactQuery({
    branch: raw.branch,
    worktreeId: raw.worktreeId,
    origin: raw.origin,
    state: raw.state,
    touching: raw.touching,
    profile: 'details',
  });
  const filtered =
    query.branch !== undefined ||
    query.worktreeId !== undefined ||
    query.origin !== 'all' ||
    query.state !== undefined ||
    query.touching !== undefined;
  return { query, filtered };
}

type SelectedRecords<T> =
  | { kind: 'selected'; value: T }
  | { kind: 'unavailable'; code: ProjectDatabaseErrorCode; message: string };

function attempt<T>(select: () => T): SelectedRecords<T> {
  try {
    return { kind: 'selected', value: select() };
  } catch (cause) {
    if (!(cause instanceof ProjectDatabaseError) || cause.code === 'CANCELLED') throw cause;
    return { kind: 'unavailable', code: cause.code, message: cause.message };
  }
}

function selectProjectStatistics(
  view: ProjectReadView,
  prepared: ReturnType<typeof prepareProjectStatisticsQuery>
) {
  const selected = selectProjectArtifactRows(view, prepared.query);
  const ids = selected.rows.map((row) => row.artifactId);
  const lifecycles = ids.map((artifactId) => ({
    artifactId,
    records: attempt(() => selectProjectLifecycleCompletions(view, artifactId)),
  }));
  const usage = attempt(() =>
    selectProjectUsageAccounting(view, prepared.filtered ? ids : undefined)
  );
  return { selected, lifecycles, usage, filtered: prepared.filtered };
}

function hydrateProjectStatistics(
  projectId: string,
  snapshot: { value: ReturnType<typeof selectProjectStatistics>; counters: ProjectCounters }
): ProjectStatistics {
  const counters = snapshot.counters;
  const selected = hydrateProjectArtifactRows({ value: snapshot.value.selected, counters });
  const issues: ProjectStatisticsIssue[] = [];
  const artifacts = selected.rows.map((row, index) => {
    let details: ArtifactQueryDetails;
    try {
      details = ArtifactQueryDetailsSchema.parse(JSON.parse(row.detailsJson!));
    } catch (cause) {
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Selected statistics metadata is invalid; explicitly rebuild from original records',
        { cause }
      );
    }
    const lifecycle = snapshot.value.lifecycles[index];
    let lifecycles: ProjectLifecycleCompletion[] | null = null;
    if (lifecycle.records.kind === 'selected') {
      try {
        lifecycles = hydrateProjectLifecycleCompletions({
          value: lifecycle.records.value,
          counters,
        }).records;
      } catch (cause) {
        if (!(cause instanceof ProjectDatabaseError)) throw cause;
        issues.push({
          code: cause.code,
          resource: 'lifecycle',
          artifactId: row.artifactId,
          message: cause.message,
        });
      }
    } else
      issues.push({
        code: lifecycle.records.code,
        resource: 'lifecycle',
        artifactId: row.artifactId,
        message: lifecycle.records.message,
      });
    return { row, details, lifecycles };
  });
  const ids = artifacts.map(({ row }) => row.artifactId);
  let usage: ProjectUsageAccountingInput | null = null;
  const sessions = new Map<string, UsageSession>();
  if (snapshot.value.usage.kind === 'selected') {
    for (const row of snapshot.value.usage.value.snapshots)
      sessions.set(usageSessionKey(row.agent, row.sessionId), {
        agent: row.agent,
        sessionId: row.sessionId,
      });
    try {
      usage = hydrateProjectUsageAccounting(projectId, snapshot.value.filtered ? ids : undefined, {
        value: snapshot.value.usage.value,
        counters,
      });
    } catch (cause) {
      if (!(cause instanceof ProjectDatabaseError)) throw cause;
      issues.push({ code: cause.code, resource: 'usage', message: cause.message });
    }
  } else
    issues.push({
      code: snapshot.value.usage.code,
      resource: 'usage',
      message: snapshot.value.usage.message,
    });
  return {
    artifacts,
    counts: selected.counts,
    unknownAssociations: selected.unknownAssociations,
    filtered: snapshot.value.filtered,
    sessions: [...sessions.values()],
    usage,
    issues,
    counters,
  };
}

export function readProjectStatistics(
  handle: ProjectDatabase,
  raw: ProjectStatisticsQuery = {}
): ProjectStatistics {
  const prepared = prepareProjectStatisticsQuery(raw);
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => selectProjectStatistics(view, prepared));
  return hydrateProjectStatistics(handle.authority.projectId, snapshot);
}
