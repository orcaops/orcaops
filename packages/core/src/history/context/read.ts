import { isDeepStrictEqual } from 'node:util';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { resolveDatabaseGitContext, revalidateDatabaseGitContext } from './git-context.js';
import { readDatabaseGitHead } from './git-head.js';
import { readRepositoryRegistration, readWorktreeRegistration } from '../registration-files.js';
import { databaseSetupError } from '../setup/errors.js';

export async function readDatabaseHistoryContext(input: { cwd: string; signal?: AbortSignal }) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.cwd !== 'string' ||
    !input.cwd.trim()
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide a nonempty Git working directory before reading history context'
    );
  const { cwd, signal } = input;
  if (signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'History context inspection cancelled');
  const context = await resolveDatabaseGitContext({ cwd, signal });
  const registration = await readRepositoryRegistration({ commonDir: context.commonDir });
  let worktreeId: string | null = null;
  let worktreeIssue: ProjectDatabaseError | null = null;
  if (registration) {
    try {
      worktreeId =
        (
          await readWorktreeRegistration({
            gitDir: context.gitDir,
            repositoryInstanceId: registration.repository_instance_id,
          })
        )?.worktree_id ?? null;
    } catch (cause) {
      worktreeIssue = databaseSetupError(cause);
    }
  }
  let head: { branch: string | null; headOid: string | null } = { branch: null, headOid: null };
  let headIssue: ProjectDatabaseError | null = null;
  try {
    head = await readDatabaseGitHead(context, signal);
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
    headIssue = databaseSetupError(cause);
  }
  await revalidateDatabaseGitContext(context, signal);
  if (!headIssue) {
    try {
      if (!isDeepStrictEqual(head, await readDatabaseGitHead(context, signal)))
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'Git context changed during inspection; retry the read'
        );
    } catch (cause) {
      if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
      head = { branch: null, headOid: null };
      headIssue = databaseSetupError(cause);
    }
  }
  if (signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'History context inspection cancelled');
  return {
    git: {
      ...context,
      ...head,
      repositoryInstanceId: registration?.repository_instance_id ?? null,
      worktreeId,
    },
    registration,
    worktreeIssue,
    headIssue,
  };
}
export type DatabaseHistoryContext = Awaited<ReturnType<typeof readDatabaseHistoryContext>>;
