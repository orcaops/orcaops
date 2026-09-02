// The diff column: one card per FILE the page touched, each carrying ALL of that
// file's parent hunks.
//
// This is what makes the CHECKPOINT the unit of review. Resolving a single hunkKey
// out of a flat list and rendering it alone shows a reviewer one hunk at a time,
// with no idea what else lives in the file, and lets `j`/`k` walk straight across
// file and checkpoint boundaries with nothing marking the crossing.
//
// The card's geometry is a CONTRACT with `buildCheckpointLayout`, which prices it
// at marginTop(1) + topRule(1) + optional header(1), a 1-row bottom rule, and
// exactly one row for every label. The first header is omitted when the fixed
// sticky row owns it. If render and measurement differ by even one row,
// scroll-to-cursor and the virtualization spacers corrupt.

import { memo, type ReactNode, useLayoutEffect, useMemo, useRef } from 'react';

import {
  type AppTheme,
  buildFileSectionIndexById,
  type FileRenderWindowItem,
  type SliceLineRanges,
} from '@orcaops/diff-render';

import { CommentPin } from './CommentPin';
import { rowMatchesLine } from './DiffSlice';
import { type ReviewHunkBody, ReviewHunkDiff } from './ReviewHunkDiff';
import {
  buildCheckpointLayout,
  type CheckpointLayout,
  type LayoutFile,
  type LayoutPage,
  unitLineRanges,
} from './checkpointLayout';
import { type DiffAnnotation, selectedRowsForHunk, type SemanticDiffAnnotation } from './diffPins';
import {
  captureDiffScrollAnchor,
  type DiffScrollAnchor,
  resolveDiffScrollAnchor,
} from './diffScrollAnchor';
import { fileBadgeLetter } from './filePresentation';
import { useGapExpansion } from './gapExpansionContext';
import {
  planHunkMount,
  planRetainedMountedFiles,
  planRetainedMountedHunks,
  type RetainedFileRenderWindow,
  type RetainedHunkRenderWindow,
} from './hunkMounting';
import type { RowLine } from './mouseSelect';
import { binaryNoteText, type PatchIndex } from './walkDiff';
import { truncate } from '../../core/format';
import { useCockpitTheme } from '../ThemeProvider';
import { ErrorState, Notice, Rule, useHit } from '../kit';
import type { CockpitTheme } from '../theme';

function badgeFor(
  theme: CockpitTheme,
  changeType: string | null
): { letter: string; color: string } {
  const letter = fileBadgeLetter(
    changeType === 'new' ||
      changeType === 'deleted' ||
      changeType === 'change' ||
      changeType === 'rename-pure' ||
      changeType === 'rename-changed'
      ? changeType
      : null
  );
  const color =
    letter === 'A'
      ? theme.LIVE
      : letter === 'D'
        ? theme.RED
        : letter === 'R'
          ? theme.CYAN
          : letter === 'M'
            ? theme.BLUE
            : theme.DIMMER;
  return { letter, color };
}

