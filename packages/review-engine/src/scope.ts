// Scope assembly maps retained artifact threads into the normalized model and
// derives the exact Git evidence selected by the database command.

import {
  buildDiffFingerprintManifest,
  computeDiffFingerprintManifestHash,
  type DiffFingerprintManifest,
  diffSnapshotTrees,
  Repo,
} from '@orcaops/core';
import type { Disclosure } from '@orcaops/review-core';
import {
  type ArtifactThread,
  type Checkpoint,
  replayAttributionDegradedRemovals,
  replayWindowOverlapRemovals,
  type WindowOverlapFile,
} from '@orcaops/storage';

import type {
  AssemblyInput,
  CapturedFingerprintInputs,
  ReviewArtifact,
  ReviewCheckpoint,
} from './model.js';
import { collectReviewDiffBudget } from './reviewDiffBudget.js';

/**
 * Scope-side inputs to the floor's cache fingerprint — everything the whole-floor
 * cache keys on that is CHEAPLY resolvable (no review diff, no manifest re-derive).
 * `input.artifacts` carry `derivedManifestHash: null` here (the derive is skipped);
 * the fingerprint deep-strips that field, so a preamble value and a full-build value
 * fingerprint identically. Disclosures are the pre-diff topology ones only.
 */
export interface ScopeInputs {
  input: AssemblyInput;
  /**
   * `diff_fingerprint.max_diff_bytes` — caps the per-checkpoint manifest
   * RE-DERIVE only. Hashed into the durable manifest at capture, so it must
   * never be swapped for the review cap: doing so would re-derive a different
   * `manifest_hash` from identical trees and read as tampering.
   */
  fingerprintMaxDiffBytes: number;
  /**
   * `review.max_diff_bytes` — caps the live `base → pinned` review diff, and
   * therefore truncation, floor coverage, the persisted `diff.patch`, and the
   * truncation disclosure. Independently tunable; touches no durable hash.
   */
  reviewMaxDiffBytes: number;
  /** Exact untracked files explicitly admitted to the review tree. */
  reviewIncludedUntracked: string[];
  disclosures: Disclosure[];
}

/**
 * Recoverable-degradation signals from a build. When ANY is set the build is NOT
 * cacheable — a transient git/object glitch (a failed diff, a failed manifest
 * re-derive, a failed blame) would otherwise get a valid marker and be reused
 * indefinitely after the glitch clears. A deterministic skip (a truncated diff,
 * a checkpoint with no stored manifest) is NOT degradation and stays cacheable.
 */
export interface ScopeCacheHealth {
  reviewDiffOk: boolean;
  truncationStatsFailed: boolean;
  manifestDeriveFailed: boolean;
}

export interface ScopeResult {
  input: AssemblyInput;
  reviewDiff: Uint8Array;
  reviewDiffTruncated: boolean;
  /** See ScopeInputs — the checkpoint-manifest re-derive cap. */
  fingerprintMaxDiffBytes: number;
  /** See ScopeInputs — the cap the review diff above was collected under. */
  reviewMaxDiffBytes: number;
  /** Exact untracked files explicitly admitted to the review tree. */
  reviewIncludedUntracked: string[];
  /**
   * Truncated path only: the largest changed paths from a `--numstat` second
   * pass, formatted for the truncation disclosure (null when stats failed or
   * the diff was not truncated). The true diff size is unknowable at the cap;
   * naming the offenders is what makes a poisoned tree diagnosable.
   */
  truncationDetail: string | null;
  /**
   * Truncated path only: bytes dropped from the capped diff to land on a complete
   * hunk boundary (0 when not truncated). Disclosed, so "the patch is shorter than
   * the cap" is never a silent surprise.
   */
  truncationDiscardedBytes: number;
  /** Scope-resolution disclosures (degenerate/merged-branch scope). */
  disclosures: Disclosure[];
  /** Scope-side degradation signals feeding the whole-floor cache's health gate. */
  cacheHealth: ScopeCacheHealth;
}

/** Flatten window-overlap file records to their non-null paths (both rename sides). */
function overlapPaths(files: readonly WindowOverlapFile[] | undefined): string[] {
  const out = new Set<string>();
  for (const f of files ?? []) {
    if (f.file_before !== null) out.add(f.file_before);
    if (f.file_after !== null) out.add(f.file_after);
  }
  return [...out].sort();
}

