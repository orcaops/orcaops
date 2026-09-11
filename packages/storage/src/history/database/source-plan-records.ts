import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { digest } from '../event-integrity.js';
import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeRetainedSourcePlanLocator,
  decodeRetainedSourcePlanRecord,
  sourcePlanLocator,
  type SourcePlanLocatorPreparation,
  type SourcePlanNamespace,
  sourcePlanRecord,
  type SourcePlanRecordPreparation,
  type SourcePlanSelection,
} from './source-plan-input.js';
import type { ProjectSettlement } from './transactions.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';

export function sourcePlanIntegrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Original Source Plan bytes, selection or operation ownership is missing or inconsistent; preserve history for explicit repair',
    { cause }
  );
}
interface ReceiptRow {
  operationId: string;
  originalRecordId: string | null;
  importProvenanceId: string | null;
  operationKind: string | null;
  intentChange: number | null;
  targetJson: string | null;
  payloadJson: string | null;
  payloadHash: string | null;
  expectedJson: string | null;
  resultJson: string | null;
}
interface NamespaceRow {
  namespaceId: string;
  scopeKind: SourcePlanNamespace['scopeKind'];
  serverUrl: string | null;
  orgId: string | null;
  accountId: string | null;
  originalNamespaceHash: string | null;
  originalLocatorHash: string | null;
}
export interface SourcePlanRecordRow extends ReceiptRow {
  recordId: string;
  namespaceId: string;
  kind: SourcePlanRecordPreparation['kind'];
  bytesHex: string;
  recordSha256: string;
  externalId: string;
  approvedVersion: number | null;
  versionId: string | null;
  versionNumber: number | null;
  proposalId: string | null;
  baseVersionNumber: number | null;
  contentHash: string;
  pulledAt: string;
}
export interface SourcePlanLocatorRow extends ReceiptRow {
  revisionId: string;
  namespaceId: string;
  kind: SourcePlanLocatorPreparation['kind'];
  bytesHex: string;
  recordSha256: string;
  realPath: string;
  pathHash: string;
  approvedRecordId: string | null;
  externalId: string;
  approvedVersion: number | null;
  fingerprint: string | null;
  originalLocatorHash: string | null;
}
const receiptColumns = `o.operation_kind AS operationKind,o.intent_change AS intentChange,
  o.target_json AS targetJson,o.payload_json AS payloadJson,o.payload_hash AS payloadHash,
  o.expected_state_json AS expectedJson,o.result_json AS resultJson`;
