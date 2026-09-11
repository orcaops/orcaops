import { isUuidV7 } from '@orcaops/storage';
import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';
import {
  observeProjectSessionBranch,
  type ProjectSessionBranchKey,
  readProjectSessionBranch,
  readProjectSessionObservation,
  type RetainedSessionBranchState,
} from '@orcaops/storage/history/database/session-branch';

import { dedupAppend, stripCurrentFromHistory } from '../../cloud/branch-history.js';
import {
  type RegisteredDatabaseContext,
  revalidateDatabaseExecutionContext,
} from '../context/execution.js';
import { runDatabaseGit } from '../context/git-process.js';

export interface DatabaseSessionObservationInput {
  operationId: string;
  revisionId: string;
  target: ProjectSessionBranchKey['target'];
  repoUrl: string;
  secretAllow: readonly string[];
}
export interface DatabaseSessionObservationOptions extends ProjectOperationOptions {
  /** Non-fatal Git introspection failures; the observation returns null instead. */
  onUnobservable?: (cause: unknown, context: { stage: 'priorBranchExists' }) => void;
}
function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Session observation cancelled before the original operation was published'
    );
}
async function priorBranchExists(
  context: RegisteredDatabaseContext,
  branch: string,
  signal?: AbortSignal
): Promise<boolean> {
  const probe = await runDatabaseGit(
    context.git.worktreeRoot,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    signal,
    [1]
  );
  return probe.code === 0;
}
function proposedState(
  key: ProjectSessionBranchKey,
  previous: RetainedSessionBranchState | null,
  branch: string,
  headOid: string,
  priorExists: boolean | null
): RetainedSessionBranchState {
  const identity = {
    schema_version: 1 as const,
    target: { ...key.target },
    repo_url: key.repoUrl,
    working_dir: key.workingDir,
    current_branch: branch,
  };
  if (previous === null || priorExists === true)
    return { ...identity, branch_history: [], base_commit_sha: headOid, last_acked_at: null };
  return {
    ...identity,
    branch_history: stripCurrentFromHistory(
      branch,
      dedupAppend([...previous.branch_history], [previous.current_branch])
    ),
    base_commit_sha: previous.base_commit_sha ?? headOid,
    last_acked_at: previous.last_acked_at,
  };
}
/**
 * Publish one registered session-branch observation.
 *
 * Returns null when the checkout has no branch to track — a detached HEAD, or a
 * prior-branch probe that failed. Git runs only outside the database transaction, and a
 * recovery by original operation ID never runs Git at all.
 */
export async function observeDatabaseSessionBranch(
  handle: ProjectDatabase,
  context: RegisteredDatabaseContext,
  input: DatabaseSessionObservationInput,
  options: DatabaseSessionObservationOptions = {}
) {
  if (!isUuidV7(input?.operationId) || !isUuidV7(input?.revisionId))
    invalid('Provide the original session observation and revision UUIDs');
  if (typeof input.repoUrl !== 'string' || !input.repoUrl)
    invalid('Provide the original session repository URL');
  if (!Array.isArray(input.secretAllow) || input.secretAllow.some((v) => typeof v !== 'string'))
    invalid('Provide an explicit session refusal allowlist');
  const { onUnobservable, ...operation } = options;
  const publication = { ...operation, secretAllow: [...input.secretAllow] };
  cancelled(operation.signal);
  // Recovery consults the committed receipt before any Git work: the retained
  // observation is the whole original request, so nothing is re-observed.
  const retained = readProjectSessionObservation(handle, input.operationId);
  if (retained) return observeProjectSessionBranch(handle, retained, publication);
  const key: ProjectSessionBranchKey = {
    target: { ...input.target },
    repoUrl: input.repoUrl,
    workingDir: context.git.worktreeRoot,
  };
  const branch = context.git.branch;
  const headOid = context.git.headOid;
  if (branch === null || headOid === null) return null;
  const selected = readProjectSessionBranch(handle, key);
  const previous = selected?.state ?? null;
  cancelled(operation.signal);
  let priorExists: boolean | null = null;
  if (previous !== null && previous.current_branch !== branch) {
    try {
      priorExists = await priorBranchExists(context, previous.current_branch, operation.signal);
    } catch (cause) {
      if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
      onUnobservable?.(cause, { stage: 'priorBranchExists' });
      return null;
    }
  }
  const state = proposedState(key, previous, branch, headOid, priorExists);
  // Git and the registered identity are read before the write; the context is proved
  // unchanged here rather than retargeted after the awaits above.
  await revalidateDatabaseExecutionContext(context, { signal: operation.signal });
  cancelled(operation.signal);
  return observeProjectSessionBranch(
    handle,
    {
      operationId: input.operationId,
      revisionId: input.revisionId,
      key,
      expectedSelection: selected?.selection ?? null,
      stateBytes: Buffer.from(JSON.stringify(state)),
      observation: { headOid, priorBranchExists: priorExists },
    },
    publication
  );
}
