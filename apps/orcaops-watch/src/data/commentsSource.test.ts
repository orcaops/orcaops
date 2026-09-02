import { describe, expect, it } from 'vitest';

import { parsePayload } from './commentsSource';

describe('Watch comments sidecar boundary', () => {
  it('retains archive warnings in the single comments response', () => {
    const payload = parsePayload(
      JSON.stringify({
        schema_version: 1,
        branch: 'demo',
        open_count: 0,
        disclosure: [],
        comments: [],
        warnings: [
          {
            code: 'REVIEW_ARCHIVE_WRITE_FAILED',
            message: 'hot append succeeded; mirror unavailable',
          },
        ],
      })
    );

    expect(payload.warnings).toEqual([
      {
        code: 'REVIEW_ARCHIVE_WRITE_FAILED',
        message: 'hot append succeeded; mirror unavailable',
      },
    ]);
  });

  it('rejects malformed archive warning fields', () => {
    expect(() =>
      parsePayload(
        JSON.stringify({
          schema_version: 1,
          branch: 'demo',
          open_count: 0,
          disclosure: [],
          comments: [],
          warnings: [{ code: 'INVENTED_WARNING', message: 'nope' }],
        })
      )
    ).toThrow('unexpected review comments shape');
  });
});
