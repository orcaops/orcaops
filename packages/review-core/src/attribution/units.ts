// The slice partition: group one hunk's changed rows into ReviewUnits.
//
// A logical slice is a maximal run of CONSECUTIVE changed patchRows sharing
// one owner identity. ANY intervening row breaks the run — a context row
// breaks it (context is display-only padding, never slice identity, so
// distant edits can never collapse into one slice), and a changed row of a
// different owner (or of no owner) breaks it. A slice therefore carries at
// most one delete range and one add range, and a plain `-old/+new` modify
// block by one checkpoint is ONE slice.
//
// Owner identities: a checkpoint, a specific gap segment, or `unowned`
// (blame resolved nothing for the row). Different gap segments and unowned
// rows never merge into one slice.
//
// Files in a concurrent-overlap window are NEVER owner-sliced: their per-line
// owners are exactly the data OVERLAP_DOWNGRADE declared untrustworthy, so
// the whole hunk becomes ONE `ambiguous_hunk` unit whose candidates are
// evidence, not asserted ownership.

import type { DiffSide } from '../enums.js';
import type { OwnerRef, ReviewUnit, SliceRange } from '../schema.js';
import { type Chain, segmentOwner, type SegmentOwner } from './chain.js';
import type { ChangedRow } from './changedRows.js';

/** A line owner entry resolved by the sidecar's blame (see `LineOwner`). */
export interface IndexedLine {
  segment: number;
  lineHash?: string;
}

/** Per-file, per-side line-number → owner maps — the blame substrate. */
export interface FileLineIndex {
  add: Map<number, IndexedLine>;
  del: Map<number, IndexedLine>;
}

function rowOwner(
  chain: Chain,
  index: FileLineIndex | undefined,
  row: ChangedRow
): SegmentOwner | null {
  if (!index) return null;
  const entry = (row.side === 'add' ? index.add : index.del).get(row.line);
  if (entry === undefined) return null;
  return segmentOwner(chain, entry.segment);
}

function runOwnerId(owner: SegmentOwner | null): string {
  if (owner === null) return 'unowned';
  return owner.kind === 'checkpoint' ? `cp:${owner.artifact}:${owner.cp}` : `gap:${owner.segment}`;
}

function sideRange(rows: readonly ChangedRow[], side: DiffSide): SliceRange | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const row of rows) {
    if (row.side !== side) continue;
    if (start === null || row.line < start) start = row.line;
    if (end === null || row.line > end) end = row.line;
  }
  return start === null || end === null ? null : { start, end };
}

function finishRun(
  ordinal: number,
  owner: SegmentOwner | null,
  rows: readonly ChangedRow[]
): ReviewUnit {
  const coords = {
    slice: ordinal,
    patch_row_start: rows[0].patchRow,
    patch_row_end: rows[rows.length - 1].patchRow,
    del_range: sideRange(rows, 'delete'),
    add_range: sideRange(rows, 'add'),
    lines: rows.length,
  };
  if (owner !== null && owner.kind === 'checkpoint') {
    return {
      kind: 'owned_slice',
      ...coords,
      owner: { kind: 'checkpoint', artifact: owner.artifact, cp: owner.cp },
    };
  }
  return {
    kind: 'gap_slice',
    ...coords,
    owner: owner === null ? null : { kind: 'gap', segment: owner.segment },
  };
}

/**
 * Partition one reviewable hunk's changed rows into units. `rows` must be the
 * hunk's parsed changed rows in patchRow order (never inferred from header
 * ranges — those include context). Every changed row lands in exactly one
 * unit.
 */
export function collectHunkUnits(
  chain: Chain,
  rows: readonly ChangedRow[],
  index: FileLineIndex | undefined,
  ambiguous: boolean
): ReviewUnit[] {
  if (rows.length === 0) return [];

  if (ambiguous) {
    const candidates = new Map<string, OwnerRef>();
    for (const row of rows) {
      const owner = rowOwner(chain, index, row);
      if (owner === null) continue;
      candidates.set(runOwnerId(owner), owner);
    }
    return [
      {
        kind: 'ambiguous_hunk',
        lines: rows.length,
        candidates: [...candidates.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, owner]) => owner),
      },
    ];
  }

  const units: ReviewUnit[] = [];
  let runOwner: SegmentOwner | null = null;
  let runId = '';
  let runRows: ChangedRow[] = [];
  let prevPatchRow = Number.NaN;

  for (const row of rows) {
    const owner = rowOwner(chain, index, row);
    const id = runOwnerId(owner);
    const consecutive = row.patchRow === prevPatchRow + 1;
    if (runRows.length > 0 && consecutive && id === runId) {
      runRows.push(row);
    } else {
      if (runRows.length > 0) units.push(finishRun(units.length, runOwner, runRows));
      runOwner = owner;
      runId = id;
      runRows = [row];
    }
    prevPatchRow = row.patchRow;
  }
  if (runRows.length > 0) units.push(finishRun(units.length, runOwner, runRows));

  return units;
}
