import { diffSnapshotStats, type Repo } from '@orcaops/core';
import { unreportedChangedPaths } from '@orcaops/evaluator-protocol';

const MAX_NAMED_PATHS = 20;

export async function observedCheckpointPaths(
  repo: Repo,
  openTreeSha: string | null,
  closeTreeSha: string | null
): Promise<string[] | null> {
  if (openTreeSha === null || closeTreeSha === null) return null;
  if (openTreeSha === closeTreeSha) return [];
  const stats = await diffSnapshotStats({ repo, openTreeSha, closeTreeSha });
  if (!stats.ok) return null;
  return stats.entries.map((entry) => entry.path).sort();
}

export function unreportedChangedPathsWarning(
  n: number,
  paths: readonly string[]
): { code: string; message: string } {
  const named = paths.slice(0, MAX_NAMED_PATHS).join(', ');
  const more = paths.length > MAX_NAMED_PATHS ? ` and ${paths.length - MAX_NAMED_PATHS} more` : '';
  return {
    code: 'unreported-changed-paths',
    message:
      `Checkpoint ${n} changed paths its files_changed does not report: ${named}${more}. ` +
      `Anything that reads files_changed, including reviewers and path-filtered evaluators, misses them. ` +
      `List every path the checkpoint changed, or say in the summary why a path is incidental.`,
  };
}

export async function unreportedChangedPathsWarnings(
  repo: Repo,
  checkpoint: {
    n: number;
    files_changed: readonly string[];
    open_snapshot: { tree_sha: string | null };
    close_snapshot: { tree_sha: string | null };
  }
): Promise<Array<{ code: string; message: string }>> {
  const observed = await observedCheckpointPaths(
    repo,
    checkpoint.open_snapshot.tree_sha,
    checkpoint.close_snapshot.tree_sha
  );
  if (observed === null) return [];
  const missing = unreportedChangedPaths(observed, checkpoint.files_changed);
  return missing.length > 0 ? [unreportedChangedPathsWarning(checkpoint.n, missing)] : [];
}
