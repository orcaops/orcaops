export * from './repo.js';

// Narrow, explicit re-export from snapshots.js. Internals (runGit /
// RunGitOptions / RunGitResult / allocateTempIndex / snapshotRefName /
// parseSnapshotRefName / classifySnapshotFailure) stay exported in
// `./snapshots.js` so colocated tests can reach them via the relative
// path, but are intentionally NOT re-exported through this barrel —
// they're implementation details, not contract. `resolveRepoTopLevel`
// IS public surface: the CLI anchors `.orcaops` to the git worktree
// root through it, and `@orcaops/core` exposes only `"."` (no deep
// import of `./git/snapshots.js`), so the barrel is the only path.
//
// The `git/index.test.ts` surface test gates this: any new value
// export here must be added to the expected runtime set, and any
// `export *` from snapshots.js will fail the source-level check.
// Treat additions as a public-surface change that warrants its own
// review.
export {
  // Baseline namespace (the per-artifact plan-time baseline ref).
  // Public surface: the CLI captures the seed at `capture plan`, gc /
  // sync auto-prune it, and doctor surfaces stray ones. `captureWorktreeTree`
  // / `pinRef` (the shared temp-index core + ref-pinner) stay internal —
  // they are NOT re-exported here, like `runGit` / `snapshotRefName`.
  baselineRefName,
  BASELINE_REF_PREFIX,
  captureBaselineSnapshot,
  captureCheckpointSnapshot,
  captureReviewWorktreeTreeSha,
  // Tree-only live worktree capture for attribution's live
  // side (no commit object accretion). The full `captureWorktreeTree`
  // stays internal, like runGit.
  captureWorktreeTreeSha,
  collectBaselineRefsForArtifact,
  collectPrunableRefsForArtifact,
  diffSnapshotStats,
  diffSnapshotTrees,
  listRawBaselineRefNames,
  listRawBaselineRefIdentities,
  listRawReviewRefNames,
  listRawReviewRefIdentities,
  listRawSnapshotRefNames,
  listRawSnapshotRefIdentities,
  listSnapshotRefs,
  // Scratch-worktree materialization of pinned snapshot
  // commits. Public surface — `orcaops snapshots checkout` is the caller.
  listSensitiveTreePaths,
  materializeSnapshotTree,
  parseBaselineRefName,
  pinBaselineTree,
  pruneBaselineRefs,
  pruneBaselineRefsIfUnchanged,
  // Review-pin namespace (refs/orcaops/review/<slug>[-base]) — pruned when gc
  // collects a stale review dir; the pins keep only that dir's trees readable.
  pruneReviewRefs,
  pruneReviewRefsIfUnchanged,
  pruneSnapshotRefs,
  pruneSnapshotRefsIfUnchanged,
  resolveRepoTopLevel,
  REVIEW_REF_PREFIX,
  SNAPSHOT_NESTED_ORCAOPS_EXCLUDE_PATHSPECS,
  SNAPSHOT_ORCAOPS_EXCLUDE_DIRS,
  SNAPSHOT_REF_PREFIX,
} from './snapshots.js';
export type {
  BaselineSnapshotResult,
  DiffSnapshotResult,
  DiffSnapshotStatsResult,
  DiffStatEntry,
  SnapshotCheckoutResult,
  SnapshotFailureReason,
  SnapshotPhase,
  SnapshotRefEntry,
  SnapshotResult,
  ReviewWorktreeTreeResult,
  ReviewUntrackedEvidenceDetail,
  RefIdentity,
} from './snapshots.js';
