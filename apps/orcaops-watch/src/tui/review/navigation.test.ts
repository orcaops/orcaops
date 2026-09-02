// The navigation tests.
//
// The `z`/`Z` collapse half hand-builds FloorDisplayHunk fixtures. The
// cursor-jump and `/`-filter half types against the lens-neutral `LayoutPage`,
// so one navigation serves a Checkpoint page and a Part page alike.

import { describe, expect, it } from 'vitest';

import type { ReviewUnit } from '@orcaops/review-core';

import type { LayoutPage, LayoutSlice } from './checkpointLayout';
import type { ExpandedGaps, PatchGapHunk } from './gapExpansion';
import {
  collapseTargetAnchorRow,
  type FileExpansion,
  fileMatchesFilter,
  filterNavigatorFiles,
  type FloorDisplayHunk,
  halfPageStep,
  pageStep,
  planFileCollapseState,
  selectVisibleCollapseTarget,
} from './navigation';

function floor(
  hunkKey: string,
  status: FloorDisplayHunk['status'],
  patchHunkIndex: number | null,
  collapsedBefore = 0
): FloorDisplayHunk {
  return { space: 'floor', hunkKey, status, patchHunkIndex, collapsedBefore };
}

const NOTHING_OPEN: FileExpansion = { gaps: new Set(), foreignHunks: new Set() };

const UNIT: ReviewUnit = {
  kind: 'owned_slice',
  slice: 0,
  patch_row_start: 0,
  patch_row_end: 0,
  del_range: null,
  add_range: { start: 1, end: 1 },
  lines: 1,
  owner: { kind: 'checkpoint', artifact: 'A', cp: 1 },
};

function slice(sliceKey: string, file: string): LayoutSlice {
  return { sliceKey, hunkKey: sliceKey.split(':')[0]!, file, unit: UNIT };
}

/** One finding, standing in for the page content the `/` filter must not disturb. */
const FINDINGS = [{ sliceKeys: ['a1:s0'] }];

function pageOf(slices: LayoutSlice[]): LayoutPage {
  const byFile = new Map<string, LayoutSlice[]>();
  for (const s of slices) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  const files = [...byFile.entries()].map(([file, ss]) => ({
    file,
    slices: ss,
    hunks: ss.map((s) => ({
      hunkKey: s.hunkKey,
      file,
      newStart: 1,
      oldStart: 1,
      added: 1,
      removed: 0,
      status: 'matched' as const,
      ownerLabels: [],
      foreignOwnerLabels: [],
    })),
  }));
  return { files, findings: FINDINGS };
}

// a.ts has two slices, b.ts one, c.ts two — reading order.
const SLICES = [
  slice('a1:s0', 'src/a.ts'),
  slice('a2:s0', 'src/a.ts'),
  slice('b1:s0', 'src/b.ts'),
  slice('c1:s0', 'src/c.ts'),
  slice('c2:s0', 'src/c.ts'),
];

