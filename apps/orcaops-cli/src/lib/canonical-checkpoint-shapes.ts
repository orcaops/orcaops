import type { SnapshotFailureReason, SnapshotPhase, SnapshotResult } from '@orcaops/core';
import type { EvaluatorRunPayload, GateAuditRun } from '@orcaops/evaluator-protocol';
import {
  type AttributionDegraded,
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
  type CheckpointSnapshotBoundary,
  type DiffFingerprintFailureReason,
  type DiffFingerprintManifest,
  type DiffFingerprintSummary,
  type WindowOverlap,
} from '@orcaops/storage';

export function emptyDiffWindowWarning(n: number): { code: string; message: string } {
  return {
    code: 'empty-diff-window',
    message:
      `Checkpoint ${n} closed with an EMPTY diff even though it reported changed ` +
      `files: those changes landed outside its open-to-close window and lose ` +
      `per-line attribution. Open the next checkpoint before you change the worktree.`,
  };
}

export interface SnapshotCaptureFailure {
  phase: SnapshotPhase;
  reason: SnapshotFailureReason;
  /**
   * Raw git stderr. Present on every path that routes through
   * `classifySnapshotFailure` — i.e. precisely the paths that can produce the
   * uninformative `'unknown'`, which is the whole reason this field exists.
   * Absent only on `captureWorktreeTree`'s unborn-HEAD pre-flight
   * short-circuit, whose reason — 'unborn_repo' — already names itself.
   * `merge_conflict` always carries one: an unmerged index does not fail
   * capture, so that reason only ever arrives via stderr classification.
   */
  message?: string;
}

export const SNAPSHOT_ERROR_MESSAGE_MAX_CHARS = 600;

export const SNAPSHOT_FAILURE_CONSEQUENCE: Record<SnapshotPhase, string> = {
  open:
    `The open boundary has no tree, so this checkpoint's close has nothing to ` +
    `diff against ('missing_open_tree_sha') and its work loses per-line attribution.`,
  close:
    `The close boundary has no tree, so this checkpoint's diff fingerprint is ` +
    `skipped and its work loses per-line attribution.`,
  abandon:
    `The abandon boundary has no tree, so the abandoned work cannot be ` +
    `materialized from its snapshot ref later.`,
};

export function truncateSnapshotErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= SNAPSHOT_ERROR_MESSAGE_MAX_CHARS) return trimmed;
  return (
    `${trimmed.slice(0, SNAPSHOT_ERROR_MESSAGE_MAX_CHARS)}… ` +
    `[truncated; ${trimmed.length} chars total]`
  );
}

export function captureExcludeInvalidWarning(invalid: readonly string[]): {
  code: string;
  message: string;
} {
  return {
    code: 'capture-exclude-invalid',
    message:
      `capture.exclude has ${invalid.length} invalid pattern(s) ` +
      `[${invalid.map((p) => JSON.stringify(p)).join(', ')}] — each was IGNORED, so any path ` +
      `it was meant to withhold was captured. Fix or remove the entry in capture.exclude.`,
  };
}

export function captureExcludeProbeFailedWarning(
  n: number,
  phase: SnapshotPhase
): { code: string; message: string } {
  return {
    code: 'capture-exclude-probe-failed',
    message:
      `Checkpoint ${n} ${phase} snapshot captured, but the exclude probe ` +
      `(git ls-files --others) failed — capture.exclude did not run at this boundary, so ` +
      `every path it was meant to withhold is in the snapshot tree. ` +
      `Inspect with: orcaops snapshots checkout`,
  };
}

export function snapshotCaptureFailedWarning(
  n: number,
  failure: SnapshotCaptureFailure
): { code: string; message: string } {
  const detail =
    failure.message === undefined || failure.message.length === 0
      ? '(git reported no message)'
      : truncateSnapshotErrorMessage(failure.message);
  return {
    code: 'snapshot-capture-failed',
    message:
      `Checkpoint ${n} ${failure.phase} snapshot capture FAILED ` +
      `(snapshot_error_reason: ${failure.reason}). ` +
      `${SNAPSHOT_FAILURE_CONSEQUENCE[failure.phase]} ` +
      `Capture is fail-open, so the checkpoint itself committed. git said: ${detail}`,
  };
}

