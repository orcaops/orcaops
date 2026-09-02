// Slice geometry — OUR code (not vendored; no MIT header).
//
// Measured row bounds for ONE canonical hunk of a DiffFile: the exact per-row
// terminal heights the consuming app needs for scroll-follow and windowed
// mounting. Rows are built by the same vendored builders DiffSlice renders
// with (buildSplitRowsForHunk/buildStackRowsForHunk, so a leading collapsed
// gap rides along) and each is measured via measureRenderedRowHeight
// under the caller's render config (line numbers / hunk headers / wrapping —
// defaults match DiffSlice's defaults: numbers + headers on, wrapping off).
//
// The caching mirrors the IDEA of hunk's diffSectionGeometry.ts — a WeakMap
// owned by the immutable DiffFile, one bounded slot per hunk replaced when
// the config key changes (so stale widths/layouts don't accumulate) — but
// none of its render-plan coupling: reviewRenderPlan stays
// un-vendored (see ./_boundary.ts).

import type { DiffFile } from '../../core/types';
import type { AppTheme } from '../themes';
import { expandCollapsedRows, type FileSourceStatus } from './expandCollapsedRows';
import { FileSlottedBoundedCache } from './fileSlottedBoundedCache';
import {
  buildSplitRowsForHunk,
  buildSplitStructureRowsForHunk,
  buildStackRowsForHunk,
  buildStackStructureRowsForHunk,
  type DiffRow,
  type HighlightedDiffCode,
  type RenderSpan,
} from './pierre';
import { measureRenderedRowHeight } from './renderRows';

/** Hunk-local vertical bounds of one rendered DiffRow. */
export interface SliceRowBounds {
  top: number;
  height: number;
}

/** Measured geometry of one hunk: per-row bounds (prefix-summed) + total. */
export interface SliceGeometry {
  bounds: SliceRowBounds[];
  totalHeight: number;
  /** Structure-only rows aligned 1:1 with bounds; render spans are never retained here. */
  rows: readonly DiffRow[];
}

/**
 * The gap-expansion state of one file's slice pipeline — a geometry input:
 * expanded gaps splice status + synthesized context rows into the row stream,
 * so measurement must run the SAME expandCollapsedRows the renderer does.
 */
export interface SliceExpansion {
  /** This file's expanded gap keys (gapKey(position, hunkIndex) spellings). */
  expandedKeys: ReadonlySet<string>;
  /** Load state of the expansion side's full source text. */
  sourceStatus: FileSourceStatus | undefined;
  /** Which side's line numbers index the source text (expansionSide(file)). */
  side: 'old' | 'new';
}

/**
 * The side whose full text fills expanded gaps: deleted files have no new
 * side, everything else expands against the new (pinned) tree — the rule
 * hunk's row plan applies.
 */
export function expansionSide(file: DiffFile): 'old' | 'new' {
  return file.metadata.type === 'deleted' ? 'old' : 'new';
}

export interface MeasureSliceRowBoundsOptions {
  file: DiffFile;
  /** 0-based hunk ordinal within the file — the same index DiffSlice renders. */
  hunkIndex: number;
  layout: 'split' | 'stack';
  width: number;
  /** Shared gutter width for the whole file — sliceLineNumberDigits(file). */
  lineNumberDigits: number;
  theme: AppTheme;
  /**
   * Height is highlight-invariant: wrap-free rows are one cell tall, and
   * wrapped rows break on display width alone (wrapSpans ignores span
   * boundaries), so plain and highlighted spans of the same text share geometry.
   */
  highlighted: HighlightedDiffCode | null;
  /** Render toggles — geometry inputs, so each participates in the cache key. */
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  /** Gap-expansion state — a geometry input like the toggles (cache-keyed). */
  expansion?: SliceExpansion;
}

const LINE_NUMBER_DIGITS_CACHE = new WeakMap<DiffFile, number>();

