import { withNonDerivableWriteLease } from '@orcaops/storage';
import type { ArtifactStore, SessionBranchState } from '@orcaops/storage';

import { dedupAppend, stripCurrentFromHistory } from './branch-history.js';
import type { Repo } from '../git/repo.js';

/**
 * `git rev-parse --abbrev-ref HEAD` literal returned in a detached-HEAD
 * state. Routing a capture at this sentinel would tell the cloud to match a
 * task with the literal branch name "HEAD" — never what the user means. We
 * fall back to the caller's snapshot-time branch instead so a brief detach
 * mid-session (rebase, bisect, checkout-by-sha) does not orphan the capture.
 */
const DETACHED_HEAD_SENTINEL = 'HEAD';

/**
 * CLI-side session state for the cloud's branch-history matching path.
 *
 * The cloud's `findOpenTaskByBranchOrHistory` accepts a `branch_history`
 * chain alongside the current branch so a local `git branch -m` rename
 * routes captures into the existing task. The chain has to live across
 * CLI invocations because eager push + offline retry mean the rename
 * event and the next `captureThread.start` may straddle a process
 * boundary.
 *
 * This module owns the read-and-update half of that contract:
 *
 *   - `syncToGit` reads the current `git symbolic-ref --short HEAD`,
 *     compares against the stored `current_branch`, appends a rename
 *     to the chain when it differs, persists, and returns the state
 *     the caller will copy into the start-payload.
 *   - `markAcked` clears the chain after a successful start ack — the
 *     cloud now knows the canonical current branch, so subsequent
 *     renames start a fresh window.
 *
 * Identity is `(repoUrl, workingDir)`. State persists in the SQLite
 * `cli_session_branch_state` table introduced by migration 013.
 */

/**
 * Observe the live git state, reconcile it against any stored CLI
 * session state, and persist + return the post-reconcile snapshot.
 *
 * Returns `null` when there is no reliable live branch to track — either
 * the working tree is in a detached-HEAD state (rebase, bisect, checkout
 * by SHA) or the git introspection threw. The caller falls back to the
 * snapshot-time branch in that case; no session row is read or written
 * so subsequent invocations on a real branch start cleanly.
 *
 * Reconcile rules (when live branch is available):
 *
 *   - First sight (no row yet): seed `current_branch` from git, seed
 *     `base_commit_sha` from HEAD, `branch_history = []`.
 *   - Branch unchanged: return the stored row as-is.
 *   - Branch changed: append the previously-stored branch to
 *     `branch_history` (deduped, capped, current-branch stripped),
 *     then advance `current_branch` to the new value. `base_commit_sha`
 *     stays pinned to the original session start so the SHA derivation
 *     doesn't reset on every rename.
 */
