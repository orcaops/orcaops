// The projector: a ReaderPage + the deterministic floor -> the LayoutPage that
// geometry measures and the diff column renders.
//
// This is the piece that makes the CHECKPOINT the unit of review. Today the diff
// column resolves ONE hunkKey against a flat list of 213 hunks and renders it
// alone, so `j`/`k` walks straight across checkpoint and file boundaries with
// nothing to mark the crossing. A page projects to the FILES its checkpoint
// touched, each carrying ALL of its parent hunks — the ones this checkpoint owns
// lit, the rest present but subdued, so the reviewer can see what else lives in
// the code they are reading.
//
// THE INVARIANT (pageProjection.test.ts): the rows this projection LIGHTS are
// exactly the rows the page's coverage event COVERS. Display and coverage are
// two readings of one floor — a checkpoint's `sliceRefs` — and if they ever
// disagree, a reviewer marks a checkpoint reviewed having been shown different
// code than the ledger recorded. That is not a rendering bug, it is a false
// record of what was reviewed.

import {
  COVERAGE_VERDICT,
  type CoverageItem,
  type Floor,
  type OwnerRef,
  type ReviewUnit,
  sliceKey,
} from '@orcaops/review-core';
import type { ChangedRowSegment, ContestedEntry, UnattributedEntry } from '@orcaops/review-engine';

import {
  type DisplayHunkStatus,
  type LayoutFile,
  type LayoutHunk,
  type LayoutPage,
  type LayoutSlice,
  unitLineRanges,
} from './checkpointLayout';

/**
 * The only diff-shaped value a reader lens hands to the canonical shell.
 *
 * `layout` is the full file-card document. `sliceStops` is deliberately
 * separate: rows answer what is covered or inspected, while stops answer where
 * the cursor can land. Collapsing either one into hunk keys loses information.
 */
export interface ReaderSliceStop {
  sliceKey: string;
  hunkKey: string;
  file: string;
}

export interface ReaderDiffProjection {
  layout: LayoutPage;
  sliceStops: readonly ReaderSliceStop[];
}

export function readerDiffProjection(layout: LayoutPage): ReaderDiffProjection {
  return {
    layout,
    sliceStops: layout.files.flatMap((file) =>
      file.slices.map((slice) => ({
        sliceKey: slice.sliceKey,
        hunkKey: slice.hunkKey,
        file: slice.file,
      }))
    ),
  };
}

function memberSlug(artifact: string, cp: number): string {
  return `${artifact}:cp${cp}`;
}

/**
 * The checkpoint page a hunk cursor is "on" — the first checkpoint (in floor
 * order) owning a slice of that hunk.
 *
 * A parent hunk can be shared, so this can be ambiguous, and FIRST is the honest
 * resolution: it puts the reviewer on the earliest checkpoint that touched the
 * code, and the page shows the whole file anyway, so the rest of the hunk is
 * still on screen — subdued, and labelled with whose it is.
 */
export function checkpointKeyForHunk(floor: Floor, hunkKey: string): string | null {
  for (const thread of [...floor.outline.threads].sort((a, b) => a.order - b.order)) {
    for (const checkpoint of [...thread.checkpoints].sort((a, b) => a.order - b.order)) {
      if (checkpoint.sliceRefs.some((ref) => ref.hunkKey === hunkKey)) {
        return checkpoint.checkpointKey;
      }
    }
  }
  return null;
}

/** Every checkpoint on the branch mapped to its human label, for the owner chips. */
export function labelByCheckpoint(floor: Floor): Map<string, string> {
  const labels = new Map<string, string>();
  for (const thread of floor.outline.threads) {
    for (const checkpoint of thread.checkpoints) {
      const cp = checkpoint.checkpoint;
      if (cp.label) labels.set(memberSlug(cp.artifact, cp.cp), cp.label);
    }
  }
  return labels;
}

/** Attribution chip for any owner: `cp<n> · <label>`, a gap segment, or unattributed. */
function ownerRefLabel(owner: OwnerRef | null | undefined, labels: Map<string, string>): string {
  if (owner === null || owner === undefined) return 'unattributed';
  if (owner.kind === 'gap') return `gap ${owner.segment}`;
  const label = labels.get(memberSlug(owner.artifact, owner.cp));
  return label !== undefined ? `cp${owner.cp} · ${label}` : `cp${owner.cp}`;
}

