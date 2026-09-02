// The placement ladder: line → hunk → file → header.
//
// The property that matters most here is the one that is easiest to lose: NOTHING
// IS DROPPED. Every comment the sidecar holds comes back as a pin somewhere, even
// when this page can place it nowhere. A reviewer who cannot see a comment
// concludes it was never filed — and then the agent's reply lands on code nobody
// is looking at, which is the comment/revision loop failing silently.

import { describe, expect, it } from 'vitest';

import type { ReanchoredPosition, ReviewUnit } from '@orcaops/review-core';

import type { LayoutPage } from './checkpointLayout';
import { buildDiffPins, headerPins, selectedRowsForHunk } from './diffPins';
import type { EnrichedComment } from '../../data/commentsSource';

type Range = { start: number; end: number } | null;

function ownedUnit(slice: number, del: Range, add: Range): ReviewUnit {
  return {
    kind: 'owned_slice',
    slice,
    patch_row_start: 0,
    patch_row_end: 3,
    del_range: del,
    add_range: add,
    lines: 2,
    owner: { kind: 'checkpoint', artifact: 'A', cp: 1 },
  };
}

/**
 * `src/a.ts` holds two parent hunks — but only `hunk_a1` has a slice THIS page
 * owns. `hunk_a2` is another checkpoint's work, rendered here as context. That
 * asymmetry is the whole reason the ladder has a hunk rung and a file rung.
 */
const PAGE: LayoutPage = {
  files: [
    {
      file: 'src/a.ts',
      slices: [
        {
          sliceKey: 'hunk_a1:s0',
          hunkKey: 'hunk_a1',
          file: 'src/a.ts',
          unit: ownedUnit(0, { start: 5, end: 5 }, { start: 2, end: 3 }),
        },
      ],
      hunks: [
        {
          hunkKey: 'hunk_a1',
          file: 'src/a.ts',
          newStart: 1,
          oldStart: 1,
          added: 2,
          removed: 1,
          status: 'matched',
          ownerLabels: ['cp1'],
          foreignOwnerLabels: [],
        },
        {
          hunkKey: 'hunk_a2',
          file: 'src/a.ts',
          newStart: 40,
          oldStart: 40,
          added: 1,
          removed: 0,
          status: 'foreign',
          ownerLabels: ['cp2'],
          foreignOwnerLabels: ['cp2'],
        },
      ],
    },
    {
      file: 'src/b.ts',
      slices: [
        {
          sliceKey: 'hunk_b1:s0',
          hunkKey: 'hunk_b1',
          file: 'src/b.ts',
          unit: ownedUnit(0, null, { start: 11, end: 11 }),
        },
      ],
      hunks: [
        {
          hunkKey: 'hunk_b1',
          file: 'src/b.ts',
          newStart: 10,
          oldStart: 10,
          added: 1,
          removed: 0,
          status: 'matched',
          ownerLabels: ['cp1'],
          foreignOwnerLabels: [],
        },
      ],
    },
  ],
  findings: [],
};

function at(over: Partial<ReanchoredPosition>): ReanchoredPosition {
  return {
    rung: 'line_hash',
    file: null,
    side: null,
    line: null,
    endLine: null,
    hunkKey: null,
    threadKey: null,
    drifted: false,
    ...over,
  };
}

function comment(id: string, position: ReanchoredPosition | null): EnrichedComment {
  return {
    comment_id: id,
    ts: '2026-01-01T00:00:00.000Z',
    author: 'reviewer',
    body: `body of ${id}`,
    status: 'open',
    anchor: { kind: 'DIFF_LINE', file: 'src/a.ts', side: 'add', line: 2, lineHash: 'hash_a2' },
    replies: [],
    position,
    context: [],
    owner: null,
    trail: [],
  };
}

function place(position: ReanchoredPosition | null) {
  const [pin] = buildDiffPins({ page: PAGE, comments: [comment('c1', position)] });
  return pin!.target;
}

describe('buildDiffPins — the placement ladder', () => {
  it('pins an owned ADD row at line grain', () => {
    expect(place(at({ hunkKey: 'hunk_a1', file: 'src/a.ts', side: 'add', line: 2 }))).toEqual({
      kind: 'line',
      sliceKey: 'hunk_a1:s0',
      side: 'add',
      line: 2,
    });
  });

  it('pins an owned DELETE row at line grain — the side is honoured, not assumed', () => {
    // `hunk_a1`'s slice owns add rows 2–3 and delete row 5. A placer that only ever
    // consulted `addRange` would miss this one and silently demote it to hunk grain.
    expect(place(at({ hunkKey: 'hunk_a1', file: 'src/a.ts', side: 'delete', line: 5 }))).toEqual({
      kind: 'line',
      sliceKey: 'hunk_a1:s0',
      side: 'delete',
      line: 5,
    });
  });

  it('falls to hunk grain when the row is in an owned hunk but not on an owned slice', () => {
    // Row 99 lives in `hunk_a1` but outside this page's slice — another checkpoint's
    // row, rendered here as context. Pin the hunk, never a row the page never claimed.
    expect(place(at({ hunkKey: 'hunk_a1', file: 'src/a.ts', side: 'add', line: 99 }))).toEqual({
      kind: 'slice',
      sliceKey: 'hunk_a1:s0',
    });
  });

  it('falls to hunk grain when the ladder resolved no line at all', () => {
    expect(place(at({ rung: 'hunk', hunkKey: 'hunk_a1', file: 'src/a.ts' }))).toEqual({
      kind: 'slice',
      sliceKey: 'hunk_a1:s0',
    });
  });

  it('falls to the file card for a hunk this page renders but owns no slice in', () => {
    // `hunk_a2` is on the page — visible, subdued, another checkpoint's. It has no
    // owned slice, so there is nothing to hang a pin on; the file card is the
    // truthful place, and it is still in front of the reader.
    expect(place(at({ hunkKey: 'hunk_a2', file: 'src/a.ts', side: 'add', line: 41 }))).toEqual({
      kind: 'file',
      file: 'src/a.ts',
    });
  });

  it('falls to the file card when the ladder resolved only a file', () => {
    expect(place(at({ rung: 'file', file: 'src/b.ts' }))).toEqual({
      kind: 'file',
      file: 'src/b.ts',
    });
  });

  it('falls to the header for a file this page never touched', () => {
    expect(place(at({ rung: 'file', file: 'src/elsewhere.ts' }))).toEqual({ kind: 'header' });
  });

  it('falls to the header when the ladder could not re-anchor at all', () => {
    expect(place(null)).toEqual({ kind: 'header' });
    expect(place(at({ rung: 'unanchored' }))).toEqual({ kind: 'header' });
  });
});

