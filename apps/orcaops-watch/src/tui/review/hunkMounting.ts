// What to mount for one hunk of a page, and why.
//
// `DiffSlice.rowWindow` consumes the same measured inline-row heights as
// `buildCheckpointLayout`. A comment pin therefore participates in the visible
// row window instead of forcing the whole parent hunk to mount.

import {
  buildFileRenderWindow,
  type FileRenderWindowPlan,
  type FileSectionLayout,
} from '@orcaops/diff-render';

import type { HunkUnit } from './checkpointLayout';

/** Row-window a mounted hunk only once its body outgrows this many viewports. */
const WINDOW_AFTER_VIEWPORTS = 2;
/** How long a burst keeps its wider mounted-row halo after the last jump. */
export const RAPID_SCROLL_OVERSCAN_IDLE_MS = 160;
// Large discrete jumps start a burst automatically. Native OpenTUI wheel
// events arrive one row at a time, so callers mark that continuous input
// explicitly; this lets wheel scrolling widen the stable window while
// one/two-row keyboard reading keeps the tight normal window.
const RAPID_SCROLL_MIN_DELTA_ROWS = 3;
const RAPID_SCROLL_MIN_VIEWPORT_MULTIPLIER = 3;
// A burst needs enough real rows to absorb commits arriving behind input, not a
// halo proportional to the distance already jumped. Price that working set in
// viewports so short terminals do not pay a desktop-sized allocation. React and
// OpenTUI host nodes make a fifth viewport exceed the product's 1,000-node cap
// at a real 27-row viewport in either layout. Four viewports keeps both layouts
// inside the same hard working-set envelope while retaining roughly six
// painted viewports in the outer band.
const RAPID_SCROLL_MAX_VIEWPORTS = 4;
const RAPID_SCROLL_ABSOLUTE_MAX_OVERSCAN_ROWS = 160;

export function rapidScrollOverscanRowLimit(input: { viewportHeight: number }): number {
  const viewport = Math.max(1, Math.floor(input.viewportHeight));
  return Math.min(RAPID_SCROLL_ABSOLUTE_MAX_OVERSCAN_ROWS, viewport * RAPID_SCROLL_MAX_VIEWPORTS);
}

/**
 * A bounded adaptation of Hunk's rapid-scroll overscan policy. Row-by-row
 * reading keeps the normal window; a page, wheel burst, or distant slice jump
 * temporarily mounts enough real rows around the destination to cover commits
 * arriving behind the input stream.
 */
export function computeRapidScrollOverscanRows(input: {
  deltaRows: number;
  viewportHeight: number;
  continuous?: boolean;
}): number {
  const delta = Math.abs(input.deltaRows);
  if (delta < (input.continuous === true ? 1 : RAPID_SCROLL_MIN_DELTA_ROWS)) return 0;
  const viewport = Math.max(1, Math.floor(input.viewportHeight));
  const maxOverscanRows = rapidScrollOverscanRowLimit(input);
  return Math.min(
    maxOverscanRows,
    Math.max(delta * 2, viewport * RAPID_SCROLL_MIN_VIEWPORT_MULTIPLIER)
  );
}

export interface RowWindow {
  readonly top: number;
  readonly height: number;
}

interface RenderBand {
  readonly top: number;
  readonly bottom: number;
  readonly overscanRows: number;
}

export interface RetainedHunkRenderWindow extends RenderBand {
  readonly sections: FileSectionLayout[];
  readonly anchorScrollTop: number;
  readonly mounted: ReadonlySet<string>;
}

export interface RetainedFileRenderWindow extends RenderBand {
  readonly sections: FileSectionLayout[];
  readonly anchorScrollTop: number;
  readonly plan: FileRenderWindowPlan;
}

/**
 * Price a stable row-coordinate band, rather than re-centering a section-count
 * window on every wheel tick. One viewport remains on either side during normal
 * reading. Rapid-scroll rows enlarge that bounded band, while directional bias
 * spends more of it in front of travel. A non-burst destination mounts the real
 * viewport plus a one-row seam only: app-owned movement commits before the
 * surface moves, and native slider movement must make its distant destination
 * usable synchronously. Clamping transfers unused padding at document edges to
 * the useful side (especially important at scrollTop zero).
 */
