import { isDeepStrictEqual } from 'node:util';

import { isUuidV7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
} from '@orcaops/storage/history/database';
import { type ExecutionBinding, ExecutionBindingSchema } from '@orcaops/storage/history/execution';

import {
  type DatabaseGitContext,
  resolveDatabaseGitContext,
  revalidateDatabaseGitContext,
  sameRepositoryCreation,
} from './git-context.js';
import { readDatabaseGitHead as readHead } from './git-head.js';
import { databaseSetupError } from '../setup/errors.js';
import { readValidatedSetupRegistration } from '../setup/inspection.js';

export interface RegisteredDatabaseContext {
  authority: ProjectDatabaseAuthority;
  git: DatabaseGitContext;
  binding: ExecutionBinding | null;
}
async function readRegisteredContext(
  input: { cwd: string; root: string; projectId?: string },
  options: { signal?: AbortSignal } = {}
): Promise<RegisteredDatabaseContext | null> {
  const { cwd, root: requestedRoot, projectId } = input;
  const { signal } = options;
  if (
    typeof cwd !== 'string' ||
    !cwd ||
    typeof requestedRoot !== 'string' ||
    !requestedRoot ||
    (projectId !== undefined && !isUuidV7(projectId))
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide an existing checkout, selected data root and optional exact project UUID'
    );
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Registered context inspection cancelled before Git reads'
    );
  const root = await normalizeHistoryRoot({ root: requestedRoot });
  const context = await resolveDatabaseGitContext({ cwd, signal });
  const registered = await readValidatedSetupRegistration(context, root, projectId);
  if (!registered) return null;
  const registration = registered.registration!;
  const authority: ProjectDatabaseAuthority = {
    resolvedRoot: registration.authority.resolved_root,
    rootKey: registration.authority.root_key,
    projectId: registration.authority.project_id,
    storeInstanceId: registration.authority.store_instance_id,
    repositoryInstanceId: registration.repository_instance_id,
  };
  const head = await readHead(context, signal);
  await revalidateDatabaseGitContext(context, signal);
  if (!isDeepStrictEqual(head, await readHead(context, signal)))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Git context changed during inspection; prepare a new operation against the intended checkout'
    );
  const git = {
    ...context,
    ...head,
    repositoryInstanceId: authority.repositoryInstanceId,
    worktreeId: registered.worktree?.worktree_id ?? null,
  };
  const binding =
    git.worktreeId === null
      ? null
      : ExecutionBindingSchema.parse({
          repository_instance_id: authority.repositoryInstanceId,
          worktree_id: git.worktreeId,
          git_context: { branch: git.branch, head_sha: git.headOid },
        });
  return { authority, git, binding };
}
export async function requireDatabaseExecutionContext(
  input: { cwd: string; root: string; projectId?: string },
  options: { signal?: AbortSignal } = {}
) {
  const current = await readRegisteredDatabaseContext(input, options);
  if (!current)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'Registered project history is unavailable. Run `orcaops doctor` before recovery; use first-use setup only after confirming no prior history exists, otherwise restore the verified original registration and database.'
    );
  if (!current.binding)
    throw new ProjectDatabaseError(
      'IDENTITY_RECOVERY_REQUIRED',
      'This worktree has no execution registration; run `orcaops doctor --fix` in this worktree. Existing artifact ownership still requires explicit checkout handoff.'
    );
  return { ...current, binding: current.binding };
}
export async function revalidateDatabaseExecutionContext(
  expected: RegisteredDatabaseContext,
  options: { signal?: AbortSignal } = {}
) {
  const snapshot = structuredClone(expected);
  const current = await requireDatabaseExecutionContext(
    {
      cwd: snapshot.git.worktreeRoot,
      root: snapshot.authority.resolvedRoot,
      projectId: snapshot.authority.projectId,
    },
    options
  );
  if (
    !isDeepStrictEqual(current.authority, snapshot.authority) ||
    !sameRepositoryCreation(current.git.repositoryCreation, snapshot.git.repositoryCreation) ||
    !sameRepositoryCreation(
      current.git.administrativeIdentity,
      snapshot.git.administrativeIdentity
    ) ||
    !isDeepStrictEqual(current.binding, snapshot.binding)
  )
    throw new ProjectDatabaseError(
      'EXECUTION_CONTEXT_CHANGED',
      'Registered Git context changed after preparation; explicitly validate the intended worktree and start a new operation'
    );
  return current;
}

export async function readRegisteredDatabaseContext(
  input: { cwd: string; root: string; projectId?: string },
  options: { signal?: AbortSignal } = {}
): Promise<RegisteredDatabaseContext | null> {
  try {
    return await readRegisteredContext(input, options);
  } catch (cause) {
    throw databaseSetupError(cause);
  }
}
