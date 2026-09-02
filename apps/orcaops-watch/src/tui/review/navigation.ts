// Pure navigation math for the review keymap: the collapse/expand keys (`z`/`Z`),
// page and half-page steps, the file and comment-pin cursor jumps, and the `/`
// file-card filter. All headless-testable; the key handlers in ReviewApp are thin
// calls into these.
//
// The cursor-jump and filter halves take the lens-neutral `LayoutPage` — so one
// navigation serves a Checkpoint page and a Part page alike, which is the whole
// point of the two-lens reader.

import { gapKey } from '@orcaops/diff-render';

import type { DisplayHunkStatus } from './checkpointLayout';
import { allGapKeys, type ExpandedGaps, type PatchGapHunk, setFileGaps } from './gapExpansion';

/**
 * FLOOR space: a floor coverage item as the reader displays it. `patchHunkIndex`
 * is the index it RESOLVED to in patch space — null when it resolved to none,
 * which is a loud `⊘ unavailable` row, never an expandable one.
 *
 * The `space` discriminant is what stops this from being handed to `allGapKeys`
 * (see `PatchGapHunk`): both shapes carry a `collapsedBefore`, so structurally
 * they are interchangeable, and swapping them mints gap keys against the wrong
 * index space — a key that matches no row, so `z` silently does nothing.
 */
export interface FloorDisplayHunk {
  readonly space: 'floor';
  readonly hunkKey: string;
  readonly status: DisplayHunkStatus;
  readonly patchHunkIndex: number | null;
  readonly collapsedBefore: number;
}

/** What the file currently has open — the two expansion stores, narrowed to one file. */
export interface FileExpansion {
  readonly gaps: ReadonlySet<string>;
  readonly foreignHunks: ReadonlySet<string>;
}

/** The file's trailing gap, in patch space: `pierre` stamps it on the LAST patch hunk. */
export interface TrailingGap {
  readonly key: string;
  readonly patchHunkIndex: number;
}

export type VisibleCollapseTarget =
  | { kind: 'gap'; key: string; hunkKey: string; position: 'before' | 'trailing' }
  | { kind: 'foreign-hunk'; hunkKey: string };

/** Does this hunk render its real body right now (so its inner gap rows exist)? */
function rendersBody(hunk: FloorDisplayHunk, expanded: FileExpansion): boolean {
  if (hunk.patchHunkIndex === null) return false;
  return hunk.status === 'matched' || expanded.foreignHunks.has(hunk.hunkKey);
}

/**
 * The next collapse block that is BOTH rendered and still closed, scanning
 * forward from the cursor's hunk and wrapping across the file at most once.
 * `z` is open-only, so being expansion-aware is what lets repeated presses
 * advance instead of flipping one block forever.
 *
 * Two orderings are load-bearing:
 * - A collapsed foreign parent wins before its own leading gap — that gap row
 *   does not exist until the parent's body is on screen. Once the parent opens,
 *   the gap it just revealed is the next target (do not skip past it).
 * - The file's trailing gap comes last, and only when the hunk hosting the final
 *   patch index is itself rendered.
 */
export function selectVisibleCollapseTarget(
  hunks: readonly FloorDisplayHunk[],
  currentHunkKey: string,
  expanded: FileExpansion,
  trailing: TrailingGap | null
): VisibleCollapseTarget | null {
  const current = hunks.findIndex((hunk) => hunk.hunkKey === currentHunkKey);
  if (current < 0) return null;

  const scan = (from: number, to: number): VisibleCollapseTarget | null => {
    for (let i = from; i < to; i += 1) {
      const hunk = hunks[i]!;
      if (hunk.patchHunkIndex === null) continue; // unavailable: loud, but not expandable
      if (!rendersBody(hunk, expanded)) return { kind: 'foreign-hunk', hunkKey: hunk.hunkKey };
      const key = gapKey('before', hunk.patchHunkIndex);
      if (hunk.collapsedBefore > 0 && !expanded.gaps.has(key)) {
        return { kind: 'gap', key, hunkKey: hunk.hunkKey, position: 'before' };
      }
    }
    return null;
  };

  const afterCursor = scan(current, hunks.length);
  if (afterCursor !== null) return afterCursor;

  if (trailing !== null && !expanded.gaps.has(trailing.key)) {
    const host = hunks.find((hunk) => hunk.patchHunkIndex === trailing.patchHunkIndex);
    if (host !== undefined && rendersBody(host, expanded)) {
      return { kind: 'gap', key: trailing.key, hunkKey: host.hunkKey, position: 'trailing' };
    }
  }

  return scan(0, current);
}

/** The measured rows of the target's owning hunk, as of the PRE-toggle layout. */
export interface AnchorUnit {
  readonly top: number;
  readonly sliceTop: number;
  readonly sliceHeight: number;
}

