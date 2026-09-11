import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import type { DatabaseGitContext } from './git-context.js';
import { runDatabaseGit } from './git-process.js';

export async function readDatabaseGitHead(context: DatabaseGitContext, signal?: AbortSignal) {
  const branch = await runDatabaseGit(
    context.worktreeRoot,
    ['symbolic-ref', '--quiet', 'HEAD'],
    signal,
    [1]
  );
  const head = await runDatabaseGit(
    context.worktreeRoot,
    ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    signal,
    [1]
  );
  const fullBranch = branch.code === 0 ? branch.stdout.trim() : null;
  const branchName = fullBranch?.startsWith('refs/heads/')
    ? fullBranch.slice('refs/heads/'.length)
    : fullBranch;
  const headOid = head.code === 0 ? head.stdout.trim() : null;
  if (
    (branch.code === 0 && !branchName) ||
    (headOid !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headOid)) ||
    (branchName === null && headOid === null)
  )
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Git HEAD is unavailable or invalid; inspect the original branch and commit before retrying'
    );
  if (headOid === null && branchName !== null) {
    const refs = await runDatabaseGit(
      context.worktreeRoot,
      ['for-each-ref', '--format=%(refname)', fullBranch!],
      signal
    );
    if (refs.stdout.trim())
      throw new ProjectDatabaseError(
        'HISTORY_INACCESSIBLE',
        'The current branch exists but its expected commit is unavailable; restore Git history before retrying'
      );
  }
  return { branch: branchName, headOid };
}
