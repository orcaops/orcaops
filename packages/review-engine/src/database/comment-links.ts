import { type ProjectOperationOptions } from '@orcaops/storage/history/database';

import { prepareReviewCommentLink, type PrepareReviewCommentLink } from './comment-link-records.js';
import {
  requireReviewCommentLinkTargets,
  type ResolvedReviewCommentLink,
  resolveReviewCommentLink,
} from './comment-link-targets.js';
import { json, performReviewOperation, stale } from './request.js';

export async function linkDatabaseReviewComment(
  raw: PrepareReviewCommentLink,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const { input, source } = prepareReviewCommentLink(raw, options);
  let prepared: ResolvedReviewCommentLink | undefined;
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.comment.link',
        target: { reviewId: input.reviewId, linkId: input.linkId },
        payload: json({
          commentId: input.commentId,
          commentRevisionId: input.commentRevisionId,
          endpoint: input.endpoint,
          source,
        }),
        expectedState: null,
        intentChange: true,
      },
      async prepareReadOnly(database) {
        prepared = await resolveReviewCommentLink(database, input, options.signal);
      },
      settle(tx) {
        if (!prepared)
          stale('The original link preparation is missing; retry its unchanged operation');
        requireReviewCommentLinkTargets(tx, input, prepared.proof);
        if (
          tx.get('SELECT link_id FROM review_comment_claim_links WHERE link_id = ?', input.linkId)
        )
          stale('The link identity is already retained; replay its original operation');
        tx.run(
          'INSERT INTO review_comment_claim_links VALUES (?, ?, ?, ?, ?, ?, ?)',
          input.linkId,
          input.reviewId,
          input.commentId,
          input.commentRevisionId,
          input.operationId,
          JSON.stringify(json(input.endpoint)),
          JSON.stringify(json(source))
        );
        return {
          reviewId: input.reviewId,
          linkId: input.linkId,
          commentId: input.commentId,
          commentRevisionId: input.commentRevisionId,
        };
      },
    },
    options
  );
}
