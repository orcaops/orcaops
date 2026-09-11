import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '@orcaops/storage';
import {
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  type ProjectOperation,
  type ProjectOperationOptions,
  type ProjectReadView,
  type ProjectSettlement,
} from '@orcaops/storage/history/database';
import {
  type PreparedReviewRetention,
  readProjectPendingReview,
  selectReviewRetentionRows,
} from '@orcaops/storage/history/database/review-retention';

import { retainDatabaseReviewBase } from './base-retention.js';
import {
  decodeRetainedReviewJson,
  decodeRetainedReviewRecord,
  type PreparedReviewJson,
  prepareReviewJson,
  prepareReviewRecords,
} from './records.js';
import {
  authoritySchema,
  integrity,
  invalid,
  json,
  operationFields,
  performReviewOperation,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
  version,
  withReviewDatabase,
} from './request.js';

export const retainedMemberSchema = z.strictObject({
  artifactId: revisionId,
  generation: version.refine((n) => n > 0),
  orderedHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const sourceOccurrenceSchema = z.strictObject({
  streamId: text,
  ordinal: version.refine((n) => n > 0),
  eventId: text.nullable(),
});
export const membershipSchema = z.strictObject({
  revisionId,
  members: z
    .array(retainedMemberSchema)
    .refine(
      (members) => new Set(members.map((member) => member.artifactId)).size === members.length
    ),
  source: sourceOccurrenceSchema.nullable(),
});
const createSchema = z.strictObject({
  ...operationFields,
  identityBytes: z.instanceof(Uint8Array),
  membershipBytes: z.instanceof(Uint8Array),
});
export type CreateDatabaseReview = z.infer<typeof createSchema>;
export interface ReviewSelection {
  review_id: string;
  membership_revision_id: string;
  base_revision_id: string | null;
  floor_publication_id: string | null;
  current_run_id: string | null;
  story_publication_id: string | null;
  semantic_publication_id: string | null;
  membership_version: number;
  base_version: number;
  floor_version: number;
  run_selection_version: number;
  story_version: number;
  semantic_version: number;
}
export function selection(view: ProjectReadView, reviewId: string): ReviewSelection {
  const row = view.get<ReviewSelection>(
    'SELECT * FROM review_selections WHERE review_id = ?',
    reviewId
  );
  if (!row)
    stale(
      'The exact review does not exist; select an existing review or explicitly create a new one'
    );
  return row;
}
export function validateMembers(
  view: ProjectReadView,
  members: z.infer<typeof retainedMemberSchema>[]
): void {
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.artifactId)) invalid('Review membership cannot repeat an artifact');
    seen.add(member.artifactId);
    const row = view.get<{ ordered_hash: string }>(
      'SELECT ordered_hash FROM artifact_revisions WHERE artifact_id = ? AND generation = ?',
      member.artifactId,
      member.generation
    );
    if (!row || row.ordered_hash !== member.orderedHash)
      stale(
        'The exact member artifact revision is not retained; select its original retained revision in a new operation'
      );
  }
}
function insertMembership(
  tx: ProjectSettlement,
  reviewId: string,
  operationId: string,
  record: PreparedReviewJson<z.infer<typeof membershipSchema>>,
  previous: string | null
): void {
  const membership = record.value;
  validateMembers(tx, membership.members);
  tx.run(
    'INSERT INTO review_membership_revisions VALUES (?, ?, ?, ?, ?, ?)',
    membership.revisionId,
    reviewId,
    previous,
    operationId,
    record.bytes,
    record.sha256
  );
  for (const member of membership.members)
    tx.run(
      'INSERT INTO review_members VALUES (?, ?, ?)',
      membership.revisionId,
      member.artifactId,
      member.generation
    );
}

