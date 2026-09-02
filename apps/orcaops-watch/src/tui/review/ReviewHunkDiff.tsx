// The shared canonical parent-hunk renderer.
//
// Matched and expanded-foreign parents render the real DiffSlice rows; a
// foreign-only parent collapses to one explicit presentation row; a floor/patch
// mismatch stays loud rather than vanishing.
//
// It takes the MEASURED `display` rather than the ingredients to re-derive it, so
// layout and render cannot disagree: layout prices the chrome from `display`, this
// draws it from the same `display`, and there is no second derivation.

import type { ReactNode } from 'react';

import type {
  AppTheme,
  DiffFile,
  DiffRow,
  FileSourceStatus,
  SliceLineRanges,
} from '@orcaops/diff-render';

import { DiffSlice } from './DiffSlice';
import type { HunkDisplay, LayoutHunk } from './checkpointLayout';
import { hiddenHunkLabel, hideHunkLabel, subduedContextLabel } from './hunkLabels';
import type { RowWindow } from './hunkMounting';
import type { RowLine } from './mouseSelect';
import { useCockpitTheme } from '../ThemeProvider';
import { ErrorState } from '../kit';

/**
 * How this hunk's rows mount. Inline pins travel with the exact per-row heights
 * priced by checkpointLayout, so the windowed arm preserves spacer geometry.
 */
export type ReviewHunkBody = (
  | { readonly kind: 'full' }
  /** A bounded visual-row band. Rows and inline pins outside it become exact spacers. */
  | { readonly kind: 'windowed'; readonly rowWindow: RowWindow }
) & {
  readonly afterLine?: (row: DiffRow) => ReactNode;
  readonly rowExtraHeightsByKey?: ReadonlyMap<string, number>;
};

export interface ReviewHunkDiffProps {
  hunk: LayoutHunk;
  file: DiffFile;
  hunkIndex: number | null;
  /** The MEASURED display state from `CheckpointLayout.byHunkKey`. Never re-derived. */
  display: HunkDisplay;
  /** The MEASURED mount from `planHunkMount`. Never re-derived. */
  body: ReviewHunkBody;
  /**
   * Pins that sit ABOVE the rows — priced into `HunkUnit.sliceTop` as a fixed
   * offset, never interleaved. Inline `afterLine` pins instead travel through
   * the body's measured `rowExtraHeightsByKey` map.
   */
  beforeHunk?: ReactNode;
  showOwnerLabels?: boolean;
  width: number;
  theme: AppTheme;
  layout: 'split' | 'stack';
  /** The rows this page OWNS. Everything else in the hunk renders as subdued context. */
  focusRanges: readonly SliceLineRanges[];
  focusWholeHunk?: boolean;
  selectedRows?: readonly { side: 'add' | 'delete'; line: number }[];
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  codeHorizontalOffset: number;
  expandedGapKeys?: ReadonlySet<string>;
  sourceStatus?: FileSourceStatus;
  onToggleGap?: (gapKey: string) => void;
  onToggleForeign?: (hunkKey: string) => void;
  onRowMouseDown?: (pick: RowLine | null) => void;
  onRowMouseDrag?: (pick: RowLine | null) => void;
  onRowMouseDragEdge?: (pointerY: number | null) => void;
}

export function ReviewHunkDiff(props: ReviewHunkDiffProps) {
  const { DIMMER } = useCockpitTheme();
  const {
    hunk,
    file,
    hunkIndex,
    display,
    body,
    beforeHunk,
    showOwnerLabels = false,
    width,
    theme,
    layout,
    focusRanges,
    focusWholeHunk = false,
    selectedRows,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    codeHorizontalOffset,
    expandedGapKeys,
    sourceStatus,
    onToggleGap,
    onToggleForeign,
    onRowMouseDown,
    onRowMouseDrag,
    onRowMouseDragEdge,
  } = props;

  if (display === 'unavailable' || hunkIndex === null) {
    return (
      <ErrorState
        id={`review-hunk-unavailable-${hunk.hunkKey}`}
        variant="inline"
        rows={1}
        width={width}
        message={`hunk unavailable (+${hunk.added} −${hunk.removed}) — floor/patch mismatch`}
      />
    );
  }

  // Every label below is priced by checkpointLayout at EXACTLY one row, so all of
  // them go through hunkLabels, which truncates to width.
  if (display === 'collapsed') {
    return (
      <box onMouseUp={onToggleForeign ? () => onToggleForeign(hunk.hunkKey) : undefined}>
        <text fg={DIMMER}>
          {hiddenHunkLabel({
            collapsedBefore: file.metadata.hunks[hunkIndex]?.collapsedBefore ?? 0,
            added: hunk.added,
            removed: hunk.removed,
            owners: showOwnerLabels ? hunk.ownerLabels : [],
            width,
          })}
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column">
      {display === 'expanded-foreign' ? (
        <box onMouseUp={onToggleForeign ? () => onToggleForeign(hunk.hunkKey) : undefined}>
          <text fg={DIMMER}>{hideHunkLabel(width)}</text>
        </box>
      ) : null}
      {showOwnerLabels && hunk.foreignOwnerLabels.length > 0 ? (
        <text fg={DIMMER}>{subduedContextLabel(hunk.foreignOwnerLabels, width)}</text>
      ) : null}
      <DiffSlice
        file={file}
        hunkIndex={hunkIndex}
        width={width}
        theme={theme}
        layout={layout}
        focused={false}
        selectedRows={selectedRows}
        showLineNumbers={showLineNumbers}
        showHunkHeaders={showHunkHeaders}
        wrapLines={wrapLines}
        codeHorizontalOffset={codeHorizontalOffset}
        maskOutsideRanges={focusWholeHunk ? undefined : focusRanges}
        rowWindow={body.kind === 'windowed' ? body.rowWindow : undefined}
        rowExtraHeightsByKey={body.rowExtraHeightsByKey}
        expandedGapKeys={expandedGapKeys}
        sourceStatus={sourceStatus}
        onToggleGap={onToggleGap}
        onRowMouseDown={onRowMouseDown}
        onRowMouseDrag={onRowMouseDrag}
        onRowMouseDragEdge={onRowMouseDragEdge}
        slots={{
          ...(beforeHunk !== undefined ? { beforeHunk } : {}),
          ...(body.afterLine !== undefined ? { afterLine: body.afterLine } : {}),
        }}
      />
    </box>
  );
}
