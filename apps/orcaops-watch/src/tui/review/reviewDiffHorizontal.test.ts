import { describe, expect, it } from 'vitest';

import { type DiffFile, diffFileFromPatch, gapKey } from '@orcaops/diff-render';

import {
  maxReviewCodeHorizontalOffset,
  maxReviewCodeHorizontalOffsetFromMetrics,
  measureReviewDiffHorizontalContent,
  reviewDiffHorizontalGeometry,
  reviewReaderGeometry,
} from './reviewDiffHorizontal';

function fileWithLine(text: string) {
  return diffFileFromPatch(
    [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -0,0 +1 @@',
      `+${text}`,
      '',
    ].join('\n'),
    { sourceId: `horizontal:${text.length}` }
  );
}

function content(file: DiffFile, renderedHunkIndices = [...file.metadata.hunks.keys()]) {
  return { file, renderedHunkIndices };
}

function fileWithDistantHunk(secondLine: string) {
  return diffFileFromPatch(
    [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1 @@',
      '-const first = 0;',
      '+const first = 1;',
      '@@ -40 +40 @@',
      '-const oldTail = 0;',
      `+${secondLine}`,
      '',
    ].join('\n'),
    { sourceId: `horizontal:distant:${secondLine.length}` }
  );
}

describe('review diff horizontal geometry', () => {
  it('prices the responsive reader and native diff viewport without terminal-height overmount', () => {
    expect(reviewReaderGeometry(120, 30)).toMatchObject({
      split: true,
      bodyHeight: 29,
      railHeight: 29,
      diffHeight: 29,
      diffViewportUpperBound: 27,
    });
    expect(reviewReaderGeometry(104, 36)).toMatchObject({
      split: false,
      bodyHeight: 35,
      railHeight: 15,
      diffHeight: 20,
      diffViewportUpperBound: 18,
    });
    expect(reviewReaderGeometry(78, 20)).toMatchObject({
      split: false,
      bodyHeight: 19,
      railHeight: 8,
      diffHeight: 11,
      diffViewportUpperBound: 9,
    });
    const short = reviewReaderGeometry(80, 12);
    expect(short).toMatchObject({
      split: false,
      bodyHeight: 11,
      railHeight: 6,
      diffHeight: 5,
      diffViewportUpperBound: 3,
    });
    expect(short.railHeight + short.diffHeight).toBe(short.bodyHeight);
  });

  it('prices the same nested shell and card chrome as the rendered diff', () => {
    expect(reviewDiffHorizontalGeometry(100, 'auto')).toEqual({
      codeRowWidth: 94,
      layout: 'split',
    });
    expect(reviewDiffHorizontalGeometry(80, 'auto')).toEqual({
      codeRowWidth: 74,
      layout: 'stack',
    });
    expect(reviewDiffHorizontalGeometry(160, 'stack')).toEqual({
      codeRowWidth: 111,
      layout: 'stack',
    });
  });

  it('clamps short pages to zero and shrinks the bound as the code viewport grows', () => {
    const short = fileWithLine('const answer = 42;');
    const long = fileWithLine(`const value = '${'x'.repeat(400)}';`);

    expect(
      maxReviewCodeHorizontalOffset({
        content: [content(short)],
        width: 160,
        layout: 'split',
        showLineNumbers: true,
      })
    ).toBe(0);

    const split = maxReviewCodeHorizontalOffset({
      content: [content(short), content(long)],
      width: 160,
      layout: 'split',
      showLineNumbers: true,
    });
    const stack = maxReviewCodeHorizontalOffset({
      content: [content(short), content(long)],
      width: 160,
      layout: 'stack',
      showLineNumbers: true,
    });
    const wideStack = maxReviewCodeHorizontalOffset({
      content: [content(short), content(long)],
      width: 220,
      layout: 'stack',
      showLineNumbers: true,
    });
    const stackWithoutLineNumbers = maxReviewCodeHorizontalOffset({
      content: [content(short), content(long)],
      width: 160,
      layout: 'stack',
      showLineNumbers: false,
    });

    expect(stack).toBeLessThan(split);
    expect(wideStack).toBeLessThan(stack);
    expect(stackWithoutLineNumbers).toBeLessThan(stack);
    expect(wideStack).toBeGreaterThan(0);

    const metrics = measureReviewDiffHorizontalContent([content(short), content(long)]);
    expect(
      maxReviewCodeHorizontalOffsetFromMetrics({
        metrics,
        width: 160,
        layout: 'stack',
        showLineNumbers: true,
      })
    ).toBe(stack);
    expect(metrics.widestCodeLine).toBeGreaterThan(400);
  });

  it('prices long loaded context synthesized by an expanded unchanged gap', () => {
    const file = fileWithDistantHunk('const tail = 40;');
    const plain = maxReviewCodeHorizontalOffset({
      content: [content(file, [1])],
      width: 160,
      layout: 'stack',
      showLineNumbers: true,
    });
    const sourceLines = Array.from({ length: 40 }, (_unused, index) =>
      index === 20 ? `const expanded = '${'x'.repeat(400)}';` : `const line${index + 1} = 1;`
    );
    const expanded = maxReviewCodeHorizontalOffset({
      content: [
        {
          ...content(file, [1]),
          expansion: {
            expandedKeys: new Set([gapKey('before', 1)]),
            sourceStatus: { kind: 'loaded', text: sourceLines.join('\n') },
            side: 'new',
          },
        },
      ],
      width: 160,
      layout: 'stack',
      showLineNumbers: true,
    });

    expect(plain).toBe(0);
    expect(expanded).toBeGreaterThan(200);
  });

  it('omits a partial loaded range that the row renderer replaces with an error status', () => {
    const file = fileWithDistantHunk('const tail = 40;');
    const partialSource = [
      `const invisiblePrefix = '${'x'.repeat(400)}';`,
      ...Array.from({ length: 9 }, (_unused, index) => `const partial${index} = 1;`),
    ].join('\n');

    expect(
      maxReviewCodeHorizontalOffset({
        content: [
          {
            ...content(file, [1]),
            expansion: {
              expandedKeys: new Set([gapKey('before', 1)]),
              sourceStatus: { kind: 'loaded', text: partialSource },
              side: 'new',
            },
          },
        ],
        width: 160,
        layout: 'stack',
        showLineNumbers: true,
      })
    ).toBe(0);
  });

  it('does not let a long collapsed foreign hunk pan visible short rows into blank space', () => {
    const file = fileWithDistantHunk(`const hidden = '${'x'.repeat(400)}';`);
    const visibleOnly = maxReviewCodeHorizontalOffset({
      content: [content(file, [0])],
      width: 160,
      layout: 'stack',
      showLineNumbers: true,
    });
    const withForeignExpanded = maxReviewCodeHorizontalOffset({
      content: [content(file, [0, 1])],
      width: 160,
      layout: 'stack',
      showLineNumbers: true,
    });

    expect(visibleOnly).toBe(0);
    expect(withForeignExpanded).toBeGreaterThan(200);
  });
});