export async function createDatabaseReview(
  raw: CreateDatabaseReview,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(createSchema, raw);
  const membership = prepareReviewJson(membershipSchema, {
    bytes: input.membershipBytes,
    secretAllow: input.secretAllow,
  });
  const [record] = prepareReviewRecords({
    records: [{ kind: 'identity', bytes: input.identityBytes }],
    secretAllow: input.secretAllow,
  });
  const identity = decodeRetainedReviewRecord({ kind: 'identity', bytes: record!.bytes }).value;
  scanMetadata({ authority: input.authority, membership: membership.value }, input.secretAllow);
  if (
    identity.project_id !== input.authority.projectId ||
    identity.store_instance_id !== input.authority.storeInstanceId ||
    (identity.repository_instance_id !== null &&
      identity.repository_instance_id !== input.authority.repositoryInstanceId)
  )
    invalid('The review identity must name this project and original store/repository authority');
  if (identity.created_by_operation !== input.operationId)
    invalid('New review identity must retain this original creation operation');
  if (
    canonicalJson([...identity.artifact_ids].sort()) !==
    canonicalJson(membership.value.members.map((m) => m.artifactId).sort())
  )
    invalid('Initial exact membership must match the original review identity artifact set');
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.create',
        target: { reviewId: identity.review_id },
        payload: {
          identityBytes: record!.bytes.toString('base64'),
          membershipBytes: membership.bytes.toString('base64'),
        },
        expectedState: null,
        intentChange: false,
      },
      settle(tx) {
        if (tx.get('SELECT review_id FROM reviews WHERE review_id = ?', identity.review_id))
          stale(
            'Review identity already exists; retry its original creation operation or use an explicitly new review identity'
          );
        tx.run(
          'INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?)',
          identity.review_id,
          record!.bytes,
          record!.sha256,
          input.operationId,
          identity.initial_context.branch,
          identity.repository_instance_id
        );
        insertMembership(tx, identity.review_id, input.operationId, membership, null);
        tx.run(
          'INSERT INTO review_selections VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, 1, 0, 0, 0, 0, 0)',
          identity.review_id,
          membership.value.revisionId
        );
        return {
          reviewId: identity.review_id,
          membershipRevisionId: membership.value.revisionId,
          membershipVersion: 1,
        };
      },
    },
    options
  );
}

const membershipRequest = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  membershipBytes: z.instanceof(Uint8Array),
  expected: z.strictObject({ revisionId, version: version.refine((n) => n > 0) }),
});
export type ChangeDatabaseReviewMembership = z.infer<typeof membershipRequest>;
export async function changeDatabaseReviewMembership(
  raw: ChangeDatabaseReviewMembership,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(membershipRequest, raw);
  const membership = prepareReviewJson(membershipSchema, {
    bytes: input.membershipBytes,
    secretAllow: input.secretAllow,
  });
  scanMetadata({ authority: input.authority, expected: input.expected }, input.secretAllow);
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.membership',
        target: { reviewId: input.reviewId },
        payload: { membershipBytes: membership.bytes.toString('base64') },
        expectedState: json(input.expected),
        intentChange: false,
      },
      settle(tx) {
        const current = selection(tx, input.reviewId);
        if (
          current.membership_revision_id !== input.expected.revisionId ||
          current.membership_version !== input.expected.version
        )
          stale(
            'Review membership changed; prepare an explicitly new operation against the intended exact membership'
          );
        insertMembership(
          tx,
          input.reviewId,
          input.operationId,
          membership,
          current.membership_revision_id
        );
        tx.run(
          'UPDATE review_selections SET membership_revision_id = ?, membership_version = membership_version + 1 WHERE review_id = ?',
          membership.value.revisionId,
          input.reviewId
        );
        return {
          reviewId: input.reviewId,
          membershipRevisionId: membership.value.revisionId,
          membershipVersion: current.membership_version + 1,
        };
      },
    },
    options
  );
}
export const baseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('auto'),
    recordedAt: z.iso.datetime(),
    source: sourceOccurrenceSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('explicit'),
    ref: text,
    oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    recordedAt: z.iso.datetime(),
    source: sourceOccurrenceSchema.nullable(),
  }),
]);
const baseRequest = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  revisionId,
  baseBytes: z.instanceof(Uint8Array),
  expectedVersion: version,
  gitRoot: text.optional(),
});
export type ChangeDatabaseReviewBase = z.infer<typeof baseRequest>;
export async function changeDatabaseReviewBase(
  raw: ChangeDatabaseReviewBase,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(baseRequest, raw);
  const base = prepareReviewJson(baseSchema, {
    bytes: input.baseBytes,
    secretAllow: input.secretAllow,
  });
  scanMetadata({ authority: input.authority }, input.secretAllow);
  const operation: ProjectOperation = {
    operationId: input.operationId,
    kind: 'review.base',
    target: { reviewId: input.reviewId },
    payload: { revisionId: input.revisionId, baseBytes: base.bytes.toString('base64') },
    expectedState: input.expectedVersion,
    intentChange: false,
  };
  if (base.value.kind === 'explicit')
    return retainDatabaseReviewBase(input, base, operation, options);
  return performReviewOperation(
    {
      authority: input.authority,
      operation,
      prepareReadOnly: async (database) => {
        if (readProjectPendingReview(database, input.operationId).value)
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            'This operation already admitted an explicit base; retry its original authored input without retargeting'
          );
      },
      settle: (tx) => settleReviewBase(tx, input, base),
    },
    options
  );
}
export function settleReviewBase(
  tx: ProjectSettlement,
  input: ChangeDatabaseReviewBase,
  base: PreparedReviewJson<z.infer<typeof baseSchema>>,
  retention?: { prepared: PreparedReviewRetention; expectedTransitionId: string }
) {
  if (
    !retention &&
    tx.get(
      'SELECT original_operation_id FROM git_retention_operations WHERE original_operation_id = ? UNION ALL SELECT original_operation_id FROM pending_review_requests WHERE original_operation_id = ? LIMIT 1',
      input.operationId,
      input.operationId
    )
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'This operation already admitted external publication input; retry its original authored request without retargeting'
    );
  const current = selection(tx, input.reviewId);
  if (current.base_version !== input.expectedVersion)
    stale(
      'The selected review base changed; prepare a new operation without retargeting the old identity'
    );
  tx.run(
    'INSERT INTO review_base_revisions VALUES (?, ?, ?, ?, ?, ?)',
    input.revisionId,
    input.reviewId,
    current.base_revision_id,
    input.operationId,
    base.bytes,
    base.sha256
  );
  if (retention) selectReviewRetentionRows(tx, retention.prepared, retention.expectedTransitionId);
  tx.run(
    'UPDATE review_selections SET base_revision_id = ?, base_version = base_version + 1 WHERE review_id = ?',
    input.revisionId,
    input.reviewId
  );
  return {
    reviewId: input.reviewId,
    baseRevisionId: input.revisionId,
    baseVersion: current.base_version + 1,
  };
}

