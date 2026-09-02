/**
 * Commit-level reconciliation for `orcaops diff --reconcile`.
 *
 * The adversarial sweep (`diff --attribution`) diffs artifact base →
 * live worktree, so a commit landed INSIDE the artifact window with no
 * checkpoint covering it is invisible there: its changes are already in
 * both trees. This module answers the complementary audit question —
 * "which in-window commits touched files no checkpoint accounts for?"
 *
 * Pure function: commits come from `Repo.getCommitsBetweenStrict`
 * (callers MUST use the strict variant — an enumeration failure has to
 * surface as an error, never as an empty-and-therefore-clean result);
 * coverage is the union of closed checkpoints' `files_changed` claims
 * plus manifest file paths, assembled by the CLI.
 */

/** One commit in the audited window (shape of `getCommitsBetween*`). */
export interface ReconcileCommit {
  sha: string;
  subject: string;
  files: readonly string[];
}

export interface ReconciledCommit {
  sha: string;
  subject: string;
  files: string[];
  /** Files of this commit that no checkpoint claim or manifest covers. */
  uncovered_files: string[];
  /**
   * Files covered ONLY by weak/provisional evidence (ambiguous,
   * mixed-segment, or own-claim-pending under a window overlap).
   * Strong coverage always wins — a file in both sets is
   * strongly covered.
   */
  weakly_covered_files: string[];
  /**
   * Every file accounted for, but at least one only weakly — the
   * commit must be DISCLOSED as ambiguous coverage, never silently
   * clean.
   */
  ambiguous_coverage: boolean;
  /**
   * Non-empty file list and EVERY file uncovered — work no checkpoint
   * accounts for at all. Deliberately false for zero-file commits
   * (`git log --name-only` lists no files for merge commits), so a
   * merge never reads as smuggled work; callers can still see the
   * empty `files` array and disclose if they care.
   */
  fully_uncovered: boolean;
}

export interface ReconcileResult {
  /** Per-commit reconciliation, input order preserved. */
  commits: ReconciledCommit[];
  /**
   * Commits with at least one uncovered file — the audit findings.
   * Includes the fully-uncovered ones (`fully_uncovered: true`).
   */
  uncovered_commits: ReconciledCommit[];
  /** Commits whose every file is covered (zero-file commits count). */
  covered_commit_count: number;
}

/**
 * Classify every commit's files against the coverage set. No I/O, no
 * git — determinism is the point: the same commits + coverage always
 * reconcile identically.
 */
export function reconcileCommitsAgainstCoverage(opts: {
  commits: readonly ReconcileCommit[];
  /** Union of covered file paths (repo-relative, same as commit files). */
  coverage: Iterable<string>;
  /**
   * Weak/provisional coverage under window overlap: ambiguous,
   * mixed-segment, own-claim-pending files. A file here but
   * not in `coverage` counts as weakly covered — disclosed, never
   * silently clean.
   */
  weakCoverage?: Iterable<string>;
}): ReconcileResult {
  const covered = opts.coverage instanceof Set ? opts.coverage : new Set(opts.coverage);
  const weak = new Set(opts.weakCoverage ?? []);

  const commits: ReconciledCommit[] = opts.commits.map((c) => {
    const files = [...c.files];
    const uncovered = files.filter((f) => !covered.has(f) && !weak.has(f));
    const weaklyCovered = files.filter((f) => !covered.has(f) && weak.has(f));
    return {
      sha: c.sha,
      subject: c.subject,
      files,
      uncovered_files: uncovered,
      weakly_covered_files: weaklyCovered,
      ambiguous_coverage: uncovered.length === 0 && weaklyCovered.length > 0,
      fully_uncovered: files.length > 0 && uncovered.length === files.length,
    };
  });

  const uncoveredCommits = commits.filter((c) => c.uncovered_files.length > 0);
  return {
    commits,
    uncovered_commits: uncoveredCommits,
    covered_commit_count: commits.length - uncoveredCommits.length,
  };
}
