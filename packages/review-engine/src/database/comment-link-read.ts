import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  type ProjectCounters,
  ProjectDatabaseError,
  type ProjectReadView,
} from '@orcaops/storage/history/database';

import {
  commentClaimEndpointSchema,
  commentClaimLinkSourceSchema,
} from './comment-link-records.js';
import { resolveReviewCommentLink } from './comment-link-targets.js';
import { decodeRetainedReviewJson } from './records.js';
import {
  authoritySchema,
  integrity,
  revisionId,
  text,
  validate,
  withReviewDatabase,
} from './request.js';
import { selection } from './reviews.js';

const listSchema = z.strictObject({ authority: authoritySchema, reviewId: revisionId });
const readSchema = listSchema.extend({ linkId: revisionId });
const targetSchema = z.strictObject({ reviewId: revisionId, linkId: revisionId });
const payloadSchema = z.strictObject({
  commentId: text,
  commentRevisionId: revisionId,
  endpoint: commentClaimEndpointSchema,
  source: commentClaimLinkSourceSchema,
});
const resultSchema = targetSchema.extend({ commentId: text, commentRevisionId: revisionId });
interface LinkRow {
  link_id: string;
  review_id: string;
  comment_id: string;
  comment_revision_id: string;
  operation_id: string;
  endpoint_json: string;
  source_json: string;
}
interface LinkOperation {
  operation_id: string;
  operation_kind: string;
  intent_change: number;
  target_json: string;
  payload_json: string;
  payload_hash: string;
  expected_state_json: string;
  result_json: string;
  committed_write_sequence: number;
  committed_intent_counter: number;
}
export function snapshotReviewCommentLinks(
  view: ProjectReadView,
  reviewId: string,
  linkId?: string
) {
  selection(view, reviewId);
  const links = view.all<LinkRow>(
    `SELECT * FROM review_comment_claim_links WHERE review_id = ?${linkId === undefined ? '' : ' AND link_id = ?'} ORDER BY link_id`,
    ...[reviewId, ...(linkId === undefined ? [] : [linkId])]
  );
  const operations = view.all<LinkOperation>(
    `SELECT * FROM operations WHERE operation_kind = 'review.comment.link' AND json_extract(target_json, '$.reviewId') = ?${linkId === undefined ? '' : " AND json_extract(target_json, '$.linkId') = ?"} ORDER BY committed_write_sequence`,
    ...[reviewId, ...(linkId === undefined ? [] : [linkId])]
  );
  return { reviewId, linkId: linkId ?? null, links, operations };
}

export function decodeReviewCommentLinks(snapshot: {
  value: ReturnType<typeof snapshotReviewCommentLinks>;
  counters: ProjectCounters;
}) {
  const { links, operations, reviewId, linkId } = snapshot.value;
  const byOperation = new Map(links.map((link) => [link.operation_id, link]));
  if (byOperation.size !== links.length || links.length !== operations.length)
    integrity(
      'Retained comment links and original receipts differ; preserve history for explicit repair'
    );
  const prepared = operations.map((operation) => {
    const row = byOperation.get(operation.operation_id);
    if (!row) integrity('A committed comment link is missing; restore its exact retained record');
    const target = decodeRetainedReviewJson(targetSchema, Buffer.from(operation.target_json)).value;
    const payload = decodeRetainedReviewJson(
      payloadSchema,
      Buffer.from(operation.payload_json)
    ).value;
    const result = decodeRetainedReviewJson(resultSchema, Buffer.from(operation.result_json)).value;
    const endpoint = decodeRetainedReviewJson(
      commentClaimEndpointSchema,
      Buffer.from(row.endpoint_json)
    ).value;
    const source = decodeRetainedReviewJson(
      commentClaimLinkSourceSchema,
      Buffer.from(row.source_json)
    ).value;
    const expected = decodeRetainedReviewJson(
      z.null(),
      Buffer.from(operation.expected_state_json)
    ).value;
    if (
      row.review_id !== reviewId ||
      (linkId !== null && row.link_id !== linkId) ||
      target.reviewId !== reviewId ||
      target.linkId !== row.link_id ||
      source.eventId !== row.link_id ||
      payload.commentId !== row.comment_id ||
      payload.commentRevisionId !== row.comment_revision_id ||
      !isDeepStrictEqual(payload.endpoint, endpoint) ||
      !isDeepStrictEqual(payload.source, source) ||
      !isDeepStrictEqual(result, {
        reviewId,
        linkId: row.link_id,
        commentId: row.comment_id,
        commentRevisionId: row.comment_revision_id,
      }) ||
      operation.operation_kind !== 'review.comment.link' ||
      operation.intent_change !== 1 ||
      expected !== null ||
      operation.payload_hash !==
        createHash('sha256').update(operation.payload_json).digest('hex') ||
      operation.committed_write_sequence > snapshot.counters.writeSequence ||
      operation.committed_intent_counter > snapshot.counters.intentChangeCounter
    )
      integrity(
        'The retained comment link differs from its original operation identity or receipt'
      );
    return { row, endpoint, source, operation };
  });
  return {
    value: {
      reviewId,
      links: prepared.map(({ row, endpoint, source, operation }) => ({
        linkId: row.link_id,
        operationId: row.operation_id,
        commentId: row.comment_id,
        commentRevisionId: row.comment_revision_id,
        endpoint,
        source,
        committedCounters: {
          writeSequence: operation.committed_write_sequence,
          intentChangeCounter: operation.committed_intent_counter,
        },
      })),
    },
    counters: snapshot.counters,
  };
}

export async function listDatabaseReviewCommentLinks(raw: z.infer<typeof listSchema>) {
  const input = validate(listSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    decodeReviewCommentLinks(
      database.read((view) => snapshotReviewCommentLinks(view, input.reviewId))
    )
  );
}
export async function readDatabaseReviewCommentLink(raw: z.infer<typeof readSchema>) {
  const input = validate(readSchema, raw);
  return withReviewDatabase(input.authority, 'reader', async (database) => {
    const result = decodeReviewCommentLinks(
      database.read((view) => snapshotReviewCommentLinks(view, input.reviewId, input.linkId))
    );
    const link = result.value.links[0];
    if (!link) return { value: null, counters: result.counters };
    try {
      const resolved = await resolveReviewCommentLink(database, {
        authority: input.authority,
        reviewId: input.reviewId,
        commentId: link.commentId,
        commentRevisionId: link.commentRevisionId,
        endpoint: link.endpoint,
      });
      return {
        value: { ...link, comment: resolved.comment, target: resolved.value },
        counters: result.counters,
      };
    } catch (cause) {
      if (
        cause instanceof ProjectDatabaseError &&
        (cause.code === 'INVALID_INPUT' || cause.code === 'STALE_CONTEXT')
      )
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The retained link no longer resolves to its original evidence; preserve history for explicit repair',
          { cause }
        );
      throw cause;
    }
  });
}
