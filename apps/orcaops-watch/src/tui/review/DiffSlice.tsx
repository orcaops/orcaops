import type { BoxRenderable, MouseEvent } from '@opentui/core';
import type { ReactNode } from 'react';
import { useMemo, useRef } from 'react';

import {
  type AppTheme,
  buildPlannedSliceRows,
  buildRowFocusMap,
  type DiffFile,
  type DiffRow,
  type DiffRowFocus,
  DiffRowView,
  expansionSide,
  type FileSourceStatus,
  measureSliceRowBounds,
  type RenderSpan,
  resolveVisiblePlannedRowWindow,
  sliceLineNumberDigits,
  type SliceLineRanges,
  spansForHighlightedSourceLine,
  useHighlightedDiff,
  useHighlightedSource,
} from '@orcaops/diff-render';

import { useHitCoordinator } from '../kit';
import { changedLineAtColumn, changedLineOfRow, type RowLine } from './mouseSelect';

const EMPTY_ROW_FOCUS: ReadonlyMap<string, DiffRowFocus> = new Map();

/**
 * Does a rendered diff row carry the anchored (side, line)? Line pins and the
 * row-grain cursor/v-span highlight both hang off this.
 */
export function rowMatchesLine(
  row: DiffRow,
  side: 'add' | 'delete',
  line: number,
  focus?: DiffRowFocus
): boolean {
  if (row.type === 'split-line') {
    if (focus?.kind === 'split' && (side === 'add' ? focus.right : focus.left) === 'subdued') {
      return false;
    }
    return side === 'add'
      ? row.right.kind === 'addition' && row.right.lineNumber === line
      : row.left.kind === 'deletion' && row.left.lineNumber === line;
  }
  if (row.type === 'stack-line') {
    if (focus?.kind === 'stack' && focus.cell === 'subdued') return false;
    return side === 'add'
      ? row.cell.kind === 'addition' && row.cell.newLineNumber === line
      : row.cell.kind === 'deletion' && row.cell.oldLineNumber === line;
  }
  return false;
}

/** Slot renderers woven into a rendered slice — the seam callers fill. */
export interface DiffSliceSlots {
  /** Rendered once, above the hunk's rows. */
  beforeHunk?: ReactNode;
  /** Rendered once, below the hunk's rows. */
  afterHunk?: ReactNode;
  /** Rendered after each row — e.g. a finding/comment pin anchored to that line. */
  afterLine?: (row: DiffRow) => ReactNode;
}

export interface DiffSliceProps {
  file: DiffFile;
  /** 0-based index of the hunk to render. Its leading collapsed gap rides along. */
  hunkIndex: number;
  width: number;
  theme: AppTheme;
  layout?: 'split' | 'stack';
  slots?: DiffSliceSlots;
  focused?: boolean;
  /** View toggles (l/w/M) + Shift-←/→ pan. Defaults show line numbers and hunk headers, unwrapped. */
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  codeHorizontalOffset?: number;
  /**
   * Gap expansion (`z` / click): this FILE's expanded gap keys plus the load
   * status of its expansion-side source. Expanded collapsed rows become a
   * status row + synthesized context rows; the same inputs must reach the
   * measured geometry or spacer math drifts.
   */
  expandedGapKeys?: ReadonlySet<string>;
  sourceStatus?: FileSourceStatus;
  /** Collapsed-row toggle, passed through to DiffRowView (click affordance). */
  onToggleGap?: (gapKey: string) => void;
  /** Union of primary ranges when one canonical parent hunk renders once. */
  maskOutsideRanges?: readonly SliceLineRanges[];
  /**
   * Slice-local visible range in visual-row space. When set, rows outside it
   * collapse into exact-height spacers — including measured `afterLine` pins.
   */
  rowWindow?: { top: number; height: number };
  /** Exact measured height rendered after each stable row key. */
  rowExtraHeightsByKey?: ReadonlyMap<string, number>;
  /**
   * Row-grain selection (the walk's ↵ cursor / v-span): when set, only rows
   * matching one of these (side, line) pairs render selected and the
   * hunk-level `focused` glow is suppressed — the row highlight IS the cursor.
   */
  selectedRows?: readonly { side: 'add' | 'delete'; line: number }[];
  /**
   * Mouse click on a row: fires with the row's changed (side, line), or
   * null for a non-changed row (context/header/collapsed). Wired to the wrapper
   * box, not DiffRowView, so the memoized row body's props never change.
   */
  onRowMouseDown?: (pick: RowLine | null) => void;
  /** Mouse drag entering a row — drag-select extends the v-span to it. */
  onRowMouseDrag?: (pick: RowLine | null) => void;
  /** Pointer y while a real row-owned drag is active; null ends edge coordination. */
  onRowMouseDragEdge?: (pointerY: number | null) => void;
}

