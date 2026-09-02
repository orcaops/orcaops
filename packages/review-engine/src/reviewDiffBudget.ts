import { diffSnapshotStats, diffSnapshotTrees, Repo } from '@orcaops/core';

import { normalizeTruncatedReviewDiff } from './truncate.js';

export interface ReviewDiffBudgetResult {
  ok: boolean;
  diff: Uint8Array;
  truncated: boolean;
  detail: string | null;
  omittedBytes: number;
  statsFailed: boolean;
}

interface PatchUnit {
  path: string;
  sectionKey: string;
  header: Uint8Array;
  body: Uint8Array;
  ordinal: number;
  tracked: boolean;
}

interface PathCollection {
  path: string;
  tracked: boolean;
  units: PatchUnit[];
  sourceBytes: number;
  sourceTruncated: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function lineOffsets(text: string, pattern: RegExp): number[] {
  const offsets: number[] = [];
  for (const match of text.matchAll(pattern)) offsets.push(match.index ?? 0);
  return offsets;
}

/** Split one path-scoped patch into independently retainable complete hunks. */
function splitPatch(
  path: string,
  bytes: Uint8Array,
  tracked: boolean,
  sourceTruncated: boolean
): PatchUnit[] {
  const text = decoder.decode(bytes);
  const sectionOffsets = lineOffsets(text, /^diff --git /gm);
  if (sectionOffsets.length === 0) return [];
  sectionOffsets.push(text.length);
  const units: PatchUnit[] = [];
  for (let section = 0; section < sectionOffsets.length - 1; section += 1) {
    const sectionText = text.slice(sectionOffsets[section], sectionOffsets[section + 1]);
    const hunkOffsets = lineOffsets(sectionText, /^@@ /gm);
    if (hunkOffsets.length === 0) {
      // A capped text diff may normalize back to a header with no complete hunk.
      // Emitting that header would look like evidence while carrying zero rows.
      if (sourceTruncated) continue;
      units.push({
        path,
        sectionKey: `${path}\0${section}`,
        header: new Uint8Array(),
        body: encoder.encode(sectionText),
        ordinal: units.length,
        tracked,
      });
      continue;
    }
    hunkOffsets.push(sectionText.length);
    const header = encoder.encode(sectionText.slice(0, hunkOffsets[0]));
    for (let hunk = 0; hunk < hunkOffsets.length - 1; hunk += 1) {
      units.push({
        path,
        sectionKey: `${path}\0${section}`,
        header,
        body: encoder.encode(sectionText.slice(hunkOffsets[hunk], hunkOffsets[hunk + 1])),
        ordinal: units.length,
        tracked,
      });
    }
  }
  return units;
}

function changedRows(bytes: Uint8Array): number {
  let count = 0;
  for (const line of decoder.decode(bytes).split('\n')) {
    if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    )
      count += 1;
  }
  return count;
}

function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function unitCost(unit: PatchUnit, selectedSections: ReadonlySet<string>): number {
  return unit.body.length + (selectedSections.has(unit.sectionKey) ? 0 : unit.header.length);
}

/**
 * Collect the review diff under a global cap without letting git's path order
 * silently decide coverage. The normal-size fast path stays byte-identical. On
 * overflow, complete path-scoped hunks are selected in fair rounds: tracked
 * paths first, smallest representative first, then explicit untracked evidence.
 */
