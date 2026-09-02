import type { MouseEvent, ScrollBoxRenderable } from '@opentui/core';
import type { ReactNode, RefObject } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import {
  type AppTheme,
  findFileSectionAtOffset,
  findHeaderOwningFileSection,
} from '@orcaops/diff-render';
import {
  CITATION_KIND,
  type Floor,
  type ReviewLifecycleLedger,
  UNCERTAINTY_STATE,
  type UncertaintyState,
} from '@orcaops/review-core';

import type { EnrichedComment } from '../../data/commentsSource';
import type {
  ReviewTargetsStatus,
  RoutineStoryAnchors,
  RoutineStoryOverlay,
} from '../../data/reviewSource';
import type { StalenessRow } from '../../data/staleness';
import { useCockpitTheme } from '../ThemeProvider';
import { SYMBOL, UI_GLYPH } from '../coreTheme';
import { EmptyState, ErrorState, Notice, Rule, Section, useHit, WarningBanner } from '../kit';
import { displayLen, truncate } from '../layout';
import { allocateReviewSurfaceHeight, fitActionRow, readableProseWidth } from '../responsiveLayout';
import { Brief } from './Brief';
import { CheckpointDiff, CheckpointFileHeaderRow } from './CheckpointDiff';
import { OffPageCommentPin } from './CommentPin';
import { CommentsIndex } from './CommentsIndex';
import { ReviewFileNavigator } from './ReviewFileNavigator';
import type { BriefAttentionRow } from './briefAttention';
import { type BriefTree as BriefTreeModel, buildBriefTree } from './briefTree';
import { automatedConcerns, capturedTrailForCheckpoint } from './capturedTrail';
import type { CheckpointLayout } from './checkpointLayout';
import { buildDiffPins, headerPins, type SemanticDiffAnnotation } from './diffPins';
import type { DiffScrollAnchor } from './diffScrollAnchor';
import { diffDragEdgeDirection, type DiffDragEdgeDirection } from './dragEdge';
import { buildFileNavigatorEntries } from './fileNavigator';
import { compactDiffPath, fileBadgeLetter } from './filePresentation';
import type { FinishObligation } from './finishPresentation';
import { useGapExpansion } from './gapExpansionContext';
import {
  selectStoryReviewFooterLayout,
  type StoryReviewFocus,
  type StoryReviewScreen,
} from './keymap';
import type { RowLine } from './mouseSelect';
import { filterNavigatorFiles } from './navigation';
import { checkpointKeyForHunk, projectCheckpointPage, rowsOfProjectedHunk } from './pageProjection';
import type { ReaderAuxiliaryPage, ReaderModel, ReaderPage, ReaderRailItem } from './readerModel';
import { BRIEF_TREE_FOCUS } from './readerReviewController';
import { resolveReviewDiffLayout, reviewReaderGeometry } from './reviewDiffHorizontal';
import { buildPatchIndex, type PatchIndex } from './walkDiff';

function ReviewHitRow({
  id,
  children,
  onSelect,
  selectedBackground,
  flexDirection = 'row',
  paddingLeft,
}: {
  id: string;
  children: ReactNode;
  onSelect?: () => void;
  selectedBackground?: string;
  flexDirection?: 'row' | 'column';
  paddingLeft?: number;
}) {
  const { SEL_BG } = useCockpitTheme();
  const hit = useHit({ hitId: id, enabled: onSelect !== undefined, onSelect });
  const interactive = onSelect !== undefined;
  return (
    <box
      id={id}
      flexDirection={flexDirection}
      paddingLeft={paddingLeft}
      backgroundColor={selectedBackground ?? (hit.hovered ? SEL_BG : undefined)}
      onMouseOver={interactive ? hit.onMouseOver : undefined}
      onMouseOut={interactive ? hit.onMouseOut : undefined}
      onMouseDown={interactive ? hit.onMouseDown : undefined}
      onMouseUp={interactive ? hit.onMouseUp : undefined}
    >
      {children}
    </box>
  );
}

export type ReviewExperienceScreen = StoryReviewScreen;

const contextRailItemId = (index: number): string => `review-context-item-${index}`;

export interface ReviewExperienceProps {
  floor: Floor;
  lifecycle?: ReviewLifecycleLedger;
  /**
   * Whether owned rows could be derived from floor + diff.patch at all. When it
   * is not ok, coverage cannot be computed on ANY screen, so the banner is not
   * screen-scoped — it sits above the body, everywhere.
   */
  targetsStatus?: ReviewTargetsStatus;
  storyStatus?: RoutineStoryOverlay['status'];
  storyIssue?: string | null;
  storyRunId?: string | null;
  storyAnchorStatus?: RoutineStoryAnchors['status'];
  storyAnchorIssue?: string | null;
  staleness?: StalenessRow | null;
  screen: ReviewExperienceScreen;
  width: number;
  height: number;
  activeAct?: number;
  activePart?: number;
  activeItem?: number;
  activeStoryItemId?: string | null;
  attentionCursor?: number;
  commentCursor?: number;
  flatFileCursor?: number;
  /** `/` — the current file-navigation filter, or null when unfiltered. */
  fileFilter?: string | null;
  floorCursor?: number;
  diffGrain?: 'hunk' | 'row';
  diffRowCursor?: number;
  diffSelectionAnchor?: number | null;
  selectedFloorSliceKey?: string | null;
  selectedFloorHunkKey?: string | null;
  focus?: StoryReviewFocus;
  /** Whether q exits Review rather than consuming one local Back step. */
  atReviewRoot?: boolean;
  notice?: string | null;
  reviewDiff?: string;
  /** Parsed once per immutable review generation by ReviewApp. */
  patchIndex?: PatchIndex;
  /** Deferred moved-line presentation revision from that immutable index. */
  patchEnrichmentRevision?: number;
  theme?: AppTheme;
  onActivateRailItem?: (index: number) => void;
  onMarkReviewed?: (partKey: string) => void;
  walkScrollRef?: RefObject<ScrollBoxRenderable | null>;
  capturedTrailScrollRef?: RefObject<ScrollBoxRenderable | null>;
  /** Foreign parent hunks the reviewer has opened back up (`Z`, or a click). */
  expandedForeignHunks?: ReadonlySet<string>;
  onToggleForeign?: (hunkKey: string) => void;
  /**
   * `l` / `w` / `M`. GEOMETRY INPUTS, not decoration: `measureSliceRowBounds`
   * prices a wrapped row differently, so the layout, the mount plan and the render
   * must read the same three booleans or the spacers stop adding up.
   */
  showLineNumbers?: boolean;
  wrapLines?: boolean;
  showHunkHeaders?: boolean;
  diffLayout?: 'split' | 'stack' | 'auto';
  showOwnerLabels?: boolean;
  codeHorizontalOffset?: number;
  /** The mouse, into the SAME controller seam the keys use. */
  onRowMouseDown?: (pick: RowLine | null) => void;
  onRowMouseDrag?: (pick: RowLine | null) => void;
  /**
   * The comment sidecar, straight from the engine — NOT routed through the
   * narrative item model. The re-anchor ladder is already narrative-independent,
   * so pins render on the deterministic path, which is the only path that exists
   * until a Story is composed.
   */
  comments?: readonly EnrichedComment[];
  semanticAnnotation?: SemanticDiffAnnotation | null;
  /** The diff column's live scroll position and viewport height (see CheckpointDiff). */
  diffScrollTop?: number;
  diffViewportHeight?: number;
  diffViewportRevision?: number;
  diffTightViewportWindow?: boolean;
  /** Native viewport after fixed headers and off-page pins take their rows. */
  diffVisibleViewportHeight?: number;
  diffOverscanRows?: number;
  preserveDiffSourceViewport?: boolean;
  diffSourceAnchor?: DiffScrollAnchor | null;
  preferredDiffSourceAnchorKey?: string | null;
  pendingDiffSourceDelta?: number;
  onDiffWheel?: (delta: number) => void;
  /** Shift+wheel/native horizontal wheel pans code without moving the viewport. */
  onDiffHorizontalWheel?: (delta: number) => void;
  onDiffDragEdge?: (direction: DiffDragEdgeDirection | null) => void;
  onDiffMeasured?: (layout: CheckpointLayout) => void;
  onDiffScrollSurface?: (surface: ScrollBoxRenderable | null) => void;
  finishObligations?: readonly FinishObligation[];
  finishCursor?: number;
  /** Replayed citation state; absent entries are still open. */
  uncertaintyStates?: ReadonlyMap<string, UncertaintyState>;
  contextItemCursor?: number;
  onSelectContextItem?: (index: number) => void;
  /** The Brief's tree cursor — an index into `BriefTree.destinations`. */
  briefCursor?: number;
  /** Durable identity of the selected attention row, or null before traversal. */
  attentionRowKey?: string | null;
  /** Built once per projection by the app; shared with cursor clamping and routing. */
  briefTree?: BriefTreeModel | null;
  briefAttention?: readonly BriefAttentionRow[];
  onActivateBriefDestination?: (destination: number) => void;
  onActivateBriefAttention?: (index: number) => void;
  onActivateFlatFile?: (index: number) => void;
  onActivateComment?: (index: number) => void;
  onActivateFinishObligation?: (index: number) => void;
  onActivateCommentPin?: (commentId: string) => void;
  /** Sidebar file rows and keyboard file movement share this transition. */
  onSelectDiffFile?: (file: string) => void;
  /** `\` and the visible FILES header share this presentation transition. */
  fileNavigatorExpanded?: boolean;
  onToggleFileNavigator?: () => void;
  /** The reader's current page, and where it sits in the lens's page list. */
  readerPage?: ReaderPage | ReaderAuxiliaryPage | null;
  pageNumber?: number;
  pageCount?: number;
  /**
   * The reader itself — carried for the screens that are a statement about the
   * BRANCH rather than about one page. Finish is the first: its gate is the same
   * one the journal transport re-checks, and it has to answer under either lens.
   */
  reader?: ReaderModel | null;
}

