// Narrow, explicit re-export from `./adapter.js`. The adapter module owns
// the curation rationale; this barrel re-exports the same surface so
// external callers go through `@orcaops/core`'s top-level barrel without
// reaching into a `diff-fingerprint/adapter` subpath.
//
// The `diff-fingerprint/index.test.ts` surface test gates this: any new
// value or type export must be added to the expected set there, and any
// `export *` from `@orcaops/diff-fingerprint` will fail the source-level
// check. Treat additions as a public-surface change that warrants its
// own review.

export {
  buildDiffFingerprintManifest,
  computeDiffFingerprintManifestHash,
  DIFF_ALGORITHM,
  fingerprintUnifiedDiff,
  HASH_ENCODING,
  HUNK_HEADER_HASH_ALGORITHM,
  LINE_HASH_ALGORITHM,
  // Line-membership primitives for the attribution matcher
  // (surface-widening rationale in adapter.ts).
  lineHash,
  LINE_NORMALIZATION_VERSION,
  MANIFEST_HASH_ALGORITHM,
  normalizeLineBody,
  parseUnifiedDiff,
  PATCH_HASH_ALGORITHM,
  summarizeManifest,
} from './adapter.js';

export type {
  CheckpointSnapshotBoundary,
  DiffFingerprintFailureReason,
  DiffFingerprintHunk,
  DiffFingerprintManifest,
  DiffFingerprintStatus,
  DiffFingerprintSummary,
  NormalizedHunk,
} from './adapter.js';
