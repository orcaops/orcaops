import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { OssSourcePlanReviewPropose, OssSourcePlanReviewPush } from '@orcaops/sdk';
import {
  assertNoSecretsInPayload,
  canonicalJson,
  type ReviewPullRecord,
  ReviewPullRecordSchema,
  sha256Hex,
} from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  publishProjectSourcePlanRecord,
  readProjectSourcePlanNamespace,
  readProjectSourcePlanRecordPublication,
  readProjectSourcePlanReview,
  runProjectOperation,
  type SourcePlanNamespace,
  type SourcePlanSelection,
} from '@orcaops/storage/history/database';
import type { RemoteTransportScope } from '@orcaops/storage/history/database/source-plan-upload';
import { canonicalRemoteTarget, type RemoteTarget } from '@orcaops/storage/history/remote-target';

import type { PlanReviewPersistence } from '../commands/plan/review/persistence.js';

export interface DatabasePlanReviewPersistenceOptions {
  reader: ProjectDatabase;
  target: RemoteTarget;
  secretAllow: readonly string[];
  openWriter(): Promise<ProjectDatabase>;
  signal?: AbortSignal;
  onWait?: ProjectOperationOptions['onWait'];
  publicationAdmission?(): DatabasePlanReviewPublicationAdmission | null;
}

type PublicationMethod = Extract<
  RemoteTransportScope['method'],
  'sourcePlan.reviewPush' | 'sourcePlan.reviewPropose'
>;

export interface DatabasePlanReviewPublicationAdmission {
  operationId: string;
  commandKey: string;
  target: RemoteTarget;
  method: PublicationMethod;
  externalId: string;
  namespace: Extract<SourcePlanNamespace, { scopeKind: 'account' }>;
  expectedCandidateSelection: SourcePlanSelection | null;
  request: Readonly<Record<string, unknown>>;
  publicationAt: string;
}

export interface DatabasePlanReviewPublicationAdmissionOptions {
  reader: ProjectDatabase;
  getWriter(): Promise<ProjectDatabase>;
  operationId: string;
  commandKey: string;
  target: RemoteTarget;
  method: PublicationMethod;
  externalId: string;
  command: Readonly<Record<string, unknown>>;
  request: unknown;
  publicationAt: string;
  secretAllow: readonly string[];
  signal?: AbortSignal;
  onWait?: ProjectOperationOptions['onWait'];
}

interface OperationRow {
  kind: string;
  intentChange: number;
  targetJson: string;
  payloadJson: string;
  payloadHash: string;
  expectedJson: string;
  resultJson: string;
}

const selection = z.strictObject({
  recordId: z.string().min(1),
  version: z.number().int().positive(),
});
const namespace = z.strictObject({
  namespaceId: z.string().min(1),
  scopeKind: z.literal('account'),
  serverUrl: z.string().min(1),
  orgId: z.string().min(1),
  accountId: z.string().min(1),
  originalNamespaceHash: z.null(),
  originalLocatorHash: z.null(),
});
const admissionTarget = z.strictObject({
  commandKey: z.string().min(1),
  target: z.strictObject({
    server_url: z.string().min(1),
    org_id: z.string().min(1),
    account_id: z.string().min(1),
  }),
  method: z.enum(['sourcePlan.reviewPush', 'sourcePlan.reviewPropose']),
  externalId: z.string().min(1),
  namespace,
  expectedCandidateSelection: selection.nullable(),
});
const admissionPayload = z.strictObject({
  command: z.record(z.string(), z.unknown()),
  request: z.record(z.string(), z.unknown()),
  publicationAt: z.string().min(1),
});

const refAliasTarget = z.strictObject({
  ref: z.string().min(1),
  target: z.strictObject({
    server_url: z.string().min(1),
    org_id: z.string().min(1),
    account_id: z.string().min(1),
  }),
});
const refAliasPayload = z.strictObject({
  external_id: z.string().min(1),
  pulled_at: z.string().min(1),
});

interface RefAliasRow {
  intentChange: number;
  targetJson: string;
  payloadJson: string;
  payloadHash: string;
  expectedJson: string;
  resultJson: string;
}

function databasePlanReviewNamespace(
  reader: ProjectDatabase,
  target: RemoteTarget
): Extract<SourcePlanNamespace, { scopeKind: 'account' }> {
  return (
    readProjectSourcePlanNamespace(reader, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    }) ?? {
      namespaceId: derivedId(reader.authority.projectId, 'source_plan.namespace', target),
      scopeKind: 'account' as const,
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
      originalNamespaceHash: null,
      originalLocatorHash: null,
    }
  );
}