export const UNMERGED_DEGRADED_CONSEQUENCE: Record<SnapshotPhase, string> = {
  open:
    `The snapshot captured, but these paths will be EXCLUDED from per-line ` +
    `attribution for this checkpoint — attribution will be PARTIAL, not lost; ` +
    `other files attribute normally. Resolve the conflicts (edit, then ` +
    `\`git add <path>\`, or \`git merge --abort\`) before closing to keep the ` +
    `exclusion set from growing.`,
  close:
    `Attribution is PARTIAL: hunks touching these paths were removed from the ` +
    `diff fingerprint; all other files attribute normally. Resolve the ` +
    `conflicts before the next checkpoint boundary.`,
  abandon:
    `The abandon snapshot captured the conflicted worktree bytes (markers ` +
    `included) — a later salvage of this checkpoint materializes them as-is.`,
};

export function unmergedPathsDegradedWarning(
  n: number,
  phase: SnapshotPhase,
  paths: readonly string[]
): { code: string; message: string } {
  return {
    code: 'unmerged-paths-degraded',
    message:
      `Checkpoint ${n} ${phase === 'close' ? 'closed' : `${phase}ed`} with ` +
      `${paths.length} unmerged git path(s): ${paths.join(', ')}. ` +
      `${UNMERGED_DEGRADED_CONSEQUENCE[phase]} Inspect with: git status --short`,
  };
}

export function unmergedProbeFailedWarning(
  n: number,
  phase: SnapshotPhase
): { code: string; message: string } {
  return {
    code: 'unmerged-probe-failed',
    message:
      `Checkpoint ${n} ${phase} snapshot captured, but the unmerged-index probe ` +
      `(git ls-files -u) failed — degraded-path detection was unavailable at this ` +
      `boundary, so per-line attribution may silently include conflicted paths. ` +
      `Inspect with: git status --short`,
  };
}

export function attributionDegradedWarnings(
  n: number,
  degraded: AttributionDegraded | undefined
): Array<{ code: string; message: string }> {
  if (degraded === undefined) return [];
  return [
    ...(degraded.unmerged_paths.length > 0
      ? [unmergedPathsDegradedWarning(n, 'close', degraded.unmerged_paths)]
      : []),
    ...(degraded.probe_failed === true
      ? [
          {
            code: 'unmerged-probe-failed',
            message:
              `Checkpoint ${n} closed, but the unmerged-index probe (git ls-files -u) ` +
              `failed at one of its boundaries — the empty exclusion set must not be ` +
              `read as verified-clean; per-line attribution may silently include ` +
              `conflicted paths. Inspect with: git status --short`,
          },
        ]
      : []),
  ];
}

export function windowOverlapWarnings(
  n: number,
  wo: WindowOverlap | undefined
): Array<{ code: string; message: string }> {
  if (wo === undefined) return [];
  const warnings: Array<{ code: string; message: string }> = [];
  const droppedUnclaimed = wo.dropped_files
    .filter((d) => d.status === 'unclaimed')
    .map((d) => d.file_after ?? d.file_before ?? '(unknown)');
  const unattributed = [...new Set([...droppedUnclaimed, ...wo.unattributed_in_window])].sort();
  if (unattributed.length > 0) {
    warnings.push({
      code: 'window-overlap-unattributed',
      message:
        `Checkpoint ${n} closed a concurrent window with in-window changes NO checkpoint ` +
        `accounts for: ${unattributed.join(', ')}. This work has no attribution owner — ` +
        `claim it on the checkpoint that produced it.`,
    });
  }
  if (wo.rejected_claims.length > 0) {
    warnings.push({
      code: 'window-overlap-rejected-claims',
      message:
        `Checkpoint ${n} claimed files that segment evidence contradicts (changed only ` +
        `while this checkpoint was not open): ${wo.rejected_claims.join(', ')}. The claims ` +
        `were not honored.`,
    });
  }
  if (wo.ambiguous_files.length > 0) {
    warnings.push({
      code: 'window-overlap-ambiguous',
      message:
        `Checkpoint ${n} and a concurrent sibling both claim: ${wo.ambiguous_files
          .map((f) => f.file_after ?? f.file_before ?? '(unknown)')
          .join(', ')}. Kept in both manifests, flagged ambiguous — attribution consumers ` +
        `treat these as weak evidence.`,
    });
  }
  if (wo.mixed_segment.length > 0) {
    warnings.push({
      code: 'window-overlap-mixed-segment',
      message:
        `Checkpoint ${n} has files with both exclusive and concurrent-segment changes: ` +
        `${wo.mixed_segment
          .map((f) => f.file_after ?? f.file_before ?? '(unknown)')
          .join(', ')}. Kept on segment evidence, downgraded for attribution.`,
    });
  }
  if (wo.segment_attributed.length > 0) {
    warnings.push({
      code: 'window-overlap-unreported-attributed',
      message:
        `Checkpoint ${n} did not report ${wo.segment_attributed.join(', ')} in ` +
        `files_changed, but exclusive-segment evidence attributes them to it — kept. ` +
        `Report files_changed accurately: it is the attribution claim under overlap.`,
    });
  }
  return warnings;
}