/** The owners of a set of units, deduped, in first-seen order. */
function ownerLabelsForUnits(
  units: readonly ReviewUnit[],
  labels: Map<string, string>
): readonly string[] {
  const result: string[] = [];
  for (const unit of units) {
    const owners =
      unit.kind === 'ambiguous_hunk'
        ? unit.candidates.map((candidate) => ownerRefLabel(candidate, labels))
        : [ownerRefLabel(unit.owner, labels)];
    for (const label of owners) if (!result.includes(label)) result.push(label);
  }
  return result;
}

/**
 * Matched means THIS page owns at least one unit of the hunk. A hunk with no
 * owned unit is still projected — it is what the reviewer sees collapsed beside
 * their own work — but the verdict comes first, because an excluded or
 * unreviewable hunk is not "someone else's code", it is code nobody can review.
 */
function displayStatus(item: CoverageItem, ownedUnits: readonly ReviewUnit[]): DisplayHunkStatus {
  if (ownedUnits.length > 0) return 'matched';
  if (item.verdict === COVERAGE_VERDICT.EXCLUDED) return 'excluded';
  if (item.verdict === COVERAGE_VERDICT.UNREVIEWABLE) return 'unreviewable';
  return 'foreign';
}

/** Floor reading order within a file: by position, then by key for stability. */
function byPosition(a: CoverageItem, b: CoverageItem): number {
  const pos = (a.new_start ?? a.old_start ?? 0) - (b.new_start ?? b.old_start ?? 0);
  return pos !== 0 ? pos : a.hunkKey.localeCompare(b.hunkKey);
}

function hunkOf(
  item: CoverageItem,
  ownedUnits: readonly ReviewUnit[],
  labels: Map<string, string>
): LayoutHunk {
  const owned = new Set(ownedUnits);
  return {
    hunkKey: item.hunkKey,
    file: item.file,
    newStart: item.new_start ?? null,
    oldStart: item.old_start ?? null,
    added: item.added_lines,
    removed: item.removed_lines,
    status: displayStatus(item, ownedUnits),
    ownerLabels: ownerLabelsForUnits(item.units, labels),
    foreignOwnerLabels: ownerLabelsForUnits(
      item.units.filter((unit) => !owned.has(unit)),
      labels
    ),
  };
}

function sliceOf(item: CoverageItem, unit: ReviewUnit): LayoutSlice {
  return {
    // Non-durable by contract (keys.ts) — a cursor id, never persisted.
    sliceKey: unit.kind === 'ambiguous_hunk' ? item.hunkKey : sliceKey(item.hunkKey, unit.slice),
    hunkKey: item.hunkKey,
    file: item.file,
    unit,
  };
}

/**
 * Project the deterministic page for one CHECKPOINT.
 *
 * The ownership join — `checkpoint.sliceRefs` -> `(hunkKey, unit.slice)` — is the
 * SAME join `buildEligibleNarrativeTargets` performs to mint the targets that
 * `ReaderPage.ownedRows` is built from. Both read one floor, so they cannot
 * disagree about what this checkpoint owns; the test pins that.
 *
 * The floor's own `sliceRefs` are used rather than the eligible targets because
 * targets carry ONLY `owned_slice` units. The reviewer must also see the gap and
 * ambiguous hunks sitting in the same files — collapsed, but present.
 */
export function projectCheckpointPage(input: { floor: Floor; checkpointKey: string }): LayoutPage {
  const { floor, checkpointKey } = input;
  const labels = labelByCheckpoint(floor);

  const checkpoint = floor.outline.threads
    .flatMap((thread) => thread.checkpoints)
    .find((candidate) => candidate.checkpointKey === checkpointKey);
  const ownedRefs = new Set(
    (checkpoint?.sliceRefs ?? []).map((ref) => `${ref.hunkKey}\u0000${ref.slice}`)
  );

  const itemByHunk = new Map(floor.coverage.items.map((item) => [item.hunkKey, item]));

  /** The units of `item` that THIS checkpoint owns, in the floor's unit order. */
  const ownedUnitsOf = (item: CoverageItem): ReviewUnit[] =>
    item.units.filter(
      (unit) =>
        unit.kind !== 'ambiguous_hunk' && ownedRefs.has(`${item.hunkKey}\u0000${unit.slice}`)
    );

  // The files this checkpoint touched — from the hunks it owns a slice in.
  const files: string[] = [];
  for (const ref of checkpoint?.sliceRefs ?? []) {
    const item = itemByHunk.get(ref.hunkKey);
    if (item !== undefined && !files.includes(item.file)) files.push(item.file);
  }

  const cards: LayoutFile[] = files.map((file) => {
    const items = floor.coverage.items.filter((item) => item.file === file).sort(byPosition);
    const slices: LayoutSlice[] = [];
    const hunks: LayoutHunk[] = [];
    for (const item of items) {
      const owned = ownedUnitsOf(item);
      hunks.push(hunkOf(item, owned, labels));
      for (const unit of owned) slices.push(sliceOf(item, unit));
    }
    return { file, slices, hunks };
  });

  // Findings are a narrative concept; a checkpoint page has none of its own.
  return { files: cards, findings: [] };
}