/** Widest line number in the file, so every slice of it shares one gutter width. */
export function sliceLineNumberDigits(file: DiffFile): number {
  const cached = LINE_NUMBER_DIGITS_CACHE.get(file);
  if (cached !== undefined) return cached;
  let maxLine = 1;
  for (const hunk of file.metadata.hunks) {
    const lastOld = hunk.deletionStart + Math.max(0, hunk.deletionCount - 1);
    const lastNew = hunk.additionStart + Math.max(0, hunk.additionCount - 1);
    maxLine = Math.max(maxLine, lastOld, lastNew);
  }
  const digits = Math.max(1, String(maxLine).length);
  LINE_NUMBER_DIGITS_CACHE.set(file, digits);
  return digits;
}

/**
 * The cache-key fragment for an expansion state, scoped to ONE hunk: only gap
 * keys addressing this slice's collapsed rows (`…:<hunkIndex>`) change its
 * rows, so a toggle on another hunk leaves this slot's key (and cache) alone.
 * Loaded source receives its own weak generation identity because it can be
 * replaced independently of the immutable DiffFile that owns this geometry.
 */
type LoadedSourceStatus = Extract<FileSourceStatus, { kind: 'loaded' }>;

interface LoadedSourceGeneration {
  readonly text: string;
  readonly id: number;
}

const LOADED_SOURCE_GENERATIONS = new WeakMap<LoadedSourceStatus, LoadedSourceGeneration>();
let nextLoadedSourceGenerationId = 1;

/**
 * Exact identity for one loaded-source value without hashing the complete file once per hunk.
 *
 * Gap source statuses are immutable render generations in normal use. Keep the text alongside the
 * weak identity anyway so an in-place replacement cannot accidentally inherit its prior geometry.
 * Distinct status objects deliberately receive distinct ids even when their text is equal: a safe
 * cache miss is preferable to stale row bounds, and the WeakMap never retains an old source value.
 */
function loadedSourceGenerationKey(status: LoadedSourceStatus): string {
  const existing = LOADED_SOURCE_GENERATIONS.get(status);
  if (existing !== undefined && existing.text === status.text) {
    return `${status.text.length}:generation:${existing.id}`;
  }

  const generation = { text: status.text, id: nextLoadedSourceGenerationId };
  nextLoadedSourceGenerationId += 1;
  LOADED_SOURCE_GENERATIONS.set(status, generation);
  return `${status.text.length}:generation:${generation.id}`;
}

function expansionKeyFor(expansion: SliceExpansion | undefined, hunkIndex: number): string {
  if (expansion === undefined) return '';
  const relevant = [...expansion.expandedKeys].filter((k) => k.endsWith(`:${hunkIndex}`)).sort();
  if (relevant.length === 0) return '';
  const status = expansion.sourceStatus;
  const statusKey =
    status === undefined
      ? 'none'
      : status.kind === 'loaded'
        ? `loaded:${loadedSourceGenerationKey(status)}`
        : status.kind === 'error'
          ? `error:${status.reason ?? ''}`
          : 'loading';
  return `${relevant.join(',')}|${statusKey}|${expansion.side}`;
}

interface SliceGeometryCacheValue {
  readonly key: string;
  readonly geometry: SliceGeometry;
}

export const MAX_SLICE_GEOMETRY_CACHE_ENTRIES = 1_024;
export const MAX_SLICE_GEOMETRY_CACHE_WEIGHT = 8 * 1024 * 1024;
export const MAX_SLICE_GEOMETRY_CACHE_ENTRY_WEIGHT = 512 * 1024;

/** Conservative retained-byte price for one prefix-summed bounds array. */
export function estimateSliceGeometryWeight(geometry: SliceGeometry): number {
  // Structure rows keep nested cell objects and identity strings but no source
  // or syntax spans. Price them above a bare object floor so the cache cannot
  // hide megabytes of semantic plans behind a bounds-only estimate.
  return 64 + geometry.bounds.length * 32 + geometry.rows.length * 192;
}

export interface SliceGeometryCacheOptions {
  maxEntries?: number;
  maxWeight?: number;
  maxEntryWeight?: number;
}

/**
 * Global byte-budgeted LRU for geometry. PatchIndex owns immutable DiffFiles
 * for an entire review, so a WeakMap by itself does not bound cross-page
 * retention. Eviction actively clears the weak owner's lookup slot too.
 */