function stateGlyph(complete: boolean): string {
  return complete ? '✓' : '○';
}

function StoryProgress({ reader }: { reader: ReaderModel }) {
  const { DIM, FG, LIVE } = useCockpitTheme();
  const story = reader.story;
  if (story === null) return null;
  const parts = reader.pages.filter((page) => page.kind === 'part');
  const partsComplete = parts.filter((page) => page.complete).length;
  const actsComplete = story.acts.filter((act) =>
    act.partIds.every(
      (partId) => reader.pages.find((page) => page.key === partId)?.complete === true
    )
  ).length;
  const residue =
    reader.auxiliaryPage.kind === 'story-residue' &&
    (reader.auxiliaryPage.sliceStops.length > 0 || reader.auxiliaryPage.railItems.length > 0)
      ? ` · ${reader.auxiliaryPage.complete ? 1 : 0}/1 Residue`
      : '';
  const openItems = reader.routeIndex.attentionItems.filter(
    (item) => item.state === 'OPEN' || item.state === 'OUTSTANDING'
  ).length;
  return (
    <text fg={reader.finish.allowed ? LIVE : FG}>
      1 Story · {actsComplete}/{story.acts.length} Acts · {partsComplete}/{parts.length} Parts
      {residue} · <span fg={DIM}>{openItems} open</span>
    </text>
  );
}

function CapturedContextDetail({ item, width }: { item: ReaderRailItem | null; width: number }) {
  const { AMBER, DIM, FG, PANEL_BG, ACCENT } = useCockpitTheme();
  if (item === null) {
    return (
      <ErrorState
        id="review-captured-context-missing"
        variant="screen"
        title="Captured context unavailable"
        message="The selected item no longer exists in this Story generation."
      />
    );
  }
  return (
    <scrollbox
      id="review-captured-context-scroll"
      scrollY={true}
      focused={false}
      flexGrow={1}
      padding={2}
      backgroundColor={PANEL_BG}
    >
      <box width={readableProseWidth(width, 4)} flexDirection="column">
        <Section id="review-captured-context-heading" title="CAPTURED CONTEXT" />
        <text fg={ACCENT}>
          {item.source} · {item.kind}
        </text>
        <text fg={item.state === 'OPEN' || item.state === 'OUTSTANDING' ? AMBER : FG}>
          {item.state} · {item.placementState ?? 'unplaced'}
        </text>
        {item.disposition === undefined ? null : (
          <text fg={DIM}>
            {item.disposition} · {item.targetCount ?? 0} semantic target(s) ·{' '}
            {item.locationCount ?? 0} real location(s)
          </text>
        )}
        {item.context === undefined ? null : <text fg={DIM}>Source · {item.context}</text>}
        <text> </text>
        <text fg={FG}>{item.text}</text>
        <text> </text>
        <text fg={DIM}>
          {item.placementState === 'anchored'
            ? 'Enter from its compact rail link to open code; (/) cycles real locations.'
            : 'No code location was declared. No link or inline card has been fabricated.'}
        </text>
        <text fg={DIM}>Esc · return</text>
      </box>
    </scrollbox>
  );
}

export interface ReviewChangedRow {
  side: 'add' | 'delete';
  line: number;
}

function rowsForRange(side: 'add' | 'delete', start: number, end: number): ReviewChangedRow[] {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => ({
    side,
    line: start + offset,
  }));
}

export function changedRowsForFloorHunk(
  hunk: Floor['coverage']['items'][number]
): ReviewChangedRow[] {
  const partitionRows = hunk.units.flatMap((unit) => {
    if (unit.kind === 'ambiguous_hunk') return [];
    return [
      ...(unit.del_range === null
        ? []
        : rowsForRange('delete', unit.del_range.start, unit.del_range.end)),
      ...(unit.add_range === null
        ? []
        : rowsForRange('add', unit.add_range.start, unit.add_range.end)),
    ];
  });
  if (partitionRows.length > 0) return partitionRows;
  return [
    ...(hunk.old_start === null || hunk.old_start === undefined
      ? []
      : rowsForRange('delete', hunk.old_start, hunk.old_start + hunk.removed_lines - 1)),
    ...(hunk.new_start === null || hunk.new_start === undefined
      ? []
      : rowsForRange('add', hunk.new_start, hunk.new_start + hunk.added_lines - 1)),
  ];
}

export function selectedRowsForCursor(
  rows: readonly ReviewChangedRow[],
  cursor: number,
  selectionAnchor: number | null
): ReviewChangedRow[] {
  if (rows.length === 0) return [];
  const boundedCursor = Math.max(0, Math.min(cursor, rows.length - 1));
  if (selectionAnchor === null) return [rows[boundedCursor]!];
  const boundedAnchor = Math.max(0, Math.min(selectionAnchor, rows.length - 1));
  const start = Math.min(boundedCursor, boundedAnchor);
  const end = Math.max(boundedCursor, boundedAnchor);
  return rows.slice(start, end + 1);
}

export interface ReaderHeaderLayout {
  label: string;
  droppedIds: readonly string[];
  requiredDroppedIds: readonly string[];
  occupiedWidth: number;
}

/** Fit the measured reader's external header without changing the diff document. */
export function selectReaderHeaderLayout({
  width,
  page,
  slice,
  file,
  row,
}: {
  width: number;
  page: string;
  slice: string;
  file: string;
  row: string | null;
}): ReaderHeaderLayout {
  const pagePrefix = page.split(' · ')[0] ?? page;
  const shortPage = pagePrefix.startsWith('Checkpoint')
    ? pagePrefix.replace('Checkpoint', 'CP')
    : pagePrefix;
  const shortFile = `F ${compactDiffPath(file.replace(/^Cursor · /, ''), Math.max(6, Math.floor(width * 0.24)))}`;
  const rowLayout = fitActionRow(
    [
      {
        id: 'page',
        fullLabel: page,
        shortLabel: shortPage,
        priority: 0,
        required: true,
      },
      {
        id: 'slice',
        fullLabel: slice,
        shortLabel: slice.replace('Slice ', 'S '),
        priority: 0,
        required: true,
      },
      {
        id: 'file',
        fullLabel: file,
        shortLabel: shortFile,
        priority: 0,
        required: true,
      },
      ...(row === null
        ? []
        : [
            {
              id: 'row',
              fullLabel: row,
              shortLabel: row.replace('Row ', 'R '),
              priority: 0,
              required: true,
            },
          ]),
    ],
    Math.max(0, width - 2),
    3
  );
  return {
    label: rowLayout.items.map((item) => item.label).join(' · '),
    droppedIds: rowLayout.droppedIds,
    requiredDroppedIds: rowLayout.requiredDroppedIds,
    occupiedWidth: rowLayout.occupiedWidth,
  };
}

/**
 * The deterministic diff column: the CHECKPOINT owning the cursor's hunk, rendered
 * as its file cards — every parent hunk of every file it touched.
 *
 * The unit of review is the checkpoint. Resolving ONE hunk instead, by scanning a
 * flat list across every file and checkpoint on the branch, lets `j`/`k` cross
 * checkpoint boundaries silently and never shows the reviewer what else lives in
 * the file they are reading.
 */
