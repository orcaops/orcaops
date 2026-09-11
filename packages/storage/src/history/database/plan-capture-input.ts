import { z } from 'zod';

import { UuidV7Schema } from '../../ids/uuidv7.js';
import { type CapturePlanInput, CapturePlanInputSchema } from '../../schema/capture-input.js';
import { type SourcePlanPin, SourcePlanPinSchema } from '../../schema/source-plan.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';
import { digest } from '../event-integrity.js';
import { captureKey } from './capture-records.js';
import { ProjectDatabaseError } from './errors.js';
import { copyDatabaseValue, serializeDatabaseValue } from './values.js';

export interface PlanCaptureAuthoredInput {
  readonly authored: CapturePlanInput;
  readonly sourcePlan: SourcePlanPin | null;
}
export interface PreparedPlanCaptureInput {
  readonly kind: 'prepared-plan-capture-input';
}
export interface PlanCaptureInputData extends PlanCaptureAuthoredInput {
  readonly idempotencyKey: string;
  readonly requestBytes: string;
  readonly requestHash: string;
}
const preparations = new WeakMap<PreparedPlanCaptureInput, PlanCaptureInputData>();
const requestSchema = z.strictObject({
  authored: CapturePlanInputSchema,
  sourcePlan: SourcePlanPinSchema.nullable(),
});
function rememberInput(input: PlanCaptureAuthoredInput): PreparedPlanCaptureInput {
  const requestBytes = serializeDatabaseValue(input);
  const prepared = Object.freeze({ kind: 'prepared-plan-capture-input' as const });
  preparations.set(
    prepared,
    immutable({
      ...input,
      idempotencyKey: input.authored.idempotency_key,
      requestBytes,
      requestHash: digest(Buffer.from(requestBytes)),
    })
  );
  return prepared;
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export function preparePlanCaptureInput(
  input: PlanCaptureAuthoredInput,
  secretAllow: readonly string[]
): PreparedPlanCaptureInput {
  try {
    assertNoSecretsInPayload(input, secretAllow);
  } catch (cause) {
    if (!(cause instanceof SecretInPayloadError)) throw cause;
    throw new ProjectDatabaseError(
      'SECRET_IN_PAYLOAD',
      'Remove or redescribe refused authored content before preparing the plan capture',
      { cause }
    );
  }
  const original = copyDatabaseValue(input);
  captureKey(original.authored?.idempotency_key);
  const parsed = requestSchema.safeParse(original);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the validated original plan and source-plan pin',
      {
        cause: parsed.error,
      }
    );
  return rememberInput(parsed.data);
}

export function restorePlanCaptureInput(
  requestBytes: string,
  requestHash: string
): PreparedPlanCaptureInput {
  try {
    if (typeof requestBytes !== 'string' || digest(Buffer.from(requestBytes)) !== requestHash)
      throw new Error('Original request checksum differs');
    const value: unknown = JSON.parse(requestBytes);
    const input = requestSchema.parse(value);
    captureKey(input.authored.idempotency_key);
    if (serializeDatabaseValue(input) !== requestBytes)
      throw new Error('Original request representation differs');
    return rememberInput(input);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Original plan input is unavailable or inconsistent; preserve the request for explicit repair',
      { cause }
    );
  }
}

export function planCaptureInput(prepared: PreparedPlanCaptureInput): PlanCaptureInputData {
  const value = preparations.get(prepared);
  if (!value)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Use genuine original plan input preparation');
  return value;
}

export function assertSamePlanCaptureInput(
  prepared: PreparedPlanCaptureInput,
  original: PreparedPlanCaptureInput
): void {
  if (planCaptureInput(prepared).requestBytes !== planCaptureInput(original).requestBytes)
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The original plan key has different authored content or source-plan input; retain its original request or use an explicitly new key'
    );
}

const identitySchema = z.strictObject({
  originalOperationId: UuidV7Schema,
  admissionOperationId: UuidV7Schema,
  artifactId: UuidV7Schema,
  planEventId: UuidV7Schema,
});
export type PlanCaptureCommandIdentity = z.infer<typeof identitySchema>;
export interface PreparedPlanCaptureCommand {
  readonly kind: 'prepared-plan-capture-command';
}
export type PlanCaptureCommandData = PlanCaptureInputData & Readonly<PlanCaptureCommandIdentity>;
const commands = new WeakMap<PreparedPlanCaptureCommand, PlanCaptureCommandData>();

export function preparePlanCaptureCommand(
  input: PreparedPlanCaptureInput,
  identity: PlanCaptureCommandIdentity
): PreparedPlanCaptureCommand {
  const request = planCaptureInput(input);
  const parsed = identitySchema.safeParse(identity);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Retain the original minted plan command identities',
      {
        cause: parsed.error,
      }
    );
  const prepared = Object.freeze({ kind: 'prepared-plan-capture-command' as const });
  commands.set(prepared, immutable({ ...request, ...parsed.data }));
  return prepared;
}

export function planCaptureCommand(prepared: PreparedPlanCaptureCommand): PlanCaptureCommandData {
  const value = commands.get(prepared);
  if (!value)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Use genuine fixed plan command preparation');
  return value;
}
