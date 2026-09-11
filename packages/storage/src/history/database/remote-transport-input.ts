import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { canonicalizeBaseUrl } from '../../source-plan/canonical-base-url.js';
import { assertNoForbiddenControlChars } from '../../text/control-chars.js';
import { digest, DigestSchema } from '../event-integrity.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';

export const REMOTE_TRANSPORT_METHODS = [
  'captureThread.start',
  'captureThread.attachPlan',
  'captureThread.attachPlanRevision',
  'captureThread.attachCheckpointOpened',
  'captureThread.attachCheckpoint',
  'captureThread.attachSummary',
  'captureThread.attachEvaluators',
  'captureThread.attachCodingSessionsUsage',
  'sourcePlan.attachPin',
  'sourcePlan.create',
  'sourcePlan.reviewPush',
  'sourcePlan.reviewPropose',
  'sourcePlan.reviewComment',
  'sourcePlan.setReviewerVerdict',
  'sourcePlan.declineProposal',
  'review.reply',
  'review.resolve',
] as const;
const Text = z.string().min(1);
const Time = Text.refine((value) => Number.isFinite(Date.parse(value)));
const Version = z.number().int().positive().safe();
const Bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array);
const Target = z.strictObject({ server_url: Text, org_id: Text, account_id: Text });
const Scope = z.strictObject({
  target: Target,
  artifactId: UuidV7Schema.nullable(),
  method: z.enum(REMOTE_TRANSPORT_METHODS),
  targetExternalId: Text,
  idempotencyKey: Text,
});
const Selection = z
  .strictObject({
    version: Version,
    requestId: UuidV7Schema,
    attemptId: UuidV7Schema.nullable(),
    outcomeId: UuidV7Schema.nullable(),
  })
  .refine((value) => value.outcomeId === null || value.attemptId !== null);
const Common = {
  operationId: UuidV7Schema,
  scope: Scope,
  expectedSelection: Selection.nullable(),
};
const Request = z.strictObject({
  ...Common,
  requestId: UuidV7Schema,
  payloadBytes: Bytes,
  preparedAt: Time,
});
const Attempt = z.strictObject({
  ...Common,
  expectedSelection: Selection,
  requestId: UuidV7Schema,
  attemptId: UuidV7Schema,
  attemptedAt: Time,
});
const OutcomeCommon = {
  ...Common,
  expectedSelection: Selection,
  requestId: UuidV7Schema,
  attemptId: UuidV7Schema,
  outcomeId: UuidV7Schema,
  observedAt: Time,
};
const Outcome = z.discriminatedUnion('kind', [
  z.strictObject({
    ...OutcomeCommon,
    kind: z.literal('acknowledged'),
    responseBytes: Bytes,
    failure: z.null(),
  }),
  z.strictObject({
    ...OutcomeCommon,
    kind: z.literal('ack_unknown'),
    responseBytes: z.null(),
    failure: z.strictObject({ kind: z.literal('unknown'), message: z.string() }).nullable(),
  }),
]);
const Options = z.strictObject({ secretAllow: z.array(z.string()) });
export type RemoteTransportScope = z.infer<typeof Scope>;
export type RemoteTransportSelection = z.infer<typeof Selection>;
export type ProjectRemoteRequestInput = z.infer<typeof Request>;
export type ProjectRemoteAttemptInput = z.infer<typeof Attempt>;
export type ProjectRemoteOutcomeInput = z.infer<typeof Outcome>;
export type RemoteTransportOptions = z.infer<typeof Options>;