export function FloorDiff({
  floor,
  reviewDiff,
  theme,
  hunkKey,
  sliceKey,
  width,
  height,
  diffGrain,
  diffRowCursor,
  diffSelectionAnchor,
  scrollRef,
  readerPage,
  pageNumber,
  pageCount,
  comments,
  semanticAnnotation,
  scrollTop,
  viewportHeight,
  viewportRevision,
  tightViewportWindow,
  overscanRows,
  pageKey,
  preserveSourceViewport,
  sourceAnchor,
  preferredSourceAnchorKey,
  pendingSourceDelta,
  onWheel,
  onHorizontalWheel,
  expandedForeignHunks,
  onToggleForeign,
  onMeasured,
  diffLayout = 'auto',
  codeHorizontalOffset = 0,
  showOwnerLabels,
  showLineNumbers,
  wrapLines,
  showHunkHeaders,
  onRowMouseDown,
  onRowMouseDrag,
  onDragEdge,
  patchIndex,
  patchEnrichmentRevision,
  pinnedFile,
  onSelectFile,
  onSelectComment,
  onScrollSurface,
}: {
  floor: Floor;
  reviewDiff: string;
  theme: AppTheme;
  hunkKey: string;
  sliceKey: string | null;
  width: number;
  height: number;
  diffGrain: 'hunk' | 'row';
  diffRowCursor: number;
  diffSelectionAnchor: number | null;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  /** The reader's current page — the pager's answer to "which checkpoint". */
  readerPage?: ReaderPage | ReaderAuxiliaryPage | null;
  pageNumber?: number;
  pageCount?: number;
  comments?: readonly EnrichedComment[];
  semanticAnnotation?: SemanticDiffAnnotation | null;
  scrollTop?: number;
  viewportHeight?: number;
  viewportRevision?: number;
  tightViewportWindow?: boolean;
  overscanRows?: number;
  pageKey?: string | null;
  preserveSourceViewport?: boolean;
  sourceAnchor?: DiffScrollAnchor | null;
  preferredSourceAnchorKey?: string | null;
  pendingSourceDelta?: number;
  onWheel?: (delta: number) => void;
  onHorizontalWheel?: (delta: number) => void;
  expandedForeignHunks?: ReadonlySet<string>;
  onToggleForeign?: (hunkKey: string) => void;
  onMeasured?: (layout: CheckpointLayout) => void;
  diffLayout?: 'split' | 'stack' | 'auto';
  codeHorizontalOffset?: number;
  showOwnerLabels?: boolean;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
  showHunkHeaders?: boolean;
  onRowMouseDown?: (pick: RowLine | null) => void;
  onRowMouseDrag?: (pick: RowLine | null) => void;
  onDragEdge?: (direction: DiffDragEdgeDirection | null) => void;
  /** Shared with the contextual rail when the shell already built one. */
  patchIndex?: PatchIndex;
  patchEnrichmentRevision?: number;
  /** File owning the viewport top; presentation only, never the semantic cursor. */
  pinnedFile?: string | null;
  onSelectFile?: (file: string) => void;
  onSelectComment?: (commentId: string) => void;
  onScrollSurface?: (surface: ScrollBoxRenderable | null) => void;
}) {
  const cockpit = useCockpitTheme();
  const gaps = useGapExpansion();
  // `source` is what attaches each DiffFile's tree-source fetcher. Passing the
  // diff alone leaves `sourceFetcher` undefined, so gap expansion has nothing to
  // expand FROM, so `z` is inert — with no missing key binding to explain it.
  const patch = useMemo(
    () => patchIndex ?? buildPatchIndex(reviewDiff, gaps.source),
    [patchIndex, reviewDiff, gaps.source]
  );
  // The page comes from the READER, not from the cursor's hunk:
  // `checkpointKeyForHunk` answers "the
  // FIRST checkpoint owning a slice of this hunk", so on a hunk two checkpoints
  // share it can only ever name one of them — and paging into the other would
  // derive straight back out. The prop is the pager's answer; the derivation stays
  // as the entry fallback for routes that arrive holding only a hunk.
  const checkpointKey = useMemo(
    () =>
      readerPage?.kind === 'checkpoint'
        ? readerPage.key
        : readerPage === undefined || readerPage === null
          ? checkpointKeyForHunk(floor, hunkKey)
          : null,
    [readerPage, floor, hunkKey]
  );
  const page = useMemo(
    () =>
      readerPage?.projection.layout ??
      (checkpointKey === null ? null : projectCheckpointPage({ floor, checkpointKey })),
    [readerPage, floor, checkpointKey]
  );
  const pins = useMemo(
    () =>
      page === null
        ? []
        : [
            ...buildDiffPins({ page, comments: comments ?? [] }),
            ...(semanticAnnotation === null || semanticAnnotation === undefined
              ? []
              : [semanticAnnotation]),
          ],
    [page, comments, semanticAnnotation]
  );
  const unplaceable = useMemo(
    () => headerPins(pins).filter((pin) => pin.kind === 'comment'),
    [pins]
  );
  const offPagePinRows = Math.min(
    unplaceable.length,
    // Preserve the one-row price while the diff can still retain a
    // six-row viewport. Only short terminals turn the pin family into a bounded
    // scroll region; ordinary-height geometry and its viewport anchors stay put.
    Math.max(1, Math.max(1, height) - 8)
  );

  if (page === null) {
    return (
      <scrollbox ref={scrollRef} scrollY={true} focused={false} flexGrow={1} padding={1}>
        <ErrorState
          id="review-unowned-hunk"
          variant="screen"
          title="Checkpoint projection unavailable"
          message="The selected hunk belongs to no checkpoint in the deterministic floor."
          detail="Return to the Brief and choose another captured destination."
        />
      </scrollbox>
    );
  }

  const item = floor.coverage.items.find((candidate) => candidate.hunkKey === hunkKey);
  // The rows THIS PAGE owns, not every changed row in the parent hunk. On a hunk two
  // checkpoints share, the unfiltered list starts the cursor on the other checkpoint's
  // line — so `ROW 1/2` names somebody else's code and `c` anchors it.
  const changedRows =
    readerPage !== undefined && readerPage !== null
      ? rowsOfProjectedHunk(readerPage.projection, hunkKey)
      : checkpointKey === null
        ? item === undefined
          ? []
          : changedRowsForFloorHunk(item)
        : rowsOfProjectedHunk(
            { layout: projectCheckpointPage({ floor, checkpointKey }), sliceStops: [] },
            hunkKey
          );
  // Slice stops are page-local and remain distinct even when several share one
  // parent hunk. The header names the navigation model the reviewer is using.
  const pageStops = readerPage?.sliceStops ?? [];
  const at = pageStops.findIndex((stop) => stop.sliceKey === sliceKey);
  const pageLabel =
    pageNumber !== undefined && pageCount !== undefined ? ` ${pageNumber}/${pageCount}` : '';
  const pageContext =
    readerPage?.kind === 'unassigned'
      ? 'Unassigned'
      : readerPage?.kind === 'part'
        ? `Part${pageLabel} · ${readerPage.label}`
        : `Checkpoint${pageLabel} · ${readerPage?.label ?? 'Captured checkpoint'}`;
  const sliceContext = `Slice ${Math.max(0, at) + 1}/${pageStops.length}`;
  const rowContext =
    diffGrain === 'row'
      ? `Row ${Math.min(diffRowCursor + 1, Math.max(1, changedRows.length))}/${changedRows.length}`
      : null;
  const cursorFile = item?.file ?? 'No file';
  const cursorPrefix = pinnedFile !== null && pinnedFile !== cursorFile ? 'Cursor · ' : '';
  const fileContext = `${cursorPrefix}${compactDiffPath(
    cursorFile,
    Math.max(12, Math.floor(width * 0.3) - cursorPrefix.length)
  )}`;
  const header = selectReaderHeaderLayout({
    width,
    page: pageContext,
    slice: sliceContext,
    file: fileContext,
    row: rowContext,
  }).label;
  const pinnedGroup =
    page.files.find((group) => group.file === pinnedFile) ?? page.files[0] ?? null;
  const bindScrollRef = useCallback(
    (surface: ScrollBoxRenderable | null): void => {
      if (scrollRef !== undefined) scrollRef.current = surface;
      onScrollSurface?.(surface);
    },
    [onScrollSurface, scrollRef]
  );
  const publishDragEdge = useCallback(
    (pointerY: number | null): void => {
      if (pointerY === null) {
        onDragEdge?.(null);
        return;
      }
      const surface = scrollRef?.current ?? null;
      if (surface === null) return;
      onDragEdge?.(
        diffDragEdgeDirection({
          pointerY,
          viewportTop: surface.y,
          viewportHeight: surface.viewport.height,
        })
      );
    },
    [onDragEdge, scrollRef]
  );

  return (
    <box flexDirection="column" flexGrow={1}>
      {/*
        The header sits OUTSIDE the scrollbox so the scrolled content is exactly
        what `buildCheckpointLayout` measured — a header inside it would offset
        every row by one and land scroll-to-cursor on the wrong line.

        The slice header is outside the scroll document for the same reason: it is
        navigation state, not rendering context priced by the diff geometry.
      */}
      <box
        id="review-reader-header"
        width={width}
        height={1}
        flexShrink={0}
        paddingLeft={1}
        backgroundColor={cockpit.PANEL_BG}
      >
        <text fg={cockpit.FG}>{header}</text>
      </box>
      {pinnedGroup !== null ? (
        <box
          id="review-pinned-file-header"
          width={width}
          height={1}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={cockpit.PANEL_BG}
        >
          <CheckpointFileHeaderRow
            group={pinnedGroup}
            patch={patch}
            width={Math.max(24, width - 2)}
            pinned
            onActivate={() => onSelectFile?.(pinnedGroup.file)}
          />
        </box>
      ) : null}
      {/*
        Comments this page cannot place in a card — the ladder fell to `unanchored`,
        or they re-anchored into a file this checkpoint never touched. They render
        HERE rather than nowhere: a comment the reviewer cannot see is one they
        conclude was never filed, and the agent's reply then lands on code nobody
        is looking at. Outside the scrollbox, so they cost the measured stream
        nothing.

        `flexShrink={0}` is load-bearing. The scrollbox below grows, and without
        this the flex parent squeezes these rows to nothing and paints them ON TOP
        of the header — the comment is technically rendered and completely unreadable.
      */}
      {unplaceable.length > 0 ? (
        <scrollbox
          id="review-off-page-pins"
          scrollY={true}
          focused={false}
          height={offPagePinRows}
          flexShrink={0}
        >
          {unplaceable.map((pin) => (
            <OffPageCommentPin
              key={pin.commentId}
              pin={pin}
              width={Math.max(24, width - 2)}
              onActivate={onSelectComment}
            />
          ))}
        </scrollbox>
      ) : null}
      <scrollbox
        id="review-diff-scroll"
        ref={bindScrollRef}
        scrollY={true}
        focused={false}
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
        onMouseUp={() => onDragEdge?.(null)}
        onMouseDragEnd={() => onDragEdge?.(null)}
      >
        {/*
          The wheel is intercepted here and routed to the app's scroll coordinator.
          A ScrollBox self-scrolls on wheel REGARDLESS of focus, and a scroll React
          never hears about would leave the mount window stale — the reader wheels
          down and finds blank spacers where their code should be. The app is the
          single writer of scrollTop; this is what keeps that true.
        */}
        <box
          flexDirection="column"
          onMouseScroll={
            onWheel !== undefined || onHorizontalWheel !== undefined
              ? wheelToApp({ onWheel, onHorizontalWheel, scrollRef })
              : undefined
          }
        >
          <CheckpointDiff
            page={page}
            patch={patch}
            patchEnrichmentRevision={patchEnrichmentRevision}
            theme={theme}
            width={Math.max(24, width - 2)}
            layout={resolveReviewDiffLayout(width, diffLayout)}
            cursorSliceKey={sliceKey}
            cursorHunkKey={hunkKey}
            pins={pins}
            scrollTop={scrollTop ?? 0}
            viewportHeight={viewportHeight ?? 0}
            viewportRevision={viewportRevision}
            tightViewportWindow={tightViewportWindow}
            overscanRows={overscanRows}
            pageKey={pageKey}
            preserveSourceViewport={preserveSourceViewport}
            sourceAnchor={sourceAnchor}
            preferredSourceAnchorKey={preferredSourceAnchorKey}
            pendingSourceDelta={pendingSourceDelta}
            selectedRows={
              diffGrain === 'row'
                ? selectedRowsForCursor(changedRows, diffRowCursor, diffSelectionAnchor)
                : undefined
            }
            expandedForeignHunks={expandedForeignHunks}
            onToggleForeign={onToggleForeign}
            showLineNumbers={showLineNumbers}
            wrapLines={wrapLines}
            showHunkHeaders={showHunkHeaders}
            onRowMouseDown={onRowMouseDown}
            onRowMouseDrag={onRowMouseDrag}
            onRowMouseDragEdge={publishDragEdge}
            onMeasured={onMeasured}
            showOwnerLabels={showOwnerLabels}
            codeHorizontalOffset={codeHorizontalOffset}
            pinnedFileHeader
            onSelectFile={onSelectFile}
            onSelectComment={onSelectComment}
          />
        </box>
      </scrollbox>
    </box>
  );
}

