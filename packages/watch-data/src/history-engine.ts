import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import type { KnowledgeBlock } from '@orcaops/core';
import {
  type DatabaseHistoryProject,
  type DatabaseHistoryScope,
  type HistoryIssue,
  type HistoryScopeInput,
  resolveDatabaseHistoryScope,
} from '@orcaops/project-scope/history/database';
import { isUuidV7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  type ProjectArtifactQueryRow,
  type ProjectCounters,
  type ProjectDatabase,
  projectDatabasePath,
  queryProjectArtifacts,
  readProjectArtifactDetails,
  readProjectDisplayName,
  readProjectRepositoryCreation,
  readProjectUsageAccounting,
  repositoryDisplayName,
} from '@orcaops/storage/history/database';
import {
  aggregateCanonicalUsage,
  type UsageAccountingInput,
  type UsageAccountingResult,
} from '@orcaops/storage/history/usage-accounting';

import { AgentActivityReader, type AgentActivityReaderLike } from './agent-activity.js';
import { readCurrentBranch } from './current-branch.js';
import { readThreadsKnowledge } from './history-knowledge.js';
import {
  artifactStatus,
  parseWatchMetadata,
  revisionToken,
  type ThreadDetail,
  threadDetail,
  timestampMs,
} from './history-thread.js';
import { classifyAgent, DEFAULT_THRESHOLDS, type Thresholds } from './liveness.js';
import { countOpenReviewComments, selectReviewComments } from './review-comments.js';
import { bucketize } from './sparkline.js';
import type {
  SessionTokens,
  TickerEvent,
  WatchProject,
  WatchSnapshot,
  WatchThread,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Only thread activity written within this window feeds sparklines and the ticker. */
const TAIL_ACTIVE_MS = 60 * 60 * 1000;
const TICKER_MAX = 50;
const RECENT_EVENTS_MAX = 50;
/** A refresh whose reads observe different write sequences is repeated this many times. */
const REFRESH_ATTEMPTS = 2;
/** A resolution whose inventory stamp moved across it is repeated this many times. */
const SCOPE_ATTEMPTS = 2;

export interface HistoryEngineOptions {
  scope: HistoryScopeInput;
  thresholds?: Thresholds;
  activityReader?: AgentActivityReaderLike;
}

/** Per-tick stage timings, for the refresh latency evidence. */
export interface HistoryTickTimings {
  totalMs: number;
  scopeMs: number;
  stampMs: number;
  selectionMs: number;
  hydrationMs: number;
  usageMs: number;
  reviewMs: number;
  activityMs: number;
  /** Projects whose display was reused because their write sequence was unchanged. */
  reusedProjects: number;
  refreshedProjects: number;
  hydratedArtifacts: number;
  selectedRows: number;
}

interface CachedDetail {
  revision: string;
  executionVersion: number | null;
  detail: ThreadDetail;
}

/** Everything a thread needs that does not move between ticks of one write sequence. */
interface ThreadBase {
  artifactId: string;
  version: string;
  row: ProjectArtifactQueryRow;
  branch: string;
  currentLine: string | null;
  currentLineTruncated: boolean;
  events: Array<{ ts: string; tsMs: number; type: string }>;
  omittedEvents: number;
  storedLastWriteMs: number | null;
  sessions: SessionTokens[];
  detail: ThreadDetail;
  /** Null when the project's continuing knowledge could not be read this tick. */
  knowledge: KnowledgeBlock | null;
  /** The code that read failed with, so a pane can say so rather than print nothing. */
  knowledgeUnavailable: string | null;
}

interface ProjectDisplay {
  displayName: string;
  repository: WatchProject['repository'];
  authorityKey: string;
  writeSequence: number;
  threads: ThreadBase[];
  comments: Map<string, number> | null;
  usage: UsageAccountingInput;
  issues: HistoryIssue[];
}

function distinctHistoryIssues(issues: HistoryIssue[]): HistoryIssue[] {
  return [
    ...new Map(
      issues.map((issue) => [
        JSON.stringify([
          issue.code,
          issue.project_id,
          issue.artifact_id,
          issue.resource,
          issue.message,
          issue.count,
        ]),
        issue,
      ])
    ).values(),
  ];
}

function issueFrom(projectId: string | null, cause: unknown): HistoryIssue {
  return {
    code:
      cause !== null && typeof cause === 'object' && 'code' in cause
        ? String(cause.code)
        : 'HISTORY_WATCH_UNAVAILABLE',
    project_id: projectId,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function maxMs(...values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const value of values) if (value !== null && (best === null || value > best)) best = value;
  return best;
}

/**
 * Summarized work leaves the display once its newest retained write falls
 * outside the day window. The window moves with the clock, so it is re-applied
 * to a retained selection as well as to a fresh one.
 */
function withinCandidateWindow(
  state: string,
  lastWriteMs: number | null,
  sinceMs: number
): boolean {
  return state !== 'summarized' || (lastWriteMs ?? -Infinity) >= sinceMs;
}

/**
 * The retained selection with the window re-applied. Nothing is re-read: the
 * rows cannot have changed while the write sequence stands, so only the clock
 * can move an artifact out of the display, and the project's usage accounting
 * is narrowed to the artifacts still shown.
 */
function retainedWithinWindow(display: ProjectDisplay, nowMs: number): ProjectDisplay {
  const since = nowMs - DAY_MS;
  const threads = display.threads.filter((thread) =>
    withinCandidateWindow(thread.row.state, thread.storedLastWriteMs, since)
  );
  if (threads.length === display.threads.length) return display;
  return {
    ...display,
    threads,
    usage: { ...display.usage, artifactIds: threads.map((thread) => thread.artifactId) },
  };
}

function sessionTotal(session: UsageAccountingResult['sessions'][number]): number {
  const totals = session.totals ?? session.observed_high_water;
  return (
    totals.input_tokens +
    totals.output_tokens +
    totals.cache_creation_input_tokens +
    totals.cache_read_input_tokens
  );
}

/**
 * Reads Watch displays from validated readonly project databases. The resolved
 * scope and its readers stay open across ticks; every tick observes the
 * project inventory and each project's write sequence, and only a changed
 * sequence selects rows or hydrates artifacts. No transaction is open while
 * the engine awaits or emits.
 */
export class HistoryWatchEngine extends EventEmitter {
  private scope: DatabaseHistoryScope | null = null;
  private inventory: string | null = null;
  private reopen = false;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private lastSnapshot: WatchSnapshot | null = null;
  private lastTimings: HistoryTickTimings | null = null;
  private readonly displays = new Map<string, ProjectDisplay>();
  private readonly details = new Map<string, Map<string, CachedDetail>>();
  private readonly activity: AgentActivityReaderLike;

  constructor(private readonly options: HistoryEngineOptions) {
    super();
    this.activity =
      options.activityReader ?? new AgentActivityReader(options.scope.env ?? process.env);
  }

  get snapshot(): WatchSnapshot | null {
    return this.lastSnapshot;
  }

  get timings(): HistoryTickTimings | null {
    return this.lastTimings ? { ...this.lastTimings } : null;
  }

  /** The data root's projects directory: databases, WAL files and catalog entries all live under it. */
  getWatchRoots(): string[] {
    return this.scope ? [path.join(this.scope.root.resolvedRoot, 'projects')] : [];
  }

  /**
   * Each open project's database and its write-ahead log. A commit appends to
   * the log and leaves the enclosing directories untouched, so these are the
   * only paths whose change means "a capture landed"; watching them is what
   * keeps a refresh from waiting on the caller's heartbeat.
   */
  getWatchFiles(): string[] {
    if (!this.scope) return [];
    const files: string[] = [];
    for (const project of this.scope.projects) {
      if (!project.authority) continue;
      const file = projectDatabasePath(project.authority);
      files.push(file, `${file}-wal`);
    }
    return files;
  }

  start(nowMs?: number): Promise<void> {
    return this.tick(nowMs);
  }

  /** Run one serialized tick. `nowMs` is injectable for deterministic tests. */
  tick(nowMs = Date.now()): Promise<void> {
    const run = this.tail.then(() => this.performTick(nowMs));
    this.tail = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    const scope = this.scope;
    this.scope = null;
    this.displays.clear();
    this.details.clear();
    scope?.close();
  }

  private publish(snapshot: WatchSnapshot): void {
    if (this.closed) return;
    this.lastSnapshot = snapshot;
    this.emit('snapshot', snapshot);
  }

  private async performTick(nowMs: number): Promise<void> {
    if (this.closed) return;
    const started = performance.now();
    const timings: HistoryTickTimings = {
      totalMs: 0,
      scopeMs: 0,
      stampMs: 0,
      selectionMs: 0,
      hydrationMs: 0,
      usageMs: 0,
      reviewMs: 0,
      activityMs: 0,
      reusedProjects: 0,
      refreshedProjects: 0,
      hydratedArtifacts: 0,
      selectedRows: 0,
    };
    const scopeStarted = performance.now();
    let scope: DatabaseHistoryScope;
    try {
      scope = await this.currentScope();
    } catch (cause) {
      timings.scopeMs = performance.now() - scopeStarted;
      if (!this.lastSnapshot) throw cause;
      this.publishDeferred(nowMs, issueFrom(null, cause), timings, started);
      return;
    }
    timings.scopeMs = performance.now() - scopeStarted;
    if (this.closed) return;
    const currentBranch = scope.gitContext
      ? await readCurrentBranch(scope.gitContext.worktreeRoot)
      : null;
    if (this.closed) return;

    const projects: WatchProject[] = [];
    const usageInputs: UsageAccountingInput[] = [];
    const live = new Set<string>();
    for (const project of scope.projects) {
      live.add(project.projectId);
      const previous = this.displays.get(project.projectId);
      const authorityKey = project.authority?.storeInstanceId ?? null;
      const retained = previous && previous.authorityKey === authorityKey ? previous : undefined;
      let display: ProjectDisplay | undefined;
      let failure: HistoryIssue[] = [];
      if (project.database && authorityKey) {
        try {
          display = await this.refreshProject(project, project.database, retained, nowMs, timings);
        } catch (cause) {
          failure = [issueFrom(project.projectId, cause)];
          this.reopen = true;
        }
      } else {
        failure = project.completeness.issues.length
          ? project.completeness.issues
          : [issueFrom(project.projectId, 'Project history is unavailable')];
        this.reopen = true;
      }
      if (display) this.displays.set(project.projectId, display);
      const shown = display ?? retained;
      const displayName =
        shown?.displayName ??
        (scope.gitContext &&
        project.authority &&
        scope.gitContext.repositoryInstanceId === project.authority.repositoryInstanceId
          ? repositoryDisplayName(scope.gitContext.commonDir) || project.projectId
          : project.projectId);
      const issues = [...(shown?.issues ?? []), ...failure];
      if (!shown) {
        projects.push({
          projectId: project.projectId,
          displayName,
          authorityKey,
          writeSequence: null,
          state: 'unavailable',
          completeness: { complete: false, issues },
          threads: [],
        });
        usageInputs.push({
          projectId: project.projectId,
          events: [],
          unavailable: issues.map((issue) => issue.message),
        });
        continue;
      }
      const isCurrentRepository =
        scope.gitContext !== null &&
        project.authority !== null &&
        scope.gitContext.repositoryInstanceId === project.authority.repositoryInstanceId;
      projects.push({
        projectId: project.projectId,
        displayName,
        authorityKey: shown.authorityKey,
        repository: shown.repository,
        writeSequence: shown.writeSequence,
        state: display ? 'current' : 'deferred',
        completeness: { complete: display !== undefined && issues.length === 0, issues },
        threads: shown.threads.map((base) =>
          this.presentThread(
            base,
            shown,
            displayName,
            isCurrentRepository && currentBranch !== null && base.branch === currentBranch
          )
        ),
      });
      usageInputs.push(shown.usage);
    }
    for (const projectId of [...this.displays.keys()])
      if (!live.has(projectId)) {
        this.displays.delete(projectId);
        this.details.delete(projectId);
      }
    if (!scope.completeness.complete)
      usageInputs.push({
        projectId: '',
        events: [],
        unavailable: ['Project catalog selection is incomplete'],
      });

    const activityStarted = performance.now();
    const sessions = projects.flatMap((project) =>
      project.threads.flatMap((thread) => thread.sessions)
    );
    const activity = sessions.length
      ? await this.activity.readLastActivity(sessions)
      : new Map<string, Map<string, number>>();
    timings.activityMs = performance.now() - activityStarted;
    if (this.closed) return;
    const thresholds = this.options.thresholds ?? DEFAULT_THRESHOLDS;
    const ticker: TickerEvent[] = [];
    for (const project of projects) {
      for (const thread of project.threads) {
        for (const session of thread.sessions) {
          const observed = activity.get(session.agent)?.get(session.session_id);
          if (observed !== undefined) thread.lastWriteMs = maxMs(thread.lastWriteMs, observed);
        }
        thread.state = classifyAgent(thread, nowMs, thresholds);
        if (thread.lastWriteMs !== null && nowMs - thread.lastWriteMs <= TAIL_ACTIVE_MS) {
          const events = thread.recentEvents;
          thread.sparkline = bucketize(events, nowMs);
          thread.recentEvents = events.slice(-RECENT_EVENTS_MAX).reverse();
          ticker.push(...events);
        } else {
          thread.sparkline = [];
          thread.recentEvents = [];
        }
      }
    }
    ticker.sort((a, b) => b.tsMs - a.tsMs);
    const usage = aggregateCanonicalUsage(usageInputs);
    const complete =
      scope.completeness.complete && projects.every((project) => project.completeness.complete);
    timings.totalMs = performance.now() - started;
    this.lastTimings = timings;
    this.publish({
      generated_at: new Date(nowMs).toISOString(),
      generatedAtMs: nowMs,
      dataRoot: scope.root.resolvedRoot,
      rootKey: scope.root.rootKey,
      state: complete ? 'current' : 'deferred',
      completeness: {
        complete,
        issues: distinctHistoryIssues([
          ...scope.completeness.issues,
          ...projects.flatMap((project) => project.completeness.issues),
        ]),
      },
      totals: {
        activeThreads: projects.reduce(
          (sum, project) =>
            sum + project.threads.filter((thread) => thread.artifactStatus === 'active').length,
          0
        ),
        openCheckpoints: projects.reduce(
          (sum, project) =>
            sum + project.threads.reduce((inner, thread) => inner + thread.openCheckpoints, 0),
          0
        ),
        sessionTokens: usage.sessions
          .filter((session) => session.status === 'exact')
          .reduce((sum, session) => sum + sessionTotal(session), 0),
        usageStatus: usage.status,
      },
      projects,
      ticker: ticker.slice(0, TICKER_MAX),
    });
  }

  private publishDeferred(
    nowMs: number,
    issue: HistoryIssue,
    timings: HistoryTickTimings,
    started: number
  ): void {
    const last = this.lastSnapshot!;
    timings.totalMs = performance.now() - started;
    this.lastTimings = timings;
    this.publish({
      ...structuredClone(last),
      generated_at: new Date(nowMs).toISOString(),
      generatedAtMs: nowMs,
      state: 'deferred',
      completeness: { complete: false, issues: [issue] },
      projects: last.projects.map((project) => ({
        ...structuredClone(project),
        state: project.state === 'unavailable' ? 'unavailable' : 'deferred',
        completeness: { complete: false, issues: [...project.completeness.issues, issue] },
      })),
    });
  }

  /**
   * The open scope is reused until the project inventory changes or a reader
   * failed; both re-resolve so a replaced or newly catalogued database is
   * validated again instead of being served from a stale handle.
   *
   * The stamp is read BEFORE the resolution and the pre-resolution stamp is the
   * one recorded, so it can only ever lag the opened scope: recording a stamp
   * taken afterwards would name a project catalogued during the resolution that
   * the scope never opened, and every later tick would compare equal and keep
   * omitting it. A stamp that moved across the resolution re-resolves; when the
   * budget runs out the lagging stamp simply re-resolves on the next tick.
   */
  private async currentScope(): Promise<DatabaseHistoryScope> {
    const root = this.scope?.root.resolvedRoot ?? (await this.resolveRoot());
    let inventory = await this.readInventory(root);
    if (this.scope && !this.reopen && inventory === this.inventory) return this.scope;
    for (let attempt = 1; ; attempt++) {
      const next = await resolveDatabaseHistoryScope({
        ...this.options.scope,
        selector: { scope: 'all-projects' },
      });
      if (this.closed) {
        next.close();
        throw new Error('Watch engine is closed');
      }
      const settled = await this.readInventory(next.root.resolvedRoot);
      if (settled !== inventory && attempt < SCOPE_ATTEMPTS) {
        next.close();
        inventory = settled;
        continue;
      }
      const previous = this.scope;
      this.scope = next;
      this.inventory = inventory;
      this.reopen = false;
      previous?.close();
      return next;
    }
  }

  /**
   * The data root the first resolution will select, read the same way the scope
   * resolver reads it. Resolution creates nothing, so this only names the
   * directory whose inventory the first stamp covers.
   */
  private async resolveRoot(): Promise<string> {
    const { root, env, home, cwd } = this.options.scope;
    return (await normalizeHistoryRoot({ root, env, home, cwd })).resolvedRoot;
  }

  private async readInventory(root: string): Promise<string> {
    const directory = path.join(root, 'projects');
    const names: string[] = [];
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'catalog') {
          try {
            for (const name of await readdir(path.join(directory, 'catalog')))
              names.push(`catalog/${name}`);
          } catch {
            names.push('catalog/?');
          }
        } else if (entry.isDirectory() && isUuidV7(entry.name)) names.push(entry.name);
        else names.push(`?/${entry.name}`);
      }
    } catch {
      return '';
    }
    return names.sort().join('\n');
  }

  private async refreshProject(
    project: DatabaseHistoryProject,
    database: ProjectDatabase,
    retained: ProjectDisplay | undefined,
    nowMs: number,
    timings: HistoryTickTimings
  ): Promise<ProjectDisplay> {
    const stampStarted = performance.now();
    const stamp = database.read(() => null).counters;
    timings.stampMs += performance.now() - stampStarted;
    // A retained selection that carries an issue is re-read even when the write
    // sequence stands: the usage or review read that failed has its own causes,
    // and reusing the cached failure would keep disclosing it long after the
    // cause cleared. The re-read costs a selection, not a hydration.
    if (retained && retained.writeSequence === stamp.writeSequence && !retained.issues.length) {
      timings.reusedProjects += 1;
      return retainedWithinWindow(retained, nowMs);
    }
    let stale: unknown = null;
    for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt++) {
      const observed = attempt === 0 ? stamp : database.read(() => null).counters;
      try {
        const display = await this.selectProject(
          project,
          database,
          retained,
          observed,
          nowMs,
          timings
        );
        timings.refreshedProjects += 1;
        return display;
      } catch (cause) {
        if (!(cause instanceof RefreshMoved)) throw cause;
        stale = cause;
      }
    }
    throw stale;
  }

  private async selectProject(
    project: DatabaseHistoryProject,
    database: ProjectDatabase,
    retained: ProjectDisplay | undefined,
    observed: ProjectCounters,
    nowMs: number,
    timings: HistoryTickTimings
  ): Promise<ProjectDisplay> {
    const sameSequence = (counters: ProjectCounters) => {
      if (counters.writeSequence !== observed.writeSequence) throw new RefreshMoved();
    };
    const selectionStarted = performance.now();
    const selection = queryProjectArtifacts(database, { profile: 'watch' });
    timings.selectionMs += performance.now() - selectionStarted;
    sameSequence(selection.counters);
    timings.selectedRows += selection.rows.length;
    const since = nowMs - DAY_MS;
    const rows = selection.rows.filter((row) =>
      withinCandidateWindow(
        row.state,
        maxMs(timestampMs(row.updatedAt), timestampMs(row.bindingUpdatedAt)),
        since
      )
    );

    const cache = this.details.get(project.projectId) ?? new Map<string, CachedDetail>();
    this.details.set(project.projectId, cache);
    const changed = rows.filter((row) => {
      const cached = cache.get(row.artifactId);
      return (
        !cached ||
        cached.revision !== revisionToken(row) ||
        cached.executionVersion !== row.executionVersion
      );
    });
    const hydrationStarted = performance.now();
    if (changed.length) {
      const hydrated = readProjectArtifactDetails(
        database,
        changed.map((row) => ({
          artifactId: row.artifactId,
          revision: {
            generation: row.generation,
            orderedHash: row.orderedHash,
            eventCount: row.eventCount,
            byteLength: row.byteLength,
            tailEventId: row.tailEventId,
          },
          executionVersion: row.executionVersion,
        }))
      );
      sameSequence(hydrated.counters);
      for (const entry of hydrated.artifacts) {
        const row = changed.find((candidate) => candidate.artifactId === entry.artifactId)!;
        if (!entry.artifact)
          throw Object.assign(
            new Error('Selected artifact history is missing; preserve it for explicit repair'),
            {
              code: 'HISTORY_MISSING',
            }
          );
        cache.set(row.artifactId, {
          revision: revisionToken(row),
          executionVersion: row.executionVersion,
          detail: await threadDetail(entry.artifact.thread),
        });
      }
      timings.hydratedArtifacts += changed.length;
    }
    timings.hydrationMs += performance.now() - hydrationStarted;
    for (const artifactId of [...cache.keys()])
      if (!rows.some((row) => row.artifactId === artifactId)) cache.delete(artifactId);

    const usageStarted = performance.now();
    const ids = rows.map((row) => row.artifactId);
    let usage: UsageAccountingInput;
    const issues: HistoryIssue[] = [];
    try {
      usage = readProjectUsageAccounting(database, {
        artifactIds: ids,
        expectedWriteSequence: observed.writeSequence,
      });
    } catch (cause) {
      if (
        cause !== null &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'STALE_CONTEXT'
      )
        throw new RefreshMoved();
      issues.push(issueFrom(project.projectId, cause));
      usage = {
        projectId: project.projectId,
        artifactIds: ids,
        events: [],
        unavailable: [cause instanceof Error ? cause.message : String(cause)],
      };
    }
    timings.usageMs += performance.now() - usageStarted;

    // One read for the tick, so every pane of a refresh answers at one boundary. A failure here
    // leaves the panes without the block and is reported as an issue: a thread rendered as though
    // no rule bears on it would be the one answer this must never give.
    let knowledge: Map<string, KnowledgeBlock> | null = null;
    let knowledgeUnavailable: string | null = null;
    try {
      const composed = database.read((view) => readThreadsKnowledge(view, project.projectId, ids));
      sameSequence(composed.counters);
      knowledge = new Map(composed.value.map((entry) => [entry.artifactId, entry.block]));
    } catch (cause) {
      if (cause instanceof RefreshMoved) throw cause;
      const issue = issueFrom(project.projectId, cause);
      knowledgeUnavailable = issue.code;
      issues.push(issue);
    }

    const reviewStarted = performance.now();
    let comments: Map<string, number> | null = null;
    try {
      const copied = database.read(selectReviewComments);
      sameSequence(copied.counters);
      comments = countOpenReviewComments(copied.value);
    } catch (cause) {
      if (cause instanceof RefreshMoved) throw cause;
      issues.push(issueFrom(project.projectId, cause));
    }
    timings.reviewMs += performance.now() - reviewStarted;

    const threads = rows.map((row): ThreadBase => {
      const watch = parseWatchMetadata(row);
      const perArtifact = aggregateCanonicalUsage([{ ...usage, artifactIds: [row.artifactId] }]);
      return {
        artifactId: row.artifactId,
        version: revisionToken(row),
        row,
        branch: row.bindingBranch ?? row.branch,
        currentLine: watch.currentLine,
        currentLineTruncated: watch.currentLineTruncated,
        events: watch.events.flatMap((event) => {
          const tsMs = timestampMs(event.ts);
          return tsMs === null ? [] : [{ ts: event.ts, tsMs, type: event.type }];
        }),
        omittedEvents: watch.omittedEvents,
        storedLastWriteMs: maxMs(timestampMs(row.updatedAt), timestampMs(row.bindingUpdatedAt)),
        sessions: perArtifact.sessions.map((session) => ({
          agent: session.agent,
          session_id: session.session_id,
          status: session.status,
          tokens: sessionTotal(session),
        })),
        detail: cache.get(row.artifactId)!.detail,
        knowledge: knowledge?.get(row.artifactId) ?? null,
        knowledgeUnavailable,
      };
    });
    const creation = readProjectRepositoryCreation(database);
    const displayName =
      readProjectDisplayName(database) ??
      ((creation ? repositoryDisplayName(creation.commonDirectory) : '') ||
        database.authority.projectId);
    return {
      displayName,
      repository: creation
        ? {
            commonDirectory: creation.commonDirectory,
            instanceId: database.authority.repositoryInstanceId,
          }
        : undefined,
      authorityKey: database.authority.storeInstanceId,
      writeSequence: observed.writeSequence,
      threads,
      comments,
      usage,
      issues,
    };
  }

  private presentThread(
    base: ThreadBase,
    display: ProjectDisplay,
    project: string,
    isCurrentCheckout: boolean
  ): WatchThread {
    const row = base.row;
    const events: TickerEvent[] = base.events.map((event) => ({
      ...event,
      project,
      branch: base.branch,
    }));
    return {
      artifactId: base.artifactId,
      version: base.version,
      artifactStatus: artifactStatus(row.state),
      branch: base.branch,
      title: row.task ?? row.label ?? '',
      agent: row.agent,
      sessions: base.sessions.map((session) => ({ ...session })),
      openCheckpoints: row.openCheckpointCount,
      openComments: display.comments === null ? null : (display.comments.get(base.branch) ?? 0),
      isCurrentCheckout,
      currentLine: base.currentLine,
      steps: { completed: row.completedPlanStepCount, total: row.planStepCount },
      lastWriteMs: base.storedLastWriteMs,
      lastClosed: base.detail.lastClosed ? { ...base.detail.lastClosed } : null,
      state: 'idle',
      sparkline: [],
      planSteps: structuredClone(base.detail.planSteps),
      checkpoints: structuredClone(base.detail.checkpoints),
      startedAtMs: row.startedMs ?? timestampMs(row.startedAt),
      planDecisions: structuredClone(base.detail.planDecisions),
      nonGoals: [...base.detail.nonGoals],
      knowledge: base.knowledge === null ? null : structuredClone(base.knowledge),
      knowledgeUnavailable: base.knowledgeUnavailable,
      // Oldest-first for the classification pass; the pass reverses and caps it.
      recentEvents: events,
      omittedEvents: base.omittedEvents,
      activityWindowComplete: base.omittedEvents === 0,
    };
  }
}

/** A refresh whose independent reads observed different write sequences. */
class RefreshMoved extends Error {
  readonly code = 'STALE_CONTEXT';
  constructor() {
    super('History changed while refreshing the display; the next tick re-reads it');
    this.name = 'RefreshMoved';
  }
}
