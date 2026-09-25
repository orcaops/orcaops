import type { EffectiveProcessingLimits } from '@orcaops/core';
import {
  type GaveUpProcessingJobs,
  knowledgeBoundaryAt,
  openProjectDatabase,
  type ProcessingBacklog,
  type ProcessingControl,
  type ProcessingLease,
  type ProcessingQueue,
  type ProcessingUsageWindows,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  readGaveUpProcessingJobs,
  readProcessingBacklog,
  readProcessingControl,
  readProcessingLease,
  readProcessingQueue,
  readProcessingUsageWindows,
} from '@orcaops/storage/history/database';

import { resolveDatabaseHistoryCommandContext } from './database-history-context.js';

/**
 * What the project database says about background processing, read-only. It
 * opens no store it would have to create, upgrades nothing and writes nothing:
 * a database this build cannot read is reported as what it is, so `status`,
 * `doctor` and the enable flow can say so instead of failing.
 */
export type { ProcessingBacklog } from '@orcaops/storage/history/database';

export type ProcessingHistoryProblem =
  /** No project database exists here yet, so nothing has been admitted. */
  | { code: 'no_history'; message: string }
  /** An earlier release wrote it; the explicit upgrade is named, never performed. */
  | { code: 'upgrade_required'; message: string }
  | { code: 'unreadable'; message: string };

/**
 * Which project database, in which checkout. Everything that can wake a worker
 * needs both, and both are already resolved by the read that found the queue,
 * so neither is looked up twice.
 */
export interface ProcessingProjectTarget {
  repoRoot: string;
  authority: ProjectDatabaseAuthority;
}

export interface ProcessingHistory {
  /** Null exactly when the queue below was read from the project database. */
  problem: ProcessingHistoryProblem | null;
  backlog: ProcessingBacklog;
  queue: ProcessingQueue | null;
  control: ProcessingControl | null;
  lease: ProcessingLease | null;
  usage: ProcessingUsageWindows | null;
  /** The jobs that gave up most recently, and how many there are. Null when no queue was read. */
  gaveUp: GaveUpProcessingJobs | null;
  /** Null when no project database was found, so nothing could be woken. */
  target: ProcessingProjectTarget | null;
  /**
   * The store's committed write sequence: what "now" is for a read here. Null when no queue was
   * read. Processing coverage compares the newest admitted job against it.
   */
  boundary: number | null;
}

export interface ProcessingHistoryRequest {
  /** Windows are computed against the limits in force; absent, they are left unread. */
  limits?: EffectiveProcessingLimits;
  /** How many of the jobs that gave up to read; the total is always counted. */
  gaveUpLimit?: number;
  now?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const NOTHING_ADMITTED: ProcessingBacklog = { paused_jobs: 0, latest_admitted_sequence: null };

function targetOf(
  scope: { gitContext: { worktreeRoot: string } | null },
  authority: ProjectDatabaseAuthority | null
): ProcessingProjectTarget | null {
  const repoRoot = scope.gitContext?.worktreeRoot;
  return repoRoot === undefined || authority === null ? null : { repoRoot, authority };
}

function problemOfCause(cause: unknown): ProcessingHistoryProblem {
  return problemOf(
    cause instanceof Error && 'code' in cause ? String(cause.code) : 'HISTORY_INACCESSIBLE',
    cause instanceof Error ? cause.message : String(cause)
  );
}

function problemOf(code: string, message: string): ProcessingHistoryProblem {
  // The refusal already names the command that performs the upgrade, so it is
  // carried word for word rather than restated here.
  if (code === 'HISTORY_UPGRADE_REQUIRED') return { code: 'upgrade_required', message };
  if (code === 'HISTORY_MISSING' || code === 'LEGACY_HISTORY_PRESENT')
    return { code: 'no_history', message };
  return { code: 'unreadable', message };
}

/**
 * The project database opened for a write to the scheduling tables: the pause,
 * the resume and the operator retry. It is the same project selection the read
 * uses, so a database this build cannot read refuses the write with the same
 * answer instead of a raw error.
 */
export async function withProcessingWriter<T>(
  request: { cwd?: string; env?: NodeJS.ProcessEnv },
  use: (handle: ProjectDatabase) => Promise<T>
): Promise<
  | { ok: true; value: T; target: ProcessingProjectTarget | null }
  | { ok: false; problem: ProcessingHistoryProblem }
> {
  let context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>;
  try {
    context = await resolveDatabaseHistoryCommandContext({
      profile: 'status',
      selector: { scope: 'project' },
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.env === undefined ? {} : { env: request.env }),
    });
  } catch (cause) {
    return { ok: false, problem: problemOfCause(cause) };
  }
  let authority;
  let target: ProcessingProjectTarget | null = null;
  try {
    const project = context.scope.projects[0];
    if (!project?.authority || !project.database) {
      const first = project?.completeness.issues[0];
      return {
        ok: false,
        problem: project
          ? problemOf(
              first?.code ?? 'HISTORY_INACCESSIBLE',
              first?.message ?? 'The project database cannot be read.'
            )
          : { code: 'no_history', message: 'This repository has no orcaops project history yet.' },
      };
    }
    authority = { ...project.authority };
    target = targetOf(context.scope, authority);
  } finally {
    context.scope.close();
  }
  const handle = await openProjectDatabase({ authority, mode: 'writer' });
  try {
    return { ok: true, value: await use(handle), target };
  } finally {
    handle.close();
  }
}

