import {
  type AllProjectsScope,
  archiveLastWriteMs,
  hotLastWriteMs,
  openAllProjects,
  type ProjectHandle,
  resolveArtifactSource,
  type UnidentifiedProjectHandle,
} from '@orcaops/project-scope';
import {
  archiveArtifactPaths,
  archiveRoot,
  artifactPathsFor,
  artifactsRoot,
  type ArtifactStore,
  type ClosedCheckpointRow,
  indexRoot,
  type OpenCheckpointRow,
  type PlanStepRow,
  type ProjectIndexMeta,
  readProjectIndexMeta,
  type Store,
} from '@orcaops/storage';

import { AgentActivityReader, type AgentActivityReaderLike } from './agent-activity.js';
import { readCurrentBranch } from './current-branch.js';
import { DiffStatReader } from './diff-stats.js';
import { EventTailReader } from './event-tail.js';
import { classifyAgent, DEFAULT_THRESHOLDS, type Thresholds } from './liveness.js';
import { deriveSteps } from './presenters.js';
import { countOpenReviewComments } from './review-badge.js';
import { bucketize } from './sparkline.js';
import type {
  AgentSource,
  SessionTokens,
  TickerEvent,
  WatchCheckpoint,
  WatchCheckpointStep,
  WatchDecision,
  WatchDecisionAlternative,
  WatchProject,
  WatchSnapshot,
  WatchThread,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Only tail (for sparklines/ticker) artifacts written within this window. */
const TAIL_ACTIVE_MS = 60 * 60 * 1000;
/** Merged ticker cap. */
const TICKER_MAX = 50;

export interface SnapshotOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  rootOverride?: string;
  /** Injectable clock for deterministic tests; defaults to `Date.now()`. */
  nowMs?: number;
  /** Liveness thresholds; defaults to DEFAULT_THRESHOLDS. */
  thresholds?: Thresholds;
  /** Long-lived tail reader (the engine passes a persistent one for cache reuse). */
  tailReader?: EventTailReader;
  /** Long-lived diff-stat reader (the engine passes a persistent one for cache reuse). */
  diffReader?: DiffStatReader;
  /** Long-lived agent reader (the engine passes a persistent one for provider cache reuse). */
  activityReader?: AgentActivityReaderLike;
}

/** The event-log + sidecar paths for one artifact (routed by hot vs archive source). */
interface LogPaths {
  eventsNdjson: string;
  sidecarsDir: string;
  containmentRoot?: string;
}

/** A thread paired with the fs paths of its event log (tail pass + diff pass). */
interface TailTarget {
  thread: WatchThread;
  project: WatchProject;
  eventsPath: string;
  sidecarsDir: string;
  containmentRoot?: string;
}

interface ProjectCollectionSelection {
  includeArtifact: (id: string) => boolean;
  archiveMeta?: ProjectIndexMeta;
  candidateArtifactIds?: ReadonlySet<string>;
  lastWriteByArtifact?: ReadonlyMap<string, number | null>;
}

/**
 * One-shot snapshot: open the cross-project scope (with the two watch opt-ins),
 * collect, close. `SnapshotEngine` holds a scope open across ticks and calls
 * {@link collectFromScope} directly instead.
 */
export async function collectSnapshot(opts: SnapshotOptions = {}): Promise<WatchSnapshot> {
  const scope = await openAllProjects({
    cwd: opts.cwd,
    env: opts.env,
    rootOverride: opts.rootOverride,
    includeArchiveForHot: true,
    allowUnidentifiedHot: true,
    throwOnHotOpenError: true,
  });
  try {
    return await collectFromScope(scope, opts);
  } finally {
    scope.close();
  }
}