function parseCanonical(value: string): unknown {
  try {
    const parsed = JSON.parse(value);
    if (canonicalJson(parsed) !== value) throw new Error('noncanonical');
    return parsed;
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The retained Source Plan review publication admission is invalid',
      { cause }
    );
  }
}

function publicationIntegrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'The retained Source Plan review publication admission is invalid',
    { cause }
  );
}

function readPublicationAdmission(
  input: DatabasePlanReviewPublicationAdmissionOptions
): DatabasePlanReviewPublicationAdmission | null {
  const row = input.reader.read((view) =>
    view.get<OperationRow>(
      `SELECT operation_kind AS kind,intent_change AS intentChange,target_json AS targetJson,
      payload_json AS payloadJson,payload_hash AS payloadHash,expected_state_json AS expectedJson,
      result_json AS resultJson FROM operations WHERE operation_id=?`,
      input.operationId
    )
  ).value;
  if (!row) return null;
  if (row.kind !== 'source_plan.review.publication.begin' || row.intentChange !== 0)
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The Source Plan review publication admission identity belongs to another operation'
    );
  let retainedTarget: z.infer<typeof admissionTarget>;
  let retainedPayload: z.infer<typeof admissionPayload>;
  let expected: z.infer<typeof selection> | null;
  let result: unknown;
  try {
    retainedTarget = admissionTarget.parse(parseCanonical(row.targetJson));
    retainedPayload = admissionPayload.parse(parseCanonical(row.payloadJson));
    expected = selection.nullable().parse(parseCanonical(row.expectedJson));
    result = parseCanonical(row.resultJson);
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    publicationIntegrity(cause);
  }
  if (
    canonicalJson(expected) !== canonicalJson(retainedTarget.expectedCandidateSelection) ||
    row.payloadHash !== sha256Hex(row.payloadJson) ||
    canonicalJson(result) !== canonicalJson({ admitted: true }) ||
    retainedTarget.namespace.serverUrl !== retainedTarget.target.server_url ||
    retainedTarget.namespace.orgId !== retainedTarget.target.org_id ||
    retainedTarget.namespace.accountId !== retainedTarget.target.account_id
  )
    publicationIntegrity();
  if (
    retainedTarget.commandKey !== input.commandKey ||
    canonicalJson(retainedTarget.target) !== canonicalJson(canonicalRemoteTarget(input.target)) ||
    retainedTarget.method !== input.method ||
    retainedTarget.externalId !== input.externalId ||
    canonicalJson(retainedPayload.command) !== canonicalJson(input.command) ||
    canonicalJson(retainedPayload.request) !== canonicalJson(input.request)
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The retained Source Plan review publication admission belongs to different original input'
    );
  return {
    operationId: input.operationId,
    commandKey: input.commandKey,
    target: retainedTarget.target,
    method: retainedTarget.method,
    externalId: retainedTarget.externalId,
    namespace: retainedTarget.namespace,
    expectedCandidateSelection: retainedTarget.expectedCandidateSelection,
    request: retainedPayload.request,
    publicationAt: retainedPayload.publicationAt,
  };
}

export async function ensureDatabasePlanReviewPublicationAdmission(
  raw: DatabasePlanReviewPublicationAdmissionOptions
): Promise<DatabasePlanReviewPublicationAdmission> {
  const input = {
    ...raw,
    target: canonicalRemoteTarget(raw.target),
    command: JSON.parse(canonicalJson(raw.command)),
    request: JSON.parse(canonicalJson(raw.request)),
    secretAllow: [...raw.secretAllow],
  };
  const retained = readPublicationAdmission(input);
  if (retained) return retained;
  const retainedNamespace = databasePlanReviewNamespace(input.reader, input.target);
  const expectedCandidateSelection =
    readProjectSourcePlanReview(input.reader, {
      namespaceId: retainedNamespace.namespaceId,
      kind: 'candidate',
      subjectId: input.externalId,
    })?.selection ?? null;
  const targetValue = {
    commandKey: input.commandKey,
    target: input.target,
    method: input.method,
    externalId: input.externalId,
    namespace: retainedNamespace,
    expectedCandidateSelection,
  };
  const payload = {
    command: input.command,
    request: input.request,
    publicationAt: input.publicationAt,
  };
  assertNoSecretsInPayload({ target: targetValue, payload }, input.secretAllow);
  const writer = await input.getWriter();
  try {
    await runProjectOperation(
      writer,
      {
        operationId: input.operationId,
        kind: 'source_plan.review.publication.begin',
        target: targetValue,
        payload,
        expectedState: expectedCandidateSelection,
        intentChange: false,
      },
      () => ({ admitted: true }),
      { signal: input.signal, onWait: input.onWait }
    );
  } catch (cause) {
    const raced = readPublicationAdmission(input);
    if (raced) return raced;
    throw cause;
  }
  const admitted = readPublicationAdmission(input);
  if (!admitted)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The Source Plan review publication admission was not retained'
    );
  return admitted;
}

