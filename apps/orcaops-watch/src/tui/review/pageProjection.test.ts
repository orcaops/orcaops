// The keystone: what the reviewer SEES lit and what the ledger RECORDS covered
// are the same rows.
//
// These do not fixture the eligible targets — they run the REAL engine projection
// (`buildEligibleNarrativeTargets`) over a real floor and a real patch, then build
// the real reader from it. That is the whole point: coverage rows come from the
// engine's join, display slices come from the projector's join, and the test
// exists to prove those two independent joins over one floor cannot disagree.
// Fixturing the targets would assert the projector against itself.

import { describe, expect, it } from 'vitest';

import {
  type CurrentThreadManifest,
  type Floor,
  replayReviewLedgerV2,
  type ReviewUnit,
} from '@orcaops/review-core';
import { buildCurrentThreadManifests, buildEligibleNarrativeTargets } from '@orcaops/review-engine';

import { pageSlices, unitLineRanges } from './checkpointLayout';
import {
  projectCheckpointPage,
  projectCheckpointReaderPage,
  projectUnassignedReaderPage,
  rowsOfProjectedHunk,
} from './pageProjection';
import { buildDeterministicReader, type CheckpointPage } from './readerModel';

const ARTIFACT = 'artifact-fixture';
const THREAD = 'sec_thread';

// src/a.ts holds three hunks, src/b.ts one.
//
// hunk_a1 is the case the whole slice machinery exists for and the focus mask
// was built to serve: ONE parent hunk carrying TWO slices owned by DIFFERENT
// checkpoints. cp1 owns the modify pair, cp2 owns the trailing pure add. The hunk
// is `matched` on both pages, but each must light only its own rows — a
// projection that hands a page every slice of a hunk it merely touches is
// indistinguishable from a correct one until this case exists.
//
// cp1: hunk_a1/s0 + hunk_b1/s0.  cp2: hunk_a1/s1 + hunk_a2/s0.  hunk_a3: a gap
// slice nobody owns, so every display status appears at least once.
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
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
  '@@ -80,2 +82,3 @@',
  ' const tail2 = 1;',
  '+const gap = true;',
  ' const tail3 = 2;',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -10,2 +11,3 @@',
  '   const z = 2;',
  '+  const w = 3;',
  '   const v = 4;',
  '',
].join('\n');

type Range = { start: number; end: number } | null;

function owned(slice: number, cp: number, del: Range, add: Range): ReviewUnit {
  return {
    kind: 'owned_slice',
    slice,
    patch_row_start: 0,
    patch_row_end: 0,
    del_range: del,
    add_range: add,
    lines: 1,
    owner: { kind: 'checkpoint', artifact: ARTIFACT, cp },
  };
}

/** An unowned gap slice — the hunk that belongs to no checkpoint at all. */
function gap(add: Range): ReviewUnit {
  return {
    kind: 'gap_slice',
    slice: 0,
    patch_row_start: 0,
    patch_row_end: 0,
    del_range: null,
    add_range: add,
    lines: 1,
    owner: null,
  };
}

function item(
  hunkKey: string,
  file: string,
  oldStart: number,
  newStart: number,
  added: number,
  removed: number,
  units: ReviewUnit[]
) {
  return {
    hunkKey,
    file,
    verdict: 'MATCHED',
    old_start: oldStart,
    new_start: newStart,
    added_lines: added,
    removed_lines: removed,
    units,
  };
}

const FLOOR = {
  outline: {
    threads: [
      {
        threadKey: THREAD,
        order: 1,
        title: 'Restore the reading experience',
        artifact: ARTIFACT,
        checkpoints: [
          {
            checkpointKey: 'chap_cp1',
            order: 1,
            checkpoint: { artifact: ARTIFACT, cp: 1, label: 'first' },
            members: [{ artifact: ARTIFACT, cp: 1 }],
            sliceRefs: [
              { hunkKey: 'hunk_a1', slice: 0 }, // the modify pair of the SHARED hunk
              { hunkKey: 'hunk_b1', slice: 0 },
            ],
            citationIds: [],
          },
          {
            checkpointKey: 'chap_cp2',
            order: 2,
            checkpoint: { artifact: ARTIFACT, cp: 2, label: 'second' },
            members: [{ artifact: ARTIFACT, cp: 2 }],
            sliceRefs: [
              { hunkKey: 'hunk_a1', slice: 1 }, // ...and the pure add of the SAME hunk
              { hunkKey: 'hunk_a2', slice: 0 },
            ],
            citationIds: [],
          },
        ],
      },
    ],
    unassigned: { gap: { sliceRefs: [], files: [] }, ambiguous: { hunkKeys: [], files: [] } },
  },
  coverage: {
    // Deliberately NOT in file-position order — the card must sort, and a fixture
    // that arrives pre-sorted cannot tell a working sort from a missing one.
    items: [
      item('hunk_a3', 'src/a.ts', 80, 82, 1, 0, [gap({ start: 83, end: 83 })]),
      item('hunk_b1', 'src/b.ts', 10, 11, 1, 0, [owned(0, 1, null, { start: 12, end: 12 })]),
      item('hunk_a2', 'src/a.ts', 40, 41, 1, 0, [owned(0, 2, null, { start: 42, end: 42 })]),
      item('hunk_a1', 'src/a.ts', 1, 1, 2, 1, [
        owned(0, 1, { start: 2, end: 2 }, { start: 2, end: 2 }),
        owned(1, 2, null, { start: 3, end: 3 }),
      ]),
    ],
  },
  // Read by the finish gate. Omitting them behind the cast would have this floor
  // claim it carries no captured uncertainty when it has never been asked.
  citations: [],
} as unknown as Floor;

