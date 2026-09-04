import { attentionRows, sortedProjects } from '@orcaops/watch-data/ui';
import type { WatchProject, WatchSnapshot, WatchTask, WatchThread } from '@orcaops/watch-data/ui';

import { deriveTasks } from '../core/tasks';

export type StatusFilter = 'all' | 'attention' | 'working' | 'ready' | 'idle';

/** How the rail clusters its rows: flat, by derived task, or by project. */
export type GroupBy = 'none' | 'task' | 'project';

/** The order the `g` keybind cycles through. */
export const GROUPBY_ORDER: readonly GroupBy[] = ['none', 'task', 'project'];

/**
 * One navigable rail row: a thread (a captured session) or a derived task
 * aggregate (in `task` mode). Thread rows carry their project because a
 * `WatchThread` has no project name (lost in the pinned attention group otherwise).
 */
export type RailRow =
  | {
      kind: 'thread';
      id: string;
      thread: WatchThread;
      project: string;
      projectId: string | null;
    }
  | { kind: 'task'; id: string; task: WatchTask };

export interface RailGroup {
  key: string;
  title: string;
  tone: 'attention' | 'project' | 'flat';
  branch?: string;
  count: number;
  rows: RailRow[];
}

/** Does a thread pass the active status filter? */
export function matchesFilter(
  thread: WatchThread,
  isAttention: boolean,
  filter: StatusFilter
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'attention':
      return isAttention;
    case 'ready':
      return thread.state === 'ready';
    case 'working':
      return (
        thread.state === 'working' ||
        thread.state === 'quiet' ||
        thread.state === 'wrapping' ||
        thread.state === 'starting'
      );
    case 'idle':
      return thread.state === 'idle' || thread.state === 'done';
    default:
      return true;
  }
}

const threadRow = (thread: WatchThread, project: string, projectId: string | null): RailRow => ({
  kind: 'thread',
  id: thread.artifactId,
  thread,
  project,
  projectId,
});

const taskRow = (task: WatchTask): RailRow => ({ kind: 'task', id: task.id, task });

export interface RailOptions {
  groupBy?: GroupBy;
  filter?: StatusFilter;
  repo?: string | null;
}

/**
 * Build the grouped rail. NEEDS ATTENTION (thread-granular: stalled/ready) is
 * pinned first in EVERY mode, then the main rail is arranged by `groupBy`:
 *   - `none`: one flat group of all threads;
 *   - `project` (default): one group per project;
 *   - `task`: per project, threads clustered into task rows by (project, branch),
 *     with default-branch threads left as loose thread rows.
 * Honors the status + repo filters and reuses the shared presenter ordering
 * (attentionRows / sortedProjects).
 */
export function railGroups(
  snapshot: WatchSnapshot,
  { groupBy = 'project', filter = 'all', repo = null }: RailOptions = {}
): RailGroup[] {
  const groups: RailGroup[] = [];
  const attn = attentionRows(snapshot);
  const attnIds = new Set(attn.map((row) => row.thread.artifactId));
  const repoOk = (displayName: string): boolean => repo === null || displayName === repo;

  // NEEDS ATTENTION — pinned first, thread rows, in every mode.
  const attnRows: RailRow[] = attn
    .filter((row) => repoOk(row.project.displayName) && matchesFilter(row.thread, true, filter))
    .map((row) => threadRow(row.thread, row.project.displayName, row.project.projectId));
  if (attnRows.length > 0) {
    groups.push({
      key: '__attention',
      title: 'NEEDS ATTENTION',
      tone: 'attention',
      count: attnRows.length,
      rows: attnRows,
    });
  }

  // Non-attention threads for a project, honoring the status filter.
  const remainder = (project: WatchProject): WatchThread[] =>
    project.threads.filter(
      (thread) => !attnIds.has(thread.artifactId) && matchesFilter(thread, false, filter)
    );

  if (groupBy === 'none') {
    const rows: RailRow[] = [];
    for (const project of sortedProjects(snapshot)) {
      if (!repoOk(project.displayName)) continue;
      for (const thread of remainder(project)) {
        rows.push(threadRow(thread, project.displayName, project.projectId));
      }
    }
    if (rows.length > 0) {
      groups.push({ key: '__all', title: 'THREADS', tone: 'flat', count: rows.length, rows });
    }
    return groups;
  }

  // 'project' — one row per thread; 'task' — task rows for non-default branches
  // plus loose thread rows for default-branch threads. `count` stays the thread
  // total so the header reads honestly; `rows` may be fewer (grouped).
  for (const project of sortedProjects(snapshot)) {
    if (!repoOk(project.displayName)) continue;
    const threads = remainder(project);
    // In the ordinary all-status task view, aggregate the full branch even when
    // actionable members are also pinned above as shortcuts. Otherwise a task's
    // count/state/detail silently omit its stalled or review-ready members.
    const presentationThreads = groupBy === 'task' && filter === 'all' ? project.threads : threads;
    if (presentationThreads.length === 0) continue;

    let rows: RailRow[];
    if (groupBy === 'task') {
      const { tasks, loose } = deriveTasks({ ...project, threads: presentationThreads });
      rows = [
        ...tasks.map(taskRow),
        // Attention shortcuts already exist in the pinned group; avoid an exact
        // duplicate loose row while retaining those members inside task rollups.
        ...loose
          .filter((thread) => !attnIds.has(thread.artifactId))
          .map((thread) => threadRow(thread, project.displayName, project.projectId)),
      ];
    } else {
      rows = threads.map((thread) => threadRow(thread, project.displayName, project.projectId));
    }

    if (rows.length === 0) continue;

    groups.push({
      key: project.projectId ?? project.displayName,
      title: project.displayName,
      tone: 'project',
      branch: presentationThreads[0]?.branch,
      count: presentationThreads.length,
      rows,
    });
  }

  return groups;
}

