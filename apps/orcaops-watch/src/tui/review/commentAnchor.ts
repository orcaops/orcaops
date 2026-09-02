// Authoring-side anchors, built from the ROW CURSOR.
//
// `listHunkChangedLines` walks a file's raw patch to one hunk and lists its changed
// lines in patch order; `listSliceChangedLines` narrows that to a slice's own-side
// ranges. Both are pure and diff-render-free, like `patchSplit.ts`.
//
// Coarse-grain `c` keeps a deterministic auto-pick, but over
// the ACTIVE SLICE rather than its whole parent hunk. That distinction is what makes
// the convenience honest: the slice cursor has already bounded the reviewer's intent;
// row grain remains the exact-line path and `v` remains the explicit range path.

import {
  type CommentAnchor,
  isTrivialAnchorBody,
  lineHash,
  type ReviewUnit,
} from '@orcaops/review-core';

export interface AnchorPick {
  side: 'add' | 'delete';
  /** New-file line number for adds; old-file line number for deletes. */
  line: number;
  /** The line body without the diff sign — what the content hash covers. */
  body: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Walk `filePatch` to the hunk whose header matches `hunk`'s start positions and list
 * its changed lines in PATCH ORDER (deletes and adds interleaved as the diff prints
 * them). Empty when the hunk cannot be found or has no changed lines (rename-only /
 * binary).
 */
export function listHunkChangedLines(
  filePatch: string,
  hunk: { newStart: number | null; oldStart: number | null }
): AnchorPick[] {
  let inTarget = false;
  let oldLine = 0;
  let newLine = 0;
  const changed: AnchorPick[] = [];

  for (const raw of filePatch.split('\n')) {
    const header = HUNK_RE.exec(raw);
    if (header) {
      if (inTarget) break; // ran past the target hunk
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inTarget =
        (hunk.newStart !== null && newLine === hunk.newStart) ||
        (hunk.newStart === null && hunk.oldStart !== null && oldLine === hunk.oldStart);
      continue;
    }
    if (!inTarget) continue;
    const kind = raw[0];
    if (kind === '+') {
      changed.push({ side: 'add', line: newLine, body: raw.slice(1) });
      newLine += 1;
    } else if (kind === '-') {
      changed.push({ side: 'delete', line: oldLine, body: raw.slice(1) });
      oldLine += 1;
    } else if (kind === ' ') {
      oldLine += 1;
      newLine += 1;
    } else if (kind !== '\\') {
      break; // header/trailer ends the hunk body
    }
  }
  return changed;
}

/**
 * Narrow a parent hunk's changed lines to ONE slice: adds inside the unit's
 * `add_range`, deletes inside its `del_range`, patch order preserved. A whole
 * ambiguous hunk keeps every changed line (it renders unsliced).
 */
export function listSliceChangedLines(
  filePatch: string,
  hunk: { newStart: number | null; oldStart: number | null },
  unit: ReviewUnit
): AnchorPick[] {
  const lines = listHunkChangedLines(filePatch, hunk);
  if (unit.kind === 'ambiguous_hunk') return lines;
  return lines.filter((pick) => {
    const range =
      pick.side === 'add' ? unit.add_range : pick.side === 'delete' ? unit.del_range : null;
    return range !== null && pick.line >= range.start && pick.line <= range.end;
  });
}

/**
 * Coarse-grain comment anchor inside the ACTIVE slice: prefer meaningful new code,
 * then meaningful removed code, and fall back to the first representable row.
 */
export function pickAnchorFromLines(lines: readonly AnchorPick[]): AnchorPick | null {
  if (lines.length === 0) return null;
  const preferred = [
    ...lines.filter((line) => line.side === 'add'),
    ...lines.filter((line) => line.side === 'delete'),
  ];
  return preferred.find((line) => !isTrivialAnchorBody(line.body)) ?? preferred[0]!;
}

export interface RowAnchorInput {
  readonly file: string;
  readonly hunkKey: string;
  /** Durable review ownership, so open reviewer comments gate the page they came from. */
  readonly threadKey?: string;
  /** The hunk's changed lines, in the SAME order the row cursor indexes. */
  readonly lines: readonly AnchorPick[];
  /** `diffRowCursor`. */
  readonly cursor: number;
  /** `diffSelectionAnchor` — the other end of a `v` span, or null. */
  readonly selectionAnchor: number | null;
}

export interface RowAnchorResult {
  readonly anchor: CommentAnchor;
  /**
   * Set when the authored anchor is NARROWER than what the reviewer selected — a
   * `v` span that crossed from deletes into adds. `DIFF_RANGE` carries ONE side by
   * schema, so the anchor takes the cursor's, and this says how many rows that left
   * out. Silently narrowing a selection is how a reviewer ends up believing they
   * commented on code they did not.
   */
  readonly droppedRows: number;
}

/**
 * The anchor for the row the reviewer is actually looking at.
 *
 * A bare cursor authors `DIFF_LINE`. A `v` span authors `DIFF_RANGE`.
 */
export async function buildRowCommentAnchor(
  input: RowAnchorInput
): Promise<RowAnchorResult | null> {
  const { file, hunkKey, threadKey, lines, cursor, selectionAnchor } = input;
  const at = lines[cursor];
  if (at === undefined) return null;

  const encoder = new TextEncoder();
  const hashOf = (pick: AnchorPick): Promise<string> =>
    lineHash(pick.side, encoder.encode(pick.body));

  if (selectionAnchor === null || selectionAnchor === cursor) {
    return {
      anchor: {
        kind: 'DIFF_LINE',
        file,
        side: at.side,
        line: at.line,
        lineHash: await hashOf(at),
        hunkKey,
        ...(threadKey !== undefined ? { threadKey } : {}),
      },
      droppedRows: 0,
    };
  }

  const from = Math.min(selectionAnchor, cursor);
  const to = Math.max(selectionAnchor, cursor);
  const span = lines.slice(from, to + 1);
  // One side, by schema. The cursor's side is the reviewer's most recent intent.
  const sameSide = span.filter((pick) => pick.side === at.side);
  if (sameSide.length === 0) return null;

  const numbers = sameSide.map((pick) => pick.line);
  return {
    anchor: {
      kind: 'DIFF_RANGE',
      file,
      side: at.side,
      line: Math.min(...numbers),
      endLine: Math.max(...numbers),
      lineHash: await hashOf(at),
      lineHashes: await Promise.all(sameSide.map(hashOf)),
      hunkKey,
      ...(threadKey !== undefined ? { threadKey } : {}),
    },
    droppedRows: span.length - sameSide.length,
  };
}
