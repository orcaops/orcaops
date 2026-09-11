import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7, UuidV7Schema } from '../../ids/uuidv7.js';
import { CounterSchema, digest, DigestSchema } from '../event-integrity.js';
import type { ArtifactRevision } from './artifacts.js';
import type {
  CaptureOperationSource,
  LifecycleCompletionPreparation,
  PlanIdempotencyPreparation,
} from './capture-operation-input.js';
import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import type { ProjectOperation } from './transactions.js';
import type { DatabaseJson } from './values.js';

export function captureIntegrity(message: string, cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    `${message}; preserve original records for explicit repair`,
    { cause }
  );
}
export function captureArtifactId(value: string): string {
  if (!isUuidV7(value))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select an exact artifact UUID');
  return value;
}
export function captureKey(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select the exact original nonempty record key'
    );
  return value;
}
const artifactRevisionSchema = z.strictObject({
  generation: CounterSchema.refine((n) => n > 0),
  eventCount: CounterSchema.refine((n) => n > 0),
  byteLength: CounterSchema.refine((n) => n > 0),
  orderedHash: DigestSchema,
  tailEventId: UuidV7Schema,
});
export const captureRevisionColumns = `a.generation, a.ordered_hash AS orderedHash,
  a.event_count AS eventCount, a.byte_length AS byteLength, a.tail_event_id AS tailEventId`;
export function captureArtifactRevision(
  view: ProjectReadView,
  artifactId: string
): ArtifactRevision {
  const row = view.get<ArtifactRevision>(
    `SELECT ${captureRevisionColumns} FROM artifacts f
    LEFT JOIN artifact_revisions a ON a.artifact_id=f.artifact_id AND a.generation=f.current_generation
    WHERE f.artifact_id=?`,
    artifactId
  );
  if (!row)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The expected artifact history is missing; preserve the target for explicit repair'
    );
  if (!artifactRevisionSchema.safeParse(row).success)
    captureIntegrity('The selected artifact revision is missing or invalid');
  return row;
}
export function assertCaptureArtifactRevision(
  view: ProjectReadView,
  artifactId: string,
  expected: Readonly<ArtifactRevision>
): void {
  if (!isDeepStrictEqual(captureArtifactRevision(view, artifactId), expected))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The intended artifact revision changed; prepare an explicitly new operation without retargeting original content'
    );
}
export const captureProvenanceColumns = `publication_operation_id, artifact_id, artifact_generation,
  source_kind, source_identity, source_locator, source_profile, source_revision_id,
  source_event_id, source_operation_id, source_sha256, record_bytes, record_hash`;
export type CaptureRecordPreparation = Omit<
  LifecycleCompletionPreparation,
  'kind' | 'key' | 'row' | 'revisionId' | 'expectedSelection'