/** Flat ordered list of navigable row ids (thread artifactIds; task ids later), in display order. */
export function navOrder(groups: readonly RailGroup[]): string[] {
  return groups.flatMap((group) => group.rows.map((row) => row.id));
}

/** Flat ordered list of navigable rows, parallel to {@link navOrder}, for resolving the selection. */
export function navRows(groups: readonly RailGroup[]): RailRow[] {
  return groups.flatMap((group) => [...group.rows]);
}

/** Semantic rail location retained while grouping/filtering changes row ids. */
export interface RailSelectionAnchor {
  artifactId: string | null;
  project: string;
  projectId: string | null;
  branch: string;
  index: number;
}

export function railSelectionAnchor(
  rows: readonly RailRow[],
  selectedId: string | null,
  previous: RailSelectionAnchor | null = null
): RailSelectionAnchor | null {
  const index = rows.findIndex((row) => row.id === selectedId);
  const row = rows[index];
  if (row === undefined) return null;
  if (row.kind === 'thread') {
    return {
      artifactId: row.thread.artifactId,
      project: row.project,
      projectId: row.projectId,
      branch: row.thread.branch,
      index,
    };
  }
  const retainedArtifact =
    previous !== null &&
    previous.projectId === row.task.projectId &&
    previous.branch === row.task.branch &&
    previous.artifactId !== null &&
    row.task.threads.some((thread) => thread.artifactId === previous.artifactId)
      ? previous.artifactId
      : null;
  return {
    artifactId: retainedArtifact,
    project: row.task.project,
    projectId: row.task.projectId,
    branch: row.task.branch,
    index,
  };
}

/** Resolve exact artifact → containing task/branch → nearest surviving row. */
export function resolveRailSelection(
  groups: readonly RailGroup[],
  anchor: RailSelectionAnchor | null
): string | null {
  const rows = navRows(groups);
  if (rows.length === 0) return null;
  if (anchor === null) return rows[0]?.id ?? null;
  if (anchor.artifactId !== null) {
    const exact = rows.find(
      (row) => row.kind === 'thread' && row.thread.artifactId === anchor.artifactId
    );
    if (exact !== undefined) return exact.id;
    const containingTask = rows.find(
      (row) =>
        row.kind === 'task' &&
        row.task.projectId === anchor.projectId &&
        row.task.branch === anchor.branch &&
        row.task.threads.some((thread) => thread.artifactId === anchor.artifactId)
    );
    if (containingTask !== undefined) return containingTask.id;
  }
  const sameBranch = rows.find((row) =>
    row.kind === 'thread'
      ? row.projectId === anchor.projectId && row.thread.branch === anchor.branch
      : row.task.projectId === anchor.projectId && row.task.branch === anchor.branch
  );
  if (sameBranch !== undefined) return sameBranch.id;
  return rows[Math.min(anchor.index, rows.length - 1)]?.id ?? null;
}

/** Resolve a selection id to its thread (or null if it fell out of the list). */
export function findThread(snapshot: WatchSnapshot | null, id: string | null): WatchThread | null {
  if (snapshot === null || id === null) return null;
  for (const project of snapshot.projects) {
    for (const thread of project.threads) {
      if (thread.artifactId === id) return thread;
    }
  }
  return null;
}

/** Count threads in each status bucket (for the filter chip counts). */
export function statusCounts(snapshot: WatchSnapshot): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = {
    all: 0,
    attention: 0,
    working: 0,
    ready: 0,
    idle: 0,
  };
  const attnIds = new Set(attentionRows(snapshot).map((row) => row.thread.artifactId));
  for (const project of snapshot.projects) {
    for (const thread of project.threads) {
      const isAttention = attnIds.has(thread.artifactId);
      for (const f of ['all', 'attention', 'working', 'ready', 'idle'] as StatusFilter[]) {
        if (matchesFilter(thread, isAttention, f)) counts[f] += 1;
      }
    }
  }
  return counts;
}

/** All repo display names present in the snapshot, in sorted order. */
export function repoNames(snapshot: WatchSnapshot): string[] {
  return sortedProjects(snapshot).map((project) => project.displayName);
}

/** Total threads across all projects. */
export function totalThreads(snapshot: WatchSnapshot): number {
  return snapshot.projects.reduce((total, project) => total + project.threads.length, 0);
}

/** Total derived tasks across all projects (mode-independent), for the TASKS tile. */
export function totalTasks(snapshot: WatchSnapshot): number {
  return snapshot.projects.reduce((total, project) => total + deriveTasks(project).tasks.length, 0);
}

/** Approximate line offset of the selected row within the rail (header=2, row=2). */
export function railLineOffset(groups: readonly RailGroup[], id: string | null): number {
  let line = 0;
  for (const group of groups) {
    line += 2;
    for (const row of group.rows) {
      if (row.id === id) return line;
      line += 2;
    }
  }
  return 0;
}

/** Total rendered line count of the rail (for scroll clamping). */
export function railLineCount(groups: readonly RailGroup[]): number {
  return groups.reduce((total, group) => total + 2 + group.rows.length * 2, 0);
}
