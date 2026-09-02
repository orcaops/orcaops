import { classifyAgent, needsAttention, type Thresholds } from './liveness.js';
import type { AgentState, WatchProject, WatchSnapshot, WatchStep, WatchThread } from './types.js';

/**
 * Re-classify every thread over a fresh `nowMs` (the TUI's 1s ticker), returning
 * a new snapshot. Classification is pure over `now`, so time-driven transitions
 * (working→quiet→stalled, a wrapping close sinking to idle) advance in memory
 * between the engine's data ticks without re-collecting from disk.
 */
export function reclassify(
  snapshot: WatchSnapshot,
  nowMs: number,
  thresholds: Thresholds
): WatchSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.map((p) => ({
      ...p,
      threads: p.threads.map((a) => ({ ...a, state: classifyAgent(a, nowMs, thresholds) })),
    })),
  };
}

/**
 * Pure presenter helpers shared by the TUI and its tests: step derivation,
 * attention ordering, and project ordering. Nothing here imports the renderer.
 */

/** Derive plan steps with done (a closed cp claimed it) / current (the open cp declares it) markers. */
export function deriveSteps(
  steps: ReadonlyArray<{ idx: number; text: string; label?: string; step_id: string }>,
  closedClaimed: ReadonlySet<string>,
  openDeclared: ReadonlySet<string>
): WatchStep[] {
  return steps.map((s) => ({
    idx: s.idx,
    text: s.text,
    label: s.label && s.label.length > 0 ? s.label : s.text,
    done: closedClaimed.has(s.step_id),
    current: openDeclared.has(s.step_id),
  }));
}

/** A flattened thread row with its project context. */
export interface FlatRow {
  thread: WatchThread;
  project: WatchProject;
}

function compareAttention(x: FlatRow, y: FlatRow): number {
  const rank = (s: AgentState): number => (s === 'stalled' ? 0 : 1);
  const dr = rank(x.thread.state) - rank(y.thread.state);
  if (dr !== 0) return dr;
  // Oldest first (smallest last-write); a null last-write sorts oldest.
  return (x.thread.lastWriteMs ?? 0) - (y.thread.lastWriteMs ?? 0);
}

/** Needs-attention rows: stalled before ready, oldest first. */
export function attentionRows(snapshot: WatchSnapshot): FlatRow[] {
  const out: FlatRow[] = [];
  for (const project of snapshot.projects) {
    for (const thread of project.threads) {
      if (needsAttention(thread.state)) out.push({ thread, project });
    }
  }
  return out.sort(compareAttention);
}

/** Project groups sorted alphabetically by display name. */
export function sortedProjects(snapshot: WatchSnapshot): WatchProject[] {
  return [...snapshot.projects].sort((a, b) => a.displayName.localeCompare(b.displayName));
}