>;
export function captureRecordParameters(record: CaptureRecordPreparation): unknown[] {
  return [
    record.operationId,
    record.artifactId,
    record.artifactRevision.generation,
    record.sourceKind,
    record.source.identity,
    record.source.locator,
    record.sourceProfile,
    record.source.revisionId,
    record.source.eventId,
    record.source.operationId,
    record.source.sha256,
    record.bytesBase64 === null ? null : Buffer.from(record.bytesBase64, 'base64'),
    record.recordHash,
  ];
}
export function captureOperation(
  record: CaptureRecordPreparation | PlanIdempotencyPreparation,
  kind: string,
  expectedState: DatabaseJson
): ProjectOperation {
  return {
    operationId: record.operationId,
    kind,
    target: { artifactId: record.artifactId },
    payload: JSON.parse(canonicalJson(record)) as DatabaseJson,
    expectedState,
    intentChange: false,
  };
}
export function assertCaptureOperation(
  record: CaptureRecordPreparation,
  operationId: string
): void {
  if (record.operationId !== operationId)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Compose the prepared record under its original publication operation'
    );
}
export interface CaptureRecordRow {
  operationId: string;
  artifactId: string;
  artifactGeneration: number;
  sourceKind: 'authored' | 'historical';
  sourceIdentity: string;
  sourceLocator: string;
  sourceProfile: '0.2.0-rc.2' | null;
  sourceRevisionId: string | null;
  sourceEventId: string | null;
  sourceOperationId: string | null;
  sourceSha256: string | null;
  bytesHex: string | null;
  recordHash: string | null;
  retainedOperationId: string | null;
  retainedGeneration: number | null;
}
export const captureReadColumns = `r.publication_operation_id AS operationId, r.artifact_id AS artifactId,
 r.artifact_generation AS artifactGeneration,r.source_kind AS sourceKind,r.source_identity AS sourceIdentity,
 r.source_locator AS sourceLocator,r.source_profile AS sourceProfile,r.source_revision_id AS sourceRevisionId,
 r.source_event_id AS sourceEventId,r.source_operation_id AS sourceOperationId,r.source_sha256 AS sourceSha256,
 CASE WHEN r.record_bytes IS NULL THEN NULL ELSE hex(r.record_bytes) END AS bytesHex,r.record_hash AS recordHash,
 o.operation_id AS retainedOperationId,a.generation AS retainedGeneration`;
export const captureReadJoins = `LEFT JOIN operations o ON o.operation_id=r.publication_operation_id
 LEFT JOIN artifact_revisions a ON a.artifact_id=r.artifact_id AND a.generation=r.artifact_generation`;
const text = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'));
const sourceSchema = z.strictObject({
  identity: text,
  locator: text,
  revisionId: text.nullable(),
  eventId: text.nullable(),
  operationId: text.nullable(),
  sha256: DigestSchema.nullable(),
});
export function decodeCaptureProvenance(row: CaptureRecordRow): CaptureOperationSource {
  try {
    if (
      !isUuidV7(row.operationId) ||
      row.retainedOperationId !== row.operationId ||
      row.retainedGeneration !== row.artifactGeneration ||
      !Number.isSafeInteger(row.artifactGeneration) ||
      row.artifactGeneration < 1 ||
      !isUuidV7(row.artifactId) ||
      !['authored', 'historical'].includes(row.sourceKind) ||
      (row.sourceKind === 'historical'
        ? row.sourceProfile !== '0.2.0-rc.2'
        : row.sourceProfile !== null)
    )
      captureIntegrity('Original publication or artifact provenance is missing or inconsistent');
    return sourceSchema.parse({
      identity: row.sourceIdentity,
      locator: row.sourceLocator,
      revisionId: row.sourceRevisionId,
      eventId: row.sourceEventId,
      operationId: row.sourceOperationId,
      sha256: row.sourceSha256,
    });
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    captureIntegrity('Original operational provenance cannot be decoded', cause);
  }
}
export function decodeCaptureRecord<T>(
  row: CaptureRecordRow,
  schema: z.ZodType<T>
): { record: T; bytes: Buffer; source: CaptureOperationSource } {
  try {
    const source = decodeCaptureProvenance(row);
    if (row.bytesHex === null || !/^(?:[0-9A-F]{2})*$/u.test(row.bytesHex))
      captureIntegrity('Original record bytes are missing or invalid');
    const bytes = Buffer.from(row.bytesHex, 'hex');
    if (
      digest(bytes) !== row.recordHash ||
      (source.sha256 !== null && source.sha256 !== row.recordHash)
    )
      captureIntegrity('Original record checksum differs');
    const record = schema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
    return { record, bytes, source };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    captureIntegrity('Original operational record cannot be decoded', cause);
  }
}
export function validateCaptureSelection(value: { revisionId: string; version: number }): void {
  if (
    !isUuidV7(value.revisionId) ||
    !CounterSchema.safeParse(value.version).success ||
    value.version < 1
  )
    captureIntegrity('The original selected revision or version is invalid');
}
