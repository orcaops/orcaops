import type { ScrollBoxRenderable } from '@opentui/core';
import { describe, expect, it } from 'vitest';

import { scrollByViewport, type ScrollRef, viewportPageRows } from './scroll';

function scrollFixture(top: number, viewportHeight: number) {
  const surface = { scrollTop: top, viewport: { height: viewportHeight } };
  const ref = { current: surface as ScrollBoxRenderable } as ScrollRef;
  return { ref, surface };
}

describe('native viewport-relative paging', () => {
  it('prices full and half pages with one overlap row', () => {
    expect(viewportPageRows(20)).toBe(19);
    expect(viewportPageRows(21, true)).toBe(10);
    expect(viewportPageRows(1)).toBe(1);
  });

  it('reads the live viewport on every page request and clamps at the top', () => {
    const { ref, surface } = scrollFixture(20, 8);
    scrollByViewport(ref, 1);
    expect(surface.scrollTop).toBe(27);
    surface.viewport.height = 13;
    scrollByViewport(ref, 1);
    expect(surface.scrollTop).toBe(39);
    scrollByViewport(ref, -1, true);
    expect(surface.scrollTop).toBe(33);
    surface.scrollTop = 2;
    scrollByViewport(ref, -1);
    expect(surface.scrollTop).toBe(0);
  });
});
