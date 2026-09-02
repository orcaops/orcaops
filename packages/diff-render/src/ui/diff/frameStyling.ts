import { resolveSplitCellGeometry, resolveSplitPaneWidths } from './codeColumns';

/**
 * Count the distinct foreground colors used in the CODE cells of a rendered diff
 * frame — a building block for verifying that syntax highlighting actually landed.
 *
 * Detecting "syntax highlighting is present" is subtle. Two confounds:
 *   1. A plain (unhighlighted) diff frame is NOT single-color: the rail, +/- sign,
 *      and line-number gutter cells are colored, and word-diff emphasis already tints
 *      added/removed code. So a column-blind "has >= 2 colors" check false-positives.
 *   2. So does an absolute code-cell threshold: word-diff alone yields >= 2 code
 *      foregrounds, before any syntax highlighting.
 *
 * This function addresses (1) by scoping to code columns via the renderer's own
 * geometry. Callers address (2) by comparing the count of the SETTLED frame against
 * the pre-settle (deferred-highlight) frame: syntax highlighting adds token colors on
 * top of word-diff coloring, so `settledCount > plainCount`. That delta is both
 * syntax-specific and its own negative control (a broken/absent highlighter adds no
 * colors, so the counts match).
 */

/** Minimal captured-span shape (a structural subset of OpenTUI's `CapturedSpan`). */
export interface StyledSpan {
  readonly fg: { toInts(): readonly number[] };
  readonly width: number;
}
export interface StyledLine {
  readonly spans: readonly StyledSpan[];
}

/**
 * The `[startColumn, endColumn)` ranges that hold code TEXT — excluding the rail
 * prefix, the sign/line-number gutter of each pane, and the split separator — for a
 * split-layout diff row of `width`. Note this excludes gutters and the separator but
 * NOT hunk-header rows (a header's text overlaps the code columns); render the frame
 * with `showHunkHeaders={false}` so header rows never reach the check.
 */
export function splitCodeCellRanges(
  width: number,
  lineNumberDigits: number,
  showLineNumbers = true
): ReadonlyArray<readonly [number, number]> {
  const { leftWidth, rightWidth } = resolveSplitPaneWidths(width);
  const left = resolveSplitCellGeometry(leftWidth, lineNumberDigits, showLineNumbers);
  const right = resolveSplitCellGeometry(rightWidth, lineNumberDigits, showLineNumbers);
  const leftCodeStart = leftWidth - left.contentWidth; // past rail + gutter
  const rightCodeStart = leftWidth + (rightWidth - right.contentWidth); // past separator + gutter
  return [
    [leftCodeStart, leftWidth],
    [rightCodeStart, leftWidth + rightWidth],
  ];
}

function startsInCodeRange(
  columnStart: number,
  ranges: ReadonlyArray<readonly [number, number]>
): boolean {
  return ranges.some(([start, end]) => columnStart >= start && columnStart < end);
}

/** Number of distinct foreground colors among the code cells (per `codeCellRanges`). */
export function distinctCodeForegroundCount(
  lines: ReadonlyArray<StyledLine>,
  codeCellRanges: ReadonlyArray<readonly [number, number]>
): number {
  const codeForegrounds = new Set<string>();
  for (const line of lines) {
    let column = 0;
    for (const span of line.spans) {
      const columnStart = column;
      column += span.width;
      if (span.width > 0 && startsInCodeRange(columnStart, codeCellRanges)) {
        codeForegrounds.add(span.fg.toInts().join(','));
      }
    }
  }
  return codeForegrounds.size;
}
