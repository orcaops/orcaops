import { Repo } from '@orcaops/core';

import { readProjectId } from './project-identity.js';

/**
 * The one seam for every home-dir store keyed per repo (pin store,
 * global-install refs): the minted `orcaops.projectid`, used VERBATIM — a
 * UUIDv7 is fs-safe, move-stable, and worktree-shared. Null when the repo
 * has no identity yet; such a repo has no per-repo home-dir state either,
 * so callers treat null as "nothing recorded". A malformed stored id is
 * refused by readProjectId, never silently re-keyed.
 */
export async function resolveRepoKey(repo: Repo): Promise<string | null> {
  return readProjectId(repo);
}
