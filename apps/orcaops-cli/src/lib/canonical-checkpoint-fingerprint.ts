import {
  buildDiffFingerprintManifest,
  computeWindowSegments,
  diffSnapshotTrees,
  type Repo,
  type SnapshotResult,
  type WindowSegment,
} from '@orcaops/core';
import type { CheckpointCloseCallbacks, Config } from '@orcaops/storage';

import { makeSkippedCloseResult, toBoundary } from './canonical-checkpoint-shapes.js';

export async function prepareCheckpointFingerprint(
  input: Parameters<NonNullable<CheckpointCloseCallbacks['captureCloseFingerprint']>>[0] & {
    repo: Repo;
    cap: Config['diff_fingerprint'];
    closeSnap: SnapshotResult;
  }
) {
  const { repo, cap, closeSnap, openCheckpoint, closeContext, recovery, overlap } = input;
  if (!closeSnap.ok) {
    return makeSkippedCloseResult(closeSnap.error_reason, closeSnap);
  }
  const openTreeSha = openCheckpoint.open_snapshot.tree_sha;
  if (openTreeSha === null) {
    return makeSkippedCloseResult('missing_open_tree_sha', closeSnap);
  }
  // Tree equality survives recovery changing the manifest baseline.
  const fenceEmpty = openTreeSha === closeSnap.tree_sha;

  const diff = await diffSnapshotTrees({
    repo,
    openTreeSha,
    closeTreeSha: closeSnap.tree_sha,
    maxDiffBytes: cap.max_diff_bytes,
  });
  if (!diff.ok) return makeSkippedCloseResult('git_diff_failed', closeSnap);

  const built = await buildDiffFingerprintManifest({
    artifactId: closeContext.artifact_id,
    checkpointN: closeContext.n,
    openTreeSha,
    closeTreeSha: closeSnap.tree_sha,
    diffBytes: diff.diff,
    truncated: diff.truncated,
    maxDiffBytes: cap.max_diff_bytes,
  });
  // Only positive recovered hunks replace the real empty-window evidence.
  if (fenceEmpty && recovery.filesChanged.length > 0 && !recovery.recoveryBlocked) {
    const baseline = recovery.hwmBaselineTreeSha ?? recovery.seedBaselineTreeSha;
    if (baseline !== null) {
      try {
        const recoveredDiff = await diffSnapshotTrees({
          repo,
          openTreeSha: baseline,
          closeTreeSha: closeSnap.tree_sha,
          maxDiffBytes: cap.max_diff_bytes,
          pathspecs: [...recovery.filesChanged],
        });
        if (recoveredDiff.ok) {
          const recovered = await buildDiffFingerprintManifest({
            artifactId: closeContext.artifact_id,
            checkpointN: closeContext.n,
            openTreeSha: baseline,
            closeTreeSha: closeSnap.tree_sha,
            diffBytes: recoveredDiff.diff,
            truncated: recoveredDiff.truncated,
            maxDiffBytes: cap.max_diff_bytes,
          });
          if (
            recovered.manifest !== null &&
            recovered.summary.hunk_count > 0 &&
            (recovered.summary.status === 'captured' || recovered.summary.status === 'truncated')
          ) {
            return {
              boundary: toBoundary(closeSnap).boundary,
              summary: recovered.summary,
              manifest: recovered.manifest,
              ...(closeSnap.unmerged_paths.length > 0
                ? { unmerged_paths: [...closeSnap.unmerged_paths] }
                : {}),
              ...(closeSnap.unmerged_probe_failed === true ? { unmerged_probe_failed: true } : {}),
            };
          }
        }
      } catch {
        // Preserve the original window when recovery evidence is unavailable.
      }
    }
  }
  let segmentEvidence: WindowSegment[] | undefined;
  if (overlap !== undefined && closeSnap.tree_sha !== null) {
    try {
      segmentEvidence = await computeWindowSegments({
        repo,
        boundaries: [
          ...overlap.boundaries,
          {
            eventIdx: overlap.currentCloseIdx,
            n: closeContext.n,
            phase: 'close',
            treeSha: closeSnap.tree_sha,
          },
        ],
      });
    } catch {
      // Missing segment evidence leaves the existing claims-only qualification.
    }
  }

  return {
    boundary: toBoundary(closeSnap).boundary,
    summary: built.summary,
    manifest: built.manifest,
    ...(segmentEvidence !== undefined ? { segment_evidence: segmentEvidence } : {}),
    ...(closeSnap.unmerged_paths.length > 0
      ? { unmerged_paths: [...closeSnap.unmerged_paths] }
      : {}),
    ...(closeSnap.unmerged_probe_failed === true ? { unmerged_probe_failed: true } : {}),
  };
}