/**
 * The absolute row `z` should keep in view — measured BEFORE the toggle. Every
 * expansion splices its rows strictly below the row you toggled, so the target's
 * own top never moves and the pre-toggle measurement stays correct afterwards.
 */
export function collapseTargetAnchorRow(
  target: VisibleCollapseTarget,
  unit: AnchorUnit | undefined
): number | null {
  if (unit === undefined) return null;
  if (target.kind === 'foreign-hunk') return unit.top; // the one collapsed row itself
  const bodyTop = unit.top + unit.sliceTop;
  // A leading gap is the body's first row; the trailing gap is its last.
  return target.position === 'before' ? bodyTop : bodyTop + Math.max(0, unit.sliceHeight - 1);
}

/** The `Z` decision plus the two whole-store writes it implies. */
export interface FileCollapsePlan {
  readonly action: 'open' | 'close' | 'none';
  readonly expandedGaps: ExpandedGaps;
  readonly expandedForeignHunks: ReadonlySet<string>;
  /** The file has gaps but no pinned source — the caller owes an honest notice. */
  readonly gapsUnavailable: boolean;
}

/**
 * `Z` — open every expandable block in one file, or close them all if they are
 * already open. "Expandable" is only what a reviewer can actually reach: foreign
 * hunks that resolve to a patch hunk, plus (with a pinned source) the gaps those
 * hunks host. Unresolved floor items stay loud and never hold the file open, and
 * gaps are left out entirely without a source rather than parked in the store as
 * inert keys whose `sourceStatus` can never settle.
 */
export function planFileCollapseState(input: {
  file: string;
  hunks: readonly FloorDisplayHunk[];
  patchHunks: readonly PatchGapHunk[];
  hasTrailingGap: boolean;
  hasSource: boolean;
  expandedGaps: ExpandedGaps;
  expandedForeignHunks: ReadonlySet<string>;
}): FileCollapsePlan {
  const { file, hunks, patchHunks, hasTrailingGap, hasSource } = input;
  const unchanged: Omit<FileCollapsePlan, 'action' | 'gapsUnavailable'> = {
    expandedGaps: input.expandedGaps,
    expandedForeignHunks: input.expandedForeignHunks,
  };

  const resolvable = new Set(
    hunks.map((hunk) => hunk.patchHunkIndex).filter((idx): idx is number => idx !== null)
  );
  const foreignKeys = hunks
    .filter((hunk) => hunk.status !== 'matched' && hunk.patchHunkIndex !== null)
    .map((hunk) => hunk.hunkKey);
  const reachableGaps = allGapKeys(patchHunks, hasTrailingGap, resolvable);
  const desiredGaps: ReadonlySet<string> = hasSource ? reachableGaps : new Set();
  const gapsUnavailable = !hasSource && reachableGaps.size > 0;

  if (foreignKeys.length === 0 && desiredGaps.size === 0) {
    return { action: 'none', ...unchanged, gapsUnavailable };
  }

  const openGaps = input.expandedGaps.get(file) ?? new Set<string>();
  const allOpen =
    foreignKeys.every((key) => input.expandedForeignHunks.has(key)) &&
    [...desiredGaps].every((key) => openGaps.has(key));

  const nextForeign = new Set(input.expandedForeignHunks);
  for (const key of foreignKeys) {
    if (allOpen) nextForeign.delete(key);
    else nextForeign.add(key);
  }
  return {
    action: allOpen ? 'close' : 'open',
    expandedGaps: setFileGaps(input.expandedGaps, file, allOpen ? new Set() : desiredGaps),
    expandedForeignHunks: nextForeign,
    gapsUnavailable,
  };
}

/** Full-page scroll/selection step: one viewport minus a row of overlap. */
export function pageStep(viewportRows: number): number {
  return Math.max(1, viewportRows - 1);
}

/** Half-page step (`d`/`u`). */
export function halfPageStep(viewportRows: number): number {
  return Math.max(1, Math.floor(viewportRows / 2));
}

/** The `/` filter predicate: case-insensitive substring on path or rename source. */
export function fileMatchesFilter(file: string, prevName: string | null, query: string): boolean {
  const q = query.toLowerCase();
  if (q.length === 0) return true;
  return file.toLowerCase().includes(q) || (prevName ?? '').toLowerCase().includes(q);
}

/**
 * Filter only navigator destinations. The measured page and its owned-row
 * coverage remain untouched; selecting a match still jumps into the full diff.
 */
export function filterNavigatorFiles<T extends { readonly file: string }>(
  files: readonly T[],
  query: string | null,
  prevNameOf: (file: string) => string | null
): readonly T[] {
  if (query === null || query.length === 0) return files;
  return files.filter((file) => fileMatchesFilter(file.file, prevNameOf(file.file), query));
}