// ReaderWalk publishes measured file ownership after the diff layout commits.
// Most publications keep the same pinned file; avoid reconciling the complete
// diff subtree a second time when every render input is unchanged. Context and
// hook state still pierce React.memo normally.
const MemoFloorDiff = memo(FloorDiff);

/**
 * Route a wheel event into the app-owned scroll store and stop it before the
 * ScrollBox self-scrolls. The ScrollBox handles wheel regardless of focus, so
 * interception — not `focused={false}` — is what makes the app the single writer.
 */
export interface ReviewDiffWheelIntent {
  readonly axis: 'vertical' | 'horizontal';
  readonly delta: number;
}

/** Classify terminal wheel input before OpenTUI remaps Shift+wheel internally. */
export function reviewDiffWheelIntent(input: {
  readonly direction: 'up' | 'down' | 'left' | 'right';
  readonly delta: number;
  readonly shift: boolean;
}): ReviewDiffWheelIntent | null {
  const magnitude = Math.abs(input.delta);
  if (magnitude === 0) return null;
  if (input.direction === 'left' || (input.shift && input.direction === 'up')) {
    return { axis: 'horizontal', delta: -magnitude };
  }
  if (input.direction === 'right' || (input.shift && input.direction === 'down')) {
    return { axis: 'horizontal', delta: magnitude };
  }
  return {
    axis: 'vertical',
    delta: input.direction === 'up' ? -magnitude : magnitude,
  };
}

function wheelToApp({
  onWheel,
  onHorizontalWheel,
  scrollRef,
}: {
  onWheel?: (delta: number) => void;
  onHorizontalWheel?: (delta: number) => void;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
}) {
  return (event: MouseEvent): void => {
    const scroll = event.scroll;
    if (scroll === undefined) return;
    const intent = reviewDiffWheelIntent({
      direction: scroll.direction,
      delta: scroll.delta,
      shift: event.modifiers.shift,
    });
    if (intent === null) return;
    event.stopPropagation();
    if (intent.axis === 'vertical') {
      onWheel?.(intent.delta);
      return;
    }

    const surface = scrollRef?.current ?? null;
    const preservedScrollTop = surface?.scrollTop ?? 0;
    const preservedScrollLeft = surface?.scrollLeft ?? 0;
    onHorizontalWheel?.(intent.delta);

    // OpenTUI remaps shifted vertical wheel directions to horizontal, and shifted
    // native horizontal directions back to vertical, after the React callback.
    // It does not honor preventDefault for that native ScrollBox step. Neutralize
    // the shared event payload, then restore both axes and fractional acceleration
    // on the next microtask so horizontal code panning can never move the reader.
    scroll.delta = 0;
    queueMicrotask(() => {
      const current = scrollRef?.current;
      if (current === null || current === undefined) return;
      current.scrollTo({ x: preservedScrollLeft, y: preservedScrollTop });
      current.scrollAcceleration.reset();
      (current as unknown as { resetScrollAccumulators?: () => void }).resetScrollAccumulators?.();
    });
    event.preventDefault();
  };
}

/**
 * Reviewer context first, navigation second. The rail is page-shaped: a captured
 * checkpoint shows its close outcome and open questions; a synthesized Part shows
 * its frame, guide, and canonical items; Unassigned explains the absence of an
 * owner. All three end in the same compact file navigator.
 */
