import { describe, expect, it } from 'vitest';

import { diffDragEdgeDirection } from './dragEdge';

describe('diffDragEdgeDirection', () => {
  it('uses live viewport-relative top and bottom edge bands', () => {
    const classify = (pointerY: number) =>
      diffDragEdgeDirection({ pointerY, viewportTop: 7, viewportHeight: 12 });

    expect(classify(7)).toBe(-1);
    expect(classify(8)).toBe(-1);
    expect(classify(9)).toBeNull();
    expect(classify(16)).toBeNull();
    expect(classify(17)).toBe(1);
    expect(classify(18)).toBe(1);
    expect(classify(6)).toBeNull();
    expect(classify(19)).toBeNull();
  });

  it('bounds the edge band for very short viewports', () => {
    expect(
      diffDragEdgeDirection({ pointerY: 4, viewportTop: 4, viewportHeight: 1, edgeRows: 8 })
    ).toBe(-1);
  });
});
