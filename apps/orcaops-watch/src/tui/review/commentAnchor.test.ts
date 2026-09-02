import { describe, expect, it } from 'vitest';

import type { ReviewUnit } from '@orcaops/review-core';

import {
  buildRowCommentAnchor,
  listHunkChangedLines,
  listSliceChangedLines,
  pickAnchorFromLines,
} from './commentAnchor';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' import { x } from "./x";',
  '-const old = 1;',
  '+const shiny = compute(x);',
  ' export {};',
  '@@ -10,3 +10,4 @@',
  ' function tail() {',
  '+}',
  ' }',
  '',
].join('\n');

function owned(
  delRange: { start: number; end: number } | null,
  addRange: { start: number; end: number } | null
): ReviewUnit {
  return {
    kind: 'owned_slice',
    slice: 0,
    patch_row_start: 0,
    patch_row_end: 0,
    del_range: delRange,
    add_range: addRange,
    lines: 1,
    owner: { kind: 'checkpoint', artifact: 'A', cp: 1 },
  };
}

describe('listHunkChangedLines', () => {
  it('lists changed lines in patch order with correct old/new coordinates', () => {
    expect(listHunkChangedLines(PATCH, { newStart: 1, oldStart: 1 })).toEqual([
      { side: 'delete', line: 2, body: 'const old = 1;' },
      { side: 'add', line: 2, body: 'const shiny = compute(x);' },
    ]);

    const contextPatch = [
      '--- a/src/c.ts',
      '+++ b/src/c.ts',
      '@@ -5,5 +5,5 @@',
      ' ctx();',
      '-gone();',
      ' more_ctx();',
      '+arrived();',
      ' tail();',
      '',
    ].join('\n');
    expect(listHunkChangedLines(contextPatch, { newStart: 5, oldStart: 5 })).toEqual([
      { side: 'delete', line: 6, body: 'gone();' },
      { side: 'add', line: 7, body: 'arrived();' },
    ]);
  });

  it('returns empty when the parent hunk is absent', () => {
    expect(listHunkChangedLines(PATCH, { newStart: 99, oldStart: 99 })).toEqual([]);
  });
});

describe('slice-grain comment candidates', () => {
  it('narrows the parent hunk to the active unit ranges without reordering rows', () => {
    expect(
      listSliceChangedLines(
        PATCH,
        { newStart: 1, oldStart: 1 },
        owned({ start: 2, end: 2 }, { start: 2, end: 2 })
      )
    ).toEqual([
      { side: 'delete', line: 2, body: 'const old = 1;' },
      { side: 'add', line: 2, body: 'const shiny = compute(x);' },
    ]);
    expect(
      listSliceChangedLines(PATCH, { newStart: 1, oldStart: 1 }, owned(null, { start: 2, end: 2 }))
    ).toEqual([{ side: 'add', line: 2, body: 'const shiny = compute(x);' }]);
  });

  it('keeps every changed line for an ambiguous whole-hunk unit', () => {
    const unit: ReviewUnit = { kind: 'ambiguous_hunk', lines: 2, candidates: [] };
    expect(listSliceChangedLines(PATCH, { newStart: 1, oldStart: 1 }, unit)).toEqual(
      listHunkChangedLines(PATCH, { newStart: 1, oldStart: 1 })
    );
  });

  it('prefers meaningful added code, then falls back within the active slice', () => {
    const lines = listSliceChangedLines(
      PATCH,
      { newStart: 1, oldStart: 1 },
      owned({ start: 2, end: 2 }, { start: 2, end: 2 })
    );
    expect(pickAnchorFromLines(lines)).toEqual({
      side: 'add',
      line: 2,
      body: 'const shiny = compute(x);',
    });
    expect(pickAnchorFromLines([{ side: 'add', line: 11, body: '}' }])).toEqual({
      side: 'add',
      line: 11,
      body: '}',
    });
    expect(pickAnchorFromLines([])).toBeNull();
  });
});

describe('buildRowCommentAnchor', () => {
  it('retains durable thread ownership on a deterministic row comment', async () => {
    const result = await buildRowCommentAnchor({
      file: 'src/a.ts',
      hunkKey: 'hunk_a',
      threadKey: 'sec_fixture',
      lines: [{ side: 'add', line: 2, body: 'const shiny = compute(x);' }],
      cursor: 0,
      selectionAnchor: null,
    });

    expect(result?.anchor).toMatchObject({
      kind: 'DIFF_LINE',
      file: 'src/a.ts',
      line: 2,
      hunkKey: 'hunk_a',
      threadKey: 'sec_fixture',
    });
  });
});