describe('selectVisibleCollapseTarget', () => {
  const hunks = [
    floor('h0', 'matched', 0),
    floor('h1', 'foreign', 1, 30),
    floor('h2', 'matched', 2, 12),
  ];

  it('returns a current visible leading gap before looking forward', () => {
    expect(
      selectVisibleCollapseTarget(
        [{ ...hunks[0]!, collapsedBefore: 4 }, hunks[1]!, hunks[2]!],
        'h0',
        NOTHING_OPEN,
        null
      )
    ).toMatchObject({ kind: 'gap', key: 'before:0' });
  });

  it('returns the foreign block before its currently invisible inner gap', () => {
    expect(selectVisibleCollapseTarget(hunks, 'h0', NOTHING_OPEN, null)).toEqual({
      kind: 'foreign-hunk',
      hunkKey: 'h1',
    });
  });

  it('returns the next matched hunk gap and then the trailing gap', () => {
    const matchedMiddle = [hunks[0]!, floor('h1', 'matched', 1), hunks[2]!];
    expect(selectVisibleCollapseTarget(matchedMiddle, 'h1', NOTHING_OPEN, null)).toMatchObject({
      kind: 'gap',
      key: 'before:2',
    });
    expect(
      selectVisibleCollapseTarget(
        [hunks[0]!, hunks[1]!, floor('h2', 'matched', 2)],
        'h2',
        NOTHING_OPEN,
        { key: 'trailing:2', patchHunkIndex: 2 }
      )
    ).toMatchObject({ kind: 'gap', key: 'trailing:2', hunkKey: 'h2' });
  });

  // A stateless target selector re-returns the cursor's leading gap forever, so
  // `z` flips one block instead of walking the file.
  it('walks every collapse block in reading order as each one opens', () => {
    const file = [
      floor('h0', 'matched', 0, 4), // cursor hunk, leading gap
      floor('h1', 'foreign', 1, 30), // hidden hunk that HAS its own leading gap
      floor('h2', 'foreign', 2), // a second hidden hunk
    ];
    const trailing = { key: 'trailing:2', patchHunkIndex: 2 };
    const gaps = new Set<string>();
    const foreignHunks = new Set<string>();
    const seen: string[] = [];

    for (let step = 0; step < 6; step += 1) {
      const target = selectVisibleCollapseTarget(file, 'h0', { gaps, foreignHunks }, trailing);
      if (target === null) {
        seen.push('null');
        break;
      }
      seen.push(target.kind === 'gap' ? target.key : `foreign:${target.hunkKey}`);
      if (target.kind === 'gap') gaps.add(target.key);
      else foreignHunks.add(target.hunkKey);
    }

    expect(seen).toEqual([
      'before:0', // the cursor's own leading gap
      'foreign:h1', // the hidden hunk wins before its inner gap — that row does not exist yet
      'before:1', // ...and now that it is open, the gap it just revealed is next
      'foreign:h2',
      'trailing:2', // the trailing gap comes last, once its host hunk renders
      'null',
    ]);
  });

  it('wraps once and exhausts unopened context earlier in the file', () => {
    const file = [
      floor('h0', 'matched', 0, 4),
      floor('h1', 'matched', 1, 3),
      floor('h2', 'matched', 2),
    ];
    const gaps = new Set<string>();
    const seen: string[] = [];

    for (let step = 0; step < 3; step += 1) {
      const target = selectVisibleCollapseTarget(
        file,
        'h2',
        { gaps, foreignHunks: new Set() },
        null
      );
      if (target === null) {
        seen.push('null');
        break;
      }
      expect(target.kind).toBe('gap');
      seen.push(target.kind === 'gap' ? target.key : `foreign:${target.hunkKey}`);
      if (target.kind === 'gap') gaps.add(target.key);
    }

    expect(seen).toEqual(['before:0', 'before:1', 'null']);
  });

  it('never targets a floor item that resolved to no patch hunk', () => {
    const file = [floor('h0', 'matched', 0), floor('h1', 'foreign', null, 9)];
    expect(selectVisibleCollapseTarget(file, 'h0', NOTHING_OPEN, null)).toBeNull();
  });

  it('holds the trailing gap back until the hunk hosting it renders', () => {
    // The trailing row lives inside the LAST patch hunk's body — which is a
    // collapsed foreign hunk here, so the row does not exist yet.
    const file = [floor('h0', 'matched', 0), floor('h1', 'foreign', 1)];
    const trailing = { key: 'trailing:1', patchHunkIndex: 1 };
    expect(selectVisibleCollapseTarget(file, 'h0', NOTHING_OPEN, trailing)).toEqual({
      kind: 'foreign-hunk',
      hunkKey: 'h1',
    });
    expect(
      selectVisibleCollapseTarget(
        file,
        'h0',
        { gaps: new Set(), foreignHunks: new Set(['h1']) },
        trailing
      )
    ).toMatchObject({ kind: 'gap', key: 'trailing:1', hunkKey: 'h1' });
  });

  it('spells the trailing key from patch space, not the last floor item', () => {
    // The floor's last item resolves to patch hunk 5; a key built from floor
    // ORDER (`trailing:1`) would match no row and `z` would silently do nothing.
    const file = [floor('h0', 'matched', 0), floor('h1', 'matched', 5)];
    const target = selectVisibleCollapseTarget(file, 'h0', NOTHING_OPEN, {
      key: 'trailing:5',
      patchHunkIndex: 5,
    });
    expect(target).toMatchObject({ kind: 'gap', key: 'trailing:5', hunkKey: 'h1' });
  });
});

describe('collapseTargetAnchorRow', () => {
  const unit = { top: 100, sliceTop: 3, sliceHeight: 20 };

  it('anchors a foreign hunk on its own collapsed row', () => {
    expect(collapseTargetAnchorRow({ kind: 'foreign-hunk', hunkKey: 'h1' }, unit)).toBe(100);
  });

  it('anchors a leading gap on the body top and a trailing gap on the body end', () => {
    expect(
      collapseTargetAnchorRow(
        { kind: 'gap', key: 'before:1', hunkKey: 'h1', position: 'before' },
        unit
      )
    ).toBe(103);
    expect(
      collapseTargetAnchorRow(
        { kind: 'gap', key: 'trailing:1', hunkKey: 'h1', position: 'trailing' },
        unit
      )
    ).toBe(122);
  });

  it('reports no anchor when the target has no measured unit', () => {
    expect(
      collapseTargetAnchorRow({ kind: 'foreign-hunk', hunkKey: 'gone' }, undefined)
    ).toBeNull();
  });
});

