import type { AgentState, WatchProject, WatchTask, WatchThread } from '@orcaops/watch-data/ui';

/** Default branches accumulate many unrelated threads, so they are never rolled into a task. */
const DEFAULT_BRANCHES = new Set(['main', 'master']);

/** Is `branch` a default branch (whose threads stay ungrouped as loose rows)? */
export function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCHES.has(branch.trim().toLowerCase());
}

// Highest-urgency member state wins: attention states outrank live, live outranks terminal.
const ROLLUP_PRIORITY: readonly AgentState[] = [
  'stalled',
  'ready',
  'working',
  'starting',
  'wrapping',
  'quiet',
  'idle',
  'done',
];

/** Roll a task's state up from its member threads (most-urgent wins; empty → idle). */
export function rollupState(threads: readonly WatchThread[]): AgentState {
  let best: AgentState = 'idle';
  let bestRank = Number.POSITIVE_INFINITY;
  for (const thread of threads) {
    const rank = ROLLUP_PRIORITY.indexOf(thread.state);
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank;
      best = thread.state;
    }
  }
  return best;
}

/**
 * Derive tasks for one project by clustering threads on the same non-default
 * branch — mirroring the web app's (repo, branch) roll-up. Default-branch threads
 * (main/master) are returned as `loose` standalone rows rather than forced into a
 * meaningless mega-task. Tasks are ordered by branch; a single-thread feature
 * branch still forms a task (matches the web's keying).
 */
export function deriveTasks(project: WatchProject): { tasks: WatchTask[]; loose: WatchThread[] } {
  const loose: WatchThread[] = [];
  const byBranch = new Map<string, WatchThread[]>();
  for (const thread of project.threads) {
    if (isDefaultBranch(thread.branch)) {
      loose.push(thread);
      continue;
    }
    const bucket = byBranch.get(thread.branch);
    if (bucket) bucket.push(thread);
    else byBranch.set(thread.branch, [thread]);
  }
  const tasks: WatchTask[] = [...byBranch.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([branch, threads]) => ({
      id: `task:${project.projectId ?? project.displayName}:${branch}`,
      title: branch,
      projectId: project.projectId,
      project: project.displayName,
      branch,
      state: rollupState(threads),
      threads,
    }));
  return { tasks, loose };
}
