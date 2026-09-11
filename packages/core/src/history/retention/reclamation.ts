import { isDeepStrictEqual } from 'node:util';

import {
  beginProjectGitReclamation,
  type GitReclamationAdmission,
  type GitReclamationTarget,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  readProjectGitReclamation,
  readProjectGitReclamationAdmission,
  settleProjectGitReclamation,
} from '@orcaops/storage/history/database';

import { removeDatabaseGitRef } from './publication.js';
import {
  type RegisteredDatabaseContext,
  revalidateDatabaseExecutionContext,
} from '../context/execution.js';

function checkAuthority(handle: ProjectDatabase, context: RegisteredDatabaseContext) {
  handle.read(() => null);
  if (!isDeepStrictEqual(handle.authority, context.authority))
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Use the original registered database for this cleanup; preserve the original publication'
    );
}
function checkTarget(handle: ProjectDatabase, target: GitReclamationTarget) {
  const current = readProjectGitReclamation(handle, target.publicationId).value;
  if (current.status !== 'eligible' || !isDeepStrictEqual(current.target, target))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'This exact publication is no longer eligible; preserve it and preview a new explicit cleanup request'
    );
}
export function previewDatabaseGitReclamation(handle: ProjectDatabase, publicationId: string) {
  return readProjectGitReclamation(handle, publicationId);
}
export async function resumeDatabaseGitReclamation(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  admissionOperationId: string,
  options: ProjectOperationOptions = {}
) {
  const context = structuredClone(expected);
  const operationOptions = { signal: options.signal, onWait: options.onWait };
  checkAuthority(handle, context);
  const original = readProjectGitReclamationAdmission(handle, admissionOperationId).value;
  if (!original)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The original cleanup admission is missing; preserve refs and use explicit repair rather than reconstructing a cleanup request'
    );
  if (original.terminal) return original.terminal;
  const target = original.input.target;
  checkTarget(handle, target);
  const current = await revalidateDatabaseExecutionContext(context, {
    signal: operationOptions.signal,
  });
  checkTarget(handle, target);
  const committed = readProjectGitReclamationAdmission(handle, admissionOperationId).value;
  if (committed?.terminal) return committed.terminal;
  try {
    const removed = await removeDatabaseGitRef(
      current,
      {
        fullRef: target.fullRef,
        objectOid: target.objectOid,
        objectFormat: target.objectFormat,
      },
      operationOptions
    );
    const concurrent = readProjectGitReclamationAdmission(handle, admissionOperationId).value;
    if (concurrent?.terminal) return concurrent.terminal;
    return await settleProjectGitReclamation(
      handle,
      { admissionOperationId, outcome: removed.outcome },
      operationOptions
    );
  } catch (cause) {
    try {
      const settled = readProjectGitReclamationAdmission(handle, admissionOperationId).value;
      if (settled?.terminal) return settled.terminal;
    } catch {
      // Failure to observe a receipt cannot replace the original failed operation.
    }
    throw cause;
  }
}
export async function applyDatabaseGitReclamation(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  raw: GitReclamationAdmission,
  options: ProjectOperationOptions = {}
) {
  const context = structuredClone(expected);
  const input = structuredClone(raw);
  const operationOptions = { signal: options.signal, onWait: options.onWait };
  checkAuthority(handle, context);
  if (!readProjectGitReclamationAdmission(handle, input.admissionOperationId).value)
    await revalidateDatabaseExecutionContext(context, { signal: operationOptions.signal });
  await beginProjectGitReclamation(handle, input, operationOptions);
  return resumeDatabaseGitReclamation(
    handle,
    context,
    input.admissionOperationId,
    operationOptions
  );
}
