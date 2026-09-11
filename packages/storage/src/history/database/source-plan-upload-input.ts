import path from 'node:path';
import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { assertNoForbiddenControlChars } from '../../text/control-chars.js';
import { digest, DigestSchema } from '../event-integrity.js';
import { canonicalRemoteTarget, RemoteTargetSchema } from '../remote-target.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeRetainedSourcePlanNamespace,
  prepareSourcePlanNamespace,
  type SourcePlanNamespace,
  type SourcePlanSelection,
} from './source-plan-input.js';

const text = z.string().min(1);
const time = text.refine((value) => Number.isFinite(Date.parse(value)));
const bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array);
const selection = z.strictObject({
  recordId: UuidV7Schema,
  version: z.number().int().positive().safe(),
});
const priorLocator = z.strictObject({
  selection,
  fingerprint: DigestSchema,
  externalId: text,
  unresolved: z.array(z.string()),
});
const namespace = z.custom<SourcePlanNamespace>(
  (value) => value !== null && typeof value === 'object'
);
const commandInput = z.strictObject({
  commandId: UuidV7Schema,
  operationId: UuidV7Schema,
  terminalOperationId: UuidV7Schema,
  requestOperationId: UuidV7Schema,
  requestId: UuidV7Schema,
  locatorOperationId: UuidV7Schema,
  locatorRevisionId: UuidV7Schema,
  target: RemoteTargetSchema,
  namespace,
  realPath: text,
  expectedLocator: priorLocator.nullable(),
  preparedAt: time,
  payloadBytes: bytes,
});
const baseline = z.strictObject({
  repo_url: z.string().nullable(),
  branch: z.string().nullable(),
  head_sha: z.string().nullable(),
});
const derivedFrom = z.strictObject({
  source_plan_external_id: text,
  version_number: z.number().int().positive().safe(),
});
const uploadPayload = z.strictObject({
  schema_version: z.literal(1),
  external_id: text,
  title: text,
  body: text,
  content_hash: DigestSchema,
  reviewers: z.array(z.string()),
  review_note: z.string().nullable(),
  source_ref: z.string().nullable(),
  derived_from: derivedFrom.nullable(),
  summary: z.string().nullable(),
  baseline: baseline.nullable(),
  authored_at: time,
});
const suggestion = z.strictObject({
  tag: z.string(),
  matches: z.array(z.strictObject({ handle: z.string(), name: z.string() })),
});
const secretFinding = z.strictObject({
  path: z.string(),
  patterns: z.array(z.string()),
  key_prefix: z.string().optional(),
});
const uploadResult = z.strictObject({
  external_id: text,
  slug: text,
  status: z.string(),
  unresolved: z.array(z.string()),
  reviewer_suggestions: z.array(suggestion).optional(),
  prior_external_id: text.optional(),
  secret_warnings: z.array(secretFinding).optional(),
});
const uploadResponse = z
  .object({
    id: text,
    externalId: text,
    slug: text,
    status: z.string(),
    unresolved: z.array(z.string()),
  })
  .passthrough();

export type SourcePlanUploadPayload = z.infer<typeof uploadPayload>;
export type SourcePlanUploadResult = z.infer<typeof uploadResult>;
export type SourcePlanUploadResponse = z.infer<typeof uploadResponse>;
export type SourcePlanUploadPriorLocator = z.infer<typeof priorLocator>;
export type ProjectSourcePlanUploadCommandInput = Omit<
  z.infer<typeof commandInput>,
  'namespace' | 'expectedLocator'
> & {
  namespace: SourcePlanNamespace;
  expectedLocator: SourcePlanUploadPriorLocator | null;
};
export interface PreparedProjectSourcePlanUploadCommand {
  readonly kind: 'prepared-source-plan-upload-command';
}
export interface SourcePlanUploadCommandPreparation extends Omit<
  ProjectSourcePlanUploadCommandInput,
  'payloadBytes'
> {
  readonly payloadBase64: string;
  readonly payloadSha256: string;
  readonly fingerprint: string;
  readonly externalId: string;
}

const preparations = new WeakMap<
  PreparedProjectSourcePlanUploadCommand,
  SourcePlanUploadCommandPreparation
>();

function invalid(message: string, cause?: unknown): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message, { cause });
}
function copy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    return invalid('Provide copyable finite Source Plan upload input', cause);
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function parsePayload(source: Uint8Array, allow: readonly string[] | null) {
  const buffer = Buffer.from(source);
  if (allow !== null) refuseJsonBytes(buffer, allow);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer));
  } catch (cause) {
    return invalid('Provide exact UTF-8 JSON Source Plan upload bytes', cause);
  }
  try {
    assertNoForbiddenControlChars(value);
  } catch (cause) {
    return invalid('Remove forbidden controls from the Source Plan upload', cause);
  }
  const parsed = uploadPayload.safeParse(value);
  if (!parsed.success) invalid('Provide the complete Source Plan upload payload', parsed.error);
  if (canonicalJson(parsed.data) !== canonicalJson(value))
    invalid('Provide the exact normalized Source Plan upload payload');
  return { bytes: buffer, value: parsed.data };
}

export function sourcePlanUploadFingerprint(
  input: Pick<
    SourcePlanUploadPayload,
    'body' | 'title' | 'reviewers' | 'review_note' | 'source_ref' | 'derived_from'
  >
): string {
  return digest(
    canonicalJson({
      body: input.body,
      title: input.title,
      reviewers: input.reviewers,
      review_note: input.review_note,
      source_ref: input.source_ref,
      derived_from: input.derived_from,
    })
  );
}

