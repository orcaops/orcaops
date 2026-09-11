import { isDeepStrictEqual } from 'node:util';

import { inspectDatabaseSetup, setupProjectDatabase } from '@orcaops/core/history/database-setup';
import {
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
} from '@orcaops/storage/history/database';

export async function registerMissingDatabaseWorktree(
  input: {
    cwd: string;
    root: string;
    projectId?: string;
    secretAllow: readonly string[];
    expectedAuthority?: ProjectDatabaseAuthority;
  },
  options: { dryRun?: boolean; signal?: AbortSignal } = {}
) {
  const state = await inspectDatabaseSetup(input, options);
  if (state.state !== 'registered') return null;
  if (
    input.expectedAuthority &&
    !isDeepStrictEqual(state.initialization!.authority, input.expectedAuthority)
  )
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Project authority changed before worktree registration'
    );
  if (state.worktree) return null;
  if (!options.dryRun) {
    const result = await setupProjectDatabase(
      { ...input, projectId: state.initialization!.authority.projectId, authoredPayloads: [] },
      options
    );
    if (result.status !== 'complete') {
      const pending = result.pending[0];
      throw new ProjectDatabaseError(
        pending?.code ?? 'ACTIVATION_PENDING',
        pending?.message ?? 'Worktree registration is incomplete; retry the original command'
      );
    }
  }
  return { projectId: state.initialization!.authority.projectId, gitDir: state.context.gitDir };
}