/** Collect an immutable snapshot from an already-open scope. */
export async function collectFromScope(
  scope: AllProjectsScope,
  opts: SnapshotOptions = {}
): Promise<WatchSnapshot> {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();
  const dataRoot = archiveRoot(env);
  const idxRoot = indexRoot(env);

  const projects: WatchProject[] = [];
  const targets: TailTarget[] = [];
  const unidentifiedTargets: TailTarget[] = [];
  const unidentifiedProject = scope.unidentifiedHot
    ? await collectUnidentified(scope.unidentifiedHot, nowMs, unidentifiedTargets)
    : null;
  const liveArtifactIds = new Set(
    unidentifiedProject?.threads.map((thread) => thread.artifactId) ?? []
  );
  // openAllProjects orders the live checkout before archive-only projects.
  // Carry live IDs forward so a repaired or reminted project identity
  // cannot make the same globally unique artifact reappear from an old mirror.
  const hotHandles = scope.projects.filter((handle) => handle.hot);
  const archiveHandles = scope.projects.filter((handle) => !handle.hot);
  for (const handle of hotHandles) {
    const project = await collectProject(handle, idxRoot, nowMs, targets, {
      includeArtifact: (id) => !liveArtifactIds.has(id),
    });
    projects.push(project);
    for (const thread of project.threads) liveArtifactIds.add(thread.artifactId);
  }
  const archiveSelection = await selectArchiveOwners(
    archiveHandles,
    idxRoot,
    nowMs,
    liveArtifactIds,
    [
      ...(scope.unidentifiedHot ? [scope.unidentifiedHot.store] : []),
      ...hotHandles.flatMap((handle) => [
        handle.store,
        ...(handle.archiveStore ? [handle.archiveStore] : []),
      ]),
    ]
  );
  for (const handle of archiveHandles) {
    projects.push(
      await collectProject(handle, idxRoot, nowMs, targets, {
        includeArtifact: (id) => archiveSelection.ownerByArtifact.get(id) === handle.projectId,
        archiveMeta: archiveSelection.metaByProject.get(handle.projectId),
        candidateArtifactIds: archiveSelection.candidatesByProject.get(handle.projectId),
        lastWriteByArtifact: archiveSelection.lastWriteByArtifact,
      })
    );
  }
  if (unidentifiedProject) {
    projects.push(unidentifiedProject);
    targets.push(...unidentifiedTargets);
  }

  // Blend local provider activity into recency before classification. Missing
  // or remote sessions remain on the event-log mtime.
  await blendAgentActivity(projects, opts.activityReader ?? new AgentActivityReader(env));

  // Classify (pure over now + thresholds) as a separate pass — the ticker
  // re-runs `classifyAgent` in memory between data ticks to advance
  // time-driven transitions without re-collecting.
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  for (const project of projects) {
    for (const thread of project.threads) {
      thread.state = classifyAgent(thread, nowMs, thresholds);
    }
  }

  // Tail pass: for each artifact written within the last 60m, tail its
  // event log (cached by size+mtime) → per-agent sparkline + recent events, and
  // merge everything into the newest-first ticker.
  const ticker = await runTailPass(targets, nowMs, opts.tailReader ?? new EventTailReader());

  // Diff pass: fill each closed checkpoint's line-counts from its close manifest
  // (cached by size+mtime; only agents with a closed cp are read).
  await runDiffPass(targets, opts.diffReader ?? new DiffStatReader());

  return {
    generated_at: new Date(nowMs).toISOString(),
    generatedAtMs: nowMs,
    dataRoot,
    // The cross-project view is live iff at least one minted/archived project
    // exists; when only `unidentifiedHot` is present the renderers show the CTA.
    archiveEnabled: scope.projects.length > 0,
    totals: {
      activeThreads: projects.reduce(
        (n, p) => n + p.threads.filter((a) => a.artifactStatus === 'active').length,
        0
      ),
      openCheckpoints: projects.reduce(
        (n, p) => n + p.threads.reduce((m, a) => m + a.openCheckpoints, 0),
        0
      ),
      sessionTokens: sumDedupedSessionTokens(projects),
    },
    projects,
    ticker,
    archiveIssues: scope.issues,
  };
}

/**
 * Blend local provider activity into each thread's `lastWriteMs` by maximum.
 * A missing provider, transcript, or session is a no-op.
 */
export async function blendAgentActivity(
  projects: WatchProject[],
  reader: AgentActivityReaderLike
): Promise<void> {
  const sessions = projects.flatMap((project) =>
    project.threads.flatMap((thread) => thread.sessions)
  );
  if (sessions.length === 0) return;
  const activity = await reader.readLastActivity(sessions);
  if (activity.size === 0) return;
  for (const project of projects) {
    for (const thread of project.threads) {
      let best = thread.lastWriteMs ?? Number.NEGATIVE_INFINITY;
      for (const session of thread.sessions) {
        const timestamp = activity.get(session.agent)?.get(session.session_id);
        if (timestamp !== undefined && timestamp > best) best = timestamp;
      }
      if (Number.isFinite(best)) thread.lastWriteMs = best;
    }
  }
}

