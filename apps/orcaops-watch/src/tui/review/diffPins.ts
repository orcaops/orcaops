// Place the sidecar's comments onto a reader page.
//
// The engine's re-anchor ladder has already answered the hard question — "where
// does this comment live NOW, against the current patch" — and written its
// verdict into `EnrichedComment.position`, with `rung` recording how far it had
// to fall to get there. This module answers the one question left, which is
// purely about the page in front of the reader: which of ITS slices does that
// verdict land on.
//
// Nothing is ever dropped. A comment that resolves outside this page still pins —
// to its file card, or failing that to the header — because a reviewer who cannot
// see a comment concludes it was never filed, and the agent's reply then arrives
// about code nobody is looking at. That is the comment/revision loop failing
// silently, which is worse than failing loudly.

import type {
  CommentAuthor,
  CommentStatus,
  ReanchoredPosition,
  ReanchorRung,
} from '@orcaops/review-core';

import {
  DEFAULT_ANNOTATION_HEIGHT,
  type LayoutPage,
  type LayoutPinTarget,
  type LayoutSlice,
  unitLineRanges,
} from './checkpointLayout';
import type { ReaderRailItem, ReaderSemanticPlacement } from './readerModel';
import type { EnrichedComment } from '../../data/commentsSource';

/**
 * A comment, placed. `target` is structurally a `LayoutPin`, so the same value
 * feeds `buildCheckpointLayout` (which prices it) and the renderer (which draws
 * it) — one placement, measured and drawn from the same field. Pricing a pin the
 * renderer puts somewhere else is how the row-window spacers go short.
 */
export interface DiffPin {
  readonly kind: 'comment';
  readonly annotationId: string;
  readonly height: typeof DEFAULT_ANNOTATION_HEIGHT;
  readonly commentId: string;
  readonly author: CommentAuthor;
  readonly status: CommentStatus;
  readonly body: string;
  readonly replyCount: number;
  /** The ladder resolved BELOW the anchor's native grain: show it, never hide it. */
  readonly drifted: boolean;
  readonly rung: ReanchorRung;
  readonly side: 'add' | 'delete' | null;
  readonly line: number | null;
  readonly endLine: number | null;
  readonly target: LayoutPinTarget;
}

export interface SemanticDiffAnnotation {
  readonly kind: 'semantic';
  readonly annotationId: string;
  readonly height: typeof DEFAULT_ANNOTATION_HEIGHT;
  readonly itemId: string;
  readonly citationId: string;
  readonly shortText: string;
  readonly fullText: string;
  readonly source: string;
  readonly disposition: NonNullable<ReaderRailItem['disposition']>;
  readonly targetCount: number;
  readonly locationCount: number;
  readonly placement: ReaderSemanticPlacement;
  readonly target: LayoutPinTarget;
}

export type DiffAnnotation = DiffPin | SemanticDiffAnnotation;

/** Does this owned slice's own-side range contain the anchored line? */
function sliceContainsLine(slice: LayoutSlice, side: 'add' | 'delete', line: number): boolean {
  const ranges = unitLineRanges(slice.unit);
  // An ambiguous unit claims no own-side range — the whole hunk is the unit, so
  // it can hold a hunk pin but never a line pin.
  if (ranges === null) return false;
  const range = side === 'add' ? ranges.addRange : ranges.delRange;
  return range !== null && line >= range.start && line <= range.end;
}

/**
 * The placement ladder, mirroring the engine's own: line → hunk → file → header.
 * Each rung is where the comment renders when the one above it cannot be honoured
 * BY THIS PAGE — which is a different question from whether the engine could
 * re-anchor it, and the reason this cannot be read off `position.rung` alone.
 */
function placeOf(
  position: ReanchoredPosition | null,
  files: ReadonlySet<string>,
  slicesByHunk: ReadonlyMap<string, readonly LayoutSlice[]>
): LayoutPinTarget {
  if (position === null) return { kind: 'header' };

  // `owned` is empty for a hunk this page RENDERS but owns no slice in — a foreign
  // hunk, another checkpoint's work shown here as context. `first` is what makes
  // that total: there is no owned slice to hang a pin on, so the ladder falls
  // through to the file card. (A non-null assertion here instead would mint a pin
  // with an undefined sliceKey, which the layout would then decline to price and
  // the renderer would decline to draw — a comment that vanishes.)
  const owned = position.hunkKey === null ? [] : (slicesByHunk.get(position.hunkKey) ?? []);
  const first = owned[0];
  if (first !== undefined) {
    const { side, line } = position;
    if (side !== null && line !== null) {
      const hit = owned.find((slice) => sliceContainsLine(slice, side, line));
      // The row travels WITH the target: this is the only place that knows the pin
      // resolved to a real, owned, rendered row, and both the measurer and the
      // renderer downstream read it from here rather than re-deriving it.
      if (hit !== undefined) return { kind: 'line', sliceKey: hit.sliceKey, side, line };
    }
    // The hunk is ours but the row is not on a slice we own — pin the hunk rather
    // than a row this page never claimed.
    return { kind: 'slice', sliceKey: first.sliceKey };
  }

  if (position.file !== null && files.has(position.file)) {
    return { kind: 'file', file: position.file };
  }
  return { kind: 'header' };
}

