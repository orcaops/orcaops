import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { copyArtifactRevision, readProjectArtifact } from './artifacts.js';
import { captureIntegrity } from './capture-records.js';
import type { ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type CaptureExecutionContext,
  restoreExecutionCaptureRequest,
} from './execution-capture.js';
import {
  planCaptureCommand,
  type PreparedPlanCaptureCommand,
  restorePlanCaptureInput,
} from './plan-capture-input.js';
import { preparePlanCaptureInsertion, readProjectPlanCapture } from './plan-capture.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resultSchema = z.strictObject({
  artifactId: UuidV7Schema,
  revision: z.strictObject({
    generation: counter.refine((n) => n > 0),
    eventCount: counter.refine((n) => n > 0),
    byteLength: counter.refine((n) => n > 0),
    orderedHash: z.string().regex(/^[0-9a-f]{64}$/),
    tailEventId: UuidV7Schema,
  }),
  eventIds: z.array(UuidV7Schema).min(1),
  executionVersion: counter.refine((n) => n > 0),
  bindingGeneration: counter,
});

export async function replayProjectPlanCapture(
  handle: ProjectDatabase,
  input: PreparedPlanCaptureCommand,
  options: ProjectOperationOptions = {}
) {
  const record = planCaptureCommand(input);
  if (record.admissionOperationId !== record.originalOperationId)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Resume the original pending capture operation through its retained publication path'
    );
  const lookup = readProjectPlanCapture(
    handle,
    restorePlanCaptureInput(record.requestBytes, record.requestHash)
  );
  if (lookup?.kind !== 'command' || !isDeepStrictEqual(planCaptureCommand(lookup.command), record))
    captureIntegrity('The expected original direct command ownership is unavailable');
  const receipt = handle.read((view) =>
    view.get<{ kind: string; payload: string; result: string }>(
      'SELECT operation_kind AS kind, payload_json AS payload, result_json AS result FROM operations WHERE operation_id=?',
      record.originalOperationId
    )
  ).value;
  if (!receipt)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The original direct plan receipt is missing; preserve its command and history for explicit repair'
    );
  let result: z.infer<typeof resultSchema>;
  let execution: CaptureExecutionContext;
  try {
    if (receipt.kind !== 'plan.capture.append') throw new Error('Wrong original operation kind');
    result = resultSchema.parse(JSON.parse(receipt.result));
    if (
      result.artifactId !== record.artifactId ||
      result.eventIds[0] !== record.planEventId ||
      result.revision.generation !== 1 ||
      result.revision.eventCount !== result.eventIds.length
    )
      throw new Error('Original result identifies different plan publication');
    execution = (JSON.parse(receipt.payload) as { capture: { execution: CaptureExecutionContext } })
      .capture.execution;
  } catch (cause) {
    captureIntegrity('The original direct plan receipt cannot be restored', cause);
  }
  const artifact = readProjectArtifact(
    handle,
    record.artifactId,
    copyArtifactRevision(result.revision)
  );
  if (!artifact)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'Original plan event history is missing; preserve its command and receipt for explicit repair'
    );
  const capture = restoreExecutionCaptureRequest(handle, {
    operationId: record.originalOperationId,
    artifactId: record.artifactId,
    expectedRevision: null,
    eventBytes: artifact.eventBytes,
    sidecarPayloads: artifact.sidecarPayloads,
    secretAllow: [],
    execution,
  });
  if (
    !isDeepStrictEqual(
      capture.request.incoming.map(({ event }) => event.record.event_id),
      result.eventIds
    )
  )
    captureIntegrity('The original direct result event identities differ from retained history');
  const plan = preparePlanCaptureInsertion(input, capture, record.admissionOperationId);
  return runProjectOperation<typeof result>(
    handle,
    {
      ...capture.operation,
      kind: 'plan.capture.append',
      payload: { capture: capture.operation.payload, command: plan.payload },
    },
    () => captureIntegrity('The original direct plan receipt disappeared during replay'),
    options
  );
}
