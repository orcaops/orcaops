import { type BranchLineageEntry } from '@orcaops/storage';

import { buildContext } from '../lib/context.js';
import { runCapture } from '../lib/run-capture.js';

export interface LineageOptions {
  /** Override the branch sync operates on (defaults to the current git branch). */
  branch?: string;
  json?: boolean;
}

interface LineageResult extends Record<string, unknown> {
  branch: string;
  head_sha: string;
  /** Rebase / amend updates: latest entry on current branch advanced to HEAD. */
  updated: Array<{ artifact_id: string; prior_sha: string; new_sha: string }>;
  /** Artifacts whose latest entry on current branch already pointed at HEAD. */
  skipped: Array<{ artifact_id: string; reason: 'already-current' }>;
  /** Merge detection: artifacts whose other-branch lineage SHA is now reachable from HEAD. */
  merged: Array<{
    artifact_id: string;
    source_branch: string;
    source_sha: string;
    new_sha: string;
  }>;
}

/**
 * `orcaops lineage` — keep `branch_lineage[]` truthful after rebases,
 * amends, or merges. Two passes:
 *
 *   1. **Rebase / amend** — for every artifact whose latest lineage
 *      entry is on the current branch but whose recorded SHA is no
 *      longer HEAD, append a `rebased` entry pointing at HEAD.
 *      O(matches) via the `lineage_by_latest_sha` index.
 *
 *   2. **Merge detection** — for every artifact whose
 *      latest entry is on a *different* branch but whose recorded
 *      SHA is reachable from current HEAD, append a `merged` entry
 *      recording (current_branch, current_HEAD). One
 *      `git merge-base --is-ancestor` invocation per non-current
 *      candidate; the index update from the first run "moves" the
 *      artifact's latest-entry branch to current, so subsequent runs
 *      no-op naturally.
 *
 * Idempotent: a no-op pass on an in-sync branch produces zero
 * updates, zero merges.
 *
 * **Caveat for merge detection:** the recorded SHA is current HEAD,
 * not the specific merge commit. For squash-merges (no merge commit
 * exists) and for descendant-branch cases (e.g. feat/y branched from
 * feat/x without a real merge), the entry is still added — the
 * artifact then appears under the descendant branch in list / status.
 */
export async function lineageAction(opts: LineageOptions = {}): Promise<void> {
  await runCapture(async () => {
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const branch = opts.branch ?? (await ctx.repo.getCurrentBranch());
      const headSha = await ctx.repo.getHeadSha();
      const ts = new Date().toISOString();

      const result: LineageResult = {
        branch,
        head_sha: headSha,
        updated: [],
        skipped: [],
        merged: [],
      };

      // ── Pass 1: rebase / amend ─────────────────────────────────────
      const allOnBranch = ctx.store.store.db
        .prepare(
          `SELECT artifact_id, latest_lineage_sha, branch_name
           FROM lineage_by_latest_sha
           WHERE branch_name = ?`
        )
        .all(branch) as Array<{
        artifact_id: string;
        latest_lineage_sha: string;
        branch_name: string;
      }>;

      for (const row of allOnBranch) {
        if (row.latest_lineage_sha === headSha) {
          result.skipped.push({ artifact_id: row.artifact_id, reason: 'already-current' });
          continue;
        }
        const entry: BranchLineageEntry = {
          branch,
          head_sha: headSha,
          ts,
          event: 'rebased',
        };
        await ctx.store.appendBranchLineage(row.artifact_id, entry);
        result.updated.push({
          artifact_id: row.artifact_id,
          prior_sha: row.latest_lineage_sha,
          new_sha: headSha,
        });
      }

      // ── Pass 2: merge detection ────────────────────────────────────
      // Artifacts whose latest lineage entry is on a different branch
      // but whose recorded SHA is reachable from current HEAD have
      // (effectively) been merged into the current branch.
      const mergeCandidates = ctx.store.store.db
        .prepare(
          `SELECT artifact_id, latest_lineage_sha, branch_name
           FROM lineage_by_latest_sha
           WHERE branch_name != ?`
        )
        .all(branch) as Array<{
        artifact_id: string;
        latest_lineage_sha: string;
        branch_name: string;
      }>;

      for (const row of mergeCandidates) {
        if (row.latest_lineage_sha === headSha) continue;
        if (!(await ctx.repo.isAncestor(row.latest_lineage_sha, headSha))) continue;
        const entry: BranchLineageEntry = {
          branch,
          head_sha: headSha,
          ts,
          event: 'merged',
        };
        await ctx.store.appendBranchLineage(row.artifact_id, entry);
        result.merged.push({
          artifact_id: row.artifact_id,
          source_branch: row.branch_name,
          source_sha: row.latest_lineage_sha,
          new_sha: headSha,
        });
      }

      return result;
    } finally {
      ctx.store.close();
    }
  });
}
