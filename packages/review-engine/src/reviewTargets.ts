import {
  changedRangeTargetKey,
  type CurrentThreadManifest,
  type EligibleNarrativeTarget,
  type Floor,
  lineHash,
  type MemberRef,
  type ReviewedRow,
  reviewedRowsDigest,
} from '@orcaops/review-core';

import { parsePatchHunks, type PatchHunk, type PatchHunkLine, positionKey } from './comments.js';

export interface EligibleTargetWithCode extends EligibleNarrativeTarget {
  body: string[];
  /** Chronology is provenance and a deterministic tie-breaker only. */
  chronology: number;
  files: string[];
}

/**
 * The content-addressed rows one eligible target owns.
 *
 * Exported because it must stay the ONLY definition. This one is paired with a
 * manifest builder that throws on an unknown section; a second copy kept for
 * tests and fixtures could silently invent one, so tests would validate a
 * builder production never runs. Coverage is keyed off these rows, so a
 * divergence here is a divergence in what "reviewed" means.
 */
export function rowsForEligibleTarget(target: EligibleNarrativeTarget): ReviewedRow[] {
  return target.anchor.ranges.flatMap((range) =>
    range.lineHashes.map((lineHashValue, offset) => ({
      file: target.anchor.file,
      side: range.side,
      line: range.startLine + offset,
      lineHash: lineHashValue,
      hunkKey: target.anchor.hunkKey,
    }))
  );
}

/**
 * Current section manifests derived from the same engine-minted eligible target
 * packet used by review validation. Watch and journal replay consume this
 * projection instead of independently interpreting transient floor slices.
 */
export async function buildCurrentThreadManifests(
  floor: Floor,
  eligibleTargets: readonly EligibleNarrativeTarget[]
): Promise<CurrentThreadManifest[]> {
  const rowsByThread = new Map(
    floor.outline.threads.map((section) => [section.threadKey, [] as ReviewedRow[]])
  );
  for (const target of eligibleTargets) {
    const rows = rowsByThread.get(target.threadKey);
    if (rows === undefined) {
      throw new Error(`eligible target ${target.targetKey} references unknown ${target.threadKey}`);
    }
    rows.push(...rowsForEligibleTarget(target));
  }
  return Promise.all(
    [...rowsByThread].map(async ([threadKey, rows]) => ({
      threadKey,
      rows,
      digest: await reviewedRowsDigest(rows),
    }))
  );
}

/**
 * Durable gap inspection identities from retained patch bodies. Slice ordinals
 * are used only to find the physical range and are never returned or persisted.
 * Missing retained rows fail closed so Unassigned cannot become falsely done.
 */
export async function buildCurrentGapRows(floor: Floor, diffText: string): Promise<ReviewedRow[]> {
  const files = new Set(floor.coverage.items.map((item) => item.file));
  const hunks = parsePatchHunks(diffText, files);
  const encoder = new TextEncoder();
  const rows: ReviewedRow[] = [];
  for (const item of floor.coverage.items) {
    const hunk = hunks.find(
      (candidate) =>
        candidate.file === item.file &&
        candidate.oldStart === item.old_start &&
        candidate.newStart === item.new_start
    );
    for (const unit of item.units) {
      if (unit.kind !== 'gap_slice') continue;
      if (hunk === undefined) {
        throw new Error(`retained patch is missing gap hunk ${item.hunkKey}`);
      }
      for (const [side, range] of [
        ['delete', unit.del_range],
        ['add', unit.add_range],
      ] as const) {
        if (range === null) continue;
        for (let line = range.start; line <= range.end; line += 1) {
          const patchLine = hunk.lines.find(
            (candidate) =>
              candidate.side === side && (side === 'add' ? candidate.new : candidate.old) === line
          );
          if (patchLine === undefined) {
            throw new Error(`retained patch is missing ${side} row ${item.file}:${line}`);
          }
          rows.push({
            file: item.file,
            side,
            line,
            lineHash: await lineHash(side, encoder.encode(patchLine.body)),
            hunkKey: item.hunkKey,
          });
        }
      }
    }
  }
  return rows;
}

