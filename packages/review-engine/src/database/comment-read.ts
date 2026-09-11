import { z } from 'zod';

import { replayComments } from '@orcaops/review-core';
import { type ProjectReadView } from '@orcaops/storage/history/database';

import { type CommentRevisionRow, hydrateReviewComment } from './comments.js';
import { authoritySchema, integrity, revisionId, validate, withReviewDatabase } from './request.js';
import { selection } from './reviews.js';

const listSchema = z.strictObject({ authority: authoritySchema, reviewId: revisionId });
export type ListDatabaseReviewComments = z.infer<typeof listSchema>;

export function snapshotReviewComments(view: ProjectReadView, reviewId: string) {
  selection(view, reviewId);
  const headers = view.all<{ comment_id: string; current_revision_id: string; version: number }>(
    'SELECT comment_id, current_revision_id, version FROM review_comments WHERE review_id = ? ORDER BY comment_id',
    reviewId
  );
  const rows = view.all<CommentRevisionRow & { comment_id: string }>(
    'SELECT comment_id, revision_id, previous_revision_id, version, operation_id, hex(record_bytes) AS record_bytes, record_hash, basis_json, source_json FROM review_comment_revisions WHERE review_id = ? ORDER BY comment_id, version',
    reviewId
  );
  const groups = new Map<string, CommentRevisionRow[]>();
  for (const row of rows) {
    const group = groups.get(row.comment_id) ?? [];
    group.push(row);
    groups.set(row.comment_id, group);
  }
  const known = new Set(headers.map((header) => header.comment_id));
  if ([...groups.keys()].some((commentId) => !known.has(commentId)))
    integrity(
      'Retained comment revisions have no current selection; preserve history for explicit repair'
    );
  return {
    reviewId,
    heads: headers.map((header) => ({
      commentId: header.comment_id,
      revisionId: header.current_revision_id,
      version: header.version,
    })),
    comments: headers.map((header) => ({
      commentId: header.comment_id,
      selected: { revision_id: header.current_revision_id, version: header.version },
      rows: groups.get(header.comment_id) ?? [],
    })),
  };
}

export function hydrateReviewComments(snapshot: ReturnType<typeof snapshotReviewComments>) {
  const details = snapshot.comments.map((comment) =>
    hydrateReviewComment({ reviewId: snapshot.reviewId, commentId: comment.commentId }, comment)
  );
  const byId = new Map(details.map((detail) => [detail.commentId, detail]));
  const ordered = replayComments(
    details.flatMap((detail) => detail.revisions.map((revision) => revision.event))
  );
  return {
    reviewId: snapshot.reviewId,
    heads: snapshot.heads,
    comments: ordered.map((comment) => byId.get(comment.comment_id)!),
  };
}

export async function listDatabaseReviewComments(raw: ListDatabaseReviewComments) {
  const input = validate(listSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) => {
    const snapshot = database.read((view) => snapshotReviewComments(view, input.reviewId));
    return { value: hydrateReviewComments(snapshot.value), counters: snapshot.counters };
  });
}
