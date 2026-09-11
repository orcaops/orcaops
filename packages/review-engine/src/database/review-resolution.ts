import { z } from 'zod';

import { HistoryScopeError } from '@orcaops/project-scope/history/database';
import { uuidv7 } from '@orcaops/storage';
import {
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';

import { decodeRetainedReviewJson } from './records.js';
import {
  authoritySchema,
  cancelled,
  integrity,
  invalid,
  revisionId,
  scanMetadata,
  text,
  validate,
  version,
  withReviewDatabase,
} from './request.js';
import { selectDatabaseReview } from './review-selection.js';
import {
  changeDatabaseReviewMembership,
  createDatabaseReview,
  membershipSchema,
  retainedMemberSchema,
  selection,
} from './reviews.js';

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const resolutionKinds = ['review.create', 'review.membership'] as const;
const resultSchema = z.strictObject({
  reviewId: revisionId,
  membershipRevisionId: revisionId,
  membershipVersion: version.refine((value) => value > 0),
});
const requestSchema = z.strictObject({
  authority: authoritySchema,
  operationId: revisionId,
  branch: text.refine((value) => Boolean(value.trim()) && !/[\0\r\n]/u.test(value)),
  members: z.array(retainedMemberSchema),
  reviewId: revisionId.optional(),
  initialContext: z.strictObject({
    worktreeId: revisionId.nullable(),
    baseSha: objectId.nullable(),
    headSha: objectId.nullable(),
  }),
  secretAllow: z.array(z.string()),
});
export type ResolveDatabaseReviewForBranch = z.infer<typeof requestSchema>;
export interface DatabaseReviewResolution extends z.infer<typeof resultSchema> {
  /** `created` mints the review, `refreshed` moves membership, `retained` writes nothing. */
  outcome: 'created' | 'refreshed' | 'retained';
  /** The result came from the original operation receipt rather than a new settlement. */
  replayed: boolean;
}

function bytes(value: unknown): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}
function sortedMembers(members: readonly z.infer<typeof retainedMemberSchema>[]) {
  return [...members].sort((left, right) => (left.artifactId < right.artifactId ? -1 : 1));
}
function sameMembers(
  left: readonly z.infer<typeof retainedMemberSchema>[],
  right: readonly z.infer<typeof retainedMemberSchema>[]
): boolean {
  if (left.length !== right.length) return false;
  const a = sortedMembers(left);
  const b = sortedMembers(right);
  return a.every(
    (member, index) =>
      member.artifactId === b[index]!.artifactId &&
      member.generation === b[index]!.generation &&
      member.orderedHash === b[index]!.orderedHash
  );
}

/**
 * Read the original receipt for a resolution operation ID. A retry mints a
 * fresh review identity, so its payload differs from the committed one and the
 * operation layer would refuse the replay as a conflict — the original result
 * has to be read back instead.
 */
export async function readDatabaseReviewResolution(raw: {
  authority: ProjectDatabaseAuthority;
  operationId: string;
}) {
  const input = validate(
    z.strictObject({ authority: authoritySchema, operationId: revisionId }),
    raw
  );
  return withReviewDatabase(input.authority, 'reader', (database) => {
    const retained = database.read((view) =>
      view.get<{ operation_kind: string; result_json: string }>(
        'SELECT operation_kind, result_json FROM operations WHERE operation_id = ?',
        input.operationId
      )
    );
    const row = retained.value;
    if (!row) return { value: null, counters: retained.counters };
    if (!(resolutionKinds as readonly string[]).includes(row.operation_kind))
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'This operation identity belongs to another authored action; retain its original action or explicitly choose a new operation'
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.result_json);
    } catch {
      integrity('The original review resolution receipt is unreadable; preserve it for repair');
    }
    const result = resultSchema.safeParse(parsed);
    if (!result.success)
      integrity('The original review resolution receipt lost its retained identities');
    return {
      value: { ...result.data, kind: row.operation_kind as (typeof resolutionKinds)[number] },
      counters: retained.counters,
    };
  });
}

/**
 * Select the branch's retained review, or mint one, and keep its membership on
 * the branch's exact retained artifact revisions.
 *
 * Every switched review verb needs a review row and a membership revision
 * before it can prepare or publish anything: floor preparation derives the
 * whole floor from the retained membership, and `selectDatabaseReview` refuses
 * when no review is retained. Ambiguity is never resolved here — two reviews on
 * one branch require an explicit selection.
 */