export async function collectReviewDiffBudget(opts: {
  repo: Repo;
  openTreeSha: string;
  closeTreeSha: string;
  maxDiffBytes: number;
  includedUntracked: readonly string[];
}): Promise<ReviewDiffBudgetResult> {
  const fast = await diffSnapshotTrees({
    repo: opts.repo,
    openTreeSha: opts.openTreeSha,
    closeTreeSha: opts.closeTreeSha,
    maxDiffBytes: opts.maxDiffBytes,
  });
  if (!fast.ok) {
    return {
      ok: false,
      diff: new Uint8Array(),
      truncated: false,
      detail: null,
      omittedBytes: 0,
      statsFailed: false,
    };
  }
  if (!fast.truncated) {
    return {
      ok: true,
      diff: fast.diff,
      truncated: false,
      detail: null,
      omittedBytes: 0,
      statsFailed: false,
    };
  }

  const stats = await diffSnapshotStats({
    repo: opts.repo,
    openTreeSha: opts.openTreeSha,
    closeTreeSha: opts.closeTreeSha,
  });
  if (!stats.ok) {
    const normalized = normalizeTruncatedReviewDiff(fast.diff);
    return {
      ok: true,
      diff: normalized.bytes,
      truncated: true,
      detail: null,
      omittedBytes: normalized.discardedBytes,
      statsFailed: true,
    };
  }

  const includedUntracked = new Set(opts.includedUntracked);
  const paths = [...new Set(stats.entries.map((entry) => entry.path))].sort();
  const collections: PathCollection[] = [];
  for (const filePath of paths) {
    const scoped = await diffSnapshotTrees({
      repo: opts.repo,
      openTreeSha: opts.openTreeSha,
      closeTreeSha: opts.closeTreeSha,
      maxDiffBytes: opts.maxDiffBytes,
      pathspecs: [filePath],
    });
    if (!scoped.ok) {
      return {
        ok: false,
        diff: new Uint8Array(),
        truncated: true,
        detail: `failed to collect path-scoped review evidence for ${filePath}`,
        omittedBytes: 0,
        statsFailed: false,
      };
    }
    const normalized = scoped.truncated ? normalizeTruncatedReviewDiff(scoped.diff) : null;
    const bytes = normalized?.bytes ?? scoped.diff;
    const tracked = !includedUntracked.has(filePath);
    collections.push({
      path: filePath,
      tracked,
      units: splitPatch(filePath, bytes, tracked, scoped.truncated),
      sourceBytes: scoped.byte_count,
      sourceTruncated: scoped.truncated,
    });
  }

  const selectedSections = new Set<string>();
  const selected: PatchUnit[] = [];
  let used = 0;
  const select = (unit: PatchUnit): void => {
    const cost = unitCost(unit, selectedSections);
    if (used + cost > opts.maxDiffBytes) return;
    selected.push(unit);
    used += cost;
    selectedSections.add(unit.sectionKey);
  };

  // Representative round. Small product hunks land before giant archive hunks;
  // explicit untracked evidence has a separate, lower-priority lane.
  for (const tracked of [true, false]) {
    const first = collections
      .filter((collection) => collection.tracked === tracked && collection.units.length > 0)
      .map((collection) => collection.units[0])
      .sort((left, right) => {
        const cost = unitCost(left, selectedSections) - unitCost(right, selectedSections);
        return cost !== 0 ? cost : left.path.localeCompare(right.path);
      });
    for (const unit of first) select(unit);
  }

  // Remaining complete hunks are selected round-robin by ordinal, preserving
  // source order inside each path while preventing any one path from monopolizing.
  const maxUnits = Math.max(0, ...collections.map((collection) => collection.units.length));
  for (let ordinal = 1; ordinal < maxUnits; ordinal += 1) {
    for (const tracked of [true, false]) {
      for (const collection of collections.filter((entry) => entry.tracked === tracked)) {
        const unit = collection.units[ordinal];
        if (unit !== undefined) select(unit);
      }
    }
  }

  selected.sort((left, right) => {
    const pathOrder = paths.indexOf(left.path) - paths.indexOf(right.path);
    return pathOrder !== 0 ? pathOrder : left.ordinal - right.ordinal;
  });
  const emittedHeaders = new Set<string>();
  const chunks: Uint8Array[] = [];
  for (const unit of selected) {
    if (!emittedHeaders.has(unit.sectionKey) && unit.header.length > 0) chunks.push(unit.header);
    chunks.push(unit.body);
    emittedHeaders.add(unit.sectionKey);
  }
  const diff = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

  const selectedByPath = new Map<string, PatchUnit[]>();
  for (const unit of selected) {
    const entries = selectedByPath.get(unit.path) ?? [];
    entries.push(unit);
    selectedByPath.set(unit.path, entries);
  }
  const omissions: string[] = [];
  let omittedBytes = 0;
  for (const collection of collections) {
    const retained = selectedByPath.get(collection.path) ?? [];
    const countedSections = new Set<string>();
    const retainedBytes = retained.reduce((sum, unit) => {
      const headerBytes = countedSections.has(unit.sectionKey) ? 0 : unit.header.length;
      countedSections.add(unit.sectionKey);
      return sum + unit.body.length + headerBytes;
    }, 0);
    const retainedRows = retained.reduce((sum, unit) => sum + changedRows(unit.body), 0);
    const stat = stats.entries.find((entry) => entry.path === collection.path);
    const totalRows = (stat?.added ?? 0) + (stat?.deleted ?? 0);
    const incomplete =
      collection.sourceTruncated ||
      retained.length < collection.units.length ||
      retainedRows < totalRows;
    if (!incomplete) continue;
    const omittedForPath = Math.max(0, collection.sourceBytes - retainedBytes);
    omittedBytes += omittedForPath;
    omissions.push(
      `${collection.path} (retained ${groupDigits(retainedRows)}/${groupDigits(totalRows)} rows; ` +
        `omitted ≥${groupDigits(omittedForPath)} bytes${collection.sourceTruncated ? ', path itself exceeded cap' : ''})`
    );
  }

  return {
    ok: true,
    diff,
    truncated: omissions.length > 0,
    detail: omissions.length > 0 ? `incomplete paths: ${omissions.join(', ')}` : null,
    omittedBytes,
    statsFailed: false,
  };
}