/**
 * Project a stored manifest down to the handful of fields the integrity re-derive
 * needs. The manifest itself must NOT escape this function — see
 * `CapturedFingerprintInputs` for why (it would land in the cache fingerprint).
 *
 * The `corrupt` case: any corrupt line (sidecar included) refuses
 * `readCheckpointsRecovered` upstream under the artifact-level contract, so
 * "a manifest_hash is declared, but no manifest came back" here can only
 * mean a genuinely absent manifest over an intact log — kept as a loud
 * `corrupt` load state as defense in depth rather than silently
 * downgrading to never-fingerprinted.
 */
function projectCapturedFingerprint(
  storedManifestHash: string | null,
  manifest: DiffFingerprintManifest | undefined
): CapturedFingerprintInputs {
  if (manifest === undefined) {
    return {
      loadState: storedManifestHash === null ? 'not-captured' : 'corrupt',
      openTreeSha: null,
      closeTreeSha: null,
      maxDiffBytes: null,
      diffOptions: null,
    };
  }
  return {
    loadState: 'loaded',
    openTreeSha: manifest.open_tree_sha,
    closeTreeSha: manifest.close_tree_sha,
    maxDiffBytes: manifest.limits.max_diff_bytes,
    diffOptions: {
      find_renames: manifest.diff_options.find_renames,
      no_ext_diff: manifest.diff_options.no_ext_diff,
      unified: manifest.diff_options.unified,
    },
  };
}

function normalizeCheckpoint(
  cp: Checkpoint,
  manifest: DiffFingerprintManifest | undefined
): ReviewCheckpoint {
  const openTreeSha = cp.open_snapshot.tree_sha;
  if (cp.status === 'closed') {
    return {
      artifact: cp.artifact_id,
      n: cp.n,
      closedAt: cp.closed_at,
      status: 'closed',
      openTreeSha,
      closeTreeSha: cp.close_snapshot.tree_sha,
      headSha: cp.head_sha,
      summary: cp.summary,
      filesChanged: cp.files_changed,
      completedStepIds: cp.completed_step_ids,
      declaredStepIds: cp.declared_step_ids,
      decisions: cp.decisions.map((d) => ({
        decision: d.decision,
        reason: d.reason,
        alternativesConsidered: (d.alternatives_considered ?? []).map((alt) => ({
          option: alt.option,
          rejectedBecause: alt.rejected_because,
        })),
      })),
      uncertainty: cp.uncertainty,
      doneCriteria: cp.done_criteria.map((dc) => ({
        criterionId: dc.criterion_id,
        evidence: dc.evidence,
      })),
      // OPTIONAL-ABSENT in storage (hash stability), so `?? []` here rather
      // than a defaulted field — same read the claim ledger already does.
      verification: (cp.verification ?? []).map((v) => ({
        command: v.command,
        exitCode: v.exit_code,
        outputDigest: v.output_digest ?? null,
        note: v.note ?? null,
      })),
      manifestHash: cp.diff_fingerprint_summary.manifest_hash,
      manifestTruncated: cp.diff_fingerprint_summary.truncated,
      capturedFingerprint: projectCapturedFingerprint(
        cp.diff_fingerprint_summary.manifest_hash,
        manifest
      ),
      derivedManifestHash: null,
      overlapAmbiguousFiles: overlapPaths([
        ...(cp.window_overlap?.ambiguous_files ?? []),
        ...(cp.window_overlap?.mixed_segment ?? []),
      ]),
      windowOverlap: cp.window_overlap,
      attributionDegraded: cp.attribution_degraded,
    };
  }
  return {
    artifact: cp.artifact_id,
    n: cp.n,
    closedAt: null,
    status: cp.status,
    openTreeSha,
    closeTreeSha: null,
    headSha: cp.head_sha,
    summary: null,
    filesChanged: [],
    completedStepIds: [],
    declaredStepIds: cp.declared_step_ids,
    decisions: [],
    uncertainty: [],
    doneCriteria: [],
    verification: [],
    manifestHash: null,
    manifestTruncated: false,
    // An open/abandoned cp has no capture to verify.
    capturedFingerprint: {
      loadState: 'not-captured',
      openTreeSha: null,
      closeTreeSha: null,
      maxDiffBytes: null,
      diffOptions: null,
    },
    derivedManifestHash: null,
    overlapAmbiguousFiles: [],
    windowOverlap: undefined,
    attributionDegraded: undefined,
  };
}

