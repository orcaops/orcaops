import { z } from 'zod';

import { type CommentEvent, commentEventSchema } from '@orcaops/review-core';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import { type ProjectOperationOptions } from '@orcaops/storage/history/database';

import { appendDatabaseReviewCommentEvents } from './comment-events.js';
import { createDatabaseReviewComment } from './comments.js';
import { readDatabaseReviewContext } from './read-context.js';
import { integrity, invalid, revisionId, text, validate } from './request.js';
import {
  deriveReviewOperationId,
  readRetainedReviewOperation,
  replayRetainedReviewOperation,
  type RetainedReviewOperation,
  reviewOperationConflict,
} from './review-operation.js';
import { resolveDatabaseReviewAuthority } from './source-scope.js';

const requestSchema = z.strictObject({
  branch: text.refine((value) => Boolean(value.trim()) && !/[\0\r\n]/u.test(value)),
  cwd: text,
  projectId: revisionId.optional(),
  dataRoot: text.optional(),
  operationId: revisionId,
  events: z.array(commentEventSchema).min(1),
  secretAllow: z.array(z.string()),
});
export type ApplyDatabaseReviewComments = Omit<z.infer<typeof requestSchema>, 'events'> & {
  events: CommentEvent[];
};

function bytes(event: CommentEvent): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(`${JSON.stringify(event, null, 2)}\n`));
}

/** The label the batch tail's derived child operation identity carries. */
const APPEND_OPERATION = 'review.comment.append';

function decodeRetainedEvent(value: unknown, field: string): CommentEvent {
  if (typeof value !== 'string')
    integrity(`The original comment receipt lost its ${field}; preserve it for repair`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    integrity(`The original comment receipt has an unreadable ${field}; preserve it for repair`);
  }
  const result = commentEventSchema.safeParse(parsed);
  if (!result.success)
    integrity(`The original comment receipt has an unreadable ${field}; preserve it for repair`);
  return result.data;
}

/**
 * The authored content of a comment event, without the identities the caller
 * mints per invocation. A retried `review comment add` mints a fresh
 * `comment_id` and timestamp, so comparing those would refuse every honest
 * retry; what the reviewer authored is the body, the author and the anchor.
 */
function authoredComment(event: CommentEvent, withIdentity: boolean): string {
  const { comment_id, ts: _ts, ...authored } = event;
  return canonicalJson(withIdentity ? { comment_id, ...authored } : authored);
}

function requireOriginalComments(
  original: RetainedReviewOperation,
  events: readonly CommentEvent[]
): void {
  if (original.kind === 'review.comment.add') {
    const retained = decodeRetainedEvent(original.payload.commentBytes, 'authored comment');
    if (authoredComment(retained, false) !== authoredComment(events[0]!, false))
      reviewOperationConflict();
    return;
  }
  const retained = original.payload.events;
  if (!Array.isArray(retained) || retained.length !== events.length) reviewOperationConflict();
  if (original.target.commentId !== events[0]!.comment_id) reviewOperationConflict();
  retained.forEach((entry, index) => {
    const event = decodeRetainedEvent((entry as { bytes?: unknown }).bytes, 'authored revision');
    if (authoredComment(event, true) !== authoredComment(events[index]!, true))
      reviewOperationConflict();
  });
}

/**
 * Append an authored comment batch to the review's retained comments.
 *
 * An `add` mints the comment against the selected floor and membership; every
 * other event is an append-only revision on the continuing comment identity, so
 * a reply that also resolves settles both revisions under one operation. The
 * comment identity is the author's original `comment_id` — it is never
 * reassigned.
 */