export interface CheckpointDiffProps {
  page: LayoutPage;
  patch: PatchIndex;
  /** Deferred PatchIndex enrichment; invalidates every identity-sensitive row/layout cache. */
  patchEnrichmentRevision?: number;
  theme: AppTheme;
  width: number;
  layout: 'split' | 'stack';
  /** The exact navigation stop; two stops may share one parent hunk. */
  cursorSliceKey?: string | null;
  /**
   * The cursor's parent hunk — highlights its card and selects its rows.
   * Hunk-grain because hunks are the unit the floor route tracks.
   */
  cursorHunkKey: string | null;
  /**
   * Comments placed on THIS page. The same values are handed to
   * `buildCheckpointLayout` (which prices them) and drawn below — one placement,
   * measured and rendered from the same field, so a pin cannot be priced in one
   * spot and drawn in another.
   */
  pins: readonly DiffAnnotation[];
  /**
   * The scrollbox's live position and height. Virtualization is a RENDER decision,
   * so React has to know where the reader is looking: the app owns scrollTop (the
   * ScrollBox is unfocused and its wheel is intercepted) precisely so this is true.
   * A viewport of 0 — before the renderable has laid out — mounts everything.
   */
  scrollTop: number;
  viewportHeight: number;
  /** Monotonic app-owned input revision; invalidates restoration even when the numeric top repeats. */
  viewportRevision?: number;
  /** Native slider destinations trim partially visible boundary hunks to their visible rows. */
  tightViewportWindow?: boolean;
  /** Temporary extra mounted rows while scroll input arrives in bursts. */
  overscanRows?: number;
  /** Logical reader page; restoration never crosses this boundary. */
  pageKey?: string | null;
  /** Disable old-layout restoration while an intentional page-entry slice owns positioning. */
  preserveSourceViewport?: boolean;
  /** Prefer an anchor already captured before the presentation mutation. */
  sourceAnchor?: DiffScrollAnchor | null;
  /** Retain the chosen side when one split row carries both delete and add identities. */
  preferredSourceAnchorKey?: string | null;
  /** Wheel rows queued while the replacement geometry was rendering. */
  pendingSourceDelta?: number;
  selectedRows?: readonly { side: 'add' | 'delete'; line: number }[];
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  /** The mouse, into the SAME controller seam the keys use. */
  onRowMouseDown?: (pick: RowLine | null) => void;
  onRowMouseDrag?: (pick: RowLine | null) => void;
  onRowMouseDragEdge?: (pointerY: number | null) => void;
  codeHorizontalOffset?: number;
  showOwnerLabels?: boolean;
  expandedForeignHunks?: ReadonlySet<string>;
  onToggleForeign?: (hunkKey: string) => void;
  /** The measured stream, handed back so the scroll coordinator can anchor on it. */
  onMeasured?: (layout: CheckpointLayout) => void;
  /** The fixed header above the scrollbox owns file zero's path row. */
  pinnedFileHeader?: boolean;
  /** Select a file from any in-stream path row, matching the fixed sticky row. */
  onSelectFile?: (file: string) => void;
  /** Open a pin in the comment index without adding geometry around its measured card. */
  onSelectComment?: (commentId: string) => void;
}

function SemanticAnnotationCard({
  annotation,
  width,
}: {
  annotation: SemanticDiffAnnotation;
  width: number;
}) {
  const { AMBER, CYAN, DIMMER, FG } = useCockpitTheme();
  const target = annotation.placement.target;
  const placement =
    target.scope === 'WHOLE_BLOCK'
      ? 'whole block'
      : target.focus_status === 'ACCEPTED'
        ? 'focused rows'
        : `block · ${target.focus_diagnostic_code}`;
  return (
    <box
      id={`review-semantic-annotation-${annotation.annotationId}`}
      height={annotation.height}
      flexDirection="column"
      border
      borderColor={CYAN}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={CYAN}>
        ◆ {annotation.source} · <span fg={AMBER}>{placement}</span> ·{' '}
        <span fg={DIMMER}>
          {annotation.placement.locationIndex + 1}/{Math.max(1, annotation.locationCount)}
        </span>
      </text>
      <text fg={FG}>{truncate(annotation.shortText, Math.max(8, width - 4))}</text>
    </box>
  );
}

function AnnotationCard({
  annotation,
  width,
  onSelectComment,
}: {
  annotation: DiffAnnotation;
  width: number;
  onSelectComment?: (commentId: string) => void;
}) {
  return annotation.kind === 'comment' ? (
    <CommentPin pin={annotation} width={width} onActivate={onSelectComment} />
  ) : (
    <SemanticAnnotationCard annotation={annotation} width={width} />
  );
}

/**
 * One canonical file heading, shared by the fixed sticky row and every in-stream
 * handoff row. Badge, rename wording, truncation, and stats therefore cannot drift
 * into two subtly different descriptions of the same file.
 */
