import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { isSourceTimeSnapshotChanged } from './source-time-records.js';
import {
  assertExecutionMutation,
  type ExecutionBinding,
  ExecutionBindingSchema,
  initializeCapturedExecution,
  prepareExecutionTransition,
  recordExecutionCheckpointOpen,
} from '../execution.js';
import {
  type AppendProjectArtifactEvents,
  prepareArtifactAppend,
  prepareArtifactAppendRequest,
  restoreArtifactAppendRequest,
} from './artifacts.js';
import type { ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { translateExecutionFailure } from './execution-errors.js';
import {
  prepareExecutionRecords,
  readProjectExecution,
  refuseExecutionInput,
  restoreExecutionRecords,
  settleExecutionRecords,
} from './execution-records.js';
import type { PreparedPlanCaptureCommand } from './plan-capture-input.js';
import { preparePlanCaptureInsertion } from './plan-capture.js';
import {
  type ProjectOperationOptions,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';

export type CaptureExecutionContext =
  | { kind: 'create'; context: ExecutionBinding; ts: string }
  | {
      kind: 'task' | 'summary_amendment' | 'historical_maintenance';
      context: ExecutionBinding;
      expectedVersion: number;
      expectedGeneration: number;
      explicitTarget: boolean;
    };
const contextSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    context: ExecutionBindingSchema,
    ts: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.enum(['task', 'summary_amendment', 'historical_maintenance']),
    context: ExecutionBindingSchema,
    expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    explicitTarget: z.boolean(),
  }),
]);

export function prepareExecutionCaptureRequest(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents & { execution: CaptureExecutionContext }
) {
  return captureRequest(handle, input, true);
}

export function restoreExecutionCaptureRequest(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents & { execution: CaptureExecutionContext }
) {
  return captureRequest(handle, input, false);
}

function captureRequest(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents & { execution: CaptureExecutionContext },
  authored: boolean
) {
  const request = authored
    ? prepareArtifactAppendRequest(input)
    : restoreArtifactAppendRequest(input);
  const parsed = contextSchema.safeParse(input.execution);
  if (!parsed.success)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide the exact capture execution context', {
      cause: parsed.error,
    });
  const execution = parsed.data;
  if (authored) refuseExecutionInput(execution, input.secretAllow);
  if (
    execution.context.repository_instance_id !== handle.authority.repositoryInstanceId ||
    (execution.kind === 'create') !== (request.expected === null)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Capture context must identify this repository and the intended existing or new artifact'
    );
  const operation = {
    ...request.operation,
    kind: 'capture.append',
    payload: { events: request.operation.payload, execution },
  };
  return { request, execution, operation, secretAllow: [...input.secretAllow], authored };
}

