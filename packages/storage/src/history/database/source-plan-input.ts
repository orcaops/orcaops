import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { canonicalizeBaseUrl } from '../../source-plan/canonical-base-url.js';
import { assertNoForbiddenControlChars } from '../../text/control-chars.js';
import { digest, DigestSchema } from '../event-integrity.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';

const text = z.string().min(1);
const version = z.number().int().positive().safe();
const bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array);
const allowSchema = z.array(z.string());
const namespaceSchema = z.discriminatedUnion('scopeKind', [
  z.strictObject({
    namespaceId: UuidV7Schema,
    scopeKind: z.literal('account'),
    serverUrl: text,
    orgId: text,
    accountId: text,
    originalNamespaceHash: z.null(),
    originalLocatorHash: z.null(),
  }),
  z.strictObject({
    namespaceId: UuidV7Schema,
    scopeKind: z.literal('organization_observation'),
    serverUrl: text,
    orgId: text,
    accountId: z.null(),
    originalNamespaceHash: DigestSchema,
    originalLocatorHash: z.null(),
  }),
  z.strictObject({
    namespaceId: UuidV7Schema,
    scopeKind: z.literal('unresolved_upload'),
    serverUrl: z.null(),
    orgId: z.null(),
    accountId: z.null(),
    originalNamespaceHash: z.null(),
    originalLocatorHash: DigestSchema,
  }),
]);
const approvedSchema = z.strictObject({
  schema_version: z.literal(1),
  external_id: text,
  slug: text,
  version_number: version,
  title: text,
  body: text,
  content_hash: DigestSchema,
  source_ref: z.string().nullable(),
  base_url: text,
  org_id: text,
  pulled_at: text,
});
const reviewSchema = z
  .strictObject({
    schema_version: z.literal(1),
    target: z.enum(['candidate', 'proposal']),
    external_id: text,
    version_id: text.nullable(),
    version_number: version.nullable(),
    proposal_id: text.nullable(),
    base_version_number: version.nullable(),
    content_hash: DigestSchema,
    body: text,
    base_url: text,
    org_id: text,
    pulled_at: text,
  })
  .refine((value) =>
    value.target === 'candidate'
      ? value.version_id !== null && value.version_number !== null && value.proposal_id === null
      : value.proposal_id !== null && value.version_id === null && value.version_number === null
  );
const pathSchema = z.strictObject({
  real_path: text,
  external_id: text,
  version_number: version,
});
const uploadSchema = z.strictObject({
  fingerprint: DigestSchema,
  external_id: text,
  unresolved: z.array(z.string()),
});
const selectionSchema = z.strictObject({ recordId: UuidV7Schema, version });
const recordInputSchema = z.strictObject({
  operationId: UuidV7Schema,
  recordId: UuidV7Schema,
  namespace: namespaceSchema,
  kind: z.enum(['approved', 'candidate', 'proposal']),
  expectedSelection: selectionSchema.nullable(),
  recordBytes: bytes,
});
const locatorInputSchema = z.strictObject({
  operationId: UuidV7Schema,
  revisionId: UuidV7Schema,
  namespace: namespaceSchema,
  kind: z.enum(['path', 'upload']),
  realPath: text,
  approvedRecordId: UuidV7Schema.nullable(),
  expectedSelection: selectionSchema.nullable(),
  recordBytes: bytes,
});
export type SourcePlanRecordContent = z.infer<typeof approvedSchema> | z.infer<typeof reviewSchema>;
export type SourcePlanLocatorContent = z.infer<typeof pathSchema> | z.infer<typeof uploadSchema>;
export type SourcePlanNamespace = z.infer<typeof namespaceSchema>;
export type SourcePlanSelection = z.infer<typeof selectionSchema>;
export type SourcePlanRecordInput = z.infer<typeof recordInputSchema>;
export type SourcePlanLocatorInput = z.infer<typeof locatorInputSchema>;
export interface PreparedSourcePlanRecord {
  readonly kind: 'prepared-source-plan-record';
}
export interface PreparedSourcePlanLocator {
  readonly kind: 'prepared-source-plan-locator';
}
export interface SourcePlanRecordPreparation extends Omit<SourcePlanRecordInput, 'recordBytes'> {
  readonly recordBase64: string;
  readonly recordSha256: string;
  readonly externalId: string;
  readonly approvedVersion: number | null;
  readonly versionId: string | null;
  readonly versionNumber: number | null;
  readonly proposalId: string | null;
  readonly baseVersionNumber: number | null;
  readonly contentHash: string;
  readonly pulledAt: string;
}
export interface SourcePlanLocatorPreparation extends Omit<SourcePlanLocatorInput, 'recordBytes'> {
  readonly recordBase64: string;
  readonly recordSha256: string;
  readonly pathHash: string;
  readonly externalId: string;
  readonly approvedVersion: number | null;
  readonly fingerprint: string | null;
}
const records = new WeakMap<PreparedSourcePlanRecord, SourcePlanRecordPreparation>();
const locators = new WeakMap<PreparedSourcePlanLocator, SourcePlanLocatorPreparation>();

