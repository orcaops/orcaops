import { describe, expect, it } from 'vitest';

import {
  type ActionRowItem,
  allocateReviewSurfaceHeight,
  allocateShellHeight,
  fitActionRow,
  MAX_PROSE_WIDTH,
  readableProseWidth,
  resolveModalGeometry,
} from './responsiveLayout.js';

const ACTIONS: readonly ActionRowItem[] = [
  {
    id: 'primary',
    fullLabel: 'Review checkpoints',
    shortLabel: 'Review',
    fixedWidth: 2,
    priority: 0,
    required: true,
  },
  {
    id: 'help',
    fullLabel: 'Open help',
    shortLabel: 'Help',
    fixedWidth: 2,
    priority: 1,
    required: true,
  },
  {
    id: 'filter',
    fullLabel: 'Filter destinations',
    shortLabel: 'Filter',
    fixedWidth: 2,
    priority: 2,
  },
  {
    id: 'theme',
    fullLabel: 'Choose theme',
    shortLabel: 'Theme',
    fixedWidth: 2,
    priority: 3,
  },
  {
    id: 'notify',
    fullLabel: 'Toggle notifications',
    shortLabel: 'Notify',
    fixedWidth: 2,
    priority: 4,
  },
];

describe('fitActionRow', () => {
  it.each([80, 110, 160])('never exceeds the %i-column row budget', (budget) => {
    const layout = fitActionRow(ACTIONS, budget, 3);
    expect(layout.occupiedWidth).toBeLessThanOrEqual(budget);
    expect(layout.requiredDroppedIds).toEqual([]);
    expect(layout.items.map((item) => item.id)).toEqual(
      ACTIONS.filter((item) => !layout.droppedIds.includes(item.id)).map((item) => item.id)
    );
  });

  it('reports every short variant and priority drop truthfully', () => {
    const layout = fitActionRow(ACTIONS, 35, 3);
    expect(layout.items.map(({ id, variant }) => [id, variant])).toEqual([
      ['primary', 'short'],
      ['help', 'full'],
      ['filter', 'short'],
    ]);
    expect(layout.droppedIds).toEqual(['theme', 'notify']);
    expect(layout.occupiedWidth).toBe(33);
  });

  it('admits impossible required drops explicitly instead of overflowing', () => {
    const layout = fitActionRow(ACTIONS, 8, 3);
    expect(layout.occupiedWidth).toBeLessThanOrEqual(8);
    expect(layout.requiredDroppedIds).toEqual(['help']);
    expect(layout.droppedIds).toContain('help');
  });
});

describe('resolveModalGeometry', () => {
  it.each([
    { width: 80, height: 12, desiredWidth: 82, desiredHeight: 18 },
    { width: 110, height: 24, desiredWidth: 82, desiredHeight: 28 },
    { width: 160, height: 40, desiredWidth: 82, desiredHeight: 34 },
  ])('reconciles body and actions inside $width×$height', (input) => {
    const geometry = resolveModalGeometry({ ...input, hasActions: true });
    expect(geometry.left + geometry.frameWidth).toBeLessThanOrEqual(input.width);
    expect(geometry.top + geometry.frameHeight).toBeLessThanOrEqual(input.height);
    expect(
      geometry.titleRows +
        geometry.titleGapRows +
        geometry.bodyRows +
        geometry.actionGapRows +
        geometry.actionRows
    ).toBe(geometry.innerRows);
    expect(geometry.actionWidth).toBe(geometry.innerWidth);
  });

  it('returns body capacity from actual height rather than desired height', () => {
    const short = resolveModalGeometry({
      width: 80,
      height: 12,
      desiredWidth: 80,
      desiredHeight: 30,
      hasActions: true,
    });
    const tall = resolveModalGeometry({
      width: 80,
      height: 24,
      desiredWidth: 80,
      desiredHeight: 30,
      hasActions: true,
    });
    expect(short.frameHeight).toBe(10);
    expect(short.bodyRows).toBe(4);
    expect(tall.frameHeight).toBe(22);
    expect(tall.bodyRows).toBe(16);
  });
});

