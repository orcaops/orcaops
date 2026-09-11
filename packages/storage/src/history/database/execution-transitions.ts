import { z } from 'zod';

import { isUuidV7 } from '../../ids/uuidv7.js';
import { ExecutionBindingSchema, prepareExecutionTransition } from '../execution.js';
import { type ArtifactRevision, copyArtifactRevision, readProjectArtifact } from './artifacts.js';
import type { ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { translateExecutionFailure } from './execution-errors.js';
import {
  prepareExecutionRecords,
  readProjectExecution,
  refuseExecutionInput,
  settleExecutionRecords,
} from './execution-records.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';

const transitionSchema = z.strictObject({
  action: z.enum(['first_bind', 'handoff', 'context_changed']),
  target: ExecutionBindingSchema,
  expectedBinding: ExecutionBindingSchema.nullable(),
  expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().nullable(),
  ts: z.string().datetime(),
});
export type ProjectExecutionTransition = z.infer<typeof transitionSchema> & {
  operationId: string;
  artifactId: string;
  expectedRevision: ArtifactRevision;
  secretAllow: readonly string[];
};
async function transitionExecution(
  handle: ProjectDatabase,
  input: ProjectExecutionTransition,
  options: ProjectOperationOptions
) {
  const artifactId = input.artifactId;
  const operationId = input.operationId;
  if (!isUuidV7(artifactId) || !isUuidV7(operationId))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact artifact and original operation UUIDs'
    );
  const revision = copyArtifactRevision(input.expectedRevision);
  const intent = transitionSchema.parse({
    action: input.action,
    target: input.target,
    expectedBinding: input.expectedBinding,
    expectedGeneration: input.expectedGeneration,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
    ts: input.ts,
  });
  refuseExecutionInput(intent, input.secretAllow);
  if (intent.target.repository_instance_id !== handle.authority.repositoryInstanceId)
    throw new ProjectDatabaseError(
      'IDENTITY_CONFLICT',
      'Select a worktree registered to this project repository instance'
    );
  const operation = {
    operationId,
    kind: 'execution.transition',
    target: { artifactId },
    payload: {
      action: intent.action,
      target: intent.target,
      expectedBinding: intent.expectedBinding,
      reason: intent.reason,
      ts: intent.ts,
    },
    expectedState: {
      revision: { ...revision },
      version: intent.expectedVersion,
      generation: intent.expectedGeneration,
    },
    intentChange: false,
  };
  if (
    handle.read((v) =>
      v.get('SELECT operation_id FROM operations WHERE operation_id=?', operationId)
    ).value
  )
    return runProjectOperation(
      handle,
      operation,
      () => {
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The retained execution operation disappeared; preserve history for explicit repair'
        );
      },
      options
    );
  const artifact = readProjectArtifact(handle, artifactId, revision);
  const previous = readProjectExecution(handle, artifactId);
  if (artifact && previous === null)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The expected execution history is unavailable; preserve the artifact for explicit repair'
    );
  if (!artifact || previous?.version !== intent.expectedVersion)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The intended artifact revision or execution version is unavailable; prepare a new explicit operation'
    );
  if ((artifact.thread.plan?.origin?.kind ?? 'captured') !== previous.state.origin_kind)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained plan and execution origins disagree; preserve history for explicit repair'
    );
  const state = prepareExecutionTransition({
    state: previous.state,
    operationId,
    expectedGeneration: intent.expectedGeneration,
    expectedBinding: intent.expectedBinding,
    action: intent.action,
    target: intent.target,
    reason: intent.reason ?? undefined,
    openCheckpointIds: artifact.thread.checkpoints
      .filter((cp) => cp.status === 'open')
      .map((cp) => cp.source_event_id),
    ts: intent.ts,
  }).executionState;
  const records = prepareExecutionRecords({
    state,
    previous,
    artifactRevision: revision,
    operationId,
    secretAllow: [...input.secretAllow],
  });
  return runProjectOperation(
    handle,
    operation,
    (transaction) => {
      settleExecutionRecords(transaction, records);
      return {
        artifactId,
        executionVersion: previous.version + 1,
        bindingGeneration: state.binding_generation,
      };
    },
    options
  );
}
export async function transitionProjectExecution(
  handle: ProjectDatabase,
  input: ProjectExecutionTransition,
  options: ProjectOperationOptions = {}
) {
  try {
    return await transitionExecution(handle, input, options);
  } catch (cause) {
    throw translateExecutionFailure(cause);
  }
}