async function runTailPass(
  targets: TailTarget[],
  nowMs: number,
  tailReader: EventTailReader
): Promise<TickerEvent[]> {
  const ticker: TickerEvent[] = [];
  for (const { thread, project, eventsPath, containmentRoot } of targets) {
    if (thread.lastWriteMs === null || nowMs - thread.lastWriteMs > TAIL_ACTIVE_MS) continue;
    const events = await tailReader.read(eventsPath, containmentRoot, thread.source === 'hot');
    thread.sparkline = bucketize(events, nowMs);
    const projected: TickerEvent[] = events.map((e) => ({
      tsMs: e.tsMs,
      ts: e.ts,
      type: e.type,
      project: project.displayName,
      branch: thread.branch,
    }));
    // Newest-first, last ~50, for the drill-in activity table.
    thread.recentEvents = projected.slice(-50).reverse();
    for (const ev of projected) ticker.push(ev);
  }
  ticker.sort((a, b) => b.tsMs - a.tsMs);
  return ticker.slice(0, TICKER_MAX);
}

/** Fill each closed checkpoint's linesAdded/linesRemoved from its diff manifest. */
async function runDiffPass(targets: TailTarget[], diffReader: DiffStatReader): Promise<void> {
  for (const { thread, eventsPath, sidecarsDir, containmentRoot } of targets) {
    if (!thread.checkpoints.some((cp) => cp.status === 'closed')) continue;
    const stats = await diffReader.read(
      eventsPath,
      sidecarsDir,
      containmentRoot,
      thread.source === 'hot'
    );
    if (stats.size === 0) continue;
    for (const cp of thread.checkpoints) {
      const stat = stats.get(cp.n);
      if (stat) {
        cp.linesAdded = stat.added;
        cp.linesRemoved = stat.removed;
      }
    }
  }
}

async function collectProject(
  handle: ProjectHandle,
  idxRoot: string,
  nowMs: number,
  targets: TailTarget[],
  selection: ProjectCollectionSelection
): Promise<WatchProject> {
  const project: WatchProject = {
    projectId: handle.projectId,
    displayName: handle.displayName,
    threads: [],
  };
  const add = (thread: WatchThread | null, paths: LogPaths): void => {
    if (!thread) return;
    project.threads.push(thread);
    targets.push({
      thread,
      project,
      eventsPath: paths.eventsNdjson,
      sidecarsDir: paths.sidecarsDir,
      containmentRoot: paths.containmentRoot,
    });
  };

  if (handle.hot && handle.hotStore && handle.archiveStore) {
    // Hot project + archive index: merge, freshest-projection-wins, so agents in
    // sibling worktrees (archive-only rows) become visible.
    const hotArtifactStore = handle.hotStore;
    const hotStore = handle.store;
    const archiveStore = handle.archiveStore;
    assertHotArtifactRoot(hotArtifactStore);
    const meta = handle.archiveMeta ?? (await readProjectIndexMeta(idxRoot, handle.projectId));
    const hotCandidates = candidateIds(hotStore, nowMs);
    const archiveCandidates = candidateIds(archiveStore, nowMs);
    const ids = unionIds(hotCandidates, archiveCandidates);
    for (const id of ids) {
      if (!selection.includeArtifact(id)) continue;
      const built = await mergeAndBuild(
        id,
        hotArtifactStore,
        hotStore,
        archiveStore,
        meta,
        handle.projectDir
      );
      if (!built) continue;
      const selectedCandidates = built.thread.source === 'hot' ? hotCandidates : archiveCandidates;
      if (selectedCandidates.has(id)) add(built.thread, built.paths);
    }
  } else if (handle.hot && handle.hotStore) {
    // Hot project without an archive index (only when includeArchiveForHot is off).
    const hotArtifactStore = handle.hotStore;
    assertHotArtifactRoot(hotArtifactStore);
    for (const id of candidateIds(handle.store, nowMs)) {
      if (!selection.includeArtifact(id)) continue;
      const lastWriteMs = await hotLastWriteMs(hotArtifactStore, id);
      add(buildThread(handle.store, id, 'hot', lastWriteMs), hotLogPaths(hotArtifactStore, id));
    }
  } else {
    // Archive-served index project: every row is source 'archive'.
    const meta = selection.archiveMeta ?? (await readProjectIndexMeta(idxRoot, handle.projectId));
    const ids = selection.candidateArtifactIds ?? candidateIds(handle.store, nowMs);
    for (const id of ids) {
      if (!selection.includeArtifact(id)) continue;
      const lastWriteMs = selection.lastWriteByArtifact?.has(id)
        ? (selection.lastWriteByArtifact.get(id) ?? null)
        : archiveLastWriteMs(meta, id);
      add(
        buildThread(handle.store, id, 'archive', lastWriteMs),
        archiveLogPaths(handle.projectDir, id)
      );
    }
  }

  // Review-comments pass: `✎ n` counts live in THIS checkout's reviews dir,
  // regardless of which store served the projection (review state never mirrors).
  // Same for the current-checkout flag — it is a property of THIS checkout's HEAD.
  if (handle.hot && handle.hotStore) {
    await fillOpenComments(project.threads, handle.hotStore.repoRoot);
    await fillCurrentCheckout(project.threads, handle.hotStore.repoRoot);
  }

  return project;
}

