import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { digest, DigestSchema } from '../event-integrity.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeRetainedRemoteRequest,
  normalizeRemoteTransportScope,
  prepareProjectRemoteRequest,
  remoteRequestPreparation,
} from './remote-transport-input.js';

export const ARTIFACT_PUSH_METHODS = [
  'captureThread.start',
  'captureThread.attachPlan',
  'captureThread.attachPlanRevision',
  'captureThread.attachCheckpointOpened',
  'captureThread.attachCheckpoint',
  'captureThread.attachSummary',
  'captureThread.attachEvaluators',
  'captureThread.attachCodingSessionsUsage',
  'sourcePlan.attachPin',
] as const;
const text = z.string().min(1);
const positive = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
const target = z.strictObject({ server_url: text, org_id: text, account_id: text });
const revision = z.strictObject({
  generation: positive,
  orderedHash: DigestSchema,
  eventCount: positive,
  byteLength: positive,
  tailEventId: UuidV7Schema,
});
const selection = z.strictObject({ revisionId: UuidV7Schema, version: positive });
const pushSelection = z.strictObject({ pushId: UuidV7Schema, version: positive });
const session = z.strictObject({
  key: z.strictObject({ target, repoUrl: text, workingDir: text }),
  expectedSelection: selection,
  acknowledgementId: UuidV7Schema,
  resultRevisionId: UuidV7Schema,
});
const call = z.strictObject({
  requestId: UuidV7Schema,
  method: z.enum(ARTIFACT_PUSH_METHODS),
  targetExternalId: text,
  payloadBytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
});
const inputSchema = z.strictObject({
  pushId: UuidV7Schema,
  operationId: UuidV7Schema,
  terminalOperationId: UuidV7Schema,
  artifactId: UuidV7Schema,
  target,
  artifactRevision: revision,
  artifactPayloadHash: DigestSchema,
  usageRevision: revision.nullable(),
  expectedPushSelection: pushSelection.nullable(),
  expectedCloudSelection: selection.nullable(),
  session: session.nullable(),
  cloudAcknowledgementId: UuidV7Schema,
  preparedAt: text.refine((value) => Number.isFinite(Date.parse(value))),
  result: z.strictObject({
    checkpoints: count,
    summary: z.boolean(),
    evaluators: count,
    sourcePlanPinned: z.enum(['A', 'B']).nullable(),
  }),
  calls: z.array(call).min(2),
});
const optionsSchema = z.strictObject({ secretAllow: z.array(z.string()) });
export type ProjectArtifactPushInput = z.infer<typeof inputSchema>;
export type ProjectArtifactPushCallInput = z.infer<typeof call>;
export type ProjectArtifactPushOptions = z.infer<typeof optionsSchema>;
export interface PreparedProjectArtifactPush {
  readonly kind: 'prepared-artifact-push';
}
export interface ArtifactPushCallPreparation extends Omit<
  ProjectArtifactPushCallInput,
  'payloadBytes'
