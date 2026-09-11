import path from 'node:path';
import { z } from 'zod';

import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import type { SourcePlanSelection } from './source-plan-input.js';
import {
  decodeSourcePlanLocatorRow,
  decodeSourcePlanRecordRow,
  sourcePlanIntegrity,
  sourcePlanLocatorReceiptExists,
  sourcePlanLocatorRow,
  sourcePlanNamespaceRow,
  sourcePlanRecordReceiptExists,
  sourcePlanRecordRow,
} from './source-plan-records.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';

const text = z.string().min(1);
const approvedKey = z.strictObject({
  namespaceId: UuidV7Schema,
  externalId: text,
  approvedVersion: z.number().int().positive().safe(),
});
const approvedScanKey = approvedKey.omit({ namespaceId: true });
const reviewKey = z.strictObject({
  namespaceId: UuidV7Schema,
  kind: z.enum(['candidate', 'proposal']),
  subjectId: text,
});
const locatorKey = z.strictObject({
  namespaceId: UuidV7Schema,
  kind: z.enum(['path', 'upload']),
  realPath: text.refine(path.isAbsolute),
});
export type ProjectApprovedSourcePlanKey = z.infer<typeof approvedKey>;
export type ProjectApprovedSourcePlanScan = z.infer<typeof approvedScanKey>;
export type ProjectSourcePlanReviewKey = z.infer<typeof reviewKey>;
export type ProjectSourcePlanLocatorKey = z.infer<typeof locatorKey>;
function key<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact finite Source Plan lookup identity',
      { cause: parsed.error }
    );
  return parsed.data;
}
function selected(value: SourcePlanSelection): SourcePlanSelection {
  if (
    !UuidV7Schema.safeParse(value.recordId).success ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  )
    sourcePlanIntegrity();
  return value;
}
function materializeRecord(
  view: ProjectReadView,
  namespaceId: string,
  selection: SourcePlanSelection | null,
  retained: unknown
) {
  if (!selection) {
    if (retained) sourcePlanIntegrity();
    return null;
  }
  const record = sourcePlanRecordRow(view, selection.recordId);
  const namespace = sourcePlanNamespaceRow(view, namespaceId);
  if (!record || !namespace || record.namespaceId !== namespaceId) sourcePlanIntegrity();
  return { record, namespace, selection: selected(selection) };
}
function decodeSelectedApproval(
  row: NonNullable<ReturnType<typeof sourcePlanRecordRow>>,
  namespace: NonNullable<ReturnType<typeof sourcePlanNamespaceRow>>
) {
  const record = decodeSourcePlanRecordRow(row, namespace);
  const result = JSON.parse(row.resultJson!) as { selection: SourcePlanSelection };
  if (
    record.kind !== 'approved' ||
    result.selection.recordId !== record.recordId ||
    result.selection.version !== 1
  )
    sourcePlanIntegrity();
  return record;
}
export function readProjectApprovedSourcePlan(
  handle: ProjectDatabase,
  input: ProjectApprovedSourcePlanKey
) {
  assertProjectDatabasePath(handle);
  const request = key(approvedKey, input);
  const read = handle.read((view) =>
    materializeRecord(
      view,
      request.namespaceId,
      view.get<SourcePlanSelection>(
        'SELECT record_id AS recordId,1 AS version FROM source_plan_approved WHERE namespace_id=? AND external_id=? AND approved_version=?',
        request.namespaceId,
        request.externalId,
        request.approvedVersion
      ),
      view.get(
        "SELECT record_id FROM source_plan_records WHERE namespace_id=? AND kind='approved' AND external_id=? AND approved_version=? LIMIT 1",
        request.namespaceId,
        request.externalId,
        request.approvedVersion
      ) ||
        sourcePlanRecordReceiptExists(view, {
          namespaceId: request.namespaceId,
          kind: 'approved',
          subjectId: request.externalId,
          approvedVersion: request.approvedVersion,
        })
    )
  );
  if (!read.value) return null;
  const record = decodeSelectedApproval(read.value.record, read.value.namespace);
  if (
    record.kind !== 'approved' ||
    record.externalId !== request.externalId ||
    record.approvedVersion !== request.approvedVersion
  )
    sourcePlanIntegrity();
  return { record, selection: read.value.selection, counters: read.counters };
}
export function scanProjectApprovedSourcePlans(
  handle: ProjectDatabase,
  input: ProjectApprovedSourcePlanScan
) {
  assertProjectDatabasePath(handle);
  const request = key(approvedScanKey, input);
  const read = handle.read((view) => {
    const namespaces = view.all<{ namespaceId: string }>(
      `SELECT namespace_id AS namespaceId FROM source_plan_approved
       WHERE external_id=? AND approved_version=?
       UNION
       SELECT namespace_id AS namespaceId FROM source_plan_records
       WHERE kind='approved' AND external_id=? AND approved_version=?
       UNION
       SELECT json_extract(target_json,'$.namespaceId') AS namespaceId FROM operations
       WHERE operation_kind='source_plan.record'
         AND json_extract(target_json,'$.kind')='approved'
         AND json_extract(target_json,'$.externalId')=?
         AND json_extract(target_json,'$.approvedVersion')=?
       ORDER BY namespaceId`,
      request.externalId,
      request.approvedVersion,
      request.externalId,
      request.approvedVersion,
      request.externalId,
      request.approvedVersion
    );
    return namespaces.map(({ namespaceId }) => {
      const value = materializeRecord(
        view,
        namespaceId,
        view.get<SourcePlanSelection>(
          'SELECT record_id AS recordId,1 AS version FROM source_plan_approved WHERE namespace_id=? AND external_id=? AND approved_version=?',
          namespaceId,
          request.externalId,
          request.approvedVersion
        ),
        view.get(
          "SELECT record_id FROM source_plan_records WHERE namespace_id=? AND kind='approved' AND external_id=? AND approved_version=? LIMIT 1",
          namespaceId,
          request.externalId,
          request.approvedVersion
        ) ||
          sourcePlanRecordReceiptExists(view, {
            namespaceId,
            kind: 'approved',
            subjectId: request.externalId,
            approvedVersion: request.approvedVersion,
          })
      );
      if (!value) sourcePlanIntegrity();
      return value;
    });
  });
  return {
    matches: read.value.map((value) => {
      const record = decodeSelectedApproval(value.record, value.namespace);
      if (
        record.externalId !== request.externalId ||
        record.approvedVersion !== request.approvedVersion
      )
        sourcePlanIntegrity();
      return { record, selection: value.selection };
    }),
    counters: read.counters,
  };
}
export function readProjectSourcePlanReview(
  handle: ProjectDatabase,
  input: ProjectSourcePlanReviewKey
) {
  assertProjectDatabasePath(handle);
  const request = key(reviewKey, input);
  const read = handle.read((view) =>
    materializeRecord(
      view,
      request.namespaceId,
      view.get<SourcePlanSelection>(
        'SELECT record_id AS recordId,version FROM source_plan_review_current WHERE namespace_id=? AND kind=? AND subject_id=?',
        request.namespaceId,
        request.kind,
        request.subjectId
      ),
      (request.kind === 'candidate'
        ? view.get(
            "SELECT record_id FROM source_plan_records WHERE namespace_id=? AND kind='candidate' AND external_id=? LIMIT 1",
            request.namespaceId,
            request.subjectId
          )
        : view.get(
            "SELECT record_id FROM source_plan_records WHERE namespace_id=? AND kind='proposal' AND proposal_id=? LIMIT 1",
            request.namespaceId,
            request.subjectId
          )) ||
        sourcePlanRecordReceiptExists(view, {
          namespaceId: request.namespaceId,
          kind: request.kind,
          subjectId: request.subjectId,
          approvedVersion: null,
        })
    )
  );
  if (!read.value) return null;
  const record = decodeSourcePlanRecordRow(read.value.record, read.value.namespace);
  if (
    record.kind !== request.kind ||
    (record.kind === 'candidate' ? record.externalId : record.proposalId) !== request.subjectId ||
    read.value.selection.version !== (record.expectedSelection?.version ?? 0) + 1
  )
    sourcePlanIntegrity();
  return { record, selection: read.value.selection, counters: read.counters };
}
export function readProjectSourcePlanLocator(
  handle: ProjectDatabase,
  input: ProjectSourcePlanLocatorKey
) {
  assertProjectDatabasePath(handle);
  const request = key(locatorKey, input);
  const read = handle.read((view) => {
    const selection = view.get<SourcePlanSelection>(
      `SELECT revision_id AS recordId,version FROM source_plan_locator_current WHERE namespace_id=? AND kind=? AND locator_kind='real_path' AND locator=?`,
      request.namespaceId,
      request.kind,
      request.realPath
    );
    if (!selection) {
      if (
        view.get(
          'SELECT revision_id FROM source_plan_locator_revisions WHERE namespace_id=? AND kind=? AND real_path=? LIMIT 1',
          request.namespaceId,
          request.kind,
          request.realPath
        ) ||
        sourcePlanLocatorReceiptExists(view, request.namespaceId, request.kind, request.realPath)
      )
        sourcePlanIntegrity();
      return null;
    }
    const record = sourcePlanLocatorRow(view, selection.recordId);
    const namespace = sourcePlanNamespaceRow(view, request.namespaceId);
    if (!record || !namespace || record.namespaceId !== request.namespaceId) sourcePlanIntegrity();
    const approved =
      record.approvedRecordId === null ? null : sourcePlanRecordRow(view, record.approvedRecordId);
    const approval =
      record.approvedRecordId === null
        ? null
        : view.get<{ recordId: string }>(
            'SELECT record_id AS recordId FROM source_plan_approved WHERE namespace_id=? AND external_id=? AND approved_version=?',
            request.namespaceId,
            record.externalId,
            record.approvedVersion
          );
    if (
      record.kind === 'path' &&
      (!approved || !approval || approval.recordId !== record.approvedRecordId)
    )
      sourcePlanIntegrity();
    return { record, namespace, selection: selected(selection), approved };
  });
  if (!read.value) return null;
  const record = decodeSourcePlanLocatorRow(read.value.record, read.value.namespace);
  if (
    record.kind !== request.kind ||
    record.realPath !== request.realPath ||
    read.value.selection.version !== (record.expectedSelection?.version ?? 0) + 1
  )
    sourcePlanIntegrity();
  if (read.value.approved) {
    const approved = decodeSelectedApproval(read.value.approved, read.value.namespace);
    if (
      approved.kind !== 'approved' ||
      approved.externalId !== record.externalId ||
      approved.approvedVersion !== record.approvedVersion
    )
      sourcePlanIntegrity();
  }
  return { record, selection: read.value.selection, counters: read.counters };
}

