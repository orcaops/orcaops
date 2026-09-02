// Mouse → row-cursor resolution for the Walk. OpenTUI delivers mouse
// events to the box under the cursor (verified against @opentui/core 0.1.89), so
// a click on a diff row fires that row's onMouseDown — no global y-offset math.
// These pure helpers turn a rendered DiffRow into the row-grain cursor's
// identity (the (side, line) the line cursor indexes) and normalize a
// drag's anchor/head into an inclusive span. Diff-render types only; headless
// testable like patchSplit.ts.

import type { DiffRow, DiffRowFocus } from '@orcaops/diff-render';

/** A changed line's grain identity — the same shape selectedRows carries. */
export interface RowLine {
  side: 'add' | 'delete';
  /** New-file line number for adds; old-file line number for deletes. */
  line: number;
}

export type SplitPane = 'left' | 'right';

/**
 * Resolve a slice-local terminal column to the split pane rendered there.
 *
 * This mirrors diff-render's split geometry: one rail column at the start and
 * one separator column at the start of the right pane, with the remaining
 * width divided between them. Keeping pointer hit testing on that same seam is
 * important for odd widths, where a simple `width / 2` comparison is off by a
 * cell.
 */
export function splitPaneAtColumn(width: number, column: number): SplitPane {
  const usableWidth = Math.max(0, width - 2);
  const leftWidth = Math.max(0, 1 + Math.floor(usableWidth / 2));
  return column < leftWidth ? 'left' : 'right';
}

/**
 * The changed (side, line) a rendered diff row resolves to, or null for rows
 * with no selectable changed line (context, hunk header, collapsed gap, or an
 * empty/subdued cell). With no pane supplied, additions win over deletions on
 * a modified split pair, mirroring pickHunkAnchorLine's adds-before-deletes
 * preference. Pointer callers supply the pane actually under the cursor so a
 * click can never fall through to the opposite split cell.
 */
export function changedLineOfRow(
  row: DiffRow,
  focus?: DiffRowFocus,
  splitPane?: SplitPane
): RowLine | null {
  if (row.type === 'split-line') {
    const leftPick =
      (focus?.kind !== 'split' || focus.left === 'primary') &&
      row.left.kind === 'deletion' &&
      typeof row.left.lineNumber === 'number'
        ? ({ side: 'delete', line: row.left.lineNumber } satisfies RowLine)
        : null;
    const rightPick =
      (focus?.kind !== 'split' || focus.right === 'primary') &&
      row.right.kind === 'addition' &&
      typeof row.right.lineNumber === 'number'
        ? ({ side: 'add', line: row.right.lineNumber } satisfies RowLine)
        : null;

    if (splitPane === 'left') return leftPick;
    if (splitPane === 'right') return rightPick;
    return rightPick ?? leftPick;
  }
  if (row.type === 'stack-line') {
    if (focus?.kind === 'stack' && focus.cell === 'subdued') return null;
    if (row.cell.kind === 'addition' && typeof row.cell.newLineNumber === 'number') {
      return { side: 'add', line: row.cell.newLineNumber };
    }
    if (row.cell.kind === 'deletion' && typeof row.cell.oldLineNumber === 'number') {
      return { side: 'delete', line: row.cell.oldLineNumber };
    }
    return null;
  }
  return null;
}

/** Resolve a pointer column without ever selecting the opposite split cell. */
export function changedLineAtColumn(
  row: DiffRow,
  focus: DiffRowFocus | undefined,
  width: number,
  column: number
): RowLine | null {
  return changedLineOfRow(
    row,
    focus,
    row.type === 'split-line' ? splitPaneAtColumn(width, column) : undefined
  );
}

/**
 * A drag's anchor + head row indices, normalized to an inclusive [lo, hi] span
 * over the changed-line list — the v-span a drag-select builds, order-free.
 */
export function normalizeSpan(anchor: number, head: number): { lo: number; hi: number } {
  return anchor <= head ? { lo: anchor, hi: head } : { lo: head, hi: anchor };
}