/**
 * Resolve one archive owner for every ID that is a candidate anywhere. A
 * current checkout owns visibility even when its projection is outside the
 * window; duplicate archive projections use their refresh-aligned high-water
 * (mtime, then size), with project ID only as a deterministic tie. The cached
 * candidate sets are reused by collection.
 */
async function selectArchiveOwners(
  handles: readonly ProjectHandle[],
  idxRoot: string,
  nowMs: number,
  liveArtifactIds: ReadonlySet<string>,
  liveStores: readonly Store[]
): Promise<{
  ownerByArtifact: Map<string, string>;
  metaByProject: Map<string, ProjectIndexMeta>;
  candidatesByProject: Map<string, ReadonlySet<string>>;
  lastWriteByArtifact: Map<string, number | null>;
}> {
  const metaByProject = new Map<string, ProjectIndexMeta>();
  const candidatesByProject = new Map<string, ReadonlySet<string>>();
  const candidateArtifactIds = new Set<string>();
  for (const handle of handles) {
    const meta = handle.archiveMeta ?? (await readProjectIndexMeta(idxRoot, handle.projectId));
    metaByProject.set(handle.projectId, meta);
    const candidates = candidateIds(handle.store, nowMs);
    candidatesByProject.set(handle.projectId, candidates);
    for (const id of candidates) {
      if (!liveArtifactIds.has(id)) candidateArtifactIds.add(id);
    }
  }

  const ownerByArtifact = new Map<string, string>();
  const lastWriteByArtifact = new Map<string, number | null>();
  for (const id of candidateArtifactIds) {
    // A current checkout owns visibility even when its canonical projection is
    // outside the active/recent window; an old archive cannot resurrect it.
    if (liveStores.some((store) => store.getArtifact(id) !== null)) continue;
    const copies = handles.filter((handle) => handle.store.getArtifact(id) !== null);
    if (copies.length === 0) continue;
    if (copies.length === 1) {
      const owner = copies[0]!;
      ownerByArtifact.set(id, owner.projectId);
      lastWriteByArtifact.set(id, archiveLastWriteMs(metaByProject.get(owner.projectId)!, id));
      continue;
    }

    let selected:
      | { projectId: string; lastWriteMs: number | null; scoreMs: number; scoreSize: number }
      | undefined;
    for (const handle of copies) {
      const highWater = metaByProject.get(handle.projectId)?.artifacts[id];
      const scoreMs = highWater?.mtime_ms ?? Number.NEGATIVE_INFINITY;
      const scoreSize = highWater?.size ?? Number.NEGATIVE_INFINITY;
      if (
        selected === undefined ||
        scoreMs > selected.scoreMs ||
        (scoreMs === selected.scoreMs && scoreSize > selected.scoreSize) ||
        (scoreMs === selected.scoreMs &&
          scoreSize === selected.scoreSize &&
          handle.projectId.localeCompare(selected.projectId) < 0)
      ) {
        selected = {
          projectId: handle.projectId,
          lastWriteMs: highWater?.mtime_ms ?? null,
          scoreMs,
          scoreSize,
        };
      }
    }
    ownerByArtifact.set(id, selected!.projectId);
    lastWriteByArtifact.set(id, selected!.lastWriteMs);
  }

  return {
    ownerByArtifact,
    metaByProject,
    candidatesByProject,
    lastWriteByArtifact,
  };
}