/** The git diff options `diffSnapshotTrees` actually runs under (`--no-ext-diff --unified=3 --find-renames`). */
const ENGINE_DIFF_OPTIONS = { find_renames: true, no_ext_diff: true, unified: 3 } as const;

/**
 * Why this checkpoint's integrity CANNOT be checked — or undefined when it can.
 *
 * The single source of truth for that question: `deriveManifestHashes` uses it to
 * decide whether to even attempt a re-derive, and the floor uses it to decide
 * whether to disclose. Keeping one function means the two can never drift into
 * "the engine skipped it silently but the floor claimed it was fine".
 *
 * Only DURABLE inabilities live here. A transient git failure during the re-derive
 * is not one of them: it leaves `derivedManifestHash` null, marks the build
 * non-cacheable, and gets retried — disclosing it would cry wolf about a hiccup.
 */
export function integrityUnavailableReason(
  captured: CapturedFingerprintInputs
): string | undefined {
  if (captured.loadState === 'not-captured') return undefined; // nothing to verify
  if (captured.loadState === 'corrupt') {
    return 'a manifest_hash is recorded but its fingerprint manifest could not be loaded (corrupt or dropped sidecar)';
  }
  if (captured.openTreeSha === null || captured.closeTreeSha === null) {
    return 'the stored manifest records no capture-time boundary trees to re-diff';
  }
  if (captured.maxDiffBytes === null) {
    return 'the stored manifest records no capture-time max_diff_bytes, so its hash cannot be reproduced';
  }
  const o = captured.diffOptions;
  if (
    o === null ||
    o.find_renames !== ENGINE_DIFF_OPTIONS.find_renames ||
    o.no_ext_diff !== ENGINE_DIFF_OPTIONS.no_ext_diff ||
    o.unified !== ENGINE_DIFF_OPTIONS.unified
  ) {
    return `the stored manifest was captured under git diff options this engine does not reproduce (${JSON.stringify(o)} vs ${JSON.stringify(ENGINE_DIFF_OPTIONS)})`;
  }
  return undefined;
}

/**
 * Integrity re-derive: fresh boundary re-diff + re-fingerprint per closed
 * checkpoint, mirroring the CLI's fingerprint-derive path. The derived hash lands
 * on the model for the engine's stored-vs-derived comparison.
 *
 * THE RULE: re-derive from what the MANIFEST RECORDED, never from what the config
 * says now. A manifest records its own `open_tree_sha`, `close_tree_sha`,
 * `limits.max_diff_bytes` and `diff_options`, and its `manifest_hash` is taken over
 * all of them. Deriving from the live config instead was a latent trap with two
 * teeth:
 *
 *  1. The cap is IN the hash. Bump `diff_fingerprint.max_diff_bytes` and every
 *     already-closed checkpoint re-derives a different hash from identical trees —
 *     a repo-wide INTEGRITY_MISMATCH storm accusing the user of tampering. It only
 *     stayed invisible because capture and re-derive happened to read one key.
 *  2. The trees can legitimately differ. A RECOVERED manifest can carry a different
 *     baseline open tree than the checkpoint projection does, which is exactly why
 *     the CLI's `fingerprint derive` refuses to fall back to the cp's own
 *     boundaries.
 *
 * Reading the recorded inputs also makes a TRUNCATED capture reproducible for the
 * first time — same trees + same cap ⇒ same byte prefix ⇒ same hash — so the two
 * old "skip the comparison at a truncation boundary" guards are gone, and truncated
 * checkpoints now get real integrity coverage instead of a silent pass.
 *
 * `failed` means a TRANSIENT degradation (a git op that didn't produce a diff, a
 * thrown error) — the cache must not bless the build. A DURABLE inability to check
 * (corrupt sidecar, unreproducible options) is not a failure here: it is reported
 * as `unavailableReason` so the floor discloses it and returns `verified: null`.
 */