/**
 * The queue as one project database already open for reading holds it. A surface that has the
 * handle in hand reads it here rather than resolving a second scope of its own: two readings of
 * the same queue is how two surfaces start printing different numbers for one store.
 */
export function readProjectProcessingHistory(
  handle: ProjectDatabase,
  request: {
    target?: ProcessingProjectTarget | null;
    limits?: EffectiveProcessingLimits;
    now?: string;
    gaveUpLimit?: number;
  } = {}
): ProcessingHistory {
  return {
    problem: null,
    target: request.target ?? null,
    boundary: handle.read((view) => knowledgeBoundaryAt(view)).value,
    backlog: readProcessingBacklog(handle),
    queue: readProcessingQueue(handle),
    control: readProcessingControl(handle),
    lease: readProcessingLease(handle),
    usage:
      request.limits === undefined
        ? null
        : readProcessingUsageWindows(handle, {
            now: request.now ?? new Date().toISOString(),
            maxCallsPerHour: request.limits.max_calls_per_hour,
            maxCostUsdPerDay:
              request.limits.max_cost_usd_per_day === 'none'
                ? undefined
                : request.limits.max_cost_usd_per_day,
          }),
    gaveUp: readGaveUpProcessingJobs(handle, request.gaveUpLimit),
  };
}

export async function readProcessingHistory(
  request: ProcessingHistoryRequest = {}
): Promise<ProcessingHistory> {
  const empty = {
    backlog: NOTHING_ADMITTED,
    queue: null,
    control: null,
    lease: null,
    usage: null,
    gaveUp: null,
    target: null,
    boundary: null,
  };
  let context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>;
  try {
    context = await resolveDatabaseHistoryCommandContext({
      profile: 'status',
      selector: { scope: 'project' },
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.env === undefined ? {} : { env: request.env }),
    });
  } catch (cause) {
    return { ...empty, problem: problemOfCause(cause) };
  }
  try {
    const project = context.scope.projects[0];
    if (!project)
      return {
        ...empty,
        problem: {
          code: 'no_history',
          message: 'This repository has no orcaops project history yet.',
        },
      };
    if (!project.database) {
      const first = project.completeness.issues[0];
      return {
        ...empty,
        problem: problemOf(
          first?.code ?? 'HISTORY_INACCESSIBLE',
          first?.message ?? 'The project database cannot be read.'
        ),
      };
    }
    return readProjectProcessingHistory(project.database, {
      target: targetOf(context.scope, project.authority),
      ...(request.limits === undefined ? {} : { limits: request.limits }),
      ...(request.now === undefined ? {} : { now: request.now }),
      ...(request.gaveUpLimit === undefined ? {} : { gaveUpLimit: request.gaveUpLimit }),
    });
  } catch (cause) {
    return { ...empty, problem: problemOfCause(cause) };
  } finally {
    context.scope.close();
  }
}