export async function prepareExecutionCaptureSettlement(
  handle: ProjectDatabase,
  input: ReturnType<typeof prepareExecutionCaptureRequest>
) {
  const { request, execution } = input;
  const prepared = await prepareArtifactAppend(handle, request);
  const previous = readProjectExecution(handle, request.artifactId);
  if (execution.kind !== 'create' && previous === null)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The expected execution history is unavailable; preserve the artifact for explicit repair'
    );
  if (
    execution.kind === 'create'
      ? previous !== null
      : previous?.version !== execution.expectedVersion
  )
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Execution changed after capture preparation; retain the target and prepare an explicitly new operation'
    );
  if (
    execution.kind === 'create' &&
    (prepared.thread.plan?.origin?.kind === 'git-import' ||
      request.incoming[0]?.event.record.type !== 'plan_captured' ||
      request.incoming.some(({ event }) => event.record.type === 'summary_captured'))
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Authored creation requires an active captured plan; historical import uses its own typed admission'
    );
  let state =
    execution.kind === 'create'
      ? initializeCapturedExecution({
          artifactId: request.artifactId,
          operationId: request.operationId,
          context: execution.context,
          ts: execution.ts,
        })
      : previous!.state;
  if (
    previous &&
    (prepared.prior?.thread.plan?.origin?.kind ?? 'captured') !== previous.state.origin_kind
  )
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained plan and execution origins disagree; preserve history for explicit repair'
    );
  if ((prepared.thread.plan?.origin?.kind ?? 'captured') !== state.origin_kind)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'An authored capture cannot change the retained artifact origin; preserve its original creation provenance'
    );
  if (execution.kind !== 'create')
    assertExecutionMutation({
      state,
      expectedGeneration: execution.expectedGeneration,
      context: execution.context,
      operation: execution.kind,
      explicitTarget: execution.explicitTarget,
    });
  for (const { event } of request.incoming) {
    if (event.record.type === 'checkpoint_opened')
      state = recordExecutionCheckpointOpen({
        state,
        checkpointEventId: event.record.event_id,
        expectedGeneration: state.binding_generation,
        context: execution.context,
      });
  }
  const completion = request.incoming.find(({ event }) => event.record.type === 'summary_captured');
  if (completion && state.lifecycle !== 'completed')
    state = prepareExecutionTransition({
      state,
      operationId: request.operationId,
      expectedGeneration: state.binding_generation,
      expectedBinding: state.current_binding,
      action: 'completed',
      openCheckpointIds:
        prepared.prior?.thread.checkpoints
          .filter((checkpoint) => checkpoint.status === 'open')
          .map((checkpoint) => checkpoint.source_event_id) ?? [],
      ts: completion.event.record.ts,
    }).executionState;
  const records =
    previous && isDeepStrictEqual(previous.state, state)
      ? null
      : (input.authored ? prepareExecutionRecords : restoreExecutionRecords)({
          state,
          previous,
          artifactRevision: prepared.revision,
          operationId: request.operationId,
          secretAllow: [...input.secretAllow],
        });
  return {
    artifactRevision: prepared.revision,
    settle(transaction: ProjectSettlement) {
      const current = transaction.get<{ version: number }>(
        'SELECT version FROM execution_current WHERE artifact_id = ?',
        request.artifactId
      );
      if ((current?.version ?? null) !== (previous?.version ?? null))
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'Execution advanced after capture preparation; prepare an explicitly new operation against the intended artifact'
        );
      const artifact = prepared.settle(transaction);
      if (records) settleExecutionRecords(transaction, records);
      return {
        ...artifact,
        revision: { ...artifact.revision },
        executionVersion: (previous?.version ?? 0) + (records ? 1 : 0),
        bindingGeneration: state.binding_generation,
      };
    },
  };
}

async function appendExecutionCapture(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents & { execution: CaptureExecutionContext },
  options: ProjectOperationOptions = {},
  command?: PreparedPlanCaptureCommand
) {
  const runtime = { signal: options.signal, onWait: options.onWait };
  const prepared = prepareExecutionCaptureRequest(handle, input);
  const plan = command
    ? preparePlanCaptureInsertion(command, prepared, prepared.request.operationId)
    : null;
  const operation = plan
    ? {
        ...prepared.operation,
        kind: 'plan.capture.append',
        payload: { capture: prepared.operation.payload, command: plan.payload },
      }
    : prepared.operation;
  if (
    handle.read((view) =>
      view.get(
        'SELECT operation_id FROM operations WHERE operation_id = ?',
        prepared.request.operationId
      )
    ).value
  )
    return runProjectOperation(
      handle,
      operation,
      () => {
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The retained capture operation disappeared; preserve history for explicit repair'
        );
      },
      runtime
    );
  for (let attempt = 0; ; attempt++) {
    const settlement = await prepareExecutionCaptureSettlement(handle, prepared);
    try {
      return await runProjectOperation(
        handle,
        operation,
        (transaction) => {
          plan?.settle(transaction);
          return settlement.settle(transaction);
        },
        runtime
      );
    } catch (error) {
      if (attempt !== 0 || !isSourceTimeSnapshotChanged(error)) throw error;
    }
  }
}

export async function appendProjectPlanCapture(
  handle: ProjectDatabase,
  input: {
    capture: AppendProjectArtifactEvents & { execution: CaptureExecutionContext };
    command: PreparedPlanCaptureCommand;
  },
  options: ProjectOperationOptions = {}
) {
  try {
    return await appendExecutionCapture(handle, input.capture, options, input.command);
  } catch (cause) {
    throw translateExecutionFailure(cause);
  }
}

export async function appendProjectExecutionCapture(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents & { execution: CaptureExecutionContext },
  options: ProjectOperationOptions = {}
) {
  try {
    return await appendExecutionCapture(handle, input, options);
  } catch (cause) {
    throw translateExecutionFailure(cause);
  }
}
