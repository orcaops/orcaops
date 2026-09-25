import type { KnowledgeBlock } from '@orcaops/core';
import type { HistoryCompleteness, HistoryIssue } from '@orcaops/project-scope/history/database';

export type { HistoryCompleteness, HistoryIssue, KnowledgeBlock };

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

/** A summarized artifact is complete; every other retained state is still active. */
export type ArtifactStatus = 'active' | 'complete';

/** Per-session token evidence (grand total across all token classes). */
export interface SessionTokens {
  agent: string;
  session_id: string;
  /** Whether `tokens` is an exact lifetime total or an observed lower bound. */
  status: 'exact' | 'incomplete';
  /** cumulative input + output + cache-creation + cache-read. */
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
 * One thread = one artifact's live projection, read from the project's
 * canonical database. `artifactStatus` feeds the classifier (a completed
 * artifact must never classify `ready`).
 */
export interface WatchThread {
  artifactId: string;
  /** Retained revision token (`generation:orderedHash`) the display was hydrated from. */
  version: string;
  artifactStatus: ArtifactStatus;
  branch: string;
  title: string;
  agent: string;
  sessions: SessionTokens[];
  openCheckpoints: number;
  /**
   * Open comments across registered reviews on this branch (`✎ n` badge).
   * Null when the project's review comments could not be read this tick.
   */
  openComments: number | null;
  /**
   * True iff this thread's branch is the one currently checked out in THIS
   * checkout — the signal the cockpit's `v` guard needs. Reviewing a branch
   * that is NOT checked out here yields `degenerate_scope`, so `v` refuses it.
   * Threads of other projects and other branches are false.
   */
  isCurrentCheckout: boolean;
  /** Open cp's first declared step text, else the last closed summary. */
  currentLine: string | null;
  steps: { completed: number; total: number } | null;
  /** Retained artifact/binding update or provider activity high-water (ms) — the classifier's recency input. */
  lastWriteMs: number | null;
  lastClosed: LastClosed | null;
  /** The classifier fills this; it defaults to `idle`. */
  state: AgentState;
  /** Bucketed recent event counts; empty when the thread is not recently active. */
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
  /**
   * The continuing knowledge this thread is answerable to, read through the shared answer at the
   * boundary its project is committed through. Null only when the project's knowledge could not be
   * read this tick — never a shorthand for "no rules bear on this".
   */
  knowledge: KnowledgeBlock | null;
  /**
   * The code the tick's knowledge read failed with, or null when it did not fail. A pane that
   * simply left the section out would be byte-identical to one over a project holding no
   * continuing record at all, so a locked database or one on an older schema would read as
   * "nothing bears on this work".
   */
  knowledgeUnavailable: string | null;
  /** Recent events for the drill-in, newest first; empty when idle >60m. */
  recentEvents: TickerEvent[];
  /** Events older than the retained bounded activity window. */
  omittedEvents: number;
  activityWindowComplete: boolean;
}

export interface WatchProject {
  projectId: string;
  /** A locator from retained creation facts; the UI revalidates registration before using it. */
  repository?: { commonDirectory: string; instanceId: string };
  displayName: string;
  /** The validated store instance the display was read from; null when the project is unavailable. */
  authorityKey: string | null;
  /** Project write sequence observed when the display was last refreshed; null when never read. */
  writeSequence: number | null;
  /** `deferred` retains the last display after a failed refresh; `unavailable` never had one. */
  state: 'current' | 'deferred' | 'unavailable';
  completeness: HistoryCompleteness;
  threads: WatchThread[];
}

/**
 * A derived roll-up of threads sharing one (project, branch) — the TUI's mirror
 * of the web app's Task. Ephemeral: computed per render from the snapshot, never
 * stored. `state` is a liveness rollup across members (the TUI has no PR data, so
 * there is no In-Review / Merged).
 */
export interface WatchTask {
  /** `task:${projectId}:${branch}` — stable within a snapshot. */
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
  /** Sum of exact session totals deduped by (agent, session_id) across the whole snapshot. */
  sessionTokens: number;
  /** Whether every session behind `sessionTokens` accounted exactly. */
  usageStatus: 'exact' | 'partial' | 'unavailable';
}

export interface WatchSnapshot {
  /** ISO-8601 tick time. */
  generated_at: string;
  /** Epoch-ms tick time (the classifier / "ago" clock for this snapshot). */
  generatedAtMs: number;
  dataRoot: string;
  rootKey: string;
  /** `deferred` when any project retains a previous display or the catalog is incomplete. */
  state: 'current' | 'deferred';
  completeness: HistoryCompleteness;
  totals: WatchTotals;
  projects: WatchProject[];
  /** Merged recent events across all threads, newest first, capped. */
  ticker: TickerEvent[];
}