describe('allocateShellHeight', () => {
  it.each([12, 24])('keeps required shell allocations within %i rows', (height) => {
    const layout = allocateShellHeight(height);
    expect(layout.usedRows).toBeLessThanOrEqual(height);
    expect(layout.menuRows + layout.topBarRows + layout.bodyRows + layout.footerRows).toBe(
      layout.usedRows
    );
    expect(layout.railRows + layout.eventRows).toBe(layout.bodyRows);
    expect(layout.menuRows).toBe(1);
    expect(layout.footerRows).toBe(1);
    expect(layout.railRows).toBeGreaterThanOrEqual(6);
  });

  it('yields events and TopBar rows before the primary rail or footer', () => {
    expect(allocateShellHeight(12)).toMatchObject({
      topBarRows: 4,
      bodyRows: 6,
      railRows: 6,
      eventRows: 0,
      footerRows: 1,
    });
    expect(allocateShellHeight(24)).toMatchObject({
      topBarRows: 6,
      bodyRows: 16,
      railRows: 11,
      eventRows: 5,
      footerRows: 1,
    });
  });

  it.each([
    // [width, height] — wide keeps the side-by-side allocation, detail = body.
    [110, 24],
    [160, 40],
  ])('stays side-by-side at %ix%i', (width, height) => {
    const layout = allocateShellHeight(height, width);
    expect(layout.stacked).toBe(false);
    expect(layout.detailRows).toBe(layout.bodyRows);
    expect(layout.railRows + layout.eventRows).toBe(layout.bodyRows);
    expect(layout.usedRows).toBeLessThanOrEqual(height);
  });

  it.each([
    // [width, height, expected] — the stacked contract at concrete dimensions.
    // 80x12: even a compact TopBar cannot reach the 10-row floor → rail collapses.
    [80, 12, { topBarRows: 3, bodyRows: 7, railRows: 0, detailRows: 7 }],
    // 100x15: TopBar yields 3 rows to reach exactly the stacked floor.
    [100, 15, { topBarRows: 3, bodyRows: 10, railRows: 4, detailRows: 6 }],
    // 100x17: TopBar yields a single row — the boundary the floor math must hit.
    [100, 17, { topBarRows: 5, bodyRows: 10, railRows: 4, detailRows: 6 }],
    // 100x24 / 109x24: comfortable stacked splits, detail keeps the majority.
    [100, 24, { topBarRows: 6, bodyRows: 16, railRows: 5, detailRows: 11 }],
    [109, 24, { topBarRows: 6, bodyRows: 16, railRows: 5, detailRows: 11 }],
  ])('stacks at %ix%i with the documented allocation', (width, height, expected) => {
    const layout = allocateShellHeight(height, width);
    expect(layout.stacked).toBe(true);
    expect(layout.eventRows).toBe(0);
    expect(layout).toMatchObject(expected);
    // The stacked invariant: the two panes exactly partition the body.
    expect(layout.detailRows + layout.railRows).toBe(layout.bodyRows);
    expect(layout.detailRows).toBeGreaterThanOrEqual(layout.railRows);
    expect(layout.usedRows).toBeLessThanOrEqual(height);
    expect(layout.menuRows).toBeGreaterThanOrEqual(0);
    expect(layout.topBarRows).toBeGreaterThanOrEqual(0);
    expect(layout.railRows).toBeGreaterThanOrEqual(0);
    expect(layout.detailRows).toBeGreaterThanOrEqual(0);
  });

  it('omitting the width uses the side-by-side allocation', () => {
    expect(allocateShellHeight(24)).toMatchObject({ stacked: false, detailRows: 16 });
  });
});

describe('short-height and prose policies', () => {
  it.each([12, 24])('keeps warning, body, and footer within %i Review rows', (height) => {
    const layout = allocateReviewSurfaceHeight(height, 9);
    expect(layout.usedRows).toBe(height);
    expect(layout.warningRows + layout.bodyRows + layout.footerRows).toBe(height);
    expect(layout.bodyRows).toBeGreaterThanOrEqual(6);
    expect(layout.footerRows).toBe(1);
  });

  it('bounds overflow warnings before reducing the primary body', () => {
    expect(allocateReviewSurfaceHeight(12, 20)).toEqual({
      terminalRows: 12,
      warningRows: 5,
      bodyRows: 6,
      footerRows: 1,
      usedRows: 12,
    });
  });

  it('caps wide prose while retaining the full narrow measure', () => {
    expect(readableProseWidth(80, 4)).toBe(76);
    expect(readableProseWidth(160, 4)).toBe(MAX_PROSE_WIDTH);
    expect(readableProseWidth(220)).toBe(MAX_PROSE_WIDTH);
  });
});
