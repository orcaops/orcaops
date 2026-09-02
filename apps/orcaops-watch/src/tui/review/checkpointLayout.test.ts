// These measure real diff-render geometry against a real patch, so they bite on a
// row of drift.
//
// The fixture builds a `LayoutPage` — the narrow structural shape geometry
// actually reads. Titles, threads, summaries, decisions, claimed steps and
// denormalized counts are deliberately absent: layout never reads them, so a
// fixture that carried them would be describing a different contract.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DARK_THEME_ID,
  findHeaderOwningFileSection,
  measureSliceRowBounds,
  resolveTheme,
  sliceLineNumberDigits,
} from '@orcaops/diff-render';
import type { ReviewUnit } from '@orcaops/review-core';

import {
  buildCheckpointLayout,
  DEFAULT_ANNOTATION_HEIGHT,
  type LayoutHunk,
  type LayoutPage,
  type LayoutPin,
  type LayoutSlice,
} from './checkpointLayout';
import { captureDiffScrollAnchor, restoreDiffScrollAnchor } from './diffScrollAnchor';
import { buildPatchIndex } from './walkDiff';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const one = 1;
-const two = 2;
+const two = 2 + 0;
+const extra = true;
 const three = 3;
@@ -40,2 +41,3 @@
 function tail() {
+  return 41;
 }
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,2 +11,3 @@
   const z = 2;
+  const w = 3;
   const v = 4;
