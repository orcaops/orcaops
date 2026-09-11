import { z } from 'zod';

import { replayComments } from '@orcaops/review-core';
import { canonicalJson } from '@orcaops/storage';
import { type ProjectOperationOptions } from '@orcaops/storage/history/database';

import { commentPreparationSchema, prepareDatabaseReviewComment } from './comment-preparation.js';
import {
  decodeRetainedReviewJson,
  decodeRetainedReviewRecord,
  prepareReviewRecords,
} from './records.js';
import {
  authoritySchema,
  integrity,
  invalid,
  json,
  performReviewOperation,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
  version,
  withReviewDatabase,
} from './request.js';
import { selection } from './reviews.js';

const createSchema = commentPreparationSchema.extend({ operationId: revisionId, revisionId });
export type CreateDatabaseReviewComment = Omit<z.infer<typeof createSchema>, 'commentBytes'> & {
  commentBytes: Uint8Array;
};
export const commentBasisSchema = z.strictObject({
  floorPublicationId: revisionId,
  membershipRevisionId: revisionId,
  floorVersion: version,
  checkpointTarget: z
    .strictObject({
      membershipRevisionId: revisionId,
      membershipVersion: version,
      artifactId: revisionId,
      generation: version,
      orderedHash: z.string().regex(/^[0-9a-f]{64}$/),
      cp: version.refine((value) => value > 0),
    })
    .optional(),
});
const sourceSchema = z.strictObject({
  kind: z.literal('authored'),
  eventId: revisionId,
  fieldPath: text,
  position: version,
});

export async function createDatabaseReviewComment(
  raw: CreateDatabaseReviewComment,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(createSchema, raw);
  const [record] = prepareReviewRecords({
    records: [{ kind: 'comment', bytes: input.commentBytes }],
    secretAllow: input.secretAllow,
  });
  const event = decodeRetainedReviewRecord({ kind: 'comment', bytes: record!.bytes }).value;
  if (event.type !== 'add') invalid('Create comment requires an original add event');
  scanMetadata(
    {
      authority: input.authority,
      reviewId: input.reviewId,
      expected: input.expected,
      floorPublicationId: input.floorPublicationId,
      gitRoot: input.gitRoot,
    },
    input.secretAllow
  );
  const basis = {
    floorPublicationId: input.floorPublicationId,
    membershipRevisionId: input.expected.membershipRevisionId,
    floorVersion: input.expected.floorVersion,
  };
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.comment.add',
        target: { reviewId: input.reviewId, commentId: event.comment_id },
        payload: { revisionId: input.revisionId, commentBytes: record!.bytes.toString('base64') },
        expectedState: json({ ...basis, commentRevisionId: null }),
        intentChange: false,
      },
      async prepareReadOnly() {
        await prepareDatabaseReviewComment(
          {
            authority: input.authority,
            reviewId: input.reviewId,
            floorPublicationId: input.floorPublicationId,
            expected: input.expected,
            commentBytes: record!.bytes,
            secretAllow: input.secretAllow,
            ...(input.gitRoot === undefined ? {} : { gitRoot: input.gitRoot }),
          },
          { signal: options.signal }
        );
      },
      settle(tx) {
        const current = selection(tx, input.reviewId);
        if (
          current.floor_publication_id !== basis.floorPublicationId ||
          current.floor_version !== basis.floorVersion ||
          current.membership_revision_id !== basis.membershipRevisionId
        )
          stale(
            'The selected comment basis changed; preserve this target and prepare a new operation'
          );
        if (
          tx.get(
            'SELECT comment_id FROM review_comments WHERE review_id = ? AND comment_id = ?',
            input.reviewId,
            event.comment_id
          )
        )
          stale(
            'This comment identity already exists; replay its original operation or use its exact revision'
          );
        tx.run(
          'INSERT INTO review_comments VALUES (?, ?, ?, 1)',
          input.reviewId,
          event.comment_id,
          input.revisionId
        );
        tx.run(
          'INSERT INTO review_comment_revisions VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?, ?)',
          input.revisionId,
          input.reviewId,
          event.comment_id,
          input.operationId,
          record!.bytes,
          record!.sha256,
          canonicalJson(basis),
          canonicalJson({
            kind: 'authored',
            eventId: input.revisionId,
            fieldPath: 'comment',
            position: 0,
          })
        );
        return {
          reviewId: input.reviewId,
          commentId: event.comment_id,
          revisionId: input.revisionId,
          version: 1,
          ...basis,
        };
      },
    },
    options
  );
}

const readSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  commentId: text,
  revisionId: revisionId.optional(),
});
export type ReadDatabaseReviewComment = z.infer<typeof readSchema>;
export interface CommentRevisionRow {
  revision_id: string;
  previous_revision_id: string | null;
  version: number;
  operation_id: string;
  record_bytes: string;
  record_hash: string;
  basis_json: string;
  source_json: string;
}

export async function readDatabaseReviewComment(raw: ReadDatabaseReviewComment) {
  const input = validate(readSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) => {
    const snapshot = database.read((view) => {
      selection(view, input.reviewId);
      const header = view.get<{ current_revision_id: string; version: number }>(
        'SELECT current_revision_id, version FROM review_comments WHERE review_id = ? AND comment_id = ?',
        input.reviewId,
        input.commentId
      );
      if (!header) {
        const retained = view.get(
          'SELECT revision_id FROM review_comment_revisions WHERE review_id = ? AND comment_id = ? LIMIT 1',
          input.reviewId,
          input.commentId
        );
        if (retained)
          integrity(
            'The retained comment selection is missing; preserve its revisions for explicit repair'
          );
        return null;
      }
      const selected = view.get<{ revision_id: string; version: number }>(
        'SELECT revision_id, version FROM review_comment_revisions WHERE review_id = ? AND comment_id = ? AND revision_id = ?',
        input.reviewId,
        input.commentId,
        input.revisionId ?? header.current_revision_id
      );
      if (!selected || (input.revisionId === undefined && selected.version !== header.version))
        integrity(
          'The exact selected comment revision is missing; preserve history for explicit repair'
        );
      const rows = view.all<CommentRevisionRow>(
        'SELECT revision_id, previous_revision_id, version, operation_id, hex(record_bytes) AS record_bytes, record_hash, basis_json, source_json FROM review_comment_revisions WHERE review_id = ? AND comment_id = ? AND version <= ? ORDER BY version',
        input.reviewId,
        input.commentId,
        selected.version
      );
      return { rows, selected };
    });
    if (snapshot.value === null) return { value: null, counters: snapshot.counters };
    return { value: hydrateReviewComment(input, snapshot.value), counters: snapshot.counters };
  });
}

export function hydrateReviewComment(
  input: { reviewId: string; commentId: string },
  snapshot: { rows: CommentRevisionRow[]; selected: { revision_id: string; version: number } }
) {
  const { rows, selected } = snapshot;
  if (rows.length !== selected.version || rows.at(-1)?.revision_id !== selected.revision_id)
    integrity('The selected comment revision chain is incomplete; preserve history for repair');
  const revisions = rows.map((row, index) => {
    const record = decodeRetainedReviewRecord({
      kind: 'comment',
      bytes: Buffer.from(row.record_bytes, 'hex'),
    });
    const basis = decodeRetainedReviewJson(commentBasisSchema, Buffer.from(row.basis_json)).value;
    const source = decodeRetainedReviewJson(sourceSchema, Buffer.from(row.source_json)).value;
    const checkpointRef = record.value.type === 'reply' ? record.value.checkpoint_ref : undefined;
    if (
      checkpointRef
        ? !basis.checkpointTarget ||
          checkpointRef.artifact !== basis.checkpointTarget.artifactId ||
          checkpointRef.cp !== basis.checkpointTarget.cp
        : basis.checkpointTarget !== undefined
    )
      integrity('The retained reply checkpoint differs from its exact revision basis');
    if (
      row.version !== index + 1 ||
      row.previous_revision_id !== (index === 0 ? null : rows[index - 1]!.revision_id) ||
      record.sha256 !== row.record_hash ||
      record.value.comment_id !== input.commentId ||
      (index === 0 ? record.value.type !== 'add' : record.value.type === 'add') ||
      source.eventId !== row.revision_id
    )
      integrity(
        'Retained comment bytes, source identity or predecessor differ from their revision'
      );
    return {
      revisionId: row.revision_id,
      previousRevisionId: row.previous_revision_id,
      version: row.version,
      operationId: row.operation_id,
      bytes: record.bytes,
      hash: record.sha256,
      event: record.value,
      basis,
      source,
    };
  });
  const comment = replayComments(revisions.map((revision) => revision.event))[0];
  if (!comment)
    integrity('The retained comment has no original add record; preserve history for repair');
  return {
    reviewId: input.reviewId,
    commentId: input.commentId,
    revisionId: selected.revision_id,
    version: selected.version,
    comment,
    revisions,
  };
}