> {
  readonly ordinal: number;
  readonly payloadBase64: string;
  readonly payloadSha256: string;
  readonly requestKey: string;
}
export interface ArtifactPushPreparation extends Omit<ProjectArtifactPushInput, 'calls'> {
  readonly calls: readonly ArtifactPushCallPreparation[];
  readonly requestSha256: string;
}
const preparations = new WeakMap<PreparedProjectArtifactPush, ArtifactPushPreparation>();
function invalid(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'INVALID_INPUT',
    'Provide the original fixed artifact push identities, ordered calls and exact source selections',
    { cause }
  );
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid(result.error);
  return result.data;
}
function copy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    return invalid(cause);
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function callIdentity(
  item: ProjectArtifactPushCallInput,
  payload: unknown,
  artifactId: string,
  ordinal: number
): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) invalid();
  const value = payload as Record<string, unknown>;
  const checkpoint =
    item.method === 'captureThread.attachCheckpoint' ||
    item.method === 'captureThread.attachCheckpointOpened';
  if (
    (ordinal === 1 && item.method !== 'captureThread.start') ||
    (ordinal === 2 &&
      item.method !== 'captureThread.attachPlan' &&
      item.method !== 'captureThread.attachPlanRevision') ||
    (ordinal > 2 &&
      [
        'captureThread.start',
        'captureThread.attachPlan',
        'captureThread.attachPlanRevision',
      ].includes(item.method)) ||
    (item.method === 'captureThread.start' ? value.externalId : value.artifact_id) !== artifactId ||
    (checkpoint && !positive.safeParse(value.n).success) ||
    item.targetExternalId !== (checkpoint ? `${artifactId}:${value.n}` : artifactId)
  )
    invalid();
}
const retainedComparison = z.strictObject({
  requestSha256: DigestSchema,
  calls: z
    .array(
      z.strictObject({
        requestId: UuidV7Schema,
        ordinal: positive,
        payloadSha256: DigestSchema,
        requestKey: text,
      })
    )
    .min(2),
});
export type ArtifactPushRetainedComparison = z.infer<typeof retainedComparison>;
function materializeArtifactPush(
  value: ProjectArtifactPushInput,
  refusal: ProjectArtifactPushOptions | null,
  retained?: ArtifactPushRetainedComparison
): ArtifactPushPreparation {
  const { calls: originalCalls, ...header } = value;
  if (refusal !== null) refuseJsonBytes(Buffer.from(canonicalJson(header)), refusal.secretAllow);
  if (retained && retained.calls.length !== originalCalls.length) invalid();
  if (
    header.operationId === header.terminalOperationId ||
    (header.session !== null &&
      canonicalJson(header.session.key.target) !== canonicalJson(header.target))
  )
    invalid();
  const requestIds = new Set<string>();
  const slots = new Set<string>();
  const calls = originalCalls.map((item, index): ArtifactPushCallPreparation => {
    const slot = canonicalJson([item.method, item.targetExternalId]);
    if (requestIds.has(item.requestId) || slots.has(slot)) invalid();
    requestIds.add(item.requestId);
    slots.add(slot);
    const scope = {
      target: header.target,
      artifactId: header.artifactId,
      method: item.method,
      targetExternalId: item.targetExternalId,
      idempotencyKey: header.pushId,
    };
    if (canonicalJson(normalizeRemoteTransportScope(scope)) !== canonicalJson(scope)) invalid();
    const requestInput = {
      operationId: header.operationId,
      requestId: item.requestId,
      scope,
      expectedSelection: null,
      payloadBytes: item.payloadBytes,
      preparedAt: header.preparedAt,
    };
    const comparison = retained?.calls[index];
    if (
      retained &&
      (!comparison || comparison.requestId !== item.requestId || comparison.ordinal !== index + 1)
    )
      invalid();
    const request =
      refusal === null
        ? decodeRetainedRemoteRequest(requestInput, comparison!)
        : remoteRequestPreparation(prepareProjectRemoteRequest(requestInput, refusal));
    const ordinal = index + 1;
    callIdentity(
      item,
      JSON.parse(Buffer.from(request.payloadBase64, 'base64').toString('utf8')),
      header.artifactId,
      ordinal
    );
    return {
      requestId: item.requestId,
      method: item.method,
      targetExternalId: item.targetExternalId,
      ordinal,
      payloadBase64: request.payloadBase64,
      payloadSha256: request.payloadSha256,
      requestKey: request.requestKey,
    };
  });
  if (
    header.result.summary !== calls.some((item) => item.method === 'captureThread.attachSummary') ||
    (header.result.sourcePlanPinned !== null) !==
      calls.some((item) => item.method === 'sourcePlan.attachPin')
  )
    invalid();
  const requestSha256 = digest(
    canonicalJson({
      ...header,
      calls: calls.map(({ payloadBase64: _, ...item }) => item),
    })
  );
  if (retained && retained.requestSha256 !== requestSha256) invalid();
  return freeze({ ...header, calls, requestSha256 });
}
export function prepareProjectArtifactPush(
  input: ProjectArtifactPushInput,
  options: ProjectArtifactPushOptions
): PreparedProjectArtifactPush {
  const value = parse(inputSchema, copy(input));
  const refusal = parse(optionsSchema, copy(options));
  const materialized = materializeArtifactPush(value, refusal);
  const prepared = Object.freeze({ kind: 'prepared-artifact-push' as const });
  preparations.set(prepared, materialized);
  return prepared;
}
export function decodeRetainedArtifactPush(
  input: ProjectArtifactPushInput,
  comparison: ArtifactPushRetainedComparison
): ArtifactPushPreparation {
  try {
    return materializeArtifactPush(
      parse(inputSchema, copy(input)),
      null,
      parse(retainedComparison, copy(comparison))
    );
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Original grouped push input or comparison fields are missing or inconsistent; preserve the original owner for explicit repair',
      { cause }
    );
  }
}
export function projectArtifactPush(
  prepared: PreparedProjectArtifactPush
): ArtifactPushPreparation {
  const value = preparations.get(prepared);
  if (!value) invalid();
  return value;
}