/**
 * Flag each thread whose branch is the one checked out in `repoRoot`. One
 * read-only `git symbolic-ref` per hot project per tick; a detached/unresolved
 * HEAD leaves every thread false (the `v` guard then refuses, which is safe).
 */
async function fillCurrentCheckout(threads: WatchThread[], repoRoot: string): Promise<void> {
  const current = await readCurrentBranch(repoRoot);
  if (current === null) return;
  for (const thread of threads) thread.isCurrentCheckout = thread.branch === current;
}

/** Fill each thread's open-comment badge from the checkout's reviews dir (deduped per branch). */
async function fillOpenComments(threads: WatchThread[], repoRoot: string): Promise<void> {
  const byBranch = new Map<string, number>();
  for (const thread of threads) {
    let count = byBranch.get(thread.branch);
    if (count === undefined) {
      count = await countOpenReviewComments(repoRoot, thread.branch);
      byBranch.set(thread.branch, count);
    }
    thread.openComments = count;
  }
}

async function collectUnidentified(
  handle: UnidentifiedProjectHandle,
  nowMs: number,
  targets: TailTarget[]
): Promise<WatchProject> {
  const project: WatchProject = { projectId: null, displayName: handle.displayName, threads: [] };
  assertHotArtifactRoot(handle.hotStore);
  for (const id of candidateIds(handle.store, nowMs)) {
    // The unidentified repo has no archive; last-write + tail both stat the hot log.
    const lastWriteMs = await hotLastWriteMs(handle.hotStore, id);
    const thread = buildThread(handle.store, id, 'hot', lastWriteMs);
    if (thread) {
      const paths = hotLogPaths(handle.hotStore, id);
      project.threads.push(thread);
      targets.push({
        thread,
        project,
        eventsPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
        containmentRoot: paths.containmentRoot,
      });
    }
  }
  await fillOpenComments(project.threads, handle.hotStore.repoRoot);
  await fillCurrentCheckout(project.threads, handle.hotStore.repoRoot);
  return project;
}

function hotLogPaths(hot: ArtifactStore, id: string): LogPaths {
  const p = artifactPathsFor(hot.repoRoot, hot.config, id);
  return {
    eventsNdjson: p.eventsNdjson,
    sidecarsDir: p.sidecarsDir,
    containmentRoot: hot.repoRoot,
  };
}

function assertHotArtifactRoot(store: ArtifactStore): void {
  artifactsRoot(store.repoRoot, store.config);
}

function archiveLogPaths(projectDir: string, id: string): LogPaths {
  const p = archiveArtifactPaths(projectDir, id);
  return { eventsNdjson: p.eventsNdjson, sidecarsDir: p.sidecarsDir };
}

/**
 * Freshest-projection-wins per duplicate id: compare the hot event-log mtime
 * (this checkout) against the high-water captured by the archive index refresh.
 * Archive wins ONLY when strictly newer; tie / archive-missing → hot (ordinary
 * mirror lag — hot is written first under the same lock). The chosen store both
 * serves the projection and is recorded as `source`, so last-write routing
 * stays consistent by construction.
 */