/** Build the real reader off the real engine projection. */
async function reader() {
  const eligibleTargets = await buildEligibleNarrativeTargets(FLOOR, PATCH);
  const currentThreads: CurrentThreadManifest[] = await buildCurrentThreadManifests(
    FLOOR,
    eligibleTargets
  );
  const ledger = await replayReviewLedgerV2({ events: [], currentThreads });
  return {
    eligibleTargets,
    model: buildDeterministicReader({
      floor: FLOOR,
      eligibleTargets,
      ledger,
      currentThreads,
      finishFacts: { targets: { ok: true }, currentGapRows: [], comments: [] },
    }),
  };
}

function pageOf(model: Awaited<ReturnType<typeof reader>>['model'], key: string): CheckpointPage {
  const page = model.pages.find((candidate) => candidate.key === key);
  expect(page, `no page ${key}`).toBeDefined();
  return page as CheckpointPage;
}

/** Every (file, side, line) the projection LIGHTS — the rows drawn as this page's own. */
function litRows(page: CheckpointPage): string[] {
  const layout = projectCheckpointPage({ floor: FLOOR, checkpointKey: page.key });
  const rows: string[] = [];
  for (const slice of pageSlices(layout)) {
    const ranges = unitLineRanges(slice.unit);
    if (ranges === null) continue;
    for (const [side, range] of [
      ['delete', ranges.delRange],
      ['add', ranges.addRange],
    ] as const) {
      if (range === null) continue;
      for (let line = range.start; line <= range.end; line += 1) {
        rows.push(`${slice.file} ${side} ${line}`);
      }
    }
  }
  return rows.sort();
}

/** Every (file, side, line) the page's coverage event would RECORD. */
function coveredRows(page: CheckpointPage): string[] {
  return [...page.ownedRows.values()]
    .flat()
    .map((row) => `${row.file} ${row.side} ${row.line}`)
    .sort();
}

describe('what is lit is what is covered', () => {
  it('cp1: the projection lights exactly the rows its coverage event records', async () => {
    // THE invariant. Display reads `checkpoint.sliceRefs` through the projector;
    // coverage reads the SAME sliceRefs through the engine's target join. If these
    // ever drift, the reviewer marks a checkpoint reviewed having been shown code
    // the ledger did not record — a false record of what was reviewed.
    const { model } = await reader();
    const page = pageOf(model, 'chap_cp1');

    expect(litRows(page)).toEqual(coveredRows(page));
    expect(litRows(page)).toEqual([
      'src/a.ts add 2', // hunk_a1 slice 0 — the modify pair...
      'src/a.ts delete 2',
      'src/b.ts add 12',
    ]);
  });

  it('cp2: same invariant, on the SAME parent hunk, lighting different rows', async () => {
    // cp2 owns slice 1 of hunk_a1 — the same parent cp1 owns slice 0 of. Each page
    // must light only its own rows. A projection that hands a page every slice of a
    // hunk it merely touches passes every other test in this file and fails here.
    const { model } = await reader();
    const page = pageOf(model, 'chap_cp2');

    expect(litRows(page)).toEqual(coveredRows(page));
    expect(litRows(page)).toEqual([
      'src/a.ts add 3', // hunk_a1 slice 1 — ...and the trailing pure add
      'src/a.ts add 42', // hunk_a2
    ]);
    // Emphatically NOT cp1's rows, though they share the parent hunk.
    expect(litRows(page)).not.toContain('src/a.ts add 2');
    expect(litRows(page)).not.toContain('src/a.ts delete 2');
  });

  it('the shared parent reads `matched` on both pages', async () => {
    // Both own a slice in it, so neither sees it as somebody else's code — but the
    // focus mask is what keeps them from reading each other's rows as their own.
    const { model } = await reader();
    for (const key of ['chap_cp1', 'chap_cp2']) {
      const layout = projectCheckpointPage({ floor: FLOOR, checkpointKey: pageOf(model, key).key });
      const a = layout.files.find((f) => f.file === 'src/a.ts')!;
      expect(a.hunks.find((h) => h.hunkKey === 'hunk_a1')!.status).toBe('matched');
    }
  });
});

