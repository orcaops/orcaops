import { describe, expect, it } from 'vitest';

import { parsePayload } from './commentsSource';

describe('Watch comments sidecar boundary', () => {
  it('accepts the enriched payload the comments verb emits', () => {
    const payload = parsePayload(
      JSON.stringify({
        schema_version: 1,
        branch: 'demo',
        open_count: 1,
        disclosure: ['no selected floor for this review'],
        comments: [],
      })
    );

    expect(payload.branch).toBe('demo');
    expect(payload.open_count).toBe(1);
    expect(payload.comments).toEqual([]);
  });

  it('refuses a comments payload with no records array', () => {
    expect(() =>
      parsePayload(
        JSON.stringify({ schema_version: 1, branch: 'demo', open_count: 0, disclosure: [] })
      )
    ).toThrow('unexpected review comments shape');
  });
});
