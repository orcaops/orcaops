import { beforeEach, expect, it, vi } from 'vitest';

import { openProjectDatabase } from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import {
  createDatabaseReviewFeedbackMutationClient,
  type DatabaseReviewFeedbackMutationOptions,
  type ReviewFeedbackMutationCloudClient,
} from './database-review-feedback-mutations.js';
import { fixture } from '../../tests/helpers/database-history.js';

const target: RemoteTarget = {
  server_url: 'https://cloud.example.test',
  org_id: 'organization',
  account_id: 'account-a',
};

let f: Awaited<ReturnType<typeof fixture>>;
let reply: ReturnType<typeof vi.fn<ReviewFeedbackMutationCloudClient['review']['reply']>>;
let resolve: ReturnType<typeof vi.fn<ReviewFeedbackMutationCloudClient['review']['resolve']>>;
let writerOpens: number;

beforeEach(async () => {
  f = await fixture();
  writerOpens = 0;
  reply = vi.fn<ReviewFeedbackMutationCloudClient['review']['reply']>(async () => ({
    comment_id: 'reply-1',
    parent_comment_id: 'comment-1',
    published_at: '2026-09-09T00:02:00.000Z',
  }));
  resolve = vi.fn<ReviewFeedbackMutationCloudClient['review']['resolve']>(async () => ({
    comment_id: 'comment-1',
    status: 'RESOLVED' as const,
  }));
});

function client(
  changes: Partial<DatabaseReviewFeedbackMutationOptions> = {}
): ReviewFeedbackMutationCloudClient {
  return createDatabaseReviewFeedbackMutationClient({
    reader: f.writer,
    openWriter: async () => {
      writerOpens += 1;
      return openProjectDatabase({ authority: f.authority, mode: 'writer' });
    },
    client: { review: { reply, resolve } },
    target,
    secretAllow: [],
    now: () => '2026-09-09T00:01:00.000Z',
    ...changes,
  });
}

const replyPayload = {
  schema_version: 1 as const,
  comment_id: 'comment-1',
  body: 'Addressed in the latest change.',
  pass_token: '2026-09-09T00:00:00.000Z',
};

it('replays the same default reply without another writer or SDK call', async () => {
  await expect(client().review.reply(replyPayload)).resolves.toMatchObject({
    comment_id: 'reply-1',
  });
  const beforeReplay = writerOpens;
  await expect(client().review.reply(replyPayload)).resolves.toMatchObject({
    comment_id: 'reply-1',
  });

  expect(reply).toHaveBeenCalledTimes(1);
  expect(writerOpens).toBe(beforeReplay);
  expect(
    f.writer.read((view) =>
      view.get<{ count: number }>('SELECT count(*) AS count FROM remote_requests')
    ).value
  ).toEqual({ count: 1 });
});

it('refuses changed payload under one explicit operation key', async () => {
  await client({ idempotencyKey: 'one-operation' }).review.reply(replyPayload);

  await expect(
    client({ idempotencyKey: 'one-operation' }).review.reply({
      ...replyPayload,
      body: 'A different reply.',
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(reply).toHaveBeenCalledTimes(1);
});

it('allows intentional duplicate replies under distinct explicit keys', async () => {
  await client({ idempotencyKey: 'first-operation' }).review.reply(replyPayload);
  await client({ idempotencyKey: 'second-operation' }).review.reply(replyPayload);

  expect(reply).toHaveBeenCalledTimes(2);
  expect(
    f.writer.read((view) =>
      view.get<{ count: number }>('SELECT count(*) AS count FROM remote_requests')
    ).value
  ).toEqual({ count: 2 });
});

it('retains an unknown reply and directs retries to actual inspection commands', async () => {
  reply.mockRejectedValueOnce(new Error('connection ended without a response'));
  const original = client();
  await expect(original.review.reply(replyPayload)).rejects.toThrow(/review status/);
  await expect(client().review.reply(replyPayload)).rejects.toThrow(/review pull --pr/);

  expect(reply).toHaveBeenCalledTimes(1);
  expect(
    f.writer.read((view) =>
      view.get<{ kind: string }>('SELECT kind FROM remote_outcomes ORDER BY outcome_n DESC LIMIT 1')
    ).value
  ).toEqual({ kind: 'ack_unknown' });
});

it('settles an acknowledged reply after cancellation during the SDK call', async () => {
  const controller = new AbortController();
  reply.mockImplementationOnce(async () => {
    controller.abort();
    return {
      comment_id: 'reply-after-cancel',
      parent_comment_id: 'comment-1',
      published_at: '2026-09-09T00:02:00.000Z',
    };
  });
  const original = client({ signal: controller.signal });
  await expect(original.review.reply(replyPayload)).resolves.toMatchObject({
    comment_id: 'reply-after-cancel',
  });
  await expect(client().review.reply(replyPayload)).resolves.toMatchObject({
    comment_id: 'reply-after-cancel',
  });
  expect(reply).toHaveBeenCalledTimes(1);
});

it('does not send when cancellation wins before attempt admission', async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    client({ signal: controller.signal }).review.reply(replyPayload)
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(reply).not.toHaveBeenCalled();
  expect(
    f.writer.read((view) =>
      view.get<{ count: number }>('SELECT count(*) AS count FROM remote_attempts')
    ).value
  ).toEqual({ count: 0 });
});

it('refuses secret-shaped authored identity before opening a writer', async () => {
  await expect(
    client({ idempotencyKey: `ghp_${'a'.repeat(36)}` }).review.resolve({
      schema_version: 1,
      comment_id: 'comment-1',
    })
  ).rejects.toThrow(/secret/i);
  expect(writerOpens).toBe(0);
  expect(resolve).not.toHaveBeenCalled();
});
