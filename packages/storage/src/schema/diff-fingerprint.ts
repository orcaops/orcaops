// Storage-side surface for the checkpoint diff-fingerprint schemas.
//
// Re-exports the four primary schemas (CheckpointSnapshotBoundary,
// DiffFingerprintHunk, DiffFingerprintSummary, DiffFingerprintManifest)
// + their four backing enum schemas from `@orcaops/diff-fingerprint`.
// That package itself re-exports them from `@orcaops/protocol`, so the
// storage layer ↔ cloud wire ↔ matcher builder all reference the same
// single source of truth. The fixture-parity gate in
// `@orcaops/diff-fingerprint` guarantees byte-identical canonical/hash
// output across the boundary.
//
// Mirrors the existing precedent in `./evaluator-run.ts`, which
// re-exports schemas from `@orcaops/evaluator-protocol` and adds
// storage-specific materialized helpers on top.
//
// This module ALSO owns two storage-side default-builder helpers used
// exclusively by the WRITE path in `packages/storage/src/artifacts/store.ts`:
//
//   * `buildDefaultSkippedSnapshotBoundary()` — the deliberate-skip
//     boundary (all-null ref/tree/commit + `snapshot_error_reason: null`)
//     that storage substitutes when a caller's `snapshotCallbacks` field
//     is absent.
//
//   * `buildDefaultSkippedFingerprintSummary()` — the deliberate-skip
//     summary (`status: 'skipped'`, zero counts, all-null algorithm
//     identifiers, `error_reason: null`) substituted in the same case.
//
// Both helpers represent "did not attempt" — distinct from "tried and
// unexpectedly failed" which is encoded by `snapshot_error_reason: 'unknown'`
// + `fingerprint_summary.error_reason: 'unknown'` in the write path's
// defense-in-depth try/catch (see store.ts callback wiring).
//
// **The defaults live in the WRITE path only.** The rebuilder
// (`packages/storage/src/events/rebuilders.ts`) reads the v4 event-payload
// fields with no fallback — if an old v3 event lacks them, rebuild fails
// by design (strict clean break, no rebuilder forward-defaults).

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

/**
 * The deliberate-skip snapshot boundary: every reference field is null
 * and `snapshot_error_reason` is null (signalling no error occurred —
 * the caller chose not to capture). Substituted by the write path when
 * `snapshotCallbacks` is absent. Distinct from a captured-then-failed
 * boundary, which carries a concrete `snapshot_error_reason` like
 * `'merge_conflict'` or `'unknown'`.
 */
export function buildDefaultSkippedSnapshotBoundary(): CheckpointSnapshotBoundary {
  return {
    snapshot_ref: null,
    tree_sha: null,
    snapshot_commit_sha: null,
    snapshot_error_reason: null,
  };
}

/**
 * The deliberate-skip fingerprint summary: `status: 'skipped'` with all
 * counts zero, every algorithm identifier null, and `error_reason: null`
 * (no error occurred — the caller chose not to capture). Substituted by
 * the write path on `writeCheckpointClosed` when `snapshotCallbacks` is
 * absent. Distinct from a captured-then-failed summary, which carries a
 * concrete `error_reason` like `'cap_exceeded'` or `'unknown'`.
 */
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