export interface PreparedProjectRemoteRequest {
  readonly kind: 'prepared-remote-request';
}
export interface PreparedProjectRemoteAttempt {
  readonly kind: 'prepared-remote-attempt';
}
export interface PreparedProjectRemoteOutcome {
  readonly kind: 'prepared-remote-outcome';
}
export interface RemoteRequestPreparation extends Omit<ProjectRemoteRequestInput, 'payloadBytes'> {
  readonly payloadBase64: string;
  readonly payloadSha256: string;
  readonly requestKey: string;
}
export type RemoteAttemptPreparation = ProjectRemoteAttemptInput;
export type RemoteOutcomePreparation = Omit<ProjectRemoteOutcomeInput, 'responseBytes'> & {
  readonly responseBase64: string | null;
  readonly responseSha256: string | null;
};
const requests = new WeakMap<PreparedProjectRemoteRequest, RemoteRequestPreparation>();
const attempts = new WeakMap<PreparedProjectRemoteAttempt, RemoteAttemptPreparation>();
const outcomes = new WeakMap<PreparedProjectRemoteOutcome, RemoteOutcomePreparation>();

function invalid(message: string, cause?: unknown): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message, { cause });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid('Provide complete typed remote identities and values', parsed.error);
  return parsed.data;
}
function detached<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    return invalid('Provide copyable remote input values', cause);
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function normalized(scope: RemoteTransportScope): RemoteTransportScope {
  let url: URL;
  try {
    url = new URL(scope.target.server_url);
  } catch (cause) {
    return invalid('Provide a complete HTTP(S) remote server identity', cause);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalid('Remote server identity must be HTTP(S) without credentials, query or fragment');
  return {
    ...scope,
    target: { ...scope.target, server_url: canonicalizeBaseUrl(scope.target.server_url) },
  };
}
export function normalizeRemoteTransportScope(input: RemoteTransportScope): RemoteTransportScope {
  const value = parse(Scope, detached(input));
  controls(value);
  return freeze(normalized(value));
}
function controls(value: unknown): void {
  try {
    assertNoForbiddenControlChars(value);
  } catch (cause) {
    invalid('Remove forbidden controls without changing the intended remote identity', cause);
  }
}
function authoredMetadata(value: unknown, allow: readonly string[]): void {
  controls(value);
  refuseJsonBytes(Buffer.from(canonicalJson(value)), allow);
}
function jsonBytes(
  input: Uint8Array,
  allow: readonly string[] | null
): {
  bytes: Buffer;
  value: unknown;
} {
  const bytes = Buffer.from(input);
  if (allow !== null) refuseJsonBytes(bytes, allow);
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    canonicalJson(value);
  } catch (cause) {
    return invalid('Provide complete finite UTF-8 JSON remote bytes', cause);
  }
  if (allow !== null) {
    controls(text);
    controls(value);
    // An overwritten JSON key still belongs to the exact retained request bytes.
    for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) controls(JSON.parse(match[0]));
  }
  return { bytes, value };
}
function requireRequest(selection: RemoteTransportSelection, requestId: string): void {
  if (selection.requestId !== requestId)
    invalid('The remote selection must name the same original request');
}
function requestValue(
  input: ProjectRemoteRequestInput,
  allow: readonly string[] | null
): RemoteRequestPreparation {
  const { payloadBytes, ...metadata } = parse(Request, detached(input));
  if (allow !== null) authoredMetadata(metadata, allow);
  const scope = normalized(metadata.scope);
  const { bytes, value } = jsonBytes(payloadBytes, allow);
  return freeze({
    ...metadata,
    scope,
    payloadBase64: bytes.toString('base64'),
    payloadSha256: digest(bytes),
    requestKey: `operation:${digest(
      canonicalJson([
        scope.method,
        scope.targetExternalId,
        scope.idempotencyKey,
        digest(canonicalJson(value)),
      ])
    )}`,
  });
}
function attemptValue(
  input: ProjectRemoteAttemptInput,
  allow: readonly string[] | null
): RemoteAttemptPreparation {
  const value = parse(Attempt, detached(input));
  if (allow !== null) authoredMetadata(value, allow);
  requireRequest(value.expectedSelection, value.requestId);
  if (value.expectedSelection.attemptId !== null || value.expectedSelection.outcomeId !== null)
    invalid(
      'This remote request already has a retained attempt and cannot be admitted or sent again'
    );
  return freeze({ ...value, scope: normalized(value.scope) });
}
function outcomeValue(
  input: ProjectRemoteOutcomeInput,
  allow: readonly string[] | null
): RemoteOutcomePreparation {
  const { responseBytes, ...value } = parse(Outcome, detached(input));
  if (allow !== null) authoredMetadata(value, allow);
  requireRequest(value.expectedSelection, value.requestId);
  if (value.expectedSelection.attemptId !== value.attemptId)
    invalid('The remote outcome must name the exact admitted attempt');
  const response = responseBytes === null ? null : jsonBytes(responseBytes, allow);
  return freeze({
    ...value,
    scope: normalized(value.scope),
    responseBase64: response?.bytes.toString('base64') ?? null,
    responseSha256: response ? digest(response.bytes) : null,
  });
}
export function prepareProjectRemoteRequest(
  input: ProjectRemoteRequestInput,
  options: RemoteTransportOptions
): PreparedProjectRemoteRequest {
  const allow = parse(Options, detached(options)).secretAllow;
  const value = requestValue(input, allow);
  const prepared = Object.freeze({ kind: 'prepared-remote-request' as const });
  requests.set(prepared, value);
  return prepared;
}
export function prepareProjectRemoteAttempt(
  input: ProjectRemoteAttemptInput,
  options: RemoteTransportOptions
): PreparedProjectRemoteAttempt {
  const allow = parse(Options, detached(options)).secretAllow;
  const value = attemptValue(input, allow);
  const prepared = Object.freeze({ kind: 'prepared-remote-attempt' as const });
  attempts.set(prepared, value);
  return prepared;
}
export function prepareProjectRemoteOutcome(
  input: ProjectRemoteOutcomeInput,
  options: RemoteTransportOptions
): PreparedProjectRemoteOutcome {
  const allow = parse(Options, detached(options)).secretAllow;
  const value = outcomeValue(input, allow);
  const prepared = Object.freeze({ kind: 'prepared-remote-outcome' as const });
  outcomes.set(prepared, value);
  return prepared;
}
export function remoteRequestPreparation(
  input: PreparedProjectRemoteRequest
): RemoteRequestPreparation {
  return requests.get(input) ?? invalid('Use the original typed remote request preparation');
}
export function remoteAttemptPreparation(
  input: PreparedProjectRemoteAttempt
): RemoteAttemptPreparation {
  return attempts.get(input) ?? invalid('Use the original typed remote attempt preparation');
}
export function remoteOutcomePreparation(
  input: PreparedProjectRemoteOutcome
): RemoteOutcomePreparation {
  return outcomes.get(input) ?? invalid('Use the original typed remote outcome preparation');
}
function retained<T extends { scope: RemoteTransportScope }>(
  input: { scope: RemoteTransportScope },
  decode: () => T
): T {
  try {
    const value = decode();
    if (canonicalJson(value.scope) !== canonicalJson(input.scope))
      invalid('Retained remote namespace is not canonical');
    return value;
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'HISTORY_INTEGRITY_REQUIRED')
      throw cause;
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained remote data is malformed or mismatched; preserve history for explicit repair',
      { cause }
    );
  }
}
export function decodeRetainedRemoteRequest(
  input: ProjectRemoteRequestInput,
  expected: { payloadSha256: string; requestKey: string }
): RemoteRequestPreparation {
  return retained(input, () => {
    const value = requestValue(input, null);
    if (
      !DigestSchema.safeParse(expected.payloadSha256).success ||
      value.payloadSha256 !== expected.payloadSha256 ||
      value.requestKey !== expected.requestKey
    )
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Retained remote request bytes differ from their original identity; preserve history for repair'
      );
    return value;
  });
}
export function decodeRetainedRemoteAttempt(
  input: ProjectRemoteAttemptInput
): RemoteAttemptPreparation {
  return retained(input, () => attemptValue(input, null));
}
export function decodeRetainedRemoteOutcome(
  input: ProjectRemoteOutcomeInput,
  responseSha256: string | null
): RemoteOutcomePreparation {
  return retained(input, () => {
    const value = outcomeValue(input, null);
    if (value.responseSha256 !== responseSha256)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Retained remote response differs from its original bytes; preserve history for repair'
      );
    return value;
  });
}
