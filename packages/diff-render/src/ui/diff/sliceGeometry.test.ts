import { describe, expect, it } from 'vitest';

import { diffFileFromPatch } from '../../fromPatch';
import { DEFAULT_DARK_THEME_ID, resolveTheme } from '../themes';
import type { DiffRow, HighlightedDiffCode } from './pierre';
import {
  buildPlannedSliceRows,
  buildSliceStructureRows,
  estimatePlannedRowsWeight,
  estimateSliceGeometryWeight,
  MAX_PLANNED_ROWS_CACHE_ENTRIES,
  MAX_PLANNED_ROWS_CACHE_ENTRY_WEIGHT,
  MAX_PLANNED_ROWS_CACHE_WEIGHT,
  measureSliceRowBounds,
  PlannedRowsCache,
  SliceGeometryCache,
  sliceLineNumberDigits,
} from './sliceGeometry';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 0000001..0000002 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const one = 1;',
  '-const two = 2;',
  '+const two = 2 + 0;',
  '+const extra = true;',
  ' const three = 3;',
  '@@ -40,2 +41,3 @@',
  ' function tail() {',
  '+  return 41;',
  ' }',
].join('\n');

const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);
const file = () => diffFileFromPatch(PATCH, { sourceId: 'slice-geometry-test' });

function plannedRows(count: number, width = 24, hunkIndex = 0): DiffRow[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'stack-line' as const,
    key: `row:${hunkIndex}:${index}`,
    fileId: 'cache-test',
    hunkIndex,
    cell: {
      kind: 'addition' as const,
      sign: '+',
      newLineNumber: index + 1,
      spans: [{ text: `${index.toString().padStart(6, '0')} ${'x'.repeat(width)}` }],
    },
  }));
}

function geometry(rowCount: number) {
  return {
    bounds: Array.from({ length: rowCount }, (_, top) => ({ top, height: 1 })),
    totalHeight: rowCount,
    rows: plannedRows(rowCount),
  };
}

function withoutRenderSpans(row: DiffRow): DiffRow {
  if (row.type === 'split-line') {
    return {
      ...row,
      left: { ...row.left, spans: [] },
      right: { ...row.right, spans: [] },
    };
  }
  if (row.type === 'stack-line') return { ...row, cell: { ...row.cell, spans: [] } };
  return row;
}

function cacheLookup({
  owner,
  hunkIndex = 0,
  highlighted = null,
}: {
  owner: ReturnType<typeof file>;
  hunkIndex?: number;
  highlighted?: HighlightedDiffCode | null;
}) {
  return {
    file: owner,
    hunkIndex,
    layout: 'stack' as const,
    theme,
    highlighted,
  };
}

describe('sliceLineNumberDigits', () => {
  it('derives the shared gutter width from the widest line across all hunks', () => {
    // Hunk 2 reaches line 43 on the new side — two digits for every slice.
    expect(sliceLineNumberDigits(file())).toBe(2);
  });
});

