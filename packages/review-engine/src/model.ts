// Normalized floor-assembly model. The storage-reading layer (scope.ts) maps
// @orcaops/storage's richer Checkpoint/Plan/Summary/EvaluatorLog + git output
// into these plain shapes; the pure builders (outline/citations/landmarks) and
// the engine consume them. Keeping this seam narrow keeps every builder
// unit-testable without a store.

import type { AttributionDegraded, WindowOverlap } from '@orcaops/storage';

/**
 * The capture-time inputs a stored fingerprint manifest RECORDS about itself —
 * everything the integrity re-derive needs to reproduce that manifest's hash,
 * and nothing else.
 *
 * This shape is deliberately TINY, and that is a hard constraint rather than a
 * style preference. `projectFingerprintInput` spreads every ReviewCheckpoint
 * field into the whole-floor cache fingerprint's canonical JSON, so parking the
 * full DiffFingerprintManifest here would drag its entire hunk + line-hash
 * payload (megabytes on a real branch) onto the CHEAP cache-preamble path — the
 * one whose entire purpose is that a cache hit-check pays none of the
 * diff/derive/blame cost. The manifest itself is never needed: re-derive takes
 * only the trees, the cap, and the options, and the hash to compare against is
 * already on the checkpoint as `manifestHash`.
 *
 * `loadState` participating in the fingerprint is likewise load-bearing: when a
 * manifest sidecar goes corrupt, nothing ELSE in the fingerprint moves (the
 * stored summary hash is unchanged), so without it a newly-corrupt manifest
 * would hit a previously-healthy cached floor and the corruption would never
 * surface.
 */
export interface CapturedFingerprintInputs {
  /**
   * - `loaded`      — the manifest is present and its recorded inputs are below.
   * - `not-captured`— no manifest was ever captured (fingerprinting was skipped).
   * - `corrupt`     — a manifest_hash IS recorded but the manifest will not load.
   *                   Not the same as `not-captured`, and not a mismatch either:
   *                   we cannot compare, so we must not claim drift.
   */
  loadState: 'loaded' | 'not-captured' | 'corrupt';
  /** The manifest's OWN baseline tree — recovery can make this differ from the cp's. */
  openTreeSha: string | null;
  closeTreeSha: string | null;
  /** `limits.max_diff_bytes` — the cap in force AT CAPTURE, hashed into manifest_hash. */
  maxDiffBytes: number | null;
  /** The git diff options the manifest was built under; re-derive must match them. */
  diffOptions: { find_renames: boolean; no_ext_diff: boolean; unified: number } | null;
}

/** A checkpoint, normalized for floor assembly. */
export interface ReviewCheckpoint {
  artifact: string;
  n: number;
  closedAt: string | null;
  status: 'closed' | 'open' | 'abandoned';
  openTreeSha: string | null;
  closeTreeSha: string | null;
  /** Close-time git HEAD commit — the ancestry proxy for merge-base (has real parents; the snapshot commit does not). */
  headSha: string | null;
  summary: string | null;
  filesChanged: string[];
  completedStepIds: string[];
  declaredStepIds: string[];
  decisions: Array<{
    decision: string;
    reason: string;
    /** Rejected alternatives — the RULED-OUT evidence the floor cites. */
    alternativesConsidered: Array<{ option: string; rejectedBecause: string }>;
  }>;
  uncertainty: string[];
  /**
   * Close-time evidence per plan-time acceptance criterion (`done_criteria`).
   * `criterionId` is the join key back to `ReviewPlanStep.acceptanceCriteria`;
   * it may name a criterion the current plan revision no longer carries, and
   * the evidence still rides (the citation simply has no `parent`).
   */
  doneCriteria: Array<{ criterionId: string; evidence: string }>;
  /**
   * Verified-close evidence (`verification[]`): commands run fresh at close
   * with their exit codes. A non-zero exit is valid evidence, not an error.
   * NOT the evaluator log — that is `ReviewArtifact.evaluatorRuns`.
   */
  verification: Array<{
    command: string;
    exitCode: number;
    outputDigest: string | null;
    note: string | null;
  }>;
  /** `diff_fingerprint_summary.manifest_hash` (null when capture skipped it). */
  manifestHash: string | null;
  manifestTruncated: boolean;
  /** What the stored manifest records about its own capture — see the interface. */
  capturedFingerprint: CapturedFingerprintInputs;
  /** Hash of the sidecar's fresh boundary re-diff (integrity cross-check). */
  derivedManifestHash: string | null;
  /**
   * Paths flagged by capture-time window-overlap evidence as line-grain
   * ambiguous (the persisted `window_overlap.ambiguous_files` +
   * `mixed_segment`, both rename sides). The floor downgrades these files to
   * hunk grain — reading the store's adjudication, never re-running git.
   */
  overlapAmbiguousFiles: string[];
  /**
   * The full persisted window-overlap partition record (transport-only; the
   * engine never reads it). The integrity re-derive must REPLAY its recorded
   * removals — close persisted the FILTERED manifest, so an unfiltered
   * re-derive of an overlap-partitioned cp would fabricate a mismatch.
   */
  windowOverlap: WindowOverlap | undefined;
  /**
   * The persisted unmerged-index degradation record (transport-only, like
   * `windowOverlap`). The integrity re-derive replays its recorded
   * exclusion — close persisted the manifest with the degraded union's
   * hunks removed.
   */
  attributionDegraded: AttributionDegraded | undefined;
}