/**
 * One comment, as a pin — the ONE translation from the sidecar's shape to the
 * renderer's. The target is supplied by the caller because only the caller knows
 * where it is drawing: the diff column resolves a slice, the Unassigned column
 * hangs it straight under a row. Everything else about a pin is the comment.
 */
export function commentAsPin(comment: EnrichedComment, target: LayoutPinTarget): DiffPin {
  return {
    kind: 'comment',
    annotationId: `comment:${comment.comment_id}`,
    height: DEFAULT_ANNOTATION_HEIGHT,
    commentId: comment.comment_id,
    author: comment.author,
    status: comment.status,
    body: comment.body,
    replyCount: comment.replies.length,
    drifted: comment.position?.drifted ?? false,
    rung: comment.position?.rung ?? 'unanchored',
    side: comment.position?.side ?? null,
    line: comment.position?.line ?? null,
    endLine: comment.position?.endLine ?? null,
    target,
  };
}

export function semanticPlacementAsAnnotation(
  item: ReaderRailItem,
  placement: ReaderSemanticPlacement
): SemanticDiffAnnotation {
  if (item.disposition === undefined) {
    throw new Error(`reader item ${item.id} has a placement without an anchor disposition`);
  }
  return {
    kind: 'semantic',
    annotationId: `semantic:${placement.id}`,
    height: DEFAULT_ANNOTATION_HEIGHT,
    itemId: item.id,
    citationId: placement.citationId,
    shortText: item.shortText,
    fullText: item.text,
    source: item.source,
    disposition: item.disposition,
    targetCount: item.targetCount ?? 0,
    locationCount: item.locationCount ?? 0,
    placement,
    target: placement.displayTarget,
  };
}

export function buildDiffPins(input: {
  page: LayoutPage;
  comments: readonly EnrichedComment[];
}): readonly DiffPin[] {
  const { page, comments } = input;

  const files = new Set(page.files.map((group) => group.file));
  const slicesByHunk = new Map<string, LayoutSlice[]>();
  for (const group of page.files) {
    for (const slice of group.slices) {
      const at = slicesByHunk.get(slice.hunkKey);
      if (at === undefined) slicesByHunk.set(slice.hunkKey, [slice]);
      else at.push(slice);
    }
  }

  return comments.map((comment) =>
    commentAsPin(comment, placeOf(comment.position, files, slicesByHunk))
  );
}

/** The pins this page cannot place in the diff body — rendered above it, never dropped. */
export function headerPins<T extends DiffAnnotation>(pins: readonly T[]): readonly T[] {
  return pins.filter((pin) => pin.target.kind === 'header');
}

/**
 * Which rows one hunk highlights as SELECTED.
 *
 * Precedence guarantees the live cursor stays visible: a semantic annotation that
 * replaced the selection unconditionally would let the reviewer's row-grain cursor
 * (and a `v` range) move invisibly after routing to an anchored item, with the
 * highlight glued to the placement rows. `reviewerRows` exists only in row grain,
 * so the annotation keeps its highlight on hunk-grain entry, and the live cursor
 * wins the moment the reviewer moves it. An annotation card and a visible cursor
 * are not mutually exclusive.
 */
export function selectedRowsForHunk(input: {
  cursorHunk: boolean;
  /** The reviewer's live row-grain selection; undefined outside row grain. */
  reviewerRows: readonly { side: 'add' | 'delete'; line: number }[] | undefined;
  annotation: SemanticDiffAnnotation | undefined;
  /** The cursor slice's changed rows — the hunk-grain fallback highlight. */
  activeSliceRows: readonly { side: 'add' | 'delete'; line: number }[] | undefined;
}): readonly { side: 'add' | 'delete'; line: number }[] | undefined {
  if (input.cursorHunk && input.reviewerRows !== undefined) return input.reviewerRows;
  if (input.annotation !== undefined) {
    return input.annotation.placement.highlightedRows.map((row) => ({
      side: row.side,
      line: row.line,
    }));
  }
  return input.cursorHunk ? input.activeSliceRows : undefined;
}