const readRequest = z.strictObject({ authority: authoritySchema, reviewId: revisionId });
const reviewChildTables = [
  'review_membership_revisions',
  'review_base_revisions',
  'review_evidence_publications',
  'review_runs',
  'review_run_revisions',
  'review_selections',
  'review_comments',
  'review_comment_revisions',
  'review_workflow_transitions',
  'review_workflow_current',
  'review_comment_claim_links',
  'review_run_finalizations',
  'git_retention_review_targets',
] as const;

export function assertReviewIdentityInventory(view: ProjectReadView): void {
  for (const table of reviewChildTables)
    if (
      view.get(
        `SELECT child.review_id FROM ${table} child LEFT JOIN reviews identity ON identity.review_id = child.review_id WHERE identity.review_id IS NULL LIMIT 1`
      )
    )
      integrity(
        'A retained review child has lost its original identity; preserve history before selecting by branch'
      );
  if (
    view.get(
      "SELECT o.operation_id FROM operations o LEFT JOIN reviews r ON r.review_id = json_extract(o.target_json, '$.reviewId') WHERE o.operation_kind = 'review.create' AND r.review_id IS NULL LIMIT 1"
    )
  )
    integrity(
      'A retained review creation receipt has lost its identity; preserve history before selecting by branch'
    );
}

export function assertNoRetainedReviewIdentity(view: ProjectReadView, reviewId: string): void {
  for (const table of reviewChildTables)
    if (view.get(`SELECT 1 FROM ${table} WHERE review_id = ? LIMIT 1`, reviewId))
      integrity(
        'Retained review history has lost its original identity; preserve all records for explicit repair'
      );
  if (
    view.get(
      "SELECT 1 FROM operations WHERE operation_kind = 'review.create' AND json_extract(target_json, '$.reviewId') = ? LIMIT 1",
      reviewId
    )
  )
    integrity(
      'The original review creation receipt survives without its identity; preserve history for explicit repair'
    );
}

export function snapshotDatabaseReview(view: ProjectReadView, reviewId: string) {
  const row = view.get<{
    identity_hex: string;
    identity_hash: string;
    operation_id: string;
    branch: string | null;
    repository_instance_id: string | null;
  }>(
    'SELECT hex(identity_bytes) AS identity_hex, identity_hash, operation_id, branch, repository_instance_id FROM reviews WHERE review_id = ?',
    reviewId
  );
  if (!row) {
    assertNoRetainedReviewIdentity(view, reviewId);
    return null;
  }
  const current = view.get<ReviewSelection>(
    'SELECT * FROM review_selections WHERE review_id = ?',
    reviewId
  );
  if (!current)
    integrity('The selected review state is missing; preserve history for explicit repair');
  const membership = view.get<{ record_hex: string; record_hash: string }>(
    'SELECT hex(record_bytes) AS record_hex, record_hash FROM review_membership_revisions WHERE revision_id = ? AND review_id = ?',
    current.membership_revision_id,
    reviewId
  );
  if (!membership)
    integrity('The selected review membership is missing; preserve history for explicit repair');
  const operation = view.get<{
    operation_kind: string;
    target_json: string;
    payload_json: string;
    payload_hash: string;
    expected_state_json: string;
    result_json: string;
  }>(
    'SELECT operation_kind, target_json, payload_json, payload_hash, expected_state_json, result_json FROM operations WHERE operation_id = ?',
    row.operation_id
  );
  if (!operation)
    integrity(
      'The original review creation receipt is missing; preserve history for explicit repair'
    );
  const initial = view.get<{ revision_id: string; record_hex: string; record_hash: string }>(
    'SELECT revision_id, hex(record_bytes) AS record_hex, record_hash FROM review_membership_revisions WHERE review_id = ? AND operation_id = ? AND previous_revision_id IS NULL',
    reviewId,
    row.operation_id
  );
  if (!initial)
    integrity('The original review membership is missing; preserve history for explicit repair');
  return { reviewId, row, selection: current, membership, operation, initial };
}

