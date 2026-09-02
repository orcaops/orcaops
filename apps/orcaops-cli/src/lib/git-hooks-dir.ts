import path from 'node:path';

import { Repo } from '@orcaops/core';

/**
 * Candidate dirs where an orcaops-stamped git hook may live: the dir git
 * currently RUNS hooks from (`rev-parse --git-path hooks`, which honors both
 * the linked-worktree common-dir indirection and `core.hooksPath`) plus the
 * default common-dir `hooks/`. A hook installed before a later
 * `core.hooksPath` adoption (husky, lefthook) strands in the default dir and
 * would never run — removal and doctor scan the union so it is still found.
 * Both sources canonicalize via realpath, so plain string dedupe suffices.
 */
export async function hooksDirCandidates(repo: Repo): Promise<string[]> {
  const { dir } = await repo.getHooksDir();
  const common = path.join(await repo.getCommonDirAbsolute(), 'hooks');
  return dir === common ? [dir] : [dir, common];
}
