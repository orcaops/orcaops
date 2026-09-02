import { describe, expect, it } from 'vitest';

import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  CheckpointSnapshotBoundarySchema,
  DiffFingerprintSummarySchema,
} from './diff-fingerprint.js';

/**
 * Cross-repo contract guard.
 *
 * The OSS storage layer is the SECOND producer of the snapshot-boundary
 * and fingerprint-summary contracts — its deliberate-skip default builders
 * (`buildDefaultSkipped*`, substituted when fingerprinting is disabled by
 * config or no snapshot is attempted; disabled-by-config is NOT a failure
 * reason). The cross-repo fixture-parity gate in
 * `@orcaops/diff-fingerprint` structurally only covers the FIRST producer
 * (manifest.ts), so a protocol superRefine tightened against that producer
 * alone can retroactively reject these builders the moment the tarball is
 * re-vendored — the boundary (0.0.3) and summary (0.0.4) contract-mismatch
 * class this guard catches before a re-vendor rather than after.
 *
 * This asserts the deliberate-skip producers parse cleanly through the
 * vendored protocol schemas (re-exported here). It runs OSS-side every
 * test run, so the next such drift fails BEFORE a re-vendor, not after.
 */
describe('deliberate-skip producers conform to the vendored protocol schemas', () => {
  it('buildDefaultSkippedSnapshotBoundary() is accepted (all-null / null-error = deliberate skip)', () => {
    const r = CheckpointSnapshotBoundarySchema.safeParse(buildDefaultSkippedSnapshotBoundary());
    expect(r.success).toBe(true);
  });

  it('buildDefaultSkippedFingerprintSummary() is accepted (status skipped + error_reason null)', () => {
    const r = DiffFingerprintSummarySchema.safeParse(buildDefaultSkippedFingerprintSummary());
    expect(r.success).toBe(true);
  });

  // Pin the other legitimate states so a future over-tightening that breaks
  // them (the same failure class) is caught here too.

  it('a success boundary (all SHAs set, null error) is accepted', () => {
    const r = CheckpointSnapshotBoundarySchema.safeParse({
      snapshot_ref: 'refs/orcaops/snap/a/1/open',
      tree_sha: 'a'.repeat(40),
      snapshot_commit_sha: 'b'.repeat(40),
      snapshot_error_reason: null,
    });
    expect(r.success).toBe(true);
  });

  it('a failure boundary (all SHAs null, non-null error) is accepted', () => {
    const r = CheckpointSnapshotBoundarySchema.safeParse({
      snapshot_ref: null,
      tree_sha: null,
      snapshot_commit_sha: null,
      snapshot_error_reason: 'merge_conflict',
    });
    expect(r.success).toBe(true);
  });

  it('a mixed boundary (some SHA set, some null, null error) is still rejected', () => {
    const r = CheckpointSnapshotBoundarySchema.safeParse({
      snapshot_ref: 'refs/orcaops/snap/a/1/open',
      tree_sha: null,
      snapshot_commit_sha: null,
      snapshot_error_reason: null,
    });
    expect(r.success).toBe(false);
  });

  it('a capture-failure skipped summary (error_reason non-null) is accepted', () => {
    const r = DiffFingerprintSummarySchema.safeParse({
      ...buildDefaultSkippedFingerprintSummary(),
      error_reason: 'parser_failed',
    });
    expect(r.success).toBe(true);
  });
});