export function CheckpointFileHeaderRow({
  group,
  patch,
  width,
  pinned = false,
  onActivate,
}: {
  group: LayoutFile;
  patch: PatchIndex;
  width: number;
  pinned?: boolean;
  onActivate?: () => void;
}) {
  const cockpit = useCockpitTheme();
  const hit = useHit({
    hitId: `review-file-header:${group.file}`,
    enabled: onActivate !== undefined,
    onSelect: onActivate,
  });
  const { FG, LIVE, PANEL_BG, RED } = cockpit;
  const diff = patch.fileDiff(group.file);
  const changeType = patch.fileChangeType(group.file);
  const previousName = diff?.metadata.prevName ?? null;
  const badge = badgeFor(cockpit, changeType);
  const added = group.hunks.reduce((count, hunk) => count + hunk.added, 0);
  const removed = group.hunks.reduce((count, hunk) => count + hunk.removed, 0);
  const path =
    previousName !== null && previousName !== group.file
      ? `${previousName} → ${group.file}`
      : group.file;
  const statsWidth = ` +${added} −${removed}`.length;

  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      backgroundColor={pinned ? PANEL_BG : undefined}
      onMouseOver={onActivate === undefined ? undefined : hit.onMouseOver}
      onMouseOut={onActivate === undefined ? undefined : hit.onMouseOut}
      onMouseDown={onActivate === undefined ? undefined : hit.onMouseDown}
      onMouseUp={onActivate === undefined ? undefined : hit.onMouseUp}
    >
      <text fg={badge.color}>{badge.letter} </text>
      <text fg={FG}>{truncate(path, Math.max(8, width - 18 - statsWidth))}</text>
      <text fg={LIVE}> +{added}</text>
      <text fg={RED}> −{removed}</text>
    </box>
  );
}

interface HunkFocus {
  ranges: SliceLineRanges[];
  wholeHunk: boolean;
}

/**
 * Index the rows this page owns in one hunk pass plus one slice pass per file.
 *
 * Building each hunk independently by scanning `group.slices` made this render
 * metadata O(H x S) on large generated files. Canonical hunk keys are globally
 * unique (their identity includes the file path); staging each file separately
 * keeps a slice from attaching to a hunk in another file. If invalid input
 * nevertheless duplicates a key, the final merge is last-write-wins.
 */
export function buildFocusByHunkKey(files: readonly LayoutFile[]): Map<string, HunkFocus> {
  const indexed = new Map<string, HunkFocus>();
  for (const group of files) {
    const groupFocus = new Map<string, HunkFocus>();
    for (const hunk of group.hunks) {
      groupFocus.set(hunk.hunkKey, { ranges: [], wholeHunk: false });
    }
    for (const slice of group.slices) {
      const focus = groupFocus.get(slice.hunkKey);
      if (focus === undefined) continue;
      const range = unitLineRanges(slice.unit);
      // An ambiguous unit has no own-side range — its whole hunk is the unit.
      if (range === null) focus.wholeHunk = true;
      else focus.ranges.push(range);
    }
    for (const [hunkKey, focus] of groupFocus) indexed.set(hunkKey, focus);
  }
  return indexed;
}

const EMPTY_HUNK_FOCUS: HunkFocus = { ranges: [], wholeHunk: false };
const EMPTY_EXPANDED_FOREIGN_HUNKS: ReadonlySet<string> = new Set();

interface StableFileCardProps {
  group: LayoutFile;
  sectionIndex: number;
  measured: CheckpointLayout;
  mounted: ReadonlySet<string> | null;
  scrollTop: number;
  viewportHeight: number;
  overscanRows: number;
  tightViewportWindow: boolean;
  /** Stable identity for every non-viewport value captured by `render`. */
  renderRevision: object;
  render: () => ReactNode;
}

function sameHunkMount(
  left: ReturnType<typeof planHunkMount>,
  right: ReturnType<typeof planHunkMount>
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'spacer' && right.kind === 'spacer') return left.height === right.height;
  if (left.kind === 'windowed' && right.kind === 'windowed') {
    return (
      left.rowWindow.top === right.rowWindow.top && left.rowWindow.height === right.rowWindow.height
    );
  }
  return true;
}

/**
 * Keep a file card out of React's host reconciliation while a small scroll stays
 * inside the already-mounted file/hunk window. OpenTUI moves the native viewport;
 * rebuilding identical rows on every three-line wheel tick only adds latency.
 * A boundary crossing or tall-hunk row-window move still invalidates immediately.
 */
