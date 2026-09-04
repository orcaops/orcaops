// Scope resolution — open the store/repo/config, gather every artifact on the
// branch (lineage-aware), map storage's rich Checkpoint/Plan/Summary/Evaluator
// shapes into the normalized assembly model, resolve the base + target trees,
// and produce the live review diff. This is the only place @orcaops/storage +
// git are touched; everything downstream is pure over the model.

import {
  buildDiffFingerprintManifest,
  captureReviewWorktreeTreeSha,
  computeDiffFingerprintManifestHash,
  type DiffFingerprintManifest,
  diffSnapshotTrees,
  loadReadOnlyProjectConfig,
  readOnlyWorktreeState,
  Repo,
} from '@orcaops/core';
import { type Disclosure, DISCLOSURE_CODE, slugifyBranch } from '@orcaops/review-core';
import {
  type ArtifactRow,
  ArtifactStore,
  cacheDbPath,
  type Checkpoint,
  openEmptyArtifactStore,
  replayAttributionDegradedRemovals,
  replayWindowOverlapRemovals,
  resolveCaptureExcludes,
  Store,
  type WindowOverlapFile,
} from '@orcaops/storage';

import {
  type BaseSource,
  chooseBase,
  type LatestClosed,
  resolveTargetAndAncestry,
  validateOverrideBase,
} from './base.js';
import { ExcludePolicyError } from './dossier.js';
import { revParseTree, runGit } from './git.js';
import type {
  AssemblyInput,
  CapturedFingerprintInputs,
  ReviewArtifact,
  ReviewCheckpoint,
} from './model.js';
import { collectReviewDiffBudget } from './reviewDiffBudget.js';
import { readStickyBase } from './stickyBase.js';
import { requireCompleteArtifactStore } from './storePreparation.js';

function formatUntrackedEvidence(
  paths: readonly string[],
  details: readonly { path: string; bytes: number | null; rows: number | null }[]
): string {
  const byPath = new Map(details.map((detail) => [detail.path, detail]));
  const count = (value: number | null, unit: string): string =>
    value === null
      ? `${unit} unknown`
      : `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${unit}`;
  return paths
    .map((filePath) => {
      const detail = byPath.get(filePath);
      return detail === undefined
        ? `${filePath} (bytes unknown; rows unknown)`
        : `${filePath} (${count(detail.bytes, 'bytes')}; ${count(detail.rows, 'rows')})`;
    })
    .join(', ');
}

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

