// One checkpoint page, twelve parent hunks, the sixth of them 5,000 rows tall.
//
// Shared by the mounting unit tests (vitest) and the CheckpointDiff render test
// (bun), which cannot import each other — the two runners split over `bun:`
// protocol modules, so a fixture either lives in a plain module like this one or
// gets copied, and a copied fixture drifts.
//
// Twelve hunks is not arbitrary: the mount window overscans by two either side, so
// a page of three (what the app's own harness fixture has) mounts everything no
// matter what the planner decides — and every spacer assertion written against it
// passes whether or not spacers exist. This page is big enough that some hunk is
// always outside the window.

import type { ReviewUnit } from '@orcaops/review-core';

import type { LayoutPage, LayoutPin } from '../../src/tui/review/checkpointLayout';

export const TALL_ADDS = 5000;
export const TALL_HUNK = 'hunk_5';
export const SMALL_ADDS = 3;
export const HUNK_COUNT = 12;
export const TALL_FILE = 'src/big.ts';

interface FixtureHunk {
  readonly key: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly adds: number;
}

export const TALL_HUNKS: readonly FixtureHunk[] = (() => {
  const out: FixtureHunk[] = [];
  let drift = 0;
  for (let i = 0; i < HUNK_COUNT; i += 1) {
    const oldStart = 1 + i * 20;
    const adds = `hunk_${i}` === TALL_HUNK ? TALL_ADDS : SMALL_ADDS;
    out.push({ key: `hunk_${i}`, oldStart, newStart: oldStart + drift, adds });
    drift += adds;
  }
  return out;
})();

export const TALL_PATCH = (() => {
  const lines = [
    `diff --git a/${TALL_FILE} b/${TALL_FILE}`,
    'index 1111111..2222222 100644',
    `--- a/${TALL_FILE}`,
    `+++ b/${TALL_FILE}`,
  ];
  for (const hunk of TALL_HUNKS) {
    lines.push(`@@ -${hunk.oldStart},2 +${hunk.newStart},${2 + hunk.adds} @@`);
    lines.push(` const before_${hunk.key} = 0;`);
    for (let i = 0; i < hunk.adds; i += 1) lines.push(`+const ${hunk.key}_row${i} = ${i};`);
    lines.push(` const after_${hunk.key} = 1;`);
  }
  lines.push('');
  return lines.join('\n');
})();

function ownedUnit(add: { start: number; end: number }): ReviewUnit {
  const lines = add.end - add.start + 1;
  return {
    kind: 'owned_slice',
    slice: 0,
    patch_row_start: 0,
    patch_row_end: Math.max(0, lines - 1),
    del_range: null,
    add_range: add,
    lines,
    owner: { kind: 'checkpoint', artifact: 'A', cp: 1 },
  };
}

/** The added rows sit one below the hunk header's `newStart` (the leading context row). */
export const TALL_PAGE: LayoutPage = {
  files: [
    {
      file: TALL_FILE,
      slices: TALL_HUNKS.map((hunk) => ({
        sliceKey: `${hunk.key}:s0`,
        hunkKey: hunk.key,
        file: TALL_FILE,
        unit: ownedUnit({ start: hunk.newStart + 1, end: hunk.newStart + hunk.adds }),
      })),
      hunks: TALL_HUNKS.map((hunk) => ({
        hunkKey: hunk.key,
        file: TALL_FILE,
        newStart: hunk.newStart,
        oldStart: hunk.oldStart,
        added: hunk.adds,
        removed: 0,
        status: 'matched' as const,
        ownerLabels: [],
        foreignOwnerLabels: [],
      })),
    },
  ],
  findings: [],
};

/**
 * N per-row pins on one slice — the shape whose exact inline heights must stay
 * in lockstep with row windowing.
 *
 * Each carries the real row it hangs on (the slice's first added lines), because a
 * line pin priced against a row that never renders reserves four rows and draws
 * none. `checkpointDiff.render.test.tsx` measures exactly that.
 */
export function tallLinePins(sliceKey: string, count: number): LayoutPin[] {
  const hunk = TALL_HUNKS.find((candidate) => sliceKey.startsWith(`${candidate.key}:`));
  if (hunk === undefined) throw new Error(`no fixture hunk for ${sliceKey}`);
  return Array.from({ length: count }, (_, i) => ({
    annotationId: `fixture:${sliceKey}:line:${i}`,
    height: 4,
    target: {
      kind: 'line' as const,
      sliceKey,
      side: 'add' as const,
      // Stay inside the slice's own added range, whatever its size.
      line: hunk.newStart + 1 + (i % hunk.adds),
    },
  }));
}

/**
 * Pins spread across several hunks, so a unit's `height` and its `sliceHeight`
 * genuinely DIFFER — an unpinned hunk carries no chrome, and a spacer that
 * reserved only the body would then measure identically to a correct one.
 */
export const TALL_CHROME_PINS: readonly LayoutPin[] = [
  {
    annotationId: `fixture:${TALL_HUNK}:slice`,
    height: 4,
    target: { kind: 'slice', sliceKey: `${TALL_HUNK}:s0` },
  },
  ...tallLinePins(`${TALL_HUNK}:s0`, 2),
  {
    annotationId: 'fixture:hunk_0:slice',
    height: 4,
    target: { kind: 'slice', sliceKey: 'hunk_0:s0' },
  },
  ...tallLinePins('hunk_2:s0', 1),
];