function ContextualReviewRail({
  floor,
  page,
  patch,
  cursorFile,
  viewportFile,
  fileNavigatorExpanded,
  fileFilter,
  width,
  height,
  scrollRef,
  focus,
  uncertaintyStates = new Map(),
  contextItemCursor = 0,
  activeItem = 0,
  onActivateItem,
  onMarkReviewed,
  onSelectFile,
  onToggleFileNavigator,
  onSelectContextItem,
}: {
  floor: Floor;
  page: ReaderPage | ReaderAuxiliaryPage;
  patch: PatchIndex;
  cursorFile: string | null;
  viewportFile: string | null;
  fileNavigatorExpanded: boolean;
  fileFilter: string | null;
  width: number;
  height: number;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  focus?: StoryReviewFocus;
  uncertaintyStates?: ReadonlyMap<string, UncertaintyState>;
  contextItemCursor?: number;
  activeItem?: number;
  onActivateItem?: (index: number) => void;
  onMarkReviewed?: () => void;
  onSelectFile?: (file: string) => void;
  onToggleFileNavigator?: () => void;
  onSelectContextItem?: (index: number) => void;
}) {
  const { AMBER, BRIGHT, DIM, FG, FOCUS_BG, PANEL_BG, ACCENT } = useCockpitTheme();
  const trail = useMemo(
    () => (page.kind === 'checkpoint' ? capturedTrailForCheckpoint(floor, page.member) : null),
    [floor, page]
  );
  const uncertainties =
    trail?.records.filter((record) => record.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY) ?? [];
  const openQuestionCount = uncertainties.filter(
    (record) =>
      (uncertaintyStates.get(record.id) ?? UNCERTAINTY_STATE.OPEN) === UNCERTAINTY_STATE.OPEN
  ).length;
  const concerns = automatedConcerns(trail?.records ?? []);
  const decisions =
    trail?.records.filter((record) => record.kind === CITATION_KIND.CHECKPOINT_DECISION) ?? [];
  const ruledOut =
    trail?.records.filter((record) => record.kind === CITATION_KIND.CHECKPOINT_ALTERNATIVE) ?? [];
  const selectedPartItem =
    page.kind === 'part' ? (page.railItems[activeItem] ?? page.railItems[0] ?? null) : null;
  const railFocused = focus === 'rail';
  const inner = Math.max(12, width - 4);
  const navigatorFiles = useMemo(
    () =>
      filterNavigatorFiles(
        page.projection.layout.files,
        fileFilter,
        (file) => patch.fileDiff(file)?.metadata.prevName ?? null
      ),
    [fileFilter, page.projection.layout.files, patch]
  );
  const navigatorContentRows = useMemo(
    () => buildFileNavigatorEntries(navigatorFiles).length,
    [navigatorFiles]
  );
  const followedItem =
    page.kind === 'checkpoint' ? contextItemCursor : page.kind === 'part' ? activeItem : null;
  const railPageKey =
    page.kind === 'checkpoint' ? `${page.member.artifact}:cp${page.member.cp}` : page.key;

  useEffect(() => {
    if (followedItem === null) return;
    // Follow committed geometry rather than estimating wrapped text heights.
    scrollRef?.current?.scrollChildIntoView(contextRailItemId(followedItem));
  }, [followedItem, railPageKey, scrollRef]);

  const navigatorHeight =
    height < 10
      ? 3
      : height < 12
        ? fileNavigatorExpanded
          ? 5
          : 1
        : fileNavigatorExpanded
          ? Math.min(11, Math.max(5, Math.min(Math.floor(height * 0.28), navigatorContentRows + 3)))
          : 3;

  return (
    <box flexDirection="column" width={width} height={height}>
      <box id="review-context-panel" flexDirection="column" flexGrow={1} backgroundColor={PANEL_BG}>
        <Section
          id="review-context-heading"
          variant="cap"
          title={`REVIEW CONTEXT · ${page.kind.toUpperCase()}`}
          right={railFocused ? 'j/k' : undefined}
          focused={railFocused}
        />
        <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
          <Rule width={Math.max(0, width - 2)} />
        </box>
        <scrollbox
          id="review-context-rail"
          ref={scrollRef}
          scrollY={true}
          focused={false}
          flexGrow={1}
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={PANEL_BG}
        >
          {page.kind === 'checkpoint' ? (
            <>
              <text fg={DIM}>
                cp{page.member.cp} · {page.label}
              </text>
              <box
                id="review-captured-summary"
                width={readableProseWidth(width, 4)}
                flexDirection="column"
                paddingTop={1}
              >
                <text fg={ACCENT}>OUTCOME</text>
                <text fg={FG}>{trail?.summary ?? page.label}</text>
              </box>
              {uncertainties.length > 0 ? (
                <box flexDirection="column" paddingTop={1}>
                  <text fg={AMBER}>CAPTURED QUESTIONS · {openQuestionCount} OPEN</text>
                  {uncertainties.map((record, index) => {
                    const state = uncertaintyStates.get(record.id) ?? UNCERTAINTY_STATE.OPEN;
                    const selected = railFocused && index === contextItemCursor;
                    return (
                      <ReviewHitRow
                        key={record.id}
                        id={contextRailItemId(index)}
                        selectedBackground={selected ? FOCUS_BG : undefined}
                        onSelect={
                          onSelectContextItem === undefined
                            ? undefined
                            : () => onSelectContextItem(index)
                        }
                      >
                        <text fg={selected ? BRIGHT : state === UNCERTAINTY_STATE.OPEN ? FG : DIM}>
                          {selected ? '❯' : ' '} ⚑ {state} {record.text}
                        </text>
                      </ReviewHitRow>
                    );
                  })}
                </box>
              ) : null}
              {concerns.length > 0 ? (
                <box flexDirection="column" paddingTop={1}>
                  <text fg={AMBER}>AUTOMATED CONCERNS</text>
                  {concerns.map((concern) => (
                    <box key={concern.id} flexDirection="column">
                      <text fg={AMBER}>
                        {SYMBOL.warning} {concern.evaluatorRef} ·{' '}
                        {concern.status === 'error'
                          ? 'ERROR'
                          : (concern.severity ?? 'VIOLATION').toUpperCase()}
                      </text>
                      {concern.text.length > 0 ? <text fg={FG}>{concern.text}</text> : null}
                    </box>
                  ))}
                </box>
              ) : null}
              {decisions.length > 0 ? (
                <box flexDirection="column" paddingTop={1}>
                  <text fg={ACCENT}>DECISION{decisions.length === 1 ? '' : 'S'}</text>
                  {decisions.map((record) =>
                    record.text.split('\n').map((line, index) => (
                      <text key={`${record.id}:${index}`} fg={index === 0 ? FG : DIM}>
                        {index === 0 ? '◆ ' : ''}
                        {line}
                      </text>
                    ))
                  )}
                </box>
              ) : null}
              {ruledOut.length > 0 ? (
                <box flexDirection="column" paddingTop={1}>
                  <text fg={DIM}>RULED OUT</text>
                  {ruledOut.map((record) => (
                    <text key={record.id} fg={DIM}>
                      {record.text}
                    </text>
                  ))}
                </box>
              ) : null}
            </>
          ) : page.kind === 'part' ? (
            <>
              {page.actTitle !== null ? <text fg={DIM}>{page.actTitle}</text> : null}
              <box flexDirection="column" paddingTop={1}>
                <text fg={ACCENT}>OUTCOME</text>
                <text fg={FG}>{page.part.interpretation}</text>
                {page.part.contextOnly ? (
                  <text fg={DIM}>Context-only · no changed rows are owned by this Part</text>
                ) : null}
                {/*
                  Per-Part stale health, beside the context-only line it mirrors.
                  The Brief carries one aggregate count for the whole projection;
                  it cannot say which Part in front of you lost its code. Amber
                  for narrative-only because NOTHING here will navigate, dim for
                  partial because the survivors still do.
                */}
                {page.projectionHealth === 'narrative-only' ? (
                  <text id="review-part-projection-health" fg={AMBER}>
                    Code mappings unavailable · narrative preserved
                  </text>
                ) : page.projectionHealth === 'partial' ? (
                  <text id="review-part-projection-health" fg={DIM}>
                    Some code mappings unavailable · surviving links navigate
                  </text>
                ) : null}
              </box>
              {page.railItems.length > 0 ? (
                <box flexDirection="column" paddingTop={1}>
                  <text fg={ACCENT}>CONTEXT</text>
                  {page.railItems.map((item, index) => (
                    <ReviewHitRow
                      key={`${item.id}:${index}`}
                      id={contextRailItemId(index)}
                      paddingLeft={1}
                      selectedBackground={index === activeItem ? FOCUS_BG : undefined}
                      onSelect={
                        onActivateItem === undefined ? undefined : () => onActivateItem(index)
                      }
                    >
                      <text fg={index === activeItem ? BRIGHT : FG}>
                        {index === activeItem ? '❯' : ' '} {item.state} ·{' '}
                        {truncate(item.shortText, Math.max(12, inner - 8))}
                      </text>
                      <text fg={DIM}>
                        {'  '}
                        {item.source} · {item.placementState ?? 'part-context'}
                        {(item.targetCount ?? 0) > 0
                          ? ` · ${item.targetCount} target(s) / ${item.locationCount ?? 0} location(s)`
                          : ''}
                      </text>
                    </ReviewHitRow>
                  ))}
                </box>
              ) : null}
              {selectedPartItem !== null ? (
                <box flexDirection="column" paddingTop={1}>
                  <text fg={DIM}>
                    {selectedPartItem.context ?? selectedPartItem.source} · {selectedPartItem.kind}
                  </text>
                </box>
              ) : null}
            </>
          ) : (
            <>
              <text fg={FG}>
                {page.kind === 'story-residue'
                  ? 'Evidence not owned by one Story Part.'
                  : 'No checkpoint owns these rows.'}
              </text>
              <text fg={DIM}>
                {page.inspectionRows.length} unowned changed row(s) ·{' '}
                {page.ambiguousHunkKeys.length} ambiguous hunk(s)
              </text>
              {page.kind === 'story-residue' && page.railItems.length > 0 ? (
                <box flexDirection="column" paddingTop={1}>
                  <text fg={ACCENT}>ATTACHED LEDGER</text>
                  {page.railItems.map((item) => (
                    <box key={item.id} flexDirection="column">
                      <text fg={FG}>
                        {item.state} · {truncate(item.shortText, Math.max(12, inner - 4))}
                      </text>
                      <text fg={DIM}>{item.source}</text>
                    </box>
                  ))}
                </box>
              ) : null}
            </>
          )}

          {page.kind === 'checkpoint' ? (
            <text fg={DIM}>
              {page.rowCount} owned row(s) · {page.projection.layout.files.length} file(s)
            </text>
          ) : page.kind === 'part' ? (
            <ReviewHitRow
              id="review-mark-reviewed"
              onSelect={page.markReviewedEnabled ? onMarkReviewed : undefined}
            >
              <text fg={page.complete ? FG : AMBER}>
                {stateGlyph(page.complete)} {page.rowCount} changed row(s)
              </text>
            </ReviewHitRow>
          ) : null}
        </scrollbox>
      </box>
      <ReviewFileNavigator
        files={page.projection.layout.files}
        patch={patch}
        width={width}
        height={navigatorHeight}
        expanded={fileNavigatorExpanded}
        filter={fileFilter}
        cursorFile={cursorFile}
        viewportFile={viewportFile}
        onToggleExpanded={onToggleFileNavigator}
        onSelectFile={onSelectFile}
      />
    </box>
  );
}

// The measurement-only ReaderWalk pass above also leaves rail inputs unchanged
// unless the pinned/viewport file actually crosses a boundary.
const MemoContextualReviewRail = memo(ContextualReviewRail);