async function mergeAndBuild(
  id: string,
  hotArtifactStore: ArtifactStore,
  hotStore: Store,
  archiveStore: Store,
  meta: ProjectIndexMeta,
  projectDir: string
): Promise<{ thread: WatchThread; paths: LogPaths } | null> {
  const inHot = hotStore.getArtifact(id) !== null;
  const inArchive = archiveStore.getArtifact(id) !== null;
  const hotMs = inHot ? await hotLastWriteMs(hotArtifactStore, id) : null;
  const archiveMs = inArchive ? archiveLastWriteMs(meta, id) : null;

  const resolution = resolveArtifactSource({
    hotPresent: inHot,
    archivePresent: inArchive,
    hotLastWriteMs: hotMs,
    archiveLastWriteMs: archiveMs,
  });
  if (resolution === null) return null;
  const { source, lastWriteMs } = resolution;
  const store = source === 'hot' ? hotStore : archiveStore;
  const thread = buildThread(store, id, source, lastWriteMs);
  if (!thread) return null;
  // Route the log paths the same way as the projection: a hot-served row's log
  // is in THIS checkout; an archive-served row's log is in the shared archive.
  const paths =
    source === 'hot' ? hotLogPaths(hotArtifactStore, id) : archiveLogPaths(projectDir, id);
  return { thread, paths };
}

function candidateIds(store: Store, nowMs: number): Set<string> {
  // Union of active-status and the 24h activity window, deduped by id. The
  // status query keeps age-independent `ready` rows reachable (an active
  // artifact whose uncertainty close is >24h old has no window overlap); the
  // window query adds recently-completed artifacts.
  const since = new Date(nowMs - DAY_MS).toISOString();
  const ids = new Set<string>();
  for (const a of store.listArtifacts({ status: 'active' })) ids.add(a.id);
  for (const a of store.listArtifacts({ activeSince: since })) ids.add(a.id);
  return ids;
}

function unionIds(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>(a);
  for (const id of b) out.add(id);
  return out;
}

function buildThread(
  store: Store,
  id: string,
  source: AgentSource,
  lastWriteMs: number | null
): WatchThread | null {
  const artifact = store.getArtifact(id);
  if (!artifact) return null;
  const openCps = store.getOpenCheckpoints(id);
  const closedCps = store.getClosedCheckpoints(id);
  const lastClosed = closedCps.length > 0 ? closedCps[closedCps.length - 1] : null;
  const planRev = store.getLatestPlanRevision(id);
  const claims = store.getStepClaims(id);
  const openDeclared = new Set(openCps.flatMap((cp) => cp.declared_step_ids));
  const stepById = new Map<string, WatchCheckpointStep>(
    (planRev?.steps ?? []).map((s) => [s.step_id, { idx: s.idx, label: s.label }])
  );
  const sessions: SessionTokens[] = store.artifactCodingSessions(id).map((s) => ({
    agent: s.agent,
    session_id: s.session_id,
    tokens:
      s.cumulative_input_tokens +
      s.cumulative_output_tokens +
      s.cumulative_cache_creation_input_tokens +
      s.cumulative_cache_read_input_tokens,
  }));

  return {
    artifactId: id,
    artifactStatus: artifact.status,
    source,
    branch: artifact.branch,
    title: artifact.task,
    agent: artifact.agent,
    sessions,
    openCheckpoints: openCps.length,
    openComments: 0, // the review-comments pass fills this for hot checkouts
    isCurrentCheckout: false, // the current-checkout pass flips this for the checked-out branch

    currentLine: deriveCurrentLine(openCps, planRev?.steps ?? null, lastClosed),
    steps: planRev ? { completed: claims.closedClaimed.length, total: planRev.steps.length } : null,
    lastWriteMs,
    lastClosed: lastClosed
      ? {
          closed_at: lastClosed.closed_at,
          summary: lastClosed.summary,
          uncertaintyCount: lastClosed.uncertainty.length,
        }
      : null,
    state: 'idle', // placeholder — the classify pass (`classifyAgent`) computes this.
    sparkline: [], // the tail pass fills this.
    planSteps: planRev
      ? deriveSteps(planRev.steps, new Set(claims.closedClaimed), openDeclared)
      : [],
    checkpoints: buildCheckpoints(openCps, closedCps, stepById),
    startedAtMs: toMs(artifact.started_at),
    planDecisions: parseDecisions(jsonArray(planRev?.plan.decisions)),
    nonGoals: parseNonGoals(jsonArray(planRev?.plan.non_goals)),
    recentEvents: [], // the tail pass fills this.
  };
}