export class SliceGeometryCache {
  readonly #cache: FileSlottedBoundedCache<SliceGeometryCacheValue>;

  constructor({
    maxEntries = MAX_SLICE_GEOMETRY_CACHE_ENTRIES,
    maxWeight = MAX_SLICE_GEOMETRY_CACHE_WEIGHT,
    maxEntryWeight = MAX_SLICE_GEOMETRY_CACHE_ENTRY_WEIGHT,
  }: SliceGeometryCacheOptions = {}) {
    this.#cache = new FileSlottedBoundedCache(maxEntries, maxWeight, maxEntryWeight);
  }

  get size() {
    return this.#cache.size;
  }

  get weight() {
    return this.#cache.weight;
  }

  get(file: DiffFile, slotKey: string, key: string): SliceGeometry | undefined {
    return this.#cache.get(file, slotKey, (value) => value.key === key)?.geometry;
  }

  set(file: DiffFile, slotKey: string, key: string, geometry: SliceGeometry): boolean {
    return this.#cache.set(file, slotKey, { key, geometry }, estimateSliceGeometryWeight(geometry));
  }
}

const SLICE_GEOMETRY_CACHE = new SliceGeometryCache();

/**
 * The final planned row array for one canonical hunk — the exact pipeline
 * (build-hunk → expandCollapsedRows) measurement and rendering
 * share, sans highlight spans (row count and identity of indices are
 * highlight-invariant). Callers use it to resolve slice cursor targets against
 * the same canonical indices the geometry prices.
 */
export function buildPlannedSliceRows(options: {
  file: DiffFile;
  hunkIndex: number;
  layout: 'split' | 'stack';
  theme: AppTheme;
  highlighted?: HighlightedDiffCode | null;
  expansion?: SliceExpansion;
  sourceLineSpans?: (line: string | undefined, sourceLineNumber: number) => RenderSpan[];
}): DiffRow[] {
  const {
    file,
    hunkIndex,
    layout,
    theme,
    highlighted = null,
    expansion,
    sourceLineSpans,
  } = options;
  let rows = plannedRowsForHunk(file, hunkIndex, layout, theme, highlighted);
  if (expansion !== undefined && expansion.expandedKeys.size > 0) {
    rows = expandCollapsedRows(rows, {
      layout,
      expandedKeys: expansion.expandedKeys,
      sourceStatus: expansion.sourceStatus,
      sourceLineSpans,
      side: expansion.side,
    });
  }
  return rows;
}

/**
 * Build the exact row identities consumed by geometry, anchors, and line pins
 * without retaining or normalizing render spans for offscreen hunks. Expanded
 * source rows keep their canonical keys and line numbers but deliberately carry
 * empty spans; the mounted DiffSlice builds the presentation-rich plan later.
 */
export function buildSliceStructureRows(options: {
  file: DiffFile;
  hunkIndex: number;
  layout: 'split' | 'stack';
  theme: AppTheme;
  expansion?: SliceExpansion;
}): DiffRow[] {
  const { file, hunkIndex, layout, theme, expansion } = options;
  let rows =
    layout === 'stack'
      ? buildStackStructureRowsForHunk(file, hunkIndex, theme)
      : buildSplitStructureRowsForHunk(file, hunkIndex, theme);
  if (expansion !== undefined && expansion.expandedKeys.size > 0) {
    rows = expandCollapsedRows(rows, {
      layout,
      expandedKeys: expansion.expandedKeys,
      sourceStatus: expansion.sourceStatus,
      // Geometry and anchors need source identities, not styled text. Avoid
      // sanitizing/copying every expanded line until its hunk actually mounts.
      sourceLineSpans: () => [],
      side: expansion.side,
    });
  }
  return rows;
}

interface PlannedRowsCacheValue {
  readonly theme: AppTheme;
  readonly highlighted: WeakRef<HighlightedDiffCode> | null;
  readonly rows: DiffRow[];
}

/**
 * Retain enough nearby hunk plans for a smooth revisit without making a large
 * review permanent. The estimator is deliberately conservative: row objects
 * keep nested cell/span arrays and strings alive, so source character count
 * alone materially underprices their heap cost.
 */
