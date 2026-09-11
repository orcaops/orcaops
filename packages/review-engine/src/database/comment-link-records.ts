import { z } from 'zod';

import { COMMENT_AUTHOR } from '@orcaops/review-core';

import {
  cancelled,
  operationFields,
  revisionId,
  scanMetadata,
  text,
  validate,
  version,
} from './request.js';

const artifactRevisionSchema = z.strictObject({
  generation: version.min(1),
  orderedHash: z.string().regex(/^[0-9a-f]{64}$/),
  eventCount: version.min(1),
  byteLength: version.min(1),
  tailEventId: revisionId,
});
export const commentClaimEndpointSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('run-ledger-entry'),
    runId: text,
    runRevisionId: revisionId,
    inputPublicationId: revisionId,
    ledgerEntryId: text,
  }),
  z.strictObject({
    kind: z.literal('captured-occurrence'),
    membershipRevisionId: revisionId,
    artifactId: revisionId,
    artifactRevision: artifactRevisionSchema,
    sourceEventId: revisionId,
    fieldPath: z.literal('/done_criteria'),
    position: version,
  }),
]);
export type CommentClaimEndpoint = z.infer<typeof commentClaimEndpointSchema>;

export const commentClaimLinkSourceSchema = z.strictObject({
  kind: z.literal('authored'),
  eventId: revisionId,
  fieldPath: z.literal('link'),
  position: z.literal(0),
  actor: z.enum(COMMENT_AUTHOR),
  at: z.iso.datetime({ offset: true }),
});
export const commentClaimLinkSchema = z.strictObject({
  linkId: revisionId,
  reviewId: revisionId,
  commentId: text,
  commentRevisionId: revisionId,
  endpoint: commentClaimEndpointSchema,
  actor: z.enum(COMMENT_AUTHOR),
  at: z.iso.datetime({ offset: true }),
});
export const commentClaimLinkRequestSchema = commentClaimLinkSchema.extend(operationFields);
export type PrepareReviewCommentLink = z.infer<typeof commentClaimLinkRequestSchema>;

export function prepareReviewCommentLink(
  raw: PrepareReviewCommentLink,
  options: { signal?: AbortSignal } = {}
) {
  const signal = options.signal;
  const input = validate(commentClaimLinkRequestSchema, raw);
  scanMetadata(input, input.secretAllow);
  cancelled(signal);
  const source = validate(commentClaimLinkSourceSchema, {
    kind: 'authored',
    eventId: input.linkId,
    fieldPath: 'link',
    position: 0,
    actor: input.actor,
    at: input.at,
  });
  return { input, source };
}