/** Parse a JSON-encoded array column (PlanRow stores decisions/non_goals as strings). */
function jsonArray(raw: string | null | undefined): unknown[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Parse an ISO-8601 timestamp to epoch ms, or null if it isn't parseable. */
function toMs(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Extract the exclusion text from plan non_goals (string or {text} shapes). */
function parseNonGoals(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const g of raw) {
    if (typeof g === 'string') out.push(g);
    else if (g && typeof g === 'object' && 'text' in g) {
      const text = (g as { text: unknown }).text;
      if (typeof text === 'string') out.push(text);
    }
  }
  return out;
}

function buildCheckpoints(
  openCps: OpenCheckpointRow[],
  closedCps: ClosedCheckpointRow[],
  stepById: ReadonlyMap<string, WatchCheckpointStep>
): WatchCheckpoint[] {
  const resolve = (ids: readonly string[]): WatchCheckpointStep[] =>
    ids
      .map((sid) => stepById.get(sid))
      .filter((s): s is WatchCheckpointStep => s !== undefined)
      .sort((a, b) => a.idx - b.idx);
  const out: WatchCheckpoint[] = [
    ...openCps.map((cp) => ({
      n: cp.n,
      status: 'open' as const,
      summary: null,
      uncertainties: [],
      decisions: [],
      steps: resolve(cp.declared_step_ids),
      linesAdded: null,
      linesRemoved: null,
      filesChanged: null,
    })),
    ...closedCps.map((cp) => ({
      n: cp.n,
      status: 'closed' as const,
      summary: cp.summary,
      uncertainties: cp.uncertainty,
      decisions: parseDecisions(cp.decisions),
      steps: resolve(cp.completed_step_ids),
      // linesAdded/linesRemoved are filled by the diff pass from the close manifest.
      linesAdded: null,
      linesRemoved: null,
      filesChanged: cp.files_changed.length,
    })),
  ];
  return out.sort((a, b) => a.n - b.n);
}

/** Parse loosely-typed decisions (cp or plan) into {decision, reason, alternatives?}. */
function parseDecisions(raw: readonly unknown[]): WatchDecision[] {
  const out: WatchDecision[] = [];
  for (const d of raw) {
    if (d && typeof d === 'object' && 'decision' in d && 'reason' in d) {
      const o = d as { decision: unknown; reason: unknown; alternatives_considered?: unknown };
      if (typeof o.decision === 'string' && typeof o.reason === 'string') {
        const alternatives = parseAlternatives(o.alternatives_considered);
        out.push(
          alternatives.length > 0
            ? { decision: o.decision, reason: o.reason, alternatives }
            : { decision: o.decision, reason: o.reason }
        );
      }
    }
  }
  return out;
}

/** Parse a decision's rejected alternatives ({option, rejected_because}[]). */
function parseAlternatives(raw: unknown): WatchDecisionAlternative[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchDecisionAlternative[] = [];
  for (const a of raw) {
    if (a && typeof a === 'object' && 'option' in a && 'rejected_because' in a) {
      const o = a as { option: unknown; rejected_because: unknown };
      if (typeof o.option === 'string' && typeof o.rejected_because === 'string') {
        out.push({ option: o.option, reason: o.rejected_because });
      }
    }
  }
  return out;
}

function deriveCurrentLine(
  openCps: OpenCheckpointRow[],
  steps: PlanStepRow[] | null,
  lastClosed: ClosedCheckpointRow | null
): string | null {
  if (openCps.length > 0 && steps) {
    const firstDeclared = openCps[0].declared_step_ids[0];
    const step = steps.find((s) => s.step_id === firstDeclared);
    if (step) return step.text;
  }
  return lastClosed?.summary ?? null;
}

/**
 * Exact-or-nothing header total: dedup every session by (agent, session_id) —
 * a session spanning artifacts/projects counts ONCE — then sum. The per-artifact
 * `artifactCodingSessions` totals are full session lifetime cumulatives, so the
 * same key reports the same value everywhere (max is a belt-and-suspenders pick).
 * Never sums usage deltas.
 */
function sumDedupedSessionTokens(projects: WatchProject[]): number {
  const byKey = new Map<string, number>();
  for (const project of projects) {
    for (const thread of project.threads) {
      for (const s of thread.sessions) {
        const key = `${s.agent} ${s.session_id}`;
        byKey.set(key, Math.max(byKey.get(key) ?? 0, s.tokens));
      }
    }
  }
  let total = 0;
  for (const v of byKey.values()) total += v;
  return total;
}
