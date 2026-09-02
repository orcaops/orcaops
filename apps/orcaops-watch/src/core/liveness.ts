import type { AgentState, WatchThread } from './types.js';

/** Liveness thresholds consumed by `classifyAgent`. */
export interface Thresholds {
  /** open cp + last write younger than this → working. */
  workingMaxMs: number;
  /** open cp + last write younger than this → quiet; older → stalled. */
  quietMaxMs: number;
  /** no open cp, not ready, last write younger than this → starting (never closed) / wrapping (has a close); else idle. */
  wrapWindowMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  workingMaxMs: 90_000,
  quietMaxMs: 600_000,
  wrapWindowMs: 300_000,
};

/** The classification-relevant slice of a WatchThread. */
export type ClassifyInputs = Pick<
  WatchThread,
  'artifactStatus' | 'openCheckpoints' | 'lastWriteMs' | 'lastClosed'
>;

/**
 * Pure liveness classification over (inputs, now, thresholds). "artifact still
 * active" is a real input, not an assumption — the candidate set includes
 * completed artifacts (via the 24h window), and a completed artifact
 * must NEVER classify `ready`.
 *
 *   - Terminal `artifactStatus` wins first: `complete` → `done`
 *     (age-independent; a finished thread never reads idle/ready).
 *   - With an OPEN checkpoint, state is keyed purely off last-write recency:
 *     <workingMax → working, <quietMax → quiet, else stalled.
 *   - With NO open checkpoint, `ready` is AGE-INDEPENDENT: a still-active
 *     artifact whose last close carries a summary + recorded uncertainty stays
 *     `ready` no matter how old — a recorded uncertainty must never silently
 *     expire off the attention board. The state only clears when the inputs
 *     change (a new cp opens, writes resume, or the artifact is summarized).
 *   - Otherwise a fresh write within wrapWindow → `starting` when the artifact
 *     has never closed a checkpoint (only its plan is captured — it's just
 *     getting going, not winding down), else `wrapping` (a close happened, so
 *     there's something to wrap); older than the window → idle.
 */
export function classifyAgent(
  inputs: ClassifyInputs,
  nowMs: number,
  thresholds: Thresholds
): AgentState {
  // Terminal artifact status wins over liveness: a completed thread is done
  // regardless of open checkpoints, recency, or recorded uncertainty — so
  // finished work never reads as "idle".
  if (inputs.artifactStatus === 'complete') return 'done';

  const ageMs = inputs.lastWriteMs === null ? Number.POSITIVE_INFINITY : nowMs - inputs.lastWriteMs;

  if (inputs.openCheckpoints > 0) {
    if (ageMs < thresholds.workingMaxMs) return 'working';
    if (ageMs < thresholds.quietMaxMs) return 'quiet';
    return 'stalled';
  }

  if (
    inputs.artifactStatus === 'active' &&
    inputs.lastClosed !== null &&
    inputs.lastClosed.uncertaintyCount > 0 &&
    inputs.lastClosed.summary.trim().length > 0
  ) {
    return 'ready';
  }

  // No open checkpoint and no recorded-uncertainty close. A recent write with
  // NO prior close is a freshly-planned artifact just starting up; `wrapping`
  // is reserved for winding down after a close (there must be something to wrap).
  if (ageMs < thresholds.wrapWindowMs) {
    return inputs.lastClosed === null ? 'starting' : 'wrapping';
  }
  return 'idle';
}

/** The states that pull the human in — pinned to the attention section. */
export function needsAttention(state: AgentState): boolean {
  return state === 'stalled' || state === 'ready';
}
