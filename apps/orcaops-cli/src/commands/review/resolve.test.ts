import { expect, it } from 'vitest';

import { runReviewFeedbackResolve } from './resolve.js';

it('maps commentId onto the wire input', async () => {
  const calls: unknown[] = [];
  const client = {
    review: {
      resolve: async (input: unknown) => {
        calls.push(input);
        return { comment_id: 'c1', status: 'RESOLVED' as const };
      },
    },
  };
  const result = await runReviewFeedbackResolve({ client, commentId: 'c1' });
  expect(calls).toEqual([{ schema_version: 1, comment_id: 'c1' }]);
  expect(result.comment_id).toBe('c1');
  expect(result.status).toBe('RESOLVED');
});
