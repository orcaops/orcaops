export {
  CheckpointSnapshotBoundarySchema,
  DiffFingerprintFailureReasonSchema,
  DiffFingerprintHunkSchema,
  DiffFingerprintManifestSchema,
  DiffFingerprintStatusSchema,
  DiffFingerprintSummarySchema,
  SnapshotFailureReasonSchema,
  SnapshotPhaseSchema,
} from '@orcaops/diff-fingerprint';
export type {
  CheckpointSnapshotBoundary,
  DiffFingerprintFailureReason,
  DiffFingerprintHunk,
  DiffFingerprintManifest,
  DiffFingerprintStatus,
  DiffFingerprintSummary,
  SnapshotFailureReason,
  SnapshotPhase,
} from '@orcaops/diff-fingerprint';
import type { CheckpointSnapshotBoundary, DiffFingerprintSummary } from '@orcaops/diff-fingerprint';
export function buildDefaultSkippedSnapshotBoundary(): CheckpointSnapshotBoundary {
  return {
    snapshot_ref: null,
    tree_sha: null,
    snapshot_commit_sha: null,
    snapshot_error_reason: null,
  };
}
export function buildDefaultSkippedFingerprintSummary(): DiffFingerprintSummary {
  return {
    status: 'skipped',
    hunk_count: 0,
    captured_hunk_count: 0,
    truncated: false,
    fingerprint_algorithm: null,
    manifest_hash: null,
    manifest_hash_algorithm: null,
    error_reason: null,
  };
}
