// Local attribution matcher: exact hunk-hash matching of a live diff
// against checkpoint manifests, plus the line-membership primitive.
// Small module — the whole surface is public contract for
// `orcaops diff --attribution`, the `resolveWhy` line tier, and the
// agent-trace exporter.
export { isKnownWeakHunk, matchDiffAgainstManifests } from './matcher.js';
export type {
  AttributedHunk,
  AttributionCoverage,
  HunkMatch,
  ManifestSource,
  MatchDiffResult,
} from './matcher.js';
export { lineContentMatch, TRIVIAL_LINE_MIN_BYTES } from './line-match.js';
export type { LineMatchResult } from './line-match.js';
// Commit-level reconcile: in-window commits vs checkpoint coverage,
// for `orcaops diff --reconcile`.
export { reconcileCommitsAgainstCoverage } from './reconcile.js';
export type { ReconcileCommit, ReconcileResult, ReconciledCommit } from './reconcile.js';
// Segment evidence: boundary-tree file-sets for the claims partition
// under window overlap.
export { computeWindowSegments } from './segments.js';
export type { SegmentBoundaryInput, WindowSegment } from './segments.js';