export function hydrateDatabaseReview(
  authority: ProjectDatabaseAuthority,
  snapshot: ReturnType<typeof snapshotDatabaseReview>
) {
  if (snapshot === null) return null;
  const { reviewId, row, selection: current, membership, operation, initial } = snapshot;
  const identity = decodeRetainedReviewRecord({
    kind: 'identity',
    bytes: Buffer.from(row.identity_hex, 'hex'),
  });
  const member = decodeRetainedReviewJson(
    membershipSchema,
    Buffer.from(membership.record_hex, 'hex')
  );
  const initialMember = decodeRetainedReviewJson(
    membershipSchema,
    Buffer.from(initial.record_hex, 'hex')
  );
  const target = decodeRetainedReviewJson(
    z.strictObject({ reviewId: revisionId }),
    Buffer.from(operation.target_json)
  ).value;
  const payload = decodeRetainedReviewJson(
    z.strictObject({ identityBytes: text, membershipBytes: text }),
    Buffer.from(operation.payload_json)
  ).value;
  const result = decodeRetainedReviewJson(
    z.strictObject({
      reviewId: revisionId,
      membershipRevisionId: revisionId,
      membershipVersion: z.literal(1),
    }),
    Buffer.from(operation.result_json)
  ).value;
  if (
    identity.sha256 !== row.identity_hash ||
    member.sha256 !== membership.record_hash ||
    initialMember.sha256 !== initial.record_hash ||
    identity.value.review_id !== reviewId ||
    identity.value.project_id !== authority.projectId ||
    identity.value.store_instance_id !== authority.storeInstanceId ||
    identity.value.repository_instance_id !== row.repository_instance_id ||
    (identity.value.repository_instance_id !== null &&
      identity.value.repository_instance_id !== authority.repositoryInstanceId) ||
    identity.value.initial_context.branch !== row.branch ||
    identity.value.created_by_operation !== row.operation_id ||
    member.value.revisionId !== current.membership_revision_id ||
    initialMember.value.revisionId !== initial.revision_id ||
    operation.operation_kind !== 'review.create' ||
    target.reviewId !== reviewId ||
    operation.expected_state_json !== 'null' ||
    createHash('sha256').update(operation.payload_json).digest('hex') !== operation.payload_hash ||
    payload.identityBytes !== identity.bytes.toString('base64') ||
    payload.membershipBytes !== initialMember.bytes.toString('base64') ||
    result.reviewId !== reviewId ||
    result.membershipRevisionId !== initial.revision_id
  )
    integrity(
      'Retained review identity, membership or original receipt differs from its exact authority; preserve history for explicit repair'
    );
  return {
    identity: identity.value,
    identityBytes: identity.bytes,
    identityHash: identity.sha256,
    selection: current,
    membership: member.value,
    membershipBytes: member.bytes,
    membershipHash: member.sha256,
  };
}

export async function readDatabaseReview(raw: z.infer<typeof readRequest>) {
  const input = validate(readRequest, raw);
  return withReviewDatabase(input.authority, 'reader', (database) => {
    const snapshot = database.read((view) => snapshotDatabaseReview(view, input.reviewId));
    return {
      value: hydrateDatabaseReview(input.authority, snapshot.value),
      counters: snapshot.counters,
    };
  });
}
const listRequest = z.strictObject({
  authority: authoritySchema,
  branch: text.optional(),
  limit: z.number().int().min(1).max(1000),
});
export async function listDatabaseReviews(raw: z.infer<typeof listRequest>) {
  const input = validate(listRequest, raw);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    database.read((view) =>
      view.all<{ review_id: string; branch: string | null; repository_instance_id: string | null }>(
        input.branch === undefined
          ? 'SELECT review_id, branch, repository_instance_id FROM reviews ORDER BY review_id ASC LIMIT ?'
          : 'SELECT review_id, branch, repository_instance_id FROM reviews WHERE branch = ? ORDER BY review_id ASC LIMIT ?',
        ...(input.branch === undefined ? [input.limit] : [input.branch, input.limit])
      )
    )
  );
}
