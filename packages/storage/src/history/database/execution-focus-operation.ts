import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7, UuidV7Schema } from '../../ids/uuidv7.js';
import { CounterSchema, digest, DigestSchema } from '../event-integrity.js';
import { type ArtifactRevision, copyArtifactRevision } from './artifacts.js';
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeRetainedFocusPin,
  type ProjectFocusScope,
  projectFocusScopeJson,
} from './execution-focus-input.js';
import { prepareProjectFocusRead } from './execution-focus.js';

const positive = CounterSchema.refine((value) => value > 0);
const selection = z.strictObject({ operationId: UuidV7Schema, version: positive });
const expectedSchema = z.strictObject({
  selection: selection.nullable(),
  target: z
    .strictObject({
      artifactId: UuidV7Schema,
      revision: z.custom<ArtifactRevision>().transform(copyArtifactRevision),
      executionVersion: positive,
      bindingGeneration: CounterSchema,
    })
    .nullable(),
});
const payloadSchema = z.strictObject({
  action: z.enum(['set', 'clear']),
  pinHash: DigestSchema.nullable(),
});
const resultSchema = z.strictObject({ status: z.enum(['present', 'cleared']), selection });
function integrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Original focus record or receipt is missing or inconsistent; preserve original focus for explicit repair',
    { cause }
  );
}
export function readProjectExecutionFocusOperation(handle: ProjectDatabase, operationId: string) {
  if (!isUuidV7(operationId))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide the original focus operation UUID');
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => ({
    receipt: view.get<{
      operation_kind: string;
      intent_change: number;
      target_json: string;
      payload_json: string;
      payload_hash: string;
      expected_state_json: string;
      result_json: string;
      committed_write_sequence: number;
      committed_intent_counter: number;
    }>('SELECT * FROM operations WHERE operation_id=?', operationId),
    record: view.get<{
      scopeJson: string;
      cleared: number;
      pinBytes: string;
      pinHash: string | null;
    }>(
      'SELECT scope_json AS scopeJson,pin_bytes IS NULL AS cleared,hex(pin_bytes) AS pinBytes,pin_hash AS pinHash FROM execution_focus_records WHERE operation_id=?',
      operationId
    ),
  }));
  const { receipt, record } = snapshot.value;
  if (!receipt) {
    if (record) integrity();
    return null;
  }
  if (receipt.operation_kind !== 'execution.focus') {
    if (record) integrity();
    return null;
  }
  if (!record) integrity();
  try {
    const scope = JSON.parse(record.scopeJson) as ProjectFocusScope;
    if (projectFocusScopeJson(scope) !== record.scopeJson) integrity();
    prepareProjectFocusRead(handle, scope);
    const payload = payloadSchema.parse(JSON.parse(receipt.payload_json));
    const expected = expectedSchema.parse(JSON.parse(receipt.expected_state_json));
    const result = resultSchema.parse(JSON.parse(receipt.result_json));
    if (
      receipt.intent_change !== 0 ||
      receipt.target_json !== canonicalJson({ scopeHash: digest(record.scopeJson) }) ||
      digest(receipt.payload_json) !== receipt.payload_hash ||
      canonicalJson(payload) !== receipt.payload_json ||
      canonicalJson(expected) !== receipt.expected_state_json ||
      canonicalJson(result) !== receipt.result_json ||
      result.selection.operationId !== operationId ||
      result.selection.version !== (expected.selection?.version ?? 0) + 1 ||
      !Number.isSafeInteger(receipt.committed_write_sequence) ||
      receipt.committed_write_sequence < 1 ||
      receipt.committed_write_sequence > snapshot.counters.writeSequence ||
      !Number.isSafeInteger(receipt.committed_intent_counter) ||
      receipt.committed_intent_counter < 0 ||
      receipt.committed_intent_counter > snapshot.counters.intentChangeCounter
    )
      integrity();
    const common = { operationId, scope, expectedSelection: expected.selection };
    const counters = {
      writeSequence: receipt.committed_write_sequence,
      intentChangeCounter: receipt.committed_intent_counter,
    };
    if (record.cleared === 1) {
      if (
        payload.action !== 'clear' ||
        payload.pinHash !== null ||
        record.pinHash !== null ||
        expected.target !== null ||
        result.status !== 'cleared'
      )
        integrity();
      return { input: { ...common, action: 'clear' as const }, result, counters };
    }
    if (
      record.cleared !== 0 ||
      payload.action !== 'set' ||
      payload.pinHash !== record.pinHash ||
      record.pinHash === null ||
      expected.target === null ||
      result.status !== 'present'
    )
      integrity();
    const pinBytes = Buffer.from(record.pinBytes, 'hex');
    const pin = decodeRetainedFocusPin(record.scopeJson, pinBytes, record.pinHash);
    if (
      pin.artifact_id !== expected.target.artifactId ||
      pin.binding_generation !== expected.target.bindingGeneration
    )
      integrity();
    return {
      input: {
        ...common,
        action: 'set' as const,
        pinBytes,
        expectedArtifactRevision: expected.target.revision,
        expectedExecutionVersion: expected.target.executionVersion,
      },
      result,
      counters,
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'HISTORY_INTEGRITY_REQUIRED')
      throw cause;
    integrity(cause);
  }
}
