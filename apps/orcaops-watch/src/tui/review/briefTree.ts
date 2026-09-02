// The Brief's right pane, as data.
//
// The Brief shows a two-level structure — Threads → Checkpoints under the
// deterministic lens, Acts → Parts under synthesis — but only the LEAVES are
// navigable. Parents are grouping headings: not cursor stops, not clickable.
//
// That distinction is the whole reason this module exists. A row list that
// mixed headings and leaves would force every consumer — rendering, cursor
// clamping, keyboard activation, pointer activation, route restoration — to
// re-derive which rows are selectable, and clamping against the full row count
// could park the cursor on a heading. Instead `destinations` is THE selectable
// array: its index IS the cursor, and headings never appear in it. `groups`
// carries only what a heading needs to render, plus the destination indices it
// spans so the renderer can interleave the two without a second traversal.
//
// `ReaderModel.pages` is already built parent-major and in order under both
// lenses — deterministic iterates threads by order then checkpoints by order
// (`readerModel.ts`), synthesized is `acts.flatMap(act => act.parts)` — so leaf
// runs are contiguous per parent. Grouping needs no re-sort, and destination
// index maps 1:1 to page index.

import type { ReviewLifecycleLedger } from '@orcaops/review-core';

import type { ReaderLens, ReaderModel, ReaderPage } from './readerModel';

/**
 * A place the Brief cursor can land.
 *
 * Keys are NAMESPACED, never a raw `page.key`. The floor and narrative schemas
 * guarantee only `nonEmptyString` for checkpoint and part keys, so the two
 * namespaces can collide; and a route snapshot survives a lens switch, so a
 * deterministic snapshot's key can be resolved against a synthesized tree. The
 * literal keys `unassigned` and `finish` are reachable page keys under those
 * same schemas, which is the other half of the same hazard.
 */
export type BriefDestination =
  | {
      kind: 'page';
      pageIndex: number;
      key: `checkpoint:${string}` | `part:${string}`;
      /**
       * Churn, computed ONCE per reader rather than per render.
       *
       * A leaf's metrics are a fold over every row the page owns, and a page can
       * own tens of thousands. Deriving them in the renderer made the Brief's
       * cost scale with the branch's size on every keystroke.
       */
      metrics: BriefLeafMetrics;
    }
  | { kind: 'unassigned'; key: 'unassigned' }
  | { kind: 'finish'; key: 'finish' };

/** A non-interactive heading: a Thread under the floor lens, an Act under the Story. */
export interface BriefTreeGroup {
  /** The durable parent identity, namespaced — `thread:…` or `act:…`. Never a destination key. */
  key: string;
  title: string;
  /** Zero-based position among `groups`. Renderers display `order + 1`. */
  order: number;
  /**
   * What the heading IS. A Story tree can mix real Acts with captured-code
   * threads (degraded attribution) and loose Parts that belong to no Act, and
   * only the real Acts may carry the `ACT n` prefix.
   */
  variant: 'act' | 'thread' | 'loose';
  /** One-based position among the `act` groups alone, or null off the Act spine. */
  actOrdinal: number | null;
  /** Indices into `BriefTree.destinations`. Always contiguous and ascending. */
  leafDestinationIndices: readonly number[];
  /** Leaves whose page reads complete. */
  complete: number;
  total: number;
}

export interface BriefTree {
  lens: ReaderLens;
  groups: readonly BriefTreeGroup[];
  /** THE selectable array. Index === cursor. Headings never appear in it. */
  destinations: readonly BriefDestination[];
}

export interface BriefFinishRow {
  glyph: string;
  label: string;
  detail: string | null;
  /** True while the review is open and the canonical gate still refuses. */
  blocked: boolean;
}

/**
 * The Finish row, identically on both lenses.
 *
 * Reads ONLY `reader.finish` — the canonical gate. `buildStoryReader` takes the
 * canonical `finishGate(floor, ledger, …)` and additionally pushes a
 * `story_items` blocker when required Story items remain open, so a complete
 * Story with one open floor uncertainty legitimately stays blocked. Rendering
 * any softer verdict here would offer a Finish the transport is going to
 * reject.
 */
export function briefFinishRow(
  lifecycle: ReviewLifecycleLedger | undefined,
  finish: ReaderModel['finish']
): BriefFinishRow {
  const state = lifecycle?.state;
  if (state !== undefined && state !== 'OPEN') {
    return lifecycle?.stale === true
      ? {
          glyph: '◐',
          label: `${state.toLowerCase()} record is stale · reopen to reconcile`,
          detail: null,
          blocked: false,
        }
      : {
          glyph: '✓',
          label: `Review finished ${state.toLowerCase()}`,
          detail: null,
          blocked: false,
        };
  }
  return finish.allowed
    ? { glyph: '✓', label: 'Ready to finish complete', detail: null, blocked: false }
    : {
        glyph: '◐',
        label: 'Finish partial or continue review',
        detail: `${finish.blockers.length} obligation(s) remain`,
        blocked: true,
      };
}

/** The state mark a leaf carries: done, opened but blocked, or untouched. */
export function briefLeafGlyph(page: ReaderPage): string {
  if (page.complete) return '✓';
  return page.visited ? '◐' : '○';
}

