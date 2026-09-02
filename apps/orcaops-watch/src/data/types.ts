// Re-export the package's snapshot data shapes. These are type-only (erased at
// runtime), so importing them never pulls in the sqlite-bound engine.
export type {
  AgentState,
  ArchiveIssue,
  SessionTokens,
  TickerEvent,
  WatchThread,
  WatchCheckpoint,
  WatchCheckpointStep,
  WatchDecision,
  WatchDecisionAlternative,
  WatchProject,
  WatchSnapshot,
  WatchStep,
  WatchTask,
  WatchTotals,
} from '../core/types';