describe('the file card carries the whole file', () => {
  it('projects EVERY parent hunk of a touched file, not just the owned ones', async () => {
    // The defect this replaces: the diff column resolved one hunkKey and rendered
    // it alone, so a reviewer never saw what else lived in the file they were
    // reading, and `j`/`k` crossed file and checkpoint boundaries unmarked.
    const { model } = await reader();
    const layout = projectCheckpointPage({
      floor: FLOOR,
      checkpointKey: pageOf(model, 'chap_cp1').key,
    });

    const a = layout.files.find((f) => f.file === 'src/a.ts')!;
    expect(a.hunks.map((h) => h.hunkKey)).toEqual(['hunk_a1', 'hunk_a2', 'hunk_a3']);
    expect(a.hunks.map((h) => h.status)).toEqual(['matched', 'foreign', 'foreign']);
    // ...but it owns a slice in only ONE of them.
    expect(a.slices.map((s) => s.sliceKey)).toEqual(['hunk_a1:s0']);
  });

  it('orders hunks by position in the file, not by floor order', async () => {
    // The floor hands them over as a3, a2, a1. The card must read top-to-bottom.
    const { model } = await reader();
    const layout = projectCheckpointPage({
      floor: FLOOR,
      checkpointKey: pageOf(model, 'chap_cp2').key,
    });
    const a = layout.files.find((f) => f.file === 'src/a.ts')!;
    expect(a.hunks.map((h) => h.newStart)).toEqual([1, 41, 82]);
    expect(a.hunks.map((h) => h.status)).toEqual(['matched', 'matched', 'foreign']);
    // cp2's own slices, also in reading order: the shared parent, then hunk_a2.
    expect(a.slices.map((s) => s.sliceKey)).toEqual(['hunk_a1:s1', 'hunk_a2:s0']);
  });

  it('only projects the files the checkpoint actually touched', async () => {
    const { model } = await reader();
    expect(
      projectCheckpointPage({
        floor: FLOOR,
        checkpointKey: pageOf(model, 'chap_cp1').key,
      }).files.map((f) => f.file)
    ).toEqual(['src/a.ts', 'src/b.ts']);
    // cp2 never touched src/b.ts — its card must not appear at all.
    expect(
      projectCheckpointPage({
        floor: FLOOR,
        checkpointKey: pageOf(model, 'chap_cp2').key,
      }).files.map((f) => f.file)
    ).toEqual(['src/a.ts']);
  });
});

describe('owner labels', () => {
  it('names the foreign owner so a subdued hunk says WHOSE it is', async () => {
    const { model } = await reader();
    const layout = projectCheckpointPage({
      floor: FLOOR,
      checkpointKey: pageOf(model, 'chap_cp1').key,
    });
    const a = layout.files.find((f) => f.file === 'src/a.ts')!;

    // hunk_a2 belongs entirely to cp2 — every one of its units is foreign to cp1.
    expect(a.hunks[1]!.ownerLabels).toEqual(['cp2 · second']);
    expect(a.hunks[1]!.foreignOwnerLabels).toEqual(['cp2 · second']);

    // An unowned gap reads as a gap, not as somebody's checkpoint.
    expect(a.hunks[2]!.ownerLabels).toEqual(['unattributed']);
  });

  it('explains the OTHER owner of a hunk this page also owns', async () => {
    // The shared parent. Read from cp1, `ownerLabels` names both checkpoints — it
    // is who is in this hunk — while `foreignOwnerLabels` names only cp2, because
    // that is the row of explanation cp1 needs: "the rest of this hunk is cp2's".
    // Collapsing these two into one field is how a reviewer ends up being told
    // their own work is somebody else's.
    const { model } = await reader();
    const layout = projectCheckpointPage({
      floor: FLOOR,
      checkpointKey: pageOf(model, 'chap_cp1').key,
    });
    const shared = layout.files
      .find((f) => f.file === 'src/a.ts')!
      .hunks.find((h) => h.hunkKey === 'hunk_a1')!;

    expect(shared.ownerLabels).toEqual(['cp1 · first', 'cp2 · second']);
    expect(shared.foreignOwnerLabels).toEqual(['cp2 · second']);

    // ...and read from cp2, the foreign owner is cp1. Symmetric.
    const fromCp2 = projectCheckpointPage({
      floor: FLOOR,
      checkpointKey: pageOf(model, 'chap_cp2').key,
    })
      .files.find((f) => f.file === 'src/a.ts')!
      .hunks.find((h) => h.hunkKey === 'hunk_a1')!;
    expect(fromCp2.foreignOwnerLabels).toEqual(['cp1 · first']);
  });
});

