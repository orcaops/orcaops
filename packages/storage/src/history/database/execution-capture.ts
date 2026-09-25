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
import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { translateExecutionFailure } from './execution-errors.js';
import {
  prepareExecutionRecords,
  readProjectExecution,
  refuseExecutionInput,
  restoreExecutionRecords,
  settleExecutionRecords,
} from './execution-records.js';
import {
  type PreparedTaskUses,
  preparePlanTaskUses,
  settleProjectTaskUses,
} from './knowledge-task-uses.js';
import { planCaptureCommand, type PreparedPlanCaptureCommand } from './plan-capture-input.js';
import { composePlanCaptureOperation, preparePlanCaptureInsertion } from './plan-capture.js';
import { processingDispatchContext } from './processing-dispatch-context.js';
import { admitProcessingJob, type ProcessingJob } from './processing-jobs.js';
import {
  type ProjectOperationOptions,
  type ProjectOperationResult,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { PROCESSING_ELIGIBLE_EVENT_TYPES } from '../../schema/knowledge-contract.js';

/**
 * What a live capture admits for background processing. It is not part of the
 * capture request: the invocation's no-LLM choice is a runtime fact of the
 * command that settles, not of the retained bytes, and the operation payload
 * that identifies this capture must not move because of it.
 */
export interface CaptureProcessingAdmission {
  processorContract: string;
  /** The invocation's no-LLM choice, retained on every job this capture admits. */
  withoutModel: boolean;
  /**
   * The checkout this capture was made in. Dispatch re-reads the configuration
   * that governs it before any provider is constructed, and pauses the job when
   * it is gone rather than borrowing another worktree's settings, so it is
   * recorded here, where it is known, and nowhere else.
   */
  origin: { worktreeRoot: string };
}

/**
 * A live capture admits nothing without this, so the choice is always the
 * settling caller's and never a default someone forgot to pass.
 */
export interface CaptureOperationOptions extends ProjectOperationOptions {
  processing?: CaptureProcessingAdmission;
  /** Recheck publication gates under the write transaction, after asynchronous preparation. */
  assertPublication?: (view: ProjectReadView) => void;
}

export type ProjectCaptureResult<T> = ProjectOperationResult<T> & {
  /** Jobs admitted in the very transaction that published this capture. */
  admittedProcessingJobs: ProcessingJob[];
};

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
    payload: {
      events: request.manifest,
      execution,
      ...(request.evidence === null ? {} : { evaluator_evidence: request.evidence.digest }),
    },
  };
  return { request, execution, operation, secretAllow: [...input.secretAllow], authored };
}

/**
 * Admit one job per eligible event this capture settles, in the transaction
 * that publishes them. The contract decides what is eligible: an imported
 * artifact's amend, an empty lifecycle event and a source processing derived
 * all reach this and admit nothing.
 */
function admitCapturedSources(
  transaction: ProjectSettlement,
  input: {
    incoming: ReturnType<typeof prepareArtifactAppendRequest>['incoming'];
    artifactId: string;
    operationId: string;
    originKind: 'captured' | 'git-import';
    processing: CaptureProcessingAdmission;
  }
): ProcessingJob[] {
  const settledEventTypes = input.incoming.map(({ event }) => event.record.type);
  const admittedAt = new Date().toISOString();
  const admitted: ProcessingJob[] = [];
  for (const { event } of input.incoming) {
    if (!(PROCESSING_ELIGIBLE_EVENT_TYPES as readonly string[]).includes(event.record.type))
      continue;
    const admission = admitProcessingJob(
      transaction,
      {
        jobId: uuidv7(),
        identity: {
          source: { kind: 'capture_event', event_id: event.record.event_id },
          processor_contract: input.processing.processorContract,
        },
        path: 'live_capture_settlement',
        originKind: input.originKind,
        settledEventTypes,
        derivedByProcessing: false,
        withoutModel: input.processing.withoutModel,
        admittedAt,
        context: processingDispatchContext({
          artifactId: input.artifactId,
          worktreeRoot: input.processing.origin.worktreeRoot,
        }),
      },
      input.operationId
    );
    if (admission.outcome === 'admitted') admitted.push(admission.job);
  }
  return admitted;
}