function invalid(message: string, cause?: unknown): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message, { cause });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    invalid('Provide complete finite Source Plan identities and content', result.error);
  return result.data;
}
function detached<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    return invalid('Provide copyable Source Plan input', cause);
  }
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function refuse(value: unknown, allow: readonly string[]): void {
  refuseJsonBytes(Buffer.from(canonicalJson(value)), allow);
  try {
    assertNoForbiddenControlChars(value);
  } catch (cause) {
    invalid('Remove forbidden controls without changing the original Source Plan identity', cause);
  }
}
function server(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    return invalid('Provide a complete HTTP(S) Source Plan server identity', cause);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalid('Source Plan server identity must be HTTP(S) without credentials, query or fragment');
  return canonicalizeBaseUrl(value);
}
export function prepareSourcePlanNamespace(
  input: SourcePlanNamespace,
  secretAllow: readonly string[]
): SourcePlanNamespace {
  return decodeNamespace(input, parse(allowSchema, detached(secretAllow)));
}
export function decodeRetainedSourcePlanNamespace(input: SourcePlanNamespace): SourcePlanNamespace {
  return decodeNamespace(input);
}
function decodeNamespace(
  input: SourcePlanNamespace,
  allow?: readonly string[]
): SourcePlanNamespace {
  const value = parse(namespaceSchema, detached(input));
  if (allow !== undefined) refuse(value, allow);
  if (value.scopeKind === 'unresolved_upload') return frozen(value);
  const serverUrl = server(value.serverUrl);
  if (
    value.scopeKind === 'organization_observation' &&
    value.originalNamespaceHash !== digest(`${serverUrl}|${value.orgId}`)
  )
    invalid('Retain the original namespace hash for its exact server and organization');
  return frozen({ ...value, serverUrl });
}
function recordJson(
  source: Uint8Array,
  allow: readonly string[] | undefined
): { bytes: Buffer; value: unknown } {
  const buffer = Buffer.from(source);
  if (allow !== undefined) refuseJsonBytes(buffer, allow);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer));
  } catch (cause) {
    return invalid('Provide complete original UTF-8 JSON Source Plan bytes', cause);
  }
  if (allow !== undefined) refuse(value, allow);
  return { bytes: buffer, value };
}
function account(namespace: SourcePlanNamespace): void {
  if (namespace.scopeKind !== 'account')
    invalid(
      'Historical namespace observations cannot authorize an authored Source Plan publication'
    );
}
export function prepareSourcePlanRecord(
  raw: SourcePlanRecordInput,
  secretAllow: readonly string[]
): PreparedSourcePlanRecord {
  return decodeRecord(raw, parse(allowSchema, detached(secretAllow)));
}
export function decodeRetainedSourcePlanRecord(
  raw: SourcePlanRecordInput
): PreparedSourcePlanRecord {
  return decodeRecord(raw);
}
function decodeRecord(
  raw: SourcePlanRecordInput,
  allow?: readonly string[]
): PreparedSourcePlanRecord {
  const input = parse(recordInputSchema, detached(raw));
  const namespace = decodeNamespace(input.namespace, allow);
  account(namespace);
  const source = recordJson(input.recordBytes, allow);
  const value =
    input.kind === 'approved'
      ? parse(approvedSchema, source.value)
      : parse(reviewSchema, source.value);
  if ('target' in value && value.target !== input.kind)
    invalid('Publish the original candidate or proposal under its exact kind');
  if (server(value.base_url) !== namespace.serverUrl || value.org_id !== namespace.orgId)
    invalid('Source Plan bytes belong to another server or organization');
  if (digest(value.body) !== value.content_hash)
    invalid('Preserve the exact Source Plan body and its original content hash');
  if (input.kind === 'approved' && input.expectedSelection !== null)
    invalid('Approved Source Plan identity is immutable; compare its existing exact record');
  const { recordBytes: _bytes, ...metadata } = input;
  const prepared = frozen({ kind: 'prepared-source-plan-record' as const });
  records.set(
    prepared,
    frozen({
      ...metadata,
      namespace,
      recordBase64: source.bytes.toString('base64'),
      recordSha256: digest(source.bytes),
      externalId: value.external_id,
      approvedVersion: input.kind === 'approved' ? value.version_number : null,
      versionId: 'version_id' in value ? value.version_id : null,
      versionNumber: input.kind === 'candidate' ? value.version_number : null,
      proposalId: 'proposal_id' in value ? value.proposal_id : null,
      baseVersionNumber: 'base_version_number' in value ? value.base_version_number : null,
      contentHash: value.content_hash,
      pulledAt: value.pulled_at,
    })
  );
  return prepared;
}
export function sourcePlanRecord(input: PreparedSourcePlanRecord): SourcePlanRecordPreparation {
  const value = records.get(input);
  if (!value) invalid('Use an original storage-prepared Source Plan record');
  return value;
}
export function compareApprovedSourcePlanRecords(
  original: PreparedSourcePlanRecord,
  incoming: PreparedSourcePlanRecord
): 'equal' {
  const before = sourcePlanRecord(original),
    after = sourcePlanRecord(incoming);
  if (before.kind !== 'approved' || after.kind !== 'approved')
    invalid('Compare approved Source Plan records only');
  const { pulled_at: _beforeTime, ...beforeFacts } = parse(
    approvedSchema,
    JSON.parse(Buffer.from(before.recordBase64, 'base64').toString('utf8'))
  );
  const { pulled_at: _afterTime, ...afterFacts } = parse(
    approvedSchema,
    JSON.parse(Buffer.from(after.recordBase64, 'base64').toString('utf8'))
  );
  if (
    !isDeepStrictEqual(before.namespace, after.namespace) ||
    !isDeepStrictEqual(beforeFacts, afterFacts)
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The approved Source Plan identity has different retained facts; preserve the original version'
    );
  return 'equal';
}
export function prepareSourcePlanLocator(
  raw: SourcePlanLocatorInput,
  secretAllow: readonly string[]
): PreparedSourcePlanLocator {
  return decodeLocator(raw, parse(allowSchema, detached(secretAllow)));
}
export function decodeRetainedSourcePlanLocator(
  raw: SourcePlanLocatorInput
): PreparedSourcePlanLocator {
  return decodeLocator(raw);
}
function decodeLocator(
  raw: SourcePlanLocatorInput,
  allow?: readonly string[]
): PreparedSourcePlanLocator {
  const input = parse(locatorInputSchema, detached(raw));
  const namespace = decodeNamespace(input.namespace, allow);
  account(namespace);
  const { recordBytes: _bytes, ...metadata } = input;
  if (allow !== undefined) refuse(metadata, allow);
  if (!path.isAbsolute(input.realPath)) invalid('Provide the original resolved absolute plan path');
  const source = recordJson(input.recordBytes, allow);
  const value =
    input.kind === 'path' ? parse(pathSchema, source.value) : parse(uploadSchema, source.value);
  if (input.kind === 'path') {
    if (
      !('real_path' in value) ||
      value.real_path !== input.realPath ||
      input.approvedRecordId === null
    )
      invalid('Path pointers require the exact approved record and original resolved path');
  } else if (input.approvedRecordId !== null)
    invalid('Upload indexes cannot claim an approved Source Plan record');
  const prepared = frozen({ kind: 'prepared-source-plan-locator' as const });
  locators.set(
    prepared,
    frozen({
      ...metadata,
      namespace,
      recordBase64: source.bytes.toString('base64'),
      recordSha256: digest(source.bytes),
      pathHash: digest(input.realPath),
      externalId: value.external_id,
      approvedVersion: 'version_number' in value ? value.version_number : null,
      fingerprint: 'fingerprint' in value ? value.fingerprint : null,
    })
  );
  return prepared;
}
export function sourcePlanLocator(input: PreparedSourcePlanLocator): SourcePlanLocatorPreparation {
  const value = locators.get(input);
  if (!value) invalid('Use an original storage-prepared Source Plan locator');
  return value;
}
