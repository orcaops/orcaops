import type { OssReviewFeedbackResolve, OssReviewFeedbackResolveResponse } from '@orcaops/sdk';

import { withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../io/output.js';
import { assertNoSecretsOutbound } from '../../lib/cloud-secret-gate.js';
import { createDatabaseReviewFeedbackMutationClient } from '../../lib/database-review-feedback-mutations.js';
import { loadSecretAllowlist } from '../../lib/run-capture.js';

export interface ReviewFeedbackResolveClient {
  review: {
    resolve(input: OssReviewFeedbackResolve): Promise<OssReviewFeedbackResolveResponse>;
  };
}

export async function runReviewFeedbackResolve(args: {
  client: ReviewFeedbackResolveClient;
  commentId: string;
}): Promise<OssReviewFeedbackResolveResponse> {
  return args.client.review.resolve({
    schema_version: 1,
    comment_id: args.commentId,
  });
}

/** `orcaops review resolve <commentId>` — the HUMAN verb (solo flow). The
 *  agent protocol is reply-don't-resolve; the skill enforces it. */
export async function reviewFeedbackResolveAction(
  commentId: string,
  opts: { idempotencyKey?: string; baseUrl?: string; json?: boolean } = {}
): Promise<void> {
  try {
    if (!commentId) {
      throw new OrcaopsError(ErrorCodes.NO_INPUT, 'a comment id is required.', 'review-resolve');
    }
    if (opts.idempotencyKey !== undefined && opts.idempotencyKey.length === 0) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--idempotency-key must be non-empty when provided.',
        'review-resolve'
      );
    }
    assertNoSecretsOutbound(
      'review-resolve',
      [
        ['comment_id', commentId],
        ['idempotency_key', opts.idempotencyKey ?? null],
      ],
      await loadSecretAllowlist()
    );
    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [],
        operation: 'review resolve',
      },
      (ctx) =>
        runReviewFeedbackResolve({
          client: createDatabaseReviewFeedbackMutationClient({
            reader: ctx.reader,
            openWriter: ctx.openWriter,
            client: ctx.client,
            target: ctx.target,
            idempotencyKey: opts.idempotencyKey,
            secretAllow: ctx.secretAllow,
            now: () => new Date().toISOString(),
            signal: ctx.signal,
            onWait: ctx.onWait,
          }),
          commentId,
        })
    );
    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(
      `Resolved thread ${result.comment_id}.\n` +
        "(agents: prefer 'review reply' — resolution is the reviewer's judgment)\n"
    );
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
