// Tests for the vendored rowWindowing adaptation — OUR test (not vendored):
// exercises the retyped generic surface over synthetic bounds, the way the
// watch app feeds it (rows + measured slice bounds, no render plan).

import { describe, expect, it } from 'vitest';

import { resolveVisiblePlannedRowWindow, type WindowedSectionGeometry } from './rowWindowing';

function geometry(heights: number[]): WindowedSectionGeometry {
  const rowBounds = [];
  let top = 0;
  for (const height of heights) {
    rowBounds.push({ top, height });
    top += height;
  }
  return { bodyHeight: top, rowBounds };
}

const labels = (n: number) => Array.from({ length: n }, (_, i) => `row:${i}`);

describe('resolveVisiblePlannedRowWindow', () => {
  it('selects only rows overlapping the visible range and preserves total height', () => {
    const rows = labels(6);
    const g = geometry([1, 1, 1, 1, 1, 1]);
    const window = resolveVisiblePlannedRowWindow({
      plannedRows: rows,
      sectionGeometry: g,
      visibleBodyBounds: { top: 2, height: 2 },
    });
    expect(window.plannedRows).toEqual(['row:2', 'row:3']);
    expect(window.topSpacerHeight).toBe(2);
    expect(window.bottomSpacerHeight).toBe(2);
    expect(window.topSpacerHeight + window.plannedRows.length + window.bottomSpacerHeight).toBe(
      g.bodyHeight
    );
  });

  it('clamps a window that starts above the body', () => {
    const window = resolveVisiblePlannedRowWindow({
      plannedRows: labels(4),
      sectionGeometry: geometry([1, 1, 1, 1]),
      visibleBodyBounds: { top: -10, height: 12 },
    });
    expect(window.plannedRows).toEqual(['row:0', 'row:1']);
    expect(window.topSpacerHeight).toBe(0);
    expect(window.bottomSpacerHeight).toBe(2);
  });

  it('degrades to pure spacers when the window sits entirely below the body', () => {
    const g = geometry([1, 1, 1, 1]);
    const window = resolveVisiblePlannedRowWindow({
      plannedRows: labels(4),
      sectionGeometry: g,
      visibleBodyBounds: { top: 100, height: 10 },
    });
    expect(window.plannedRows).toEqual([]);
    expect(window.topSpacerHeight + window.bottomSpacerHeight).toBe(g.bodyHeight);
  });

  it('keeps zero-height structural rows attached to the visible edge', () => {
    // row:1 is hidden (height 0) directly above the visible band.
    const window = resolveVisiblePlannedRowWindow({
      plannedRows: labels(5),
      sectionGeometry: geometry([2, 0, 1, 1, 2]),
      visibleBodyBounds: { top: 2, height: 1 },
    });
    expect(window.plannedRows).toEqual(['row:1', 'row:2']);
    expect(window.topSpacerHeight).toBe(2);
    expect(window.bottomSpacerHeight).toBe(3);
  });

  it('falls back to the full row set when bounds and rows disagree in length', () => {
    const window = resolveVisiblePlannedRowWindow({
      plannedRows: labels(3),
      sectionGeometry: geometry([1, 1]),
      visibleBodyBounds: { top: 0, height: 1 },
    });
    expect(window.plannedRows).toEqual(labels(3));
    expect(window.topSpacerHeight).toBe(0);
    expect(window.bottomSpacerHeight).toBe(0);
  });

  it('spacer heights stay exact over variable-height rows', () => {
    // Tops: [0, 3, 4, 8, 9]; a [3.5, 5.5) window overlaps row:1 [3,4) and row:2 [4,8).
    const g = geometry([3, 1, 4, 1, 5]);
    const window = resolveVisiblePlannedRowWindow({
      plannedRows: labels(5),
      sectionGeometry: g,
      visibleBodyBounds: { top: 3.5, height: 2 },
    });
    expect(window.plannedRows).toEqual(['row:1', 'row:2']);
    expect(window.topSpacerHeight).toBe(3);
    expect(window.bottomSpacerHeight).toBe(6);
    expect(window.topSpacerHeight + 1 + 4 + window.bottomSpacerHeight).toBe(g.bodyHeight);
  });
});