export async function prepareExecutionCaptureSettlement(
  handle: ProjectDatabase,
  input: ReturnType<typeof prepareExecutionCaptureRequest>,
  processing?: CaptureProcessingAdmission
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
  // Filled inside the settlement and read only after it commits, so a rolled-back
  // attempt reports nothing admitted and neither does a replay, which never settles.
  const admitted: ProcessingJob[] = [];
  return {
    artifactRevision: prepared.revision,
    admitted,
    settle(transaction: ProjectSettlement) {
      admitted.length = 0;
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
      if (processing)
        admitted.push(
          ...admitCapturedSources(transaction, {
            incoming: request.incoming,
            artifactId: request.artifactId,
            operationId: request.operationId,
            originKind: state.origin_kind,
            processing,
          })
        );
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
  options: CaptureOperationOptions = {},
  command?: PreparedPlanCaptureCommand,
  uses?: PreparedTaskUses | null
) {
  const runtime = { signal: options.signal, onWait: options.onWait };
  if (command) {
    const record = planCaptureCommand(command);
    const originalUses = preparePlanTaskUses({
      artifactId: record.artifactId,
      planEventId: record.planEventId,
      uses: record.authored.knowledge_uses,
      secretAllow: input.secretAllow,
    });
    if (
      uses !== undefined &&
      (!isDeepStrictEqual(uses?.uses, originalUses?.uses) ||
        !isDeepStrictEqual(uses?.authoredSha256, originalUses?.authoredSha256))
    )
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'The supplied selection differs from the original plan command'
      );
    uses = originalUses;
  }
  const prepared = prepareExecutionCaptureRequest(handle, input);
  const plan = command
    ? preparePlanCaptureInsertion(command, prepared, prepared.request.operationId)
    : null;
  // What the plan event selected is part of what this operation is, so a retry of the same
  // operation with a different selection conflicts instead of replaying as though it matched.
  const operation = plan
    ? composePlanCaptureOperation(prepared, plan, uses?.authoredSha256 ?? [])
    : uses
      ? {
          ...prepared.operation,
          payload: { ...prepared.operation.payload, knowledge_uses: [...uses.authoredSha256] },
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
    return {
      ...(await runProjectOperation(
        handle,
        operation,
        () => {
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'The retained capture operation disappeared; preserve history for explicit repair'
          );
        },
        runtime
      )),
      admittedProcessingJobs: [],
    };
  for (let attempt = 0; ; attempt++) {
    const settlement = await prepareExecutionCaptureSettlement(
      handle,
      prepared,
      options.processing
    );
    try {
      const result = await runProjectOperation(
        handle,
        operation,
        (transaction, settling) => {
          options.assertPublication?.(transaction);
          plan?.settle(transaction);
          const artifact = settlement.settle(transaction);
          // After the events, never before: a use is keyed to a retained plan event, and its
          // selection is derived from the operation that wrote that event's artifact revision.
          if (uses) settleProjectTaskUses(transaction, settling, uses, null);
          return artifact;
        },
        runtime
      );
      return { ...result, admittedProcessingJobs: [...settlement.admitted] };
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
    /** The uses the plan selected, settled in this same operation so the store derives them. */
    uses?: PreparedTaskUses | null;
  },
  options: CaptureOperationOptions = {}
) {
  try {
    return await appendExecutionCapture(handle, input.capture, options, input.command, input.uses);
  } catch (cause) {
    throw translateExecutionFailure(cause);
  }
}

export async function appendProjectExecutionCapture(
  handle: ProjectDatabase,
  input: AppendProjectArtifactEvents & { execution: CaptureExecutionContext },
  options: CaptureOperationOptions = {},
  /** The uses a plan revision among these events selected, settled in this same operation. */
  uses?: PreparedTaskUses | null
) {
  try {
    return await appendExecutionCapture(handle, input, options, undefined, uses ?? null);
  } catch (cause) {
    throw translateExecutionFailure(cause);
  }
}