async function deriveManifestHashes(
  repo: Repo,
  artifacts: readonly ReviewArtifact[]
): Promise<boolean> {
  let failed = false;
  for (const artifact of artifacts) {
    for (const cp of artifact.checkpoints) {
      if (cp.status !== 'closed') continue;
      if (cp.manifestHash === null) continue; // nothing stored to compare against

      const captured = cp.capturedFingerprint;
      // Durably uncheckable (corrupt sidecar, unreproducible options). Leave
      // derivedManifestHash null; the floor discloses INTEGRITY_UNAVAILABLE off the
      // SAME predicate. Never a fabricated comparison, never a false mismatch.
      if (integrityUnavailableReason(captured) !== undefined) continue;
      // Narrow for TS — the predicate above already guarantees these are non-null.
      if (
        captured.openTreeSha === null ||
        captured.closeTreeSha === null ||
        captured.maxDiffBytes === null
      ) {
        continue;
      }

      try {
        // The manifest's OWN trees and OWN cap — not the checkpoint projection's,
        // not the current config's.
        const diff = await diffSnapshotTrees({
          repo,
          openTreeSha: captured.openTreeSha,
          closeTreeSha: captured.closeTreeSha,
          maxDiffBytes: captured.maxDiffBytes,
        });
        if (!diff.ok) {
          failed = true;
          continue;
        }
        const built = await buildDiffFingerprintManifest({
          artifactId: cp.artifact,
          checkpointN: cp.n,
          openTreeSha: captured.openTreeSha,
          closeTreeSha: captured.closeTreeSha,
          diffBytes: diff.diff,
          truncated: diff.truncated,
          maxDiffBytes: captured.maxDiffBytes,
        });
        // An overlap-partitioned close persisted the FILTERED manifest —
        // replay exactly the recorded removals before hashing (deterministic
        // replay, never re-adjudication; the fingerprint-derive contract).
        let derivedHash = built.summary.manifest_hash;
        let derivedManifest = built.manifest;
        if (cp.windowOverlap !== undefined && derivedManifest !== null) {
          const replayed = replayWindowOverlapRemovals(derivedManifest, cp.windowOverlap);
          if (replayed !== derivedManifest) {
            derivedManifest = replayed;
            derivedHash = await computeDiffFingerprintManifestHash(replayed);
          }
        }
        // Second removal class: replay the unmerged-degraded exclusion the
        // close recorded, same doctrine as the overlap replay above.
        if (cp.attributionDegraded !== undefined && derivedManifest !== null) {
          const replayed = replayAttributionDegradedRemovals(
            derivedManifest,
            cp.attributionDegraded.unmerged_paths
          );
          if (replayed !== derivedManifest) {
            derivedManifest = replayed;
            derivedHash = await computeDiffFingerprintManifestHash(replayed);
          }
        }
        cp.derivedManifestHash = derivedHash;
      } catch {
        // Degrade silently: derive failure is a skipped comparison, never a
        // fabricated mismatch — but it marks the build non-cacheable so a
        // recovered re-run can fill the integrity comparison it missed.
        failed = true;
      }
    }
  }
  return failed;
}

