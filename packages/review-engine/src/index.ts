// @orcaops/review-engine — the Task Review data layer: floor assembly,
// two-lane review runs, the reviewer journal, the comment loop, and anchors.
//
// ONE implementation, two consumers: the orcaops CLI exposes it as the public
// `orcaops review …` command group, and the watch app's Node sidecar routes
// its internal `review …` argv to the same `runReview`. Everything here is
// plain Node (storage/git/fs) — no renderer, no Bun.

export { runAnchor } from './anchor.js';
export { type ReviewArchiveWarning } from './archive.js';
export {
  type CommentsPayload,
  type EnrichedComment,
  runCommentAction,
  runComments,
} from './comments.js';
export { buildFloor, FLOOR_PRODUCER_VERSION } from './floor.js';
export * from './floorSource.js';
export * from './currentStory.js';
export { validateReviewLogFiles } from './durableState.js';
export {
  JOURNAL_APPEND_REJECTION_CODE,
  type JournalAppendRejection,
  type JournalAppendRejectionCode,
  runJournal,
} from './journal.js';
export { type NormalizedDiff, normalizeTruncatedReviewDiff } from './truncate.js';
export {
  ensureReviewStateVersion,
  REVIEW_STATE_VERSION,
  type ReviewStateInitialization,
} from './reviewState.js';
export {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
  type EligibleTargetWithCode,
  rowsForEligibleTarget,
} from './reviewTargets.js';
export * from './runtimeIdentity.js';
export * from './semanticAnchors.js';
export * from './semanticAnchorGenerations.js';
export * from './storyReviewModel.js';
export { SLICE_DIAGNOSTIC_CODES } from './twolaneSlice.js';
export {
  parseReviewArgs,
  resolveReviewRoot,
  type ReviewArgs,
  reviewFloorLockKey,
  reviewLocksDir,
  runReview,
} from './run.js';
