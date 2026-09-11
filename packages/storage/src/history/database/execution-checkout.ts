import { isDeepStrictEqual } from 'node:util';

import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { prepareExecutionTransition } from '../execution.js';
import { type ArtifactRevision, readProjectArtifact } from './artifacts.js';
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { assertNewCheckoutFocusIdentity } from './execution-checkout-identity.js';
import {
  assertCheckoutPinHash,
  CheckoutExpectedSchema,
  CheckoutPayloadSchema,
  CheckoutResultSchema,
  type ProjectExecutionCheckoutInput,
} from './execution-checkout-input.js';
import { translateExecutionFailure } from './execution-errors.js';
import {
  prepareProjectFocusRead,
  readProjectExecutionFocus,
  selectProjectExecutionFocus,
} from './execution-focus.js';
import {
  hydrateProjectExecutionRecords,
  prepareExecutionRecords,
  readProjectExecution,
  refuseExecutionInput,
  selectProjectExecutionRecords,
  settleExecutionRecords,
} from './execution-records.js';
import {
  type ProjectOperation,
  type ProjectOperationOptions,
  runProjectOperation,
} from './transactions.js';
import { copyDatabaseValue } from './values.js';

export type { ProjectExecutionCheckoutInput } from './execution-checkout-input.js';
export interface PreparedProjectExecutionCheckout {
  readonly kind: 'prepared-execution-checkout';
}
const preparations = new WeakMap<
  PreparedProjectExecutionCheckout,
  {
    request: Omit<ProjectExecutionCheckoutInput, 'secretAllow'>;
    records: ReturnType<typeof prepareExecutionRecords>;
    scopeJson: string;
  }