export interface ProjectSourcePlanHistoricalDisclosure {
  readonly count: number;
  readonly locations: readonly string[];
  readonly accountProvenance: 'unknown';
}

/**
 * Source Plan records converted from the frozen 0.2.0-rc.2 profile, disclosed by count and
 * original location.
 *
 * They cannot be returned through the account-scoped readers above: `source_plan_records`
 * requires a namespace whose `scope_kind` is `account`, and the frozen writer never recorded a
 * server, organization or account for its pull cache. Inventing one to make the records
 * reachable would be exactly the account reconstruction the conversion refuses, so the records
 * stay in the retained legacy table and this disclosure is how the accepted read path admits
 * they exist. It decodes no payload, replays nothing and grants no authority — a caller that
 * gets `null` from the account-scoped readers can still see that history is held here and where
 * it came from.
 */
export function readProjectSourcePlanHistoricalDisclosure(
  handle: ProjectDatabase
): ProjectSourcePlanHistoricalDisclosure {
  assertProjectDatabasePath(handle);
  const rows = handle.read((view) =>
    view.all<{ location: string; provenance: string }>(
      `SELECT source_location AS location, account_provenance AS provenance
       FROM legacy_source_plan_records ORDER BY source_location`
    )
  ).value;
  if (rows.some((row) => row.provenance !== 'unknown')) sourcePlanIntegrity();
  return Object.freeze({
    count: rows.length,
    locations: Object.freeze(rows.map((row) => row.location)),
    accountProvenance: 'unknown' as const,
  });
}