describe('planFileCollapseState', () => {
  const patch = (...collapsedBefore: number[]): PatchGapHunk[] =>
    collapsedBefore.map((n) => ({ space: 'patch', collapsedBefore: n }));

  const base = {
    file: 'src/a.ts',
    hunks: [floor('h0', 'matched', 0, 4), floor('h1', 'foreign', 1, 30), floor('h2', 'foreign', 2)],
    patchHunks: patch(4, 30, 0),
    hasTrailingGap: true,
    hasSource: true,
  };
  const OTHER: ExpandedGaps = new Map([['src/other.ts', new Set(['before:7'])]]);

  it('opens every expandable block, then closes them all', () => {
    const opened = planFileCollapseState({
      ...base,
      expandedGaps: OTHER,
      expandedForeignHunks: new Set(['other:h9']),
    });
    expect(opened.action).toBe('open');
    expect([...opened.expandedGaps.get('src/a.ts')!].sort()).toEqual([
      'before:0',
      'before:1',
      'trailing:2',
    ]);
    expect([...opened.expandedForeignHunks].sort()).toEqual(['h1', 'h2', 'other:h9']);

    const closed = planFileCollapseState({
      ...base,
      expandedGaps: opened.expandedGaps,
      expandedForeignHunks: opened.expandedForeignHunks,
    });
    expect(closed.action).toBe('close');
    expect(closed.expandedGaps.has('src/a.ts')).toBe(false);
    expect([...closed.expandedForeignHunks]).toEqual(['other:h9']);
    // Another file's expansion state is never collateral damage.
    expect(closed.expandedGaps.get('src/other.ts')).toBe(OTHER.get('src/other.ts'));
  });

  it('converges without a pinned source: hunks open and close, gaps stay out of the store', () => {
    const opened = planFileCollapseState({
      ...base,
      hasSource: false,
      expandedGaps: new Map(),
      expandedForeignHunks: new Set(),
    });
    expect(opened.action).toBe('open');
    expect(opened.gapsUnavailable).toBe(true);
    // No inert gap keys whose sourceStatus could never settle.
    expect(opened.expandedGaps.has('src/a.ts')).toBe(false);
    expect([...opened.expandedForeignHunks].sort()).toEqual(['h1', 'h2']);

    const closed = planFileCollapseState({
      ...base,
      hasSource: false,
      expandedGaps: opened.expandedGaps,
      expandedForeignHunks: opened.expandedForeignHunks,
    });
    expect(closed.action).toBe('close');
    expect([...closed.expandedForeignHunks]).toEqual([]);
  });

  it('never counts an unresolved floor item, so it cannot hold the file open', () => {
    const plan = planFileCollapseState({
      ...base,
      hunks: [floor('h0', 'matched', 0), floor('ghost', 'foreign', null, 12)],
      patchHunks: patch(0),
      hasTrailingGap: false,
      expandedGaps: new Map(),
      expandedForeignHunks: new Set(),
    });
    expect(plan).toMatchObject({ action: 'none', gapsUnavailable: false });
  });

  it('reports none for a file with nothing hidden, preserving both stores', () => {
    const gaps: ExpandedGaps = new Map();
    const foreign = new Set<string>();
    const plan = planFileCollapseState({
      ...base,
      hunks: [floor('h0', 'matched', 0)],
      patchHunks: patch(0),
      hasTrailingGap: false,
      expandedGaps: gaps,
      expandedForeignHunks: foreign,
    });
    expect(plan.action).toBe('none');
    expect(plan.expandedGaps).toBe(gaps);
    expect(plan.expandedForeignHunks).toBe(foreign);
  });
});

describe('pageStep / halfPageStep', () => {
  it('pages one viewport minus a row of overlap, half pages the floor half', () => {
    expect(pageStep(20)).toBe(19);
    expect(halfPageStep(20)).toBe(10);
    expect(halfPageStep(21)).toBe(10);
  });

  it('never steps below one row', () => {
    expect(pageStep(0)).toBe(1);
    expect(pageStep(1)).toBe(1);
    expect(halfPageStep(1)).toBe(1);
  });
});

describe('fileMatchesFilter', () => {
  it('matches case-insensitive substrings on the path', () => {
    expect(fileMatchesFilter('src/tui/ReviewApp.tsx', null, 'reviewapp')).toBe(true);
    expect(fileMatchesFilter('src/tui/ReviewApp.tsx', null, 'TUI')).toBe(true);
    expect(fileMatchesFilter('src/tui/ReviewApp.tsx', null, 'beyond')).toBe(false);
  });

  it('also matches the rename source (prevName)', () => {
    expect(fileMatchesFilter('src/new.ts', 'src/old.ts', 'old')).toBe(true);
    expect(fileMatchesFilter('src/new.ts', null, 'old')).toBe(false);
  });

  it('an empty query matches everything', () => {
    expect(fileMatchesFilter('anything', null, '')).toBe(true);
  });
});

describe('filterNavigatorFiles', () => {
  const files = pageOf(SLICES).files;

  it('filters only navigator destinations by current or renamed path', () => {
    expect(filterNavigatorFiles(files, 'a.ts', () => null).map((file) => file.file)).toEqual([
      'src/a.ts',
    ]);
    expect(
      filterNavigatorFiles(files, 'legacy', (file) =>
        file === 'src/b.ts' ? 'src/legacy.ts' : null
      ).map((file) => file.file)
    ).toEqual(['src/b.ts']);
  });

  it('returns all destinations for a clear filter and no destinations for no match', () => {
    expect(filterNavigatorFiles(files, null, () => null)).toBe(files);
    expect(filterNavigatorFiles(files, '', () => null)).toBe(files);
    expect(filterNavigatorFiles(files, 'no-such-file', () => null)).toEqual([]);
  });
});