describe('buildDiffPins — nothing is dropped', () => {
  it('returns one pin per comment, however badly the ladder fared', () => {
    const comments = [
      comment('on-row', at({ hunkKey: 'hunk_a1', file: 'src/a.ts', side: 'add', line: 2 })),
      comment('on-hunk', at({ rung: 'hunk', hunkKey: 'hunk_a1', file: 'src/a.ts' })),
      comment('on-file', at({ rung: 'file', file: 'src/b.ts' })),
      comment('off-page', at({ rung: 'file', file: 'src/elsewhere.ts' })),
      comment('lost', null),
    ];
    const pins = buildDiffPins({ page: PAGE, comments });

    expect(pins).toHaveLength(comments.length);
    expect(pins.map((pin) => pin.commentId)).toEqual([
      'on-row',
      'on-hunk',
      'on-file',
      'off-page',
      'lost',
    ]);
    // The two the page cannot place still surface — above the diff, never nowhere.
    expect(headerPins(pins).map((pin) => pin.commentId)).toEqual(['off-page', 'lost']);
  });

  it('carries the facts a reader needs to judge the pin, not just its position', () => {
    const drifted: EnrichedComment = {
      ...comment('c9', at({ rung: 'hunk', hunkKey: 'hunk_a1', file: 'src/a.ts', drifted: true })),
      author: 'agent',
      status: 'resolved',
      replies: [
        { ts: '2026-01-02T00:00:00.000Z', author: 'agent', body: 'fixed in cp3' },
        { ts: '2026-01-03T00:00:00.000Z', author: 'reviewer', body: 'confirmed' },
      ],
    };
    const [pin] = buildDiffPins({ page: PAGE, comments: [drifted] });

    expect(pin).toMatchObject({
      commentId: 'c9',
      author: 'agent',
      status: 'resolved',
      replyCount: 2,
      drifted: true,
      rung: 'hunk',
    });
  });

  it('reports a range span from the resolved position', () => {
    const [pin] = buildDiffPins({
      page: PAGE,
      comments: [
        comment(
          'c10',
          at({ hunkKey: 'hunk_a1', file: 'src/a.ts', side: 'add', line: 2, endLine: 3 })
        ),
      ],
    });
    expect(pin).toMatchObject({ side: 'add', line: 2, endLine: 3 });
    expect(pin!.target).toEqual({ kind: 'line', sliceKey: 'hunk_a1:s0', side: 'add', line: 2 });
  });
});

describe('selectedRowsForHunk', () => {
  const annotation = {
    kind: 'semantic',
    placement: {
      highlightedRows: [
        { side: 'add', line: 7, lineHash: 'h7' },
        { side: 'add', line: 8, lineHash: 'h8' },
      ],
    },
  } as unknown as import('./diffPins').SemanticDiffAnnotation;
  const reviewerRows = [{ side: 'add' as const, line: 12 }];
  const sliceRows = [{ side: 'delete' as const, line: 3 }];

  it('lets the reviewer’s live row-grain selection win over the annotation', () => {
    // An annotation that replaced the selection unconditionally would move the row
    // cursor (and a `v` range) invisibly on an annotated hunk.
    expect(
      selectedRowsForHunk({
        cursorHunk: true,
        reviewerRows,
        annotation,
        activeSliceRows: sliceRows,
      })
    ).toBe(reviewerRows);
  });

  it('keeps the annotation highlight for hunk-grain entry on the cursor hunk', () => {
    expect(
      selectedRowsForHunk({
        cursorHunk: true,
        reviewerRows: undefined,
        annotation,
        activeSliceRows: sliceRows,
      })
    ).toEqual([
      { side: 'add', line: 7 },
      { side: 'add', line: 8 },
    ]);
  });

  it('highlights an annotated hunk even when the cursor sits elsewhere', () => {
    expect(
      selectedRowsForHunk({
        cursorHunk: false,
        reviewerRows: undefined,
        annotation,
        activeSliceRows: undefined,
      })
    ).toEqual([
      { side: 'add', line: 7 },
      { side: 'add', line: 8 },
    ]);
  });

  it('falls back to the cursor slice’s rows without an annotation, and to nothing off-cursor', () => {
    expect(
      selectedRowsForHunk({
        cursorHunk: true,
        reviewerRows: undefined,
        annotation: undefined,
        activeSliceRows: sliceRows,
      })
    ).toBe(sliceRows);
    expect(
      selectedRowsForHunk({
        cursorHunk: false,
        reviewerRows,
        annotation: undefined,
        activeSliceRows: sliceRows,
      })
    ).toBeUndefined();
  });
});