export async function syncToGit(opts: {
  repo: Repo;
  store: Pick<ArtifactStore, 'store' | 'repoRoot'>;
  repoUrl: string;
  workingDir: string;
  /**
   * Optional sink for non-fatal git-introspection failures. Invoked once per
   * `syncToGit` call when `getCurrentBranch` or `getHeadSha` throws — the
   * call still returns null and the push proceeds, but the error is surfaced
   * so a persistently-broken git invocation does not silently disable rename
   * detection forever. Common callers wire this to `console.warn`.
   */
  onError?: (err: unknown, context: { stage: 'getCurrentBranch' | 'getHeadSha' }) => void;
  /** Eager-push cancellation; bounds the otherwise 150-second rebuild-lock wait. */
  signal?: AbortSignal;
}): Promise<SessionBranchState | null> {
  const { repo, store, repoUrl, workingDir, onError, signal } = opts;
  const leaseOptions = signal
    ? { retryOnLeaseLoss: true, acquireTimeoutMs: 2_000 }
    : { retryOnLeaseLoss: true };

  let currentBranch: string;
  let headSha: string;
  signal?.throwIfAborted();
  try {
    currentBranch = await repo.getCurrentBranch();
  } catch (err) {
    // Empty repo, missing HEAD, worktree corruption — capture push should
    // not be blocked on a tooling bug in rename detection. Surface to the
    // caller-supplied sink so persistent failures are visible.
    onError?.(err, { stage: 'getCurrentBranch' });
    return null;
  }
  signal?.throwIfAborted();
  try {
    headSha = await repo.getHeadSha();
  } catch (err) {
    onError?.(err, { stage: 'getHeadSha' });
    return null;
  }
  signal?.throwIfAborted();

  if (currentBranch === DETACHED_HEAD_SENTINEL || currentBranch.length === 0) {
    return null;
  }

  const existing = store.store.getSessionBranchState(repoUrl, workingDir);

  if (!existing) {
    const fresh = {
      repoUrl,
      workingDir,
      currentBranch,
      branchHistory: [],
      baseCommitSha: headSha,
    };
    await withNonDerivableWriteLease(
      store.repoRoot,
      () => {
        signal?.throwIfAborted();
        store.store.upsertSessionBranchState(fresh);
      },
      leaseOptions
    );
    return { ...fresh, lastAckedAt: null };
  }

  if (existing.currentBranch === currentBranch) {
    return existing;
  }

  // Branch differs from the stored row. Two reasons it differs:
  //
  //   1. `git branch -m <prior> <current>` — rename. The prior ref is gone;
  //      captures on <current> are a continuation of the work that lived on
  //      <prior>, so we thread <prior> into branchHistory and cloud routes
  //      them into the existing task.
  //   2. `git checkout -b <current> <prior>` (or `git switch -c`) — branch-
  //      off. The prior ref is still present; new captures belong to a
  //      NEW task. If we treated this as a rename the new feature would
  //      get pulled into the old feature's task spine and the old task's
  //      canonical `branch` would silently advance to <current>.
  //
  // `git rev-parse --verify refs/heads/<prior>` is the canonical signal:
  // a rename removes the prior ref, a branch-off leaves it intact. Falsely
  // identifying a branch-off (prior deleted right after) as a rename is the
  // safe failure mode — captures route to the original task and the user
  // can split if needed. The other direction (falsely calling a rename a
  // branch-off) would orphan in-flight work onto a fresh task, which is
  // why we lean on the explicit ref-existence probe rather than a heuristic.
  const priorStillExists = await repo.branchExists(existing.currentBranch);
  signal?.throwIfAborted();

  if (priorStillExists) {
    // Branch-off: reset to a fresh session for the new branch. The prior
    // session's row gets overwritten — the prior branch's task in the cloud
    // already owns its captures and doesn't need this row to find them
    // again. lastAckedAt resets to null so the new session is treated as
    // first-sight on the next push.
    const fresh = {
      repoUrl,
      workingDir,
      currentBranch,
      branchHistory: [],
      baseCommitSha: headSha,
    };
    await withNonDerivableWriteLease(
      store.repoRoot,
      () => {
        signal?.throwIfAborted();
        store.store.upsertSessionBranchState(fresh);
      },
      leaseOptions
    );
    return { ...fresh, lastAckedAt: null };
  }

  // Rename. Append the prior branch and any previously accumulated history.
  // Strip the new current branch defensively.
  const merged = dedupAppend([...existing.branchHistory], [existing.currentBranch]);
  const cleaned = stripCurrentFromHistory(currentBranch, merged);

  const next = {
    repoUrl,
    workingDir,
    currentBranch,
    branchHistory: cleaned,
    baseCommitSha: existing.baseCommitSha ?? headSha,
  };
  await withNonDerivableWriteLease(
    store.repoRoot,
    () => {
      signal?.throwIfAborted();
      store.store.upsertSessionBranchState(next);
    },
    leaseOptions
  );
  return { ...next, lastAckedAt: existing.lastAckedAt };
}

/**
 * Stamp a successful captureThread.start ack and clear the pending
 * rename chain. The cloud now knows the canonical `current_branch`;
 * subsequent CLI invocations should start chaining from empty.
 */
export function markAcked(opts: {
  store: Pick<ArtifactStore, 'store' | 'repoRoot'>;
  repoUrl: string;
  workingDir: string;
  ackedAt?: string;
}): void {
  const { store, repoUrl, workingDir } = opts;
  const ts = opts.ackedAt ?? new Date().toISOString();
  store.store.markSessionAcked(repoUrl, workingDir, ts);
}