export async function applyDatabaseReviewComments(
  raw: ApplyDatabaseReviewComments,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(requestSchema, raw);
  const first = input.events[0]!;
  if (input.events.some((event) => event.comment_id !== first.comment_id))
    invalid('A comment batch settles one comment identity');
  if (input.events.some((event, index) => index > 0 && event.type === 'add'))
    invalid('Only the first event of a batch may create a comment');

  // Receipt first, before the review is selected and before any writer: an
  // authored batch whose response was lost replays under its original identity
  // instead of retaining a second comment or a second revision.
  const authority = await resolveDatabaseReviewAuthority({
    cwd: input.cwd,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
  const appendOperationId =
    first.type === 'add'
      ? deriveReviewOperationId(input.operationId, APPEND_OPERATION)
      : input.operationId;
  const committed = await readRetainedReviewOperation({
    authority,
    operationId: input.operationId,
    kinds: ['review.comment.add', 'review.comment.append'],
  });
  if (committed.value) {
    requireOriginalComments(committed.value, input.events);
    // An append-only batch settled whole under the caller's identity; an add with
    // no tail did too. Replay it.
    if (committed.value.kind === 'review.comment.append' || input.events.length === 1)
      return replayRetainedReviewOperation<
        Awaited<ReturnType<typeof appendDatabaseReviewCommentEvents>>['value']
      >(committed.value);
    // An add-plus-revisions batch settles its add under the caller's identity and
    // its tail under the derived append identity. Replay the tail by that identity
    // rather than minting a fresh continuation against the advanced comment head,
    // which would conflict with the retained append instead of replaying it. When
    // the tail never settled (interrupted between the two), fall through to it.
    const committedTail = await readRetainedReviewOperation({
      authority,
      operationId: appendOperationId,
      kinds: ['review.comment.append'],
    });
    if (committedTail.value) {
      requireOriginalComments(committedTail.value, input.events.slice(1));
      return replayRetainedReviewOperation<
        Awaited<ReturnType<typeof appendDatabaseReviewCommentEvents>>['value']
      >(committedTail.value);
    }
  }

  const context = await readDatabaseReviewContext({
    branch: input.branch,
    cwd: input.cwd,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
  if (context.floor === null)
    invalid(`no selected floor for '${input.branch}'; run review data first`);

  // A reply that names a checkpoint is a claim about the reviewed set, so the
  // append is pinned to the selection that set belongs to; the append refuses a
  // membership target supplied for a batch that names none.
  const namesCheckpoint = input.events.some(
    (event) => event.type === 'reply' && event.checkpoint_ref !== undefined
  );
  const membership = namesCheckpoint
    ? {
        revisionId: context.selection.membership_revision_id,
        version: context.selection.membership_version,
      }
    : null;

  if (first.type === 'add' && !committed.value) {
    const created = await createDatabaseReviewComment(
      {
        authority: context.authority,
        reviewId: context.reviewId,
        operationId: input.operationId,
        revisionId: uuidv7(),
        floorPublicationId: context.floor.publicationId,
        expected: {
          floorVersion: context.selection.floor_version,
          membershipRevisionId: context.selection.membership_revision_id,
        },
        commentBytes: bytes(first),
        gitRoot: input.cwd,
        secretAllow: input.secretAllow,
      },
      options
    );
    const rest = input.events.slice(1);
    if (rest.length === 0) return created;
    return appendDatabaseReviewCommentEvents(
      {
        authority: context.authority,
        reviewId: context.reviewId,
        operationId: appendOperationId,
        commentId: first.comment_id,
        expected: { revisionId: created.value.revisionId, version: created.value.version },
        membership,
        events: rest.map((event) => ({ revisionId: uuidv7(), bytes: bytes(event) })),
        secretAllow: input.secretAllow,
      },
      options
    );
  }

  // The retained add gives the tail its identity: a replayed add carries the
  // original comment, so the tail continues from that comment's current head.
  const commentId = committed.value
    ? (committed.value.target.commentId as string)
    : first.comment_id;
  const tail = committed.value ? input.events.slice(1) : input.events;
  const head = context.comments.heads.find((entry) => entry.commentId === commentId);
  if (!head) invalid(`unknown comment id '${commentId}'`);
  return appendDatabaseReviewCommentEvents(
    {
      authority: context.authority,
      reviewId: context.reviewId,
      operationId: appendOperationId,
      commentId,
      expected: { revisionId: head.revisionId, version: head.version },
      membership,
      events: tail.map((event) => ({
        revisionId: uuidv7(),
        bytes: bytes({ ...event, comment_id: commentId }),
      })),
      secretAllow: input.secretAllow,
    },
    options
  );
}
