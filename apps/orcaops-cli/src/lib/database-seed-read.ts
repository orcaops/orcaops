import type { Repo } from '@orcaops/core';
import {
  type ProjectDatabase,
  queryProjectArtifacts,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import {
  collectArtifactCoverage,
  describeOpenCheckpoint,
  expandCoveredRanges,
  type SeedOpenCheckpoint,
  type SeedOpenCheckpointGuard,
} from '../commands/seed/index.js';

/**
 * The set of commit SHAs the project's history already covers, read from the SQLite
 * project database — the database counterpart of `collectCoveredShas`.
 *
 * The file version also folded in the shared project archive; there is no archive on the
 * database (it is retired), so the project database is the single source of coverage and
 * the local set is the whole set. Every artifact contributes its closed checkpoints' head
 * SHAs and its summary head SHA, and the open→close ranges expand through git ancestry —
 * the same pure `collectArtifactCoverage` / `expandCoveredRanges` the file path used.
 */
export async function collectDatabaseCoveredShas(
  handle: ProjectDatabase,
  repo: Pick<Repo, 'isAncestor' | 'getCommitsBetweenStrict'>
): Promise<Set<string>> {
  const covered = new Set<string>();
  const ranges = new Map<string, { base: string; head: string }>();
  for (const row of queryProjectArtifacts(handle, {}).rows) {
    const retained = readProjectArtifact(handle, row.artifactId);
    if (!retained) continue;
    collectArtifactCoverage(retained.thread.checkpoints, retained.thread.summary, covered, ranges);
  }
  await expandCoveredRanges(repo, [...ranges.values()], covered);
  return covered;
}

/**
 * The open-checkpoint guard, read from the project database. A FOREIGN open checkpoint (on
 * a live capture) blocks a seed apply — the coverage pre-filter reads closed claims only,
 * so an in-flight session's eventual head SHAs are unknowable and seeding beside it risks
 * double-narrating it. A seed-owned open checkpoint (a `git-import` artifact) is this
 * command's own crash residue and never a reason to refuse; ownership is read off the
 * `git-import` origin, the storage-class choke point.
 */
export function inspectDatabaseOpenCheckpointGuard(
  handle: ProjectDatabase
): SeedOpenCheckpointGuard {
  const openCheckpoints: SeedOpenCheckpoint[] = [];
  for (const row of queryProjectArtifacts(handle, { profile: 'versions' }).rows) {
    if (row.openCheckpointCount === 0) continue;
    const retained = readProjectArtifact(handle, row.artifactId);
    if (!retained) continue;
    for (const checkpoint of retained.thread.checkpoints) {
      if (checkpoint.status !== 'open') continue;
      openCheckpoints.push({
        artifact_id: row.artifactId,
        artifact_label: retained.thread.plan?.label ?? row.artifactId,
        checkpoint_n: checkpoint.n,
        seed_owned: row.origin === 'git-import',
      });
    }
  }
  openCheckpoints.sort(
    (left, right) =>
      left.artifact_id.localeCompare(right.artifact_id) || left.checkpoint_n - right.checkpoint_n
  );
  const foreign = openCheckpoints.filter((checkpoint) => !checkpoint.seed_owned);
  const stranded = openCheckpoints.filter((checkpoint) => checkpoint.seed_owned);
  return {
    blocked: foreign.length > 0,
    open_checkpoints: openCheckpoints,
    stranded,
    message:
      foreign.length > 0
        ? `Seed cannot write while a checkpoint is open: ${foreign
            .map(describeOpenCheckpoint)
            .join('; ')}. Close or abandon it first.`
        : null,
    recovery_message:
      stranded.length > 0
        ? `recovering an interrupted seed run: ${stranded.map(describeOpenCheckpoint).join('; ')}`
        : null,
  };
}