function ReaderWalk({
  floor,
  reviewDiff,
  patchIndex,
  patchEnrichmentRevision,
  theme,
  hunkKey,
  sliceKey,
  width,
  height,
  diffGrain,
  diffRowCursor,
  diffSelectionAnchor,
  scrollRef,
  capturedTrailScrollRef,
  readerPage,
  pageNumber,
  pageCount,
  comments,
  semanticAnnotation,
  scrollTop,
  viewportHeight,
  viewportRevision,
  tightViewportWindow,
  visibleViewportHeight,
  overscanRows,
  preserveSourceViewport,
  sourceAnchor,
  preferredSourceAnchorKey,
  pendingSourceDelta,
  onWheel,
  onHorizontalWheel,
  expandedForeignHunks,
  onToggleForeign,
  showLineNumbers,
  wrapLines,
  showHunkHeaders,
  diffLayout,
  showOwnerLabels,
  codeHorizontalOffset,
  focus,
  onRowMouseDown,
  onRowMouseDrag,
  onDragEdge,
  onMeasured,
  uncertaintyStates,
  activeItem,
  onActivateItem,
  onMarkReviewed,
  onSelectFile,
  onSelectComment,
  fileNavigatorExpanded,
  fileFilter,
  onToggleFileNavigator,
  onScrollSurface,
  contextItemCursor,
  onSelectContextItem,
}: {
  floor: Floor;
  reviewDiff: string;
  patchIndex?: PatchIndex;
  patchEnrichmentRevision?: number;
  theme: AppTheme;
  hunkKey: string | null;
  sliceKey: string | null;
  width: number;
  height: number;
  focus?: StoryReviewFocus;
  diffGrain: 'hunk' | 'row';
  diffRowCursor: number;
  diffSelectionAnchor: number | null;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  capturedTrailScrollRef?: RefObject<ScrollBoxRenderable | null>;
  readerPage: ReaderPage | ReaderAuxiliaryPage;
  pageNumber?: number;
  pageCount?: number;
  comments?: readonly EnrichedComment[];
  semanticAnnotation?: SemanticDiffAnnotation | null;
  scrollTop?: number;
  viewportHeight?: number;
  viewportRevision?: number;
  tightViewportWindow?: boolean;
  visibleViewportHeight?: number;
  overscanRows?: number;
  preserveSourceViewport?: boolean;
  sourceAnchor?: DiffScrollAnchor | null;
  preferredSourceAnchorKey?: string | null;
  pendingSourceDelta?: number;
  onWheel?: (delta: number) => void;
  onHorizontalWheel?: (delta: number) => void;
  expandedForeignHunks?: ReadonlySet<string>;
  onToggleForeign?: (hunkKey: string) => void;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
  showHunkHeaders?: boolean;
  diffLayout?: 'split' | 'stack' | 'auto';
  showOwnerLabels?: boolean;
  codeHorizontalOffset?: number;
  onRowMouseDown?: (pick: RowLine | null) => void;
  onRowMouseDrag?: (pick: RowLine | null) => void;
  onDragEdge?: (direction: DiffDragEdgeDirection | null) => void;
  onMeasured?: (layout: CheckpointLayout) => void;
  uncertaintyStates?: ReadonlyMap<string, UncertaintyState>;
  activeItem?: number;
  onActivateItem?: (index: number) => void;
  onMarkReviewed?: () => void;
  onSelectFile?: (file: string) => void;
  onSelectComment?: (commentId: string) => void;
  fileNavigatorExpanded?: boolean;
  fileFilter?: string | null;
  onToggleFileNavigator?: () => void;
  onScrollSurface?: (surface: ScrollBoxRenderable | null) => void;
  contextItemCursor?: number;
  onSelectContextItem?: (index: number) => void;
}) {
  const { FOCUS_MARKER } = useCockpitTheme();
  const gaps = useGapExpansion();
  const patch = useMemo(
    () => patchIndex ?? buildPatchIndex(reviewDiff, gaps.source),
    [patchIndex, reviewDiff, gaps.source]
  );
  const {
    split,
    railWidth,
    diffPaneWidth: diffWidth,
    railHeight,
    diffHeight,
  } = reviewReaderGeometry(width, height);
  const [measuredPage, setMeasuredPage] = useState<{
    readonly pageKey: string;
    readonly layout: CheckpointLayout;
  } | null>(null);
  const handleMeasured = useCallback(
    (layout: CheckpointLayout): void => {
      setMeasuredPage((current) =>
        current?.pageKey === readerPage.key && current.layout === layout
          ? current
          : { pageKey: readerPage.key, layout }
      );
      onMeasured?.(layout);
    },
    [onMeasured, readerPage.key]
  );
  const fileSections =
    measuredPage?.pageKey === readerPage.key ? measuredPage.layout.fileSections : [];
  const viewportTop = Math.max(0, scrollTop ?? 0);
  // The fixed file row hands off one row AFTER the next in-stream path reaches
  // the top: for that one frame both names are visible, exactly like a sticky
  // table heading being pushed away by its successor.
  const pinnedSection = findHeaderOwningFileSection(fileSections, Math.max(0, viewportTop - 1));
  const viewportSection = findFileSectionAtOffset(
    fileSections,
    viewportTop + Math.floor(Math.max(1, visibleViewportHeight ?? Math.max(1, diffHeight - 2)) / 2)
  );
  const cursorFile = readerPage.sliceStops.find((stop) => stop.sliceKey === sliceKey)?.file ?? null;
  const pinnedFile = pinnedSection?.fileId ?? cursorFile;
  const viewportFile = viewportSection?.fileId ?? pinnedFile;
  return (
    <box flexDirection={split ? 'row' : 'column'} flexGrow={1}>
      <MemoContextualReviewRail
        floor={floor}
        page={readerPage}
        patch={patch}
        cursorFile={cursorFile}
        viewportFile={viewportFile}
        fileNavigatorExpanded={fileNavigatorExpanded ?? true}
        fileFilter={fileFilter ?? null}
        focus={focus}
        width={railWidth}
        height={railHeight}
        scrollRef={capturedTrailScrollRef}
        uncertaintyStates={uncertaintyStates}
        activeItem={activeItem}
        onActivateItem={onActivateItem}
        onMarkReviewed={onMarkReviewed}
        onSelectFile={onSelectFile}
        onToggleFileNavigator={onToggleFileNavigator}
        contextItemCursor={contextItemCursor}
        onSelectContextItem={onSelectContextItem}
      />
      <box id="review-diff-pane" width={diffWidth} height={diffHeight} flexGrow={1}>
        {focus === 'diff' ? (
          <text
            id="review-diff-focus-marker"
            position="absolute"
            left={0}
            top={0}
            zIndex={2}
            fg={FOCUS_MARKER}
          >
            {UI_GLYPH.paneFocused}
          </text>
        ) : null}
        {hunkKey !== null ? (
          <MemoFloorDiff
            floor={floor}
            reviewDiff={reviewDiff}
            theme={theme}
            hunkKey={hunkKey}
            sliceKey={sliceKey}
            width={diffWidth}
            height={diffHeight}
            diffGrain={diffGrain}
            diffRowCursor={diffRowCursor}
            diffSelectionAnchor={diffSelectionAnchor}
            scrollRef={scrollRef}
            readerPage={readerPage}
            patchIndex={patch}
            patchEnrichmentRevision={patchEnrichmentRevision}
            pageNumber={pageNumber}
            pageCount={pageCount}
            comments={comments}
            semanticAnnotation={semanticAnnotation}
            scrollTop={scrollTop}
            viewportHeight={viewportHeight}
            viewportRevision={viewportRevision}
            tightViewportWindow={tightViewportWindow}
            overscanRows={overscanRows}
            pageKey={`${readerPage.kind}:${readerPage.key}`}
            preserveSourceViewport={preserveSourceViewport}
            sourceAnchor={sourceAnchor}
            preferredSourceAnchorKey={preferredSourceAnchorKey}
            pendingSourceDelta={pendingSourceDelta}
            onWheel={onWheel}
            onHorizontalWheel={onHorizontalWheel}
            expandedForeignHunks={expandedForeignHunks}
            onToggleForeign={onToggleForeign}
            showLineNumbers={showLineNumbers}
            wrapLines={wrapLines}
            showHunkHeaders={showHunkHeaders}
            diffLayout={diffLayout}
            showOwnerLabels={showOwnerLabels}
            codeHorizontalOffset={codeHorizontalOffset}
            onRowMouseDown={onRowMouseDown}
            onRowMouseDrag={onRowMouseDrag}
            onDragEdge={onDragEdge}
            onMeasured={handleMeasured}
            pinnedFile={pinnedFile}
            onSelectFile={onSelectFile}
            onSelectComment={onSelectComment}
            onScrollSurface={onScrollSurface}
          />
        ) : (
          <box
            id="review-diff-empty"
            flexGrow={1}
            border={true}
            borderColor={theme.border}
            padding={1}
          >
            <text fg={theme.muted}>
              This review page owns no changed code. Read its context in the left rail, then
              continue to another page.
            </text>
          </box>
        )}
      </box>
    </box>
  );
}

/**
 * The reader a screen falls back to when it has none — an empty floor, nothing
 * covered, nothing unexplained. It exists so the `model === null` last resort can
 * render SOMETHING rather than crash, and it is deliberately inert: it claims no
 * coverage and no unassigned work, so a screen that reaches it shows an empty
 * brief instead of confidently showing a wrong one.
 */
const EMPTY_READER: ReaderModel = {
  lens: 'deterministic',
  story: null,
  pages: [],
  routeIndex: {
    pageIndexByKey: new Map(),
    pageIndexesBySliceKey: new Map(),
    pageIndexesByHunkKey: new Map(),
    auxiliarySliceKeys: new Set(),
    auxiliaryHunkKeys: new Set(),
    briefRows: [
      {
        id: 'finish',
        kind: 'finish',
        label: 'Finish',
        level: 0,
        destination: { kind: 'finish' },
      },
    ],
    railItemsByPageKey: new Map(),
    attentionItems: [],
    capturedContextItems: [],
    itemById: new Map(),
    destinationsByItemId: new Map(),
    semanticPlacementsByItemId: new Map(),
    semanticPlacementById: new Map(),
  },
  coverage: { byThread: new Map(), pagesComplete: 0, pagesTotal: 0 },
  finish: { allowed: false, blockers: [] },
  unassigned: {
    gap: { currentRows: [], coveredRows: [], complete: true },
    ambiguous: [],
    total: 0,
    reviewed: 0,
    complete: true,
  },
  auxiliaryPage: {
    kind: 'unassigned',
    key: 'unassigned',
    label: 'Unassigned',
    projection: { layout: { files: [], findings: [] }, sliceStops: [] },
    sliceStops: [],
    inspectionRows: [],
    ambiguousHunkKeys: [],
    complete: true,
  },
};

/**
 * Finish, on WHICHEVER lens the reviewer is reading.
 *
 * It reads `reader.finish`, never an optional lens-specific experience model: a
 * model the floor path cannot supply loses the result of a floor-only review
 * before the reviewer can record it.
 *
 * It also says WHAT IS LEFT. '◐ Required review work remains' as the entire
 * vocabulary for an unfinishable review tells the reviewer they are blocked and
 * nothing about by what, so the only way forward is to go hunting. `reader.finish`
 * is the same gate the transport re-checks, and every blocker in it names an
 * obligation that can actually be discharged.
 */