export function sourcePlanNamespaceRow(view: ProjectReadView, namespaceId: string) {
  return view.get<NamespaceRow>(
    `SELECT namespace_id AS namespaceId,scope_kind AS scopeKind,server_url AS serverUrl,
    org_id AS orgId,account_id AS accountId,original_namespace_hash AS originalNamespaceHash,
    original_locator_hash AS originalLocatorHash FROM source_plan_namespaces WHERE namespace_id=?`,
    namespaceId
  );
}
export function sourcePlanRecordReceiptExists(
  view: ProjectReadView,
  input: {
    namespaceId: string;
    kind: SourcePlanRecordPreparation['kind'];
    subjectId: string;
    approvedVersion: number | null;
  }
): boolean {
  return !!view.get(
    `SELECT operation_id FROM operations WHERE operation_kind='source_plan.record'
    AND json_extract(target_json,'$.namespaceId')=? AND json_extract(target_json,'$.kind')=?
    AND json_extract(target_json,'$.subjectId')=?
    AND (? <> 'approved' OR json_extract(target_json,'$.approvedVersion')=?) LIMIT 1`,
    input.namespaceId,
    input.kind,
    input.subjectId,
    input.kind,
    input.approvedVersion
  );
}
export function sourcePlanLocatorReceiptExists(
  view: ProjectReadView,
  namespaceId: string,
  kind: SourcePlanLocatorPreparation['kind'],
  realPath: string
): boolean {
  return !!view.get(
    `SELECT operation_id FROM operations WHERE operation_kind='source_plan.locator'
    AND json_extract(target_json,'$.namespaceId')=? AND json_extract(target_json,'$.kind')=?
    AND json_extract(target_json,'$.realPath')=? LIMIT 1`,
    namespaceId,
    kind,
    realPath
  );
}
export function sourcePlanNamespaceMissing(view: ProjectReadView): boolean {
  // Once a header is lost, its receipt's namespace ID cannot recover the account tuple.
  return !!view.get(`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM source_plan_records r WHERE NOT EXISTS
      (SELECT 1 FROM source_plan_namespaces n WHERE n.namespace_id=r.namespace_id))
    OR EXISTS (SELECT 1 FROM source_plan_locator_revisions r WHERE NOT EXISTS
      (SELECT 1 FROM source_plan_namespaces n WHERE n.namespace_id=r.namespace_id))
    OR EXISTS (SELECT 1 FROM source_plan_approved r WHERE NOT EXISTS
      (SELECT 1 FROM source_plan_namespaces n WHERE n.namespace_id=r.namespace_id))
    OR EXISTS (SELECT 1 FROM source_plan_review_current r WHERE NOT EXISTS
      (SELECT 1 FROM source_plan_namespaces n WHERE n.namespace_id=r.namespace_id))
    OR EXISTS (SELECT 1 FROM source_plan_locator_current r WHERE NOT EXISTS
      (SELECT 1 FROM source_plan_namespaces n WHERE n.namespace_id=r.namespace_id))
    OR EXISTS (SELECT 1 FROM operations o WHERE o.operation_kind IN ('source_plan.record','source_plan.locator')
      AND NOT EXISTS (SELECT 1 FROM source_plan_namespaces n
        WHERE n.namespace_id=json_extract(o.target_json,'$.namespaceId')))`);
}
export function retainSourcePlanNamespace(
  transaction: ProjectSettlement,
  value: SourcePlanNamespace
): void {
  const current = sourcePlanNamespaceRow(transaction, value.namespaceId);
  if (current) {
    if (!isDeepStrictEqual(current, value))
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'This Source Plan namespace identity belongs to different original authority'
      );
    return;
  }
  if (
    value.scopeKind === 'account' &&
    transaction.get(
      "SELECT namespace_id FROM source_plan_namespaces WHERE scope_kind='account' AND server_url=? AND org_id=? AND account_id=?",
      value.serverUrl,
      value.orgId,
      value.accountId
    )
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'This Source Plan account already has a different original namespace identity'
    );
  if (sourcePlanNamespaceMissing(transaction)) sourcePlanIntegrity();
  transaction.run(
    'INSERT INTO source_plan_namespaces (namespace_id,scope_kind,server_url,org_id,account_id,original_namespace_hash,original_locator_hash) VALUES (?,?,?,?,?,?,?)',
    value.namespaceId,
    value.scopeKind,
    value.serverUrl,
    value.orgId,
    value.accountId,
    value.originalNamespaceHash,
    value.originalLocatorHash
  );
}
export function sourcePlanRecordRow(view: ProjectReadView, recordId: string) {
  return view.get<SourcePlanRecordRow>(
    `SELECT r.record_id AS recordId,r.namespace_id AS namespaceId,r.kind,
    hex(r.record_bytes) AS bytesHex,r.publication_operation_id AS operationId,r.original_record_id AS originalRecordId,r.import_provenance_id AS importProvenanceId,r.record_sha256 AS recordSha256,
    r.external_id AS externalId,r.approved_version AS approvedVersion,r.version_id AS versionId,
    r.version_number AS versionNumber,r.proposal_id AS proposalId,r.base_version_number AS baseVersionNumber,
    r.content_hash AS contentHash,r.pulled_at AS pulledAt,${receiptColumns}
    FROM source_plan_records r LEFT JOIN operations o ON o.operation_id=r.publication_operation_id WHERE r.record_id=?`,
    recordId
  );
}
export function sourcePlanLocatorRow(view: ProjectReadView, revisionId: string) {
  return view.get<SourcePlanLocatorRow>(
    `SELECT r.revision_id AS revisionId,r.namespace_id AS namespaceId,r.kind,
    hex(r.record_bytes) AS bytesHex,r.publication_operation_id AS operationId,r.original_record_id AS originalRecordId,r.import_provenance_id AS importProvenanceId,r.record_sha256 AS recordSha256,
    r.real_path AS realPath,r.path_hash AS pathHash,r.approved_record_id AS approvedRecordId,
    r.external_id AS externalId,r.approved_version AS approvedVersion,r.fingerprint,r.original_locator_hash AS originalLocatorHash,${receiptColumns}
    FROM source_plan_locator_revisions r LEFT JOIN operations o ON o.operation_id=r.publication_operation_id WHERE r.revision_id=?`,
    revisionId
  );
}
export function sourcePlanRecordReceipt(record: SourcePlanRecordPreparation) {
  return {
    target: {
      namespaceId: record.namespace.namespaceId,
      kind: record.kind,
      externalId: record.externalId,
      approvedVersion: record.approvedVersion,
      subjectId: record.kind === 'proposal' ? record.proposalId : record.externalId,
    },
    payload: { recordId: record.recordId, recordSha256: record.recordSha256 },
    expectedState: record.expectedSelection,
  };
}
export function sourcePlanLocatorReceipt(record: SourcePlanLocatorPreparation) {
  return {
    target: {
      namespaceId: record.namespace.namespaceId,
      kind: record.kind,
      realPath: record.realPath,
    },
    payload: {
      revisionId: record.revisionId,
      recordSha256: record.recordSha256,
      approvedRecordId: record.approvedRecordId,
    },
    expectedState: record.expectedSelection,
  };
}
function expected(row: ReceiptRow): SourcePlanSelection | null {
  if (row.expectedJson === null) sourcePlanIntegrity();
  return JSON.parse(row.expectedJson) as SourcePlanSelection | null;
}
function receipt(
  row: ReceiptRow,
  kind: string,
  descriptor:
    | ReturnType<typeof sourcePlanRecordReceipt>
    | ReturnType<typeof sourcePlanLocatorReceipt>
) {
  if (
    row.originalRecordId !== null ||
    row.importProvenanceId !== null ||
    row.operationKind !== kind ||
    row.intentChange !== 0 ||
    row.targetJson === null ||
    row.payloadJson === null ||
    row.payloadHash !== digest(row.payloadJson) ||
    row.resultJson === null ||
    canonicalJson(JSON.parse(row.targetJson)) !== canonicalJson(descriptor.target) ||
    canonicalJson(JSON.parse(row.payloadJson)) !== canonicalJson(descriptor.payload) ||
    canonicalJson(expected(row)) !== canonicalJson(descriptor.expectedState)
  )
    sourcePlanIntegrity();
}
const selectionSchema = z.strictObject({
  recordId: UuidV7Schema,
  version: z.number().int().positive().safe(),
});
const recordResultSchema = z.strictObject({ recordId: UuidV7Schema, selection: selectionSchema });
const locatorResultSchema = z.strictObject({
  revisionId: UuidV7Schema,
  selection: selectionSchema,
});
export function decodeSourcePlanRecordRow(row: SourcePlanRecordRow, namespace: NamespaceRow) {
  try {
    const prepared = decodeRetainedSourcePlanRecord({
      recordId: row.recordId,
      operationId: row.operationId,
      namespace: namespace as SourcePlanNamespace,
      kind: row.kind,
      expectedSelection: expected(row),
      recordBytes: Buffer.from(row.bytesHex, 'hex'),
    });
    const record = sourcePlanRecord(prepared);
    if (!isDeepStrictEqual(record.namespace, namespace)) sourcePlanIntegrity();
    for (const field of [
      'namespaceId',
      'recordSha256',
      'externalId',
      'approvedVersion',
      'versionId',
      'versionNumber',
      'proposalId',
      'baseVersionNumber',
      'contentHash',
      'pulledAt',
    ] as const) {
      const actual = field === 'namespaceId' ? record.namespace.namespaceId : record[field];
      if (!isDeepStrictEqual(actual, row[field])) sourcePlanIntegrity();
    }
    receipt(row, 'source_plan.record', sourcePlanRecordReceipt(record));
    const result = recordResultSchema.parse(JSON.parse(row.resultJson!));
    if (
      result.recordId !== record.recordId ||
      result.selection.version !==
        (record.kind === 'approved' ? 1 : (record.expectedSelection?.version ?? 0) + 1) ||
      (record.kind !== 'approved' && result.selection.recordId !== record.recordId)
    )
      sourcePlanIntegrity();
    return record;
  } catch (cause) {
    sourcePlanIntegrity(cause);
  }
}
export function decodeSourcePlanLocatorRow(row: SourcePlanLocatorRow, namespace: NamespaceRow) {
  try {
    const prepared = decodeRetainedSourcePlanLocator({
      revisionId: row.revisionId,
      operationId: row.operationId,
      namespace: namespace as SourcePlanNamespace,
      kind: row.kind,
      expectedSelection: expected(row),
      recordBytes: Buffer.from(row.bytesHex, 'hex'),
      realPath: row.realPath,
      approvedRecordId: row.approvedRecordId,
    });
    const record = sourcePlanLocator(prepared);
    if (!isDeepStrictEqual(record.namespace, namespace)) sourcePlanIntegrity();
    for (const field of [
      'namespaceId',
      'recordSha256',
      'pathHash',
      'externalId',
      'approvedVersion',
      'fingerprint',
    ] as const) {
      const actual = field === 'namespaceId' ? record.namespace.namespaceId : record[field];
      if (!isDeepStrictEqual(actual, row[field])) sourcePlanIntegrity();
    }
    receipt(row, 'source_plan.locator', sourcePlanLocatorReceipt(record));
    const result = locatorResultSchema.parse(JSON.parse(row.resultJson!));
    if (
      row.originalLocatorHash !== null ||
      result.revisionId !== record.revisionId ||
      result.selection.recordId !== record.revisionId ||
      result.selection.version !== (record.expectedSelection?.version ?? 0) + 1
    )
      sourcePlanIntegrity();
    return record;
  } catch (cause) {
    sourcePlanIntegrity(cause);
  }
}
