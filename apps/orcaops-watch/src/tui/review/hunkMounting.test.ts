// The mounting plan, measured against a REAL layout.
//
// Every `rowExtras` and `rowExtraHeightsByKey` here is set by
// `buildCheckpointLayout` pricing a real LayoutPin, never hand-asserted onto a
// fixture unit. The tests defend the agreement between measurement and mounting:
// a pin-aware hunk stays windowed only because its inline rows are exact.

import { describe, expect, it } from 'vitest';

import { DEFAULT_DARK_THEME_ID, type FileSectionLayout, resolveTheme } from '@orcaops/diff-render';

import { buildCheckpointLayout, type LayoutPin } from './checkpointLayout';
import {
  computeRapidScrollOverscanRows,
  type HunkMount,
  planHunkMount,
  planRetainedMountedFiles,
  planRetainedMountedHunks,
  rapidScrollOverscanRowLimit,
} from './hunkMounting';
import { buildPatchIndex } from './walkDiff';
import {
  HUNK_COUNT,
  TALL_CHROME_PINS,
  TALL_HUNK,
  TALL_PAGE,
  TALL_PATCH,
  tallLinePins,
} from '../../../tests/review/tallPageFixture';

const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);
const patch = buildPatchIndex(TALL_PATCH);

function layoutOf(annotations: readonly LayoutPin[] = []) {
  return buildCheckpointLayout({
    page: TALL_PAGE,
    patch,
    theme,
    layout: 'split',
    cardWidth: 80,
    annotations,
  });
}

const PLAIN = layoutOf();
const PINNED = layoutOf(tallLinePins(`${TALL_HUNK}:s0`, 1));
const CHROMED = layoutOf(TALL_CHROME_PINS);

describe('computeRapidScrollOverscanRows', () => {
  it('keeps discrete row reading tight and recognizes continuous one-row wheel input', () => {
    expect(computeRapidScrollOverscanRows({ deltaRows: 2, viewportHeight: 20 })).toBe(0);
    expect(
      computeRapidScrollOverscanRows({ deltaRows: 1, viewportHeight: 20, continuous: true })
    ).toBe(60);
    expect(computeRapidScrollOverscanRows({ deltaRows: 3, viewportHeight: 20 })).toBe(60);
  });

  it('covers burst distance or three viewports within a viewport-priced host budget', () => {
    expect(computeRapidScrollOverscanRows({ deltaRows: 8, viewportHeight: 20 })).toBe(60);
    expect(computeRapidScrollOverscanRows({ deltaRows: 80, viewportHeight: 20 })).toBe(80);
    expect(computeRapidScrollOverscanRows({ deltaRows: 10_000, viewportHeight: 20 })).toBe(80);
  });

  it('respects the viewport budget and never exceeds the absolute cap', () => {
    expect(rapidScrollOverscanRowLimit({ viewportHeight: 20 })).toBe(80);
    expect(
      computeRapidScrollOverscanRows({
        deltaRows: 10_000,
        viewportHeight: 20,
      })
    ).toBe(80);
    expect(
      computeRapidScrollOverscanRows({
        deltaRows: 10_000,
        viewportHeight: 100,
      })
    ).toBe(160);
  });
});

function tallUnit(layout: ReturnType<typeof layoutOf>) {
  const unit = layout.byHunkKey.get(TALL_HUNK);
  if (unit === undefined) throw new Error(`fixture broken: ${TALL_HUNK} did not measure`);
  return unit;
}