const StableFileCard = memo(
  function StableFileCard({ render }: StableFileCardProps) {
    return render();
  },
  (previous, next) => {
    if (
      previous.group !== next.group ||
      previous.sectionIndex !== next.sectionIndex ||
      previous.measured !== next.measured ||
      previous.renderRevision !== next.renderRevision
    ) {
      return false;
    }

    for (const hunk of next.group.hunks) {
      const previousMount = planHunkMount({
        unit: previous.measured.byHunkKey.get(hunk.hunkKey),
        mounted: previous.mounted,
        scrollTop: previous.scrollTop,
        viewportHeight: previous.viewportHeight,
        destinationScrollTop: previous.scrollTop,
        tightDestinationWindow: previous.tightViewportWindow,
        overscanRows: previous.overscanRows,
      });
      const nextMount = planHunkMount({
        unit: next.measured.byHunkKey.get(hunk.hunkKey),
        mounted: next.mounted,
        scrollTop: next.scrollTop,
        viewportHeight: next.viewportHeight,
        destinationScrollTop: next.scrollTop,
        tightDestinationWindow: next.tightViewportWindow,
        overscanRows: next.overscanRows,
      });
      if (!sameHunkMount(previousMount, nextMount)) return false;
    }
    return true;
  }
);

export function CheckpointDiff({
  page,
  patch,
  patchEnrichmentRevision = 0,
  theme,
  width,
  layout,
  cursorSliceKey = null,
  cursorHunkKey,
  pins,
  scrollTop,
  viewportHeight,
  viewportRevision = 0,
  tightViewportWindow = false,
  overscanRows = 0,
  pageKey = null,
  preserveSourceViewport = false,
  sourceAnchor = null,
  preferredSourceAnchorKey = null,
  pendingSourceDelta = 0,
  selectedRows,
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  onRowMouseDown,
  onRowMouseDrag,
  onRowMouseDragEdge,
  codeHorizontalOffset = 0,
  showOwnerLabels = false,
  expandedForeignHunks = EMPTY_EXPANDED_FOREIGN_HUNKS,
  onMeasured,
  onToggleForeign,
  pinnedFileHeader = false,
  onSelectFile,
  onSelectComment,
}: CheckpointDiffProps) {
  const cockpit = useCockpitTheme();
  const { DIMMER, FOCUS_MARKER, FRAME } = cockpit;
  const gaps = useGapExpansion();
  // Card inner width (two columns of outer padding per side), less the pin's own
  // border + padding.
  const pinWidth = Math.max(12, width - 8);

  // ONE measurement, shared by the render below and by whoever scrolls it. The
  // renderer must never re-derive a hunk's display state — layout priced the
  // chrome from it, and a second derivation is how the two drift a row apart.
  const measured = useMemo(() => {
    const next = buildCheckpointLayout({
      page,
      patch,
      theme,
      layout,
      cardWidth: width,
      annotations: pins,
      showLineNumbers,
      showHunkHeaders,
      wrapLines,
      expandedGaps: gaps.expandedGaps,
      sourceStatusByFile: gaps.sourceStatusByFile,
      expandedForeignHunks,
      showOwnerLabels,
      pinnedFileHeader,
    });
    return next;
  }, [
    page,
    patch,
    patchEnrichmentRevision,
    theme,
    layout,
    width,
    pins,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    gaps.expandedGaps,
    gaps.sourceStatusByFile,
    expandedForeignHunks,
    showOwnerLabels,
    pinnedFileHeader,
  ]);

  // Resolve the old viewport into replacement geometry before React chooses
  // which files/hunks/rows to mount. ReviewApp still owns the native scroll and
  // bounded Yoga retries; this first-render destination makes its following
  // state commit mount-plan-identical instead of paying a second remount.
  const previousMeasurementRef = useRef<{
    readonly pageScope: string | LayoutPage;
    readonly layout: CheckpointLayout;
  } | null>(null);
  const pendingRenderDestinationRef = useRef<{
    readonly pageScope: string | LayoutPage;
    readonly sourceRevision: number;
    readonly sourceScrollTop: number;
    readonly anchor: DiffScrollAnchor;
  } | null>(null);
  const pageScope = pageKey ?? page;
  const previousMeasurement = previousMeasurementRef.current;
  const pendingRenderDestination = pendingRenderDestinationRef.current;
  const renderDestination = useMemo(() => {
    const maxScrollTop = Math.max(0, measured.totalHeight - Math.max(1, viewportHeight));
    const boundedScrollTop = Math.min(maxScrollTop, Math.max(0, scrollTop));
    const resolveTarget = (anchor: DiffScrollAnchor | null): number | null => {
      const resolved = anchor === null ? null : resolveDiffScrollAnchor(measured, anchor);
      if (resolved === null) return null;
      return Math.min(maxScrollTop, Math.max(0, resolved.scrollTop + pendingSourceDelta));
    };

    if (!preserveSourceViewport) {
      return { scrollTop: boundedScrollTop, pending: null };
    }

    // Retain the semantic transaction, not a numeric destination. ReaderWalk's
    // onMeasured state publication rerenders this child before ReviewApp moves
    // the native viewport; another geometry change can also arrive in that gap.
    // Re-resolving the original anchor against the newest layout handles both.
    if (
      pendingRenderDestination !== null &&
      pendingRenderDestination.pageScope === pageScope &&
      pendingRenderDestination.sourceRevision === viewportRevision &&
      pendingRenderDestination.sourceScrollTop === scrollTop
    ) {
      const retainedTarget = resolveTarget(pendingRenderDestination.anchor);
      if (retainedTarget === null) {
        return { scrollTop: boundedScrollTop, pending: null };
      }
      return {
        scrollTop: retainedTarget,
        pending: pendingRenderDestination,
      };
    }

    if (
      previousMeasurement === null ||
      previousMeasurement.pageScope !== pageScope ||
      previousMeasurement.layout === measured
    ) {
      return { scrollTop: boundedScrollTop, pending: null };
    }

    const anchor =
      sourceAnchor ??
      captureDiffScrollAnchor(previousMeasurement.layout, scrollTop, preferredSourceAnchorKey);
    const target = resolveTarget(anchor);
    if (target === null || anchor === null) {
      return { scrollTop: boundedScrollTop, pending: null };
    }
    return {
      scrollTop: target,
      pending: {
        pageScope,
        sourceRevision: viewportRevision,
        sourceScrollTop: scrollTop,
        anchor,
      },
    };
  }, [
    measured,
    pageScope,
    pendingSourceDelta,
    pendingRenderDestination,
    preferredSourceAnchorKey,
    preserveSourceViewport,
    previousMeasurement,
    scrollTop,
    sourceAnchor,
    viewportRevision,
    viewportHeight,
  ]);
  const renderScrollTop = renderDestination.scrollTop;

  // Report geometry after the render commits. Calling the parent while this child
  // is rendering makes initial/page-transition scroll anchoring race a surface
  // whose dimensions have not landed yet.
  useLayoutEffect(() => {
    pendingRenderDestinationRef.current = renderDestination.pending;
    previousMeasurementRef.current = { pageScope, layout: measured };
  }, [measured, pageScope, renderDestination.pending]);
  useLayoutEffect(() => {
    onMeasured?.(measured);
  }, [measured, onMeasured]);

  // Stable O(1) selected-id lookups for every scroll plan. Rebuilding these
  // full maps per wheel delta turned an otherwise windowed planner back into an
  // O(all hunks + all files) hot path.
  const hunkSectionIndex = useMemo(
    () => buildFileSectionIndexById(measured.sections),
    [measured.sections]
  );
  const fileSectionIndex = useMemo(
    () => buildFileSectionIndexById(measured.fileSections),
    [measured.fileSections]
  );

  // Which hunks mount at all. `null` = all of them (nothing measured yet, or the
  // renderable has not reported a viewport). Native exploration deliberately does
  // not retain a second distant window around an offscreen semantic cursor.
  // Only a committed window may become the next render's hysteresis anchor.
  // Updating these refs from a layout effect keeps an interrupted/concurrent
  // render from publishing a plan the terminal never actually received.
  const committedHunkWindowRef = useRef<RetainedHunkRenderWindow | null>(null);
  const hunkWindow = useMemo(
    () =>
      planRetainedMountedHunks(
        {
          sections: measured.sections,
          indexBySectionId: hunkSectionIndex,
          scrollTop: renderScrollTop,
          viewportHeight,
          overscanRows,
        },
        committedHunkWindowRef.current
      ),
    [hunkSectionIndex, measured.sections, overscanRows, renderScrollTop, viewportHeight]
  );
  useLayoutEffect(() => {
    committedHunkWindowRef.current = hunkWindow;
  }, [hunkWindow]);
  const mounted = hunkWindow?.mounted ?? null;

  // Window the FILE stream before JSX descends into a card. Hunk-level spacers
  // preserve row geometry, but still leave React reconciling every file and every
  // hunk placeholder on each cursor move. Consecutive skipped cards collapse to
  // one exact-height spacer here; mounted cards retain the finer hunk/row plan.
  const committedFileWindowRef = useRef<RetainedFileRenderWindow | null>(null);
  const fileWindow = useMemo(
    () =>
      planRetainedMountedFiles(
        {
          sections: measured.fileSections,
          indexBySectionId: fileSectionIndex,
          scrollTop: renderScrollTop,
          viewportHeight,
          overscanRows,
        },
        committedFileWindowRef.current
      ),
    [fileSectionIndex, measured.fileSections, overscanRows, renderScrollTop, viewportHeight]
  );
  useLayoutEffect(() => {
    committedFileWindowRef.current = fileWindow;
  }, [fileWindow]);
  const filePlan = fileWindow?.plan ?? null;
  const fileItems = useMemo<FileRenderWindowItem[]>(
    () =>
      filePlan?.items ??
      page.files.map((group, sectionIndex) => ({
        kind: 'file' as const,
        fileId: group.file,
        sectionIndex,
      })),
    [filePlan, page.files]
  );

  // Slice focus is presentation metadata and should stay referentially stable
  // while scrolling/windows remount. DiffSlice can then preserve canonical row
  // identity and memoize the orthogonal per-cell focus map.
  const focusByHunkKey = useMemo(() => buildFocusByHunkKey(page.files), [page.files]);
  const selectedRowsRevision =
    selectedRows?.map((row) => `${row.side}:${row.line}`).join('|') ?? '';

  // Everything the file-card render closure captures except the live viewport.
  // This token changes on real presentation/selection/content updates; scroll
  // ticks use the structural mount comparison in StableFileCard instead.
  const fileCardRenderRevision = useMemo(
    () => ({
      cockpit,
      codeHorizontalOffset,
      cursorHunkKey,
      cursorSliceKey,
      focusByHunkKey,
      expandedGaps: gaps.expandedGaps,
      sourceStatusByFile: gaps.sourceStatusByFile,
      toggleGap: gaps.toggleGap,
      layout,
      onRowMouseDown,
      onRowMouseDrag,
      onRowMouseDragEdge,
      onSelectFile,
      onSelectComment,
      onToggleForeign,
      patch,
      patchEnrichmentRevision,
      pinnedFileHeader,
      pins,
      selectedRowsRevision,
      showHunkHeaders,
      showLineNumbers,
      showOwnerLabels,
      theme,
      width,
      wrapLines,
    }),
    [
      cockpit,
      codeHorizontalOffset,
      cursorHunkKey,
      cursorSliceKey,
      focusByHunkKey,
      gaps.expandedGaps,
      gaps.sourceStatusByFile,
      gaps.toggleGap,
      layout,
      onRowMouseDown,
      onRowMouseDrag,
      onRowMouseDragEdge,
      onSelectFile,
      onSelectComment,
      onToggleForeign,
      patch,
      patchEnrichmentRevision,
      pinnedFileHeader,
      pins,
      selectedRowsRevision,
      showHunkHeaders,
      showLineNumbers,
      showOwnerLabels,
      theme,
      width,
      wrapLines,
    ]
  );

  return (
    <box flexDirection="column" height={measured.totalHeight} flexShrink={0}>
      {fileItems.map((fileItem) => {
        if (fileItem.kind === 'spacer') {
          return <box key={fileItem.key} height={fileItem.height} />;
        }
        const group = page.files[fileItem.sectionIndex];
        if (group === undefined) return null;
        const diff = patch.fileDiff(group.file);
        const changeType = patch.fileChangeType(group.file);
        const selected = group.hunks.some((hunk) => hunk.hunkKey === cursorHunkKey);
        const renamePure = changeType === 'rename-pure';
        const binary = diff === null ? patch.binaryInfo(group.file) : null;

        return (
          <StableFileCard
            key={group.file}
            group={group}
            sectionIndex={fileItem.sectionIndex}
            measured={measured}
            mounted={mounted}
            scrollTop={renderScrollTop}
            viewportHeight={viewportHeight}
            overscanRows={overscanRows}
            tightViewportWindow={tightViewportWindow}
            renderRevision={fileCardRenderRevision}
            render={() => (
              <box
                id={`review-file-card-${fileItem.sectionIndex}`}
                flexDirection="column"
                paddingLeft={2}
                paddingRight={2}
                marginTop={1}
              >
                <Rule width={Math.max(0, width - 4)} color={selected ? FOCUS_MARKER : FRAME} />
                {pinnedFileHeader && fileItem.sectionIndex === 0 ? null : (
                  <CheckpointFileHeaderRow
                    group={group}
                    patch={patch}
                    width={width}
                    onActivate={() => onSelectFile?.(group.file)}
                  />
                )}

                {/* Priced right after the card header, in `pins` order — see buildCheckpointLayout. */}
                {pins
                  .filter((pin) => pin.target.kind === 'file' && pin.target.file === group.file)
                  .map((pin) => (
                    <AnnotationCard
                      key={pin.annotationId}
                      annotation={pin}
                      width={pinWidth}
                      onSelectComment={onSelectComment}
                    />
                  ))}

                {renamePure ? (
                  <text fg={DIMMER}>⋯ file moved, contents unchanged (rename hunk)</text>
                ) : diff === null && binary !== null && binary.binary ? (
                  <Notice
                    id={`review-binary-file-${fileItem.sectionIndex}`}
                    variant="inline"
                    rows={1}
                    width={Math.max(0, width - 4)}
                    message={binaryNoteText(binary)}
                  />
                ) : diff === null ? (
                  <ErrorState
                    id={`review-file-unavailable-${fileItem.sectionIndex}`}
                    variant="inline"
                    rows={1}
                    width={Math.max(0, width - 4)}
                    message="diff unavailable — truncated or unparseable"
                  />
                ) : (
                  group.hunks.map((hunk) => {
                    const unit = measured.byHunkKey.get(hunk.hunkKey);
                    const mount = planHunkMount({
                      unit,
                      mounted,
                      scrollTop: renderScrollTop,
                      viewportHeight,
                      destinationScrollTop: renderScrollTop,
                      tightDestinationWindow: tightViewportWindow,
                      overscanRows,
                    });

                    // Outside the window: an exact-height spacer. `unit.height` is the
                    // number the layout ALREADY committed to, so the content height
                    // below is bit-for-bit what it would be fully mounted — which is
                    // what keeps `G` landing on the real bottom instead of somewhere
                    // short of it.
                    if (mount.kind === 'spacer') {
                      return <box key={hunk.hunkKey} height={mount.height} />;
                    }

                    const semanticAnnotation = pins.find(
                      (pin): pin is SemanticDiffAnnotation =>
                        pin.kind === 'semantic' &&
                        pin.placement.target.block.hunk_key === hunk.hunkKey
                    );
                    const focus =
                      semanticAnnotation === undefined
                        ? (focusByHunkKey.get(hunk.hunkKey) ?? EMPTY_HUNK_FOCUS)
                        : EMPTY_HUNK_FOCUS;
                    const activeSlice = group.slices.find(
                      (slice) => slice.hunkKey === hunk.hunkKey && slice.sliceKey === cursorSliceKey
                    );
                    const activeRanges =
                      activeSlice === undefined ? null : unitLineRanges(activeSlice.unit);
                    const activeSliceRows =
                      activeRanges === null
                        ? undefined
                        : [
                            ...(activeRanges.delRange === null
                              ? []
                              : Array.from(
                                  {
                                    length:
                                      activeRanges.delRange.end - activeRanges.delRange.start + 1,
                                  },
                                  (_unused, index) => ({
                                    side: 'delete' as const,
                                    line: activeRanges.delRange!.start + index,
                                  })
                                )),
                            ...(activeRanges.addRange === null
                              ? []
                              : Array.from(
                                  {
                                    length:
                                      activeRanges.addRange.end - activeRanges.addRange.start + 1,
                                  },
                                  (_unused, index) => ({
                                    side: 'add' as const,
                                    line: activeRanges.addRange!.start + index,
                                  })
                                )),
                          ];
                    const owned = new Set(unit?.primarySliceKeys ?? []);
                    const slicePins = pins.filter(
                      (pin) => pin.target.kind === 'slice' && owned.has(pin.target.sliceKey)
                    );
                    // The SAME predicate the layout priced these with. Both read the row
                    // off `target`, so a pin cannot be counted here and matched there.
                    const linePins = pins.filter(
                      (pin) => pin.target.kind === 'line' && owned.has(pin.target.sliceKey)
                    );

                    // Inline pins use the SAME stable row keys and exact heights the
                    // layout priced. They can therefore remain attached to a bounded
                    // row window without making its top/bottom spacers lie.
                    const body: ReviewHunkBody = {
                      ...mount,
                      ...(unit !== undefined
                        ? { rowExtraHeightsByKey: unit.rowExtraHeightsByKey }
                        : {}),
                      ...(linePins.length > 0
                        ? {
                            afterLine: (row) => {
                              const hits = linePins.filter(
                                (pin) =>
                                  pin.target.kind === 'line' &&
                                  rowMatchesLine(row, pin.target.side, pin.target.line)
                              );
                              if (hits.length === 0) return null;
                              return (
                                <box flexDirection="column">
                                  {hits.map((pin) => (
                                    <AnnotationCard
                                      key={pin.annotationId}
                                      annotation={pin}
                                      width={pinWidth}
                                      onSelectComment={onSelectComment}
                                    />
                                  ))}
                                </box>
                              );
                            },
                          }
                        : {}),
                    };

                    return (
                      <ReviewHunkDiff
                        key={hunk.hunkKey}
                        hunk={hunk}
                        file={diff}
                        hunkIndex={patch.hunkIndex(hunk)}
                        display={unit?.display ?? 'unavailable'}
                        body={body}
                        beforeHunk={
                          slicePins.length > 0 ? (
                            <box flexDirection="column">
                              {slicePins.map((pin) => (
                                <AnnotationCard
                                  key={pin.annotationId}
                                  annotation={pin}
                                  width={pinWidth}
                                  onSelectComment={onSelectComment}
                                />
                              ))}
                            </box>
                          ) : undefined
                        }
                        showOwnerLabels={showOwnerLabels}
                        width={Math.max(24, width - 4)}
                        theme={theme}
                        layout={layout}
                        focusRanges={focus.ranges}
                        focusWholeHunk={focus.wholeHunk}
                        selectedRows={selectedRowsForHunk({
                          cursorHunk: hunk.hunkKey === cursorHunkKey,
                          reviewerRows: selectedRows,
                          annotation: semanticAnnotation,
                          activeSliceRows,
                        })}
                        showLineNumbers={showLineNumbers}
                        showHunkHeaders={showHunkHeaders}
                        wrapLines={wrapLines}
                        onRowMouseDown={onRowMouseDown}
                        onRowMouseDrag={onRowMouseDrag}
                        onRowMouseDragEdge={onRowMouseDragEdge}
                        codeHorizontalOffset={codeHorizontalOffset}
                        expandedGapKeys={gaps.expandedGaps.get(group.file)}
                        sourceStatus={gaps.sourceStatusByFile.get(group.file)}
                        onToggleGap={(gapKey) => gaps.toggleGap(group.file, gapKey, diff)}
                        onToggleForeign={onToggleForeign}
                      />
                    );
                  })
                )}
                <Rule width={Math.max(0, width - 4)} />
              </box>
            )}
          />
        );
      })}
    </box>
  );
}
