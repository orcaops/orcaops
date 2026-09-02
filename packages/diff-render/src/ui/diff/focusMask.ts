// Canonical-hunk focus overlay — OUR code (not vendored; no MIT header).
// Real diff rows remain the canonical display and interaction structure. This
// module classifies changed cells outside the current surface's union of primary
// slice ranges without rewriting their syntax, diff kind, move metadata, signs,
// line numbers, or span identity.

import type { DiffRow } from './pierre';

export interface SliceLineRange {
  start: number;
  end: number;
}

export interface SliceLineRanges {
  delRange: SliceLineRange | null;
  addRange: SliceLineRange | null;
}

export type DiffCellFocus = 'primary' | 'subdued';

/** Per-cell presentation for one canonical diff row. Missing map entries are wholly primary. */
export type DiffRowFocus =
  | { readonly kind: 'split'; readonly left: DiffCellFocus; readonly right: DiffCellFocus }
  | { readonly kind: 'stack'; readonly cell: DiffCellFocus };

interface CompiledRanges {
  add: readonly SliceLineRange[];
  delete: readonly SliceLineRange[];
}

/** Merge overlapping/adjacent ranges once so row classification is logarithmic in slice count. */
function mergeRanges(ranges: SliceLineRange[]): SliceLineRange[] {
  if (ranges.length <= 1) return ranges;
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SliceLineRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end + 1) {
      merged.push({ start: range.start, end: range.end });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

function compileRanges(ranges: readonly SliceLineRanges[]): CompiledRanges {
  return {
    add: mergeRanges(
      ranges.flatMap((range) => (range.addRange === null ? [] : [{ ...range.addRange }]))
    ),
    delete: mergeRanges(
      ranges.flatMap((range) => (range.delRange === null ? [] : [{ ...range.delRange }]))
    ),
  };
}

function inCompiledRanges(ranges: readonly SliceLineRange[], line: number | undefined): boolean {
  if (line === undefined) return false;
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const range = ranges[mid]!;
    if (line < range.start) high = mid - 1;
    else if (line > range.end) low = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Classify changed cells outside `ranges` as subdued presentation.
 *
 * The returned map intentionally contains only rows with at least one subdued
 * cell. Canonical rows and their nested cells/spans are never cloned or mutated;
 * interaction and rendering consume this orthogonal metadata explicitly.
 */
export function buildRowFocusMap(
  rows: readonly DiffRow[],
  ranges: readonly SliceLineRanges[]
): ReadonlyMap<string, DiffRowFocus> {
  const compiled = compileRanges(ranges);
  const focusByRowKey = new Map<string, DiffRowFocus>();

  for (const row of rows) {
    if (row.type === 'split-line') {
      if (row.isExpansionRow === true) continue;
      const left: DiffCellFocus =
        row.left.kind === 'deletion' && !inCompiledRanges(compiled.delete, row.left.lineNumber)
          ? 'subdued'
          : 'primary';
      const right: DiffCellFocus =
        row.right.kind === 'addition' && !inCompiledRanges(compiled.add, row.right.lineNumber)
          ? 'subdued'
          : 'primary';
      if (left === 'subdued' || right === 'subdued') {
        focusByRowKey.set(row.key, { kind: 'split', left, right });
      }
      continue;
    }

    if (row.type === 'stack-line') {
      if (row.isExpansionRow === true) continue;
      const foreign =
        (row.cell.kind === 'deletion' &&
          !inCompiledRanges(compiled.delete, row.cell.oldLineNumber)) ||
        (row.cell.kind === 'addition' && !inCompiledRanges(compiled.add, row.cell.newLineNumber));
      if (foreign) focusByRowKey.set(row.key, { kind: 'stack', cell: 'subdued' });
    }
  }

  return focusByRowKey;
}