>();
function integrity(message: string, cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    `${message}; preserve original checkout history for explicit repair`,
    { cause }
  );
}
function operation(request: Omit<ProjectExecutionCheckoutInput, 'secretAllow'>): ProjectOperation {
  return {
    operationId: request.operationId,
    kind: 'execution.checkout',
    target: { artifactId: request.artifactId },
    payload: request.payload,
    expectedState: { ...request.expected, revision: { ...request.expected.revision } },
    intentChange: false,
  };
}
function assertRequestAuthority(
  handle: ProjectDatabase,
  request: Omit<ProjectExecutionCheckoutInput, 'secretAllow'>
): string {
  assertProjectDatabasePath(handle);
  return prepareProjectFocusRead(handle, request.payload.focus.scope);
}
export function prepareProjectExecutionCheckout(
  handle: ProjectDatabase,
  input: ProjectExecutionCheckoutInput
): PreparedProjectExecutionCheckout {
  try {
    const copied = copyDatabaseValue(input);
    if (!isUuidV7(copied.operationId) || !isUuidV7(copied.artifactId))
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Provide exact artifact and original checkout operation UUIDs'
      );
    const request = {
      operationId: copied.operationId,
      artifactId: copied.artifactId,
      payload: CheckoutPayloadSchema.parse(copied.payload),
      expected: CheckoutExpectedSchema.parse(copied.expected),
    };
    refuseExecutionInput(request, copied.secretAllow);
    assertCheckoutPinHash(request);
    const scopeJson = assertRequestAuthority(handle, request);
    handle.read((view) => {
      assertNewCheckoutFocusIdentity(view, request.operationId, request.payload.focus.operationId);
      return null;
    });
    const focus = readProjectExecutionFocus(handle, request.payload.focus.scope);
    if (!isDeepStrictEqual(focus.selection, request.payload.focus.expectedSelection))
      throw new ProjectDatabaseError(
        'STALE_CONTEXT',
        'Focus selection changed before checkout preparation'
      );
    const artifact = readProjectArtifact(handle, request.artifactId, request.expected.revision);
    const previous = readProjectExecution(handle, request.artifactId);
    if (artifact && !previous) integrity('Expected original execution history is missing');
    if (!artifact || previous?.version !== request.expected.version)
      throw new ProjectDatabaseError(
        'STALE_CONTEXT',
        'Original checkout artifact or execution version changed'
      );
    if ((artifact.thread.plan?.origin?.kind ?? 'captured') !== previous.state.origin_kind)
      integrity('Retained plan and execution origins disagree');
    const state = prepareExecutionTransition({
      state: previous.state,
      operationId: request.operationId,
      expectedGeneration: request.expected.generation,
      expectedBinding: request.payload.expectedBinding,
      action: request.payload.action,
      target: request.payload.target,
      reason: request.payload.reason ?? undefined,
      openCheckpointIds: artifact.thread.checkpoints
        .filter((cp) => cp.status === 'open')
        .map((cp) => cp.source_event_id),
      ts: request.payload.ts,
    }).executionState;
    const records = prepareExecutionRecords({
      state,
      previous,
      artifactRevision: request.expected.revision,
      operationId: request.operationId,
      secretAllow: copied.secretAllow,
    });
    const token = Object.freeze({ kind: 'prepared-execution-checkout' as const });
    preparations.set(token, { request, records, scopeJson });
    return token;
  } catch (cause) {
    throw translateExecutionFailure(cause);
  }
}
export function projectExecutionCheckoutRequest(prepared: PreparedProjectExecutionCheckout) {
  const value = preparations.get(prepared);
  if (!value)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Use genuine prepared execution checkout');
  return copyDatabaseValue(value.request);
}
export async function publishProjectExecutionCheckout(
  handle: ProjectDatabase,
  prepared: PreparedProjectExecutionCheckout,
  options: ProjectOperationOptions = {}
) {
  const value = preparations.get(prepared);
  if (!value)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Use genuine prepared execution checkout');
  const { request, records, scopeJson } = value;
  assertRequestAuthority(handle, request);
  const original = readProjectExecutionCheckout(handle, request.operationId);
  if (original) {
    if (!isDeepStrictEqual(original.request, request))
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'Retain the original checkout request unchanged for replay'
      );
    return replayProjectExecutionCheckout(handle, request.operationId, options);
  }
  return runProjectOperation(
    handle,
    operation(request),
    (transaction) => {
      assertNewCheckoutFocusIdentity(
        transaction,
        request.operationId,
        request.payload.focus.operationId
      );
      const selected = selectProjectExecutionFocus(transaction, scopeJson)?.selected;
      const current = selected
        ? { operationId: selected.operationId, version: selected.version }
        : null;
      if (!isDeepStrictEqual(current, request.payload.focus.expectedSelection))
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'Original focus slot changed before binding commit'
        );
      settleExecutionRecords(transaction, records);
      return {
        artifactId: request.artifactId,
        executionVersion: request.expected.version + 1,
        bindingGeneration: request.expected.generation + 1,
        focusOperationId: request.payload.focus.operationId,
      };
    },
    options
  );
}
export function readProjectExecutionCheckout(handle: ProjectDatabase, operationId: string) {
  if (!isUuidV7(operationId))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide the original checkout operation UUID');
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => {
    const receipt = view.get<{
      operation_kind: string;
      intent_change: number;
      target_json: string;
      payload_json: string;
      payload_hash: string;
      expected_state_json: string;
      result_json: string;
      committed_write_sequence: number;
      committed_intent_counter: number;
    }>('SELECT * FROM operations WHERE operation_id=?', operationId);
    if (!receipt) {
      if (
        view.get(
          'SELECT operation_id FROM execution_transitions WHERE publication_operation_id=? LIMIT 1',
          operationId
        )
      )
        integrity('Original checkout transition has lost its receipt');
      return null;
    }
    if (receipt.operation_kind !== 'execution.checkout')
      return { receipt, revision: null, execution: null };
    let artifactId: string;
    let generation: number;
    try {
      artifactId = JSON.parse(receipt.target_json).artifactId;
      generation = CheckoutExpectedSchema.parse(JSON.parse(receipt.expected_state_json)).revision
        .generation;
    } catch (cause) {
      integrity('Original checkout target or expected state is malformed', cause);
    }
    const revision = view.get<ArtifactRevision>(
      `SELECT generation,ordered_hash AS orderedHash,event_count AS eventCount,byte_length AS byteLength,tail_event_id AS tailEventId FROM artifact_revisions WHERE artifact_id=? AND generation=?`,
      artifactId,
      generation
    );
    return {
      receipt,
      revision: revision ?? null,
      execution: selectProjectExecutionRecords(view, artifactId),
    };
  });
  if (!snapshot.value) return null;
  const { receipt, revision, execution } = snapshot.value;
  if (receipt.operation_kind !== 'execution.checkout') return null;
  try {
    const target = JSON.parse(receipt.target_json);
    if (
      !isUuidV7(target.artifactId) ||
      canonicalJson(target) !== canonicalJson({ artifactId: target.artifactId })
    )
      integrity('Original checkout target is invalid');
    const request = {
      operationId,
      artifactId: target.artifactId as string,
      payload: CheckoutPayloadSchema.parse(JSON.parse(receipt.payload_json)),
      expected: CheckoutExpectedSchema.parse(JSON.parse(receipt.expected_state_json)),
    };
    assertRequestAuthority(handle, request);
    const result = CheckoutResultSchema.parse(JSON.parse(receipt.result_json));
    const state = hydrateProjectExecutionRecords(
      request.artifactId,
      execution,
      snapshot.counters
    )?.state;
    const transition = state?.binding_history.find((row) => row.operation_id === operationId);
    if (
      receipt.intent_change !== 0 ||
      digest(receipt.payload_json) !== receipt.payload_hash ||
      canonicalJson(request.payload) !== receipt.payload_json ||
      canonicalJson(request.expected) !== receipt.expected_state_json ||
      canonicalJson(result) !== receipt.result_json ||
      request.operationId === request.payload.focus.operationId ||
      !Number.isSafeInteger(receipt.committed_write_sequence) ||
      receipt.committed_write_sequence < 1 ||
      receipt.committed_write_sequence > snapshot.counters.writeSequence ||
      !Number.isSafeInteger(receipt.committed_intent_counter) ||
      receipt.committed_intent_counter < 0 ||
      receipt.committed_intent_counter > snapshot.counters.intentChangeCounter ||
      !isDeepStrictEqual(revision, request.expected.revision) ||
      !isDeepStrictEqual(result, {
        artifactId: request.artifactId,
        executionVersion: request.expected.version + 1,
        bindingGeneration: request.expected.generation + 1,
        focusOperationId: request.payload.focus.operationId,
      }) ||
      !transition ||
      transition.action !== request.payload.action ||
      transition.generation !== result.bindingGeneration ||
      transition.prior_generation !== request.expected.generation ||
      transition.ts !== request.payload.ts ||
      transition.reason !== (request.payload.reason?.trim() || null) ||
      !isDeepStrictEqual(transition.prior_binding, request.payload.expectedBinding) ||
      !isDeepStrictEqual(transition.binding, request.payload.target)
    )
      integrity('Original checkout receipt, revision or transition differs');
    prepareExecutionTransition({
      state: state!,
      operationId,
      expectedGeneration: request.expected.generation,
      expectedBinding: request.payload.expectedBinding,
      action: request.payload.action,
      target: request.payload.target,
      reason: request.payload.reason ?? undefined,
      openCheckpointIds: transition.checkpoint_ids,
      ts: request.payload.ts,
    });
    assertCheckoutPinHash(request);
    return {
      request,
      result,
      counters: {
        writeSequence: receipt.committed_write_sequence,
        intentChangeCounter: receipt.committed_intent_counter,
      },
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'HISTORY_INTEGRITY_REQUIRED')
      throw cause;
    integrity('Original checkout receipt cannot be validated', cause);
  }
}
export async function replayProjectExecutionCheckout(
  handle: ProjectDatabase,
  operationId: string,
  options: ProjectOperationOptions = {}
) {
  const original = readProjectExecutionCheckout(handle, operationId);
  if (!original)
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'No original checkout receipt exists for this retry identity'
    );
  return runProjectOperation<typeof original.result>(
    handle,
    operation(original.request),
    () => integrity('Original checkout receipt disappeared'),
    options
  );
}
