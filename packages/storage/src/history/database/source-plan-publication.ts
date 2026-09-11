import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { digest } from '../event-integrity.js';
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  compareApprovedSourcePlanRecords,
  decodeRetainedSourcePlanLocator,
  decodeRetainedSourcePlanRecord,
  prepareSourcePlanLocator,
  prepareSourcePlanRecord,
  sourcePlanLocator,
  type SourcePlanLocatorInput,
  type SourcePlanLocatorPreparation,
  sourcePlanRecord,
  type SourcePlanRecordInput,
  type SourcePlanRecordPreparation,
  type SourcePlanSelection,
} from './source-plan-input.js';
import {
  readProjectApprovedSourcePlan,
  readProjectSourcePlanLocator,
  readProjectSourcePlanReview,
} from './source-plan-reader.js';
import {
  decodeSourcePlanLocatorRow,
  decodeSourcePlanRecordRow,
  retainSourcePlanNamespace,
  sourcePlanIntegrity,
  sourcePlanLocatorReceipt,
  sourcePlanLocatorReceiptExists,
  sourcePlanLocatorRow,
  sourcePlanNamespaceRow,
  sourcePlanRecordReceipt,
  sourcePlanRecordReceiptExists,
  sourcePlanRecordRow,
} from './source-plan-records.js';
import {
  type ProjectOperationOptions,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';

export interface SourcePlanPublicationOptions extends ProjectOperationOptions {
  secretAllow: readonly string[];
}
export type ProjectSourcePlanRecordPublication = {
  recordId: string;
  selection: SourcePlanSelection;
};
export type ProjectSourcePlanLocatorPublication = {
  revisionId: string;
  selection: SourcePlanSelection;
};
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'This original Source Plan operation or record identity has different input; preserve its original result and use a distinct identity only for explicitly new work'
  );
}
function stale(): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    'The original Source Plan selection changed; inspect current history before explicitly preparing a new expected selection'
  );
}
function copy<T>(input: T): T {
  try {
    return structuredClone(input);
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide copyable finite Source Plan input', {
      cause,
    });
  }
}
function operationId(input: { operationId: string }) {
  if (!UuidV7Schema.safeParse(input?.operationId).success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original Source Plan operation UUID'
    );
  return input.operationId;
}
interface OperationRow {
  kind: string;
  intentChange: number;
  target: string;
  payload: string;
  payloadHash: string;
  expected: string;
  result: string;
}
function operation(view: ProjectReadView, id: string) {
  return view.get<OperationRow>(
    `SELECT operation_kind AS kind,intent_change AS intentChange,target_json AS target,
    payload_json AS payload,payload_hash AS payloadHash,expected_state_json AS expected,
    result_json AS result FROM operations WHERE operation_id=?`,
    id
  );
}
const recordOwner = z.strictObject({
  recordId: UuidV7Schema,
  recordSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const publicationSelection = z.strictObject({
  recordId: UuidV7Schema,
  version: z.number().int().positive().safe(),
});
const locatorOwner = z.strictObject({
  revisionId: UuidV7Schema,
  recordSha256: z.string().regex(/^[0-9a-f]{64}$/),
  approvedRecordId: UuidV7Schema.nullable(),
});
function ownedRecord(handle: ProjectDatabase, id: string) {
  const receipt = handle.read((view) => operation(view, id)).value;
  if (!receipt) return null;
  if (receipt.kind !== 'source_plan.record') conflict();
  let recordId: string;
  try {
    recordId = recordOwner.parse(JSON.parse(receipt.payload)).recordId;
  } catch (cause) {
    sourcePlanIntegrity(cause);
  }
  const original = handle.read((view) => {
    const row = sourcePlanRecordRow(view, recordId);
    if (!row || row.operationId !== id) sourcePlanIntegrity();
    const namespace = sourcePlanNamespaceRow(view, row.namespaceId);
    if (!namespace) sourcePlanIntegrity();
    return { row, namespace };
  }).value;
  const record = decodeSourcePlanRecordRow(original.row, original.namespace);
  if (record.kind === 'approved') {
    const selected = readProjectApprovedSourcePlan(handle, {
      namespaceId: record.namespace.namespaceId,
      externalId: record.externalId,
      approvedVersion: record.approvedVersion!,
    });
    const result = JSON.parse(original.row.resultJson!) as ProjectSourcePlanRecordPublication;
    if (!selected || !isDeepStrictEqual(selected.selection, result.selection))
      sourcePlanIntegrity();
  } else if (
    !readProjectSourcePlanReview(handle, {
      namespaceId: record.namespace.namespaceId,
      kind: record.kind,
      subjectId: record.kind === 'candidate' ? record.externalId : record.proposalId!,
    })
  )
    sourcePlanIntegrity();
  return record;
}
function ownedLocator(handle: ProjectDatabase, id: string) {
  const receipt = handle.read((view) => operation(view, id)).value;
  if (!receipt) return null;
  if (receipt.kind !== 'source_plan.locator') conflict();
  let revisionId: string;
  try {
    revisionId = locatorOwner.parse(JSON.parse(receipt.payload)).revisionId;
  } catch (cause) {
    sourcePlanIntegrity(cause);
  }
  const original = handle.read((view) => {
    const row = sourcePlanLocatorRow(view, revisionId);
    if (!row || row.operationId !== id) sourcePlanIntegrity();
    const namespace = sourcePlanNamespaceRow(view, row.namespaceId);
    if (!namespace) sourcePlanIntegrity();
    return { row, namespace };
  }).value;
  const record = decodeSourcePlanLocatorRow(original.row, original.namespace);
  if (
    !readProjectSourcePlanLocator(handle, {
      namespaceId: record.namespace.namespaceId,
      kind: record.kind,
      realPath: record.realPath,
    })
  )
    sourcePlanIntegrity();
  if (record.kind === 'path') {
    const approved = readProjectApprovedSourcePlan(handle, {
      namespaceId: record.namespace.namespaceId,
      externalId: record.externalId,
      approvedVersion: record.approvedVersion!,
    });
    if (!approved || approved.record.recordId !== record.approvedRecordId) sourcePlanIntegrity();
  }
  return record;
}
function originalRecordInput(record: SourcePlanRecordPreparation): SourcePlanRecordInput {
  return {
    operationId: record.operationId,
    recordId: record.recordId,
    namespace: record.namespace,
    kind: record.kind,
    expectedSelection: record.expectedSelection,
    recordBytes: Buffer.from(record.recordBase64, 'base64'),
  };
}

export function readProjectSourcePlanRecordPublication(
  handle: ProjectDatabase,
  raw: SourcePlanRecordInput
): ProjectSourcePlanRecordPublication | null {
  assertProjectDatabasePath(handle);
  const input = copy(raw),
    id = operationId(input),
    original = ownedRecord(handle, id);
  if (!original) return null;
  let retained: SourcePlanRecordPreparation;
  try {
    retained = sourcePlanRecord(decodeRetainedSourcePlanRecord(input));
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'IDEMPOTENCY_CONFLICT') throw cause;
    return conflict();
  }
  if (!isDeepStrictEqual(retained, original)) conflict();
  const receipt = sourcePlanRecordReceipt(original);
  const row = handle.read((view) => operation(view, id)).value;
  if (
    !row ||
    row.kind !== 'source_plan.record' ||
    row.intentChange !== 0 ||
    row.target !== canonicalJson(receipt.target) ||
    row.payload !== canonicalJson(receipt.payload) ||
    row.payloadHash !== digest(row.payload) ||
    row.expected !== canonicalJson(receipt.expectedState)
  )
    sourcePlanIntegrity();
  let result: ProjectSourcePlanRecordPublication;
  try {
    result = z
      .strictObject({ recordId: UuidV7Schema, selection: publicationSelection })
      .parse(JSON.parse(row.result));
  } catch (cause) {
    sourcePlanIntegrity(cause);
  }
  if (
    result.recordId !== original.recordId ||
    result.selection.recordId !== original.recordId ||
    result.selection.version !== (original.expectedSelection?.version ?? 0) + 1
  )
    sourcePlanIntegrity();
  return result;
}
function recordSelection(view: ProjectReadView, r: SourcePlanRecordPreparation) {
  const selection =
    r.kind === 'approved'
      ? view.get<SourcePlanSelection>(
          'SELECT record_id AS recordId,1 AS version FROM source_plan_approved WHERE namespace_id=? AND external_id=? AND approved_version=?',
          r.namespace.namespaceId,
          r.externalId,
          r.approvedVersion
        )
      : view.get<SourcePlanSelection>(
          'SELECT record_id AS recordId,version FROM source_plan_review_current WHERE namespace_id=? AND kind=? AND subject_id=?',
          r.namespace.namespaceId,
          r.kind,
          r.kind === 'candidate' ? r.externalId : r.proposalId
        );
  if (!selection) {
    const retained =
      r.kind === 'proposal'
        ? view.get(
            "SELECT record_id FROM source_plan_records WHERE namespace_id=? AND kind='proposal' AND proposal_id=? LIMIT 1",
            r.namespace.namespaceId,
            r.proposalId
          )
        : view.get(
            'SELECT record_id FROM source_plan_records WHERE namespace_id=? AND kind=? AND external_id=? AND approved_version IS ? LIMIT 1',
            r.namespace.namespaceId,
            r.kind,
            r.externalId,
            r.approvedVersion
          );
    if (
      retained ||
      sourcePlanRecordReceiptExists(view, {
        namespaceId: r.namespace.namespaceId,
        kind: r.kind,
        subjectId: r.kind === 'proposal' ? r.proposalId! : r.externalId,
        approvedVersion: r.approvedVersion,
      })
    )
      sourcePlanIntegrity();
  }
  return selection;
}
function locatorSelection(view: ProjectReadView, r: SourcePlanLocatorPreparation) {
  const selection = view.get<SourcePlanSelection>(
    `SELECT revision_id AS recordId,version FROM source_plan_locator_current WHERE namespace_id=? AND kind=? AND locator_kind='real_path' AND locator=?`,
    r.namespace.namespaceId,
    r.kind,
    r.realPath
  );
  if (
    !selection &&
    (view.get(
      'SELECT revision_id FROM source_plan_locator_revisions WHERE namespace_id=? AND kind=? AND real_path=? LIMIT 1',
      r.namespace.namespaceId,
      r.kind,
      r.realPath
    ) ||
      sourcePlanLocatorReceiptExists(view, r.namespace.namespaceId, r.kind, r.realPath))
  )
    sourcePlanIntegrity();
  return selection;
}
function nextVersion(selection: SourcePlanSelection | null) {
  const next = (selection?.version ?? 0) + 1;
  if (!Number.isSafeInteger(next) || next < 1) sourcePlanIntegrity();
  return next;
}
function insertRecord(tx: ProjectSettlement, r: SourcePlanRecordPreparation) {
  if (
    tx.get('SELECT record_id FROM source_plan_records WHERE record_id=?', r.recordId) ||
    tx.get('SELECT revision_id FROM source_plan_locator_revisions WHERE revision_id=?', r.recordId)
  )
    conflict();
  tx.run(
    `INSERT INTO source_plan_records (record_id,namespace_id,kind,original_record_id,record_bytes,publication_operation_id,import_provenance_id,record_sha256,external_id,approved_version,version_id,version_number,proposal_id,base_version_number,content_hash,pulled_at) VALUES (?,?,?,NULL,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
    r.recordId,
    r.namespace.namespaceId,
    r.kind,
    Buffer.from(r.recordBase64, 'base64'),
    r.operationId,
    r.recordSha256,
    r.externalId,
    r.approvedVersion,
    r.versionId,
    r.versionNumber,
    r.proposalId,
    r.baseVersionNumber,
    r.contentHash,
    r.pulledAt
  );
}
export async function publishProjectSourcePlanRecord(
  handle: ProjectDatabase,
  raw: SourcePlanRecordInput,
  options: SourcePlanPublicationOptions
) {
  assertProjectDatabasePath(handle);
  const input = copy(raw),
    id = operationId(input);
  const operationOptions = { signal: options.signal, onWait: options.onWait };
  const original = ownedRecord(handle, id);
  if (original) {
    try {
      if (!isDeepStrictEqual(sourcePlanRecord(decodeRetainedSourcePlanRecord(input)), original))
        conflict();
    } catch (error) {
      if (error instanceof ProjectDatabaseError && error.code === 'IDEMPOTENCY_CONFLICT')
        throw error;
      conflict();
    }
    return runProjectOperation<ProjectSourcePlanRecordPublication>(
      handle,
      {
        operationId: id,
        kind: 'source_plan.record',
        ...sourcePlanRecordReceipt(original),
        intentChange: false,
      },
      () => sourcePlanIntegrity(),
      operationOptions
    );
  }
  const prepared = prepareSourcePlanRecord(input, options.secretAllow),
    r = sourcePlanRecord(prepared);
  const observed =
    r.kind === 'approved'
      ? readProjectApprovedSourcePlan(handle, {
          namespaceId: r.namespace.namespaceId,
          externalId: r.externalId,
          approvedVersion: r.approvedVersion!,
        })
      : readProjectSourcePlanReview(handle, {
          namespaceId: r.namespace.namespaceId,
          kind: r.kind,
          subjectId: r.kind === 'candidate' ? r.externalId : r.proposalId!,
        });
  if (r.kind === 'approved' && observed)
    compareApprovedSourcePlanRecords(
      decodeRetainedSourcePlanRecord(originalRecordInput(observed.record)),
      prepared
    );
  if (r.kind === 'proposal' && observed && observed.record.externalId !== r.externalId) conflict();
  if (r.kind !== 'approved' && !isDeepStrictEqual(observed?.selection ?? null, r.expectedSelection))
    stale();
  return runProjectOperation<ProjectSourcePlanRecordPublication>(
    handle,
    {
      operationId: id,
      kind: 'source_plan.record',
      ...sourcePlanRecordReceipt(r),
      intentChange: false,
    },
    (tx) => {
      retainSourcePlanNamespace(tx, r.namespace);
      const current = recordSelection(tx, r);
      if (!isDeepStrictEqual(current, observed?.selection ?? null)) stale();
      insertRecord(tx, r);
      if (r.kind === 'approved') {
        const selection = current ?? { recordId: r.recordId, version: 1 };
        if (!current)
          tx.run(
            'INSERT INTO source_plan_approved (namespace_id,external_id,approved_version,record_id) VALUES (?,?,?,?)',
            r.namespace.namespaceId,
            r.externalId,
            r.approvedVersion,
            r.recordId
          );
        return { recordId: r.recordId, selection };
      }
      const selection = { recordId: r.recordId, version: nextVersion(current) },
        subject = r.kind === 'candidate' ? r.externalId : r.proposalId;
      if (current) {
        if (
          tx.run(
            'UPDATE source_plan_review_current SET record_id=?,version=? WHERE namespace_id=? AND kind=? AND subject_id=? AND record_id=? AND version=?',
            r.recordId,
            selection.version,
            r.namespace.namespaceId,
            r.kind,
            subject,
            current.recordId,
            current.version
          ).changes !== 1
        )
          stale();
      } else
        tx.run(
          'INSERT INTO source_plan_review_current (namespace_id,kind,subject_id,record_id,version) VALUES (?,?,?,?,?)',
          r.namespace.namespaceId,
          r.kind,
          subject,
          r.recordId,
          1
        );
      return { recordId: r.recordId, selection };
    },
    operationOptions
  );
}
export async function publishProjectSourcePlanLocator(
  handle: ProjectDatabase,
  raw: SourcePlanLocatorInput,
  options: SourcePlanPublicationOptions
) {
  assertProjectDatabasePath(handle);
  const input = copy(raw),
    id = operationId(input);
  const operationOptions = { signal: options.signal, onWait: options.onWait };
  const original = ownedLocator(handle, id);
  if (original) {
    try {
      if (!isDeepStrictEqual(sourcePlanLocator(decodeRetainedSourcePlanLocator(input)), original))
        conflict();
    } catch (error) {
      if (error instanceof ProjectDatabaseError && error.code === 'IDEMPOTENCY_CONFLICT')
        throw error;
      conflict();
    }
    return runProjectOperation<ProjectSourcePlanLocatorPublication>(
      handle,
      {
        operationId: id,
        kind: 'source_plan.locator',
        ...sourcePlanLocatorReceipt(original),
        intentChange: false,
      },
      () => sourcePlanIntegrity(),
      operationOptions
    );
  }
  const r = sourcePlanLocator(prepareSourcePlanLocator(input, options.secretAllow));
  const observed = readProjectSourcePlanLocator(handle, {
    namespaceId: r.namespace.namespaceId,
    kind: r.kind,
    realPath: r.realPath,
  });
  if (!isDeepStrictEqual(observed?.selection ?? null, r.expectedSelection)) stale();
  const approved =
    r.kind === 'path'
      ? readProjectApprovedSourcePlan(handle, {
          namespaceId: r.namespace.namespaceId,
          externalId: r.externalId,
          approvedVersion: r.approvedVersion!,
        })
      : null;
  if (r.kind === 'path' && (!approved || approved.record.recordId !== r.approvedRecordId)) stale();
  return runProjectOperation<ProjectSourcePlanLocatorPublication>(
    handle,
    {
      operationId: id,
      kind: 'source_plan.locator',
      ...sourcePlanLocatorReceipt(r),
      intentChange: false,
    },
    (tx) => {
      retainSourcePlanNamespace(tx, r.namespace);
      const current = locatorSelection(tx, r);
      if (!isDeepStrictEqual(current, r.expectedSelection)) stale();
      if (
        tx.get(
          'SELECT revision_id FROM source_plan_locator_revisions WHERE revision_id=?',
          r.revisionId
        ) ||
        tx.get('SELECT record_id FROM source_plan_records WHERE record_id=?', r.revisionId)
      )
        conflict();
      if (
        r.kind === 'path' &&
        !tx.get(
          'SELECT record_id FROM source_plan_approved WHERE namespace_id=? AND external_id=? AND approved_version=? AND record_id=?',
          r.namespace.namespaceId,
          r.externalId,
          r.approvedVersion,
          r.approvedRecordId
        )
      )
        stale();
      tx.run(
        `INSERT INTO source_plan_locator_revisions (revision_id,namespace_id,kind,record_bytes,original_record_id,publication_operation_id,import_provenance_id,approved_record_id,record_sha256,real_path,path_hash,original_locator_hash,external_id,approved_version,fingerprint) VALUES (?,?,?,?,NULL,?,NULL,?,?,?,?,NULL,?,?,?)`,
        r.revisionId,
        r.namespace.namespaceId,
        r.kind,
        Buffer.from(r.recordBase64, 'base64'),
        r.operationId,
        r.approvedRecordId,
        r.recordSha256,
        r.realPath,
        r.pathHash,
        r.externalId,
        r.approvedVersion,
        r.fingerprint
      );
      const selection = { recordId: r.revisionId, version: nextVersion(current) };
      if (current) {
        if (
          tx.run(
            `UPDATE source_plan_locator_current SET revision_id=?,version=? WHERE namespace_id=? AND kind=? AND locator_kind='real_path' AND locator=? AND revision_id=? AND version=?`,
            r.revisionId,
            selection.version,
            r.namespace.namespaceId,
            r.kind,
            r.realPath,
            current.recordId,
            current.version
          ).changes !== 1
        )
          stale();
      } else
        tx.run(
          "INSERT INTO source_plan_locator_current (namespace_id,kind,locator_kind,locator,revision_id,version) VALUES (?,?,'real_path',?,?,1)",
          r.namespace.namespaceId,
          r.kind,
          r.realPath,
          r.revisionId
        );
      return { revisionId: r.revisionId, selection };
    },
    operationOptions
  );
}