export const MAX_PLANNED_ROWS_CACHE_ENTRIES = 64;
export const MAX_PLANNED_ROWS_CACHE_WEIGHT = 8 * 1024 * 1024;
export const MAX_PLANNED_ROWS_CACHE_ENTRY_WEIGHT = 512 * 1024;

const PLANNED_ARRAY_OVERHEAD = 32;
const PLANNED_ARRAY_SLOT_WEIGHT = 8;
const PLANNED_OBJECT_OVERHEAD = 48;
const PLANNED_STRING_OVERHEAD = 24;
const PLANNED_STRING_CODE_UNIT_WEIGHT = 2;
const PLANNED_ROW_FLOOR = 192;

function estimatePlannedValueWeight(value: unknown, seen: Set<object>): number {
  if (value === null || value === undefined) return 0;

  if (typeof value === 'string') {
    return PLANNED_STRING_OVERHEAD + value.length * PLANNED_STRING_CODE_UNIT_WEIGHT;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (typeof value !== 'object' || seen.has(value)) return 0;

  seen.add(value);
  if (Array.isArray(value)) {
    let weight = PLANNED_ARRAY_OVERHEAD + value.length * PLANNED_ARRAY_SLOT_WEIGHT;
    for (const item of value) weight += estimatePlannedValueWeight(item, seen);
    return weight;
  }

  let weight = PLANNED_OBJECT_OVERHEAD;
  for (const item of Object.values(value)) {
    weight += estimatePlannedValueWeight(item, seen);
  }
  return weight;
}

/** Approximate the bytes retained by one hunk's immutable render-row plan. */
export function estimatePlannedRowsWeight(rows: readonly DiffRow[]): number {
  return Math.max(
    PLANNED_ARRAY_OVERHEAD + rows.length * PLANNED_ROW_FLOOR,
    estimatePlannedValueWeight(rows, new Set())
  );
}

export interface PlannedRowsCacheOptions {
  maxEntries?: number;
  maxWeight?: number;
  maxEntryWeight?: number;
}

interface PlannedRowsCacheLookup {
  file: DiffFile;
  hunkIndex: number;
  layout: 'split' | 'stack';
  theme: AppTheme;
  highlighted: HighlightedDiffCode | null;
}

function plannedRowsSlotKey(hunkIndex: number, layout: 'split' | 'stack') {
  return `${layout}:${hunkIndex}`;
}

/**
 * A byte-budgeted LRU whose weak per-file lookup slots are actively cleared on
 * eviction. A WeakMap alone is not a retention bound: the review's PatchIndex
 * strongly owns its DiffFile objects for the whole session, which in turn
 * keeps every WeakMap value alive.
 *
 * Entries weakly reference both the owner and highlighted HAST generation. The
 * LRU therefore retains only its priced row arrays; it cannot accidentally pin
 * a large syntax result or a DiffFile after the caller releases them.
 */
export class PlannedRowsCache {
  readonly #cache: FileSlottedBoundedCache<PlannedRowsCacheValue>;

  constructor({
    maxEntries = MAX_PLANNED_ROWS_CACHE_ENTRIES,
    maxWeight = MAX_PLANNED_ROWS_CACHE_WEIGHT,
    maxEntryWeight = MAX_PLANNED_ROWS_CACHE_ENTRY_WEIGHT,
  }: PlannedRowsCacheOptions = {}) {
    this.#cache = new FileSlottedBoundedCache(maxEntries, maxWeight, maxEntryWeight);
  }

  get size() {
    return this.#cache.size;
  }

  get weight() {
    return this.#cache.weight;
  }

  /** Read and promote an exact theme/highlight generation. */
  get({ file, hunkIndex, layout, theme, highlighted }: PlannedRowsCacheLookup) {
    return this.#cache.get(file, plannedRowsSlotKey(hunkIndex, layout), (value) => {
      const highlightMatches =
        highlighted === null
          ? value.highlighted === null
          : value.highlighted?.deref() === highlighted;
      return value.theme === theme && highlightMatches;
    })?.rows;
  }

  /**
   * Retain one hunk plan if it fits. Oversized plans remain usable by the
   * current render but are not kept alive after it leaves the viewport.
   */
  set({ file, hunkIndex, layout, theme, highlighted }: PlannedRowsCacheLookup, rows: DiffRow[]) {
    return this.#cache.set(
      file,
      plannedRowsSlotKey(hunkIndex, layout),
      { theme, highlighted: highlighted === null ? null : new WeakRef(highlighted), rows },
      estimatePlannedRowsWeight(rows)
    );
  }
}