/**
 * Compact marks for the blockers a reviewer can act on.
 *
 * `rows` and `items` are deliberately absent. The leaf's own `✓`/`◐`/`○` glyph
 * already says whether it is complete, and on a fresh review EVERY checkpoint
 * carries `rows` — so badging it would paint a literal `rows…` on every single
 * line of the tree, telling the reviewer nothing.
 */
const LEAF_BADGE_GLYPH: Readonly<Record<string, string>> = {
  uncertainties: '⚑',
  comments: '✎',
  disclosures: '!',
};

/** Why a leaf still wants attention, as marks rather than prose. */
export function briefLeafBadges(page: ReaderPage): string | null {
  const marks = page.blockers
    .map((blocker) => LEAF_BADGE_GLYPH[blocker])
    .filter((glyph): glyph is string => glyph !== undefined);
  return marks.length === 0 ? null : marks.join('');
}

/** Churn a leaf owns, for the trailing `+X −Y · Nf` metadata. */
export interface BriefLeafMetrics {
  added: number;
  removed: number;
  files: number;
}

function destinationKeyForPage(page: ReaderPage): `checkpoint:${string}` | `part:${string}` {
  return page.kind === 'checkpoint' ? `checkpoint:${page.key}` : `part:${page.key}`;
}

function groupForPage(
  page: ReaderPage,
  lens: ReaderLens
): { key: string; title: string; variant: BriefTreeGroup['variant'] } {
  if (page.kind === 'checkpoint') {
    // On the Story lens these are the retained deterministic checkpoints of a
    // degraded-attribution review; naming them keeps the two spines distinct.
    return {
      key: `thread:${page.threadKey}`,
      title: lens === 'story' ? `Captured code · ${page.threadTitle}` : page.threadTitle,
      variant: 'thread',
    };
  }
  return page.actKey === null
    ? { key: 'act:__none__', title: 'Ungrouped parts', variant: 'loose' }
    : { key: `act:${page.actKey}`, title: page.actTitle ?? page.actKey, variant: 'act' };
}

/**
 * Group the reader's pages under their parents and flatten every navigable
 * destination into one array.
 *
 * A sole Part is present here even though `PartPage.part.visible` is false: the
 * page exists in `reader.pages` either way, and the Brief deliberately shows
 * every structural leaf beneath its Act. The sole-Part collapse remains a Walk
 * presentation concern.
 */
export function buildBriefTree(reader: ReaderModel): BriefTree {
  const groups: BriefTreeGroup[] = [];
  const destinations: BriefDestination[] = [];

  reader.pages.forEach((page, pageIndex) => {
    const { key, title, variant } = groupForPage(page, reader.lens);
    const destinationIndex = destinations.length;
    destinations.push({
      kind: 'page',
      pageIndex,
      key: destinationKeyForPage(page),
      metrics: briefLeafMetrics(page),
    });

    // Pages are parent-major, so the run for a parent is always the tail group.
    // Matching on the tail rather than searching all groups is what makes
    // `leafDestinationIndices` contiguous by construction: a parent that
    // somehow reappeared later would open a second group rather than punch a
    // hole in the first one's range.
    const open = groups[groups.length - 1];
    if (open !== undefined && open.key === key) {
      (open.leafDestinationIndices as number[]).push(destinationIndex);
      open.total += 1;
      if (page.complete) open.complete += 1;
      return;
    }
    groups.push({
      key,
      title,
      order: groups.length,
      variant,
      actOrdinal:
        variant === 'act' ? groups.filter((group) => group.variant === 'act').length + 1 : null,
      leafDestinationIndices: [destinationIndex],
      complete: page.complete ? 1 : 0,
      total: 1,
    });
  });

  // Unassigned/Residue and Finish are peer trailing destinations, not members
  // of any group; the row appears only when there is work to route to. The
  // Story's residue counts through its own auxiliary page — its explained
  // cross-Part evidence must not be relabelled as deterministic Unassigned.
  const hasAuxiliary =
    reader.auxiliaryPage.kind === 'story-residue'
      ? reader.auxiliaryPage.sliceStops.length > 0 || reader.auxiliaryPage.railItems.length > 0
      : reader.unassigned.total > 0;
  if (hasAuxiliary) destinations.push({ kind: 'unassigned', key: 'unassigned' });
  destinations.push({ kind: 'finish', key: 'finish' });

  return { lens: reader.lens, groups, destinations };
}

/** Where a durable destination key sits now, or null if it is gone. */
export function briefDestinationIndexForKey(tree: BriefTree, key: string | null): number | null {
  if (key === null) return null;
  const index = tree.destinations.findIndex((destination) => destination.key === key);
  return index < 0 ? null : index;
}

/**
 * Churn for one leaf, from the rows the page owns.
 *
 * Read off `ownedRows` rather than the page's projection: `ownedRows` is the
 * row set the coverage ledger actually attributes to this page, so the Brief's
 * per-leaf totals cannot disagree with what marking the page reviewed records.
 * Rows are deduplicated by content identity because a hunk owned by two
 * checkpoints yields the same row through both.
 */
export function briefLeafMetrics(page: ReaderPage): BriefLeafMetrics {
  const seen = new Set<string>();
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const rows of page.ownedRows.values()) {
    for (const row of rows) {
      const identity = `${row.file}\0${row.side}\0${row.lineHash}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      files.add(row.file);
      if (row.side === 'add') added += 1;
      else removed += 1;
    }
  }
  return { added, removed, files: files.size };
}