describe('PlannedRowsCache', () => {
  it('does not retain a pathological 5,000-line hunk plan', () => {
    const cache = new PlannedRowsCache();
    const owner = file();
    const huge = plannedRows(5_000, 40);

    expect(estimatePlannedRowsWeight(huge)).toBeGreaterThan(MAX_PLANNED_ROWS_CACHE_ENTRY_WEIGHT);
    expect(cache.set(cacheLookup({ owner }), huge)).toBe(false);
    expect(cache.get(cacheLookup({ owner }))).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
  });

  it('evicts least-recently-used plans under the retained-byte budget', () => {
    const rows = plannedRows(4, 8);
    const entryWeight = estimatePlannedRowsWeight(rows);
    const cache = new PlannedRowsCache({
      maxEntries: 10,
      maxEntryWeight: entryWeight,
      maxWeight: entryWeight * 2,
    });
    const first = file();
    const second = file();
    const third = file();

    expect(cache.set(cacheLookup({ owner: first }), rows)).toBe(true);
    expect(cache.set(cacheLookup({ owner: second }), plannedRows(4, 8))).toBe(true);
    expect(cache.get(cacheLookup({ owner: first }))).toBe(rows);
    expect(cache.set(cacheLookup({ owner: third }), plannedRows(4, 8))).toBe(true);

    expect(cache.get(cacheLookup({ owner: first }))).toBe(rows);
    expect(cache.get(cacheLookup({ owner: second }))).toBeUndefined();
    expect(cache.get(cacheLookup({ owner: third }))).toBeDefined();
    expect(cache.size).toBe(2);
    expect(cache.weight).toBeLessThanOrEqual(entryWeight * 2);
  });

  it('bounds many tiny plans by entry count', () => {
    const cache = new PlannedRowsCache({
      maxEntries: 2,
      maxEntryWeight: Number.POSITIVE_INFINITY,
      maxWeight: Number.POSITIVE_INFINITY,
    });
    const first = file();
    const second = file();
    const third = file();

    expect(cache.set(cacheLookup({ owner: first }), plannedRows(1))).toBe(true);
    expect(cache.set(cacheLookup({ owner: second }), plannedRows(1))).toBe(true);
    expect(cache.set(cacheLookup({ owner: third }), plannedRows(1))).toBe(true);

    expect(cache.get(cacheLookup({ owner: first }))).toBeUndefined();
    expect(cache.get(cacheLookup({ owner: second }))).toBeDefined();
    expect(cache.get(cacheLookup({ owner: third }))).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it('stays within both production budgets across a 48-file, 10-hunk traversal', () => {
    const cache = new PlannedRowsCache();

    for (let fileIndex = 0; fileIndex < 48; fileIndex += 1) {
      const owner = file();
      for (let hunkIndex = 0; hunkIndex < 10; hunkIndex += 1) {
        cache.set(cacheLookup({ owner, hunkIndex }), plannedRows(40, 24, hunkIndex));
      }
    }

    expect(cache.size).toBeLessThanOrEqual(MAX_PLANNED_ROWS_CACHE_ENTRIES);
    expect(cache.weight).toBeLessThanOrEqual(MAX_PLANNED_ROWS_CACHE_WEIGHT);
  });

  it('keeps independently highlighted hunk generations in separate slots', () => {
    const cache = new PlannedRowsCache({
      maxEntries: 10,
      maxEntryWeight: Number.POSITIVE_INFINITY,
      maxWeight: Number.POSITIVE_INFINITY,
    });
    const owner = file();
    const h0Highlight = { deletionLines: [], additionLines: [] } satisfies HighlightedDiffCode;
    const h1Highlight = { deletionLines: [], additionLines: [] } satisfies HighlightedDiffCode;
    const h0Rows = plannedRows(2, 8, 0);
    const h1Rows = plannedRows(3, 8, 1);

    expect(cache.set(cacheLookup({ owner, hunkIndex: 0, highlighted: h0Highlight }), h0Rows)).toBe(
      true
    );
    expect(cache.set(cacheLookup({ owner, hunkIndex: 1, highlighted: h1Highlight }), h1Rows)).toBe(
      true
    );

    expect(cache.get(cacheLookup({ owner, hunkIndex: 0, highlighted: h0Highlight }))).toBe(h0Rows);
    expect(cache.get(cacheLookup({ owner, hunkIndex: 1, highlighted: h1Highlight }))).toBe(h1Rows);
    expect(cache.size).toBe(2);
  });
});

describe('SliceGeometryCache', () => {
  it('actively evicts old owners under entry and byte budgets', () => {
    const sample = geometry(4);
    const weight = estimateSliceGeometryWeight(sample);
    const cache = new SliceGeometryCache({
      maxEntries: 2,
      maxWeight: weight * 2,
      maxEntryWeight: weight,
    });
    const first = file();
    const second = file();
    const third = file();

    expect(cache.set(first, 'split:0', 'a', sample)).toBe(true);
    expect(cache.set(second, 'split:0', 'a', geometry(4))).toBe(true);
    expect(cache.get(first, 'split:0', 'a')).toBe(sample);
    expect(cache.set(third, 'split:0', 'a', geometry(4))).toBe(true);

    expect(cache.get(first, 'split:0', 'a')).toBe(sample);
    expect(cache.get(second, 'split:0', 'a')).toBeUndefined();
    expect(cache.get(third, 'split:0', 'a')).toBeDefined();
    expect(cache.size).toBe(2);
    expect(cache.weight).toBeLessThanOrEqual(weight * 2);
  });

  it('bounds a many-page, multi-layout traversal and rejects an oversized entry', () => {
    const sample = geometry(12);
    const weight = estimateSliceGeometryWeight(sample);
    const cache = new SliceGeometryCache({
      maxEntries: 64,
      maxWeight: weight * 64,
      maxEntryWeight: weight,
    });

    for (let page = 0; page < 48; page += 1) {
      const owner = file();
      for (let hunk = 0; hunk < 10; hunk += 1) {
        for (const layout of ['split', 'stack'] as const) {
          cache.set(owner, `${layout}:${hunk}:nowrap`, `${page}`, geometry(12));
        }
      }
    }

    expect(cache.size).toBeLessThanOrEqual(64);
    expect(cache.weight).toBeLessThanOrEqual(weight * 64);
    const owner = file();
    expect(cache.set(owner, 'split:huge', 'a', geometry(13))).toBe(false);
    expect(cache.get(owner, 'split:huge', 'a')).toBeUndefined();
  });
});

describe('measureSliceRowBounds', () => {
  it('uses structure-only rows with exact render identities and source coordinates', () => {
    const f = file();
    for (const layout of ['split', 'stack'] as const) {
      for (const hunkIndex of f.metadata.hunks.keys()) {
        const shared = { file: f, hunkIndex, layout, theme };
        expect(buildSliceStructureRows(shared)).toEqual(
          buildPlannedSliceRows({ ...shared, highlighted: null }).map(withoutRenderSpans)
        );
      }
    }
  });

  it('returns only the requested hunk and preserves its cached row identity', () => {
    const f = file();
    const shared = { file: f, layout: 'split' as const, theme, highlighted: null };
    const first = buildPlannedSliceRows({ ...shared, hunkIndex: 0 });
    const second = buildPlannedSliceRows({ ...shared, hunkIndex: 1 });

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first.every((row) => row.hunkIndex === 0)).toBe(true);
    expect(second.every((row) => row.hunkIndex === 1)).toBe(true);
    expect(buildPlannedSliceRows({ ...shared, hunkIndex: 0 })).toBe(first);
    expect(buildPlannedSliceRows({ ...shared, hunkIndex: 1 })).toBe(second);
  });

  it('measures contiguous prefix-summed bounds for one hunk slice', () => {
    const geometry = measureSliceRowBounds({
      file: file(),
      hunkIndex: 0,
      layout: 'split',
      width: 96,
      lineNumberDigits: 2,
      theme,
      highlighted: null,
    });
    expect(geometry.bounds.length).toBeGreaterThan(0);
    let expectedTop = 0;
    for (const bound of geometry.bounds) {
      expect(bound.top).toBe(expectedTop);
      expect(bound.height).toBeGreaterThanOrEqual(0);
      expectedTop += bound.height;
    }
    expect(geometry.totalHeight).toBe(expectedTop);
  });

  it('returns the same object identity for the same inputs (cache hit)', () => {
    const f = file();
    const opts = {
      file: f,
      hunkIndex: 0,
      layout: 'split' as const,
      width: 96,
      lineNumberDigits: 2,
      theme,
      highlighted: null,
    };
    const first = measureSliceRowBounds(opts);
    const second = measureSliceRowBounds(opts);
    expect(second).toBe(first);
    expect(second.bounds).toBe(first.bounds);
  });

  it('reuses no-wrap geometry across widths but replaces the wrapped-width slot', () => {
    const f = file();
    const at = (width: number, wrapLines = false) =>
      measureSliceRowBounds({
        file: f,
        hunkIndex: 0,
        layout: 'split',
        width,
        lineNumberDigits: 2,
        theme,
        highlighted: null,
        wrapLines,
      });
    const wide = at(96);
    const narrow = at(60);
    expect(narrow).toBe(wide);

    const wrappedWide = at(96, true);
    const wrappedNarrow = at(60, true);
    expect(wrappedNarrow).not.toBe(wrappedWide);
    // The one wrapped slot was replaced: the original width re-measures fresh.
    expect(at(96, true)).not.toBe(wrappedWide);
    expect(at(96, true)).toBe(at(96, true));
  });

  it('caches hunks independently and keys on the DiffFile object', () => {
    const f = file();
    const shared = {
      layout: 'split' as const,
      width: 96,
      lineNumberDigits: 2,
      theme,
      highlighted: null,
    };
    const h0 = measureSliceRowBounds({ file: f, hunkIndex: 0, ...shared });
    const h1 = measureSliceRowBounds({ file: f, hunkIndex: 1, ...shared });
    expect(h1).not.toBe(h0);
    expect(measureSliceRowBounds({ file: f, hunkIndex: 0, ...shared })).toBe(h0);
    // A different (re-parsed) DiffFile object never shares cache entries.
    expect(measureSliceRowBounds({ file: file(), hunkIndex: 0, ...shared })).not.toBe(h0);
  });

  it('stack layout yields one row per changed line (no split pairing)', () => {
    const f = file();
    const shared = { width: 96, lineNumberDigits: 2, theme, highlighted: null };
    const split = measureSliceRowBounds({ file: f, hunkIndex: 0, layout: 'split', ...shared });
    const stack = measureSliceRowBounds({ file: f, hunkIndex: 0, layout: 'stack', ...shared });
    // Hunk 0 pairs 1 deletion with 2 additions: stacked rows outnumber split rows.
    expect(stack.bounds.length).toBeGreaterThan(split.bounds.length);
  });

  it('prices expanded gaps and scopes their cache key to the addressed hunk', () => {
    const f = file();
    const shared = {
      file: f,
      layout: 'split' as const,
      width: 96,
      lineNumberDigits: 2,
      theme,
      highlighted: null,
    };
    const h0 = measureSliceRowBounds({ ...shared, hunkIndex: 0 });
    const h1 = measureSliceRowBounds({ ...shared, hunkIndex: 1 });
    const gapLines = f.metadata.hunks[1].collapsedBefore;
    expect(gapLines).toBeGreaterThan(0);
    const sourceText = Array.from({ length: 43 }, (_, i) => `line ${i + 1}`).join('\n');
    const expansion = {
      expandedKeys: new Set(['before:1']),
      sourceStatus: { kind: 'loaded' as const, text: sourceText },
      side: 'new' as const,
    };
    // Loaded: the status row stays + one context row per gap line (height 1 each).
    const expanded = measureSliceRowBounds({ ...shared, hunkIndex: 1, expansion });
    expect(expanded.totalHeight).toBe(h1.totalHeight + gapLines);
    // Loading: a label-only change — same height, but a distinct cache slot.
    const loading = measureSliceRowBounds({
      ...shared,
      hunkIndex: 1,
      expansion: { ...expansion, sourceStatus: { kind: 'loading' as const } },
    });
    expect(loading).not.toBe(expanded);
    expect(loading.totalHeight).toBe(h1.totalHeight);
    // A gap addressed at hunk 1 leaves hunk 0's key (and cached slot) alone.
    expect(measureSliceRowBounds({ ...shared, hunkIndex: 0, expansion })).toBe(h0);
  });

  it('does not reuse loaded-source geometry across equal-length source generations', () => {
    const f = file();
    const shared = {
      file: f,
      hunkIndex: 1,
      layout: 'split' as const,
      width: 96,
      lineNumberDigits: 2,
      theme,
      highlighted: null,
    };
    const expandedKeys = new Set(['before:1']);
    const validText = Array.from({ length: 43 }, (_, index) => `line ${index + 1}`).join('\n');
    const invalidText = 'x'.repeat(validText.length);
    const validStatus = { kind: 'loaded' as const, text: validText };
    const valid = measureSliceRowBounds({
      ...shared,
      expansion: { expandedKeys, sourceStatus: validStatus, side: 'new' },
    });
    const replacement = measureSliceRowBounds({
      ...shared,
      expansion: {
        expandedKeys,
        sourceStatus: { kind: 'loaded', text: invalidText },
        side: 'new',
      },
    });

    expect(invalidText).toHaveLength(validText.length);
    expect(replacement).not.toBe(valid);
    expect(replacement.totalHeight).toBeLessThan(valid.totalHeight);

    // Protect callers that replace a mutable status object's text in place too.
    validStatus.text = invalidText;
    const mutated = measureSliceRowBounds({
      ...shared,
      expansion: { expandedKeys, sourceStatus: validStatus, side: 'new' },
    });
    expect(mutated).not.toBe(valid);
    expect(mutated.totalHeight).toBe(replacement.totalHeight);
  });

  it('keys the cache on the render toggles and measures under them', () => {
    const f = file();
    const shared = {
      file: f,
      hunkIndex: 0,
      layout: 'split' as const,
      width: 96,
      lineNumberDigits: 2,
      theme,
      highlighted: null,
    };
    const base = measureSliceRowBounds(shared);
    // Hunk headers off: a fresh geometry, exactly one @@ row (height 1 → 0) shorter.
    const noHeaders = measureSliceRowBounds({ ...shared, showHunkHeaders: false });
    expect(noHeaders).not.toBe(base);
    expect(noHeaders.totalHeight).toBe(base.totalHeight - 1);
    // Wrapping at a narrow width grows heights past one row per line.
    const flat = measureSliceRowBounds({ ...shared, width: 24 });
    const wrapped = measureSliceRowBounds({ ...shared, width: 24, wrapLines: true });
    expect(wrapped.totalHeight).toBeGreaterThan(flat.totalHeight);
    // Gutters cannot change no-wrap heights, but remain a wrapped-width input.
    const plainNumbers = measureSliceRowBounds({ ...shared });
    const noNumbers = measureSliceRowBounds({ ...shared, showLineNumbers: false });
    expect(noNumbers).toBe(plainNumbers);
    const wrappedNoNumbers = measureSliceRowBounds({
      ...shared,
      width: 24,
      wrapLines: true,
      showLineNumbers: false,
    });
    expect(wrappedNoNumbers).not.toBe(wrapped);
  });
});
