// The base/target derivation shared by both floor paths. The pure decisions
// live in base.ts; this module performs the git queries around them —
// worktree capture, HEAD, default branch, merge-base and tree peels — and
// assembles the topology disclosures.
//
// One copy on purpose: a second base choice would let the file floor and the
// canonical floor disagree about what the review is diffing.

import {
  captureReviewWorktreeTreeSha,
  type loadReadOnlyProjectConfig,
  type Repo,
} from '@orcaops/core';
import { type Disclosure, DISCLOSURE_CODE } from '@orcaops/review-core';
import { resolveCaptureExcludes } from '@orcaops/storage';

import {
  type BaseSource,
  chooseBase,
  type LatestClosed,
  resolveTargetAndAncestry,
} from './base.js';
import { ExcludePolicyError } from './dossier.js';
import { revParseTree, runGit } from './git.js';
import type { ReviewArtifact } from './model.js';

type ProjectConfig = Awaited<ReturnType<typeof loadReadOnlyProjectConfig>>;

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

export async function resolveDefaultBranch(root: string): Promise<string | null> {
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

/** The branch's chronologically-last closed checkpoint — its close tree is the captured target. */
export function latestClosed(artifacts: readonly ReviewArtifact[]): LatestClosed | null {
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

export function oldestArtifactBaseSha(artifacts: readonly ReviewArtifact[]): string | null {
  const withBase = artifacts
    .filter((a) => typeof a.baseSha === 'string' && a.baseSha.length > 0)
    .sort((a, b) => {
      if (a.startedAt === b.startedAt) return 0;
      if (a.startedAt === null) return 1;
      if (b.startedAt === null) return -1;
      return a.startedAt < b.startedAt ? -1 : 1;
    });
  return withBase[0]?.baseSha ?? null;
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

export interface ReviewBasisInput {
  root: string;
  repo: Repo;
  branch: string;
  config: ProjectConfig;
  artifacts: readonly ReviewArtifact[];
  /** `--base` (or a reused sticky pin) already peeled to a tree, or null. */
  overrideTree: string | null;
  /** The ref/sha that produced `overrideTree`, retained as the chosen base's identity. */
  overrideRef: string | null;
  /** Pin the captured review tree under a durable ref rather than a loose object. */
  durableObjects: boolean;
  /**
   * Disclosed alongside the base choice — how an override was obtained. It is
   * ordered immediately after the base-choice disclosures because the whole
   * list is fingerprinted, so its position is part of the cache key.
   */
  overrideDisclosure?: Disclosure | null;
}

export interface ReviewBasis {
  baseSha: string;
  baseTreeSha: string;
  pinnedTreeSha: string;
  worktreeHead: string;
  defaultBranch: string | null;
  reviewIncludedUntracked: string[];
  baseSource: BaseSource;
  degraded: boolean;
  disclosures: Disclosure[];
}

/**
 * Resolve the review's target tree and base for a branch: capture the worktree,
 * choose the target and the ancestry ref that belongs to it, then choose the
 * base from the override, the merge-base, the oldest artifact base or the
 * branch-scoped fallback.
 */
export async function resolveReviewBasis(input: ReviewBasisInput): Promise<ReviewBasis> {
  // Target-first: pick the target, then the ancestry ref that belongs to it.
  const currentBranch = await input.repo.getCurrentBranch();
  const onBranch = currentBranch === input.branch;
  // The exclude set has to reach the capture, not just the presentation: the
  // tree resolved here is pinned to refs/orcaops/review/<slug>, so a
  // credential-shaped file that reaches it is durable and reachable from no
  // branch, however thoroughly the dossier stubs its hunks afterwards.
  const excludes = resolveCaptureExcludes(input.config.capture);
  // Same fail-closed posture the dossier takes: a malformed entry is a hole
  // in a security control, and this refusal lands before a floor is pinned.
  if (excludes.invalid.length > 0) throw new ExcludePolicyError(excludes.invalid);
  const worktree = await captureReviewWorktreeTreeSha(
    input.repo,
    input.config.review.include_untracked,
    { durableObjects: input.durableObjects, excludePatterns: excludes.patterns }
  );
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
  const worktreeHead = await input.repo.getHeadSha();
  const ta = resolveTargetAndAncestry({
    onBranch,
    worktreeTree: worktree.tree_sha,
    worktreeHead,
    latestClosed: latestClosed(input.artifacts),
  });
  const pinnedTreeSha = ta.targetTree;
  const reviewIncludedUntracked = onBranch ? worktree.included_untracked : [];

  // Base candidates, peeled to trees. merge-base against the ancestry ref that
  // matches the target — never the parentless snapshot commit.
  const defaultBranch = await resolveDefaultBranch(input.root);
  const mergeBaseSha =
    ta.ancestryRef && defaultBranch
      ? await input.repo.getMergeBase(defaultBranch, ta.ancestryRef)
      : null;
  const mergeBaseTree = mergeBaseSha ? await revParseTree(input.root, mergeBaseSha) : null;
  // Degenerate = the branch tip is already an ancestor of the default branch
  // (merged), so merge-base is at/after the target — a merged tip's tree still
  // differs from the captured target by post-checkpoint drift, so test ancestry.
  const mergeBaseDegenerate =
    ta.ancestryRef !== null &&
    defaultBranch !== null &&
    (await input.repo.isAncestor(ta.ancestryRef, defaultBranch));
  const oldestBaseSha = oldestArtifactBaseSha(input.artifacts);
  const oldestArtifactBaseTree = oldestBaseSha
    ? await revParseTree(input.root, oldestBaseSha)
    : null;
  const fallbackRef = ta.ancestryRef ?? worktreeHead;
  const fallbackTree = (await revParseTree(input.root, fallbackRef)) ?? pinnedTreeSha;

  const chosen = chooseBase({
    overrideTree: input.overrideTree,
    mergeBaseTree,
    mergeBaseDegenerate,
    targetTree: pinnedTreeSha,
    oldestArtifactBaseTree,
    fallbackTree,
  });
  const baseTreeSha = chosen.baseTree;
  const baseShaBySource: Record<BaseSource, string | null> = {
    override: input.overrideRef,
    merge_base: mergeBaseSha,
    oldest_artifact: oldestBaseSha,
    fallback: fallbackRef,
  };
  const baseSha = baseShaBySource[chosen.source] ?? baseTreeSha;

  // Pre-diff topology disclosures only (degenerate/merged-branch scope). These
  // ARE in the fingerprint — they carry topology facts (chosen base source,
  // degraded target) that identical trees don't fully determine.
  const disclosures: Disclosure[] = [...chosen.disclosures];
  if (input.overrideDisclosure != null) disclosures.push(input.overrideDisclosure);
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
  if (onBranch && (worktree.ignored_opt_ins.length > 0 || worktree.unmatched_opt_ins.length > 0)) {
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

  return {
    baseSha,
    baseTreeSha,
    pinnedTreeSha,
    worktreeHead,
    defaultBranch,
    reviewIncludedUntracked,
    baseSource: chosen.source,
    degraded: ta.degraded,
    disclosures,
  };
}
