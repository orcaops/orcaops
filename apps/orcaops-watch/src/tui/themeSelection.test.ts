import { describe, expect, it } from 'vitest';

import type { ThemeRow } from './ThemeProvider';
import {
  nextAppearanceFilter,
  reselectAfterFilter,
  stickyWindowStart,
  themeRowsForFilter,
} from './themeSelection';

const row = (id: string, appearance: 'light' | 'dark'): ThemeRow => ({
  id,
  label: id,
  appearance,
});

const ROWS: ThemeRow[] = [
  row('ayu-dark', 'dark'),
  row('ayu-light', 'light'),
  row('dracula', 'dark'),
  row('github-light', 'light'),
  row('nord', 'dark'),
];

describe('stickyWindowStart', () => {
  it('does not move for a selection already inside the window', () => {
    // A centering window would shift rows under a stationary hover pointer;
    // an in-window selection must be a no-op.
    for (const selected of [3, 4, 5, 6, 7]) {
      expect(stickyWindowStart(3, selected, 65, 5)).toBe(3);
    }
  });

  it('advances by the minimum distance when the selection walks off either edge', () => {
    expect(stickyWindowStart(3, 8, 65, 5)).toBe(4);
    expect(stickyWindowStart(3, 2, 65, 5)).toBe(2);
  });

  it('clamps to the list bounds', () => {
    expect(stickyWindowStart(0, 64, 65, 5)).toBe(60);
    expect(stickyWindowStart(63, 0, 65, 5)).toBe(0);
    expect(stickyWindowStart(70, 62, 65, 5)).toBe(60);
  });

  it('is idempotent — a re-render with unchanged inputs keeps the same window', () => {
    const once = stickyWindowStart(3, 9, 65, 5);
    expect(stickyWindowStart(once, 9, 65, 5)).toBe(once);
  });

  it('collapses when everything fits or nothing is visible', () => {
    expect(stickyWindowStart(2, 1, 4, 5)).toBe(0);
    expect(stickyWindowStart(2, 1, 65, 0)).toBe(0);
  });

  it('reconciles a shrunken list (filter change) without going out of range', () => {
    // 65 rows filtered down to 21: a stale start deep in the old list clamps.
    expect(stickyWindowStart(55, 0, 21, 5)).toBe(0);
    expect(stickyWindowStart(55, 20, 21, 5)).toBe(16);
  });
});

describe('appearance filter', () => {
  it('cycles All → Dark → Light → All', () => {
    expect(nextAppearanceFilter('all')).toBe('dark');
    expect(nextAppearanceFilter('dark')).toBe('light');
    expect(nextAppearanceFilter('light')).toBe('all');
  });

  it('filters rows by appearance and passes everything through on all', () => {
    expect(themeRowsForFilter(ROWS, 'all')).toHaveLength(5);
    expect(themeRowsForFilter(ROWS, 'dark').map((r) => r.id)).toEqual([
      'ayu-dark',
      'dracula',
      'nord',
    ]);
    expect(themeRowsForFilter(ROWS, 'light').map((r) => r.id)).toEqual([
      'ayu-light',
      'github-light',
    ]);
  });

  it('keeps the selected theme when it survives the filter', () => {
    const dark = themeRowsForFilter(ROWS, 'dark');
    expect(reselectAfterFilter(dark, 'dracula')).toEqual({ index: 1, id: 'dracula' });
  });

  it('falls back to the first visible row when the selection is filtered out', () => {
    const light = themeRowsForFilter(ROWS, 'light');
    expect(reselectAfterFilter(light, 'dracula')).toEqual({ index: 0, id: 'ayu-light' });
    expect(reselectAfterFilter(light, null)).toEqual({ index: 0, id: 'ayu-light' });
  });

  it('reports an empty filter result so the caller can refuse the switch', () => {
    expect(reselectAfterFilter([], 'dracula')).toBeNull();
  });
});
