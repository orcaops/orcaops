import { describe, expect, it } from 'vitest';

import { commentWhereLabel } from './CommentsIndex';
import type { EnrichedComment } from '../../data/commentsSource';

function base(over: Partial<EnrichedComment>): EnrichedComment {
  return {
    comment_id: 'comment',
    ts: '2026-07-12T08:00:00.000Z',
    author: 'reviewer',
    body: 'Review this.',
    status: 'open',
    anchor: { kind: 'DIFF_LINE', file: 'src/a.ts', side: 'add', line: 3, lineHash: 'hash_a3' },
    replies: [],
    position: null,
    context: [],
    owner: null,
    trail: [],
    ...over,
  };
}

describe('comment index location labels', () => {
  it('labels unchanged-context replay distinctly from changed code', () => {
    expect(
      commentWhereLabel(
        base({
          anchor: {
            kind: 'UNCHANGED_CONTEXT_LINE',
            file: 'src/context.ts',
            headBlobOid: 'blob',
            line: 7,
            lineHash: 'hash',
            symbol: 'stableHelper',
          },
          position: {
            rung: 'unchanged_context',
            file: 'src/context.ts',
            side: null,
            line: 9,
            endLine: null,
            hunkKey: null,
            threadKey: null,
            drifted: false,
          },
        })
      )
    ).toBe('src/context.ts:9 (unchanged context)');
  });

  it('keeps an unresolved anchor at its authored location', () => {
    expect(commentWhereLabel(base({}))).toBe('src/a.ts:3 (unresolved)');
  });
});
