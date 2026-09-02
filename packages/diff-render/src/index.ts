// @orcaops/diff-render — public API.
//
// The app imports ONLY this module; the vendored internals under src/ui,
// src/core, src/lib are not part of the contract and may change on a re-vendor.
// This is the single seam where any product-named vendored export would be
// aliased to our vocabulary — the current vendor set exposes none, so the
// re-exports pass through unrenamed. Third-party provenance: LICENSE +
// THIRD-PARTY-NOTICES.md.

// --- row model + builders (a per-hunk slice = rows.filter(hunkIndex === n)) ---
export type {
  DiffRow,
  SplitLineCell,
  StackLineCell,
  RenderSpan,
  CollapsedGapPosition,
  HighlightedDiffCode,
  HighlightedSourceCode,
} from './ui/diff/pierre';
export {
  buildSplitRows,
  buildSplitRowsForHunk,
  buildStackRows,
  buildStackRowsForHunk,
  loadHighlightedDiff,
  loadHighlightedDiffHunk,
  loadHighlightedSourceLines,
  spansForHighlightedSourceLine,
  trailingCollapsedLines,
} from './ui/diff/pierre';

// --- row rendering (OpenTUI) ---
export { DiffRowView, measureRenderedRowHeight, fitText, diffMessage } from './ui/diff/renderRows';
export {
  maxFileCodeLineWidth,
  measureRenderedCodeLineWidth,
  resolveCodeViewportWidth,
} from './ui/diff/codeColumns';
export { distinctCodeForegroundCount, splitCodeCellRanges } from './ui/diff/frameStyling';
export type { StyledLine, StyledSpan } from './ui/diff/frameStyling';

// --- async highlighting hook (plain text first, spans as Shiki resolves) ---
export {
  deferMountedDiffHighlightsForInteraction,
  prefetchHighlightedDiff,
  readMountedDiffHighlightSchedulerCompletionCount,
  useHighlightedDiff,
  waitForMountedDiffHighlightsIdle,
} from './ui/diff/useHighlightedDiff';
export { useHighlightedSource } from './ui/diff/useHighlightedSource';

// --- collapsed-gap expansion (status rows + synthesized context rows) ---
export {
  expandCollapsedRows,
  gapKey,
  selectGapForKeyboardToggle,
} from './ui/diff/expandCollapsedRows';
export type {
  ExpandCollapsedRowsOptions,
  ExpansionLayout,
  FileSourceStatus,
} from './ui/diff/expandCollapsedRows';

// --- measured slice geometry + windowing (the virtualization core's seams) ---
export {
  buildPlannedSliceRows,
  buildSliceStructureRows,
  expansionSide,
  measureSliceRowBounds,
  sliceLineNumberDigits,
} from './ui/diff/sliceGeometry';
export type {
  SliceGeometry,
  SliceRowBounds,
  SliceExpansion,
  MeasureSliceRowBoundsOptions,
} from './ui/diff/sliceGeometry';

// --- canonical-hunk focus overlay ---
export { buildRowFocusMap } from './ui/diff/focusMask';
export type {
  DiffCellFocus,
  DiffRowFocus,
  SliceLineRange,
  SliceLineRanges,
} from './ui/diff/focusMask';
export { resolveVisiblePlannedRowWindow } from './ui/diff/rowWindowing';
export type {
  VisibleBodyBounds,
  VisiblePlannedRowWindow,
  WindowedRowBounds,
  WindowedSectionGeometry,
} from './ui/diff/rowWindowing';
export { buildFileRenderWindow, buildFileSectionIndexById } from './ui/lib/fileRenderWindow';
export type { FileRenderWindowItem, FileRenderWindowPlan } from './ui/lib/fileRenderWindow';
export { findFileSectionAtOffset, findHeaderOwningFileSection } from './ui/lib/fileSectionLayout';
export type { FileSectionLayout } from './ui/lib/fileSectionLayout';
export {
  computeRapidScrollOverscanRows,
  RAPID_SCROLL_OVERSCAN_IDLE_MS,
} from './ui/lib/adaptiveScrollOverscan';

// --- the per-file diff object the app constructs (carrying attribution) ---
export type {
  DiffFile,
  DiffLineMoveKind,
  DiffLineMoveKinds,
  AgentFileContext,
  AgentAnnotation,
  LayoutMode,
  FileSourceFetcher,
  FileSourceSide,
} from './core/types';

// --- theme shape + concrete bundled themes (the app passes one into DiffSlice) ---
export type { AppTheme, SyntaxColors, ThemeBase } from './ui/themes/types';
export {
  THEMES,
  resolveTheme,
  availableThemes,
  withTransparentSurfaces,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  TRANSPARENT_BACKGROUND,
} from './ui/themes';

// --- the @pierre/diffs metadata type a DiffFile carries (re-exported for convenience) ---
export type { FileDiffMetadata } from '@pierre/diffs';

// --- our helper: build a DiffFile (carrying attribution) from a unified-diff patch ---
export { diffFileFromPatch } from './fromPatch';
export type { DiffFileFromPatchOptions } from './fromPatch';

// --- multi-line input primitives (the composer + the $EDITOR round-trip) ---
export { TextComposer, draftVisualLineCount, isNewlineKey } from './ui/components/composer';
export type { TextComposerProps } from './ui/components/composer';
export { isEscapeKey, isSaveDraftNoteKey } from './ui/lib/keyboard';
export {
  editTextViaEditor,
  openFileInEditor,
  shouldSuspendForEditor,
  buildEditorCommand,
} from './ui/lib/openInEditor';
export type { EditorRoundTrip, SuspendableRenderer, EditorCommand } from './ui/lib/openInEditor';