export function ReviewFinish({
  reader,
  lifecycle,
  obligations,
  cursor,
  width,
  onSelect,
  scrollRef,
}: {
  reader: ReaderModel;
  lifecycle: ReviewLifecycleLedger;
  obligations: readonly FinishObligation[];
  cursor: number;
  width: number;
  onSelect?: (index: number) => void;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
}) {
  const { AMBER, DIM, FG, LIVE, PANEL_BG, ACCENT } = useCockpitTheme();
  const current = lifecycle.current;
  const gate = reader.finish;
  const basis = reader.lens === 'deterministic' ? 'the captured checkpoints' : 'the composed Story';
  const selectedCursor = Math.max(0, Math.min(cursor, Math.max(0, obligations.length - 1)));
  useEffect(() => {
    if (obligations.length === 0) return;
    scrollRef?.current?.scrollChildIntoView(`review-finish-obligation-${selectedCursor}`);
  }, [selectedCursor, obligations.length, scrollRef]);
  const proseWidth = readableProseWidth(width, 4);
  return (
    <scrollbox
      id="review-finish-scroll"
      ref={scrollRef}
      scrollY={true}
      focused={false}
      flexGrow={1}
      padding={2}
      backgroundColor={PANEL_BG}
    >
      <box id="review-finish-prose" width={proseWidth} flexDirection="column">
        <text fg={ACCENT}>REVIEW STATUS</text>
        <text fg={DIM}>
          {' '}
          Reading {basis} · {reader.coverage.pagesComplete}/{reader.coverage.pagesTotal} reviewed
        </text>
        {reader.lens === 'story' ? <StoryProgress reader={reader} /> : null}
        {lifecycle.state === 'OPEN' ? (
          <box flexDirection="column">
            <text fg={gate.allowed ? LIVE : AMBER}>
              {gate.allowed ? '✓ Ready to finish complete' : '◐ Required review work remains'}
            </text>
            {obligations.map((obligation, index) => (
              <ReviewHitRow
                key={obligation.key}
                id={`review-finish-obligation-${index}`}
                flexDirection="column"
                onSelect={onSelect === undefined ? undefined : () => onSelect(index)}
              >
                <text fg={index === selectedCursor ? AMBER : FG}>
                  {index === selectedCursor ? '❯' : ' '} {obligation.label}
                </text>
                <text fg={DIM}> {obligation.detail}</text>
              </ReviewHitRow>
            ))}
          </box>
        ) : (
          <>
            <text fg={lifecycle.stale ? AMBER : LIVE}>
              {lifecycle.stale ? SYMBOL.warning : '✓'} Durable {lifecycle.state.toLowerCase()} ·{' '}
              {current?.ts ?? 'unknown time'}
            </text>
            {current?.remainingWork ? (
              <text fg={FG}> Remaining · {current.remainingWork}</text>
            ) : null}
            {lifecycle.stale ? (
              <text fg={AMBER}> Generation changed; reopen before recording a new result.</text>
            ) : null}
          </>
        )}
        <text> </text>
        <text fg={ACCENT}>NEXT</text>
        {lifecycle.state === 'OPEN' && gate.allowed ? (
          <text fg={FG}> Enter · finish this review</text>
        ) : null}
        {lifecycle.state === 'OPEN' && !gate.allowed ? (
          <text fg={FG}> j/k choose · Enter open obligation · Esc return</text>
        ) : null}
        {lifecycle.state === 'OPEN' && !gate.allowed ? (
          <text fg={DIM}> p · finish as partial with a required note</text>
        ) : null}
        {lifecycle.state !== 'OPEN' ? <text fg={FG}> r · reopen review</text> : null}
      </box>
    </scrollbox>
  );
}

/**
 * Every retained hunk on the branch, filterable.
 *
 * A large branch puts hundreds of hunks across a hundred-plus files behind this
 * escape hatch, which exists precisely for "just show me everything" — so without
 * a filter it is an unsearchable wall. `/` narrows it; `filterFlatFiles` is
 * exported because the CURSOR must clamp to the same list the screen renders, or
 * the highlight walks off the bottom of what is rendered.
 */
export function filterFlatFiles(floor: Floor, filter: string | null) {
  if (filter === null || filter === '') return floor.coverage.items;
  const needle = filter.toLowerCase();
  return floor.coverage.items.filter((hunk) => hunk.file.toLowerCase().includes(needle));
}

export function FlatFiles({
  floor,
  reviewDiff,
  patchIndex,
  cursor,
  filter = null,
  onActivate,
}: {
  floor: Floor;
  reviewDiff: string;
  patchIndex?: PatchIndex;
  cursor: number;
  filter?: string | null;
  onActivate?: (index: number) => void;
}) {
  const { AMBER, DIM, FG, ACCENT } = useCockpitTheme();
  const hunks = filterFlatFiles(floor, filter);
  const patch = useMemo(() => patchIndex ?? buildPatchIndex(reviewDiff), [patchIndex, reviewDiff]);
  return (
    <scrollbox scrollY={true} focused={false} flexGrow={1} padding={1}>
      <text fg={ACCENT}>ALL FILES · deterministic floor</text>
      <text fg={DIM}>Flat escape hatch; Story grouping does not hide any retained hunk.</text>
      {filter !== null ? (
        <text fg={AMBER}>
          / {filter} · {hunks.length}/{floor.coverage.items.length} hunk(s)
        </text>
      ) : null}
      <text> </text>
      {hunks.map((hunk, index) => (
        <ReviewHitRow
          key={hunk.hunkKey}
          id={`review-flat-file-${index}`}
          onSelect={onActivate === undefined ? undefined : () => onActivate(index)}
        >
          <text fg={index === cursor ? AMBER : FG}>
            {index === cursor ? '❯' : ' '} {fileBadgeLetter(patch.fileChangeType(hunk.file))}{' '}
            {hunk.file} · +{hunk.added_lines} -{hunk.removed_lines} · {hunk.hunkKey}
          </text>
        </ReviewHitRow>
      ))}
      {hunks.length === 0 ? (
        <EmptyState
          id="review-flat-files-empty"
          variant="banner"
          title="No file matches this filter"
          message="Press / to clear or change the navigator filter; the full diff remains intact."
        />
      ) : null}
    </scrollbox>
  );
}

/**
 * Owned rows could not be derived, so nothing can be marked reviewed.
 *
 * Said out loud, on every screen. Swallowing the throw into `narrativeStatus`
 * — which the floor-only path does not even record — renders the review as
 * healthy while `m` does nothing at all, with no message, indefinitely.
 */
const COVERAGE_WARNING_TITLE = 'COVERAGE UNAVAILABLE · mark reviewed cannot record progress';
const COVERAGE_WARNING_MESSAGE =
  'The floor and diff.patch disagree, so owned rows are unknown. Re-run the review to rebuild the bundle.';

function CoverageUnavailable({ reason, width }: { reason: string; width: number }) {
  return (
    <WarningBanner
      id="review-coverage-unavailable"
      variant="banner"
      width={width}
      title={COVERAGE_WARNING_TITLE}
      message={COVERAGE_WARNING_MESSAGE}
      detail={reason}
    />
  );
}

/**
 * The ground the Brief's plane paints.
 *
 * The plane spans the whole viewport, so this IS the page ground the reviewer
 * sees — and it has to be the token the Watch root paints. `PANEL_BG` is the
 * PANEL colour (`theme.panel`), which sits about three times the relative
 * luminance of the page background at the bottom of a dark ramp, so painting it
 * full-screen makes the Brief read lighter than every other surface.
 *
 * It must also stay OPAQUE. The plane exists to stop the previous screen's
 * glyphs bleeding through on return, so a theme whose background is the literal
 * `'transparent'` falls back to the panel token rather than losing that cover.
 */
export function briefPlaneGround(theme: AppTheme | undefined, panelBg: string): string {
  const ground = theme?.background;
  return ground !== undefined && ground !== 'transparent' ? ground : panelBg;
}