/**
 * Render exactly one hunk of a DiffFile over @orcaops/diff-render's row model.
 *
 * Highlighting resolves asynchronously: `useHighlightedDiff` returns null first
 * (plain text) and the highlighted spans once Shiki settles, at which point the
 * rows rebuild. Rows for other hunks are filtered out; a leading collapsed gap
 * carries the *following* hunk's index, so it rides along with its hunk — which
 * is what a slice wants. Row props are identity-stable so `DiffRowView`'s memo
 * holds across re-renders that don't change the row.
 *
 * Expanded gaps follow the same two-phase pattern: synthesized context rows
 * render plain immediately, and `useHighlightedSource` swaps in Shiki spans
 * for the loaded side once it settles.
 */
export function DiffSlice({
  file,
  hunkIndex,
  width,
  theme,
  layout = 'split',
  slots,
  focused,
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  codeHorizontalOffset = 0,
  expandedGapKeys,
  sourceStatus,
  onToggleGap,
  maskOutsideRanges,
  rowWindow,
  rowExtraHeightsByKey,
  selectedRows,
  onRowMouseDown,
  onRowMouseDrag,
  onRowMouseDragEdge,
}: DiffSliceProps) {
  const hitCoordinator = useHitCoordinator();
  const dragAnchorRef = useRef<{ readonly hitId: string; readonly pick: RowLine } | null>(null);
  const draggingRef = useRef(false);
  const sliceRef = useRef<BoxRenderable | null>(null);
  const highlighted = useHighlightedDiff({
    file,
    hunkIndex,
    theme,
    shouldLoadHighlight: true,
  });

  // Highlight-on-expand: only a loaded source has text to highlight; until
  // Shiki settles the synthesized rows carry plain spans.
  const side = expansionSide(file);
  const sourceText = sourceStatus?.kind === 'loaded' ? sourceStatus.text : undefined;
  const highlightedSource = useHighlightedSource({
    file,
    text: sourceText,
    theme,
    shouldLoadHighlight: sourceText !== undefined,
  });
  const sourceLineSpans = useMemo(
    () =>
      highlightedSource !== null
        ? (line: string | undefined, sourceLineNumber: number): RenderSpan[] =>
            spansForHighlightedSourceLine(line, highlightedSource.lines[sourceLineNumber], theme)
        : undefined,
    [highlightedSource, theme]
  );

  const expansionActive = expandedGapKeys !== undefined && expandedGapKeys.size > 0;
  const rows = useMemo(() => {
    return buildPlannedSliceRows({
      file,
      hunkIndex,
      layout,
      theme,
      highlighted,
      ...(expansionActive && expandedGapKeys !== undefined
        ? {
            expansion: {
              expandedKeys: expandedGapKeys,
              sourceStatus,
              side,
            },
            sourceLineSpans,
          }
        : {}),
    });
  }, [
    file,
    highlighted,
    theme,
    layout,
    hunkIndex,
    expansionActive,
    expandedGapKeys,
    sourceStatus,
    sourceLineSpans,
    side,
  ]);

  // Focus is orthogonal presentation metadata. Keeping it out of the row
  // builder preserves canonical diff kinds, move metadata, syntax spans, and
  // row identity for rendering, geometry, and memoization.
  const focusByRowKey = useMemo(
    () =>
      maskOutsideRanges === undefined ? EMPTY_ROW_FOCUS : buildRowFocusMap(rows, maskOutsideRanges),
    [rows, maskOutsideRanges]
  );

  const digits = useMemo(() => sliceLineNumberDigits(file), [file]);

  // The window over `rows`: measured bounds are built from the same builders
  // with the same inputs (expansion included), so they align by index (and the
  // vendored resolver degrades to the full row set if they ever disagree in
  // length).
  const windowTop = rowWindow?.top;
  const windowHeight = rowWindow?.height;
  const windowingEnabled = windowTop !== undefined && windowHeight !== undefined;
  const windowGeometry = useMemo(() => {
    if (!windowingEnabled) return null;
    const geometry = measureSliceRowBounds({
      file,
      hunkIndex,
      layout,
      width,
      lineNumberDigits: digits,
      theme,
      highlighted,
      showLineNumbers,
      showHunkHeaders,
      wrapLines,
      ...(expansionActive && expandedGapKeys !== undefined
        ? { expansion: { expandedKeys: expandedGapKeys, sourceStatus, side } }
        : {}),
    });
    if (rowExtraHeightsByKey === undefined || rowExtraHeightsByKey.size === 0) {
      return { bodyHeight: geometry.totalHeight, rowBounds: geometry.bounds };
    }
    // Fold inline pins into their owning row's measured unit. The row key is
    // highlight-invariant, so the plain layout snapshot and highlighted render
    // resolve the same extras without forcing the complete hunk to mount.
    let accumulatedExtraHeight = 0;
    const visualBounds = geometry.bounds.map((bound, index) => {
      const row = rows[index];
      const extraHeight = row === undefined ? 0 : (rowExtraHeightsByKey?.get(row.key) ?? 0);
      const visualBound = {
        top: bound.top + accumulatedExtraHeight,
        height: bound.height + extraHeight,
      };
      accumulatedExtraHeight += extraHeight;
      return visualBound;
    });
    return {
      bodyHeight: geometry.totalHeight + accumulatedExtraHeight,
      rowBounds: visualBounds,
    };
  }, [
    windowingEnabled,
    rows,
    file,
    hunkIndex,
    layout,
    width,
    digits,
    theme,
    highlighted,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    expansionActive,
    expandedGapKeys,
    sourceStatus,
    side,
    rowExtraHeightsByKey,
  ]);
  const windowed = useMemo(() => {
    if (windowTop === undefined || windowHeight === undefined || windowGeometry === null) {
      return null;
    }
    return resolveVisiblePlannedRowWindow({
      plannedRows: rows,
      sectionGeometry: windowGeometry,
      visibleBodyBounds: { top: windowTop, height: windowHeight },
    });
  }, [rows, windowGeometry, windowHeight, windowTop]);
  const visibleRows = windowed !== null ? windowed.plannedRows : rows;

  const beforeHunk = slots?.beforeHunk;
  const afterHunk = slots?.afterHunk;
  const afterLine = slots?.afterLine;

  return (
    <box ref={sliceRef} flexDirection="column" width={width}>
      {beforeHunk ? <box flexDirection="column">{beforeHunk}</box> : null}
      {windowed !== null && windowed.topSpacerHeight > 0 ? (
        <box height={windowed.topSpacerHeight} />
      ) : null}
      {visibleRows.map((row) => {
        const focus = focusByRowKey.get(row.key);
        const after = afterLine?.(row);
        // Row grain replaces the whole-slice glow with per-row selection.
        const selected =
          selectedRows !== undefined
            ? selectedRows.some((r) => rowMatchesLine(row, r.side, r.line, focus))
            : (focused ?? false);
        // Click/drag on the row wrapper resolves both the row and the split
        // pane under the pointer. A subdued/empty cell therefore stays a
        // no-op instead of falling through to an owned cell on the other side.
        // The handlers live on the wrapper, so DiffRowView's memo (which
        // compares every handler by reference) is untouched; the collapsed-gap
        // ▾ toggle keeps its own inner onMouseUp.
        const hasSelectableCell = changedLineOfRow(row, focus) !== null;
        const pickAt = (event: MouseEvent): RowLine | null =>
          changedLineAtColumn(row, focus, width, event.x - (sliceRef.current?.x ?? 0));
        const hitIdFor = (pick: RowLine): string =>
          `review-diff-row:${row.key}:${pick.side}:${pick.line}`;
        const onDown =
          onRowMouseDown !== undefined && hasSelectableCell
            ? (event: MouseEvent) => {
                event.stopPropagation();
                const pick = pickAt(event);
                if (pick === null) {
                  hitCoordinator.cancel();
                  dragAnchorRef.current = null;
                  return;
                }
                const hitId = hitIdFor(pick);
                hitCoordinator.arm(hitId);
                dragAnchorRef.current = { hitId, pick };
                draggingRef.current = false;
              }
            : undefined;
        const onUp =
          onRowMouseDown !== undefined && hasSelectableCell
            ? (event: MouseEvent) => {
                event.stopPropagation();
                const pick = pickAt(event);
                const anchor = dragAnchorRef.current;
                dragAnchorRef.current = null;
                if (draggingRef.current || pick === null || anchor === null) {
                  draggingRef.current = false;
                  hitCoordinator.cancel();
                  return;
                }
                const release = hitCoordinator.release(hitIdFor(pick));
                if (release.committed) onRowMouseDown(pick);
              }
            : undefined;
        const onDrag =
          onRowMouseDrag !== undefined && hasSelectableCell
            ? (event: MouseEvent) => {
                event.stopPropagation();
                const pick = pickAt(event);
                const anchor = dragAnchorRef.current;
                if (pick === null || anchor === null) return;
                if (!draggingRef.current) {
                  draggingRef.current = true;
                  hitCoordinator.cancel(anchor.hitId);
                  onRowMouseDown?.(anchor.pick);
                }
                onRowMouseDrag(pick);
                onRowMouseDragEdge?.(event.y);
              }
            : undefined;
        const onDragEnd =
          onRowMouseDrag !== undefined
            ? () => {
                hitCoordinator.cancel();
                dragAnchorRef.current = null;
                draggingRef.current = false;
                onRowMouseDragEdge?.(null);
              }
            : undefined;
        return (
          <box
            key={row.key}
            flexDirection="column"
            onMouseDown={onDown}
            onMouseUp={onUp}
            onMouseDrag={onDrag}
            onMouseDragEnd={onDragEnd}
          >
            <DiffRowView
              row={row}
              width={width}
              lineNumberDigits={digits}
              showLineNumbers={showLineNumbers}
              showHunkHeaders={showHunkHeaders}
              wrapLines={wrapLines}
              codeHorizontalOffset={codeHorizontalOffset}
              theme={theme}
              selected={selected}
              focus={focus}
              onToggleGap={onToggleGap}
            />
            {after ? <box flexDirection="column">{after}</box> : null}
          </box>
        );
      })}
      {windowed !== null && windowed.bottomSpacerHeight > 0 ? (
        <box height={windowed.bottomSpacerHeight} />
      ) : null}
      {afterHunk ? <box flexDirection="column">{afterHunk}</box> : null}
    </box>
  );
}