const PLANNED_ROWS_CACHE = new PlannedRowsCache();

function plannedRowsForHunk(
  file: DiffFile,
  hunkIndex: number,
  layout: 'split' | 'stack',
  theme: AppTheme,
  highlighted: HighlightedDiffCode | null
): DiffRow[] {
  const lookup = { file, hunkIndex, layout, theme, highlighted };
  const cached = PLANNED_ROWS_CACHE.get(lookup);
  if (cached) return cached;

  const rows =
    layout === 'stack'
      ? buildStackRowsForHunk(file, hunkIndex, highlighted, theme)
      : buildSplitRowsForHunk(file, hunkIndex, highlighted, theme);
  PLANNED_ROWS_CACHE.set(lookup, rows);
  return rows;
}

/**
 * Measure the rendered bounds of each DiffRow in one canonical hunk. Same inputs
 * return the same cached object (array identity holds), so callers can lean on
 * reference equality across re-renders.
 */
export function measureSliceRowBounds({
  file,
  hunkIndex,
  layout,
  width,
  lineNumberDigits,
  theme,
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  expansion,
}: MeasureSliceRowBoundsOptions): SliceGeometry {
  // Keep one replaceable slot per hunk/layout/wrap mode. In no-wrap mode width,
  // gutters, and theme cannot change any row height; retaining that geometry
  // across terminal widths makes resize a host-layout operation instead of a
  // 480-hunk remeasurement. Wrapped slots still replace on every real width or
  // gutter input so their prefix sums remain exact.
  const slotKey = `${hunkIndex}:${layout}:${wrapLines ? 'wrapped' : 'nowrap'}`;
  const expansionKey = expansionKeyFor(expansion, hunkIndex);
  const cacheKey = wrapLines
    ? `${width}:${lineNumberDigits}:${theme.id}:${showLineNumbers ? 1 : 0}:${showHunkHeaders ? 1 : 0}:${expansionKey}`
    : `${showHunkHeaders ? 1 : 0}:${expansionKey}`;
  const cached = SLICE_GEOMETRY_CACHE.get(file, slotKey, cacheKey);
  if (cached !== undefined) return cached;

  // Mirror DiffSlice's pipeline: build the hunk → expand.
  // Spans are omitted — heights are highlight-invariant.
  const measuredRows = wrapLines
    ? buildPlannedSliceRows({
        file,
        hunkIndex,
        layout,
        theme,
        ...(expansion !== undefined ? { expansion } : {}),
      })
    : buildSliceStructureRows({
        file,
        hunkIndex,
        layout,
        theme,
        ...(expansion !== undefined ? { expansion } : {}),
      });
  // Wrapped measurement needs real text widths, but the retained geometry
  // plan and app-level anchors do not. Keep presentation spans out of the
  // geometry LRU even in wrap mode.
  const rows = wrapLines
    ? buildSliceStructureRows({
        file,
        hunkIndex,
        layout,
        theme,
        ...(expansion !== undefined ? { expansion } : {}),
      })
    : measuredRows;
  const bounds: SliceRowBounds[] = [];
  let totalHeight = 0;
  for (const row of measuredRows) {
    // Mirrors DiffSlice's DiffRowView props exactly (no reserved note column).
    const height = measureRenderedRowHeight(
      row,
      width,
      lineNumberDigits,
      showLineNumbers,
      showHunkHeaders,
      wrapLines,
      theme
    );
    bounds.push({ top: totalHeight, height });
    totalHeight += height;
  }

  const geometry: SliceGeometry = { bounds, totalHeight, rows };
  SLICE_GEOMETRY_CACHE.set(file, slotKey, cacheKey, geometry);
  return geometry;
}