export interface ReviewPlanStep {
  stepId: string;
  text: string;
  label: string;
  acceptanceCriteria: Array<{ criterionId: string; text: string }>;
}

/** An artifact (thread) on the branch, normalized. */
export interface ReviewArtifact {
  id: string;
  branch: string;
  label: string | null;
  task: string | null;
  baseSha: string | null;
  startedAt: string | null;
  /** Earliest checkpoint close (or startedAt) — the thread ordering key. */
  firstActivityAt: string | null;
  planSteps: ReviewPlanStep[];
  nonGoals: Array<{ text: string; rationale: string }>;
  /**
   * Plan-time architectural decisions (`plan.decisions`) — append-only across
   * revisions, so the latest plan holds the full set and `revisionN` attributes
   * each entry to the revision that made it. Mirrors `ReviewCheckpoint.decisions`
   * plus that tag.
   */
  planDecisions: Array<{
    decision: string;
    reason: string;
    /** The plan revision this decision was made at (0 = initial capture). */
    revisionN: number;
    /** Rejected alternatives — the RULED-OUT evidence the floor cites. */
    alternativesConsidered: Array<{ option: string; rejectedBecause: string }>;
  }>;
  summaryText: string | null;
  evaluatorRuns: Array<{
    id: string;
    verdict: 'pass' | 'violation' | 'info' | null;
    severity: 'info' | 'warn' | 'block';
    runStatus: 'completed' | 'error' | 'skipped';
    disposition: 'unresolved' | 'acknowledged' | 'dismissed' | 'policy-excepted' | null;
    body: string;
  }>;
  /** Highest plan revision index seen (>0 ⇒ the plan was revised — a landmark). */
  planRevisions: number;
  checkpoints: ReviewCheckpoint[];
}

/** Everything the floor assembler needs, git + store output already resolved. */
export interface AssemblyInput {
  branch: string;
  branchSlug: string;
  baseSha: string;
  baseTreeSha: string;
  pinnedTreeSha: string;
  defaultBranch: string | null;
  /**
   * The worktree HEAD commit at scope-resolution time (already computed for
   * the merge-base ancestry). Threaded onto `floor.scope.head_sha` as the
   * passive staleness anchor; null when HEAD is unresolvable (unborn/detached).
   */
  worktreeHead: string | null;
  artifacts: ReviewArtifact[];
}

/** Order artifacts by first activity (thread order); null sorts last, id tie-break. */
export function orderThreads(artifacts: readonly ReviewArtifact[]): ReviewArtifact[] {
  return [...artifacts].sort((a, b) => {
    if (a.firstActivityAt !== b.firstActivityAt) {
      if (a.firstActivityAt === null) return 1;
      if (b.firstActivityAt === null) return -1;
      return a.firstActivityAt < b.firstActivityAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Closed checkpoints of an artifact, chronological (the checkpoint order). */
export function orderedCheckpoints(artifact: ReviewArtifact): ReviewCheckpoint[] {
  return artifact.checkpoints
    .filter((c) => c.status === 'closed')
    .sort((a, b) => {
      if (a.closedAt !== b.closedAt) {
        if (a.closedAt === null) return 1;
        if (b.closedAt === null) return -1;
        return a.closedAt < b.closedAt ? -1 : 1;
      }
      return a.n - b.n;
    });
}