function derivedId(projectId: string, family: string, value: unknown): string {
  return artifactOperationId(projectId, canonicalJson(value), family);
}

function reviewSubject(record: ReviewPullRecord): string {
  if (record.target === 'candidate') return record.external_id;
  if (record.proposal_id === null)
    throw new ProjectDatabaseError('INVALID_INPUT', 'A proposal record requires its proposal id');
  return record.proposal_id;
}

export function createDatabasePlanReviewPersistence(
  input: DatabasePlanReviewPersistenceOptions
): PlanReviewPersistence {
  const reader = input.reader;
  const target = canonicalRemoteTarget(input.target);
  const secretAllow = [...input.secretAllow];
  const projectId = reader.authority.projectId;
  let namespace: Extract<SourcePlanNamespace, { scopeKind: 'account' }> | null = null;

  function readNamespace() {
    namespace ??= readProjectSourcePlanNamespace(reader, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    }) ?? {
      namespaceId: derivedId(projectId, 'source_plan.namespace', target),
      scopeKind: 'account' as const,
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
      originalNamespaceHash: null,
      originalLocatorHash: null,
    };
    return namespace;
  }

  function read(kind: 'candidate' | 'proposal', subjectId: string): ReviewPullRecord | null {
    const selected = readProjectSourcePlanReview(reader, {
      namespaceId: readNamespace().namespaceId,
      kind,
      subjectId,
    });
    if (!selected) return null;
    return ReviewPullRecordSchema.parse(
      JSON.parse(Buffer.from(selected.record.recordBase64, 'base64').toString('utf8'))
    );
  }

  return {
    async preflight() {
      readNamespace();
    },
    async readCandidate(externalId) {
      return read('candidate', externalId);
    },
    async readProposal(_externalId, proposalId) {
      const record = read('proposal', proposalId);
      return record?.external_id === _externalId ? record : null;
    },
    async writeRecord(value, options) {
      const record = ReviewPullRecordSchema.parse(value);
      if (record.base_url !== target.server_url || record.org_id !== target.org_id)
        throw new ProjectDatabaseError(
          'AUTHORITY_MISMATCH',
          'The Source Plan review record belongs to another authenticated target'
        );
      const kind = record.target;
      const subjectId = reviewSubject(record);
      const scope = readNamespace();
      const current = readProjectSourcePlanReview(reader, {
        namespaceId: scope.namespaceId,
        kind,
        subjectId,
      });
      assertNoSecretsInPayload({ namespace: scope, record }, secretAllow);
      if (options?.preserveEquivalent) {
        const admission = input.publicationAdmission?.();
        if (!admission)
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'Source Plan review mutation is missing its retained publication admission'
          );
        if (
          canonicalJson(admission.target) !== canonicalJson(target) ||
          !isDeepStrictEqual(admission.namespace, scope)
        )
          throw new ProjectDatabaseError(
            'AUTHORITY_MISMATCH',
            'The Source Plan review publication admission belongs to another target'
          );
        const request =
          admission.method === 'sourcePlan.reviewPush'
            ? OssSourcePlanReviewPush.parse(admission.request)
            : OssSourcePlanReviewPropose.parse(admission.request);
        if (
          record.external_id !== request.external_id ||
          (admission.method === 'sourcePlan.reviewPush' && record.target !== 'candidate') ||
          (admission.method === 'sourcePlan.reviewPropose' && record.target !== 'proposal')
        )
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            'The Source Plan review response differs from its retained publication admission'
          );
        const retainedRecord = ReviewPullRecordSchema.parse({
          ...record,
          external_id: request.external_id,
          content_hash: request.content_hash,
          body: request.body,
          base_url: admission.target.server_url,
          org_id: admission.target.org_id,
          pulled_at: admission.publicationAt,
        });
        const retainedKind = retainedRecord.target;
        const retainedSubject = reviewSubject(retainedRecord);
        const identity = {
          admissionOperationId: admission.operationId,
          kind: retainedKind,
          subjectId: retainedSubject,
        };
        const publication = {
          operationId: derivedId(projectId, 'source_plan.review.publication', identity),
          recordId: derivedId(projectId, 'source_plan.review.record', identity),
          namespace: admission.namespace,
          kind: retainedKind,
          expectedSelection:
            retainedKind === 'candidate' ? admission.expectedCandidateSelection : null,
          recordBytes: Buffer.from(canonicalJson(retainedRecord) + '\n', 'utf8'),
        };
        if (readProjectSourcePlanRecordPublication(reader, publication)) return;
        const writer = await input.openWriter();
        try {
          await publishProjectSourcePlanRecord(writer, publication, {
            secretAllow,
            onWait: input.onWait,
          });
        } finally {
          writer.close();
        }
        return;
      }
      const recordBytes = Buffer.from(canonicalJson(record) + '\n', 'utf8');
      const replay =
        current &&
        Buffer.from(current.record.recordBase64, 'base64').equals(recordBytes) &&
        isDeepStrictEqual(current.record.namespace, scope)
          ? current.record
          : null;
      const identity = {
        target,
        kind,
        subjectId,
        expectedSelection: current?.selection ?? null,
        record,
      };
      const writer = await input.openWriter();
      try {
        await publishProjectSourcePlanRecord(
          writer,
          {
            operationId:
              replay?.operationId ?? derivedId(projectId, 'source_plan.review.operation', identity),
            recordId:
              replay?.recordId ?? derivedId(projectId, 'source_plan.review.record', identity),
            namespace: scope,
            kind,
            expectedSelection: replay ? replay.expectedSelection : (current?.selection ?? null),
            recordBytes,
          },
          { secretAllow, signal: input.signal, onWait: input.onWait }
        );
      } finally {
        writer.close();
      }
    },
    async readRefAliases(ref) {
      const rows = reader.read((view) =>
        view.all<RefAliasRow>(
          `SELECT intent_change AS intentChange,target_json AS targetJson,
          payload_json AS payloadJson,payload_hash AS payloadHash,
          expected_state_json AS expectedJson,result_json AS resultJson FROM operations
          WHERE operation_kind='source_plan.review.alias'
            AND json_extract(target_json,'$.ref')=?
            AND json_extract(target_json,'$.target.server_url')=?
            AND json_extract(target_json,'$.target.org_id')=?
            AND json_extract(target_json,'$.target.account_id')=?
          ORDER BY committed_write_sequence DESC`,
          ref,
          target.server_url,
          target.org_id,
          target.account_id
        )
      ).value;
      const found = new Map<string, string>();
      for (const row of rows) {
        try {
          if (
            row.intentChange !== 0 ||
            row.expectedJson !== 'null' ||
            row.payloadHash !== sha256Hex(row.payloadJson)
          )
            continue;
          const retainedTarget = refAliasTarget.parse(parseCanonical(row.targetJson));
          const payload = refAliasPayload.parse(parseCanonical(row.payloadJson));
          if (
            retainedTarget.ref !== ref ||
            canonicalJson(retainedTarget.target) !== canonicalJson(target) ||
            canonicalJson(parseCanonical(row.resultJson)) !== canonicalJson({ recorded: true })
          )
            continue;
          // Rows arrive newest-written first, so `>` breaks a tie by write order.
          const seen = found.get(payload.external_id);
          if (seen === undefined || payload.pulled_at > seen)
            found.set(payload.external_id, payload.pulled_at);
        } catch {
          continue;
        }
      }
      return [...found].map(([externalId, pulledAt]) => ({ externalId, pulledAt }));
    },
    async writeRefAlias(alias) {
      const targetValue = { ref: alias.ref, target };
      const payload = { external_id: alias.externalId, pulled_at: alias.pulledAt };
      assertNoSecretsInPayload({ target: targetValue, payload }, secretAllow);
      const writer = await input.openWriter();
      try {
        // The instant is part of the identity so every pull appends; keying on
        // ref + id alone replays, freezing the mapping at first-seen.
        await runProjectOperation(
          writer,
          {
            operationId: derivedId(projectId, 'source_plan.review.alias', {
              ...targetValue,
              externalId: alias.externalId,
              pulledAt: alias.pulledAt,
            }),
            kind: 'source_plan.review.alias',
            target: targetValue,
            payload,
            expectedState: null,
            intentChange: false,
          },
          () => ({ recorded: true }),
          { signal: input.signal, onWait: input.onWait }
        );
      } finally {
        writer.close();
      }
    },
  };
}
