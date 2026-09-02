import { expect, it } from 'vitest';

import { runReviewFeedbackReply } from './reply.js';

it('maps comment/message/pass-token onto the wire input', async () => {
  const calls: unknown[] = [];
  const client = {
    review: {
      reply: async (input: unknown) => {
        calls.push(input);
        return {
          comment_id: 'c9',
          parent_comment_id: 'c1',
          published_at: '2026-07-02T11:00:00.000Z',
        };
      },
    },
  };
  const result = await runReviewFeedbackReply({
    client,
    commentId: 'c1',
    body: 'addressed in abc123',
    passToken: '2026-07-02T10:00:00.000Z',
  });
  expect(calls).toEqual([
    {
      schema_version: 1,
      comment_id: 'c1',
      body: 'addressed in abc123',
      pass_token: '2026-07-02T10:00:00.000Z',
    },
  ]);
  expect(result.comment_id).toBe('c9');
});