function patchHunkByFloorPosition(floor: Floor, diffText: string): Map<string, PatchHunk> {
  const files = new Set(floor.coverage.items.map((item) => item.file));
  const parsed = parsePatchHunks(diffText, files);
  return new Map(
    parsed.map((hunk) => [positionKey(hunk.file, hunk.newStart, hunk.oldStart), hunk])
  );
}

function findPatchHunk(
  map: ReadonlyMap<string, PatchHunk>,
  item: Floor['coverage']['items'][number]
): PatchHunk | undefined {
  return (
    map.get(positionKey(item.file, item.new_start ?? null, item.old_start ?? null)) ??
    map.get(positionKey(item.file, item.new_start ?? null, null))
  );
}

function rangeLines(
  hunk: PatchHunk,
  side: 'add' | 'delete',
  start: number,
  end: number
): PatchHunkLine[] {
  return hunk.lines.filter((line) => {
    if (line.side !== side) return false;
    const number = side === 'add' ? line.new : line.old;
    return number !== null && number >= start && number <= end;
  });
}

/** Mint the complete owned-row target partition directly from floor slices. */
export async function buildEligibleNarrativeTargets(
  floor: Floor,
  diffText: string
): Promise<EligibleTargetWithCode[]> {
  const hunkMap = patchHunkByFloorPosition(floor, diffText);
  const ownerBySlice = new Map<
    string,
    { threadKey: string; checkpointRefs: MemberRef[]; chronology: number }
  >();
  let chronology = 0;
  for (const section of [...floor.outline.threads].sort((a, b) => a.order - b.order)) {
    for (const checkpoint of [...section.checkpoints].sort((a, b) => a.order - b.order)) {
      chronology += 1;
      for (const ref of checkpoint.sliceRefs) {
        ownerBySlice.set(`${ref.hunkKey}\u0000${ref.slice}`, {
          threadKey: section.threadKey,
          checkpointRefs: checkpoint.members,
          chronology,
        });
      }
    }
  }

  const targets: EligibleTargetWithCode[] = [];
  for (const item of floor.coverage.items) {
    const hunk = findPatchHunk(hunkMap, item);
    for (const unit of item.units) {
      if (unit.kind !== 'owned_slice') continue;
      if (hunk === undefined) {
        throw new Error(`owned slice ${item.hunkKey} has no retained parent hunk in diff.patch`);
      }
      const owner = ownerBySlice.get(`${item.hunkKey}\u0000${unit.slice}`);
      if (owner === undefined) {
        throw new Error(`owned slice ${item.hunkKey} has no deterministic floor section`);
      }
      const ranges: EligibleNarrativeTarget['anchor']['ranges'] = [];
      const body: string[] = [];
      for (const [side, range] of [
        ['delete', unit.del_range],
        ['add', unit.add_range],
      ] as const) {
        if (range === null) continue;
        const lines = rangeLines(hunk, side, range.start, range.end);
        if (lines.length !== range.end - range.start + 1) {
          throw new Error(
            `owned ${side} range ${item.file}:${range.start}-${range.end} is incomplete`
          );
        }
        const lineHashes: string[] = [];
        for (const line of lines) {
          lineHashes.push(await lineHash(side, new TextEncoder().encode(line.body)));
          body.push(line.raw);
        }
        ranges.push({ side, startLine: range.start, endLine: range.end, lineHashes });
      }
      const anchor: EligibleNarrativeTarget['anchor'] = {
        file: item.file,
        hunkKey: item.hunkKey,
        ranges,
      };
      targets.push({
        targetKey: await changedRangeTargetKey(anchor),
        threadKey: owner.threadKey,
        anchor,
        checkpointRefs: owner.checkpointRefs,
        body,
        chronology: owner.chronology,
        files: [item.file],
      });
    }
  }
  return targets.sort(
    (a, b) =>
      a.chronology - b.chronology ||
      a.anchor.file.localeCompare(b.anchor.file) ||
      a.targetKey.localeCompare(b.targetKey)
  );
}