describe('canonical reader projection', () => {
  it('keeps two slices in one parent hunk as two ordered navigation stops', () => {
    const shared = FLOOR.coverage.items.find((item) => item.hunkKey === 'hunk_a1')!;
    const samePageFloor = {
      ...FLOOR,
      outline: {
        ...FLOOR.outline,
        threads: FLOOR.outline.threads.map((thread) => ({
          ...thread,
          checkpoints: thread.checkpoints.map((checkpoint) =>
            checkpoint.checkpointKey === 'chap_cp1'
              ? {
                  ...checkpoint,
                  sliceRefs: [
                    { hunkKey: 'hunk_a1', slice: 0 },
                    { hunkKey: 'hunk_a1', slice: 1 },
                    { hunkKey: 'hunk_b1', slice: 0 },
                  ],
                }
              : checkpoint
          ),
        })),
      },
      coverage: {
        ...FLOOR.coverage,
        items: FLOOR.coverage.items.map((item) =>
          item.hunkKey === 'hunk_a1'
            ? {
                ...shared,
                units: shared.units.map((unit) =>
                  unit.kind === 'owned_slice'
                    ? { ...unit, owner: { kind: 'checkpoint' as const, artifact: ARTIFACT, cp: 1 } }
                    : unit
                ),
              }
            : item
        ),
      },
    } as unknown as Floor;

    const projection = projectCheckpointReaderPage({
      floor: samePageFloor,
      checkpointKey: 'chap_cp1',
    });

    expect(projection.sliceStops.slice(0, 2)).toEqual([
      { sliceKey: 'hunk_a1:s0', hunkKey: 'hunk_a1', file: 'src/a.ts' },
      { sliceKey: 'hunk_a1:s1', hunkKey: 'hunk_a1', file: 'src/a.ts' },
    ]);
    expect(new Set(projection.sliceStops.slice(0, 2).map((stop) => stop.hunkKey)).size).toBe(1);
  });

  it('projects Unassigned as slice stops in the canonical shell document', () => {
    const unassignedFloor = {
      ...FLOOR,
      outline: {
        ...FLOOR.outline,
        unassigned: {
          gap: { sliceRefs: [{ hunkKey: 'hunk_a3', slice: 0 }], files: ['src/a.ts'] },
          ambiguous: { hunkKeys: [], files: [] },
        },
      },
    } as unknown as Floor;

    const projection = projectUnassignedReaderPage({ floor: unassignedFloor });
    expect(projection.sliceStops).toEqual([
      { sliceKey: 'hunk_a3:s0', hunkKey: 'hunk_a3', file: 'src/a.ts' },
    ]);
    expect(projection.layout.files[0]!.hunks.map((hunk) => hunk.hunkKey)).toEqual([
      'hunk_a1',
      'hunk_a2',
      'hunk_a3',
    ]);
  });

  it('treats an ambiguous whole-hunk stop as row-navigable changed code', () => {
    const ambiguousFloor = {
      ...FLOOR,
      outline: {
        ...FLOOR.outline,
        unassigned: {
          gap: { sliceRefs: [], files: [] },
          ambiguous: { hunkKeys: ['hunk_ambiguous'], files: ['src/ambiguous.ts'] },
        },
      },
      coverage: {
        ...FLOOR.coverage,
        items: [
          ...FLOOR.coverage.items,
          item('hunk_ambiguous', 'src/ambiguous.ts', 7, 7, 1, 1, [
            {
              kind: 'ambiguous_hunk',
              lines: 2,
              candidates: [{ kind: 'checkpoint', artifact: ARTIFACT, cp: 1 }],
            },
          ]),
        ],
      },
    } as unknown as Floor;

    const projection = projectUnassignedReaderPage({ floor: ambiguousFloor });
    expect(rowsOfProjectedHunk(projection, 'hunk_ambiguous')).toEqual([
      { side: 'delete', line: 7 },
      { side: 'add', line: 7 },
    ]);
  });
});
