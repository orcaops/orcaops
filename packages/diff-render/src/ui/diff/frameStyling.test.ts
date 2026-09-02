import { describe, expect, it } from 'vitest';

import { distinctCodeForegroundCount, splitCodeCellRanges, type StyledSpan } from './frameStyling';

// The production benchmark's syntax surface renders at width 110, split layout, with
// 4 line-number digits. That geometry puts code text in columns [8,55) and [63,110).
const RANGES = splitCodeCellRanges(110, 4);

function fg(r: number, g: number, b: number): { toInts(): readonly number[] } {
  return { toInts: () => [r, g, b, 255] };
}
function span(color: { toInts(): readonly number[] }, width: number): StyledSpan {
  return { fg: color, width };
}

const GUTTER = fg(100, 100, 100);
const SIGN = fg(0, 200, 0);
const KEYWORD = fg(200, 100, 250);
const STRING = fg(120, 200, 120);
const NUMBER = fg(250, 180, 80);
const CODE = fg(220, 220, 220); // the single default foreground of a plain code render
const ADDED = fg(120, 230, 120); // a word-diff added-line tint

// One split row: [rail 1][left gutter 7][left code 47][separator 1][right gutter 7][right code 47].
function row(
  leftGutter: StyledSpan[],
  leftCode: StyledSpan[],
  rightGutter: StyledSpan[],
  rightCode: StyledSpan[]
) {
  return {
    spans: [
      span(GUTTER, 1),
      ...leftGutter,
      ...leftCode,
      span(GUTTER, 1),
      ...rightGutter,
      ...rightCode,
    ],
  };
}

describe('distinctCodeForegroundCount (split diff frame)', () => {
  it('resolves the benchmark code-cell column ranges from the renderer geometry', () => {
    expect(RANGES).toEqual([
      [8, 55],
      [63, 110],
    ]);
  });

  it('(a) counts >= 2 distinct code foregrounds when highlighted', () => {
    const lines = [
      row(
        [span(GUTTER, 7)],
        [span(KEYWORD, 6), span(CODE, 10), span(STRING, 31)],
        [span(GUTTER, 7)],
        [span(NUMBER, 47)]
      ),
    ];
    expect(distinctCodeForegroundCount(lines, RANGES)).toBe(4); // KEYWORD, CODE, STRING, NUMBER
  });

  it('(b) counts one when all code cells share a foreground', () => {
    const lines = [
      row([span(SIGN, 1), span(GUTTER, 6)], [span(CODE, 47)], [span(GUTTER, 7)], [span(CODE, 47)]),
    ];
    expect(distinctCodeForegroundCount(lines, RANGES)).toBe(1);
  });

  it('(c) ignores a multicolor LEFT gutter over uniform code', () => {
    const lines = [
      row(
        [span(SIGN, 1), span(fg(50, 50, 200), 3), span(GUTTER, 3)],
        [span(CODE, 47)],
        [span(GUTTER, 7)],
        [span(CODE, 47)]
      ),
    ];
    expect(distinctCodeForegroundCount(lines, RANGES)).toBe(1);
  });

  it('(d) ignores a multicolor RIGHT gutter over uniform code', () => {
    const lines = [
      row(
        [span(GUTTER, 7)],
        [span(CODE, 47)],
        [span(fg(200, 50, 50), 1), span(fg(50, 50, 200), 3), span(GUTTER, 3)],
        [span(CODE, 47)]
      ),
    ];
    expect(distinctCodeForegroundCount(lines, RANGES)).toBe(1);
  });

  it('(e) discriminates highlighted from plain word-diff: settled count > plain count', () => {
    // A plain word-diff frame already varies code color (added line tinted vs context),
    // so it is NOT single-color; syntax highlighting must ADD colors on top.
    const plain = [row([span(GUTTER, 7)], [span(CODE, 47)], [span(GUTTER, 7)], [span(ADDED, 47)])];
    const highlighted = [
      row(
        [span(GUTTER, 7)],
        [span(KEYWORD, 6), span(CODE, 10), span(NUMBER, 31)],
        [span(GUTTER, 7)],
        [span(KEYWORD, 6), span(ADDED, 10), span(STRING, 31)]
      ),
    ];
    const plainCount = distinctCodeForegroundCount(plain, RANGES);
    const highlightedCount = distinctCodeForegroundCount(highlighted, RANGES);
    expect(plainCount).toBe(2); // CODE + ADDED — word-diff alone already > 1
    expect(highlightedCount).toBeGreaterThan(plainCount); // syntax adds token colors
  });
});
