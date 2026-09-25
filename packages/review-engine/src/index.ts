// @orcaops/review-engine — the Task Review data layer: floor assembly,
// two-lane review runs, the reviewer journal, the comment loop, and anchors.
//
// ONE implementation, two consumers: the orcaops CLI exposes it as the public
// `orcaops review …` command group, and the watch app's Node sidecar routes
// its internal `review …` argv to the same `runReview`. Everything here is
// plain Node (storage/git/fs) — no renderer, no Bun.

export { runAnchor } from './anchor.js';
export {
  type CommentsPayload,
  type EnrichedComment,
  runCommentAction,
  runComments,
} from './comments.js';
export { buildFloor, FLOOR_PRODUCER_VERSION } from './floor.js';
export {
  DOSSIER_KNOWLEDGE_BOUNDS,
  type DossierKnowledge,
  type DossierKnowledgeEntry,
  dossierKnowledge,
} from './dossier.js';
export { reviewKnowledge } from './database/run-inputs.js';
export {
  type DatabaseReviewPane,
  type PaneRoutineStory,
  type PaneStoryAnchors,
  type PaneStoryStatus,
  readDatabaseReviewPane,
} from './database/pane.js';
export * from './floorSource.js';
export * from './projectReviewIdentity.js';
export {
  JOURNAL_APPEND_REJECTION_CODE,
  type JournalAppendRejection,
  type JournalAppendRejectionCode,
  runJournal,
} from './journal.js';
export { type NormalizedDiff, normalizeTruncatedReviewDiff } from './truncate.js';
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
export { parseReviewArgs, resolveReviewRoot, type ReviewArgs, runReview } from './run.js';

export { isolatedReviewGitEnvironment } from './git.js';