`;

const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);
const CARD_WIDTH = 80;

type Range = { start: number; end: number } | null;

/** A fixture slice also carries its parent's position, so `pageOf` can mint the hunk. */
type FixtureSlice = LayoutSlice & {
  readonly newStart: number;
  readonly oldStart: number;
  readonly added: number;
  readonly removed: number;
};

function ownedUnit(slice: number, del: Range, add: Range): ReviewUnit {
  const lines =
    (del === null ? 0 : del.end - del.start + 1) + (add === null ? 0 : add.end - add.start + 1);
  return {
    kind: 'owned_slice',
    slice,
    patch_row_start: 0,
    patch_row_end: Math.max(0, lines - 1),
    del_range: del,
    add_range: add,
    lines: Math.max(1, lines),
    owner: { kind: 'checkpoint', artifact: 'A', cp: 1 },
  };
}

function slice(
  sliceKey: string,
  hunkKey: string,
  file: string,
  newStart: number,
  oldStart: number,
  unit: ReviewUnit
): FixtureSlice {
  return { sliceKey, hunkKey, file, newStart, oldStart, added: 1, removed: 0, unit };
}

/** Group slices into file cards, minting one matched parent hunk per hunkKey. */
function pageOf(slices: FixtureSlice[]): LayoutPage {
  const byFile = new Map<string, FixtureSlice[]>();
  for (const s of slices) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  const files = [...byFile.entries()].map(([file, ss]) => {
    const byHunk = new Map<string, FixtureSlice[]>();
    for (const s of ss) byHunk.set(s.hunkKey, [...(byHunk.get(s.hunkKey) ?? []), s]);
    const hunks: LayoutHunk[] = [...byHunk.entries()].map(([hunkKey, primary]) => ({
      hunkKey,
      file,
      newStart: primary[0]!.newStart,
      oldStart: primary[0]!.oldStart,
      added: primary.reduce((n, s) => n + s.added, 0),
      removed: primary.reduce((n, s) => n + s.removed, 0),
      status: 'matched',
      ownerLabels: [],
      foreignOwnerLabels: [],
    }));
    return { file, slices: ss, hunks };
  });
  return { files, findings: [] };
}

/** Append a parent hunk to a file's card, immutably. */
function addHunk(page: LayoutPage, file: string, hunk: LayoutHunk): LayoutPage {
  return {
    ...page,
    files: page.files.map((group) =>
      group.file === file ? { ...group, hunks: [...group.hunks, hunk] } : group
    ),
  };
}

/** Revise one parent hunk in place, keeping its position in the card's order. */
function reviseHunk(page: LayoutPage, hunkKey: string, patch: Partial<LayoutHunk>): LayoutPage {
  return {
    ...page,
    files: page.files.map((group) => ({
      ...group,
      hunks: group.hunks.map((hunk) => (hunk.hunkKey === hunkKey ? { ...hunk, ...patch } : hunk)),
    })),
  };
}

/** A foreign parent on src/a.ts — the SECOND real hunk of that file's patch. */
const FOREIGN_A2: LayoutHunk = {
  hunkKey: 'hunk_a2',
  file: 'src/a.ts',
  newStart: 41,
  oldStart: 40,
  added: 1,
  removed: 0,
  status: 'foreign',
  ownerLabels: ['cp2'],
  foreignOwnerLabels: ['cp2'],
};

function build(
  page: LayoutPage,
  overrides: {
    annotations?: LayoutPin[];
    cardWidth?: number;
    showLineNumbers?: boolean;
    showHunkHeaders?: boolean;
    wrapLines?: boolean;
    expandedForeignHunks?: ReadonlySet<string>;
    showOwnerLabels?: boolean;
    pinnedFileHeader?: boolean;
    layout?: 'split' | 'stack';
  } = {}
) {
  return buildCheckpointLayout({
    page,
    patch: buildPatchIndex(PATCH),
    theme,
    layout: overrides.layout ?? 'split',
    cardWidth: overrides.cardWidth ?? CARD_WIDTH,
    annotations: overrides.annotations ?? [],
    showLineNumbers: overrides.showLineNumbers,
    showHunkHeaders: overrides.showHunkHeaders,
    wrapLines: overrides.wrapLines,
    expandedForeignHunks: overrides.expandedForeignHunks,
    showOwnerLabels: overrides.showOwnerLabels,
    pinnedFileHeader: overrides.pinnedFileHeader,
  });
}

// Full-hunk units — each slice covers everything its parent hunk changed.
const A1 = slice(
  'hunk_a1:s0',
  'hunk_a1',
  'src/a.ts',
  1,
  1,
  ownedUnit(0, { start: 2, end: 2 }, { start: 2, end: 3 })
);
const A2 = slice(
  'hunk_a2:s0',
  'hunk_a2',
  'src/a.ts',
  41,
  40,
  ownedUnit(0, null, { start: 42, end: 42 })
);
const B1 = slice(
  'hunk_b1:s0',
  'hunk_b1',
  'src/b.ts',
  11,
  10,
  ownedUnit(0, null, { start: 12, end: 12 })
);

// hunk_a1 split into TWO sibling slices: the modify pair (del 2 / add 2) and
// the trailing pure add (add 3) — one parent, two cards.
const A1_MOD = slice(
  'hunk_a1:s0',
  'hunk_a1',
  'src/a.ts',
  1,
  1,
  ownedUnit(0, { start: 2, end: 2 }, { start: 2, end: 2 })
);
const A1_ADD = slice(
  'hunk_a1:s1',
  'hunk_a1',
  'src/a.ts',
  1,
  1,
  ownedUnit(1, null, { start: 3, end: 3 })
);

function comment(target: LayoutPin['target'], commentId?: string): LayoutPin {
  const id = commentId ?? `fixture:${JSON.stringify(target)}`;
  return { annotationId: `comment:${id}`, commentId, height: DEFAULT_ANNOTATION_HEIGHT, target };
}

function measuredHunkHeight(file: string, hunkIndex: number): number {
  const diff = buildPatchIndex(PATCH).fileDiff(file)!;
  return measureSliceRowBounds({
    file: diff,
    hunkIndex,
    layout: 'split',
    width: CARD_WIDTH - 4,
    lineNumberDigits: sliceLineNumberDigits(diff),
    theme,
    highlighted: null,
  }).totalHeight;
}

describe('buildCheckpointLayout', () => {
  it('emits the unit stream FileCard renders, with contiguous prefix-summed tops', () => {
    const layout = build(pageOf([A1, A2, B1]));
    expect(layout.units.map((u) => u.kind)).toEqual([
      'card-header',
      'hunk',
      'hunk',
      'card-end',
      'card-header',
      'hunk',
      'card-end',
    ]);
    let top = 0;
    for (const u of layout.units) {
      expect(u.top).toBe(top);
      expect(u.height).toBeGreaterThan(0);
      top += u.height;
    }
    expect(layout.totalHeight).toBe(top);
    // Card chrome costs are fixed: margin+border+header = 3, bottom border = 1.
    expect(layout.units[0]).toMatchObject({ kind: 'card-header', file: 'src/a.ts', height: 3 });
    expect(layout.units[3]).toMatchObject({ kind: 'card-end', height: 1 });
  });

  it('hunk units carry the measured complete parent height', () => {
    const layout = build(pageOf([A1, A2, B1]));
    const expected = measuredHunkHeight('src/a.ts', 0);
    const unit = layout.units[1]!;
    expect(unit).toMatchObject({
      kind: 'hunk',
      hunkKey: 'hunk_a1',
      primarySliceKeys: ['hunk_a1:s0'],
      sliceTop: 0,
      sliceHeight: expected,
      rowExtras: false,
      height: expected,
      display: 'matched',
    });
    // Every cursor slice resolves its first primary row inside the shared hunk.
    const target = layout.bySliceKey.get('hunk_a1:s0')!;
    expect(target.top).toBeGreaterThan(unit.top);
    expect(target.height).toBeGreaterThan(0);
  });

  it('prices two sibling slices of ONE parent as one complete hunk unit', () => {
    const layout = build(pageOf([A1_MOD, A1_ADD]));
    const units = layout.units.filter((u) => u.kind === 'hunk');
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      hunkKey: 'hunk_a1',
      primarySliceKeys: ['hunk_a1:s0', 'hunk_a1:s1'],
      sliceHeight: measuredHunkHeight('src/a.ts', 0),
    });
    expect(layout.bySliceKey.size).toBe(2);
    expect(layout.bySliceKey.get('hunk_a1:s0')!.top).toBeLessThan(
      layout.bySliceKey.get('hunk_a1:s1')!.top
    );
  });

  it('sections mirror the hunk units for the vendored file-render window', () => {
    const layout = build(pageOf([A1, A2, B1]));
    expect(layout.sections.map((s) => s.fileId)).toEqual(['hunk_a1', 'hunk_a2', 'hunk_b1']);
    for (const [i, s] of layout.sections.entries()) {
      const unit = layout.units.filter((u) => u.kind === 'hunk')[i]!;
      expect(s.sectionIndex).toBe(i);
      expect(s.sectionTop).toBe(unit.top);
      expect(s.sectionBottom).toBe(unit.top + unit.height);
    }
  });

  it('file sections cover complete contiguous cards for outer virtualization', () => {
    const layout = build(pageOf([A1, A2, B1]));
    expect(layout.fileSections.map((section) => section.fileId)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(layout.fileSections[0]?.sectionTop).toBe(0);
    expect(layout.fileSections[0]?.sectionBottom).toBe(layout.fileSections[1]?.sectionTop);
    expect(layout.fileSections[1]?.sectionBottom).toBe(layout.totalHeight);

    for (const section of layout.fileSections) {
      const units = layout.units.filter((unit) => unit.file === section.fileId);
      expect(section.sectionTop).toBe(units[0]?.top);
      expect(section.sectionBottom).toBe((units.at(-1)?.top ?? -1) + (units.at(-1)?.height ?? -1));
    }
  });

  it('prices the fixed file header once and records exact in-stream handoff rows', () => {
    const page = pageOf([A1, A2, B1]);
    const ordinary = build(page);
    const sticky = build(page, { pinnedFileHeader: true });

    expect(ordinary.units.filter((unit) => unit.kind === 'card-header')).toMatchObject([
      { file: 'src/a.ts', height: 3 },
      { file: 'src/b.ts', height: 3 },
    ]);
    expect(ordinary.units.filter((unit) => unit.kind === 'card-end')).toMatchObject([
      { file: 'src/a.ts', height: 1 },
      { file: 'src/b.ts', height: 1 },
    ]);
    expect(sticky.totalHeight).toBe(ordinary.totalHeight - 1);
    expect(sticky.units.filter((unit) => unit.kind === 'card-header')).toMatchObject([
      { file: 'src/a.ts', height: 2 },
      { file: 'src/b.ts', height: 3 },
    ]);
    expect(sticky.fileSections[0]).toMatchObject({
      fileId: 'src/a.ts',
      sectionTop: 0,
      headerTop: 0,
      bodyTop: 2,
    });
    const second = sticky.fileSections[1]!;
    expect(second.headerTop).toBe(second.sectionTop + 2);
    expect(second.bodyTop).toBe(second.headerTop + 1);
    expect(second.sectionBottom).toBe(sticky.totalHeight);

    // Margin and rule still belong to the old pinned name. When the next path
    // itself reaches the top both names coexist for one row; its body then takes
    // ownership and the fixed row changes without a gap or duplicate at rest.
    const pinnedAt = (scrollTop: number) =>
      findHeaderOwningFileSection(sticky.fileSections, Math.max(0, scrollTop - 1))?.fileId;
    expect(pinnedAt(second.sectionTop)).toBe('src/a.ts');
    expect(pinnedAt(second.headerTop)).toBe('src/a.ts');
    expect(pinnedAt(second.bodyTop)).toBe('src/b.ts');
  });

  it('prices a foreign-only real hunk as one explicit collapsed row', () => {
    const page = addHunk(pageOf([A1]), 'src/a.ts', FOREIGN_A2);

    const layout = build(page);
    const hunks = layout.units.filter((u) => u.kind === 'hunk');
    expect(hunks).toHaveLength(2);
    expect(hunks[1]).toMatchObject({
      hunkKey: 'hunk_a2',
      display: 'collapsed',
      sliceHeight: 1,
      height: 1,
    });

    const expanded = build(page, { expandedForeignHunks: new Set(['hunk_a2']) });
    const expandedHunk = expanded.units.filter((u) => u.kind === 'hunk')[1]!;
    // 'expanded-foreign', NOT 'matched': it renders the same canonical body, but
    // only it carries the `▴ … hide` affordance, and layout is the one place that
    // decides so the renderer cannot disagree by a row.
    expect(expandedHunk).toMatchObject({
      hunkKey: 'hunk_a2',
      display: 'expanded-foreign',
      sliceTop: 1, // the hide header, priced here because the renderer draws it
      sliceHeight: measuredHunkHeight('src/a.ts', 1),
    });
    // The collapsed row (1) becomes the hide header (1) + the real body.
    expect(expanded.totalHeight).toBe(
      layout.totalHeight - 1 + 1 + measuredHunkHeight('src/a.ts', 1)
    );

    // A page-owned hunk stays 'matched' even when it holds subdued foreign cells,
    // so it never sprouts a hide header it has no business showing.
    expect(expanded.units.filter((u) => u.kind === 'hunk')[0]).toMatchObject({
      hunkKey: 'hunk_a1',
      display: 'matched',
      sliceTop: 0,
    });

    const foreignRowKey = 'hunk:hunk_a2:add:42';
    const foreignRow = expanded.bySourceAnchorKey.get(foreignRowKey)!;
    const captured = captureDiffScrollAnchor(expanded, foreignRow.top)!;
    expect(restoreDiffScrollAnchor(layout, captured)).toBe(
      layout.bySourceAnchorKey.get('hunk:hunk_a2:start')!.top
    );
  });

  it('prices the hide header and the owner explanation as two independent rows', () => {
    // labelHeight is a SUM: `i` (show owners) must not silently remove the hide
    // affordance, so the two one-row labels are priced independently.
    const page = addHunk(pageOf([A1]), 'src/a.ts', FOREIGN_A2);
    const expandedForeignHunks = new Set(['hunk_a2']);

    const hideOnly = build(page, { expandedForeignHunks });
    const withOwners = build(page, { expandedForeignHunks, showOwnerLabels: true });
    const hunkOf = (l: ReturnType<typeof build>) => l.units.filter((u) => u.kind === 'hunk')[1]!;

    expect(hunkOf(hideOnly).sliceTop).toBe(1); // hide header only
    expect(hunkOf(withOwners).sliceTop).toBe(2); // + the owner explanation
    expect(withOwners.totalHeight).toBe(hideOnly.totalHeight + 1);
  });

  it('indexes every hunk unit by key so `z` can anchor without rebuilding the map', () => {
    const layout = build(pageOf([A1, A2, B1]));
    const units = layout.units.filter((u) => u.kind === 'hunk');
    expect([...layout.byHunkKey.keys()]).toEqual(units.map((u) => u.hunkKey));
    for (const unit of units) expect(layout.byHunkKey.get(unit.hunkKey)).toBe(unit);
  });

  it('resolves identical slice bounds across a foreign toggle (the primary.length guard)', () => {
    // buildPlannedSliceRows is skipped for hunks with no primary slices. That is
    // only behavior-preserving because a foreign hunk contributes nothing to
    // bySliceKey — assert it, so the perf guard can never quietly move a cursor.
    const page = addHunk(pageOf([A1]), 'src/a.ts', FOREIGN_A2);

    const collapsed = build(page);
    const expanded = build(page, { expandedForeignHunks: new Set(['hunk_a2']) });
    expect([...expanded.bySliceKey.entries()]).toEqual([...collapsed.bySliceKey.entries()]);
  });

  it('prices file pins as 4-row units under the card header', () => {
    const page = pageOf([A1, A2, B1]);
    const bare = build(page);
    const pinned = build(page, {
      annotations: [comment({ kind: 'file', file: 'src/a.ts' })],
    });
    expect(pinned.units.map((u) => u.kind)).toEqual([
      'card-header',
      'pin',
      'hunk',
      'hunk',
      'card-end',
      'card-header',
      'hunk',
      'card-end',
    ]);
    expect(pinned.units[1]).toMatchObject({ kind: 'pin', height: 4 });
    expect(pinned.totalHeight).toBe(bare.totalHeight + 4);

    const pinTop = pinned.units[1]!.top;
    const captured = captureDiffScrollAnchor(pinned, pinTop + 2)!;
    const relaid = build(page, {
      annotations: [comment({ kind: 'file', file: 'src/a.ts' })],
      showHunkHeaders: false,
    });
    expect(restoreDiffScrollAnchor(relaid, captured)).toBe(pinTop + 2);
  });

  it('folds slice pins into sliceTop and line pins into per-row extras', () => {
    const page = pageOf([A1]);
    const bare = build(page);
    const bareUnit = bare.units[1]!;
    expect(bareUnit.kind).toBe('hunk');

    const withSlicePin = build(page, {
      annotations: [comment({ kind: 'slice', sliceKey: 'hunk_a1:s0' })],
    });
    const sp = withSlicePin.units[1]!;
    expect(sp).toMatchObject({ kind: 'hunk', sliceTop: 4, rowExtras: false });
    expect(sp.height).toBe(bareUnit.height + 4);

    const withLinePin = build(page, {
      annotations: [comment({ kind: 'line', sliceKey: 'hunk_a1:s0', side: 'add', line: 2 })],
    });
    const lp = withLinePin.units[1]!;
    expect(lp).toMatchObject({ kind: 'hunk', sliceTop: 0, rowExtras: true });
    expect(lp.height).toBe(bareUnit.height + 4);
  });

  it('measures a reviewer comment and semantic card independently on the same row', () => {
    const page = pageOf([A1]);
    const bare = build(page);
    const target = {
      kind: 'line',
      sliceKey: A1.sliceKey,
      side: 'add',
      line: 2,
    } as const;
    const measured = build(page, {
      annotations: [
        {
          annotationId: 'comment:same-row',
          height: 4,
          target,
        },
        {
          annotationId: 'semantic:same-row',
          height: 4,
          target,
        },
      ],
    });
    const source = measured.bySourceAnchorKey.get('hunk:hunk_a1:add:2')!;
    const commentCard = measured.bySourceAnchorKey.get('comment:same-row')!;
    const semanticCard = measured.bySourceAnchorKey.get('semantic:same-row')!;

    expect(measured.totalHeight).toBe(bare.totalHeight + 8);
    expect(commentCard).toMatchObject({ top: source.top + source.height, height: 4 });
    expect(semanticCard).toMatchObject({ top: commentCard.top + commentCard.height, height: 4 });
  });

  it('includes preceding line pins in later slice scroll targets', () => {
    const page = pageOf([A1_MOD, A1_ADD]);
    const bare = build(page);
    const pinned = build(page, {
      annotations: [comment({ kind: 'line', sliceKey: A1_MOD.sliceKey, side: 'add', line: 2 })],
    });

    expect(pinned.bySliceKey.get(A1_MOD.sliceKey)!.height).toBe(
      bare.bySliceKey.get(A1_MOD.sliceKey)!.height + 4
    );
    expect(pinned.bySliceKey.get(A1_ADD.sliceKey)!.top).toBe(
      bare.bySliceKey.get(A1_ADD.sliceKey)!.top + 4
    );
  });

  it('does not price a line pin whose row is absent from the rendered hunk', () => {
    const page = pageOf([A1]);
    const bare = build(page);
    const stale = build(page, {
      annotations: [comment({ kind: 'line', sliceKey: A1.sliceKey, side: 'add', line: 999 })],
    });
    expect(stale.totalHeight).toBe(bare.totalHeight);
    expect(stale.bySliceKey.get(A1.sliceKey)).toEqual(bare.bySliceKey.get(A1.sliceKey));
  });

  it('prices the optional foreign-owner explanation row exactly once', () => {
    const page = reviseHunk(pageOf([A1]), 'hunk_a1', { foreignOwnerLabels: ['cp2'] });
    const hidden = build(page);
    const shown = build(page, { showOwnerLabels: true });
    expect(shown.totalHeight).toBe(hidden.totalHeight + 1);
    expect(shown.units[1]).toMatchObject({ kind: 'hunk', sliceTop: 1 });
    expect(shown.bySliceKey.get('hunk_a1:s0')!.top).toBe(
      hidden.bySliceKey.get('hunk_a1:s0')!.top + 1
    );
  });

  it('maps slices of a diff-less file onto the card placeholder note', () => {
    const ghost = slice(
      'hunk_ghost:s0',
      'hunk_ghost',
      'src/missing.ts',
      5,
      5,
      ownedUnit(0, null, { start: 5, end: 5 })
    );
    const layout = build(pageOf([ghost]));
    expect(layout.units.map((u) => u.kind)).toEqual(['card-header', 'note', 'card-end']);
    expect(layout.units[1]).toMatchObject({ kind: 'note', height: 1 });
    expect(layout.bySliceKey.get('hunk_ghost:s0')).toEqual({
      top: layout.units[1]!.top,
      height: 1,
    });
    expect(layout.sections).toEqual([]);
    expect(layout.fileSections).toEqual([
      expect.objectContaining({
        fileId: 'src/missing.ts',
        sectionTop: 0,
        sectionBottom: layout.totalHeight,
      }),
    ]);

    const noteTop = layout.units[1]!.top;
    const noteAnchor = captureDiffScrollAnchor(layout, noteTop)!;
    const pinned = build(pageOf([ghost]), {
      annotations: [comment({ kind: 'file', file: 'src/missing.ts' })],
    });
    const pinnedNote = pinned.units.find((unit) => unit.kind === 'note')!;
    expect(restoreDiffScrollAnchor(pinned, noteAnchor)).toBe(pinnedNote.top);
    expect(restoreDiffScrollAnchor(layout, captureDiffScrollAnchor(pinned, pinnedNote.top)!)).toBe(
      noteTop
    );
  });

  it('prices a position-unresolvable hunk as its one-line unavailable block', () => {
    const stray = slice(
      'hunk_stray:s0',
      'hunk_stray',
      'src/a.ts',
      999,
      999,
      ownedUnit(0, null, { start: 999, end: 999 })
    );
    const layout = build(pageOf([A1, stray]));
    expect(layout.units.map((u) => u.kind)).toEqual(['card-header', 'hunk', 'hunk', 'card-end']);
    expect(layout.bySliceKey.get('hunk_stray:s0')?.height).toBe(1);
    expect(layout.units[2]).toMatchObject({ kind: 'hunk', display: 'unavailable' });
  });

  it('prices the l/w/M view toggles as geometry inputs', () => {
    const page = pageOf([A1]);
    const bare = build(page).units[1]!;

    // `M` off drops exactly the one @@ header row per slice window (A1's
    // window starts at the hunk header — padding absorbed it).
    const noHeaders = build(page, { showHunkHeaders: false }).units[1]!;
    expect(noHeaders.height).toBe(bare.height - 1);

    // Wrap-off heights are one row per line — line numbers don't change them.
    const noNumbers = build(page, { showLineNumbers: false }).units[1]!;
    expect(noNumbers.height).toBe(bare.height);

    // `w` on at a narrow width grows the measured slice (lines break).
    const narrowFlat = build(page, { cardWidth: 28 });
    const narrowWrapped = build(page, { cardWidth: 28, wrapLines: true });
    expect(narrowWrapped.totalHeight).toBeGreaterThan(narrowFlat.totalHeight);
  });

  it('indexes layout-independent source rows for split/stack restoration', () => {
    const page = pageOf([A1]);
    const split = build(page, { layout: 'split' });
    const stack = build(page, { layout: 'stack' });
    const deletionKey = 'hunk:hunk_a1:delete:2';
    const additionKey = 'hunk:hunk_a1:add:2';

    const splitDeletion = split.bySourceAnchorKey.get(deletionKey)!;
    const splitAddition = split.bySourceAnchorKey.get(additionKey)!;
    expect(splitDeletion).toBe(splitAddition);
    expect(stack.bySourceAnchorKey.get(deletionKey)?.top).toBeLessThan(
      stack.bySourceAnchorKey.get(additionKey)!.top
    );
    expect(restoreDiffScrollAnchor(stack, { keys: [additionKey], offset: 0 })).toBe(
      stack.bySourceAnchorKey.get(additionKey)!.top
    );
  });

  it('keeps a source row anchored when wrapping and comment pins change geometry', () => {
    const page = pageOf([A1_MOD, A1_ADD]);
    const sourceKey = 'hunk:hunk_a1:add:3';
    const before = build(page, { cardWidth: 28, wrapLines: true });
    const sourceTop = before.bySourceAnchorKey.get(sourceKey)!.top;
    const captured = captureDiffScrollAnchor(before, sourceTop)!;
    const after = build(page, {
      cardWidth: 80,
      annotations: [comment({ kind: 'line', sliceKey: A1_MOD.sliceKey, side: 'add', line: 2 })],
    });

    expect(restoreDiffScrollAnchor(after, captured)).toBe(
      after.bySourceAnchorKey.get(sourceKey)!.top
    );
    expect(after.bySourceAnchorKey.get(sourceKey)!.top).toBeGreaterThan(
      build(page, { cardWidth: 80 }).bySourceAnchorKey.get(sourceKey)!.top
    );
  });

  it('keeps the exact inline comment row across split, stack, wrap, and width changes', () => {
    const page = pageOf([A1_MOD, A1_ADD]);
    const target = { kind: 'line', sliceKey: A1_MOD.sliceKey, side: 'add', line: 2 } as const;
    const lineComment = comment(target, 'line-comment');
    const wrappedSplit = build(page, {
      cardWidth: 28,
      wrapLines: true,
      layout: 'split',
      annotations: [lineComment],
    });
    const source = wrappedSplit.bySourceAnchorKey.get('hunk:hunk_a1:add:2')!;
    const pin = wrappedSplit.bySourceAnchorKey.get('comment:line-comment')!;

    // The source row and its trailing comment are distinct semantic units, so the
    // pin's offset is not relative to wrapped source text.
    expect(pin.top).toBe(source.top + source.height);
    expect(pin.height).toBe(4);
    const captured = captureDiffScrollAnchor(wrappedSplit, pin.top + 2)!;
    expect(captured.keys[0]).toBe('comment:line-comment');

    for (const next of [
      build(page, { cardWidth: 28, wrapLines: true, layout: 'stack', annotations: [lineComment] }),
      build(page, { cardWidth: 80, wrapLines: false, layout: 'stack', annotations: [lineComment] }),
      build(page, { cardWidth: 80, wrapLines: false, layout: 'split', annotations: [lineComment] }),
    ]) {
      const nextPin = next.bySourceAnchorKey.get('comment:line-comment')!;
      expect(restoreDiffScrollAnchor(next, captured)).toBe(nextPin.top + 2);
    }
  });

  it('anchors each finding and slice-comment chrome block independently', () => {
    const page = reviseHunk(pageOf([A1]), 'hunk_a1', { foreignOwnerLabels: ['cp2'] });
    const withChrome: LayoutPage = {
      ...page,
      findings: [{ sliceKeys: [A1.sliceKey] }],
    };
    const sliceComment = comment({ kind: 'slice', sliceKey: A1.sliceKey }, 'slice-comment');
    const before = build(withChrome, { annotations: [sliceComment] });
    const unit = before.byHunkKey.get('hunk_a1')!;
    const finding = before.bySourceAnchorKey.get('hunk:hunk_a1:finding-pin:0')!;
    const pin = before.bySourceAnchorKey.get('comment:slice-comment')!;

    expect(finding).toMatchObject({ top: unit.top, height: 4 });
    expect(pin).toMatchObject({ top: unit.top + 4, height: 4 });
    expect(before.bySourceAnchorKey.get('hunk:hunk_a1:body')!.top).toBe(unit.top + 8);

    const findingAnchor = captureDiffScrollAnchor(before, finding.top + 3)!;
    const pinAnchor = captureDiffScrollAnchor(before, pin.top + 2)!;
    const relaid = build(withChrome, {
      annotations: [sliceComment],
      showOwnerLabels: true,
      layout: 'stack',
    });
    expect(restoreDiffScrollAnchor(relaid, findingAnchor)).toBe(
      relaid.bySourceAnchorKey.get('hunk:hunk_a1:finding-pin:0')!.top + 3
    );
    expect(restoreDiffScrollAnchor(relaid, pinAnchor)).toBe(
      relaid.bySourceAnchorKey.get('comment:slice-comment')!.top + 2
    );
  });

  it('counts a finding pin against the slices it cites, like a slice comment', () => {
    // Findings and slice comments are priced from the same 4-row block; a finding
    // that cites a slice must reserve the same space a comment on it would.
    const page = pageOf([A1]);
    const bare = build(page).units[1]!;
    const withFinding = buildCheckpointLayout({
      page: { ...page, findings: [{ sliceKeys: ['hunk_a1:s0'] }] },
      patch: buildPatchIndex(PATCH),
      theme,
      layout: 'split',
      cardWidth: CARD_WIDTH,
      annotations: [],
    }).units[1]!;

    expect(withFinding).toMatchObject({ kind: 'hunk', sliceTop: 4, rowExtras: false });
    expect(withFinding.height).toBe(bare.height + 4);
  });
});
