/**
 * CLI-side branch-history helpers — mirrors the cloud's branch-history
 * dedup + cap + strip rules.
 *
 * The cloud and the CLI must agree on those rules so the chain that
 * ships in `OssCaptureThreadStartPayload.branch_history` matches what
 * the cloud's `findOpenTaskByBranchOrHistory` expects. The two
 * implementations are intentionally identical and small enough to keep
 * in sync by eye.
 */

/**
 * Maximum entries the CLI retains in the per-session branch_history.
 * A user who renames 11 times in one session without a successful push
 * in between is in a different kind of trouble.
 */
export const BRANCH_HISTORY_CAP = 10;

/**
 * Append `additions` to `existing` preserving order and deduplicating:
 * every entry in `additions` is appended unless it already appears in
 * `existing` or earlier in the same `additions` batch. Empty strings
 * are dropped.
 *
 * Direction: oldest first, most recently learned last. Trims the front
 * when the result exceeds {@link BRANCH_HISTORY_CAP}, keeping the most
 * recent entries.
 */
export function dedupAppend(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing);
  const result = [...existing];
  for (const entry of additions) {
    if (!entry) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  if (result.length <= BRANCH_HISTORY_CAP) return result;
  return result.slice(result.length - BRANCH_HISTORY_CAP);
}

/**
 * Defensive guard: a payload's `branch_history` must never include the
 * current `branch` per the wire contract. Strip the current branch and
 * empty strings before send — the cloud-side handler does the same
 * defensively, but trimming here keeps the wire smaller and matches the
 * documented protocol.
 */
export function stripCurrentFromHistory(currentBranch: string, history: string[]): string[] {
  return history.filter((entry) => entry && entry !== currentBranch);
}