function renderBand(input: {
  sections: FileSectionLayout[];
  scrollTop: number;
  viewportHeight: number;
  overscanRows: number;
  direction: -1 | 0 | 1;
}): RenderBand {
  const { sections, direction } = input;
  const viewportHeight = Math.max(1, Math.floor(input.viewportHeight));
  const overscanRows = Math.max(0, Math.floor(input.overscanRows));
  const totalHeight = Math.max(0, sections.at(-1)?.sectionBottom ?? 0);
  // `overscanRows` is the burst's extra retained-row budget. Split it between
  // both sides and add a half-viewport seam only while the burst is active.
  const paddingRows =
    overscanRows === 0
      ? 1
      : Math.max(1, Math.ceil(viewportHeight / 2)) + Math.ceil(overscanRows / 2);
  const bandHeight = Math.min(totalHeight, viewportHeight + paddingRows * 2);
  const backwardRows =
    direction > 0
      ? Math.floor(paddingRows / 2)
      : direction < 0
        ? Math.ceil((paddingRows * 3) / 2)
        : paddingRows;
  const maxTop = Math.max(0, totalHeight - bandHeight);
  const top = Math.min(maxTop, Math.max(0, Math.floor(input.scrollTop) - backwardRows));
  return { top, bottom: top + bandHeight, overscanRows };
}

function retainedBandCovers(
  retained: RenderBand,
  scrollTop: number,
  viewportHeight: number,
  overscanRows: number
): boolean {
  const top = Math.max(0, Math.floor(scrollTop));
  const bottom = top + Math.max(1, Math.floor(viewportHeight));
  return (
    retained.overscanRows === Math.max(0, Math.floor(overscanRows)) &&
    top >= retained.top &&
    bottom <= retained.bottom
  );
}

function scrollDirection(scrollTop: number, anchorScrollTop: number): -1 | 0 | 1 {
  return scrollTop > anchorScrollTop ? 1 : scrollTop < anchorScrollTop ? -1 : 0;
}

export type HunkMount =
  /** Outside the mounted window: an exact-height spacer, so scroll geometry never drifts. */
  | { readonly kind: 'spacer'; readonly height: number }
  /** Mounted whole. */
  | { readonly kind: 'full' }
  /** Mounted as a bounded row band, including any measured inline pin rows. */
  | { readonly kind: 'windowed'; readonly rowWindow: RowWindow };

/**
 * Retain the last committed hunk window while it still contains the viewport.
 * Section boundaries inside that band therefore do not create periodic host
 * remounts during a wheel burst. A native slider jump outside it rebuilds around
 * the observed destination synchronously, without retaining the semantic cursor.
 */
export function planRetainedMountedHunks(
  input: {
    sections: FileSectionLayout[];
    indexBySectionId?: ReadonlyMap<string, number>;
    scrollTop: number;
    viewportHeight: number;
    overscanRows?: number;
  },
  retained: RetainedHunkRenderWindow | null = null
): RetainedHunkRenderWindow | null {
  const { sections, indexBySectionId, scrollTop, viewportHeight, overscanRows = 0 } = input;
  if (sections.length === 0 || viewportHeight <= 0) return null;
  if (
    retained !== null &&
    retained.sections === sections &&
    retainedBandCovers(retained, scrollTop, viewportHeight, overscanRows)
  ) {
    return retained;
  }
  const band = renderBand({
    sections,
    scrollTop,
    viewportHeight,
    overscanRows,
    direction: retained === null ? 0 : scrollDirection(scrollTop, retained.anchorScrollTop),
  });
  const plan = buildFileRenderWindow({
    fileSectionLayouts: sections,
    ...(indexBySectionId !== undefined ? { indexByFileId: indexBySectionId } : {}),
    scrollTop: band.top,
    viewportHeight: band.bottom - band.top,
    overscanFiles: 0,
  });
  const mounted = new Set<string>();
  for (const index of plan.mountedFileIndices) {
    const section = sections[index];
    if (section !== undefined) mounted.add(section.fileId);
  }
  return {
    ...band,
    sections,
    anchorScrollTop: scrollTop,
    mounted,
  };
}