export async function buildReviewArtifact(
  store: {
    readPlan(artifactId: string): Promise<ArtifactThread['plan']>;
    readCheckpointsRecovered(artifactId: string): Promise<ArtifactThread['checkpoints']>;
    readSummary(artifactId: string): Promise<ArtifactThread['summary']>;
    readEvaluatorLog(artifactId: string): Promise<ArtifactThread['evaluatorLog']>;
    readArtifact(artifactId: string): Promise<ArtifactThread['artifactJson']>;
    readCheckpointDiffFingerprints(
      artifactId: string
    ): Promise<Map<number, DiffFingerprintManifest>>;
  },
  row: {
    id: string;
    branch: string;
    label: string | null;
    task: string | null;
    base_sha: string | null;
    started_at: string | null;
  }
): Promise<ReviewArtifact> {
  const [plan, checkpoints, summary, evalLog, artifactJson, manifests] = await Promise.all([
    store.readPlan(row.id),
    store.readCheckpointsRecovered(row.id),
    store.readSummary(row.id),
    store.readEvaluatorLog(row.id),
    store.readArtifact(row.id),
    // One retained-thread pass supplies every checkpoint manifest.
    store.readCheckpointDiffFingerprints(row.id),
  ]);

  const normalized = checkpoints.map((c) => normalizeCheckpoint(c, manifests.get(c.n)));
  const closedTimes = normalized
    .map((c) => c.closedAt)
    .filter((t): t is string => t !== null)
    .sort();

  return {
    id: row.id,
    branch: row.branch,
    label: row.label ?? null,
    task: row.task ?? null,
    baseSha: row.base_sha ?? null,
    startedAt: row.started_at,
    firstActivityAt: closedTimes[0] ?? row.started_at,
    planSteps: (plan?.plan_steps ?? []).map((s) => ({
      stepId: s.step_id,
      text: s.text,
      label: s.label,
      acceptanceCriteria: s.acceptance_criteria.map((c) => ({
        criterionId: c.criterion_id,
        text: c.text,
      })),
    })),
    nonGoals: (plan?.non_goals ?? []).map((ng) => ({ text: ng.text, rationale: ng.rationale })),
    planDecisions: (plan?.decisions ?? []).map((d) => ({
      decision: d.decision,
      reason: d.reason,
      revisionN: d.revision_n,
      alternativesConsidered: (d.alternatives_considered ?? []).map((alt) => ({
        option: alt.option,
        rejectedBecause: alt.rejected_because,
      })),
    })),
    summaryText: summary?.outcome ?? null,
    evaluatorRuns: (evalLog?.runs ?? []).map((r) => ({
      id: r.evaluator_id,
      verdict: r.verdict,
      severity: r.severity,
      runStatus: r.run_status,
      disposition: r.disposition,
      body: r.body,
    })),
    planRevisions: artifactJson?.plan_revision_count ?? plan?.revision_n ?? 0,
    checkpoints: normalized,
  };
}

/**
 * The CHEAP scope preamble: everything the cache fingerprint keys on, WITHOUT
 * the two expensive git passes (`deriveManifestHashes` + the review diff). The
 * whole-floor cache computes its candidate fingerprint from this alone, so a hit
 * skips the costly assembly entirely. `input.artifacts` carry
 * `derivedManifestHash: null` (the derive is not run here); the fingerprint
 * deep-strips that field so this preamble and a full build fingerprint alike.
 */
export async function resolveScope(opts: {
  root: string;
  scopeInputs: ScopeInputs;
}): Promise<ScopeResult> {
  const {
    input,
    fingerprintMaxDiffBytes,
    reviewMaxDiffBytes,
    reviewIncludedUntracked,
    disclosures,
  } = opts.scopeInputs;

  // Re-derive checkpoint manifests from their retained Git inputs before assembly.
  const repo = new Repo(opts.root);
  // No cap argument: the re-derive reads each manifest's OWN recorded cap, which is
  // what makes `diff_fingerprint.max_diff_bytes` safe to change at all.
  const manifestDeriveFailed = await deriveManifestHashes(repo, input.artifacts);

  let reviewDiff: Uint8Array = new Uint8Array();
  let reviewDiffTruncated = false;
  let truncationDetail: string | null = null;
  let truncationDiscardedBytes = 0;
  let reviewDiffOk = true;
  let truncationStatsFailed = false;
  if (input.baseTreeSha !== input.pinnedTreeSha) {
    const d = await collectReviewDiffBudget({
      repo,
      openTreeSha: input.baseTreeSha,
      closeTreeSha: input.pinnedTreeSha,
      maxDiffBytes: reviewMaxDiffBytes,
      includedUntracked: reviewIncludedUntracked,
    });
    if (d.ok) {
      reviewDiff = d.diff;
      reviewDiffTruncated = d.truncated;
      truncationDetail = d.detail;
      truncationDiscardedBytes = d.omittedBytes;
      truncationStatsFailed = d.statsFailed;
    } else {
      // A failed diff (not an empty one) is a degradation — the review would be
      // built over an empty patch; don't bless it into the cache.
      reviewDiffOk = false;
    }
  }

  return {
    input,
    reviewDiff,
    reviewDiffTruncated,
    fingerprintMaxDiffBytes,
    reviewMaxDiffBytes,
    reviewIncludedUntracked,
    truncationDetail,
    truncationDiscardedBytes,
    disclosures,
    cacheHealth: { reviewDiffOk, truncationStatsFailed, manifestDeriveFailed },
  };
}
