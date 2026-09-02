import type { ProjectScopeIssue } from '@orcaops/project-scope';
import type { ArtifactStatus } from '@orcaops/storage';

/** Which store served this row after the hot+archive merge. Routes last-write. */
export type AgentSource = 'hot' | 'archive';

/**
 * Liveness state. Computed by the classifier (`classifyAgent`).
 * `starting` is a freshly-planned artifact with no checkpoint opened yet;
 * `done` is terminal, derived from the artifact's status.
 */
export type AgentState =
  | 'working'
  | 'quiet'
  | 'stalled'
  | 'starting'
  | 'wrapping'
  | 'ready'
  | 'idle'
  | 'done';

/** Exact per-session token total (grand total across all token classes). */
export interface SessionTokens {
  agent: string;
  session_id: string;
  /** cumulative input + output + cache-creation + cache-read (exact session lifetime total). */
  tokens: number;
}

export interface LastClosed {
  closed_at: string;
  summary: string;
  uncertaintyCount: number;
}

/** A plan step with drill-in markers (done = a closed cp claimed it; current = the open cp declares it). */
export interface WatchStep {
  idx: number;
  text: string;
  /** Short 1-line headline for the checklist (falls back to text when empty). */
  label: string;
  done: boolean;
  current: boolean;
}

/** A rejected option recorded alongside a decision. */
export interface WatchDecisionAlternative {
  option: string;
  reason: string;
}

export interface WatchDecision {
  decision: string;
  reason: string;
  /** Rejected alternatives — plan-level decisions carry these; cp decisions usually don't. */
  alternatives?: WatchDecisionAlternative[];
}

/** A plan step a checkpoint covers, resolved to its display idx + short label. */
export interface WatchCheckpointStep {
  idx: number;
  label: string;
}

/** A checkpoint in the drill-in timeline. */
export interface WatchCheckpoint {
  n: number;
  status: 'open' | 'closed';
  summary: string | null;
  uncertainties: string[];
  decisions: WatchDecision[];
  /** Steps this cp covers: completed_step_ids (closed) or declared_step_ids (open), as plan idx+label. */
  steps: WatchCheckpointStep[];
  /** Lines added/removed, summed from the close diff-fingerprint manifest. Null when open, absent, or truncated. */
  linesAdded: number | null;
  linesRemoved: number | null;
  /** Count of files changed in this cp. Null when unknown. */
  filesChanged: number | null;
}

/** A single event-log entry, projected for the ticker / drill-in recent events. */
export interface TickerEvent {
  tsMs: number;
  ts: string;
  /** Event type (e.g. `checkpoint_opened`, `checkpoint_closed`, `plan_captured`). */
  type: string;
  /** Project display name + branch, so a merged ticker line has context. */
  project: string;
  branch: string;
}

/**
 * One thread = one artifact's live projection. `artifactStatus` feeds the
 * classifier (a completed artifact must never classify `ready`); `source`
 * records which store served the row and routes the last-write lookup.
 */
export interface WatchThread {
  artifactId: string;
  artifactStatus: ArtifactStatus;
  source: AgentSource;
  branch: string;
  title: string;
  agent: string;
  sessions: SessionTokens[];
  openCheckpoints: number;
  /** Open review comments on this branch (`✎ n` badge) — checkout-local, 0 elsewhere. */
  openComments: number;
  /**
   * True iff this thread's branch is the one currently checked out in THIS
   * checkout — the signal the cockpit's `v` guard needs. Reviewing a branch
   * that is NOT checked out here yields `degenerate_scope`, so `v` refuses it.
   * Archive-only threads (no hot checkout here) and other-branch threads are
   * false. Filled by the current-checkout pass; buildThread defaults it false.
   */
  isCurrentCheckout: boolean;
  /** Open cp's first declared step text, else the last closed summary. */
  currentLine: string | null;
  steps: { completed: number; total: number } | null;
  /** Event-log/provider high-water (ms) — the classifier's recency input. Null when absent. */
  lastWriteMs: number | null;
  lastClosed: LastClosed | null;
  /** The classifier fills this; it defaults to `idle`. */
  state: AgentState;
  /** The tail pass fills this (bucketed event counts); empty otherwise. */
  sparkline: number[];
  /** Drill-in detail: the plan steps with done/current markers. */
  planSteps: WatchStep[];
  /** Drill-in detail: the checkpoint timeline (summaries, uncertainty, decisions). */
  checkpoints: WatchCheckpoint[];
  /** Plan-capture time (epoch ms) — the span anchor. Null when unknown. */
  startedAtMs: number | null;
  /** Plan-level decisions (distinct from the per-checkpoint decisions above). */
  planDecisions: WatchDecision[];
  /** Plan-level non-goals (the exclusion text). */
  nonGoals: string[];
  /** Recent events for the drill-in, newest first; empty when idle >10m. */
  recentEvents: TickerEvent[];
}

export interface WatchProject {
  /** null = the current checkout with archive NOT enabled (folded in for the CTA). */
  projectId: string | null;
  displayName: string;
  threads: WatchThread[];
}

/**
 * A derived roll-up of threads sharing one (project, branch) — the TUI's mirror
 * of the web app's Task. Ephemeral: computed per render from the snapshot, never
 * stored. `state` is a liveness rollup across members (the TUI has no PR data, so
 * there is no In-Review / Merged).
 */
export interface WatchTask {
  /** `task:${projectId ?? displayName}:${branch}` — stable within a snapshot. */
  id: string;
  /** The branch (the web keys a Task on (repo, branch)). */
  title: string;
  projectId: string | null;
  project: string;
  branch: string;
  state: AgentState;
  threads: WatchThread[];
}

export interface WatchTotals {
  activeThreads: number;
  openCheckpoints: number;
  /** Sum of session totals deduped by (agent, session_id) across the whole snapshot. */
  sessionTokens: number;
}

export type ArchiveIssue = ProjectScopeIssue;

export interface WatchSnapshot {
  /** ISO-8601 tick time. */
  generated_at: string;
  /** Epoch-ms tick time (the classifier / "ago" clock for this snapshot). */
  generatedAtMs: number;
  dataRoot: string;
  /** True when any minted/archived project exists (the cross-project view is live). */
  archiveEnabled: boolean;
  totals: WatchTotals;
  projects: WatchProject[];
  /** Merged recent events across all threads, newest first, capped. */
  ticker: TickerEvent[];
  /** Project-scope issues that make the cross-project view partial or uncertain. */
  archiveIssues?: ArchiveIssue[];
}