export async function resolveDatabaseReviewForBranch(
  raw: ResolveDatabaseReviewForBranch,
  options: ProjectOperationOptions = {}
): Promise<DatabaseReviewResolution> {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(requestSchema, raw);
  if (new Set(input.members.map((member) => member.artifactId)).size !== input.members.length)
    invalid('Review membership cannot repeat an artifact');
  scanMetadata(
    { authority: input.authority, branch: input.branch, initialContext: input.initialContext },
    input.secretAllow
  );
  cancelled(options.signal);

  const original = await readDatabaseReviewResolution({
    authority: input.authority,
    operationId: input.operationId,
  });
  if (original.value)
    return {
      reviewId: original.value.reviewId,
      membershipRevisionId: original.value.membershipRevisionId,
      membershipVersion: original.value.membershipVersion,
      outcome: original.value.kind === 'review.create' ? 'created' : 'refreshed',
      replayed: true,
    };
  cancelled(options.signal);

  const retained = await withReviewDatabase(input.authority, 'reader', (database) =>
    database.read((view) => {
      let reviewId: string;
      try {
        reviewId = selectDatabaseReview(view, input, input.authority.projectId);
      } catch (cause) {
        if (cause instanceof HistoryScopeError && cause.code === 'REVIEW_NOT_FOUND') return null;
        throw cause;
      }
      const current = selection(view, reviewId);
      const membership = view.get<{ bytes: string; hash: string }>(
        'SELECT hex(record_bytes) AS bytes, record_hash AS hash FROM review_membership_revisions WHERE review_id = ? AND revision_id = ?',
        reviewId,
        current.membership_revision_id
      );
      const branch = view.get<{ branch: string | null }>(
        'SELECT branch FROM reviews WHERE review_id = ?',
        reviewId
      );
      return { reviewId, current, membership, branch: branch?.branch ?? null };
    })
  );

  if (retained.value === null) {
    if (input.reviewId !== undefined)
      throw new HistoryScopeError(
        'REVIEW_NOT_FOUND',
        'The exact review is not retained in the selected project'
      );
    const reviewId = uuidv7();
    const membershipRevisionId = uuidv7();
    const created = await createDatabaseReview(
      {
        authority: input.authority,
        operationId: input.operationId,
        secretAllow: input.secretAllow,
        identityBytes: bytes({
          schema_version: 1,
          review_id: reviewId,
          project_id: input.authority.projectId,
          store_instance_id: input.authority.storeInstanceId,
          repository_instance_id: input.authority.repositoryInstanceId,
          created_by_operation: input.operationId,
          initial_context: {
            worktree_id: input.initialContext.worktreeId,
            branch: input.branch,
            base_sha: input.initialContext.baseSha,
            head_sha: input.initialContext.headSha,
          },
          artifact_ids: input.members.map((member) => member.artifactId),
          legacy_source_ids: [],
        }),
        membershipBytes: bytes({
          revisionId: membershipRevisionId,
          members: input.members,
          source: null,
        }),
      },
      options
    );
    return { ...created.value, outcome: 'created', replayed: created.replayed };
  }

  const { reviewId, current, membership, branch } = retained.value;
  if (input.reviewId !== undefined && branch !== null && branch !== input.branch)
    throw new HistoryScopeError(
      'REVIEW_CONTEXT_MISMATCH',
      'The exact review does not belong to the requested branch; retain its original identity'
    );
  if (!membership) integrity('Selected review membership is missing; preserve history for repair');
  const record = decodeRetainedReviewJson(membershipSchema, Buffer.from(membership.bytes, 'hex'));
  if (
    record.sha256 !== membership.hash ||
    record.value.revisionId !== current.membership_revision_id
  )
    integrity('Retained review membership differs from its selection; preserve history for repair');
  if (sameMembers(record.value.members, input.members))
    return {
      reviewId,
      membershipRevisionId: current.membership_revision_id,
      membershipVersion: current.membership_version,
      outcome: 'retained',
      replayed: false,
    };
  cancelled(options.signal);
  const refreshed = await changeDatabaseReviewMembership(
    {
      authority: input.authority,
      operationId: input.operationId,
      secretAllow: input.secretAllow,
      reviewId,
      membershipBytes: bytes({
        revisionId: uuidv7(),
        members: input.members,
        source: null,
      }),
      expected: {
        revisionId: current.membership_revision_id,
        version: current.membership_version,
      },
    },
    options
  );
  return { ...refreshed.value, outcome: 'refreshed', replayed: refreshed.replayed };
}