/** File-card counterpart to `planRetainedMountedHunks`. */
export function planRetainedMountedFiles(
  input: {
    sections: FileSectionLayout[];
    indexBySectionId?: ReadonlyMap<string, number>;
    scrollTop: number;
    viewportHeight: number;
    overscanRows?: number;
  },
  retained: RetainedFileRenderWindow | null = null
): RetainedFileRenderWindow | null {
  const { sections, indexBySectionId, scrollTop, viewportHeight, overscanRows = 0 } = input;
  if (sections.length === 0 || viewportHeight <= 0) return null;
  if (
    retained !== null &&
    retained.sections === sections &&
    retainedBandCovers(retained, scrollTop, viewportHeight, overscanRows)
  ) {
    return retained;
  }
  const band = renderBand({
    sections,
    scrollTop,
    viewportHeight,
    overscanRows,
    direction: retained === null ? 0 : scrollDirection(scrollTop, retained.anchorScrollTop),
  });
  const plan = buildFileRenderWindow({
    fileSectionLayouts: sections,
    ...(indexBySectionId !== undefined ? { indexByFileId: indexBySectionId } : {}),
    scrollTop: band.top,
    viewportHeight: band.bottom - band.top,
    overscanFiles: 0,
  });
  return {
    ...band,
    sections,
    anchorScrollTop: scrollTop,
    plan,
  };
}

/**
 * How one hunk mounts. Inline pins are already part of `visualSliceHeight` and
 * the row bounds consumed by DiffSlice, so they do not change this decision.
 */
export function planHunkMount(input: {
  unit: HunkUnit | undefined;
  mounted: ReadonlySet<string> | null;
  scrollTop: number;
  viewportHeight: number;
  /** A queued position that must be rendered before the native surface moves. */
  destinationScrollTop?: number;
  /** A native distant destination may trim partially visible boundary hunks immediately. */
  tightDestinationWindow?: boolean;
  overscanRows?: number;
}): HunkMount {
  const {
    unit,
    mounted,
    scrollTop,
    viewportHeight,
    destinationScrollTop = scrollTop,
    tightDestinationWindow = false,
    overscanRows = 0,
  } = input;

  // Unmeasured: there is no height to reserve, and a zero-height spacer would
  // silently swallow the hunk. Mount it whole and let the render price it.
  if (unit === undefined) return { kind: 'full' };

  if (mounted !== null && !mounted.has(unit.hunkKey)) {
    return { kind: 'spacer', height: unit.height };
  }

  if (viewportHeight <= 0) return { kind: 'full' };
  if (tightDestinationWindow && unit.visualSliceHeight > 0) {
    const bodyTop = unit.top + unit.sliceTop;
    const seam = 1;
    const rowWindow = {
      top: destinationScrollTop - bodyTop - seam,
      height: viewportHeight + seam * 2,
    };
    // Fully contained bodies are cheaper whole; boundary bodies keep only the
    // rows the native destination can paint, plus one row on either side.
    if (rowWindow.top > 0 || rowWindow.top + rowWindow.height < unit.visualSliceHeight) {
      return { kind: 'windowed', rowWindow };
    }
  }
  if (unit.visualSliceHeight <= viewportHeight * WINDOW_AFTER_VIEWPORTS) {
    return { kind: 'full' };
  }

  const halo = Math.max(viewportHeight, overscanRows);
  // Quantize the band origin by its own halo. A one-row wheel tick inside the
  // retained band can then keep the exact same DiffSlice host subtree; the
  // viewport remains contained because the window still spans one halo either
  // side of every destination in the bucket.
  const stableDestination = Math.floor(destinationScrollTop / halo) * halo;

  return {
    kind: 'windowed',
    rowWindow: {
      // Slice-local visual-row space: where the viewport currently sits inside
      // this hunk's BODY (hence `unit.top + unit.sliceTop`, skipping chrome),
      // widened by a viewport either side. Inline pins are measured in this space.
      top: stableDestination - (unit.top + unit.sliceTop) - halo,
      height: viewportHeight + halo * 2,
    },
  };
}