describe('planHunkMount — measured visual-row windowing', () => {
  it('the fixture is genuinely window-eligible by size (so the next test can mean something)', () => {
    const unit = tallUnit(PLAIN);
    expect(unit.display).toBe('matched');
    expect(unit.rowExtras).toBe(false);
    // Comfortably past the 2-viewport threshold at every viewport asserted below.
    expect(unit.sliceHeight).toBeGreaterThan(40 * 2);
  });

  it('windows a tall PINLESS hunk into a bounded band, positioned in visual-row space', () => {
    const unit = tallUnit(PLAIN);
    const mount = planHunkMount({ unit, mounted: null, scrollTop: 500, viewportHeight: 20 });
    expect(mount).toEqual({
      kind: 'windowed',
      rowWindow: { top: 500 - (unit.top + unit.sliceTop) - 20, height: 60 },
    } satisfies HunkMount);
  });

  it('plans a large explicit jump around the destination before the surface moves', () => {
    const unit = tallUnit(PLAIN);
    const destinationScrollTop = 500;
    const mount = planHunkMount({
      unit,
      mounted: null,
      scrollTop: 0,
      viewportHeight: 20,
      destinationScrollTop,
    } as Parameters<typeof planHunkMount>[0] & { destinationScrollTop: number });

    expect(mount).toEqual({
      kind: 'windowed',
      rowWindow: {
        top: destinationScrollTop - (unit.top + unit.sliceTop) - 20,
        height: 60,
      },
    } satisfies HunkMount);
  });

  it('keeps a tall-hunk row band stable across one-row input until its halo boundary', () => {
    const unit = tallUnit(PLAIN);
    const first = planHunkMount({
      unit,
      mounted: null,
      scrollTop: 500,
      viewportHeight: 20,
    });
    expect(first.kind).toBe('windowed');

    for (let scrollTop = 501; scrollTop < 520; scrollTop += 1) {
      const next = planHunkMount({ unit, mounted: null, scrollTop, viewportHeight: 20 });
      expect(next).toEqual(first);
      if (next.kind !== 'windowed') throw new Error('tall fixture stopped windowing');
      const bodyTop = unit.top + unit.sliceTop;
      const globalTop = bodyTop + next.rowWindow.top;
      expect(globalTop).toBeLessThanOrEqual(scrollTop);
      expect(globalTop + next.rowWindow.height).toBeGreaterThanOrEqual(scrollTop + 20);
    }

    expect(planHunkMount({ unit, mounted: null, scrollTop: 520, viewportHeight: 20 })).not.toEqual(
      first
    );
  });

  it('keeps that SAME hunk windowed once one measured per-row pin lands on it', () => {
    const unit = tallUnit(PINNED);
    // The layout priced the pin into both the full visual body and its stable row.
    expect(unit.rowExtras).toBe(true);
    expect(unit.visualSliceHeight).toBe(unit.sliceHeight + 4);
    expect([...unit.rowExtraHeightsByKey.values()]).toEqual([4]);

    const mount = planHunkMount({ unit, mounted: null, scrollTop: 500, viewportHeight: 20 });
    expect(mount).toEqual({
      kind: 'windowed',
      rowWindow: { top: 500 - (unit.top + unit.sliceTop) - 20, height: 60 },
    } satisfies HunkMount);
  });

  it('keeps every pin count in the bounded path across scroll positions and viewports', () => {
    for (const pins of [1, 2, 5]) {
      const layout = layoutOf(tallLinePins(`${TALL_HUNK}:s0`, pins));
      const unit = tallUnit(layout);
      expect(unit.rowExtras).toBe(true);
      expect(unit.visualSliceHeight).toBe(unit.sliceHeight + pins * 4);
      expect([...unit.rowExtraHeightsByKey.values()].reduce((sum, height) => sum + height, 0)).toBe(
        pins * 4
      );

      for (let scrollTop = 0; scrollTop <= layout.totalHeight; scrollTop += 997) {
        for (const viewportHeight of [4, 10, 20, 40]) {
          const mount = planHunkMount({ unit, mounted: null, scrollTop, viewportHeight });
          expect(mount.kind).toBe('windowed');
        }
      }
    }
  });

  it('leaves a short hunk whole — windowing costs a spacer, and a small hunk cannot repay it', () => {
    const unit = PLAIN.byHunkKey.get('hunk_0');
    expect(unit?.rowExtras).toBe(false);
    expect(planHunkMount({ unit, mounted: null, scrollTop: 0, viewportHeight: 40 })).toEqual({
      kind: 'full',
    } satisfies HunkMount);
  });

  it('trims a short boundary hunk only for a native distant destination', () => {
    const unit = PLAIN.byHunkKey.get('hunk_0');
    if (unit === undefined) throw new Error('short fixture hunk did not measure');
    const bodyTop = unit.top + unit.sliceTop;
    const destinationScrollTop = bodyTop + unit.visualSliceHeight - 2;

    expect(
      planHunkMount({
        unit,
        mounted: null,
        scrollTop: destinationScrollTop,
        viewportHeight: 20,
        destinationScrollTop,
      })
    ).toEqual({ kind: 'full' } satisfies HunkMount);
    expect(
      planHunkMount({
        unit,
        mounted: null,
        scrollTop: destinationScrollTop,
        viewportHeight: 20,
        destinationScrollTop,
        tightDestinationWindow: true,
      })
    ).toEqual({
      kind: 'windowed',
      rowWindow: {
        top: unit.visualSliceHeight - 3,
        height: 22,
      },
    } satisfies HunkMount);
  });
});