export function sourcePlanUploadExternalId(realPath: string, fingerprint: string): string {
  return digest(`source-plan-upload:${digest(realPath)}:${fingerprint}`);
}

function materialize(
  raw: ProjectSourcePlanUploadCommandInput,
  secretAllow: readonly string[] | null
): SourcePlanUploadCommandPreparation {
  const parsed = commandInput.safeParse(copy(raw));
  if (!parsed.success)
    invalid('Provide the complete original Source Plan upload identities', parsed.error);
  const input = parsed.data as ProjectSourcePlanUploadCommandInput;
  const target = canonicalRemoteTarget(input.target);
  const scope =
    secretAllow === null
      ? decodeRetainedSourcePlanNamespace(input.namespace)
      : prepareSourcePlanNamespace(input.namespace, secretAllow);
  if (
    scope.scopeKind !== 'account' ||
    scope.serverUrl !== target.server_url ||
    scope.orgId !== target.org_id ||
    scope.accountId !== target.account_id
  )
    invalid('The Source Plan upload namespace must match its authenticated account target');
  if (!path.isAbsolute(input.realPath))
    invalid('Provide the original resolved absolute Source Plan upload path');
  const ids = [
    input.commandId,
    input.operationId,
    input.terminalOperationId,
    input.requestOperationId,
    input.requestId,
    input.locatorOperationId,
    input.locatorRevisionId,
  ];
  if (new Set(ids).size !== ids.length)
    invalid('Source Plan upload command and child identities must be distinct');
  const payload = parsePayload(input.payloadBytes, secretAllow);
  const reviewers = [...new Set(payload.value.reviewers)].sort();
  if (canonicalJson(reviewers) !== canonicalJson(payload.value.reviewers))
    invalid('Source Plan upload reviewers must be sorted and unique');
  if (digest(payload.value.body) !== payload.value.content_hash)
    invalid('Preserve the exact Source Plan body and content hash');
  const fingerprint = sourcePlanUploadFingerprint(payload.value);
  const externalId = sourcePlanUploadExternalId(input.realPath, fingerprint);
  if (payload.value.external_id !== externalId)
    invalid('The Source Plan upload external ID must match its original path and fingerprint');
  if (secretAllow !== null)
    refuseJsonBytes(
      Buffer.from(
        canonicalJson({
          commandId: input.commandId,
          target,
          namespace: scope,
          realPath: input.realPath,
          expectedLocator: input.expectedLocator,
        })
      ),
      secretAllow
    );
  const expected = input.expectedLocator;
  if (
    expected !== null &&
    (expected.selection.version < 1 ||
      expected.externalId.length === 0 ||
      expected.fingerprint.length !== 64)
  )
    invalid('Retain the complete original upload locator selection');
  const { payloadBytes: _payload, ...metadata } = input;
  return freeze({
    ...metadata,
    target,
    namespace: scope,
    payloadBase64: payload.bytes.toString('base64'),
    payloadSha256: digest(payload.bytes),
    fingerprint,
    externalId,
  });
}

export function prepareProjectSourcePlanUploadCommand(
  input: ProjectSourcePlanUploadCommandInput,
  options: { secretAllow: readonly string[] }
): PreparedProjectSourcePlanUploadCommand {
  if (
    !Array.isArray(options?.secretAllow) ||
    !options.secretAllow.every((item) => typeof item === 'string')
  )
    invalid('Provide an explicit Source Plan upload refusal allowlist');
  const prepared = Object.freeze({ kind: 'prepared-source-plan-upload-command' as const });
  preparations.set(prepared, materialize(input, [...options.secretAllow]));
  return prepared;
}

export function decodeRetainedProjectSourcePlanUploadCommand(
  input: ProjectSourcePlanUploadCommandInput
): PreparedProjectSourcePlanUploadCommand {
  const prepared = Object.freeze({ kind: 'prepared-source-plan-upload-command' as const });
  preparations.set(prepared, materialize(input, null));
  return prepared;
}

export function projectSourcePlanUploadCommand(
  input: PreparedProjectSourcePlanUploadCommand
): SourcePlanUploadCommandPreparation {
  return preparations.get(input) ?? invalid('Use the original storage-prepared Source Plan upload');
}

export function parseSourcePlanUploadResult(input: unknown): SourcePlanUploadResult {
  const parsed = uploadResult.safeParse(copy(input));
  if (!parsed.success) invalid('Provide the finite Source Plan upload result', parsed.error);
  try {
    assertNoForbiddenControlChars(parsed.data);
  } catch (cause) {
    return invalid('Remove forbidden controls from the Source Plan upload result', cause);
  }
  return freeze(parsed.data);
}

export function parseSourcePlanUploadResponse(input: unknown): SourcePlanUploadResponse {
  const parsed = uploadResponse.safeParse(copy(input));
  if (!parsed.success)
    invalid('Provide the exact acknowledged Source Plan upload response', parsed.error);
  return freeze(parsed.data);
}

export function sourcePlanUploadExpectedSelection(
  input: SourcePlanUploadPriorLocator | null
): SourcePlanSelection | null {
  return input === null ? null : copy(input.selection);
}
