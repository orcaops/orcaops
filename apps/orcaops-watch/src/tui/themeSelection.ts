import type { ThemeRow } from './ThemeProvider';

/**
 * The theme selector's list state, defined by two rules the dialog and the
 * app shell must agree on:
 *
 * 1. Every index — hover, preview, move, commit — is an index into ONE
 *    filtered array (`themeRowsForFilter`). Filtering at the JSX layer while
 *    committing against the full list is how the wrong theme gets applied.
 * 2. The visible window is STICKY: it moves only when the selection leaves it.
 *    Centering on the selection would shift a different row under a stationary
 *    pointer, fire ITS hover, and cascade — the list dragging itself until it
 *    hit a clamp.
 */
export type ThemeAppearanceFilter = 'all' | 'dark' | 'light';

const FILTER_ORDER: readonly ThemeAppearanceFilter[] = ['all', 'dark', 'light'];

export function nextAppearanceFilter(filter: ThemeAppearanceFilter): ThemeAppearanceFilter {
  return FILTER_ORDER[(FILTER_ORDER.indexOf(filter) + 1) % FILTER_ORDER.length]!;
}

export function themeRowsForFilter(
  rows: readonly ThemeRow[],
  filter: ThemeAppearanceFilter
): readonly ThemeRow[] {
  return filter === 'all' ? rows : rows.filter((row) => row.appearance === filter);
}

/**
 * Where the selection lands after the filter changes: the same theme when it
 * survived the filter, else the first visible row. Returns null when the
 * filter would leave nothing to show (the caller keeps the previous filter).
 */
export function reselectAfterFilter(
  rows: readonly ThemeRow[],
  selectedId: string | null
): { index: number; id: string } | null {
  if (rows.length === 0) return null;
  const at = selectedId === null ? -1 : rows.findIndex((row) => row.id === selectedId);
  const index = at >= 0 ? at : 0;
  return { index, id: rows[index]!.id };
}

/**
 * Scroll-into-view, not centering. The start moves only when the selection is
 * outside `[start, start + visibleRows)` — by the minimum distance — and is
 * clamped to the list. Idempotent for identical inputs, so a re-render with an
 * unchanged selection never shifts rows under a stationary pointer.
 */
export function stickyWindowStart(
  previousStart: number,
  selectedIndex: number,
  rowCount: number,
  visibleRows: number
): number {
  if (visibleRows <= 0 || rowCount <= visibleRows) return 0;
  const maxStart = rowCount - visibleRows;
  let start = Math.min(Math.max(previousStart, 0), maxStart);
  if (selectedIndex < start) start = selectedIndex;
  else if (selectedIndex >= start + visibleRows) start = selectedIndex - visibleRows + 1;
  return Math.min(Math.max(start, 0), maxStart);
}
