import { isDeepStrictEqual } from 'node:util';

import { isUuidV7, uuidv7 } from '@orcaops/storage';
import {
  beginProjectCaptureRetention,
  beginProjectImportedArtifactRetention,
  type CaptureOperationOptions,
  gitRetentionPreparation,
  type PendingCaptureInput,
  type PreparedProjectGitRetention,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  readProjectGitRetention,
  readProjectPendingCapture,
  settleProjectCaptureRetention,
  settleProjectImportedArtifactRetention,
} from '@orcaops/storage/history/database';

import {
  type RegisteredDatabaseContext,
  revalidateDatabaseExecutionContext,
} from '../context/execution.js';
import { publishDatabaseGitRef } from '../retention/publication.js';

function checkAuthority(handle: ProjectDatabase, context: RegisteredDatabaseContext) {
  handle.read(() => null);
  if (!isDeepStrictEqual(handle.authority, context.authority))
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Use the original registered project database; do not retarget this capture'
    );
}
function originalCapture(handle: ProjectDatabase, operationId: string) {
  const records = readProjectGitRetention(handle, operationId).value;
  if (!records || records.input.target.kind !== 'capture')
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The original capture retention is missing; preserve refs and use explicit history repair'
    );
  return records;
}
function replayCapture(
  handle: ProjectDatabase,
  operationId: string,
  options: CaptureOperationOptions,
  mode: 'capture' | 'import'
) {
  const records = originalCapture(handle, operationId);
  const selected = records.transitions.find((transition) => transition.kind === 'selected');
  if (!selected) return null;
  const settle =
    mode === 'import' ? settleProjectImportedArtifactRetention : settleProjectCaptureRetention;
  return settle(
    handle,
    {
      originalOperationId: operationId,
      expectedTransitionId: records.input.preparedTransitionId,
      selectedTransitionId: selected.transitionId,
    },
    options
  );
}
function resumeRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  originalOperationId: string,
  options: CaptureOperationOptions,
  mode: 'capture'
): ReturnType<typeof settleProjectCaptureRetention>;
function resumeRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  originalOperationId: string,
  options: CaptureOperationOptions,
  mode: 'import'
): ReturnType<typeof settleProjectImportedArtifactRetention>;
function resumeRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  originalOperationId: string,
  options: CaptureOperationOptions,
  mode: 'capture' | 'import'
):
  | ReturnType<typeof settleProjectCaptureRetention>
  | ReturnType<typeof settleProjectImportedArtifactRetention>;
async function resumeRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  originalOperationId: string,
  options: CaptureOperationOptions,
  mode: 'capture' | 'import'
) {
  if (!isUuidV7(originalOperationId))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact original capture operation UUID'
    );
  const context = structuredClone(expected);
  const operationOptions = {
    signal: options.signal,
    onWait: options.onWait,
    processing: options.processing,
  };
  checkAuthority(handle, context);
  const replay = replayCapture(handle, originalOperationId, operationOptions, mode);
  if (replay) return replay;
  const original = readProjectPendingCapture(handle, originalOperationId).value;
  if (!original)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The exact original pending capture input is missing; preserve refs and use explicit repair rather than synthesizing a request'
    );
  if (original.mode !== mode)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      `Original pending operation is not a ${mode} retention request`
    );
  if (original.retention.current.kind !== 'prepared')
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'This capture was retired; retain its original history and start an explicitly new logical operation'
    );
  const current = await revalidateDatabaseExecutionContext(context, {
    signal: operationOptions.signal,
  });
  if (!isDeepStrictEqual(original.capture.execution.context, current.binding))
    throw new ProjectDatabaseError(
      'EXECUTION_CONTEXT_CHANGED',
      'Return to the original capture execution context or start an explicitly new operation; do not retarget retained input'
    );
  for (const publication of original.retention.input.publications)
    await publishDatabaseGitRef(
      current,
      {
        fullRef: publication.fullRef,
        objectOid: publication.objectOid,
        treeOid: publication.treeOid,
        objectFormat: original.retention.input.objectFormat,
      },
      operationOptions
    );
  await revalidateDatabaseExecutionContext(current, { signal: operationOptions.signal });
  const committedMeanwhile = replayCapture(handle, originalOperationId, operationOptions, mode);
  if (committedMeanwhile) return committedMeanwhile;
  try {
    const settle =
      mode === 'import' ? settleProjectImportedArtifactRetention : settleProjectCaptureRetention;
    return await settle(
      handle,
      {
        originalOperationId,
        expectedTransitionId: original.retention.input.preparedTransitionId,
        selectedTransitionId: uuidv7(),
      },
      operationOptions
    );
  } catch (cause) {
    if (
      cause instanceof ProjectDatabaseError &&
      ['IDEMPOTENCY_CONFLICT', 'STALE_CONTEXT'].includes(cause.code)
    ) {
      const committed = replayCapture(handle, originalOperationId, operationOptions, mode);
      if (committed) return committed;
    }
    throw cause;
  }
}

export function resumeDatabaseCaptureRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  originalOperationId: string,
  options: CaptureOperationOptions = {}
) {
  return resumeRetention(handle, expected, originalOperationId, options, 'capture');
}

export function resumeDatabaseImportedArtifactRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  originalOperationId: string,
  options: ProjectOperationOptions = {}
) {
  return resumeRetention(handle, expected, originalOperationId, options, 'import');
}

function publishRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  input: { capture: PendingCaptureInput; retention: PreparedProjectGitRetention },
  options: CaptureOperationOptions,
  mode: 'capture'
): ReturnType<typeof settleProjectCaptureRetention>;
function publishRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  input: { capture: PendingCaptureInput; retention: PreparedProjectGitRetention },
  options: CaptureOperationOptions,
  mode: 'import'
): ReturnType<typeof settleProjectImportedArtifactRetention>;
function publishRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  input: { capture: PendingCaptureInput; retention: PreparedProjectGitRetention },
  options: CaptureOperationOptions,
  mode: 'capture' | 'import'
):
  | ReturnType<typeof settleProjectCaptureRetention>
  | ReturnType<typeof settleProjectImportedArtifactRetention>;
async function publishRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  input: { capture: PendingCaptureInput; retention: PreparedProjectGitRetention },
  options: CaptureOperationOptions,
  mode: 'capture' | 'import'
) {
  const context = structuredClone(expected);
  const capture = structuredClone(input.capture);
  const retention = input.retention;
  const operationId = gitRetentionPreparation(retention).operationId;
  const operationOptions = {
    signal: options.signal,
    onWait: options.onWait,
    processing: options.processing,
  };
  checkAuthority(handle, context);
  if (!readProjectGitRetention(handle, operationId).value) {
    const current = await revalidateDatabaseExecutionContext(context, {
      signal: operationOptions.signal,
    });
    if (!isDeepStrictEqual(capture.execution.context, current.binding))
      throw new ProjectDatabaseError(
        'EXECUTION_CONTEXT_CHANGED',
        'Prepare the capture against the actual registered execution context before admission'
      );
  }
  const begin =
    mode === 'import' ? beginProjectImportedArtifactRetention : beginProjectCaptureRetention;
  await begin(handle, { capture, retention }, operationOptions);
  return resumeRetention(handle, context, operationId, operationOptions, mode);
}

export function publishDatabaseCaptureRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  input: { capture: PendingCaptureInput; retention: PreparedProjectGitRetention },
  options: CaptureOperationOptions = {}
) {
  return publishRetention(handle, expected, input, options, 'capture');
}

export function publishDatabaseImportedArtifactRetention(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  input: { capture: PendingCaptureInput; retention: PreparedProjectGitRetention },
  options: ProjectOperationOptions = {}
) {
  return publishRetention(handle, expected, input, options, 'import');
}