/** The normalized shell input for one deterministic Checkpoint page. */
export function projectCheckpointReaderPage(input: {
  floor: Floor;
  checkpointKey: string;
}): ReaderDiffProjection {
  return readerDiffProjection(projectCheckpointPage(input));
}

/**
 * Project one routine-Story Part, including both its owned slices and the
 * same-Part ambiguous hunks the ownership pass deliberately keeps with it.
 *
 * Ambiguous hunks are display/inspection units, never coverage ownership. They
 * therefore contribute a whole-hunk cursor stop but no ReviewedRows; the reader
 * records them through the existing AMBIGUOUS_HUNK inspection event.
 */
export function projectStoryPartReaderPage(input: {
  floor: Floor;
  segments: readonly ChangedRowSegment[];
  ambiguous: readonly { hunkKey: string }[];
}): ReaderDiffProjection {
  const { floor, segments } = input;
  const labels = labelByCheckpoint(floor);
  const ownedRefs = new Set(segments.map((seg) => `${seg.hunkKey}\0${seg.slice}`));
  const ambiguousHunks = new Set(input.ambiguous.map((entry) => entry.hunkKey));
  const itemByHunk = new Map(floor.coverage.items.map((item) => [item.hunkKey, item]));

  const ownedUnitsOf = (item: CoverageItem): ReviewUnit[] =>
    item.units.filter((unit) =>
      unit.kind === 'ambiguous_hunk'
        ? ambiguousHunks.has(item.hunkKey)
        : ownedRefs.has(`${item.hunkKey}\0${unit.slice}`)
    );

  const files: string[] = [];
  for (const seg of segments) {
    const item = itemByHunk.get(seg.hunkKey);
    if (item !== undefined && !files.includes(item.file)) files.push(item.file);
  }
  for (const ambiguous of input.ambiguous) {
    const item = itemByHunk.get(ambiguous.hunkKey);
    if (item !== undefined && !files.includes(item.file)) files.push(item.file);
  }

  const cards: LayoutFile[] = files.map((file) => {
    const items = floor.coverage.items.filter((item) => item.file === file).sort(byPosition);
    const slices: LayoutSlice[] = [];
    const hunks: LayoutHunk[] = [];
    for (const item of items) {
      const owned = ownedUnitsOf(item);
      hunks.push(hunkOf(item, owned, labels));
      for (const unit of owned) slices.push(sliceOf(item, unit));
    }
    return { file, slices, hunks };
  });

  return readerDiffProjection({ files: cards, findings: [] });
}

/**
 * Project the explicit residue — cross-Part contested + genuinely unattributed
 * code — into the same file cards. Contested and `ambiguous_no_part` units are
 * whole-hunk (no slice range); gap/unowned units are slice-grained.
 */
export function projectResidueReaderPage(input: {
  floor: Floor;
  contested: readonly ContestedEntry[];
  unattributed: readonly UnattributedEntry[];
}): ReaderDiffProjection {
  const { floor, contested, unattributed } = input;
  const labels = labelByCheckpoint(floor);
  const wholeHunk = new Set<string>([
    ...contested.map((c) => c.hunkKey),
    ...unattributed.filter((u) => u.kind === 'ambiguous_no_part').map((u) => u.hunkKey),
  ]);
  const sliceRefs = new Set(
    unattributed.filter((u) => u.slice !== undefined).map((u) => `${u.hunkKey}\0${u.slice}`)
  );
  const itemByHunk = new Map(floor.coverage.items.map((item) => [item.hunkKey, item]));

  const files: string[] = [];
  for (const key of [...wholeHunk, ...sliceRefs].map((k) => k.split('\0')[0]!)) {
    const file = itemByHunk.get(key)?.file;
    if (file !== undefined && !files.includes(file)) files.push(file);
  }

  const cards: LayoutFile[] = files.map((file) => {
    const items = floor.coverage.items.filter((item) => item.file === file).sort(byPosition);
    const slices: LayoutSlice[] = [];
    const hunks: LayoutHunk[] = [];
    for (const item of items) {
      const owned = item.units.filter((unit) =>
        unit.kind === 'ambiguous_hunk'
          ? wholeHunk.has(item.hunkKey)
          : sliceRefs.has(`${item.hunkKey}\0${unit.slice}`)
      );
      hunks.push(hunkOf(item, owned, labels));
      for (const unit of owned) slices.push(sliceOf(item, unit));
    }
    return { file, slices, hunks };
  });

  return readerDiffProjection({ files: cards, findings: [] });
}

