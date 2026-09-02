import { describe, expect, it } from 'vitest';

import { halfPageStep, pageStep } from './navigation';
import {
  clampScroll,
  maxScroll,
  requiresScrollCommit,
  type ScrollBounds,
  scrollByRows,
  scrollToCenter,
  scrollToShow,
} from './scrollCoordinator';

/** A 20-row viewport onto 100 rows of content: 80 rows of travel. */
const B: ScrollBounds = { viewport: 20, content: 100 };
/** Content shorter than the viewport — nothing to scroll. */
const SHORT: ScrollBounds = { viewport: 20, content: 8 };

describe('bounds', () => {
  it('stops with the last content row on the last viewport row', () => {
    expect(maxScroll(B)).toBe(80);
    expect(clampScroll(999, B)).toBe(80);
    expect(clampScroll(-5, B)).toBe(0);
  });

  it('cannot scroll content shorter than the viewport', () => {
    // Without the floor at 0, `G` on a short page scrolls the content off the top
    // and the reader is left staring at blank rows.
    expect(maxScroll(SHORT)).toBe(0);
    expect(clampScroll(50, SHORT)).toBe(0);
  });
});

describe('paging', () => {
  it('pages down one viewport minus a row of overlap, and stops at the bottom', () => {
    const down = pageStep(B.viewport);
    expect(scrollByRows(0, down, B)).toBe(19);
    expect(scrollByRows(19, down, B)).toBe(38);
    // ...and never past the end, however hard it is pressed.
    expect(scrollByRows(75, down, B)).toBe(80);
    expect(scrollByRows(80, down, B)).toBe(80);
  });

  it('pages up symmetrically, and stops at the top', () => {
    const up = -pageStep(B.viewport);
    expect(scrollByRows(80, up, B)).toBe(61);
    expect(scrollByRows(10, up, B)).toBe(0);
    expect(scrollByRows(0, up, B)).toBe(0);
  });

  it('half-pages by half a viewport', () => {
    expect(scrollByRows(0, halfPageStep(B.viewport), B)).toBe(10);
    expect(scrollByRows(10, -halfPageStep(B.viewport), B)).toBe(0);
  });

  it('`g` and `G` reach both ends exactly', () => {
    expect(clampScroll(0, B)).toBe(0);
    expect(clampScroll(maxScroll(B), B)).toBe(80);
  });
});

describe('scroll commit planning', () => {
  it('skips a settled zero-distance destination', () => {
    expect(requiresScrollCommit({ next: 0, current: 0, planned: 0, pending: null })).toBe(false);
  });

  it('commits a real move, a stale plan, or a superseded pending write', () => {
    expect(requiresScrollCommit({ next: 0, current: 100, planned: 100, pending: null })).toBe(true);
    expect(requiresScrollCommit({ next: 0, current: 0, planned: 100, pending: null })).toBe(true);
    expect(requiresScrollCommit({ next: 0, current: 0, planned: 0, pending: 100 })).toBe(true);
  });

  it('does not duplicate the same already-pending destination', () => {
    expect(requiresScrollCommit({ next: 24, current: 24, planned: 24, pending: 24 })).toBe(false);
  });
});

describe('following the cursor', () => {
  it('does NOT move when the target is already on screen', () => {
    // The property that makes reading bearable: stepping the cursor between two
    // rows that are both visible must not shift the page under the reader's eyes.
    const visible = { top: 5, height: 1 };
    expect(scrollToShow(0, visible, B)).toBe(0);
    expect(scrollToShow(3, { top: 10, height: 2 }, B)).toBe(3);
  });

  it('pulls UP to a target above the fold, showing its top', () => {
    expect(scrollToShow(50, { top: 12, height: 3 }, B)).toBe(12);
  });

  it('pulls DOWN to a target below the fold, showing its END', () => {
    // Scroll the minimum: the target's last row lands on the viewport's last row.
    // Jumping it to the top instead would throw away everything above it that the
    // reader could still have used for context.
    expect(scrollToShow(0, { top: 25, height: 4 }, B)).toBe(9); // 25+4 - 20
  });

  it('shows the TOP of a target taller than the viewport', () => {
    // Showing its end would hide its beginning, which is where a reader starts.
    const tall = { top: 30, height: 50 };
    expect(scrollToShow(0, tall, B)).toBe(30);
    expect(scrollToShow(70, tall, B)).toBe(30);
  });

  it('never scrolls past the end to satisfy a target near the bottom', () => {
    expect(scrollToShow(0, { top: 96, height: 4 }, B)).toBe(80);
  });
});

describe('recentering the cursor', () => {
  it('centers the target and clamps at both ends', () => {
    expect(scrollToCenter({ top: 50, height: 2 }, B)).toBe(41);
    expect(scrollToCenter({ top: 0, height: 1 }, B)).toBe(0);
    expect(scrollToCenter({ top: 99, height: 1 }, B)).toBe(80);
  });
});
