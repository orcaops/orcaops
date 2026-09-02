// Pure base/target resolution decisions. scope.ts performs the git queries
// (worktree tree, merge-base, tree peels) and feeds their RESULTS here, so the
// target-first / degenerate-scope logic is unit-testable across branch
// topologies (clean / rebased / merged / cross-checkout) without a real repo.
//
// The governing rule: choose the TARGET first,
// then the ancestry ref that BELONGS to that target — base and target must be
// anchored to the same captured moment, or a moved branch ref / unrelated HEAD
// re-mismatches them.

import { type Disclosure, DISCLOSURE_CODE } from '@orcaops/review-core';

/** The branch's latest closed checkpoint — its close tree is the captured target. */
export interface LatestClosed {
  tree: string;
  /** Close-time HEAD commit — the ancestry proxy (never the parentless snapshot commit). */
  headSha: string | null;
}

export interface TargetAndAncestryInput {
  onBranch: boolean;
  /** Live worktree tree (used only when reviewing the current branch). */
  worktreeTree: string;
  /** Current git HEAD (the on-branch ancestry ref). */
  worktreeHead: string;
  /** The branch's captured tip (used when reviewing a different branch). */
  latestClosed: LatestClosed | null;
}

export interface TargetAndAncestry {
  targetTree: string;
  /** Ref/sha to merge-base against, or null when no coherent ancestry exists. */
  ancestryRef: string | null;
  /** True when we fell back to the current checkout for an off-branch review with no captured target. */
  degraded: boolean;
}

/**
 * Pick the target, then the ancestry ref that corresponds to it. On-branch:
 * live worktree + HEAD. Cross-checkout: the latest checkpoint's close tree +
 * that same checkpoint's head_sha. No captured target off-branch: degrade to
 * the current checkout (disclosed).
 */
export function resolveTargetAndAncestry(input: TargetAndAncestryInput): TargetAndAncestry {
  if (input.onBranch) {
    return { targetTree: input.worktreeTree, ancestryRef: input.worktreeHead, degraded: false };
  }
  if (input.latestClosed) {
    return {
      targetTree: input.latestClosed.tree,
      ancestryRef: input.latestClosed.headSha,
      degraded: false,
    };
  }
  // Reviewing a different branch with no captured checkpoint — nothing coherent
  // to anchor to; fall back to the current checkout and disclose.
  return { targetTree: input.worktreeTree, ancestryRef: input.worktreeHead, degraded: true };
}

/**
 * Fail loudly on an unresolvable explicit `--base`. A typo must NOT silently
 * fall through to a different base and produce a plausible-but-wrong review —
 * especially since the degenerate-scope disclosure tells users to pass `--base`.
 */
export function validateOverrideBase(base: string | undefined, overrideTree: string | null): void {
  if (base !== undefined && base.length > 0 && overrideTree === null) {
    throw new Error(`invalid --base '${base}': not a resolvable git ref or sha`);
  }
}

export type BaseSource = 'override' | 'merge_base' | 'oldest_artifact' | 'fallback';

export interface ChooseBaseInput {
  /** `--base` override, already peeled to a tree. */
  overrideTree?: string | null;
  /** peel(merge-base(default, ancestryRef))^{tree}, or null when no merge-base resolved. */
  mergeBaseTree: string | null;
  /**
   * True when merge-base is degenerate: the branch tip is an ancestor of the
   * default branch (already merged), so merge-base is at/after the target.
   * Computed commit-side (`--is-ancestor`) since a merged tip's TREE still
   * differs from the target by post-checkpoint drift.
   */
  mergeBaseDegenerate?: boolean;
  /** The chosen target tree — also degenerate when `mergeBaseTree === targetTree` (exact empty). */
  targetTree: string;
  /** peel(oldest artifact base_sha)^{tree}, or null. */
  oldestArtifactBaseTree: string | null;
  /** Branch-scoped final fallback tree (HEAD tree on-branch, last-cp head tree off-branch). */
  fallbackTree: string;
}

export interface ChooseBaseResult {
  baseTree: string;
  source: BaseSource;
  disclosures: Disclosure[];
}

/**
 * Choose the base tree: override → merge-base (unless degenerate) → oldest
 * artifact base → branch-scoped fallback. Degeneracy is either the injected
 * `mergeBaseDegenerate` flag (the branch tip is an ancestor of the default
 * branch — merged — so the merged tip's tree still differs from the target by
 * post-checkpoint drift) or exact TREE equality (an empty diff). It never
 * hard-blocks — it falls back to the oldest-artifact base and discloses.
 */
export function chooseBase(input: ChooseBaseInput): ChooseBaseResult {
  const disclosures: Disclosure[] = [];

  if (input.overrideTree) {
    return { baseTree: input.overrideTree, source: 'override', disclosures };
  }

  const degenerate =
    input.mergeBaseDegenerate === true ||
    (input.mergeBaseTree !== null && input.mergeBaseTree === input.targetTree);

  if (input.mergeBaseTree !== null && !degenerate) {
    return { baseTree: input.mergeBaseTree, source: 'merge_base', disclosures };
  }

  const mergeBaseDegenerate = degenerate && input.mergeBaseTree !== null;

  if (mergeBaseDegenerate) {
    disclosures.push({
      code: DISCLOSURE_CODE.DEGENERATE_SCOPE,
      message:
        'the reviewed branch appears already merged into the default branch, so merge-base is not a useful base — showing the oldest-artifact base scope, which may include rebased-in work; pass --base <sha> to sharpen it',
    });
  }

  if (input.oldestArtifactBaseTree !== null && input.oldestArtifactBaseTree !== input.targetTree) {
    return { baseTree: input.oldestArtifactBaseTree, source: 'oldest_artifact', disclosures };
  }

  return { baseTree: input.fallbackTree, source: 'fallback', disclosures };
}