export function extractOpenReplayShape(priorPayload: unknown): unknown {
  if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
  const p = priorPayload as Record<string, unknown>;
  return {
    artifact_id: p.artifact_id,
    declared_step_ids: p.declared_step_ids,
    agent_session_id: p.agent_session_id,
    policy_exceptions: p.policy_exceptions,
    plan_revision_id: p.plan_revision_id ?? null,
  };
}

export function extractCloseReplayShape(priorPayload: unknown): unknown {
  if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
  const p = priorPayload as Record<string, unknown>;
  return {
    artifact_id: p.artifact_id,
    n: p.n,
    summary: p.summary,
    files_changed: p.files_changed,
    decisions: p.decisions,
    uncertainty: p.uncertainty,
    done_criteria: p.done_criteria,
    // Symmetric conditional include — optional-absent.
    ...(p.verification !== undefined ? { verification: p.verification } : {}),
    completed_step_ids: p.completed_step_ids,
  };
}

export function extractAbandonReplayShape(priorPayload: unknown): unknown {
  if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
  const p = priorPayload as Record<string, unknown>;
  return {
    artifact_id: p.artifact_id,
    n: p.n,
    reason: p.reason,
  };
}

export function toSnapshotFailure(
  snap: Extract<SnapshotResult, { ok: false }>
): SnapshotCaptureFailure {
  return {
    phase: snap.phase,
    reason: snap.error_reason,
    ...(snap.error_message !== undefined ? { message: snap.error_message } : {}),
  };
}

export function toBoundary(snap: SnapshotResult): {
  boundary: CheckpointSnapshotBoundary;
  failure?: SnapshotCaptureFailure;
} {
  if (snap.ok) {
    return {
      boundary: {
        snapshot_ref: snap.ref,
        tree_sha: snap.tree_sha,
        snapshot_commit_sha: snap.commit_sha,
        snapshot_error_reason: null,
      },
    };
  }
  return {
    boundary: {
      ...buildDefaultSkippedSnapshotBoundary(),
      snapshot_error_reason: snap.error_reason,
    },
    failure: toSnapshotFailure(snap),
  };
}

export function makeSkippedCloseResult(
  errorReason: DiffFingerprintFailureReason | null,
  snap?: SnapshotResult
): {
  boundary: CheckpointSnapshotBoundary;
  summary: DiffFingerprintSummary;
  manifest: DiffFingerprintManifest | null;
  unmerged_paths?: string[];
  unmerged_probe_failed?: boolean;
} {
  const boundary = snap ? toBoundary(snap).boundary : buildDefaultSkippedSnapshotBoundary();
  return {
    boundary,
    summary: { ...buildDefaultSkippedFingerprintSummary(), error_reason: errorReason },
    manifest: null,
    // A successful close snap still reports its unmerged set (and a failed
    // probe) even when the fingerprint is skipped — the degraded disclosure
    // must not depend on the manifest existing.
    ...(snap?.ok === true && snap.unmerged_paths.length > 0
      ? { unmerged_paths: [...snap.unmerged_paths] }
      : {}),
    ...(snap?.ok === true && snap.unmerged_probe_failed === true
      ? { unmerged_probe_failed: true }
      : {}),
  };
}

export function toGateAuditRun(r: EvaluatorRunPayload): GateAuditRun {
  return {
    run_id: r.run_id,
    evaluator_ref: r.evaluator_ref,
    phase: r.phase,
    severity: r.severity,
    run_status: r.run_status,
    verdict: r.verdict,
    body: r.body,
    ...(r.raw !== undefined ? { raw: r.raw } : {}),
    ...(r.metrics !== undefined ? { metrics: r.metrics } : {}),
    ...(r.provider !== undefined ? { provider: r.provider } : {}),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.tokens !== undefined ? { tokens: r.tokens } : {}),
    ...(r.cost_usd !== undefined ? { cost_usd: r.cost_usd } : {}),
    ...(r.duration_ms !== undefined ? { duration_ms: r.duration_ms } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    ts: r.ts,
  };
}