async function resolveDefaultBranch(root: string): Promise<string | null> {
  const sym = await runGit(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (sym.code === 0) {
    const b = sym.stdout
      .toString('utf8')
      .trim()
      .replace(/^refs\/remotes\/origin\//, '');
    if (b) return `origin/${b}`;
  }
  for (const cand of ['main', 'master']) {
    const v = await runGit(root, ['rev-parse', '--verify', '--quiet', cand]);
    if (v.code === 0) return cand;
  }
  return null;
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

async function buildReviewArtifact(
  store: ArtifactStore,
  row: ArtifactRow
): Promise<ReviewArtifact> {
  const [plan, checkpoints, summary, evalLog, artifactJson, manifests] = await Promise.all([
    store.readPlan(row.id),
    store.readCheckpointsRecovered(row.id),
    store.readSummary(row.id),
    store.readEvaluatorLog(row.id),
    store.readArtifact(row.id),
    // ONE event-log pass for every checkpoint's manifest. The singular reader
    // reloads the whole log per call, so calling it per checkpoint would make the
    // cheap cache preamble O(checkpoints x event log) — on the path the watch TUI
    // hits every time the review surface opens.
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

/** The branch's chronologically-last closed checkpoint — its close tree is the captured target. */
function latestClosed(artifacts: readonly ReviewArtifact[]): LatestClosed | null {
  let best: { at: string; tree: string; headSha: string | null } | null = null;
  for (const a of artifacts) {
    for (const cp of a.checkpoints) {
      if (cp.status === 'closed' && cp.closeTreeSha !== null && cp.closedAt !== null) {
        if (best === null || cp.closedAt > best.at) {
          best = { at: cp.closedAt, tree: cp.closeTreeSha, headSha: cp.headSha };
        }
      }
    }
  }
  return best ? { tree: best.tree, headSha: best.headSha } : null;
}

function oldestArtifactBaseSha(rows: readonly ArtifactRow[]): string | null {
  const withBase = rows
    .filter((r) => typeof r.base_sha === 'string' && r.base_sha.length > 0)
    .sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
  return withBase[0]?.base_sha ?? null;
}

/**
 * The thrown floor-capture failure must carry the capture pipeline's
 * underlying cause: the reason enum alone ("unknown") discards the git
 * stderr that explains the failure — e.g. a host sandbox denying .git
 * object writes.
 */
export function worktreeCaptureFailureMessage(result: {
  error_reason: string;
  error_message?: string;
}): string {
  const cause =
    result.error_message !== undefined && result.error_message !== ''
      ? ` — ${result.error_message}`
      : '';
  return `worktree tree capture failed: ${result.error_reason}${cause}`;
}

/**
 * The CHEAP scope preamble: everything the cache fingerprint keys on, WITHOUT
 * the two expensive git passes (`deriveManifestHashes` + the review diff). The
 * whole-floor cache computes its candidate fingerprint from this alone, so a hit
 * skips the costly assembly entirely. `input.artifacts` carry
 * `derivedManifestHash: null` (the derive is not run here); the fingerprint
 * deep-strips that field so this preamble and a full build fingerprint alike.
 */
export async function resolveScopeInputs(opts: {
  root: string;
  branch: string;
  base?: string;
  ignoreStickyBase?: boolean;
  rebuildCache?: boolean;
}): Promise<ScopeInputs> {
  // Governed-but-empty worktrees are valid review roots: a sibling that has
  // never captured must be served from an in-memory projection rather than
  // by creating its cache on a read path.
  const worktree = await readOnlyWorktreeState(opts.root);
  if (worktree.kind === 'broken') throw worktree.error;
  const config =
    worktree.kind === 'enabled' ? worktree.config : await loadReadOnlyProjectConfig(opts.root);
  const emptyHotState = worktree.kind === 'enabled' && worktree.hot.empty;
  const repo = new Repo(opts.root);

  // Validate an explicit --base up front so a typo fails loudly rather than
  // silently falling through to a different base and a plausible-but-wrong review.
  let overrideTree = opts.base ? await revParseTree(opts.root, opts.base) : null;
  validateOverrideBase(opts.base, overrideTree);

  // Sticky base: a bare rebuild reuses the branch's recorded
  // explicit --base instead of silently re-deriving and drifting the session.
  // The PINNED SHA is the authority — a symbolic ref that advanced since the
  // record must not silently move the base while the floor claims reuse. A
  // stale record never hard-fails a bare run — it is disclosed and ignored.
  let stickyDisclosure: Disclosure | null = null;
  let stickyRefUsed: string | null = null;
  if (!opts.base && opts.ignoreStickyBase !== true) {
    const sticky = await readStickyBase(opts.root, slugifyBranch(opts.branch));
    if (sticky !== null) {
      const pinnedTree = await revParseTree(opts.root, sticky.pinnedSha);
      if (pinnedTree !== null) {
        overrideTree = pinnedTree;
        stickyRefUsed = sticky.pinnedSha;
        const currentRefTree = await revParseTree(opts.root, sticky.baseRef);
        const refDrifted = currentRefTree !== null && currentRefTree !== pinnedTree;
        stickyDisclosure = {
          code: DISCLOSURE_CODE.STICKY_BASE_REUSED,
          message: refDrifted
            ? `reusing the pinned base ${sticky.pinnedSha} recorded for '${sticky.baseRef}' on this branch; NOTE '${sticky.baseRef}' has since moved — still using the pinned base; pass --base <ref> to re-pin or --base auto to re-derive`
            : `reusing the pinned base ${sticky.pinnedSha} recorded for '${sticky.baseRef}' on this branch; pass --base <ref> to change it or --base auto to re-derive`,
        };
      } else {
        stickyDisclosure = {
          code: DISCLOSURE_CODE.STICKY_BASE_REUSED,
          message: `the recorded pinned base ${sticky.pinnedSha} (from '${sticky.baseRef}') no longer resolves; the base was re-derived automatically — pass --base <ref> to re-pin or --base auto to clear the record`,
        };
      }
    }
  }

  const rebuildStore =
    opts.rebuildCache === true && !emptyHotState
      ? new Store(cacheDbPath(opts.root, config), {
          containmentRoot: opts.root,
          rebuildExistingProjection: true,
        })
      : null;
  const store = emptyHotState
    ? openEmptyArtifactStore(opts.root, config)
    : new ArtifactStore({
        repoRoot: opts.root,
        config,
        ...(rebuildStore === null ? {} : { store: rebuildStore }),
      });

  try {
    if (!emptyHotState) await requireCompleteArtifactStore(store, 'review scope');
    // TWO caps, two jobs. `diff_fingerprint.max_diff_bytes` is hashed into the
    // durable checkpoint manifest, so it governs the re-derive and nothing else;
    // `review.max_diff_bytes` governs the live review diff and is free to move.
    const fingerprintMaxDiffBytes = config.diff_fingerprint.max_diff_bytes;
    const reviewMaxDiffBytes = config.review.max_diff_bytes;
    const rows = store.store.listArtifactsByLineageBranch({ branch: opts.branch });

    const artifacts: ReviewArtifact[] = [];
    for (const row of rows) {
      // FAIL CLOSED, deliberately: this list feeds target resolution
      // (latestClosed picks the off-branch review target), the floor's
      // persisted scope, and the claim ledger. Skipping an unreadable
      // artifact here would silently retarget the review at an older
      // tree and erase the artifact from durable deliverables — worse
      // than refusing. Containment-by-skip belongs only to additive
      // enumeration surfaces where omission weakens claims.
      let built: ReviewArtifact;
      try {
        built = await buildReviewArtifact(store, row);
      } catch (err) {
        throw new Error(
          `review scope cannot read artifact ${row.id} — ` +
            `${err instanceof Error ? err.message : String(err)} ` +
            `The review would misstate coverage or target the wrong tree without it; ` +
            `run \`orcaops doctor\` to see the corruption.`,
          { cause: err }
        );
      }
      artifacts.push(built);
    }
    // deriveManifestHashes is intentionally NOT run here — it is the expensive
    // per-checkpoint re-diff, and its only output (derivedManifestHash) is
    // deep-stripped from the cache fingerprint. resolveScope runs it below.

    // Target-first: pick the target, then the ancestry ref that belongs to it.
    const currentBranch = await repo.getCurrentBranch();
    const onBranch = currentBranch === opts.branch;
    // The exclude set has to reach the capture, not just the presentation: the
    // tree resolved here is pinned to refs/orcaops/review/<slug>, so a
    // credential-shaped file that reaches it is durable and reachable from no
    // branch, however thoroughly the dossier stubs its hunks afterwards.
    const excludes = resolveCaptureExcludes(config.capture);
    // Same fail-closed posture the dossier takes: a malformed entry is a hole
    // in a security control, and this refusal lands before a floor is pinned.
    if (excludes.invalid.length > 0) throw new ExcludePolicyError(excludes.invalid);
    const worktree = await captureReviewWorktreeTreeSha(repo, config.review.include_untracked, {
      excludePatterns: excludes.patterns,
    });
    if (!worktree.ok) throw new Error(worktreeCaptureFailureMessage(worktree));
    // Capture itself tolerates an unmerged index; review does not — a floor
    // tree carrying conflict-marker bytes would poison the review diff.
    if (worktree.unmerged_paths.length > 0) {
      throw new Error(
        `review scope cannot capture the worktree: unresolved merge conflicts in the index ` +
          `(${worktree.unmerged_paths.join(', ')}). Resolve them (or \`git merge --abort\`) ` +
          `and re-run.`
      );
    }
    const worktreeHead = await repo.getHeadSha();
    const ta = resolveTargetAndAncestry({
      onBranch,
      worktreeTree: worktree.tree_sha,
      worktreeHead,
      latestClosed: latestClosed(artifacts),
    });
    const pinnedTreeSha = ta.targetTree;
    const reviewIncludedUntracked = onBranch ? worktree.included_untracked : [];

    // Base candidates, peeled to trees. merge-base against the ancestry ref that
    // matches the target — never the parentless snapshot commit.
    const defaultBranch = await resolveDefaultBranch(opts.root);
    const mergeBaseSha =
      ta.ancestryRef && defaultBranch
        ? await repo.getMergeBase(defaultBranch, ta.ancestryRef)
        : null;
    const mergeBaseTree = mergeBaseSha ? await revParseTree(opts.root, mergeBaseSha) : null;
    // Degenerate = the branch tip is already an ancestor of the default branch
    // (merged), so merge-base is at/after the target — a merged tip's tree still
    // differs from the captured target by post-checkpoint drift, so test ancestry.
    const mergeBaseDegenerate =
      ta.ancestryRef !== null &&
      defaultBranch !== null &&
      (await repo.isAncestor(ta.ancestryRef, defaultBranch));
    const oldestBaseSha = oldestArtifactBaseSha(rows);
    const oldestArtifactBaseTree = oldestBaseSha
      ? await revParseTree(opts.root, oldestBaseSha)
      : null;
    const fallbackRef = ta.ancestryRef ?? worktreeHead;
    const fallbackTree = (await revParseTree(opts.root, fallbackRef)) ?? pinnedTreeSha;

    const chosen = chooseBase({
      overrideTree,
      mergeBaseTree,
      mergeBaseDegenerate,
      targetTree: pinnedTreeSha,
      oldestArtifactBaseTree,
      fallbackTree,
    });
    const baseTreeSha = chosen.baseTree;
    const baseShaBySource: Record<BaseSource, string | null> = {
      override: opts.base ?? stickyRefUsed,
      merge_base: mergeBaseSha,
      oldest_artifact: oldestBaseSha,
      fallback: fallbackRef,
    };
    const baseSha = baseShaBySource[chosen.source] ?? baseTreeSha;

    // Pre-diff topology disclosures only (degenerate/merged-branch scope). These
    // ARE in the fingerprint — they carry topology facts (chosen base source,
    // degraded target) that identical trees don't fully determine.
    const disclosures: Disclosure[] = [...chosen.disclosures];
    if (stickyDisclosure !== null) disclosures.push(stickyDisclosure);
    if (ta.degraded) {
      disclosures.push({
        code: DISCLOSURE_CODE.DEGENERATE_SCOPE,
        message:
          'reviewing a different branch with no captured checkpoint — diffing against the current checkout; pass --base to scope precisely',
      });
    }
    if (onBranch && worktree.included_untracked.length > 0) {
      disclosures.push({
        code: DISCLOSURE_CODE.UNTRACKED_EVIDENCE_INCLUDED,
        message:
          `explicit review.include_untracked evidence included (${worktree.included_untracked.length}): ` +
          formatUntrackedEvidence(worktree.included_untracked, worktree.untracked_details),
      });
    }
    if (onBranch && worktree.excluded_untracked.length > 0) {
      disclosures.push({
        code: DISCLOSURE_CODE.UNTRACKED_EVIDENCE_EXCLUDED,
        message:
          `non-ignored untracked files excluded by the tracked-only review policy ` +
          `(${worktree.excluded_untracked.length}): ` +
          formatUntrackedEvidence(worktree.excluded_untracked, worktree.untracked_details),
      });
    }
    if (onBranch && worktree.sensitive_opt_ins.length > 0) {
      disclosures.push({
        code: DISCLOSURE_CODE.UNTRACKED_EVIDENCE_WITHHELD,
        message:
          `opted-in untracked files withheld from the review tree by capture.exclude ` +
          `(${worktree.sensitive_opt_ins.length}): ${worktree.sensitive_opt_ins.join(', ')}`,
      });
    }
    // Matched by capture.exclude and in the tree anyway. Disclosed as included
    // rather than dropped: the reviewer is looking at the file's bytes, and the
    // one thing they must not be told is that it was held back.
    if (onBranch && worktree.retained_sensitive_opt_ins.length > 0) {
      disclosures.push({
        code: DISCLOSURE_CODE.UNTRACKED_EVIDENCE_INCLUDED,
        message:
          `capture.exclude matched opted-in files that are in the review tree anyway — ` +
          `git tracks them in the index, and exclusion covers untracked files only ` +
          `(${worktree.retained_sensitive_opt_ins.length}): ` +
          formatUntrackedEvidence(worktree.retained_sensitive_opt_ins, worktree.untracked_details),
      });
    }
    if (
      onBranch &&
      (worktree.ignored_opt_ins.length > 0 || worktree.unmatched_opt_ins.length > 0)
    ) {
      const details = [
        ...(worktree.ignored_opt_ins.length > 0
          ? [`ignored/generated: ${worktree.ignored_opt_ins.join(', ')}`]
          : []),
        ...(worktree.unmatched_opt_ins.length > 0
          ? [`not untracked or absent: ${worktree.unmatched_opt_ins.join(', ')}`]
          : []),
      ];
      disclosures.push({
        code: DISCLOSURE_CODE.UNTRACKED_EVIDENCE_REJECTED,
        message: `review.include_untracked opt-ins not included — ${details.join('; ')}`,
      });
    }

    const input: AssemblyInput = {
      branch: opts.branch,
      branchSlug: slugifyBranch(opts.branch),
      baseSha,
      baseTreeSha,
      pinnedTreeSha,
      defaultBranch,
      // Already resolved above for the merge-base ancestry — reuse it as the
      // floor's passive staleness anchor rather than spawning a second HEAD read.
      worktreeHead,
      artifacts,
    };
    return {
      input,
      fingerprintMaxDiffBytes,
      reviewMaxDiffBytes,
      reviewIncludedUntracked,
      disclosures,
    };
  } finally {
    store.close();
    rebuildStore?.close();
  }
}

export async function resolveScope(opts: {
  root: string;
  branch: string;
  base?: string;
  /**
   * Preamble snapshot captured by the caller for this build attempt. A cache
   * miss already owns this complete snapshot; reloading it here duplicates the
   * store/config/worktree/base pass and keeps two artifact graphs live at once.
   * The caller must still fingerprint the current inputs before installation.
   */
  scopeInputs?: ScopeInputs;
}): Promise<ScopeResult> {
  const {
    input,
    fingerprintMaxDiffBytes,
    reviewMaxDiffBytes,
    reviewIncludedUntracked,
    disclosures,
  } = opts.scopeInputs ?? (await resolveScopeInputs(opts));

  // The two expensive passes the preamble skipped. Kept here (not in
  // resolveScopeInputs) so the cache hit-check can fingerprint from the cheap
  // preamble alone. A fresh Repo — the preamble closed its store; git plumbing
  // holds no per-instance state.
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