describe('planHunkMount — spacers', () => {
  it('reserves a skipped hunk at EXACTLY its measured height — pins and chrome included', () => {
    const unit = tallUnit(CHROMED);
    // The premise that makes this bite: the hunk carries a pin ABOVE its body and
    // two per-row pins INSIDE it, so its measured height is strictly more than its
    // body. A spacer reserving only the body shortens the stream by 12 rows, and
    // `G` then lands 12 rows above the real bottom.
    expect(unit.height).toBeGreaterThan(unit.sliceHeight);

    const mount = planHunkMount({
      unit,
      mounted: new Set(['hunk_0']),
      scrollTop: 0,
      viewportHeight: 20,
    });
    expect(mount).toEqual({ kind: 'spacer', height: unit.height } satisfies HunkMount);
  });

  it('conserves total geometry: mounted bodies + spacers = the full measured stream', () => {
    const mounted =
      planRetainedMountedHunks({
        sections: CHROMED.sections,
        scrollTop: 0,
        viewportHeight: 8,
      })?.mounted ?? null;
    expect(mounted).not.toBeNull();
    expect(mounted!.size).toBeLessThan(HUNK_COUNT); // something was actually skipped

    let planned = 0;
    let measured = 0;
    let chromed = 0;
    for (const unit of CHROMED.byHunkKey.values()) {
      const mount = planHunkMount({ unit, mounted, scrollTop: 0, viewportHeight: 8 });
      planned += mount.kind === 'spacer' ? mount.height : unit.height;
      measured += unit.height;
      if (mount.kind === 'spacer' && unit.height > unit.sliceHeight) chromed += 1;
    }
    // At least one SPACER'D hunk must carry chrome, or this sum proves nothing.
    expect(chromed).toBeGreaterThan(0);
    expect(planned).toBe(measured);
  });

  it('mounts an unmeasured hunk whole rather than collapsing it to a zero-height spacer', () => {
    expect(
      planHunkMount({
        unit: undefined,
        mounted: new Set(),
        scrollTop: 0,
        viewportHeight: 20,
      })
    ).toEqual({ kind: 'full' } satisfies HunkMount);
  });
});

function fileSections(count: number, height = 100): FileSectionLayout[] {
  return Array.from({ length: count }, (_unused, sectionIndex) => ({
    fileId: `src/file-${sectionIndex}.ts`,
    sectionIndex,
    sectionTop: sectionIndex * height,
    headerTop: sectionIndex * height,
    bodyTop: sectionIndex * height + 3,
    bodyHeight: height - 4,
    sectionBottom: (sectionIndex + 1) * height,
  }));
}

describe('retained render windows', () => {
  it('keeps one bounded hunk plan through many one-row wheel steps and section boundaries', () => {
    const sections = fileSections(100, 18);
    const initial = planRetainedMountedHunks({
      sections,
      scrollTop: 0,
      viewportHeight: 30,
    });
    expect(initial).not.toBeNull();

    const burst = planRetainedMountedHunks(
      {
        sections,
        scrollTop: 1,
        viewportHeight: 30,
        overscanRows: 90,
      },
      initial
    );
    expect(burst).not.toBe(initial);
    expect(burst).not.toBeNull();
    expect(burst!.mounted.size).toBeLessThanOrEqual(9);

    let retained = burst;
    for (let scrollTop = 2; scrollTop <= 96; scrollTop += 1) {
      const next = planRetainedMountedHunks(
        { sections, scrollTop, viewportHeight: 30, overscanRows: 90 },
        retained
      );
      expect(next).toBe(burst);
      retained = next;
    }
  });

  it('rebuilds immediately around each distant native-slider destination', () => {
    const sections = fileSections(100, 100);
    let retained = planRetainedMountedFiles({
      sections,
      scrollTop: 0,
      viewportHeight: 30,
    });
    expect(retained).not.toBeNull();

    for (const scrollTop of [8_900, 700, 7_600, 1_600, 6_300, 2_900]) {
      const previous = retained;
      retained = planRetainedMountedFiles({ sections, scrollTop, viewportHeight: 30 }, retained);
      expect(retained).not.toBe(previous);
      expect(retained).not.toBeNull();
      expect(retained!.plan.mountedFileIndices).toContain(Math.floor(scrollTop / 100));
      expect(retained!.plan.mountedFileIndices.length).toBeLessThanOrEqual(2);
    }
  });
});
