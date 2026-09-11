import { isDeepStrictEqual } from 'node:util';

import { canonicalJson } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import {
  type RegisteredDatabaseContext,
  revalidateDatabaseExecutionContext,
} from '../context/execution.js';
import { enumerateDatabaseGitContexts } from '../context/git-context.js';
import { readValidatedSetupRegistration } from '../setup/inspection.js';

export async function observeCheckoutOwnerAbsence(
  context: RegisteredDatabaseContext,
  ownerId: string,
  signal?: AbortSignal
) {
  const inventory = await enumerateDatabaseGitContexts(context.git, signal);
  const refuse = (details?: string): never => {
    throw new ProjectDatabaseError(
      'EXECUTION_RECOVERY_REQUIRED',
      'Original execution ownership is not proven absent in the complete registered Git inventory; preserve the binding and resolve worktree registration or choose explicit handoff' +
        (details ? `: ${details}` : '')
    );
  };
  if (inventory.unresolved.length)
    refuse(
      inventory.unresolved
        .map((entry) => `${entry.worktreeRoot || '(unknown worktree)'}: ${entry.reason}`)
        .join('; ')
    );
  const observations = [];
  const identities = new Set<string>();
  for (const git of inventory.contexts) {
    if (signal?.aborted)
      throw new ProjectDatabaseError('CANCELLED', 'Checkout ownership inspection cancelled');
    const registered = await readValidatedSetupRegistration(
      git,
      context.authority,
      context.authority.projectId
    );
    if (!registered?.registration || !registered.worktree)
      return refuse(
        `${git.worktreeRoot} (${git.gitDir}): missing registration; run orcaops doctor --fix in that worktree`
      );
    const { registration, worktree } = registered;
    const authority = {
      resolvedRoot: registration.authority.resolved_root,
      rootKey: registration.authority.root_key,
      projectId: registration.authority.project_id,
      storeInstanceId: registration.authority.store_instance_id,
      repositoryInstanceId: registration.repository_instance_id,
    };
    if (
      !isDeepStrictEqual(authority, context.authority) ||
      identities.has(worktree.worktree_id) ||
      worktree.worktree_id === ownerId
    )
      refuse();
    identities.add(worktree.worktree_id);
    observations.push({ git, registration, worktree });
  }
  if (!context.git.worktreeId || !identities.has(context.git.worktreeId)) refuse();
  await revalidateDatabaseExecutionContext(context, { signal });
  if (signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'Checkout ownership inspection cancelled');
  return canonicalJson({ inventoryHash: inventory.hash, observations });
}