/**
 * Project genuinely unexplained work without assigning it to checkpoint zero.
 * Gap slices remain slice-grained; an ambiguous unit is one whole-hunk stop.
 */
export function projectUnassignedReaderPage(input: { floor: Floor }): ReaderDiffProjection {
  const { floor } = input;
  const labels = labelByCheckpoint(floor);
  const gapRefs = new Set(
    floor.outline.unassigned.gap.sliceRefs.map((ref) => `${ref.hunkKey}\u0000${ref.slice}`)
  );
  const ambiguous = new Set(floor.outline.unassigned.ambiguous.hunkKeys);
  const files: string[] = [];
  for (const ref of floor.outline.unassigned.gap.sliceRefs) {
    const file = floor.coverage.items.find((item) => item.hunkKey === ref.hunkKey)?.file;
    if (file !== undefined && !files.includes(file)) files.push(file);
  }
  for (const hunkKey of floor.outline.unassigned.ambiguous.hunkKeys) {
    const file = floor.coverage.items.find((item) => item.hunkKey === hunkKey)?.file;
    if (file !== undefined && !files.includes(file)) files.push(file);
  }

  const cards: LayoutFile[] = files.map((file) => {
    const items = floor.coverage.items.filter((item) => item.file === file).sort(byPosition);
    const slices: LayoutSlice[] = [];
    const hunks: LayoutHunk[] = [];
    for (const item of items) {
      const owned = item.units.filter((unit) =>
        unit.kind === 'ambiguous_hunk'
          ? ambiguous.has(item.hunkKey)
          : unit.kind === 'gap_slice' && gapRefs.has(`${item.hunkKey}\u0000${unit.slice}`)
      );
      hunks.push(hunkOf(item, owned, labels));
      for (const unit of owned) slices.push(sliceOf(item, unit));
    }
    return { file, slices, hunks };
  });

  return readerDiffProjection({ files: cards, findings: [] });
}

/** Changed rows lit by any normalized reader projection for one parent hunk. */
export function rowsOfProjectedHunk(
  projection: ReaderDiffProjection,
  hunkKey: string
): { side: 'add' | 'delete'; line: number }[] {
  const rows: { side: 'add' | 'delete'; line: number }[] = [];
  for (const group of projection.layout.files) {
    for (const slice of group.slices) {
      if (slice.hunkKey !== hunkKey) continue;
      const ranges = unitLineRanges(slice.unit);
      if (ranges === null) {
        // An ambiguous unit deliberately has no slice range: the whole parent
        // hunk is the review unit. It still needs row-grain navigation, copy,
        // comments, and $EDITOR anchors on the Unassigned page.
        if (slice.unit.kind !== 'ambiguous_hunk') continue;
        const hunk = group.hunks.find((candidate) => candidate.hunkKey === hunkKey);
        if (hunk === undefined) continue;
        if (hunk.oldStart !== null) {
          for (let offset = 0; offset < hunk.removed; offset += 1) {
            rows.push({ side: 'delete', line: hunk.oldStart + offset });
          }
        }
        if (hunk.newStart !== null) {
          for (let offset = 0; offset < hunk.added; offset += 1) {
            rows.push({ side: 'add', line: hunk.newStart + offset });
          }
        }
        continue;
      }
      if (ranges.delRange !== null) {
        for (let line = ranges.delRange.start; line <= ranges.delRange.end; line += 1) {
          rows.push({ side: 'delete', line });
        }
      }
      if (ranges.addRange !== null) {
        for (let line = ranges.addRange.start; line <= ranges.addRange.end; line += 1) {
          rows.push({ side: 'add', line });
        }
      }
    }
  }
  return rows;
}