function ReviewExperienceSurface(props: ReviewExperienceProps) {
  const { AMBER, DIM, PANEL_BG } = useCockpitTheme();
  const targetsStatus = props.targetsStatus;
  // Story-health banners belong to the Brief: every other screen either cannot
  // act on them or already announces staleness through the compact indicator
  // below, and tall banners would eat rows on checkpoint/part surfaces.
  const onBrief = props.screen === 'brief';
  const storyUnhealthy =
    onBrief &&
    props.storyStatus !== undefined &&
    props.storyStatus !== 'ok' &&
    props.storyStatus !== 'absent';
  const storyAnchorsUnhealthy =
    onBrief &&
    props.storyAnchorStatus !== undefined &&
    props.storyAnchorStatus !== 'ok' &&
    props.storyAnchorStatus !== 'absent';
  // While the reader is projecting a stale Story off-Brief, staleness must stay
  // visible without re-paying the full banner: one persistent row.
  const staleLensActive =
    !onBrief && props.reader?.lens === 'story' && props.storyStatus === 'stale';
  const warningWidth = Math.max(1, readableProseWidth(props.width, 2));
  const wrappedWarningRows = (copy: string): number =>
    Math.max(1, Math.ceil((displayLen(copy) + 2) / warningWidth));
  const coverageWarningRows =
    targetsStatus !== undefined && !targetsStatus.ok
      ? wrappedWarningRows(COVERAGE_WARNING_TITLE) +
        wrappedWarningRows(COVERAGE_WARNING_MESSAGE) +
        wrappedWarningRows(targetsStatus.reason)
      : 0;
  const storyWarningRows = storyUnhealthy
    ? wrappedWarningRows(`STORY ${props.storyStatus?.toUpperCase()}`) +
      wrappedWarningRows(
        props.storyIssue ?? 'Regenerate the routine Story before using the Story lens.'
      ) +
      (props.storyRunId === null || props.storyRunId === undefined
        ? 0
        : wrappedWarningRows(`Run ${props.storyRunId}`))
    : 0;
  const storyAnchorWarningRows = storyAnchorsUnhealthy
    ? wrappedWarningRows(`ANCHORED CONTEXT ${props.storyAnchorStatus?.toUpperCase()}`) +
      wrappedWarningRows(
        props.storyAnchorIssue ?? 'Regenerate semantic anchors for the current routine Story run.'
      )
    : 0;
  const staleLensRows = staleLensActive ? 1 : 0;
  const warningContentRows =
    coverageWarningRows + storyWarningRows + storyAnchorWarningRows + staleLensRows;
  const vertical = allocateReviewSurfaceHeight(props.height, warningContentRows);
  const shellPage =
    props.screen === 'unassigned' ? (props.reader?.auxiliaryPage ?? null) : props.readerPage;
  const shellHunkKey = props.selectedFloorHunkKey ?? null;
  let body;
  if (
    (props.screen === 'floor-diff' || props.screen === 'walk' || props.screen === 'unassigned') &&
    shellPage != null &&
    props.reviewDiff !== undefined &&
    props.theme !== undefined
  ) {
    body = (
      <ReaderWalk
        floor={props.floor}
        focus={props.focus}
        reviewDiff={props.reviewDiff}
        patchIndex={props.patchIndex}
        patchEnrichmentRevision={props.patchEnrichmentRevision}
        theme={props.theme}
        hunkKey={shellHunkKey}
        sliceKey={props.selectedFloorSliceKey ?? null}
        width={props.width}
        height={vertical.bodyRows + vertical.footerRows}
        diffGrain={props.diffGrain ?? 'hunk'}
        diffRowCursor={props.diffRowCursor ?? 0}
        diffSelectionAnchor={props.diffSelectionAnchor ?? null}
        scrollRef={props.walkScrollRef}
        capturedTrailScrollRef={props.capturedTrailScrollRef}
        readerPage={shellPage}
        pageNumber={props.screen === 'unassigned' ? undefined : props.pageNumber}
        pageCount={props.screen === 'unassigned' ? undefined : props.pageCount}
        comments={props.comments}
        semanticAnnotation={props.semanticAnnotation}
        scrollTop={props.diffScrollTop}
        viewportHeight={props.diffViewportHeight}
        viewportRevision={props.diffViewportRevision}
        tightViewportWindow={props.diffTightViewportWindow}
        visibleViewportHeight={props.diffVisibleViewportHeight}
        overscanRows={props.diffOverscanRows}
        preserveSourceViewport={props.preserveDiffSourceViewport}
        sourceAnchor={props.diffSourceAnchor}
        preferredSourceAnchorKey={props.preferredDiffSourceAnchorKey}
        pendingSourceDelta={props.pendingDiffSourceDelta}
        onWheel={props.onDiffWheel}
        onHorizontalWheel={props.onDiffHorizontalWheel}
        onDragEdge={props.onDiffDragEdge}
        expandedForeignHunks={props.expandedForeignHunks}
        onToggleForeign={props.onToggleForeign}
        showLineNumbers={props.showLineNumbers}
        wrapLines={props.wrapLines}
        showHunkHeaders={props.showHunkHeaders}
        diffLayout={props.diffLayout}
        showOwnerLabels={props.showOwnerLabels}
        codeHorizontalOffset={props.codeHorizontalOffset}
        onRowMouseDown={props.onRowMouseDown}
        onRowMouseDrag={props.onRowMouseDrag}
        onMeasured={props.onDiffMeasured}
        uncertaintyStates={props.uncertaintyStates}
        contextItemCursor={props.contextItemCursor}
        activeItem={props.activeItem}
        onActivateItem={props.onActivateRailItem}
        onMarkReviewed={() => props.onMarkReviewed?.(shellPage.key)}
        onSelectFile={props.onSelectDiffFile}
        onSelectComment={props.onActivateCommentPin}
        fileNavigatorExpanded={props.fileNavigatorExpanded}
        fileFilter={props.fileFilter ?? null}
        onToggleFileNavigator={props.onToggleFileNavigator}
        onScrollSurface={props.onDiffScrollSurface}
        onSelectContextItem={props.onSelectContextItem}
      />
    );
  } else if (props.screen === 'flat-files') {
    body = (
      <FlatFiles
        floor={props.floor}
        reviewDiff={props.reviewDiff ?? ''}
        patchIndex={props.patchIndex}
        cursor={props.flatFileCursor ?? 0}
        filter={props.fileFilter ?? null}
        onActivate={props.onActivateFlatFile}
      />
    );
  } else if (props.screen === 'comments') {
    // The comment sidecar stays available when Current Story is absent or
    // stale: reanchoring needs only floor + patch.
    body = (
      <CommentsIndex
        comments={[...(props.comments ?? [])]}
        openCount={(props.comments ?? []).filter((c) => c.status === 'open').length}
        cursor={props.commentCursor ?? 0}
        width={props.width}
        scrollRef={props.walkScrollRef ?? { current: null }}
        onActivate={props.onActivateComment}
      />
    );
  } else if (props.screen === 'captured-context' && props.reader != null) {
    body = (
      <CapturedContextDetail
        item={
          props.activeStoryItemId === null || props.activeStoryItemId === undefined
            ? null
            : (props.reader.routeIndex.itemById.get(props.activeStoryItemId) ?? null)
        }
        width={props.width}
      />
    );
  } else if (props.screen === 'finish' && props.reader != null && props.lifecycle !== undefined) {
    body = (
      <ReviewFinish
        reader={props.reader}
        lifecycle={props.lifecycle}
        obligations={props.finishObligations ?? []}
        cursor={props.finishCursor ?? 0}
        width={props.width}
        onSelect={props.onActivateFinishObligation}
        scrollRef={props.walkScrollRef}
      />
    );
  } else if (props.screen === 'brief') {
    // ONE Brief for both lenses. The lens comes off the reader itself: the
    // deterministic floor and the Story v4 model flow through the same panes,
    // and only what the lens can truthfully answer differs.
    const briefReader = props.reader ?? EMPTY_READER;
    body = (
      <Brief
        floor={props.floor}
        reader={briefReader}
        // The app builds this once per projection and passes it in; the fallback
        // is only for the empty reader, whose tree costs nothing.
        tree={props.briefTree ?? buildBriefTree(briefReader)}
        attention={props.briefAttention ?? []}
        briefCursor={props.briefCursor ?? 0}
        attentionCursor={props.attentionCursor ?? 0}
        attentionRowKey={props.attentionRowKey ?? null}
        focus={props.focus ?? BRIEF_TREE_FOCUS}
        width={props.width}
        height={vertical.bodyRows + vertical.footerRows}
        lifecycle={props.lifecycle}
        staleness={props.staleness}
        openComments={(props.comments ?? []).filter((comment) => comment.status === 'open').length}
        uncertaintyStates={props.uncertaintyStates}
        anchorStatus={briefReader.lens === 'story' ? props.storyAnchorStatus : undefined}
        onActivateDestination={props.onActivateBriefDestination}
        onActivateAttention={props.onActivateBriefAttention}
      />
    );
  } else {
    body = (
      <ErrorState
        id="review-projection-error"
        variant="screen"
        title="Review screen unavailable"
        message="The current reader projection does not support this destination."
        detail="Return to the Brief and choose another review destination."
      />
    );
  }
  const footerLayout = selectStoryReviewFooterLayout(
    props.screen,
    props.focus ?? 'rail',
    Math.max(0, props.width - 1),
    { atRoot: props.atReviewRoot ?? props.screen === 'brief' },
    props.reader?.lens ?? 'deterministic',
    props.reader?.lens === 'story' ? 'parts' : 'checkpoints',
    props.reader?.staleProjection === true
  );
  const footerHint = footerLayout.parts.join(' · ');
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      {vertical.warningRows === 0 ? null : (
        <scrollbox
          id="review-warning-scroll"
          scrollY={true}
          focused={false}
          height={vertical.warningRows}
          flexShrink={0}
          width={props.width}
        >
          <box id="review-warning-prose" width={warningWidth} flexDirection="column">
            {staleLensActive ? (
              <text id="review-stale-lens-indicator" fg={AMBER}>
                STALE STORY · read-only view — full warning on the Brief
              </text>
            ) : null}
            {targetsStatus !== undefined && !targetsStatus.ok ? (
              <CoverageUnavailable reason={targetsStatus.reason} width={warningWidth} />
            ) : null}
            {storyUnhealthy ? (
              <WarningBanner
                id="review-story-unhealthy"
                variant="banner"
                width={warningWidth}
                title={`STORY ${props.storyStatus?.toUpperCase()}`}
                message={
                  props.storyIssue ?? 'Regenerate the routine Story before using the Story lens.'
                }
                detail={
                  props.storyRunId === null || props.storyRunId === undefined
                    ? undefined
                    : `Run ${props.storyRunId}`
                }
              />
            ) : null}
            {storyAnchorsUnhealthy ? (
              <WarningBanner
                id="review-story-anchors-unhealthy"
                variant="banner"
                width={warningWidth}
                title={`ANCHORED CONTEXT ${props.storyAnchorStatus?.toUpperCase()}`}
                message="The Story remains readable; no stale or invalid code links are shown."
                detail={
                  props.storyAnchorIssue ??
                  'Regenerate semantic anchors for the current routine Story run.'
                }
              />
            ) : null}
          </box>
        </scrollbox>
      )}
      <box
        key={`review-screen-plane:${props.screen}:${props.reader?.lens ?? 'floor'}`}
        id="review-screen-plane"
        flexDirection="column"
        height={vertical.bodyRows}
        flexShrink={0}
        width="100%"
        backgroundColor={
          props.screen === 'brief' ? briefPlaneGround(props.theme, PANEL_BG) : undefined
        }
      >
        {body}
      </box>
      {vertical.footerRows === 0 ? null : (
        <box
          id="review-footer"
          width={props.width}
          height={1}
          flexShrink={0}
          paddingLeft={1}
          backgroundColor={PANEL_BG}
        >
          {props.notice ? (
            <Notice
              id="review-footer-notice"
              variant="inline"
              rows={1}
              width={Math.max(0, props.width - 1)}
              message={props.notice}
              suffix={footerHint}
            />
          ) : (
            <text fg={DIM}>{footerHint}</text>
          )}
        </box>
      )}
    </box>
  );
}

/** Keep passive cockpit heartbeats out of the already-mounted review surface. */
export const ReviewExperience = memo(ReviewExperienceSurface);
