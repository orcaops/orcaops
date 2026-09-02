import type { OssReviewFeedbackReply, OssReviewFeedbackReplyResponse } from '@orcaops/sdk';

import { withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../io/output.js';
import {
  assertNoSecretsOutbound,
  type WithSecretWarnings,
  withSecretWarnings,
  writeSecretWarnings,
} from '../../lib/cloud-secret-gate.js';
import { loadSecretAllowlist } from '../../lib/run-capture.js';

export interface ReviewFeedbackReplyClient {
  review: { reply(input: OssReviewFeedbackReply): Promise<OssReviewFeedbackReplyResponse> };
}

export async function runReviewFeedbackReply(args: {
  client: ReviewFeedbackReplyClient;
  commentId: string;
  body: string;
  passToken: string | null;
}): Promise<WithSecretWarnings<OssReviewFeedbackReplyResponse>> {
  const secretWarnings = assertNoSecretsOutbound(
    'review-reply',
    [['body', args.body]],
    await loadSecretAllowlist()
  );
  const result = await args.client.review.reply({
    schema_version: 1,
    comment_id: args.commentId,
    body: args.body,
    pass_token: args.passToken,
  });
  return withSecretWarnings(result, secretWarnings);
}

/** `orcaops review reply <commentId> --message <text> [--pass-token <cursor>]` —
 *  posts live as AGENT. Echo the cursor the pull printed; omitting it degrades
 *  coalescing (per-reply fallback key), never correctness. */
export async function reviewFeedbackReplyAction(
  commentId: string,
  opts: { message?: string; passToken?: string; baseUrl?: string; json?: boolean } = {}
): Promise<void> {
  try {
    if (!commentId) {
      throw new OrcaopsError(ErrorCodes.NO_INPUT, 'a comment id is required.', 'review-reply');
    }
    if (!opts.message || opts.message.length === 0) {
      throw new OrcaopsError(ErrorCodes.NO_INPUT, '--message is required.', 'review-reply');
    }
    // The outbound secret gate runs HERE, before credential resolution and the
    // capability ping `withReviewCloud` makes, so a refusal precedes anything
    // authored reaching the network rather than only preceding the mutation.
    // The identical gate inside the run* core is defense in depth and is what
    // the client-injected core tests drive.
    assertNoSecretsOutbound('review-reply', [['body', opts.message]], await loadSecretAllowlist());

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [],
        operation: 'review reply',
      },
      (ctx) =>
        runReviewFeedbackReply({
          client: ctx.client,
          commentId,
          body: opts.message as string,
          passToken: opts.passToken ?? null,
        })
    );
    writeSecretWarnings(result.secret_warnings);
    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(
      `Replied (comment ${result.comment_id}) on thread ${result.parent_comment_id}.\n`
    );
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
