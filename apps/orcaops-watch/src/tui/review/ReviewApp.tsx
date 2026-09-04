import type { ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard, useRenderer } from '@opentui/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type AppTheme,
  deferMountedDiffHighlightsForInteraction,
  type DiffFile,
  expansionSide,
  gapKey,
  openFileInEditor,
  trailingCollapsedLines,
} from '@orcaops/diff-render';
import {
  CITATION_KIND,
  type CommentAnchor,
  FINDING_DISPOSITION,
  type JournalEvent,
  PROMPT_DISPOSITION,
  REVIEW_BASIS,
  reviewedRowsDigest,
  type ReviewLedgerV2,
  type ReviewLifecycleLedger,
  THREAD_DISPOSITION,
  UNASSIGNED_INSPECTION_ACTION,
  UNCERTAINTY_DISPOSITION,
  UNCERTAINTY_STATE,
  uncertaintyState,
} from '@orcaops/review-core';
import { ReviewCacheBehindError } from '@orcaops/watch-data/ui';

import { CacheUpgradeDialog } from './CacheUpgradeDialog';
import { executableHelpEntries, type ExecutableHelpEntry, HelpDialog } from './HelpDialog';
import { InputModal } from './InputModal';
import { changedRowsForFloorHunk, filterFlatFiles, ReviewExperience } from './ReviewExperience';
import { buildBriefAttention, resolveBriefAttentionIntent } from './briefAttention';
import { buildBriefTree } from './briefTree';
import { type CheckpointLayout, unitLineRanges } from './checkpointLayout';
import { copyViaOsc52, formatSelectionText, type Osc52Renderer } from './clipboard';
import {
  type AnchorPick,
  buildRowCommentAnchor,
  listHunkChangedLines,
  listSliceChangedLines,
  pickAnchorFromLines,
  type RowAnchorResult,
} from './commentAnchor';
import { semanticPlacementAsAnnotation } from './diffPins';
import {
  captureDiffScrollAnchor,
  type DiffScrollAnchor,
  resolveDiffScrollAnchor,
} from './diffScrollAnchor';
import type { DiffDragEdgeDirection } from './dragEdge';
import { buildFinishObligations, type FinishObligation } from './finishPresentation';
import type { PatchGapHunk } from './gapExpansion';
import { GapExpansionProvider } from './gapExpansionContext';
import { applyFileGaps, type GapStores } from './gapSource';
import { GenerationProjectionCache } from './generationProjectionCache';
import {
  computeRapidScrollOverscanRows,
  RAPID_SCROLL_OVERSCAN_IDLE_MS,
  rapidScrollOverscanRowLimit,
} from './hunkMounting';
import { storyReviewHelpContext, storyReviewHelpSections } from './keymap';
import { LiveRefreshCoordinator } from './liveRefreshCoordinator';
import type { RowLine } from './mouseSelect';
import {
  collapseTargetAnchorRow,
  filterNavigatorFiles,
  type FloorDisplayHunk,
  halfPageStep,
  pageStep,
  planFileCollapseState,
  selectVisibleCollapseTarget,
  type VisibleCollapseTarget,
} from './navigation';
import {
  checkpointKeyForHunk,
  projectCheckpointPage,
  type ReaderSliceStop,
  rowsOfProjectedHunk,
} from './pageProjection';
import { splitPatchByFile } from './patchSplit';
import {
  buildDeterministicReader,
  buildStoryReader,
  type CheckpointPage,
  pageIndexForHunk,
  pageIndexForSlice,
  type ReaderAuxiliaryPage,
  type ReaderLens,
  type ReaderModel,
  type ReaderPage,
  type ReaderRouteIndex,
  sliceStopsOfPage,
} from './readerModel';
import {
  activateBriefAttentionItem,
  activateBriefDestination,
  activateReaderDestination,
  activateReaderRailItem,
  appendPageCoverageGuarded,
  BRIEF_OVERVIEW_FOCUS,
  captureReviewRoute,
  claimConsumedReviewKey,
  clampReviewCodeHorizontalOffset,
  dispatchFloorReviewKey,
  dispatchReaderReviewCommand,
  dispatchReaderReviewKey,
  dispatchReviewRouteBack,
  initialFocusForReviewScreen,
  initialReviewControllerState,
  panReviewCodeHorizontally,
  pushReviewRoute,
  resetReviewCodeHorizontalOffset,
  REVIEW_CODE_PAN_COLUMNS,
  type ReviewCommandInvocation,
  reviewCommandOwnerViolation,
  type ReviewControllerCommand,
  type ReviewControllerState,
  type ReviewDispatchResult,
  reviewIsAtRoot,
  type ReviewKeyLike,
  type ReviewRouteSnapshot,
  synchronizeRailToTarget,
  toggleReviewFileNavigator,
  unavailableEvidenceNotice,
} from './readerReviewController';
import {
  maxReviewCodeHorizontalOffsetFromMetrics,
  measureReviewDiffHorizontalContent,
  type ReviewDiffHorizontalFile,
  reviewReaderGeometry,
} from './reviewDiffHorizontal';
import { floorHunkForActivation } from './reviewFloorNavigation';
import {
  clampScroll,
  maxScroll,
  requiresScrollCommit,
  type ScrollBounds,
  scrollByRows,
  scrollToCenter,
  scrollToShow,
} from './scrollCoordinator';
import { buildPatchIndex } from './walkDiff';
import {
  addComment,
  type CommentsPayload,
  loadComments,
  reopenComment,
  replyComment,
  resolveComment,
} from '../../data/commentsSource';
import {
  appendJournalEvent,
  appendJournalEvents,
  type JournalAppendResult,
  type JournalSourceOptions,
  loadLedger,
} from '../../data/journalSource';
import {
  loadInstalledReview,
  loadReview,
  readReviewGenerations,
  type ReviewData,
  type ReviewGenerations,
} from '../../data/reviewSource';
import {
  computeFloorStaleness,
  readWorktreeProbe,
  type StalenessRow,
  type WorktreeProbe,
} from '../../data/staleness';
import { CockpitThemeContext, useCockpitTheme, useThemeControls } from '../ThemeProvider';
import { executableHelpInvocation, normalizeCommandGesture } from '../commandRegistry';
import { LoadingScreen } from '../components/LoadingScreen';
import { EmptyState, ErrorState } from '../kit';
import { createWheelScrollAcceleration } from '../scrollAcceleration';
import { bindScrollSurfacePolicy } from '../scrollSurfacePolicy';
import { selectShellHelpCommands, type ShellCommandId } from '../shellCommands';

/** One terminal frame: native drag/layout bursts publish one React viewport snapshot. */
const DIFF_VIEWPORT_READ_COALESCE_MS = 16;

export interface LoadedReview {
  data: ReviewData;
  ledger: ReviewLedgerV2;
  comments: CommentsPayload;
}

export interface ReviewJournalEffects {
  load: (opts: JournalSourceOptions) => Promise<ReviewLedgerV2>;
  append: (opts: JournalSourceOptions, event: JournalEvent) => Promise<JournalAppendResult>;
  appendMany: (
    opts: JournalSourceOptions,
    events: readonly JournalEvent[]
  ) => Promise<JournalAppendResult>;
}

const DEFAULT_REVIEW_JOURNAL_EFFECTS: ReviewJournalEffects = {
  load: loadLedger,
  append: appendJournalEvent,
  appendMany: appendJournalEvents,
};

/**
 * The comment sidecar's writers, behind a seam.
 *
 * Production shells out to the `orcaops review comment` CLI — the SAME track an agent
 * uses to reply out-of-band, which is exactly why the loop closes. Tests substitute an
 * in-memory sidecar, because the round-trip these tests exist to prove (author -> agent
 * replies -> reviewer resolves) cannot be observed through a subprocess.
 */
export interface ReviewCommentEffects {
  add: (
    opts: { root: string | undefined; branch: string },
    input: { body: string; anchor: CommentAnchor }
  ) => Promise<CommentsPayload>;
  reply: (
    opts: { root: string | undefined; branch: string },
    input: { id: string; body: string; author?: 'reviewer' | 'agent' }
  ) => Promise<CommentsPayload>;
  resolve: (
    opts: { root: string | undefined; branch: string },
    input: { id: string }
  ) => Promise<CommentsPayload>;
  reopen: (
    opts: { root: string | undefined; branch: string },
    input: { id: string }
  ) => Promise<CommentsPayload>;
}

const DEFAULT_REVIEW_COMMENT_EFFECTS: ReviewCommentEffects = {
  add: addComment,
  reply: replyComment,
  resolve: resolveComment,
  reopen: reopenComment,
};

const LIVE_REFRESH_THROTTLE_MS = 2_000;
const REVIEW_LOAD_DETAIL_MAX_LENGTH = 500;

function conciseReviewLoadError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const sidecar = firstLine.match(
    /^review data sidecar exited (?:-?\d+|after [^:]+)(?::\s*(.*))?$/
  );
  const detail = (sidecar?.[1] ?? firstLine).replace(
    /^(?:[A-Za-z_$][\w$]*(?:Error|Exception)|Error):\s*/,
    ''
  );
  const message =
    sidecar === null
      ? detail
      : detail.length > 0
        ? `Review rebuild failed: ${detail}`
        : 'Review rebuild failed before the sidecar reported a cause.';
  return (message || 'Review loading failed without an error message.').slice(
    0,
    REVIEW_LOAD_DETAIL_MAX_LENGTH
  );
}

interface ReviewLoadFailure {
  detail: string;
  cacheBehind: ReviewCacheBehindError | null;
}

function reviewLoadFailure(cause: unknown): ReviewLoadFailure {
  return {
    detail: conciseReviewLoadError(cause),
    cacheBehind: cause instanceof ReviewCacheBehindError ? cause : null,
  };
}

export interface ReviewShellRequest {
  readonly id: 'help' | 'next-pane' | 'back' | 'story-lens' | 'captured-checkpoint-lens';
  readonly nonce: number;
}

function loadedStaleness(loaded: LoadedReview | null): StalenessRow | null {
  if (loaded === null) return null;
  return stalenessForProbe(loaded.data, {
    headSha: loaded.data.worktreeHeadSha,
    porcelainDigest: loaded.data.worktreeDigest,
  });
}

function stalenessForProbe(data: ReviewData, probe: WorktreeProbe): StalenessRow | null {
  return computeFloorStaleness({
    floorHeadSha: data.floor.scope.head_sha,
    currentHeadSha: probe.headSha,
    loadDigest: data.worktreeDigest,
    currentDigest: probe.porcelainDigest,
  });
}

function sameStaleness(left: StalenessRow | null, right: StalenessRow | null): boolean {
  return left === right || (left?.code === right?.code && left?.message === right?.message);
}

/**
 * Whether a successful load replaced the immutable source generation behind
 * gap expansion. Mutable journal/comment overlays deliberately do not
 * participate: they must not close context the reviewer is already reading.
 */
function immutableReviewSourceChanged({
  previous,
  next,
  previousGeneration,
  nextGeneration,
  bundleChangeObserved,
}: {
  previous: ReviewData | null;
  next: ReviewData;
  previousGeneration: ReviewGenerations | null;
  nextGeneration: ReviewGenerations | null;
  bundleChangeObserved: boolean;
}): boolean {
  if (previous === null) return false;
  if (bundleChangeObserved) return true;
  if (
    previousGeneration !== null &&
    nextGeneration !== null &&
    previousGeneration.bundle !== nextGeneration.bundle
  ) {
    return true;
  }

  return (
    previous.root !== next.root ||
    previous.slug !== next.slug ||
    previous.reviewDiff !== next.reviewDiff ||
    previous.floor.input_hash !== next.floor.input_hash ||
    previous.floor.scope.branch_slug !== next.floor.scope.branch_slug ||
    previous.floor.scope.base_sha !== next.floor.scope.base_sha ||
    previous.floor.scope.pinned_tree_sha !== next.floor.scope.pinned_tree_sha
  );
}

interface ModalSpec {
  title: string;
  context?: string;
  guidance?: readonly string[];
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  required?: boolean;
  emptyMessage?: string;
  onText: (text: string) => void;
}

export interface ReviewAppProps {
  root: string | undefined;
  branch: string;
  width: number;
  height: number;
  liveGen?: number;
  /** Live shell-preview diff theme; committed provider theme when omitted. */
  themeOverride?: AppTheme;
  /** Command requested by the persistent App shell (pointer and F10 menus). */
  shellRequest?: ReviewShellRequest | null;
  /** Executes shared-shell commands selected from Review's executable Help. */
  onShellCommand?: (id: ShellCommandId) => void;
  /** Higher shell chrome owns input while a menu or theme selector is open. */
  inputSuspended?: boolean;
  onExit: () => void;
  /** Real-app acceptance seam; production leaves this undefined and loads from disk. */
  /** Explicit null means loading completed without a deterministic review floor. */
  initialLoaded?: LoadedReview | null;
  initialControllerState?: ReviewControllerState;
  disableAutoLoad?: boolean;
  /** Test seam for racing real load generations; production always uses loadReview. */
  reviewLoader?: typeof loadReview;
  /** Read-only immutable-bundle seam used only after an installed generation changes. */
  installedReviewLoader?: typeof loadInstalledReview;
  /** Cheap per-layer file-generation probe; never reads the multi-MB payloads. */
  reviewGenerationLoader?: typeof readReviewGenerations;
  /** Read-only HEAD/porcelain probe used on every live heartbeat. */
  worktreeProbeLoader?: typeof readWorktreeProbe;
  /** Test seam for the comment sidecar loaded in the same generation. */
  reviewAuxLoader?: (opts: { root: string | undefined; branch: string }) => Promise<{
    comments: CommentsPayload;
  }>;
  /** Test seam for the coordinator window; production uses two seconds. */
  liveRefreshThrottleMs?: number;
  /** Deterministic wheel-burst clock for mounted acceptance tests. */
  wheelAccelerationClock?: () => number;
  /** Performance instrumentation measured from the real wheel handler to its layout commit. */
  onDiffWheelCommitted?: (sample: { latencyMs: number; scrollTop: number }) => void;
  /** Performance instrumentation fired from each committed review-loading spinner frame. */
  onLoadingFrameCommitted?: (frame: string) => void;
  /** Performance instrumentation fired by the existing page layout-commit effect. */
  onControllerStateCommitted?: (state: ReviewControllerState) => void;
  onControllerStateChange?: (state: ReviewControllerState) => void;
  onCommandExecuted?: (command: ReviewControllerCommand, state: ReviewControllerState) => void;
  /** Acceptance seam: fires only after the production keyboard subscription is installed. */
  onInputReady?: () => void;
  /** Acceptance seam for state-driven PTY interaction with the local Help overlay. */
  onHelpOpenChange?: (open: boolean) => void;
  /** Lets the persistent shell enforce text-input-first pointer/key precedence. */
  onModalOpenChange?: (open: boolean) => void;
  /** Publishes Story availability and the active lens to persistent shell commands. */
  onLensStateChange?: (state: {
    storyAvailable: boolean;
    /** A validated model exists (current OR stale) — explicit selection only. */
    storyViewable: boolean;
    activeLens: ReaderLens;
  }) => void;
  /** Acceptance instrumentation for immutable projection-cache boundaries. */
  onProjectionBuild?: (lens: ReaderLens, loaded: LoadedReview) => void;
  /** Real-app acceptance seam; production uses the locked sidecar journal. */
  journalEffects?: ReviewJournalEffects;
  /** Real-app acceptance seam; production shells out to the comment CLI track. */
  commentEffects?: ReviewCommentEffects;
}

/** Before the ledger loads there are no transitions — which is exactly OPEN. */
const EMPTY_LIFECYCLE: ReviewLifecycleLedger = {
  state: 'OPEN',
  stale: false,
  current: null,
  history: [],
};

function deterministicReaderForLoadedReview(loaded: LoadedReview): ReaderModel {
  // The finish gate's facts are branch facts shared with the journal transport.
  // `targetsStatus` is passed rather than inferred from the empty inputs it
  // produces, because a failed target build is what makes those inputs a lie:
  // no gap rows derived reads identically to no gap rows outstanding.
  const finishFacts = {
    targets: loaded.data.targetsStatus,
    currentGapRows: loaded.data.currentGapRows,
    comments: loaded.comments.comments,
  };
  return buildDeterministicReader({
    floor: loaded.data.floor,
    eligibleTargets: loaded.data.eligibleTargets,
    ledger: loaded.ledger,
    currentThreads: loaded.data.currentThreads,
    finishFacts,
  });
}

function storyReaderForLoadedReview(loaded: LoadedReview): ReaderModel {
  const story = loaded.data.routineStory;
  if (
    (story.status !== 'ok' && story.status !== 'stale') ||
    story.model === null ||
    story.generation === null
  ) {
    throw new Error('Cannot project a Story reader without a validated Story model');
  }
  return buildStoryReader({
    floor: loaded.data.floor,
    model: story.model,
    reviewDiff: loaded.data.reviewDiff,
    // A stale Story projects best-effort and read-only; its internally-OK
    // anchor generation reconciles per-target inside the builder.
    staleProjection: story.status === 'stale',
    semanticAnchors: story.anchors.status === 'ok' ? story.anchors.model : null,
    eligibleTargets: loaded.data.eligibleTargets,
    ledger: loaded.ledger,
    currentThreads: loaded.data.currentThreads,
    finishFacts: {
      targets: loaded.data.targetsStatus,
      currentGapRows: loaded.data.currentGapRows,
      comments: loaded.comments.comments,
    },
  });
}

function currentStoryAvailable(loaded: LoadedReview | null): boolean {
  return (
    loaded?.data.routineStory.status === 'ok' &&
    loaded.data.routineStory.model !== null &&
    loaded.data.routineStory.generation !== null
  );
}

/**
 * A validated Story model exists — current OR stale. Controls explicit lens
 * selection only; `currentStoryAvailable` keeps controlling the DEFAULT lens
 * and every authority decision.
 */
function storyViewable(loaded: LoadedReview | null): boolean {
  return (
    (loaded?.data.routineStory.status === 'ok' || loaded?.data.routineStory.status === 'stale') &&
    loaded.data.routineStory.model !== null &&
    loaded.data.routineStory.generation !== null
  );
}

interface ActiveReviewProjection {
  readonly routeIndex: ReaderRouteIndex | null;
  readonly reader: ReaderModel | null;
}

const EMPTY_REVIEW_PROJECTION: ActiveReviewProjection = {
  routeIndex: null,
  reader: null,
};

interface ReviewProjectionCaches {
  deterministic: GenerationProjectionCache<LoadedReview, ReaderModel, ReaderRouteIndex>;
  story: GenerationProjectionCache<LoadedReview, ReaderModel, ReaderRouteIndex>;
}

function createReviewProjectionCaches(
  onBuild?: (lens: ReaderLens, loaded: LoadedReview) => void
): ReviewProjectionCaches {
  return {
    deterministic: new GenerationProjectionCache(
      (loaded: LoadedReview) => {
        onBuild?.('deterministic', loaded);
        return deterministicReaderForLoadedReview(loaded);
      },
      (_loaded, reader) => reader.routeIndex
    ),
    story: new GenerationProjectionCache(
      (loaded: LoadedReview) => {
        onBuild?.('story', loaded);
        return storyReaderForLoadedReview(loaded);
      },
      (_loaded, reader) => reader.routeIndex
    ),
  };
}

const DEFAULT_PROJECTION_CACHES = createReviewProjectionCaches();

function projectionForLoadedReview(
  loaded: LoadedReview | null,
  preferredLens: ReaderLens | null,
  caches: ReviewProjectionCaches
): ActiveReviewProjection {
  if (loaded === null) return EMPTY_REVIEW_PROJECTION;
  // Deterministic stays the DEFAULT whenever the Story is not current; an
  // explicit 'story' preference may project a viewable-but-stale model.
  const lens =
    preferredLens === 'story'
      ? storyViewable(loaded)
        ? 'story'
        : 'deterministic'
      : preferredLens === 'deterministic' || !currentStoryAvailable(loaded)
        ? 'deterministic'
        : 'story';
  const cached =
    lens === 'story' ? caches.story.project(loaded) : caches.deterministic.project(loaded);
  return {
    routeIndex: cached.reader,
    reader: cached.model,
  };
}

interface ReconciledProjectionController {
  readonly state: ReviewControllerState;
  readonly entrySliceKey: string | null;
}

/**
 * Move the controller between immutable reader generations by durable floor evidence.
 *
 * Page indexes are generation-local and therefore disposable. Hunk and slice
 * keys are floor identities, so they are the safe bridge across a re-floor.
 */
function reconcileProjectionController(
  state: ReviewControllerState,
  loaded: LoadedReview,
  previous: ActiveReviewProjection,
  next: ActiveReviewProjection
): ReconciledProjectionController {
  const reader = next.reader;
  if (reader === null) {
    return {
      state: {
        ...state,
        screen: 'brief',
        focus: initialFocusForReviewScreen('brief'),
        routeHistory: [],
        diffSliceKey: null,
        diffHunkKey: null,
      },
      entrySliceKey: null,
    };
  }

  // The Brief's two cursors are reconciled HERE, and only here.
  //
  // Route restoration spreads a snapshot verbatim and never receives a
  // ReaderModel, so it cannot resolve a durable key. This function already gets
  // `next.reader` and already maps every history entry, so extending it is the
  // whole change — no new app-level reconciliation step.
  const tree = buildBriefTree(reader);
  const attentionRows = buildBriefAttention({
    reader,
    obligations: buildFinishObligations({ floor: loaded.data.floor, reader }),
  });
  /**
   * Resolve one cursor/key pair against a rebuilt list.
   *
   * A null key is PRESERVED: it means traversal genuinely has not started, and
   * inventing an identity for it would make the first `n` open row 1. A key that
   * survived adopts its new index. A key that vanished clamps — and adopts the
   * fallback row's key, so the pair never drifts apart.
   */
  const reconcileSelection = <T,>(
    rows: readonly T[],
    keyOf: (row: T) => string,
    cursor: number,
    key: string | null
  ): { cursor: number; key: string | null } => {
    if (rows.length === 0) return { cursor: 0, key: null };
    if (key === null) return { cursor: clamp(cursor, rows.length), key: null };
    const found = rows.findIndex((row) => keyOf(row) === key);
    if (found >= 0) return { cursor: found, key };
    const clamped = clamp(cursor, rows.length);
    return { cursor: clamped, key: keyOf(rows[clamped]!) };
  };
  const reconcileBriefSelection = <R extends ReviewRouteSnapshot | ReviewControllerState>(
    route: R
  ): R => {
    const destination = reconcileSelection(
      tree.destinations,
      (entry) => entry.key,
      route.briefCursor,
      route.briefDestinationKey
    );
    const attention = reconcileSelection(
      attentionRows,
      (row) => row.key,
      route.attentionCursor,
      route.attentionRowKey
    );
    return {
      ...route,
      briefCursor: destination.cursor,
      briefDestinationKey: destination.key,
      attentionCursor: attention.cursor,
      attentionRowKey: attention.key,
    };
  };

  const previousReader = previous.reader;
  const pageScreen = (screen: ReviewRouteSnapshot['screen']): boolean =>
    screen === 'walk' || screen === 'floor-diff';

  const reconcileRoute = (
    route: ReviewRouteSnapshot
  ): { route: ReviewRouteSnapshot; entrySliceKey: string | null } | null => {
    if (route.screen === 'unassigned') {
      const stop =
        reader.auxiliaryPage.sliceStops.find(
          (candidate) => candidate.sliceKey === route.diffSliceKey
        ) ??
        reader.auxiliaryPage.sliceStops.find(
          (candidate) => candidate.hunkKey === route.diffHunkKey
        ) ??
        reader.auxiliaryPage.sliceStops[0] ??
        null;
      const suppliedEvidence = route.diffSliceKey !== null || route.diffHunkKey !== null;
      if (stop === null && suppliedEvidence) return null;
      return {
        route: {
          ...route,
          diffSliceKey: stop?.sliceKey ?? null,
          diffHunkKey: stop?.hunkKey ?? null,
        },
        entrySliceKey: stop?.sliceKey ?? null,
      };
    }
    if (route.screen === 'brief') {
      return { route: reconcileBriefSelection(route), entrySliceKey: null };
    }
    if (!pageScreen(route.screen)) return { route, entrySliceKey: null };

    const sameLens = previousReader?.lens === reader.lens;
    const previousPageKey = sameLens
      ? (previousReader?.pages[route.readerPage]?.key ?? null)
      : null;
    let readerPage =
      previousPageKey === null
        ? null
        : (reader.routeIndex.pageIndexByKey.get(previousPageKey) ?? null);
    if (readerPage === null && route.diffSliceKey !== null) {
      readerPage = pageIndexForSlice(reader, route.diffSliceKey);
    }
    if (readerPage === null && route.diffHunkKey !== null) {
      readerPage = pageIndexForHunk(reader, route.diffHunkKey);
    }
    const suppliedEvidence =
      previousPageKey !== null || route.diffSliceKey !== null || route.diffHunkKey !== null;
    if (readerPage === null && !suppliedEvidence && reader.pages.length > 0) {
      readerPage = clamp(route.readerPage, reader.pages.length);
    }
    if (readerPage === null) return null;

    const page = reader.pages[readerPage];
    if (page === undefined) return null;
    const stop =
      page.sliceStops.find((candidate) => candidate.sliceKey === route.diffSliceKey) ??
      page.sliceStops.find((candidate) => candidate.hunkKey === route.diffHunkKey) ??
      page.sliceStops[0] ??
      null;
    // A route anchored to diff evidence whose page now retains NO stops at all
    // has nothing to be reconciled onto. Dropping it (and saying so) beats
    // silently rewriting the anchor to an unrelated hunk.
    if (stop === null && (route.diffSliceKey !== null || route.diffHunkKey !== null)) return null;
    return {
      route: {
        ...route,
        screen: page.kind === 'part' ? 'walk' : 'floor-diff',
        focus: route.focus,
        readerPage,
        activeAct: page.kind === 'part' ? page.actIndex : 0,
        activePart: page.kind === 'part' ? page.partIndex : 0,
        activeItem: 0,
        activeTarget: 0,
        diffSliceKey: stop?.sliceKey ?? null,
        diffHunkKey: stop?.hunkKey ?? null,
        diffRowCursor: route.diffGrain === 'row' ? route.diffRowCursor : 0,
        diffSelectionAnchor: null,
      },
      entrySliceKey: stop?.sliceKey ?? null,
    };
  };

  const history = state.routeHistory.flatMap((route) => {
    const reconciled = reconcileRoute(route);
    return reconciled === null ? [] : [reconciled.route];
  });
  const current = reconcileRoute(captureReviewRoute(state));
  if (current === null) {
    return {
      state: reconcileBriefSelection({
        ...state,
        screen: 'brief',
        focus: initialFocusForReviewScreen('brief'),
        routeHistory: history,
        diffSliceKey: null,
        diffHunkKey: null,
        notice: 'The requested evidence is no longer represented in this reader',
      }),
      entrySliceKey: null,
    };
  }
  return {
    state: reconcileBriefSelection({
      ...state,
      ...current.route,
      routeHistory: history,
      notice:
        history.length < state.routeHistory.length && state.notice === null
          ? 'Review data changed; an unavailable Back destination was removed'
          : state.notice,
    }),
    entrySliceKey: current.entrySliceKey,
  };
}

class StoryReadWitnessError extends Error {
  constructor(
    message: string,
    readonly routeToStory: boolean
  ) {
    super(message);
  }
}

/** Build the exact lens identity the locked journal transport will re-check. */
async function lifecycleJournalEvent(
  action: 'COMPLETE' | 'PARTIAL' | 'REOPEN',
  loaded: LoadedReview,
  reader: ReaderModel | null,
  storyReadGeneration: string | null,
  remainingWork?: string
): Promise<JournalEvent> {
  const story = loaded.data.routineStory;
  let reviewBasis: (typeof REVIEW_BASIS)[keyof typeof REVIEW_BASIS];
  let storyGeneration: string | null;
  if (story.status === 'ok') {
    if (story.generation === null || story.model === null) {
      throw new StoryReadWitnessError(
        'The current Story resolver returned an incomplete model; refresh or regenerate before changing review lifecycle',
        false
      );
    }
    if (
      action !== 'REOPEN' &&
      (reader?.lens !== 'story' || storyReadGeneration !== story.generation)
    ) {
      throw new StoryReadWitnessError(
        'Read the current Story Brief before changing review lifecycle',
        true
      );
    }
    reviewBasis = REVIEW_BASIS.STORY;
    storyGeneration = story.generation;
  } else if (story.status === 'absent' || story.status === 'stale') {
    reviewBasis = REVIEW_BASIS.FLOOR_ONLY;
    storyGeneration = null;
  } else {
    throw new StoryReadWitnessError(
      story.issue ??
        `The current Story is ${story.status}; repair or regenerate it before changing review lifecycle`,
      false
    );
  }
  if (reader === null) {
    throw new StoryReadWitnessError('The current review reader is unavailable', false);
  }
  return {
    type: 'review_lifecycle',
    ts: nowIso(),
    action,
    review_basis: reviewBasis,
    floor_input_hash: loaded.data.floor.input_hash,
    story_generation: storyGeneration,
    ledger_generation: loaded.ledger.ledgerGeneration,
    actor: 'REVIEWER',
    source: 'WATCH',
    ...(remainingWork === undefined ? {} : { remaining_work: remainingWork }),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

type ActiveReaderPage = ReaderPage | ReaderAuxiliaryPage;

/** The canonical page selected by controller state, including Unassigned. */
function activeReaderPage(
  reader: ReaderModel | null,
  state: ReviewControllerState
): ActiveReaderPage | null {
  if (reader === null) return null;
  if (state.screen === 'unassigned') return reader.auxiliaryPage;
  return reader.pages[clamp(state.readerPage, reader.pages.length)] ?? null;
}

function activeSliceStops(
  reader: ReaderModel | null,
  state: ReviewControllerState
): readonly ReaderSliceStop[] {
  return activeReaderPage(reader, state)?.sliceStops ?? [];
}

/** File selected by the semantic diff cursor, independent of viewport orientation. */
function activeDiffFile(reader: ReaderModel | null, state: ReviewControllerState): string | null {
  const stops = activeSliceStops(reader, state);
  return (
    stops.find((stop) => stop.sliceKey === state.diffSliceKey)?.file ??
    stops.find((stop) => stop.hunkKey === state.diffHunkKey)?.file ??
    null
  );
}

/** Resolve a code-row jump back to the page's canonical slice cursor. */
function sliceStopForLine(
  page: ActiveReaderPage | null,
  hunkKey: string,
  side: 'add' | 'delete',
  line: number
): ReaderSliceStop | null {
  if (page === null) return null;
  let fallback: ReaderSliceStop | null = null;
  for (const file of page.projection.layout.files) {
    for (const slice of file.slices) {
      if (slice.hunkKey !== hunkKey) continue;
      const stop = page.sliceStops.find((candidate) => candidate.sliceKey === slice.sliceKey);
      if (stop === undefined) continue;
      fallback ??= stop;
      const ranges = unitLineRanges(slice.unit);
      if (ranges === null) return stop;
      const range = side === 'add' ? ranges.addRange : ranges.delRange;
      if (range !== null && line >= range.start && line <= range.end) return stop;
    }
  }
  // A pin may sit on subdued context inside a parent hunk. The page still owns a
  // slice of that hunk, so keep the cursor representable by choosing its first stop.
  return fallback;
}

function checkpointUncertaintyIds(
  floor: LoadedReview['data']['floor'],
  page: CheckpointPage | null
): string[] {
  if (page === null) return [];
  const checkpoint = floor.outline.threads
    .flatMap((thread) => thread.checkpoints)
    .find((candidate) => candidate.checkpointKey === page.key);
  if (checkpoint === undefined) return [];
  const uncertaintyIds = new Set(
    floor.citations
      .filter((citation) => citation.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY)
      .map((citation) => citation.id)
  );
  return checkpoint.citationIds.filter((id) => uncertaintyIds.has(id));
}

function assertNever(value: never): never {
  throw new Error(`unhandled review command: ${JSON.stringify(value)}`);
}

function journalEventForStoryItem(
  item: import('./readerModel').ReaderRailItem,
  action: 'ACKNOWLEDGE' | 'RESOLVE' | 'DISMISS' | 'REOPEN',
  reason?: string
): JournalEvent | null {
  const shared = { ts: nowIso(), ...(reason === undefined ? {} : { reason }) };
  if (item.kind === 'uncertainty') {
    if (action === 'DISMISS') return null;
    return {
      type: 'uncertainty',
      citationId: item.id.slice('citation:'.length),
      action:
        action === 'ACKNOWLEDGE'
          ? UNCERTAINTY_DISPOSITION.ACKNOWLEDGE
          : action === 'RESOLVE'
            ? UNCERTAINTY_DISPOSITION.RESOLVE
            : UNCERTAINTY_DISPOSITION.REOPEN,
      ...shared,
    };
  }
  if (item.kind === 'finding') {
    return {
      type: 'finding',
      findingKey: item.id.slice('finding:'.length),
      action:
        action === 'ACKNOWLEDGE'
          ? FINDING_DISPOSITION.ACKNOWLEDGE
          : action === 'RESOLVE'
            ? FINDING_DISPOSITION.RESOLVE
            : action === 'DISMISS'
              ? FINDING_DISPOSITION.DISMISS
              : FINDING_DISPOSITION.REOPEN,
      ...shared,
    };
  }
  if (item.kind === 'question') {
    return {
      type: 'prompt',
      promptKey: item.id.slice('question:'.length),
      action:
        action === 'ACKNOWLEDGE'
          ? PROMPT_DISPOSITION.ACKNOWLEDGE
          : action === 'RESOLVE'
            ? PROMPT_DISPOSITION.RESOLVE
            : action === 'DISMISS'
              ? PROMPT_DISPOSITION.DISMISS
              : PROMPT_DISPOSITION.REOPEN,
      ...shared,
    };
  }
  return null;
}

/** The deterministic Review reader; routine two-lane Story dispatches separately below. */
export function ReviewApp({
  root,
  branch,
  width,
  height,
  liveGen,
  themeOverride,
  shellRequest,
  onShellCommand,
  inputSuspended = false,
  onExit,
  initialLoaded,
  initialControllerState,
  disableAutoLoad = false,
  reviewLoader = loadReview,
  installedReviewLoader = loadInstalledReview,
  reviewGenerationLoader = readReviewGenerations,
  worktreeProbeLoader = readWorktreeProbe,
  reviewAuxLoader,
  liveRefreshThrottleMs = LIVE_REFRESH_THROTTLE_MS,
  wheelAccelerationClock,
  onDiffWheelCommitted,
  onLoadingFrameCommitted,
  onControllerStateCommitted,
  onControllerStateChange,
  onCommandExecuted,
  onInputReady,
  onHelpOpenChange,
  onModalOpenChange,
  onLensStateChange,
  onProjectionBuild,
  journalEffects,
  commentEffects,
}: ReviewAppProps) {
  const controls = useThemeControls();
  const cockpit = useCockpitTheme();
  const renderer = useRenderer();
  const [loaded, setLoaded] = useState<LoadedReview | null>(initialLoaded ?? null);
  const [staleness, setStaleness] = useState<StalenessRow | null>(
    loadedStaleness(initialLoaded ?? null)
  );
  const commitStaleness = useCallback((next: StalenessRow | null) => {
    setStaleness((current) => (sameStaleness(current, next) ? current : next));
  }, []);
  const [loading, setLoading] = useState(initialLoaded === undefined);
  const [error, setError] = useState<ReviewLoadFailure | null>(null);
  const [cacheUpgradePromptOpen, setCacheUpgradePromptOpen] = useState(false);
  const [rebuildingCache, setRebuildingCache] = useState(false);
  const [controller, setController] = useState(
    initialControllerState ?? initialReviewControllerState()
  );
  const controllerRef = useRef(controller);
  const codeHorizontalMaxOffsetRef = useRef(0);
  const [modal, setModal] = useState<ModalSpec | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpSelection, setHelpSelection] = useState(0);
  const helpSelectionRef = useRef(0);
  const helpCommandsRef = useRef<ExecutableHelpEntry[]>([]);
  const shellLayerRef = useRef({ inputSuspended, modal, helpOpen, cacheUpgradePromptOpen });
  shellLayerRef.current = { inputSuspended, modal, helpOpen, cacheUpgradePromptOpen };
  const helpScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const walkScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [diffScrollSurface, setDiffScrollSurface] = useState<ScrollBoxRenderable | null>(null);
  const capturedTrailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const lastVisitedPageRef = useRef<string | null>(null);
  const liveRefreshRef = useRef<LiveRefreshCoordinator | null>(null);
  const lastLiveGenRef = useRef(liveGen);
  const generationRef = useRef<ReviewGenerations | null>(null);
  const loadEpochRef = useRef(0);
  const activeLoadAbortRef = useRef<AbortController | null>(null);
  const diffLayoutRef = useRef<CheckpointLayout | null>(null);
  const diffLayoutPageKeyRef = useRef<string | null>(null);
  const pendingDiffSourceAnchorRef = useRef<DiffScrollAnchor | null>(null);
  const pendingDiffSourceLayoutRef = useRef<CheckpointLayout | null>(null);
  const pendingDiffSourceDeltaRef = useRef(0);
  const preferredDiffSourceKeyRef = useRef<string | null>(null);
  const pendingDiffRowRef = useRef<{
    readonly hunkKey: string;
    readonly row: Pick<AnchorPick, 'side' | 'line'>;
    /** The committed layout this intent must supersede. */
    readonly sourceLayout: CheckpointLayout | null;
  } | null>(null);
  // A page entry owns one pending geometry anchor. It is seeded synchronously for
  // direct-entry routes, then consumed when that page reports committed layout.
  const pendingDiffSliceRef = useRef<string | null>(
    (initialControllerState ?? initialReviewControllerState()).diffSliceKey
  );
  /** File-strength entry intent: unlike slice traversal it aligns the card under the sticky row. */
  const pendingDiffFileRef = useRef<string | null>(null);
  const loadedRef = useRef<LoadedReview | null>(initialLoaded ?? null);
  const projectionCachesRef = useRef<ReviewProjectionCaches | null>(null);
  projectionCachesRef.current ??=
    onProjectionBuild === undefined
      ? DEFAULT_PROJECTION_CACHES
      : createReviewProjectionCaches(onProjectionBuild);
  const projectionCaches = projectionCachesRef.current;
  const activeProjectionRef = useRef(
    projectionForLoadedReview(initialLoaded ?? null, controller.preferredLens, projectionCaches)
  );
  const storyReadGenerationRef = useRef<string | null>(null);
  const journal = journalEffects ?? DEFAULT_REVIEW_JOURNAL_EFFECTS;
  const commentSidecar = commentEffects ?? DEFAULT_REVIEW_COMMENT_EFFECTS;

  // --- App-owned diff scroll ---
  //
  // Virtualization is a RENDER decision, so React has to know where the reader is
  // looking. Every scroll intent funnels through `scrollDiff` below, the ScrollBox
  // is `focused={false}`, and its wheel is intercepted in FloorDiff — so the app is
  // the single writer of scrollTop and the mount window can be rendered from this
  // state without ever disagreeing with the surface.
  const [diffScrollTop, setDiffScrollTop] = useState(0);
  const [diffScrollRevision, setDiffScrollRevision] = useState(0);
  const [diffTightViewportWindow, setDiffTightViewportWindow] = useState(false);
  const [diffOverscanRows, setDiffOverscanRows] = useState(0);
  const [diffVisibleViewportHeight, setDiffVisibleViewportHeight] = useState(0);
  const [, setDiffViewportBoundRevision] = useState(0);
  const diffWheelAcceleration = useMemo(
    () => createWheelScrollAcceleration({ now: wheelAccelerationClock }),
    [wheelAccelerationClock]
  );
  const pendingDiffScrollTopRef = useRef<number | null>(null);
  const plannedDiffScrollTopRef = useRef(0);
  const diffScrollIntentEpochRef = useRef(0);
  const rapidScrollOverscanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWheelStartedAtRef = useRef<number | null>(null);
  const diffDragEdgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diffDragEdgeDirectionRef = useRef<DiffDragEdgeDirection | null>(null);
  const synchronousDiffViewportUpperBound = reviewReaderGeometry(
    width,
    height
  ).diffViewportUpperBound;
  const previousDiffViewportUpperBoundRef = useRef(synchronousDiffViewportUpperBound);
  const pendingDiffViewportGrowthBoundRef = useRef<number | null>(null);

  // The old measured viewport is necessarily too short on the render that grows
  // the responsive diff region — whether from height or a stacked-to-split width
  // transition. Publish its new synchronous upper bound for one frame so
  // virtualization mounts every row the expanded native viewport can reveal.
  // Shrinks are safe with the measured value (over-mounting cannot expose a
  // spacer), so they retire an outstanding growth bound immediately.
  if (synchronousDiffViewportUpperBound > previousDiffViewportUpperBoundRef.current) {
    pendingDiffViewportGrowthBoundRef.current = synchronousDiffViewportUpperBound;
  } else if (synchronousDiffViewportUpperBound < previousDiffViewportUpperBoundRef.current) {
    pendingDiffViewportGrowthBoundRef.current = null;
  }
  previousDiffViewportUpperBoundRef.current = synchronousDiffViewportUpperBound;

  // Bootstrap the mount window against the synchronously-priced reader viewport,
  // then replace it with the diff scrollbox's real height as soon as Yoga reports
  // one.
  //
  // The renderable's true viewport is only knowable after it lays out, and layout
  // converges AFTER the commit that mounted it. So an effect reading it back sees
  // 0 on the first paint of the diff, sets no state (0 is what it already had),
  // and therefore schedules no re-render — and, having no re-render, never reads
  // it again. Virtualization would stay switched off until the reviewer happened
  // to press a key, meaning the very first paint of a 5,000-row hunk — the one
  // paint that must not stall — is the one that mounts every row.
  //
  // The reader shell's synchronously-priced diff height is an UPPER BOUND on its
  // native ScrollBox viewport. Over-estimating during bootstrap or the first
  // frame of terminal growth only mounts more than strictly necessary, which is
  // the safe direction; under-estimating can paint blank spacers. Once the
  // renderable reports a credible height (>1), every later mount plan uses that
  // tighter value. A one-row report is the transient Yoga bootstrap value, not a
  // usable viewport, so it cannot replace the safe bound.
  const diffViewport = Math.max(
    1,
    pendingDiffViewportGrowthBoundRef.current ??
      (diffVisibleViewportHeight > 1
        ? diffVisibleViewportHeight
        : synchronousDiffViewportUpperBound)
  );
  const diffViewportRef = useRef(diffViewport);
  diffViewportRef.current = diffViewport;
  // A resize/layout toggle can make an already-active halo more expensive
  // before its 160 ms idle timer expires. Clamp the rows synchronously on the
  // render that changes geometry; an effect would leave one over-budget frame.
  const renderedDiffOverscanRows = Math.min(
    diffOverscanRows,
    rapidScrollOverscanRowLimit({
      viewportHeight: diffViewport,
    })
  );

  const activateRapidScrollOverscan = useCallback((rows: number): void => {
    if (rows <= 0) return;
    setDiffOverscanRows((current) => Math.max(current, rows));
    if (rapidScrollOverscanTimerRef.current !== null) {
      clearTimeout(rapidScrollOverscanTimerRef.current);
    }
    rapidScrollOverscanTimerRef.current = setTimeout(() => {
      rapidScrollOverscanTimerRef.current = null;
      setDiffOverscanRows(0);
    }, RAPID_SCROLL_OVERSCAN_IDLE_MS);
  }, []);

  const bindDiffScrollSurface = useCallback((surface: ScrollBoxRenderable | null): void => {
    walkScrollRef.current = surface;
    if (surface === null) setDiffVisibleViewportHeight(0);
    setDiffScrollSurface(surface);
  }, []);

  /**
   * Queue a destination for React first. The native ScrollBox moves only from
   * the layout effect below, after CheckpointDiff has committed a mount window
   * around this top. This ordering is what prevents a distant selected slice
   * from briefly revealing the spacer planned for the previous viewport.
   */
  const requestDiffScrollTop = useCallback(
    (
      next: number,
      current: number,
      viewportHeight: number,
      recordUserIntent = true,
      continuous = false
    ): void => {
      deferMountedDiffHighlightsForInteraction();
      if (recordUserIntent) {
        diffScrollIntentEpochRef.current += 1;
        pendingDiffRowRef.current = null;
      }
      setDiffTightViewportWindow(false);
      const commitRequired = requiresScrollCommit({
        next,
        current,
        planned: plannedDiffScrollTopRef.current,
        pending: pendingDiffScrollTopRef.current,
      });
      if (commitRequired) {
        pendingDiffScrollTopRef.current = next;
        plannedDiffScrollTopRef.current = next;
        setDiffScrollTop(next);
        setDiffScrollRevision((revision) => revision + 1);
      }
      if (recordUserIntent) {
        // CheckpointDiff has already planned semantic geometry restoration at
        // its resolved destination before this callback moves the native
        // surface. Treating that correction as a fresh rapid-scroll burst adds
        // a second, hidden viewport-sized halo and carries it through the next
        // 160 ms of resize work. Only real navigation needs the rescue window.
        activateRapidScrollOverscan(
          computeRapidScrollOverscanRows({
            deltaRows: next - current,
            viewportHeight,
            continuous,
          })
        );
      }
    },
    [activateRapidScrollOverscan, width]
  );

  useLayoutEffect(() => {
    const next = pendingDiffScrollTopRef.current;
    const surface = walkScrollRef.current;
    if (next === null || surface === null) return;
    surface.scrollTop = next;
    pendingDiffScrollTopRef.current = null;
    const wheelStartedAt = pendingWheelStartedAtRef.current;
    if (wheelStartedAt !== null) {
      pendingWheelStartedAtRef.current = null;
      onDiffWheelCommitted?.({
        latencyMs: performance.now() - wheelStartedAt,
        scrollTop: surface.scrollTop,
      });
    }
    // OpenTUI clamps against the geometry that actually committed. A destination
    // planned from the previous page can therefore land short; absorb the applied
    // value immediately instead of waiting for unrelated input to heal the mirror.
    if (surface.scrollTop !== next) {
      plannedDiffScrollTopRef.current = surface.scrollTop;
      setDiffScrollTop(surface.scrollTop);
    }
  }, [diffScrollRevision, onDiffWheelCommitted]);

  useEffect(
    () => () => {
      if (rapidScrollOverscanTimerRef.current !== null) {
        clearTimeout(rapidScrollOverscanTimerRef.current);
      }
    },
    []
  );

  /**
   * The single writer of the diff column's scroll position. Reconciles from the
   * renderable first (cheap insurance: if anything ever does move it behind our
   * back, the next intent heals instead of latching), then queues a render plan.
   * The layout effect above writes the surface after that plan commits.
   */
  const scrollDiff = useCallback(
    (intent: (at: number) => number, continuous = false): void => {
      const surface = walkScrollRef.current;
      if (surface === null) return;
      const bounds: ScrollBounds = {
        viewport: Math.max(1, surface.viewport?.height ?? 1),
        content: Math.max(0, surface.scrollHeight),
      };
      const current = clampScroll(pendingDiffScrollTopRef.current ?? surface.scrollTop, bounds);
      const next = clampScroll(intent(current), bounds);
      requestDiffScrollTop(next, current, bounds.viewport, true, continuous);
    },
    [requestDiffScrollTop]
  );

  const handleDiffWheel = useCallback(
    (delta: number): void => {
      pendingWheelStartedAtRef.current = performance.now();
      const acceleratedDelta = diffWheelAcceleration.tick(delta);
      // A relayout owns the semantic source row, not the old numeric scrollTop.
      // Queue wheel rows onto that anchor so a burst arriving between commit and
      // Yoga convergence is applied after restoration instead of being lost or
      // interpreted in stale geometry.
      if (pendingDiffSourceAnchorRef.current !== null) {
        deferMountedDiffHighlightsForInteraction();
        pendingDiffSourceDeltaRef.current += acceleratedDelta;
        return;
      }
      scrollDiff((at) => at + acceleratedDelta, true);
    },
    [diffWheelAcceleration, scrollDiff]
  );

  /**
   * Absorb native scrollbar/viewport movement into the same React snapshot that
   * plans virtualization. Track dragging that moves only OpenTUI's surface leaves
   * React mounted around the old location and exposes empty spacers.
   */
  const mirrorNativeDiffViewport = useCallback((releaseDiffViewportGrowthBound = false): void => {
    const surface = walkScrollRef.current;
    if (surface === null) return;
    const bounds: ScrollBounds = {
      viewport: Math.max(1, surface.viewport?.height ?? 1),
      content: Math.max(0, surface.scrollHeight),
    };
    if (releaseDiffViewportGrowthBound && pendingDiffViewportGrowthBoundRef.current !== null) {
      pendingDiffViewportGrowthBoundRef.current = null;
      // The measured height may already equal the previous snapshot. Releasing a
      // ref alone cannot schedule the tighter follow-up render, so carry a tiny
      // render-only revision rather than overloading the user-input revision.
      setDiffViewportBoundRevision((revision) => revision + 1);
    }
    setDiffVisibleViewportHeight((current) =>
      current === bounds.viewport ? current : bounds.viewport
    );
    const observed = clampScroll(surface.scrollTop, bounds);
    // A layout-effect write deliberately emits OpenTUI's change event. React has
    // already planned that destination, so reflecting it would only double-render.
    if (pendingDiffScrollTopRef.current !== null) return;
    if (observed === plannedDiffScrollTopRef.current) return;
    deferMountedDiffHighlightsForInteraction();
    diffScrollIntentEpochRef.current += 1;
    pendingDiffRowRef.current = null;
    plannedDiffScrollTopRef.current = observed;
    // Native scrollbar movement is flushed into React before OpenTUI can paint
    // another frame, so it does not need the viewport-priced rescue halo used by
    // queued app-owned jumps. A halo here would mount a hidden second screen and make
    // an otherwise-correct drag miss its latency/node budgets.
    setDiffTightViewportWindow(true);
    setDiffScrollTop(observed);
  }, []);

  /** Follow one measured slice without re-deriving geometry in the controller. */
  const showDiffSlice = useCallback(
    (sliceKey: string): boolean => {
      const surface = walkScrollRef.current;
      const target = diffLayoutRef.current?.bySliceKey.get(sliceKey);
      if (surface === null || target === undefined) return false;
      const bounds: ScrollBounds = {
        // The stream has no vertical padding: measured rows and native scroll
        // offsets share one coordinate system for sticky handoff.
        viewport: Math.max(1, surface.viewport?.height ?? 1),
        content: Math.max(0, surface.scrollHeight),
      };
      const current = clampScroll(pendingDiffScrollTopRef.current ?? surface.scrollTop, bounds);
      const next = scrollToShow(current, target, bounds);
      requestDiffScrollTop(next, current, bounds.viewport);
      return true;
    },
    [requestDiffScrollTop]
  );

  /**
   * Reveal the source row the row-grain cursor is moving to.
   *
   * A cursor step is semantic, not a terminal-row scroll: one diff row can occupy
   * several visual rows when wrapped, and split/stack mode can place the same
   * source line at different vertical offsets. The measured source-anchor index
   * is the common coordinate system for all of those presentations.
   */
  const showDiffRow = useCallback(
    ({ hunkKey, row }: { hunkKey: string; row: Pick<AnchorPick, 'side' | 'line'> }): boolean => {
      // A presentation toggle seeds a source anchor before React commits its new
      // geometry. A row key arriving in that same input burst is stronger than
      // the old viewport anchor: retain the semantic destination and resolve it
      // only after a different layout has committed. Reading the current index
      // here would price the row in stale wrap/split geometry, then cancel the
      // restoration that could have corrected it.
      const queuedRow = pendingDiffRowRef.current;
      const hasPendingRelayout = pendingDiffSourceAnchorRef.current !== null || queuedRow !== null;
      const sourceLayout =
        queuedRow?.sourceLayout ?? pendingDiffSourceLayoutRef.current ?? diffLayoutRef.current;
      const currentLayout = diffLayoutRef.current;
      if (hasPendingRelayout && (currentLayout === null || currentLayout === sourceLayout)) {
        deferMountedDiffHighlightsForInteraction();
        pendingDiffSourceAnchorRef.current = null;
        pendingDiffSourceLayoutRef.current = null;
        pendingDiffSourceDeltaRef.current = 0;
        preferredDiffSourceKeyRef.current = null;
        pendingDiffSliceRef.current = null;
        pendingDiffFileRef.current = null;
        diffScrollIntentEpochRef.current += 1;
        pendingDiffRowRef.current = { hunkKey, row, sourceLayout };
        return true;
      }
      if (hasPendingRelayout) {
        // The replacement geometry may publish synchronously between two key
        // events while its 0 ms row callback is still queued. Resolve the newer
        // row against that already-current layout now; the older callback sees
        // the replaced ref and aborts.
        pendingDiffSourceAnchorRef.current = null;
        pendingDiffSourceLayoutRef.current = null;
        pendingDiffSourceDeltaRef.current = 0;
        preferredDiffSourceKeyRef.current = null;
        pendingDiffRowRef.current = null;
      }
      const surface = walkScrollRef.current;
      const target = diffLayoutRef.current?.bySourceAnchorKey.get(
        `hunk:${hunkKey}:${row.side}:${row.line}`
      );
      if (surface === null || target === undefined) return false;
      const bounds: ScrollBounds = {
        viewport: Math.max(1, surface.viewport?.height ?? 1),
        content: Math.max(0, surface.scrollHeight),
      };
      const current = clampScroll(pendingDiffScrollTopRef.current ?? surface.scrollTop, bounds);
      const next = scrollToShow(current, target, bounds);
      requestDiffScrollTop(next, current, bounds.viewport);
      return true;
    },
    [requestDiffScrollTop]
  );

  /**
   * An explicit file command is stronger than hunk traversal: place the chosen
   * file under the fixed header so both the pinned title and viewport rail agree
   * with the user's selection. Slice/row movement keeps minimal-reveal behavior.
   */
  const showDiffFile = useCallback(
    (file: string): boolean => {
      const surface = walkScrollRef.current;
      const section = diffLayoutRef.current?.fileSections.find((entry) => entry.fileId === file);
      if (surface === null || section === undefined) return false;
      const bounds: ScrollBounds = {
        viewport: Math.max(1, surface.viewport?.height ?? 1),
        content: Math.max(0, surface.scrollHeight),
      };
      const current = clampScroll(pendingDiffScrollTopRef.current ?? surface.scrollTop, bounds);
      const anchor = section.sectionIndex === 0 ? section.sectionTop : section.bodyTop;
      const next = clampScroll(anchor, bounds);
      requestDiffScrollTop(next, current, bounds.viewport);
      return true;
    },
    [requestDiffScrollTop]
  );

  /**
   * Explicit slice/file navigation supersedes deferred page-entry alignment.
   *
   * A key burst can arrive before the replacement page has committed geometry.
   * Remember that newer destination instead of letting the entry timer scroll to
   * the page's first slice after the controller has already advanced elsewhere.
   */
  const showExplicitDiffTarget = useCallback(
    ({ sliceKey, file }: { sliceKey: string; file?: string }): void => {
      deferMountedDiffHighlightsForInteraction();
      pendingDiffSourceAnchorRef.current = null;
      pendingDiffSourceLayoutRef.current = null;
      pendingDiffSourceDeltaRef.current = 0;
      preferredDiffSourceKeyRef.current = null;
      pendingDiffRowRef.current = null;
      pendingDiffSliceRef.current = null;
      pendingDiffFileRef.current = null;

      const shown = file === undefined ? showDiffSlice(sliceKey) : showDiffFile(file);
      if (shown) return;

      // No committed geometry yet. This is still a real scroll intent: fence any
      // already-queued entry callback and align the first measured frame to this
      // explicit destination instead.
      diffScrollIntentEpochRef.current += 1;
      pendingDiffSliceRef.current = sliceKey;
      pendingDiffFileRef.current = file ?? null;
    },
    [showDiffFile, showDiffSlice]
  );

  /** Reveal the row `z` is about to open without unbounding the mounted window. */
  const showCollapseTarget = useCallback(
    (target: VisibleCollapseTarget): void => {
      const surface = walkScrollRef.current;
      const unit = diffLayoutRef.current?.byHunkKey.get(target.hunkKey);
      const anchor = collapseTargetAnchorRow(target, unit);
      if (surface === null || anchor === null) return;
      const bounds: ScrollBounds = {
        viewport: Math.max(1, surface.viewport?.height ?? 1),
        content: Math.max(0, surface.scrollHeight),
      };
      const current = clampScroll(pendingDiffScrollTopRef.current ?? surface.scrollTop, bounds);
      const next = scrollToShow(current, { top: anchor, height: 1 }, bounds);
      requestDiffScrollTop(next, current, bounds.viewport);
    },
    [requestDiffScrollTop]
  );

  const beginDiffPage = useCallback(
    (sliceKey: string | null): void => {
      pendingDiffSliceRef.current = sliceKey;
      pendingDiffFileRef.current = null;
      pendingDiffSourceAnchorRef.current = null;
      pendingDiffSourceLayoutRef.current = null;
      pendingDiffSourceDeltaRef.current = 0;
      preferredDiffSourceKeyRef.current = null;
      pendingDiffRowRef.current = null;
      diffLayoutRef.current = null;
      diffLayoutPageKeyRef.current = null;
      const surface = walkScrollRef.current;
      const current = surface?.scrollTop ?? plannedDiffScrollTopRef.current;
      requestDiffScrollTop(0, current, diffViewportRef.current);
    },
    [requestDiffScrollTop]
  );

  const handleDiffMeasured = useCallback(
    (pageKey: string | null, layout: CheckpointLayout): void => {
      const previous = diffLayoutPageKeyRef.current === pageKey ? diffLayoutRef.current : null;
      if (previous === null && diffLayoutPageKeyRef.current !== pageKey) {
        pendingDiffSourceAnchorRef.current = null;
        pendingDiffSourceLayoutRef.current = null;
        preferredDiffSourceKeyRef.current = null;
      }
      const pendingEntry = pendingDiffSliceRef.current;
      const sourceAnchor =
        pendingEntry === null && previous !== null
          ? (pendingDiffSourceAnchorRef.current ??
            captureDiffScrollAnchor(
              previous,
              pendingDiffScrollTopRef.current ?? plannedDiffScrollTopRef.current,
              preferredDiffSourceKeyRef.current
            ))
          : null;
      if (sourceAnchor !== null && pendingDiffSourceAnchorRef.current === null) {
        pendingDiffSourceAnchorRef.current = sourceAnchor;
        pendingDiffSourceLayoutRef.current = previous;
        pendingDiffSourceDeltaRef.current = 0;
      }
      diffLayoutRef.current = layout;
      diffLayoutPageKeyRef.current = pageKey;
      const pendingRow = pendingDiffRowRef.current;
      if (pendingRow !== null) {
        // Ignore a late publication from the layout that the row command was
        // meant to supersede. The next distinct measurement owns the target.
        if (layout === pendingRow.sourceLayout) return;
        const rowKey = `hunk:${pendingRow.hunkKey}:${pendingRow.row.side}:${pendingRow.row.line}`;
        if (layout.bySourceAnchorKey.has(rowKey)) {
          setTimeout(() => {
            if (
              pendingDiffRowRef.current !== pendingRow ||
              diffLayoutRef.current !== layout ||
              diffLayoutPageKeyRef.current !== pageKey
            ) {
              return;
            }
            pendingDiffRowRef.current = null;
            showDiffRow(pendingRow);
          }, 0);
          return;
        }
        pendingDiffRowRef.current = null;
      }
      const pending = pendingDiffSliceRef.current;
      if (pending !== null && layout.bySliceKey.has(pending)) {
        // OpenTUI commits the React tree before its Yoga/scroll metrics converge.
        // Defer host turns until scrollHeight and viewport describe THIS page,
        // not the surface it replaced: applying against a zero-height surface
        // clamps the entry scroll to 0 and silently CONSUMES the intent. Keep
        // the pending key as a stale-work fence, and bound the retries so a
        // surface that never converges cannot spin.
        const pendingFile = pendingDiffFileRef.current;
        const entryScrollIntentEpoch = diffScrollIntentEpochRef.current;
        let convergenceRetries = 40;
        const applyPendingEntry = (): void => {
          if (
            pendingDiffSliceRef.current !== pending ||
            pendingDiffFileRef.current !== pendingFile ||
            diffLayoutRef.current !== layout
          ) {
            return;
          }
          if (diffScrollIntentEpochRef.current !== entryScrollIntentEpoch) {
            pendingDiffSliceRef.current = null;
            pendingDiffFileRef.current = null;
            return;
          }
          const surface = walkScrollRef.current;
          if ((surface === null || surface.scrollHeight <= 0) && convergenceRetries > 0) {
            convergenceRetries -= 1;
            setTimeout(applyPendingEntry, 0);
            return;
          }
          pendingDiffSliceRef.current = null;
          pendingDiffFileRef.current = null;
          if (pendingFile === null || !showDiffFile(pendingFile)) showDiffSlice(pending);
        };
        setTimeout(applyPendingEntry, 0);
        return;
      }

      if (sourceAnchor === null) return;
      const restored = resolveDiffScrollAnchor(layout, sourceAnchor);
      if (restored === null) {
        pendingDiffSourceAnchorRef.current = null;
        pendingDiffSourceLayoutRef.current = null;
        pendingDiffSourceDeltaRef.current = 0;
        preferredDiffSourceKeyRef.current = null;
        return;
      }
      preferredDiffSourceKeyRef.current = restored.key;
      const scrollIntentEpoch = diffScrollIntentEpochRef.current;
      // OpenTUI's Yoga metrics can converge a frame after React's committed
      // layout. Apply the zero seam synchronously from CheckpointDiff's committed
      // layout effect: its destination-first mount window is already on the host,
      // so moving the native surface now prevents one frame at the old numeric top
      // from looking into spacers. The bounded 16/48 ms attempts still correct a
      // target that old Yoga scrollHeight temporarily clamped. Any real wheel/key/
      // drag intent advances the epoch and cancels the retries, so restoration can
      // never snap back over input.
      const applyRestoredPosition = (lastAttempt: boolean): void => {
        if (
          pendingDiffSliceRef.current !== null ||
          pendingDiffSourceAnchorRef.current !== sourceAnchor ||
          diffLayoutRef.current !== layout ||
          diffLayoutPageKeyRef.current !== pageKey ||
          diffScrollIntentEpochRef.current !== scrollIntentEpoch
        ) {
          if (diffScrollIntentEpochRef.current !== scrollIntentEpoch) {
            pendingDiffSourceAnchorRef.current = null;
            pendingDiffSourceLayoutRef.current = null;
            pendingDiffSourceDeltaRef.current = 0;
          }
          return;
        }
        const surface = walkScrollRef.current;
        if (surface === null) {
          if (lastAttempt) {
            pendingDiffSourceAnchorRef.current = null;
            pendingDiffSourceLayoutRef.current = null;
            pendingDiffSourceDeltaRef.current = 0;
          }
          return;
        }
        const bounds: ScrollBounds = {
          viewport: Math.max(1, surface.viewport?.height ?? 1),
          content: Math.max(0, surface.scrollHeight),
        };
        const current = clampScroll(
          pendingDiffScrollTopRef.current ?? plannedDiffScrollTopRef.current,
          bounds
        );
        const next = clampScroll(restored.scrollTop + pendingDiffSourceDeltaRef.current, bounds);
        if (lastAttempt) {
          pendingDiffSourceAnchorRef.current = null;
          pendingDiffSourceLayoutRef.current = null;
          pendingDiffSourceDeltaRef.current = 0;
        }
        requestDiffScrollTop(next, current, bounds.viewport, false);
        // `requestDiffScrollTop` publishes the matching React snapshot, but
        // OpenTUI's one-frame commit can paint before that nested update is
        // reconciled. Its pending ref is now set, so this native write is guarded
        // from the scrollbar listener and moves the surface onto the destination
        // window during the same pre-paint layout effect.
        surface.scrollTop = next;
      };

      applyRestoredPosition(false);
      const retryDelays = [16, 48] as const;
      for (const [retryIndex, delay] of retryDelays.entries()) {
        setTimeout(() => {
          applyRestoredPosition(retryIndex === retryDelays.length - 1);
        }, delay);
      }
    },
    [requestDiffScrollTop, showDiffFile, showDiffRow, showDiffSlice]
  );

  /** Capture old geometry synchronously, before a presentation toggle commits. */
  const seedPendingDiffSourceAnchor = useCallback((): void => {
    deferMountedDiffHighlightsForInteraction();
    if (
      pendingDiffSliceRef.current !== null ||
      pendingDiffSourceAnchorRef.current !== null ||
      pendingDiffRowRef.current !== null
    ) {
      return;
    }
    const layout = diffLayoutRef.current;
    if (layout === null) return;
    const anchor = captureDiffScrollAnchor(
      layout,
      pendingDiffScrollTopRef.current ?? plannedDiffScrollTopRef.current,
      preferredDiffSourceKeyRef.current
    );
    if (anchor === null) return;
    pendingDiffSourceAnchorRef.current = anchor;
    pendingDiffSourceLayoutRef.current = layout;
    pendingDiffSourceDeltaRef.current = 0;
  }, []);

  useLayoutEffect(() => {
    deferMountedDiffHighlightsForInteraction();
  }, [height, width]);

  // Gap expansion. One store for both diff routes; ReviewApp is the single
  // writer (the `z`/`Z` keys and the click affordance all funnel through
  // `applyFileGaps`). `sourceEpoch` fences an in-flight fetch against a reload —
  // without it, a settle can paint the previous review's source into this one.
  const [gapStores, setGapStores] = useState<GapStores>({
    expandedGaps: new Map(),
    sourceStatusByFile: new Map(),
  });
  const gapStoresRef = useRef(gapStores);
  const sourceEpoch = useRef(0);
  const [reviewSourceRevision, setReviewSourceRevision] = useState(0);
  const commitGapStores = useCallback((next: GapStores) => {
    gapStoresRef.current = next;
    setGapStores(next);
  }, []);

  // Foreign parent hunks the reviewer has opened. A file card carries EVERY parent
  // hunk of its file, so the ones another checkpoint owns start collapsed to one
  // explicit row — this is the set that has been expanded back open. `Z` writes it
  // wholesale; the click affordance toggles one.
  const [expandedForeignHunks, setExpandedForeignHunks] = useState<ReadonlySet<string>>(new Set());
  const expandedForeignRef = useRef(expandedForeignHunks);
  const commitExpandedForeign = useCallback((next: ReadonlySet<string>) => {
    expandedForeignRef.current = next;
    setExpandedForeignHunks(next);
  }, []);
  const toggleForeignHunk = useCallback(
    (hunkKey: string) => {
      const next = new Set(expandedForeignRef.current);
      if (!next.delete(hunkKey)) next.add(hunkKey);
      commitExpandedForeign(next);
    },
    [commitExpandedForeign]
  );

  const setControllerState = useCallback(
    (next: ReviewControllerState) => {
      const previous = controllerRef.current;
      if (previous.codeHorizontalOffset !== next.codeHorizontalOffset) {
        deferMountedDiffHighlightsForInteraction();
      }
      if (
        previous.wrapLines !== next.wrapLines ||
        previous.showLineNumbers !== next.showLineNumbers ||
        previous.showHunkHeaders !== next.showHunkHeaders ||
        previous.diffLayout !== next.diffLayout ||
        previous.showOwnerLabels !== next.showOwnerLabels
      ) {
        seedPendingDiffSourceAnchor();
      }
      const nextHasDiff =
        next.screen === 'walk' || next.screen === 'floor-diff' || next.screen === 'unassigned';
      const navigatedReader =
        nextHasDiff && (previous.screen !== next.screen || previous.readerPage !== next.readerPage);
      const activeReader = activeProjectionRef.current.reader;
      const previousFile = activeDiffFile(activeReader, previous);
      const nextFile = activeDiffFile(activeReader, next);
      const navigatedFile =
        nextHasDiff && previousFile !== nextFile && (previousFile !== null || nextFile !== null);
      if (navigatedReader || navigatedFile) {
        // A Part/checkpoint switch must publish its plain-text destination before
        // newly mounted Shiki work becomes eligible. Without this quiet window a
        // dwell timer can start synchronous tokenization in the same turn as the
        // next navigation input, producing an avoidable post-load long task.
        deferMountedDiffHighlightsForInteraction();
      }
      const navigated =
        navigatedReader || navigatedFile ? resetReviewCodeHorizontalOffset(next) : next;
      let resolved = clampReviewCodeHorizontalOffset(navigated, codeHorizontalMaxOffsetRef.current);
      if (
        next.codeHorizontalOffset !== previous.codeHorizontalOffset &&
        resolved.codeHorizontalOffset === previous.codeHorizontalOffset &&
        next.notice === null
      ) {
        resolved = {
          ...resolved,
          notice:
            codeHorizontalMaxOffsetRef.current === 0
              ? 'No horizontally hidden code on this page'
              : next.codeHorizontalOffset > previous.codeHorizontalOffset
                ? 'Already at the right edge of the code'
                : 'Already at the left edge of the code',
        };
      }
      controllerRef.current = resolved;
      setController(resolved);
    },
    [seedPendingDiffSourceAnchor]
  );

  const handleDiffHorizontalWheel = useCallback(
    (delta: number): void => {
      diffWheelAcceleration.reset();
      setControllerState(
        panReviewCodeHorizontally(controllerRef.current, delta * REVIEW_CODE_PAN_COLUMNS)
      );
    },
    [diffWheelAcceleration, setControllerState]
  );

  const toggleFileNavigator = useCallback((): void => {
    setControllerState(toggleReviewFileNavigator(controllerRef.current));
  }, [setControllerState]);

  const cancelActiveLoad = useCallback(() => {
    const active = activeLoadAbortRef.current;
    if (active === null) return;
    activeLoadAbortRef.current = null;
    loadEpochRef.current += 1;
    active.abort();
  }, []);

  const load = useCallback(
    async (
      mode: 'active' | 'installed' = 'active',
      bundleChangeObserved = false,
      rebuildCache = false
    ) => {
      cancelActiveLoad();
      const epoch = ++loadEpochRef.current;
      const abortController = new AbortController();
      activeLoadAbortRef.current = abortController;
      const previousGeneration = generationRef.current;
      if (mode === 'active') {
        setLoading(true);
        setError(null);
        setCacheUpgradePromptOpen(false);
        setRebuildingCache(rebuildCache);
      }
      try {
        const data = await (mode === 'active' ? reviewLoader : installedReviewLoader)({
          root,
          branch,
          signal: abortController.signal,
          ...(rebuildCache ? { rebuildCache: true } : {}),
        });
        const [ledgerResult, auxResult, generationResult] = await Promise.allSettled([
          journal.load({ root, branch }),
          reviewAuxLoader?.({ root, branch }) ??
            loadComments({ root, branch }).then((comments) => ({ comments })),
          reviewGenerationLoader({ root: data.root, branch }),
        ]);
        if (ledgerResult.status === 'rejected') throw ledgerResult.reason;
        if (auxResult.status === 'rejected') throw auxResult.reason;
        if (loadEpochRef.current !== epoch) return;
        const nextGeneration =
          generationResult.status === 'fulfilled' ? generationResult.value : null;
        const next = {
          data,
          ledger: ledgerResult.value,
          comments: auxResult.value.comments,
        };
        const previousLoaded = loadedRef.current;
        const sourceChanged = immutableReviewSourceChanged({
          previous: previousLoaded?.data ?? null,
          next: data,
          previousGeneration,
          nextGeneration,
          bundleChangeObserved,
        });
        if (nextGeneration !== null) generationRef.current = nextGeneration;
        const previousProjection = activeProjectionRef.current;
        const previousStoryGeneration = previousLoaded?.data.routineStory.generation ?? null;
        const nextStoryGeneration = next.data.routineStory.generation;
        const storyGenerationChanged =
          previousLoaded !== null && previousStoryGeneration !== nextStoryGeneration;
        if (storyGenerationChanged) storyReadGenerationRef.current = null;
        const enterReplacementStory = storyGenerationChanged && currentStoryAvailable(next);
        const projectionPreference = enterReplacementStory
          ? 'story'
          : controllerRef.current.preferredLens;
        const nextProjection = projectionForLoadedReview(
          next,
          projectionPreference,
          projectionCaches
        );
        if (sourceChanged) {
          // A DiffFile source fetcher memoizes per side, so replacing only the
          // loaded text is insufficient: close old gaps, discard all statuses,
          // and force buildPatchIndex to mint fetchers for the new pinned refs.
          sourceEpoch.current += 1;
          commitGapStores({ expandedGaps: new Map(), sourceStatusByFile: new Map() });
          setReviewSourceRevision((revision) => revision + 1);
        }
        loadedRef.current = next;
        setLoaded(next);
        commitStaleness(loadedStaleness(next));

        // Reconcile durable floor evidence across an immutable bundle replacement.
        const previousController = controllerRef.current;
        const previousPageKey = activeReaderPage(
          previousProjection.reader,
          previousController
        )?.key;
        let reconciled = reconcileProjectionController(
          previousController,
          next,
          previousProjection,
          nextProjection
        );
        if (enterReplacementStory) {
          reconciled = {
            state: {
              ...reconciled.state,
              preferredLens: 'story',
              screen: 'brief',
              focus: initialFocusForReviewScreen('brief'),
              floorCursor: 0,
              briefCursor: 0,
              briefDestinationKey: null,
              attentionCursor: 0,
              attentionRowKey: null,
              routeHistory: [],
              diffSliceKey: null,
              diffHunkKey: null,
              diffRowCursor: 0,
              diffSelectionAnchor: null,
              notice: 'A new Story is ready; review its Brief before continuing',
            },
            entrySliceKey: null,
          };
        }
        const nextPageKey = activeReaderPage(nextProjection.reader, reconciled.state)?.key;
        activeProjectionRef.current = nextProjection;
        readerRef.current = nextProjection.reader;
        if (
          reconciled.entrySliceKey !== null &&
          (previousPageKey !== nextPageKey ||
            previousController.diffSliceKey !== reconciled.state.diffSliceKey)
        ) {
          beginDiffPage(reconciled.entrySliceKey);
        }
        setControllerState(reconciled.state);
      } catch (cause) {
        if (abortController.signal.aborted) return;
        if (mode === 'active' && loadEpochRef.current === epoch) {
          const failure = reviewLoadFailure(cause);
          setError(failure);
          setCacheUpgradePromptOpen(failure.cacheBehind !== null);
        }
      } finally {
        if (activeLoadAbortRef.current === abortController) {
          activeLoadAbortRef.current = null;
        }
        if (loadEpochRef.current === epoch) {
          setLoading(false);
          setRebuildingCache(false);
        }
      }
    },
    [
      branch,
      beginDiffPage,
      cancelActiveLoad,
      commitGapStores,
      commitStaleness,
      installedReviewLoader,
      journal,
      projectionCaches,
      reviewAuxLoader,
      reviewGenerationLoader,
      reviewLoader,
      root,
      setControllerState,
    ]
  );

  const refreshPassive = useCallback(async () => {
    const current = loadedRef.current;
    // An explicit generation owns the foreground. A heartbeat must not advance
    // its epoch while leaving the sidecar alive: that discards the eventual
    // result and can strand the loading screen. The next heartbeat will probe
    // the generation the active load installed.
    if (current === null || activeLoadAbortRef.current !== null) return;
    const epoch = ++loadEpochRef.current;
    const [generationResult, probeResult] = await Promise.allSettled([
      reviewGenerationLoader({ root: current.data.root, branch }),
      worktreeProbeLoader(current.data.root),
    ]);
    if (loadEpochRef.current !== epoch) return;

    if (probeResult.status === 'fulfilled') {
      commitStaleness(stalenessForProbe(current.data, probeResult.value));
    }
    if (generationResult.status === 'rejected') return;

    const generation = generationResult.value;
    const previous = generationRef.current;
    const immutableChanged =
      previous === null
        ? generation.bundle !== null ||
          generation.story !== null ||
          generation.storyInstallation !== null ||
          generation.storyAnchors !== null
        : previous.bundle !== generation.bundle ||
          previous.story !== generation.story ||
          previous.storyInstallation !== generation.storyInstallation ||
          previous.storyAnchors !== generation.storyAnchors;
    if (immutableChanged) {
      await load('installed', previous !== null && previous.bundle !== generation.bundle);
      return;
    }
    if (previous === null) {
      generationRef.current = generation;
      return;
    }

    const journalChanged = previous.journal !== generation.journal;
    const auxChanged = previous.comments !== generation.comments;
    if (!journalChanged && !auxChanged) {
      generationRef.current = generation;
      return;
    }

    const [ledgerResult, auxResult] = await Promise.allSettled([
      journalChanged ? journal.load({ root, branch }) : Promise.resolve(current.ledger),
      auxChanged
        ? (reviewAuxLoader?.({ root, branch }) ??
          loadComments({ root, branch }).then((comments) => ({ comments })))
        : Promise.resolve({ comments: current.comments }),
    ]);
    if (
      loadEpochRef.current !== epoch ||
      ledgerResult.status === 'rejected' ||
      auxResult.status === 'rejected'
    ) {
      return;
    }
    const next: LoadedReview = {
      ...current,
      ledger: ledgerResult.value,
      comments: auxResult.value.comments,
    };
    loadedRef.current = next;
    generationRef.current = generation;
    setLoaded(next);
  }, [
    branch,
    commitStaleness,
    journal,
    load,
    reviewAuxLoader,
    reviewGenerationLoader,
    root,
    worktreeProbeLoader,
  ]);

  useEffect(() => {
    if (disableAutoLoad) return;
    void load();
  }, [disableAutoLoad, load]);

  useEffect(() => () => cancelActiveLoad(), [cancelActiveLoad]);

  useEffect(() => {
    if (disableAutoLoad) return;
    const coordinator = new LiveRefreshCoordinator(refreshPassive, liveRefreshThrottleMs);
    liveRefreshRef.current = coordinator;
    return () => {
      liveRefreshRef.current = null;
      coordinator.dispose();
      loadEpochRef.current += 1;
      sourceEpoch.current += 1;
    };
  }, [disableAutoLoad, liveRefreshThrottleMs, refreshPassive]);

  useEffect(() => {
    onControllerStateChange?.(controller);
  }, [controller, onControllerStateChange]);

  // A screen change unmounts one scrollbox and mounts another, and the new one
  // starts at the top. Without this reset the app's mirror of scrollTop goes on
  // describing the position of a surface that no longer exists.
  //
  // On the diff column that is invisible: entering it re-centers on the selected
  // hunk, which overwrites the stale value before anything reads it. It stops
  // being invisible the moment a second column virtualizes off the same mirror —
  // a stale scrollTop of 3,000 plans the Unassigned mount window three thousand
  // rows below where the reviewer is actually looking, and the screen paints as
  // spacers: blank, silent, and perfectly consistent with itself.
  useEffect(() => {
    // A replacement surface starts at row zero; this is not a rapid scroll on
    // the surviving surface. Routing it through requestDiffScrollTop would classify
    // a deep prior position as a large jump and keep a rapid-scroll mount halo alive
    // on the new screen. Reset the render plan and its burst state atomically.
    if (rapidScrollOverscanTimerRef.current !== null) {
      clearTimeout(rapidScrollOverscanTimerRef.current);
      rapidScrollOverscanTimerRef.current = null;
    }
    pendingDiffScrollTopRef.current = 0;
    plannedDiffScrollTopRef.current = 0;
    pendingDiffRowRef.current = null;
    // Entering a diff page already owns a pending slice alignment. Do not make
    // this internal surface reset look like newer user input and invalidate the
    // entry callback; leaving/replacing an established surface still cancels any
    // semantic restoration retries in flight.
    if (pendingDiffSliceRef.current === null) diffScrollIntentEpochRef.current += 1;
    setDiffScrollTop(0);
    setDiffScrollRevision((revision) => revision + 1);
    setDiffOverscanRows(0);
  }, [controller.screen]);

  useEffect(() => {
    if (disableAutoLoad || liveGen === undefined) return;
    if (lastLiveGenRef.current === liveGen) return;
    lastLiveGenRef.current = liveGen;
    liveRefreshRef.current?.request();
  }, [disableAutoLoad, liveGen]);

  const projection = useMemo(
    () => projectionForLoadedReview(loaded, controller.preferredLens, projectionCaches),
    [controller.preferredLens, loaded, projectionCaches]
  );
  const { reader } = projection;
  const finishObligations = useMemo(
    () =>
      loaded === null || reader === null
        ? []
        : buildFinishObligations({ floor: loaded.data.floor, reader }),
    [loaded, reader]
  );
  // ONE tree and ONE attention queue per projection, shared by rendering, cursor
  // clamping, keyboard activation, pointer activation and route restoration. Any
  // second derivation of either is a chance for the cursor to name a row the
  // pane is not showing.
  const briefTree = useMemo(() => (reader === null ? null : buildBriefTree(reader)), [reader]);
  const briefAttention = useMemo(
    () => (reader === null ? [] : buildBriefAttention({ reader, obligations: finishObligations })),
    [reader, finishObligations]
  );
  const uncertaintyStates = useMemo(
    () =>
      new Map(
        (loaded?.ledger.uncertainties ?? []).map(
          (entry) => [entry.citationId, entry.state] as const
        )
      ),
    [loaded]
  );
  /** The page the reader is on — including the canonical Unassigned page. */
  const currentPage = useMemo(() => {
    return activeReaderPage(reader, controller);
  }, [reader, controller]);
  const semanticAnnotation = useMemo(() => {
    if (
      loaded === null ||
      controller.activeStoryItemId === null ||
      !currentStoryAvailable(loaded) ||
      currentPage === null
    ) {
      return null;
    }
    const storyReader =
      reader?.lens === 'story' ? reader : projectionCaches.story.project(loaded).model;
    const placements =
      storyReader.routeIndex.semanticPlacementsByItemId.get(controller.activeStoryItemId) ?? [];
    const placement =
      placements.find(
        (candidate) =>
          candidate.locationIndex === controller.activeTarget &&
          candidate.destination.pageKey === currentPage.key &&
          candidate.destination.hunkKey === controller.diffHunkKey
      ) ?? null;
    const item = storyReader.routeIndex.itemById.get(controller.activeStoryItemId);
    return placement === null || item === undefined
      ? null
      : semanticPlacementAsAnnotation(item, placement);
  }, [
    controller.activeStoryItemId,
    controller.activeTarget,
    controller.diffHunkKey,
    currentPage,
    loaded,
    projectionCaches,
    reader,
  ]);
  const handleCurrentDiffMeasured = useCallback(
    (layout: CheckpointLayout): void =>
      handleDiffMeasured(
        currentPage === null ? null : `${currentPage.kind}:${currentPage.key}`,
        layout
      ),
    [currentPage?.key, currentPage?.kind, handleDiffMeasured]
  );

  useLayoutEffect(() => {
    onControllerStateCommitted?.(controllerRef.current);
    if (
      controller.screen !== 'walk' &&
      controller.screen !== 'floor-diff' &&
      controller.screen !== 'unassigned'
    ) {
      return;
    }
    const surface = diffScrollSurface;
    if (surface === null) return;
    return bindScrollSurfacePolicy({
      policy: 'app-owned-virtualized',
      surface,
      isAppWritePending: () => pendingDiffScrollTopRef.current !== null,
      publishNativeScroll: () => mirrorNativeDiffViewport(),
      publishViewport: () => mirrorNativeDiffViewport(true),
      flushPublish: (publish) => flushSync(publish),
      viewportReadDelayMs: DIFF_VIEWPORT_READ_COALESCE_MS,
    });
  }, [
    controller.screen,
    currentPage?.key,
    diffScrollSurface,
    mirrorNativeDiffViewport,
    onControllerStateCommitted,
  ]);
  // Key handlers read the immutable reader/index pair through refs, so a key
  // burst sees the pages the burst itself just moved through.
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const finishObligationsRef = useRef(finishObligations);
  finishObligationsRef.current = finishObligations;
  const briefTreeRef = useRef(briefTree);
  briefTreeRef.current = briefTree;
  const briefAttentionRef = useRef(briefAttention);
  briefAttentionRef.current = briefAttention;

  activeProjectionRef.current = projection;

  const switchReviewLens = useCallback(
    (lens: ReaderLens): void => {
      const current = loadedRef.current;
      if (current === null) return;
      if (lens === 'story' && !storyViewable(current)) {
        setControllerState({
          ...controllerRef.current,
          notice:
            current.data.routineStory.issue ??
            `Story is ${current.data.routineStory.status}; regenerate it before switching lenses`,
        });
        return;
      }
      const previous = activeProjectionRef.current;
      const next = projectionForLoadedReview(current, lens, projectionCaches);
      const base = { ...controllerRef.current, preferredLens: lens };
      const reconciled = reconcileProjectionController(base, current, previous, next);
      activeProjectionRef.current = next;
      readerRef.current = next.reader;
      if (reconciled.entrySliceKey !== null) beginDiffPage(reconciled.entrySliceKey);
      setControllerState({
        ...reconciled.state,
        preferredLens: lens,
        notice:
          lens === 'story'
            ? currentStoryAvailable(current)
              ? 'Reviewing the current Story'
              : 'Viewing the STALE Story — read-only'
            : 'Reviewing captured checkpoints',
      });
    },
    [beginDiffPage, projectionCaches, setControllerState]
  );

  const handleLifecycleFailure = useCallback(
    (cause: unknown): void => {
      if (cause instanceof StoryReadWitnessError && cause.routeToStory) {
        switchReviewLens('story');
        setControllerState({
          ...controllerRef.current,
          screen: 'brief',
          focus: initialFocusForReviewScreen('brief'),
          floorCursor: 0,
          routeHistory: [],
          notice: cause.message,
        });
        return;
      }
      setControllerState({
        ...controllerRef.current,
        notice: cause instanceof Error ? cause.message : String(cause),
      });
    },
    [setControllerState, switchReviewLens]
  );

  const handleLifecycleRejection = useCallback(
    (result: Extract<JournalAppendResult, { status: 'rejected' }>): void => {
      if (result.code === 'STALE_STORY') {
        storyReadGenerationRef.current = null;
        handleLifecycleFailure(
          new StoryReadWitnessError(result.message, currentStoryAvailable(loadedRef.current))
        );
        return;
      }
      setControllerState({ ...controllerRef.current, notice: result.message });
    },
    [handleLifecycleFailure, setControllerState]
  );

  useEffect(() => {
    const storyAvailable = currentStoryAvailable(loaded);
    onLensStateChange?.({
      storyAvailable,
      storyViewable: storyViewable(loaded),
      activeLens: reader?.lens ?? 'deterministic',
    });
  }, [loaded, onLensStateChange, reader?.lens]);

  useEffect(() => {
    if (reader?.lens !== 'story') return;
    const generation = loaded?.data.routineStory.generation ?? null;
    if (generation !== null) storyReadGenerationRef.current = generation;
  }, [controller.screen, loaded?.data.routineStory.generation, reader?.lens]);

  // Direct entry from a harness or restored session must land on a real slice.
  useEffect(() => {
    if (
      (controller.screen !== 'floor-diff' &&
        controller.screen !== 'walk' &&
        controller.screen !== 'unassigned') ||
      currentPage === null
    ) {
      return;
    }
    const stops = currentPage.sliceStops;
    const selected = stops.find((stop) => stop.sliceKey === controller.diffSliceKey);
    if (selected !== undefined || stops.length === 0) return;
    // A route may know the hunk before it knows the page-local slice. Preserve
    // that intent; only fall back to the page's first stop for a true direct entry.
    const first = stops.find((stop) => stop.hunkKey === controller.diffHunkKey) ?? stops[0]!;
    beginDiffPage(first.sliceKey);
    const state = controllerRef.current;
    setControllerState({
      ...state,
      focus: state.screen === 'walk' ? state.focus : 'diff',
      diffGrain: 'hunk',
      diffSliceKey: first.sliceKey,
      diffHunkKey: first.hunkKey,
      diffRowCursor: 0,
      diffSelectionAnchor: null,
      notice: null,
    });
  }, [
    beginDiffPage,
    controller.diffHunkKey,
    controller.diffSliceKey,
    controller.screen,
    currentPage,
    setControllerState,
  ]);

  /** Rail click and `,`/`.` both enter here: one file, one first slice, one scroll. */
  const selectDiffFile = useCallback(
    (file: string): void => {
      const state = controllerRef.current;
      const page = activeReaderPage(readerRef.current, state);
      const stop = page?.sliceStops.find((candidate) => candidate.file === file);
      if (stop === undefined) {
        setControllerState({ ...state, notice: `No relevant slice in ${file}` });
        return;
      }
      const currentFile =
        page?.sliceStops.find((candidate) => candidate.sliceKey === state.diffSliceKey)?.file ??
        page?.sliceStops.find((candidate) => candidate.hunkKey === state.diffHunkKey)?.file ??
        null;
      setControllerState({
        ...(currentFile === file ? state : resetReviewCodeHorizontalOffset(state)),
        focus: 'diff',
        diffSliceKey: stop.sliceKey,
        diffHunkKey: stop.hunkKey,
        diffGrain: 'hunk',
        diffRowCursor: 0,
        diffSelectionAnchor: null,
        notice: null,
      });
      showExplicitDiffTarget({ file, sliceKey: stop.sliceKey });
    },
    [setControllerState, showExplicitDiffTarget]
  );

  const selectContextItem = useCallback(
    (index: number): void => {
      const state = controllerRef.current;
      setControllerState({
        ...state,
        focus: 'rail',
        contextItemCursor: Math.max(0, index),
        notice: null,
      });
    },
    [setControllerState]
  );

  const updateLoaded = useCallback((update: (current: LoadedReview) => LoadedReview) => {
    const current = loadedRef.current;
    if (current === null) return;
    const next = update(current);
    loadedRef.current = next;
    setLoaded(next);
  }, []);

  const appendEvent = useCallback(
    async (event: JournalEvent, notice: string) => {
      const result = await journal.append({ root, branch }, event);
      if (result.status === 'rejected') {
        setControllerState({ ...controllerRef.current, notice: result.message });
        return;
      }
      updateLoaded((current) => ({ ...current, ledger: result.ledger }));
      setControllerState({ ...controllerRef.current, notice });
    },
    [branch, journal, root, setControllerState, updateLoaded]
  );

  const appendEvents = useCallback(
    async (events: readonly JournalEvent[], notice: string | null) => {
      const result = await journal.appendMany({ root, branch }, events);
      if (result.status === 'rejected') {
        setControllerState({ ...controllerRef.current, notice: result.message });
        return;
      }
      updateLoaded((current) => ({ ...current, ledger: result.ledger }));
      if (notice !== null) setControllerState({ ...controllerRef.current, notice });
    },
    [branch, journal, root, setControllerState, updateLoaded]
  );

  // Opening a page restores the journal's VISIT semantics. The event is keyed to
  // durable floor threads, never to a generated Part key; replay promotes only
  // unread -> visited and cannot downgrade reviewed/partial/skipped work.
  useEffect(() => {
    if (
      currentPage === null ||
      (currentPage.kind !== 'checkpoint' && currentPage.kind !== 'part') ||
      (controller.screen !== 'floor-diff' && controller.screen !== 'walk')
    ) {
      return;
    }
    const visitKey = `${reader?.lens ?? 'none'}:${currentPage.key}`;
    if (lastVisitedPageRef.current === visitKey) return;
    lastVisitedPageRef.current = visitKey;
    if (currentPage.visitThreadKeys.length === 0) return;
    const ts = nowIso();
    void appendEvents(
      currentPage.visitThreadKeys.map((threadKey) => ({
        type: 'section' as const,
        ts,
        threadKey,
        action: THREAD_DISPOSITION.VISIT,
      })),
      null
    );
  }, [appendEvents, controller.screen, currentPage, reader?.lens]);

  const openTextModal = useCallback((spec: ModalSpec) => setModal(spec), []);
  const currentReviewContext = useCallback((detail?: string): string => {
    const state = controllerRef.current;
    const lens = readerRef.current?.lens ?? 'deterministic';
    const base = storyReviewHelpContext(state.screen, lens, state.focus);
    return detail === undefined ? base : `${detail} · ${base}`;
  }, []);

  const reviewDiff = loaded?.data.reviewDiff ?? null;

  /** root + slug — what lets `buildPatchIndex` attach a tree-source fetcher at all. */
  const patchSource = useMemo(
    () => (loaded === null ? undefined : { root: loaded.data.root, slug: loaded.data.slug }),
    [loaded?.data.root, loaded?.data.slug]
  );
  // A patch is immutable review-generation data. Keep its parsed index above the
  // screen switch so Brief/Walk/Flat Files share it and mutable journal/comment
  // overlay replacements cannot trigger another 10 MiB parse.
  const patchIndex = useMemo(
    () => (reviewDiff === null ? null : buildPatchIndex(reviewDiff, patchSource)),
    [reviewDiff, patchSource, reviewSourceRevision]
  );
  const [patchEnrichmentRevision, setPatchEnrichmentRevision] = useState(0);
  useEffect(() => {
    setPatchEnrichmentRevision(patchIndex?.enrichmentRevision ?? 0);
    if (patchIndex === null) return;
    return patchIndex.subscribeEnrichment(setPatchEnrichmentRevision);
  }, [patchIndex]);
  const activeDiffContent = useMemo<ReviewDiffHorizontalFile[]>(() => {
    if (
      patchIndex === null ||
      currentPage === null ||
      (controller.screen !== 'walk' &&
        controller.screen !== 'floor-diff' &&
        controller.screen !== 'unassigned')
    ) {
      return [];
    }
    return currentPage.projection.layout.files.flatMap((group) => {
      const file = patchIndex.fileDiff(group.file);
      if (file === null) return [];
      const renderedHunkIndices = group.hunks.flatMap((hunk) => {
        const hunkIndex = patchIndex.hunkIndex(hunk);
        if (
          hunkIndex === null ||
          (hunk.status !== 'matched' && !expandedForeignHunks.has(hunk.hunkKey))
        ) {
          return [];
        }
        return [hunkIndex];
      });
      if (renderedHunkIndices.length === 0) return [];
      const expandedKeys = gapStores.expandedGaps.get(group.file);
      return [
        {
          file,
          renderedHunkIndices,
          ...(expandedKeys !== undefined && expandedKeys.size > 0
            ? {
                expansion: {
                  expandedKeys,
                  sourceStatus: gapStores.sourceStatusByFile.get(group.file),
                  side: expansionSide(file),
                },
              }
            : {}),
        },
      ];
    });
  }, [
    controller.screen,
    currentPage,
    expandedForeignHunks,
    gapStores.expandedGaps,
    gapStores.sourceStatusByFile,
    patchIndex,
  ]);
  const activeDiffHorizontalMetrics = useMemo(
    () => measureReviewDiffHorizontalContent(activeDiffContent),
    [activeDiffContent]
  );
  const maxCodeHorizontalOffset = useMemo(
    () =>
      controller.wrapLines
        ? 0
        : maxReviewCodeHorizontalOffsetFromMetrics({
            metrics: activeDiffHorizontalMetrics,
            width,
            layout: controller.diffLayout,
            showLineNumbers: controller.showLineNumbers,
          }),
    [
      activeDiffHorizontalMetrics,
      controller.diffLayout,
      controller.showLineNumbers,
      controller.wrapLines,
      width,
    ]
  );
  codeHorizontalMaxOffsetRef.current = maxCodeHorizontalOffset;

  useLayoutEffect(() => {
    const reconciled = clampReviewCodeHorizontalOffset(
      controllerRef.current,
      maxCodeHorizontalOffset
    );
    if (reconciled === controllerRef.current) return;
    controllerRef.current = reconciled;
    setController(reconciled);
  }, [maxCodeHorizontalOffset]);
  const patchTextByFile = useMemo(
    () => (reviewDiff === null ? new Map<string, string>() : splitPatchByFile(reviewDiff)),
    [reviewDiff]
  );

  /** Write the file's gap set and fetch its source once. The single writer. */
  const applyGaps = useCallback(
    (file: string, gaps: ReadonlySet<string>, diff: DiffFile, opened: boolean) => {
      const epoch = sourceEpoch.current;
      void applyFileGaps({
        stores: gapStoresRef.current,
        file,
        gaps,
        opened,
        fetcher: diff.sourceFetcher,
        side: expansionSide(diff),
        onStores: commitGapStores,
        onError: (message) =>
          setControllerState({ ...controllerRef.current, notice: `✗ ${message}` }),
        isCurrent: () => sourceEpoch.current === epoch,
      });
    },
    [commitGapStores, setControllerState]
  );

  const toggleGap = useCallback(
    (file: string, gap: string, diff: DiffFile) => {
      const open = new Set(gapStoresRef.current.expandedGaps.get(file) ?? []);
      const opened = !open.has(gap);
      if (opened) open.add(gap);
      else open.delete(gap);
      applyGaps(file, open, diff, opened);
    },
    [applyGaps]
  );

  /**
   * `z` expands the next hidden block and `Z` applies the same operation to
   * every rendered hunk in the current file card. Both refuse to target blocks
   * outside the active page.
   */
  const expandHidden = useCallback(
    (wholeFile: boolean) => {
      const current = loadedRef.current;
      const hunkKey = controllerRef.current.diffHunkKey;
      if (current === null || hunkKey === null || patchIndex === null) return;

      const floor = current.data.floor;
      const item = floor.coverage.items.find((candidate) => candidate.hunkKey === hunkKey);
      if (item === undefined) return;
      const patch = patchIndex;
      const diff = patch.fileDiff(item.file);
      if (diff === null) return;

      // `z` scans the WHOLE FILE CARD, because that is what the reader renders:
      // every parent hunk of every file the checkpoint touched. A `z` that could
      // only see the cursor's own hunk would refuse to open the collapsed gap
      // sitting two rows below it.
      const selectedPage = activeReaderPage(readerRef.current, controllerRef.current);
      const checkpointKey = checkpointKeyForHunk(floor, hunkKey);
      const page =
        selectedPage?.projection.layout ??
        (checkpointKey === null ? null : projectCheckpointPage({ floor, checkpointKey }));
      const card = page?.files.find((group) => group.file === item.file);
      if (card === undefined) return;

      const hunks = diff.metadata?.hunks ?? [];
      const patchHunks: PatchGapHunk[] = hunks.map((hunk) => ({
        space: 'patch',
        collapsedBefore: hunk.collapsedBefore ?? 0,
      }));
      const display: FloorDisplayHunk[] = card.hunks.map((hunk) => {
        const index = patch.hunkIndex(hunk);
        return {
          space: 'floor',
          hunkKey: hunk.hunkKey,
          status: hunk.status,
          patchHunkIndex: index,
          collapsedBefore: index === null ? 0 : (patchHunks[index]?.collapsedBefore ?? 0),
        };
      });
      const trailingLines = diff.metadata === undefined ? 0 : trailingCollapsedLines(diff.metadata);
      const trailing =
        trailingLines > 0 && hunks.length > 0
          ? { key: gapKey('trailing', hunks.length - 1), patchHunkIndex: hunks.length - 1 }
          : null;
      const open = gapStoresRef.current.expandedGaps.get(item.file) ?? new Set<string>();

      if (wholeFile) {
        const plan = planFileCollapseState({
          file: item.file,
          hunks: display,
          patchHunks,
          hasTrailingGap: trailing !== null,
          hasSource: diff.sourceFetcher !== undefined,
          expandedGaps: gapStoresRef.current.expandedGaps,
          expandedForeignHunks: expandedForeignRef.current,
        });
        if (plan.action === 'none') {
          setControllerState({
            ...controllerRef.current,
            notice: plan.gapsUnavailable
              ? 'This review has no pinned source; hidden context cannot be fetched'
              : 'Nothing hidden in this file',
          });
          return;
        }
        commitExpandedForeign(plan.expandedForeignHunks);
        applyGaps(
          item.file,
          plan.expandedGaps.get(item.file) ?? new Set(),
          diff,
          plan.action === 'open'
        );
        return;
      }

      const target = selectVisibleCollapseTarget(
        display,
        item.hunkKey,
        { gaps: open, foreignHunks: expandedForeignRef.current },
        trailing
      );
      if (target === null) {
        setControllerState({
          ...controllerRef.current,
          notice:
            diff.sourceFetcher === undefined && trailing !== null
              ? 'This review has no pinned source; hidden context cannot be fetched'
              : 'No hidden context left in this file',
        });
        return;
      }
      showCollapseTarget(target);
      // A collapsed foreign parent wins before its own leading gap — that gap row
      // does not exist until the parent's body is on screen.
      if (target.kind === 'foreign-hunk') {
        toggleForeignHunk(target.hunkKey);
        return;
      }
      applyGaps(item.file, new Set([...open, target.key]), diff, true);
    },
    [
      applyGaps,
      commitExpandedForeign,
      patchIndex,
      setControllerState,
      showCollapseTarget,
      toggleForeignHunk,
    ]
  );

  /**
   * The page a hunk lives on — for ENTRY only (Brief / Flat Files activation, and
   * comment routing), never for paging. See `pageIndexForHunk`.
   */
  const pageIndexOf = useCallback((hunkKey: string): number | null => {
    const reader = readerRef.current;
    const loaded = loadedRef.current;
    if (reader === null || loaded === null) return null;
    return pageIndexForHunk(reader, hunkKey);
  }, []);

  /**
   * The anchor for the row the reviewer's cursor is on — the authoring path the
   * deterministic route never had.
   *
   * The cursor indexes `changedRowsForFloorHunk`, which is derived from the FLOOR's
   * units; the line bodies (which the hash covers) come from the PATCH. Both are
   * walked in the same order, so the cursor's index means the same row in both — and
   * that is asserted, not assumed, in `commentAnchor.test.ts`.
   */
  const cursorLines = useCallback(
    (
      state: ReviewControllerState
    ): { file: string; hunkKey: string; threadKey?: string; lines: AnchorPick[] } | null => {
      const loaded = loadedRef.current;
      if (loaded === null || state.diffHunkKey === null) return null;
      const item = loaded.data.floor.coverage.items.find(
        (candidate) => candidate.hunkKey === state.diffHunkKey
      );
      if (item === undefined) return null;
      const filePatch = patchTextByFile.get(item.file);
      if (filePatch === undefined) return null;

      // The cursor indexes `changedRowsForFloorHunk` -- rows derived from the FLOOR's
      // units, which is what `ROW n/m` counts and what `j`/`k` walks. The BODIES (which
      // the content hash covers) only exist in the patch. Those are two different lists
      // and they are NOT the same length: the floor's units cover only the rows a
      // checkpoint OWNS, while the patch hunk carries every changed row in it. Indexing
      // the patch by the cursor's number therefore anchors the comment on a different
      // line than the one under the cursor -- silently, and off by however many rows
      // another checkpoint happens to own above it.
      //
      // So join them on (side, line), which is the identity both agree on.
      const bodies = new Map(
        listHunkChangedLines(filePatch, {
          newStart: item.new_start ?? null,
          oldStart: item.old_start ?? null,
        }).map((pick) => [`${pick.side}\u0000${pick.line}`, pick.body])
      );
      // Page-scoped, so the cursor's index means the row the cursor is ON.
      const selectedPage = activeReaderPage(readerRef.current, state);
      const threadKey =
        selectedPage?.kind === 'checkpoint'
          ? selectedPage.threadKey
          : selectedPage?.kind === 'part' && selectedPage.visitThreadKeys.length === 1
            ? selectedPage.visitThreadKeys[0]
            : undefined;
      const owned =
        selectedPage === null
          ? changedRowsForFloorHunk(item)
          : rowsOfProjectedHunk(selectedPage.projection, item.hunkKey);
      const lines = owned.flatMap((row) => {
        const body = bodies.get(`${row.side}\u0000${row.line}`);
        return body === undefined ? [] : [{ side: row.side, line: row.line, body }];
      });
      return {
        file: item.file,
        hunkKey: item.hunkKey,
        ...(threadKey !== undefined ? { threadKey } : {}),
        lines,
      };
    },
    [patchTextByFile]
  );

  const rowAnchorForCursor = useCallback(
    async (state: ReviewControllerState): Promise<RowAnchorResult | null> => {
      const at = cursorLines(state);
      if (at === null) return null;
      if (state.diffGrain === 'hunk') {
        const loaded = loadedRef.current;
        const page = activeReaderPage(readerRef.current, state);
        const item = loaded?.data.floor.coverage.items.find(
          (candidate) => candidate.hunkKey === at.hunkKey
        );
        const slice = page?.projection.layout.files
          .flatMap((file) => file.slices)
          .find((candidate) => candidate.sliceKey === state.diffSliceKey);
        const filePatch =
          loaded === null || loaded === undefined ? undefined : patchTextByFile.get(at.file);
        const lines =
          item === undefined || slice === undefined || filePatch === undefined
            ? at.lines
            : listSliceChangedLines(
                filePatch,
                { newStart: item.new_start ?? null, oldStart: item.old_start ?? null },
                slice.unit
              );
        const pick = pickAnchorFromLines(lines);
        if (pick === null) return null;
        return buildRowCommentAnchor({
          file: at.file,
          hunkKey: at.hunkKey,
          ...(at.threadKey !== undefined ? { threadKey: at.threadKey } : {}),
          lines,
          cursor: lines.indexOf(pick),
          selectionAnchor: null,
        });
      }
      return buildRowCommentAnchor({
        file: at.file,
        hunkKey: at.hunkKey,
        ...(at.threadKey !== undefined ? { threadKey: at.threadKey } : {}),
        lines: at.lines,
        cursor: state.diffRowCursor,
        selectionAnchor: state.diffSelectionAnchor,
      });
    },
    [cursorLines, patchTextByFile]
  );

  /** Center the semantic cursor against the currently committed measured stream. */
  const recenterDiff = useCallback((): void => {
    const state = controllerRef.current;
    const surface = walkScrollRef.current;
    const layout = diffLayoutRef.current;
    if (surface === null || layout === null || state.diffHunkKey === null) {
      setControllerState({ ...state, notice: 'Current screen has no measured diff cursor' });
      return;
    }

    const row = state.diffGrain === 'row' ? cursorLines(state)?.lines[state.diffRowCursor] : null;
    const target =
      row === null || row === undefined
        ? layout.byHunkKey.get(state.diffHunkKey)
        : layout.bySourceAnchorKey.get(`hunk:${state.diffHunkKey}:${row.side}:${row.line}`);
    if (target === undefined) {
      setControllerState({
        ...state,
        notice: 'Selected diff cursor has no measured center target',
      });
      return;
    }

    const bounds: ScrollBounds = {
      viewport: Math.max(1, surface.viewport?.height ?? 1),
      content: Math.max(0, surface.scrollHeight),
    };
    const current = clampScroll(pendingDiffScrollTopRef.current ?? surface.scrollTop, bounds);
    const next = scrollToCenter(target, bounds);
    requestDiffScrollTop(next, current, bounds.viewport);
  }, [cursorLines, requestDiffScrollTop, setControllerState]);

  /**
   * The mouse, into the SAME controller state the keys write.
   *
   * `DiffSlice` exposes `onRowMouseDown`/`onRowMouseDrag`; both
   * handlers resolve the clicked row to an index in `cursorLines` — the one list
   * the cursor walks, `v` spans and `Y` copies — so a click and a `j` cannot end up
   * meaning different things.
   */
  const rowIndexOfPick = useCallback(
    (pick: RowLine | null): number | null => {
      if (pick === null) return null;
      const at = cursorLines(controllerRef.current);
      if (at === null) return null;
      const index = at.lines.findIndex((row) => row.side === pick.side && row.line === pick.line);
      return index === -1 ? null : index;
    },
    [cursorLines]
  );

  const onRowMouseDown = useCallback(
    (pick: RowLine | null): void => {
      const index = rowIndexOfPick(pick);
      if (index === null) return;
      // A click DESCENDS to the row it landed on, and clears any span — the same
      // state Enter reaches, arrived at by pointing instead of typing.
      setControllerState({
        ...controllerRef.current,
        focus: 'diff',
        diffGrain: 'row',
        diffRowCursor: index,
        diffSelectionAnchor: null,
        notice: null,
      });
    },
    [rowIndexOfPick, setControllerState]
  );

  const onRowMouseDrag = useCallback(
    (pick: RowLine | null): void => {
      const index = rowIndexOfPick(pick);
      if (index === null) return;
      const state = controllerRef.current;
      // A drag IS `v`: the row the drag started on becomes the anchor and the row
      // under the pointer becomes the head. One selection model, two gestures.
      setControllerState({
        ...state,
        focus: 'diff',
        diffGrain: 'row',
        diffSelectionAnchor: state.diffSelectionAnchor ?? state.diffRowCursor,
        diffRowCursor: index,
        notice: null,
      });
    },
    [rowIndexOfPick, setControllerState]
  );

  const stopDiffDragEdge = useCallback((): void => {
    diffDragEdgeDirectionRef.current = null;
    if (diffDragEdgeTimerRef.current !== null) clearTimeout(diffDragEdgeTimerRef.current);
    diffDragEdgeTimerRef.current = null;
  }, []);

  const advanceDiffDragSelection = useCallback(
    (direction: DiffDragEdgeDirection): boolean => {
      const state = controllerRef.current;
      if (state.focus !== 'diff' || state.diffGrain !== 'row') return false;
      const at = cursorLines(state);
      if (at === null || at.lines.length === 0) return false;
      const nextIndex = Math.max(0, Math.min(at.lines.length - 1, state.diffRowCursor + direction));
      if (nextIndex === state.diffRowCursor) return false;
      const row = at.lines[nextIndex]!;
      setControllerState({
        ...state,
        diffSelectionAnchor: state.diffSelectionAnchor ?? state.diffRowCursor,
        diffRowCursor: nextIndex,
        notice: null,
      });
      // This is the same app-owned measured reveal path keyboard row movement
      // uses. It plans React's virtual window before writing the native surface.
      showDiffRow({ hunkKey: at.hunkKey, row });
      return true;
    },
    [cursorLines, setControllerState, showDiffRow]
  );

  const handleDiffDragEdge = useCallback(
    (direction: DiffDragEdgeDirection | null): void => {
      if (direction === null) {
        stopDiffDragEdge();
        return;
      }
      if (diffDragEdgeDirectionRef.current === direction && diffDragEdgeTimerRef.current !== null) {
        return;
      }
      stopDiffDragEdge();
      diffDragEdgeDirectionRef.current = direction;
      const tick = (): void => {
        const activeDirection = diffDragEdgeDirectionRef.current;
        if (activeDirection === null || !advanceDiffDragSelection(activeDirection)) {
          stopDiffDragEdge();
          return;
        }
        diffDragEdgeTimerRef.current = setTimeout(tick, 50);
      };
      tick();
    },
    [advanceDiffDragSelection, stopDiffDragEdge]
  );

  useEffect(() => stopDiffDragEdge, [stopDiffDragEdge]);

  const openFinishObligation = useCallback(
    /**
     * `base` lets a caller record the selection that launched the route before
     * the push captures it — the Brief's attention queue needs that, because
     * `pushReviewRoute` snapshots the ORIGIN state. Finish passes nothing and
     * routes from the live controller state as before.
     */
    (obligation: FinishObligation, base?: ReviewControllerState): void => {
      const state = base ?? controllerRef.current;
      const route = obligation.route;
      if (route.kind === 'recovery') {
        setControllerState({ ...state, notice: route.message });
        return;
      }
      if (route.kind === 'comments') {
        const comments = loadedRef.current?.comments.comments ?? [];
        const commentCursor = Math.max(
          0,
          comments.findIndex(
            (comment) => comment.author === 'reviewer' && comment.status === 'open'
          )
        );
        setControllerState(
          pushReviewRoute(state, {
            ...state,
            screen: 'comments',
            commentCursor,
            notice: null,
          })
        );
        return;
      }
      if (route.kind === 'unassigned') {
        const first = readerRef.current?.auxiliaryPage.sliceStops[0] ?? null;
        beginDiffPage(first?.sliceKey ?? null);
        setControllerState(
          pushReviewRoute(state, {
            ...state,
            screen: 'unassigned',
            focus: 'diff',
            diffGrain: 'hunk',
            diffSliceKey: first?.sliceKey ?? null,
            diffHunkKey: first?.hunkKey ?? null,
            diffRowCursor: 0,
            diffSelectionAnchor: null,
            notice: null,
          })
        );
        return;
      }

      const page = readerRef.current?.pages[route.pageIndex];
      if (page === undefined) {
        setControllerState({ ...state, notice: 'Refresh the review to recover this obligation.' });
        return;
      }
      const first = page.sliceStops[0] ?? null;
      beginDiffPage(first?.sliceKey ?? null);
      if (page.kind === 'checkpoint') {
        setControllerState(
          pushReviewRoute(state, {
            ...state,
            screen: 'floor-diff',
            focus: route.contextItemIndex === undefined ? 'diff' : 'rail',
            readerPage: route.pageIndex,
            contextItemCursor: route.contextItemIndex ?? 0,
            diffGrain: 'hunk',
            diffSliceKey: first?.sliceKey ?? null,
            diffHunkKey: first?.hunkKey ?? null,
            diffRowCursor: 0,
            diffSelectionAnchor: null,
            notice: null,
          })
        );
        return;
      }

      setControllerState(
        pushReviewRoute(state, {
          ...state,
          screen: 'walk',
          focus: 'rail',
          readerPage: route.pageIndex,
          activeAct: page.actIndex,
          activePart: page.partIndex,
          activeItem: 0,
          activeTarget: 0,
          diffGrain: 'hunk',
          diffSliceKey: first?.sliceKey ?? null,
          diffHunkKey: first?.hunkKey ?? null,
          diffRowCursor: 0,
          diffSelectionAnchor: null,
          notice: null,
        })
      );
    },
    [beginDiffPage, setControllerState]
  );

  const executeCommand = useCallback(
    (command: ReviewControllerCommand) => {
      const current = loadedRef.current;
      const state = controllerRef.current;
      const ownerViolation = reviewCommandOwnerViolation(
        state,
        command,
        activeReaderPage(readerRef.current, state)
      );
      if (ownerViolation !== null) {
        setControllerState({ ...state, notice: ownerViolation });
        return;
      }
      // The stale Story lens is READ-ONLY. Suppressed in presentation too, but
      // this executor gate is the defense the journal transport does not have:
      // finding/prompt/uncertainty dispositions are not story-generation-scoped,
      // so a stale-lens mutation would append cleanly. Comments on exact-match
      // current rows remain the ONE permitted persisted action.
      if (
        readerRef.current?.staleProjection === true &&
        (command.kind === 'story-item-action' ||
          command.kind === 'mark-reviewed' ||
          command.kind === 'mark-inspected' ||
          command.kind === 'finish-complete' ||
          command.kind === 'finish-partial' ||
          command.kind === 'resume')
      ) {
        setControllerState({
          ...state,
          notice: 'Read-only stale Story — switch to the captured-checkpoint lens to act',
        });
        return;
      }
      onCommandExecuted?.(command, controllerRef.current);
      if (command.kind === 'none') return;
      if (command.kind === 'quit') {
        cancelActiveLoad();
        onExit();
        return;
      }
      if (command.kind === 'refresh') {
        if (disableAutoLoad) {
          setControllerState({
            ...controllerRef.current,
            notice: 'Refresh disabled in the acceptance fixture',
          });
        } else {
          void load();
        }
        return;
      }
      if (command.kind === 'help') {
        helpSelectionRef.current = 0;
        setHelpSelection(0);
        setHelpOpen(true);
        return;
      }
      if (current === null) return;
      if (command.kind === 'move-list') {
        const state = controllerRef.current;
        if (state.screen === 'brief') {
          // ONE branch for both lenses, split only by which PANE holds focus.
          // Cursor and key move together on every step: leaving the numeric
          // cursor to travel alone means reconciliation resolves a stale key and
          // yanks the selection back the next time the data changes.
          if (state.focus === BRIEF_OVERVIEW_FOCUS) {
            const rows = briefAttentionRef.current;
            const attentionCursor = clamp(state.attentionCursor + command.direction, rows.length);
            setControllerState({
              ...state,
              attentionCursor,
              attentionRowKey: rows[attentionCursor]?.key ?? null,
            });
          } else {
            const destinations = briefTreeRef.current?.destinations ?? [];
            const briefCursor = clamp(state.briefCursor + command.direction, destinations.length);
            setControllerState({
              ...state,
              briefCursor,
              briefDestinationKey: destinations[briefCursor]?.key ?? null,
            });
          }
        } else if (state.screen === 'comments') {
          setControllerState({
            ...state,
            commentCursor: clamp(
              state.commentCursor + command.direction,
              current.comments.comments.length
            ),
          });
        } else if (state.screen === 'flat-files') {
          setControllerState({
            ...state,
            flatFileCursor: clamp(
              state.flatFileCursor + command.direction,
              // The FILTERED list. Clamping to the unfiltered length walks the cursor
              // off the bottom of what is on screen.
              filterFlatFiles(current.data.floor, state.fileFilter).length
            ),
          });
        } else if (state.screen === 'finish') {
          setControllerState({
            ...state,
            finishCursor: clamp(
              state.finishCursor + command.direction,
              finishObligationsRef.current.length
            ),
            notice: null,
          });
        }
        return;
      }
      if (command.kind === 'move-brief-attention') {
        // Selection ONLY — no routing, no beginDiffPage. Focus moves to the
        // overview pane so the highlight is visible and the follow-up `↵` opens
        // the selection through the existing overview-focus branch.
        const state = controllerRef.current;
        const resolved = resolveBriefAttentionIntent(
          briefAttentionRef.current,
          state.attentionRowKey,
          state.attentionCursor,
          command.direction === 1 ? 'next' : 'previous'
        );
        if (resolved === null) {
          setControllerState({ ...state, notice: 'No unresolved Attention items' });
          return;
        }
        setControllerState({
          ...state,
          attentionCursor: resolved.index,
          attentionRowKey: resolved.row.key,
          focus: BRIEF_OVERVIEW_FOCUS,
          notice: null,
        });
        return;
      }
      if (command.kind === 'activate-brief-attention') {
        const state = controllerRef.current;
        const rows = briefAttentionRef.current;
        const resolved = resolveBriefAttentionIntent(
          rows,
          state.attentionRowKey,
          state.attentionCursor,
          command.intent
        );
        if (resolved === null) {
          setControllerState({ ...state, notice: 'No unresolved Attention items' });
          return;
        }
        // Identity FIRST, then route. `pushReviewRoute` snapshots the origin
        // state, so a route entered before the selection is recorded leaves Back
        // restoring the row the reviewer left from — and with a null key, the
        // next `n` would reopen the same first row forever.
        const seeded: ReviewControllerState = {
          ...state,
          attentionCursor: resolved.index,
          attentionRowKey: resolved.row.key,
          notice: null,
        };
        const destination = resolved.row.destination;
        if (destination.kind === 'obligation') {
          openFinishObligation(destination.obligation, seeded);
          return;
        }
        const activeReader = readerRef.current;
        if (activeReader === null) {
          setControllerState(seeded);
          return;
        }
        const routed = activateBriefAttentionItem(seeded, activeReader, destination.itemId);
        if (
          routed.screen === 'walk' ||
          routed.screen === 'floor-diff' ||
          routed.screen === 'unassigned'
        ) {
          beginDiffPage(routed.diffSliceKey);
        }
        setControllerState(routed);
        return;
      }
      if (command.kind === 'activate') {
        const state = controllerRef.current;
        let hunkKey: string | null = null;

        // ONE Brief activation path, for every destination on both lenses.
        //
        // `BriefTree.destinations` is the list the pane renders, so the row
        // under the cursor and the thing that opens are the same object by
        // construction. Per-destination branches — a route list, a row matched by
        // comparing the cursor to a computed row index, a thread-to-checkpoint
        // guess — each get their own idea of what the cursor meant.
        const tree = briefTreeRef.current;
        if (state.screen === 'brief' && tree !== null && readerRef.current !== null) {
          const activated = activateBriefDestination(
            state,
            readerRef.current,
            tree,
            state.briefCursor
          );
          if (
            activated.screen === 'walk' ||
            activated.screen === 'floor-diff' ||
            activated.screen === 'unassigned'
          ) {
            beginDiffPage(activated.diffSliceKey);
          }
          setControllerState(activated);
          return;
        }

        if (state.screen === 'comments') {
          const comment = current.comments.comments[state.commentCursor];
          // Route through the ANCHOR, which
          // the engine's re-anchor ladder already resolved off floor + patch alone.
          hunkKey = comment?.position?.hunkKey ?? null;
          if (hunkKey === null) {
            setControllerState({
              ...state,
              notice:
                comment === undefined
                  ? 'No comment is selected'
                  : 'This comment is unanchored — it has no code to open',
            });
            return;
          }
        }
        hunkKey ??= floorHunkForActivation({ floor: current.data.floor, state });
        if (hunkKey === null) {
          setControllerState({ ...state, notice: 'Selected row has no retained diff' });
          return;
        }
        const readerPage = pageIndexOf(hunkKey);
        if (readerPage === null) {
          setControllerState({
            ...state,
            notice: unavailableEvidenceNotice(readerRef.current, hunkKey),
          });
          return;
        }
        const sliceKey =
          sliceStopsOfPage(readerRef.current, readerPage).find((stop) => stop.hunkKey === hunkKey)
            ?.sliceKey ?? null;
        const activeReader = readerRef.current;
        const destinationPage = activeReader?.pages[readerPage];
        if (activeReader === null || destinationPage === undefined) {
          setControllerState({
            ...state,
            notice: 'Selected evidence is not represented on the active review lens',
          });
          return;
        }
        beginDiffPage(sliceKey);
        setControllerState({
          ...activateReaderDestination(state, activeReader, {
            kind: 'page',
            pageIndex: readerPage,
            pageKey: destinationPage.key,
            hunkKey,
            sliceKey,
          }),
          // Flat Files and Comments are code-entry routes. Keep the destination
          // page's lens/screen identity, but put the reviewer on its diff rather
          // than on a Story rail item.
          focus: 'diff',
        });
        return;
      }
      if (command.kind === 'move-diff-slice') {
        const state = controllerRef.current;
        const stops = activeSliceStops(readerRef.current, state);
        if (stops.length === 0) {
          setControllerState({ ...state, notice: 'This review page has no retained slices' });
          return;
        }
        const at = Math.max(
          0,
          state.diffSliceKey !== null
            ? stops.findIndex((stop) => stop.sliceKey === state.diffSliceKey)
            : stops.findIndex((stop) => stop.hunkKey === state.diffHunkKey)
        );
        const next = clamp(at + command.direction, stops.length);
        const stop = stops[next]!;
        const nextState: ReviewControllerState = {
          ...state,
          diffGrain: 'hunk',
          diffSliceKey: stop.sliceKey,
          diffHunkKey: stop.hunkKey,
          diffRowCursor: 0,
          diffSelectionAnchor: null,
          notice: null,
        };
        const activePage = activeReaderPage(readerRef.current, state);
        const loadedForSync = loadedRef.current;
        const syncReader =
          readerRef.current?.lens === 'story'
            ? readerRef.current
            : loadedForSync !== null && currentStoryAvailable(loadedForSync)
              ? projectionCaches.story.project(loadedForSync).model
              : null;
        setControllerState(
          activePage === null || syncReader === null
            ? nextState
            : synchronizeRailToTarget(nextState, syncReader, {
                pageKey: activePage.key,
                hunkKey: stop.hunkKey,
              })
        );
        showExplicitDiffTarget({ sliceKey: stop.sliceKey });
        return;
      }
      if (command.kind === 'comment') {
        const state = controllerRef.current;
        // Comments in the shared reader are anchored to the code row/range the
        // reviewer is actually reading. Narrative-v2 item placements are not part
        // of the Story contract and must not remain as a hidden authoring path.
        void rowAnchorForCursor(state).then((resolved) => {
          if (resolved === null) {
            setControllerState({
              ...controllerRef.current,
              notice: 'This row has no anchorable content',
            });
            return;
          }
          openTextModal({
            title:
              resolved.anchor.kind === 'DIFF_RANGE'
                ? `Comment on ${resolved.anchor.file}:${resolved.anchor.line}–${resolved.anchor.endLine}`
                : resolved.anchor.kind === 'DIFF_LINE'
                  ? `Comment on ${resolved.anchor.file}:${resolved.anchor.line}`
                  : 'Add review comment',
            context: currentReviewContext(
              resolved.anchor.kind === 'DIFF_RANGE'
                ? `${resolved.anchor.file}:${resolved.anchor.line}–${resolved.anchor.endLine}`
                : resolved.anchor.kind === 'DIFF_LINE'
                  ? `${resolved.anchor.file}:${resolved.anchor.line}`
                  : 'Selected review item'
            ),
            guidance: ['Describe the issue and the change or explanation you need.'],
            placeholder: 'Write a review comment…',
            submitLabel: 'Add comment',
            required: true,
            emptyMessage: 'Write a comment before saving.',
            onText: (body) => {
              setModal(null);
              void commentSidecar
                .add({ root, branch }, { body, anchor: resolved.anchor })
                .then((comments) => {
                  updateLoaded((value) => ({ ...value, comments }));
                  setControllerState({
                    ...controllerRef.current,
                    diffSelectionAnchor: null,
                    notice:
                      resolved.droppedRows > 0
                        ? `Comment filed on ${resolved.anchor.kind === 'DIFF_RANGE' ? 'the selected add rows' : 'the row'} — ${resolved.droppedRows} row(s) on the other side were not included`
                        : 'Comment filed',
                  });
                })
                .catch((cause) =>
                  setControllerState({ ...controllerRef.current, notice: String(cause) })
                );
            },
          });
        });
        return;
      }
      if (command.kind === 'story-item-action') {
        const item = readerRef.current?.routeIndex.itemById.get(command.itemId);
        if (item === undefined) {
          setControllerState({
            ...controllerRef.current,
            notice: 'This Story item is no longer available',
          });
          return;
        }
        if (command.action === 'DISMISS') {
          openTextModal({
            title: 'Dismiss with a recorded reason',
            context: currentReviewContext(item.shortText),
            guidance: ['Explain why this item does not require a change.'],
            placeholder: 'Record the reason…',
            submitLabel: 'Dismiss item',
            required: true,
            emptyMessage: 'Record a reason before dismissing this item.',
            onText: (reason) => {
              setModal(null);
              const event = journalEventForStoryItem(item, command.action, reason.trim());
              if (event !== null) void appendEvent(event, 'Story item dismissed');
            },
          });
          return;
        }
        const event = journalEventForStoryItem(item, command.action);
        if (event === null) {
          setControllerState({
            ...controllerRef.current,
            notice: `${command.action.toLowerCase()} is unavailable for this Story item`,
          });
          return;
        }
        void appendEvent(event, `Story item ${command.action.toLowerCase()}`);
        return;
      }
      if (command.kind === 'context-item-action') {
        const state = controllerRef.current;
        const page = activeReaderPage(readerRef.current, state);
        const ids = checkpointUncertaintyIds(
          current.data.floor,
          page?.kind === 'checkpoint' ? page : null
        );
        const citationId = ids[Math.min(state.contextItemCursor, Math.max(0, ids.length - 1))];
        if (citationId === undefined) {
          setControllerState({ ...state, notice: 'No captured uncertainty is selected' });
          return;
        }
        if (command.action === 'DISMISS') {
          setControllerState({
            ...state,
            notice: 'Captured uncertainties cannot be dismissed — acknowledge or resolve',
          });
          return;
        }
        const currentState = uncertaintyState(current.ledger, citationId);
        if (command.action === 'REOPEN' && currentState === UNCERTAINTY_STATE.OPEN) {
          setControllerState({ ...state, notice: 'Captured uncertainty is already open' });
          return;
        }
        const action =
          command.action === 'ACKNOWLEDGE'
            ? UNCERTAINTY_DISPOSITION.ACKNOWLEDGE
            : command.action === 'RESOLVE'
              ? UNCERTAINTY_DISPOSITION.RESOLVE
              : UNCERTAINTY_DISPOSITION.REOPEN;
        void appendEvent(
          { type: 'uncertainty', ts: nowIso(), citationId, action },
          `uncertainty ${action.toLowerCase()}`
        );
        return;
      }
      if (command.kind === 'acknowledge-all-context') {
        const state = controllerRef.current;
        const page = activeReaderPage(readerRef.current, state);
        const all = checkpointUncertaintyIds(
          current.data.floor,
          page?.kind === 'checkpoint' ? page : null
        );
        const open = all.filter(
          (citationId) => uncertaintyState(current.ledger, citationId) === UNCERTAINTY_STATE.OPEN
        );
        if (open.length === 0) {
          setControllerState({ ...state, notice: 'No open uncertainties on this checkpoint' });
          return;
        }
        openTextModal({
          title: `Acknowledge ${open.length} open ${open.length === 1 ? 'uncertainty' : 'uncertainties'}`,
          context: currentReviewContext(page?.label ?? 'Captured checkpoint'),
          guidance: ['Record why these uncertainties are understood and safe to carry.'],
          placeholder: 'Explain your reasoning…',
          submitLabel: 'Acknowledge',
          required: true,
          emptyMessage: 'Record a reason before acknowledging these uncertainties.',
          onText: (text) => {
            setModal(null);
            const reason = text.trim();
            if (reason.length === 0) {
              setControllerState({
                ...controllerRef.current,
                notice: 'A reason is required — nothing recorded',
              });
              return;
            }
            const ts = nowIso();
            void appendEvents(
              open.map((citationId) => ({
                type: 'uncertainty' as const,
                ts,
                citationId,
                action: UNCERTAINTY_DISPOSITION.ACKNOWLEDGE,
                reason,
              })),
              `acknowledged ${open.length} open ${open.length === 1 ? 'uncertainty' : 'uncertainties'}`
            );
          },
        });
        return;
      }
      if (command.kind === 'set-thread-disposition') {
        const state = controllerRef.current;
        const page = activeReaderPage(readerRef.current, state);
        if (page?.kind !== 'checkpoint') {
          setControllerState({ ...state, notice: 'No checkpoint thread is selected' });
          return;
        }
        const action =
          command.action === 'SKIP' ? THREAD_DISPOSITION.SKIP : THREAD_DISPOSITION.PARTIAL;
        openTextModal({
          title:
            action === THREAD_DISPOSITION.SKIP
              ? 'Skip this checkpoint thread'
              : 'Mark this checkpoint thread partial',
          context: currentReviewContext(page.label),
          guidance: ['Record the reason so later reviewers can understand this decision.'],
          placeholder: 'Explain your reasoning…',
          submitLabel: action === THREAD_DISPOSITION.SKIP ? 'Skip checkpoint' : 'Mark partial',
          required: true,
          emptyMessage: 'Record a reason before changing this checkpoint state.',
          onText: (text) => {
            setModal(null);
            const reason = text.trim();
            if (reason.length === 0) {
              setControllerState({
                ...controllerRef.current,
                notice: 'A reason is required — nothing recorded',
              });
              return;
            }
            void appendEvent(
              { type: 'section', ts: nowIso(), threadKey: page.threadKey, action, reason },
              action === THREAD_DISPOSITION.SKIP
                ? 'checkpoint thread skipped'
                : 'checkpoint thread partial'
            );
          },
        });
        return;
      }
      if (command.kind === 'open-editor') {
        let location: { file: string; line: number } | null = null;
        const state = controllerRef.current;
        if (
          state.screen === 'walk' ||
          state.screen === 'floor-diff' ||
          state.screen === 'unassigned'
        ) {
          const at = cursorLines(state);
          const row = at?.lines[clamp(state.diffRowCursor, at.lines.length)] ?? at?.lines[0];
          if (at !== null && row !== undefined) location = { file: at.file, line: row.line };
        }
        if (location === null) {
          setControllerState({
            ...controllerRef.current,
            notice: 'Open the Part or Act header first',
          });
          return;
        }
        const failure = openFileInEditor({
          renderer,
          root: current.data.root,
          file: location.file,
          line: location.line,
        });
        setControllerState({
          ...controllerRef.current,
          notice:
            failure === null ? `Opened ${location.file}:${location.line} in $EDITOR` : failure,
        });
        return;
      }
      if (command.kind === 'mark-reviewed') {
        // THE PAGE THE READER IS ON — a Checkpoint under the floor lens, a Part
        // under synthesis. Requiring a narrative Part lets a reviewer on the
        // deterministic path read every checkpoint and record none of them: `m`
        // answers 'No narrative Part is selected' while a checkpoint is plainly on
        // screen. A finish gate that requires a narrative Part is unsatisfiable on
        // the deterministic path — a gate nothing can pass is a wall.
        const page = readerRef.current?.pages[controllerRef.current.readerPage];
        if (page === undefined) {
          setControllerState({ ...controllerRef.current, notice: 'No page is selected' });
          return;
        }
        if (!page.markReviewedEnabled) {
          setControllerState({
            ...controllerRef.current,
            notice: `Mark reviewed is blocked by ${page.blockers.join(', ')}`,
          });
          return;
        }
        void appendPageCoverageGuarded({
          page,
          floorInputHash: current.data.floor.input_hash,
          ledger: current.ledger,
          currentThreads: current.data.currentThreads,
          readGeneration: () => ({
            floorInputHash: loadedRef.current?.data.floor.input_hash ?? '',
            ledgerGeneration: loadedRef.current?.ledger.ledgerGeneration ?? '',
          }),
          append: async (event) => {
            const result = await journal.append({ root, branch }, event);
            if (result.status === 'appended') {
              updateLoaded((value) => ({ ...value, ledger: result.ledger }));
            }
            return result;
          },
        }).then((result) =>
          setControllerState({
            ...controllerRef.current,
            notice:
              result.status === 'appended'
                ? page.kind === 'part'
                  ? 'Part coverage recorded'
                  : 'Checkpoint coverage recorded'
                : result.message,
          })
        );
        return;
      }
      if (command.kind === 'mark-inspected') {
        // Read off the READER, not the narrative model. Reading the narrative model
        // answers 'No Unassigned row is selected' whenever no Story is composed —
        // which is exactly when inspecting the unexplained rows is the only review
        // work there is, and the rows are on screen the whole time.
        const reader = readerRef.current;
        const state = controllerRef.current;
        const page = activeReaderPage(reader, state);
        const stop = activeSliceStops(reader, state).find(
          (candidate) => candidate.sliceKey === state.diffSliceKey
        );
        if (reader === null || page === null || stop === undefined) {
          setControllerState({ ...state, notice: 'No inspectable slice is selected' });
          return;
        }
        // Record what THIS page displays. The residue page prices its own
        // completion against its filtered inspection rows; for a schema-valid
        // Story the v4 partition makes that set equal the deterministic gap set
        // (every gap slice lands in residue), but recording the page's rows
        // makes the agreement structural rather than coincidental. The
        // deterministic Unassigned page's inspectionRows ARE the current gap
        // rows, so its behavior is unchanged.
        const gapRows =
          page.kind === 'unassigned' || page.kind === 'story-residue'
            ? page.inspectionRows
            : reader.unassigned.gap.currentRows;
        const ambiguousHunkKeys = page.kind === 'checkpoint' ? [] : page.ambiguousHunkKeys;
        let eventsPromise: Promise<JournalEvent[]>;
        if (!ambiguousHunkKeys.includes(stop.hunkKey)) {
          if (page.kind === 'part') {
            setControllerState({
              ...state,
              notice: 'Part inspection is available only on an ambiguous hunk',
            });
            return;
          }
          // Inspecting ANY gap row marks the whole unexplained set inspected. The
          // ledger's target is the set, not the row — a reviewer who has read the
          // unexplained code has read it, and there is no per-row inspection event
          // to record. (The finish gate reads the same set, so the two agree.)
          eventsPromise = reviewedRowsDigest(gapRows).then((digest) => [
            {
              type: 'unassigned' as const,
              ts: nowIso(),
              action: UNASSIGNED_INSPECTION_ACTION.MARK_INSPECTED,
              target: {
                kind: 'GAP_ROWS' as const,
                coveredRows: [...gapRows],
                coveredRowsDigest: digest,
              },
            },
          ]);
        } else {
          eventsPromise = Promise.resolve([
            {
              type: 'unassigned' as const,
              ts: nowIso(),
              action: UNASSIGNED_INSPECTION_ACTION.MARK_INSPECTED,
              target: { kind: 'AMBIGUOUS_HUNK' as const, hunkKey: stop.hunkKey },
            },
          ]);
        }
        void eventsPromise.then(async (events) => {
          if (events.length === 0) return;
          const result = await journal.appendMany({ root, branch }, events);
          if (result.status === 'rejected') {
            setControllerState({ ...controllerRef.current, notice: result.message });
            return;
          }
          updateLoaded((value) => ({ ...value, ledger: result.ledger }));
          setControllerState({
            ...controllerRef.current,
            notice:
              page.kind === 'part'
                ? 'Part ambiguity inspected'
                : page.kind === 'story-residue'
                  ? 'Story residue inspected'
                  : 'Unassigned work inspected',
          });
        });
        return;
      }
      if (
        command.kind === 'reply-selected-comment' ||
        command.kind === 'resolve-selected-comment'
      ) {
        // Both verbs go straight to the sidecar, the same track the CLI writes. A
        // narrative gate here would refuse both whenever no Story exists — so on the
        // deterministic path a reviewer could neither reply to an agent nor resolve a
        // thread, which is the whole loop.
        const comment = current.comments.comments[controllerRef.current.commentCursor];
        if (comment === undefined) {
          setControllerState({ ...controllerRef.current, notice: 'No comment is selected' });
          return;
        }
        if (command.kind === 'resolve-selected-comment') {
          void commentSidecar
            .resolve({ root, branch }, { id: comment.comment_id })
            .then((comments) => {
              updateLoaded((value) => ({ ...value, comments }));
              setControllerState({ ...controllerRef.current, notice: 'Comment resolved' });
            })
            .catch((cause) =>
              setControllerState({ ...controllerRef.current, notice: String(cause) })
            );
          return;
        }
        openTextModal({
          title: 'Reply to comment',
          context: currentReviewContext(
            comment.position?.file === undefined
              ? 'Selected review comment'
              : `${comment.position.file}${comment.position.line == null ? '' : `:${comment.position.line}`}`
          ),
          guidance: ['Write the response that should stay with this review comment.'],
          placeholder: 'Write a reply…',
          submitLabel: 'Reply',
          required: true,
          emptyMessage: 'Write a reply before saving.',
          onText: (body) => {
            setModal(null);
            void commentSidecar
              .reply({ root, branch }, { id: comment.comment_id, body, author: 'reviewer' })
              .then((comments) => {
                updateLoaded((value) => ({ ...value, comments }));
                setControllerState({ ...controllerRef.current, notice: 'Reply filed' });
              })
              .catch((cause) =>
                setControllerState({ ...controllerRef.current, notice: String(cause) })
              );
          },
        });
        return;
      }
      if (command.kind === 'filter-files') {
        // `/`, through the SAME modal seam `c` and the finish note use. A filter is
        // a piece of text the reviewer types; there is no reason for it to invent a
        // second way to collect one.
        openTextModal({
          title: 'Filter files',
          context: currentReviewContext(
            state.screen === 'flat-files' ? 'All changed files' : 'File navigator destinations'
          ),
          guidance: [
            'Match any part of a current or renamed file path. The full diff and review coverage remain visible.',
            'Save an empty value to clear the filter.',
          ],
          placeholder: 'Type part of a file path…',
          initial: controllerRef.current.fileFilter ?? '',
          submitLabel: 'Apply filter',
          onText: (text) => {
            setModal(null);
            const filter = text.trim();
            setControllerState({
              ...controllerRef.current,
              fileFilter: filter === '' ? null : filter,
              flatFileCursor: 0,
              notice: filter === '' ? 'Filter cleared' : `Filtering files by "${filter}"`,
            });
            if (filter === '' || state.screen === 'flat-files' || patchIndex === null) return;

            const filtered = filterNavigatorFiles(
              activeReaderPage(readerRef.current, controllerRef.current)?.projection.layout.files ??
                [],
              filter,
              (file) => patchIndex.fileDiff(file)?.metadata.prevName ?? null
            );
            if (filtered.length === 0) {
              setControllerState({
                ...controllerRef.current,
                notice: `No navigator destinations match "${filter}"; the full diff remains visible`,
              });
              return;
            }
            const activeFile = activeDiffFile(readerRef.current, controllerRef.current);
            if (!filtered.some((file) => file.file === activeFile)) {
              selectDiffFile(filtered[0]!.file);
              setControllerState({
                ...controllerRef.current,
                notice: `Showing ${filtered.length} matching navigator destination(s); full diff unchanged`,
              });
            }
          },
        });
        return;
      }
      if (command.kind === 'move-pin') {
        // `{` / `}` — the reviewer's own unanswered comments are the thing they most
        // need to get back to, and the only way to reach one was to scroll until it
        // appeared. Ordered by the page's own hunk order, then by line, so the jump
        // is the same one the eye would make.
        const state = controllerRef.current;
        const pageHunks = activeSliceStops(readerRef.current, state).map((stop) => stop.hunkKey);
        const order = new Map(pageHunks.map((hunkKey, index) => [hunkKey, index]));
        const pins = current.comments.comments
          .filter((comment) => {
            const at = comment.position;
            return (
              at?.hunkKey != null && at.side !== null && at.line !== null && order.has(at.hunkKey)
            );
          })
          .sort((a, b) => {
            const byHunk =
              (order.get(a.position!.hunkKey!) ?? 0) - (order.get(b.position!.hunkKey!) ?? 0);
            return byHunk !== 0 ? byHunk : (a.position!.line ?? 0) - (b.position!.line ?? 0);
          });
        if (pins.length === 0) {
          setControllerState({ ...state, notice: 'No comment pins on this page' });
          return;
        }
        // `diffRowCursor` indexes the page-local rows the cursor can walk, not
        // every changed row in the parent floor hunk. A hunk shared by multiple
        // checkpoints can therefore have more floor rows than this page renders.
        //
        // `cursorLines` IS that list — the same one `v` spans and `Y` copies — so
        // asking it where the pin's line sits cannot disagree with where the cursor
        // then lands.
        const resolvePin = (pin: (typeof pins)[number]) => {
          const at = cursorLines({ ...state, diffHunkKey: pin.position!.hunkKey! });
          if (at === null) return null;
          const index = at.lines.findIndex(
            (row) => row.side === pin.position!.side && row.line === pin.position!.line
          );
          if (index < 0) return null;
          const stop = sliceStopForLine(
            activeReaderPage(readerRef.current, state),
            pin.position!.hunkKey!,
            pin.position!.side!,
            pin.position!.line!
          );
          return stop === null ? null : { pin, rowIndex: index, stop };
        };
        const resolvedPins = pins.flatMap((pin) => {
          const resolved = resolvePin(pin);
          return resolved === null ? [] : [resolved];
        });
        if (resolvedPins.length === 0) {
          setControllerState({
            ...state,
            notice: `${pins.length} comment pin(s) are visible but not row-resolvable on this page`,
          });
          return;
        }

        const here = resolvedPins.findIndex(
          ({ pin, rowIndex }) =>
            pin.position!.hunkKey === state.diffHunkKey && rowIndex === state.diffRowCursor
        );
        // From nowhere in particular, `}` lands on the first pin and `{` on the last.
        const next =
          here === -1
            ? command.direction === 1
              ? 0
              : resolvedPins.length - 1
            : (here + command.direction + resolvedPins.length) % resolvedPins.length;
        const { pin, rowIndex, stop } = resolvedPins[next]!;
        setControllerState({
          ...state,
          screen: state.screen,
          focus: 'diff',
          diffGrain: 'row',
          diffSliceKey: stop.sliceKey,
          diffHunkKey: pin.position!.hunkKey!,
          diffRowCursor: rowIndex,
          diffSelectionAnchor: null,
          notice: `Pin ${next + 1}/${resolvedPins.length} · ${pin.author} · ${pin.status}${resolvedPins.length < pins.length ? ` · ${pins.length - resolvedPins.length} unresolved` : ''}`,
        });
        showExplicitDiffTarget({ sliceKey: stop.sliceKey });
        return;
      }
      if (command.kind === 'copy-selection') {
        const state = controllerRef.current;
        // The SAME row list the cursor walks and the anchor builder hashes. Copying a
        // different span than the one highlighted is the same class of lie.
        const at = cursorLines(state);
        if (at === null) return;
        const from =
          state.diffGrain === 'hunk'
            ? 0
            : state.diffSelectionAnchor === null
              ? state.diffRowCursor
              : Math.min(state.diffSelectionAnchor, state.diffRowCursor);
        const to =
          state.diffGrain === 'hunk'
            ? at.lines.length - 1
            : state.diffSelectionAnchor === null
              ? state.diffRowCursor
              : Math.max(state.diffSelectionAnchor, state.diffRowCursor);
        const span = at.lines.slice(from, to + 1);
        if (span.length === 0) return;
        // Raw bodies, no gutter: `Y` exists so the reviewer can paste the code into an
        // editor or a message, and a paste carrying line numbers and +/- signs is a
        // paste they have to clean up by hand.
        const text = formatSelectionText(span);
        const result = copyViaOsc52(renderer as unknown as Osc52Renderer | null, text);
        setControllerState({
          ...controllerRef.current,
          notice:
            result === 'none'
              ? 'Clipboard unavailable in this terminal'
              : `Copied ${span.length} row(s)`,
        });
        return;
      }
      if (command.kind === 'move-unvisited') {
        const state = controllerRef.current;
        const pages = readerRef.current?.pages ?? [];
        const candidates = pages
          .map((page, index) => ({ page, index }))
          .filter(({ page }) => !page.visited);
        if (candidates.length === 0) {
          setControllerState({ ...state, notice: 'No unvisited pages' });
          return;
        }
        const ordered =
          command.direction === 1
            ? [
                ...candidates.filter(({ index }) => index > state.readerPage),
                ...candidates.filter(({ index }) => index <= state.readerPage),
              ]
            : [
                ...candidates.filter(({ index }) => index < state.readerPage).reverse(),
                ...candidates.filter(({ index }) => index >= state.readerPage).reverse(),
              ];
        const next = ordered[0]!;
        if (next.index === state.readerPage && candidates.length === 1) {
          setControllerState({ ...state, notice: 'Only unvisited page' });
          return;
        }
        if (next.page.kind !== 'part') {
          setControllerState({
            ...state,
            notice: 'Unvisited navigation is available in Story Walk',
          });
          return;
        }
        const page = next.page;
        const firstStop = page.sliceStops[0] ?? null;
        beginDiffPage(firstStop?.sliceKey ?? null);
        setControllerState({
          ...resetReviewCodeHorizontalOffset(state),
          screen: 'walk',
          readerPage: next.index,
          activeAct: page.actIndex,
          activePart: page.partIndex,
          activeItem: 0,
          activeTarget: 0,
          diffGrain: 'hunk',
          diffSliceKey: firstStop?.sliceKey ?? null,
          diffHunkKey: firstStop?.hunkKey ?? null,
          diffRowCursor: 0,
          diffSelectionAnchor: null,
          notice: null,
        });
        return;
      }
      if (command.kind === 'move-page') {
        // `[` / `]` — the reader's unit, in whichever lens is live. The page index is
        // the ONE piece of state both lenses share, which is what lets this handler
        // not care which one it is on until it has to move a cursor.
        const state = controllerRef.current;
        const pages = readerRef.current?.pages ?? [];
        if (pages.length === 0) {
          setControllerState({ ...state, notice: 'No pages to walk on this branch' });
          return;
        }
        const at = clamp(state.readerPage, pages.length);
        const next = at + command.direction;
        if (next < 0 || next >= pages.length) {
          setControllerState({
            ...state,
            notice:
              command.direction === 1 ? 'Last page — nothing further on this branch' : 'First page',
          });
          return;
        }
        const page = pages[next]!;
        // The boundary is the thing the reader most needs told: paging out of one
        // thread (or Act) and into another is a change of subject, and a flat hunk
        // walk crosses exactly that boundary with no signal at all.
        const from = pages[at]!;
        const crossed =
          page.kind === 'checkpoint' && from.kind === 'checkpoint'
            ? page.threadKey !== from.threadKey
              ? `THREAD · ${page.threadTitle}`
              : null
            : page.kind === 'part' && from.kind === 'part'
              ? page.actKey !== from.actKey
                ? `ACT · ${page.actTitle}`
                : null
              : null;
        const notice =
          crossed === null ? null : `Crossed into ${crossed} — ${next + 1}/${pages.length}`;
        const firstStop = page.sliceStops[0] ?? null;
        beginDiffPage(firstStop?.sliceKey ?? null);

        if (page.kind === 'checkpoint') {
          setControllerState({
            ...resetReviewCodeHorizontalOffset(state),
            readerPage: next,
            contextItemCursor: 0,
            screen: 'floor-diff',
            focus: 'diff',
            diffSliceKey: firstStop?.sliceKey ?? null,
            diffHunkKey: firstStop?.hunkKey ?? state.diffHunkKey,
            diffGrain: 'hunk',
            diffRowCursor: 0,
            diffSelectionAnchor: null,
            notice,
          });
          return;
        }
        setControllerState({
          ...resetReviewCodeHorizontalOffset(state),
          readerPage: next,
          contextItemCursor: 0,
          screen: 'walk',
          focus: firstStop === null ? 'rail' : state.focus,
          activeAct: page.actIndex,
          activePart: page.partIndex,
          activeItem: 0,
          activeTarget: 0,
          diffSliceKey: firstStop?.sliceKey ?? null,
          diffHunkKey: firstStop?.hunkKey ?? null,
          diffRowCursor: 0,
          diffSelectionAnchor: null,
          notice,
        });
        return;
      }
      if (command.kind === 'recenter-diff') {
        recenterDiff();
        return;
      }
      if (command.kind === 'page' || command.kind === 'scroll-diff-edge') {
        const scroll = walkScrollRef.current;
        if (scroll === null) {
          setControllerState({
            ...controllerRef.current,
            notice: 'Current screen has no scroll model',
          });
          return;
        }
        // Everything that scrolls goes through the coordinator, and `scrollDiff` is
        // the only thing that writes a scroll position — surface AND state in one
        // beat, so the mount window the next render computes is the one the reader
        // is actually looking at.
        const bounds: ScrollBounds = {
          viewport: Math.max(1, scroll.viewport?.height ?? 1),
          content: Math.max(0, scroll.scrollHeight),
        };
        if (command.kind === 'scroll-diff-edge') {
          scrollDiff(() => (command.edge === 'top' ? 0 : maxScroll(bounds)));
          return;
        }
        const rows = command.half ? halfPageStep(bounds.viewport) : pageStep(bounds.viewport);
        scrollDiff((at) => scrollByRows(at, rows * command.direction, bounds));
        return;
      }
      if (command.kind === 'move-diff-file') {
        // `,` / `.` — the previous/next file OF THIS PAGE. Use the exact same
        // transition as a sidebar click, rather than re-deriving a second hunk walk.
        const state = controllerRef.current;
        const page = activeReaderPage(readerRef.current, state);
        const files = page?.projection.layout.files ?? [];
        const currentFile = page?.sliceStops.find(
          (candidate) => candidate.sliceKey === state.diffSliceKey
        )?.file;
        const at = Math.max(
          0,
          files.findIndex((candidate) => candidate.file === currentFile)
        );
        const next = at + command.direction;
        if (next < 0 || next >= files.length) {
          setControllerState({
            ...controllerRef.current,
            notice:
              command.direction === 1
                ? 'Last file on this page — ] for the next page'
                : 'First file on this page — [ for the previous page',
          });
          return;
        }
        selectDiffFile(files[next]!.file);
        return;
      }
      if (command.kind === 'move-diff-row' || command.kind === 'select-range') {
        const state = controllerRef.current;
        let cursor: ReturnType<typeof cursorLines> = null;
        let rowCount = 0;
        if (state.diffHunkKey !== null) {
          // The SAME page-scoped list the header counts and the anchor hashes. Three
          // readers of "the rows under the cursor" is three chances to disagree about
          // which row that is.
          cursor = cursorLines(state);
          rowCount = cursor === null ? 0 : cursor.lines.length;
        }
        if (rowCount === 0) {
          setControllerState({ ...state, notice: 'Selected target has no changed-row cursor' });
          return;
        }
        if (command.kind === 'move-diff-row') {
          const diffRowCursor = clamp(state.diffRowCursor + command.direction, rowCount);
          const row = cursor?.lines[diffRowCursor];
          // Direct diff pages have measured source-row geometry. Narrative
          // placement targets do not, so preserve their one-row nudge only when
          // there is no semantic cursor to reveal.
          if (cursor === null || row === undefined) {
            scrollDiff((at) => at + command.direction);
          } else {
            showDiffRow({ hunkKey: cursor.hunkKey, row });
          }
          const nextState = { ...state, diffRowCursor, notice: null };
          const activePage = activeReaderPage(readerRef.current, state);
          const loadedForSync = loadedRef.current;
          const syncReader =
            readerRef.current?.lens === 'story'
              ? readerRef.current
              : loadedForSync !== null && currentStoryAvailable(loadedForSync)
                ? projectionCaches.story.project(loadedForSync).model
                : null;
          setControllerState(
            activePage === null || syncReader === null || row === undefined
              ? nextState
              : synchronizeRailToTarget(nextState, syncReader, {
                  pageKey: activePage.key,
                  hunkKey: cursor!.hunkKey,
                  row,
                })
          );
        } else {
          setControllerState({
            ...state,
            diffSelectionAnchor: state.diffSelectionAnchor === null ? state.diffRowCursor : null,
            notice:
              state.diffSelectionAnchor === null
                ? 'Selection anchor set; move the row cursor to extend'
                : 'Range selection cleared',
          });
        }
        return;
      }
      if (command.kind === 'expand-hidden') {
        void expandHidden(command.wholeFile);
        return;
      }
      if (command.kind === 'finish-complete') {
        // The CANONICAL gate, on both lenses. `canFinishComplete` is the
        // narrative's own verdict and is null-by-construction on the floor path, so
        // reading it would make a floor-only COMPLETE unreachable — and on the
        // narrative path it is a verdict the transport never re-checks. ONE gate
        // instead, and the reader names what is left rather than saying only
        // "required review work remains".
        // Read through the live ref. A disposition can clear the last blocker
        // without changing controller state; the callback closure may still hold
        // the gate from the render before that append even while the Finish screen
        // truthfully paints the updated reader.
        const gate = readerRef.current?.finish;
        if (gate === undefined || !gate.allowed) {
          if (gate === undefined) {
            setControllerState({ ...controllerRef.current, notice: 'The review is still loading' });
            return;
          }
          const obligations = finishObligationsRef.current;
          const obligation =
            obligations[clamp(controllerRef.current.finishCursor, obligations.length)];
          if (obligation === undefined) {
            setControllerState({
              ...controllerRef.current,
              notice: 'Refresh the review to recover its remaining obligations.',
            });
            return;
          }
          openFinishObligation(obligation);
          return;
        }
        void lifecycleJournalEvent(
          'COMPLETE',
          current,
          readerRef.current,
          storyReadGenerationRef.current
        )
          .then((event) => journal.append({ root, branch }, event))
          .then((result) => {
            if (result.status === 'rejected') {
              handleLifecycleRejection(result);
              return;
            }
            updateLoaded((value) => ({ ...value, ledger: result.ledger }));
            setControllerState({
              ...controllerRef.current,
              screen: 'finish',
              notice: 'Durable COMPLETE recorded',
            });
          })
          .catch(handleLifecycleFailure);
        return;
      }
      if (command.kind === 'finish-partial') {
        openTextModal({
          title: 'Finish as partial',
          context: currentReviewContext('Review outcome'),
          guidance: ['Describe exactly what remains before this review can be complete.'],
          placeholder: 'What remains?…',
          submitLabel: 'Record partial',
          required: true,
          emptyMessage: 'Describe the remaining work before recording PARTIAL.',
          onText: (text) => {
            setModal(null);
            if (text.length === 0) {
              setControllerState({
                ...controllerRef.current,
                notice: 'PARTIAL requires a remaining-work note',
              });
              return;
            }
            const latest = loadedRef.current;
            if (latest === null) return;
            void lifecycleJournalEvent(
              'PARTIAL',
              latest,
              readerRef.current,
              storyReadGenerationRef.current,
              text
            )
              .then((event) => journal.append({ root, branch }, event))
              .then((result) => {
                if (result.status === 'rejected') {
                  handleLifecycleRejection(result);
                  return;
                }
                updateLoaded((value) => ({ ...value, ledger: result.ledger }));
                setControllerState({
                  ...controllerRef.current,
                  screen: 'finish',
                  notice: 'Durable PARTIAL recorded',
                });
              })
              .catch(handleLifecycleFailure);
          },
        });
        return;
      }
      if (command.kind === 'resume') {
        void lifecycleJournalEvent(
          'REOPEN',
          current,
          readerRef.current,
          storyReadGenerationRef.current
        )
          .then((event) => journal.append({ root, branch }, event))
          .then((result) => {
            if (result.status === 'rejected') {
              handleLifecycleRejection(result);
              return;
            }
            updateLoaded((value) => ({ ...value, ledger: result.ledger }));
            setControllerState({
              ...controllerRef.current,
              screen: 'brief',
              routeHistory: [],
              focus: initialFocusForReviewScreen('brief'),
              notice: 'Review reopened; prior completion retained in history',
            });
          })
          .catch(handleLifecycleFailure);
        return;
      }
      assertNever(command);
    },
    [
      appendEvent,
      appendEvents,
      branch,
      beginDiffPage,
      cancelActiveLoad,
      currentReviewContext,
      disableAutoLoad,
      expandHidden,
      handleLifecycleFailure,
      handleLifecycleRejection,
      journal,
      load,
      onExit,
      onCommandExecuted,
      openFinishObligation,
      openTextModal,
      patchIndex,
      projectionCaches,
      recenterDiff,
      root,
      renderer,
      selectDiffFile,
      setControllerState,
      showDiffRow,
      showExplicitDiffTarget,
      updateLoaded,
    ]
  );

  const executeRef = useRef(executeCommand);
  executeRef.current = executeCommand;

  const dispatchCurrentReviewKey = useCallback((key: ReviewKeyLike): ReviewDispatchResult => {
    const state = controllerRef.current;
    const page = activeReaderPage(readerRef.current, state);
    const currentReader = readerRef.current;
    if (currentReader === null) {
      return dispatchFloorReviewKey(state, key, EMPTY_LIFECYCLE);
    }
    const loadedForDispatch = loadedRef.current;
    const gesture = normalizeCommandGesture(key);
    const dispatchReader =
      currentReader.lens === 'deterministic' &&
      state.activeStoryItemId !== null &&
      (gesture === '(' || gesture === ')') &&
      loadedForDispatch !== null &&
      currentStoryAvailable(loadedForDispatch)
        ? projectionCaches.story.project(loadedForDispatch).model
        : currentReader;
    return dispatchReaderReviewKey(
      state,
      key,
      {
        reader: dispatchReader,
        lifecycle: loadedRef.current?.ledger.lifecycle ?? EMPTY_LIFECYCLE,
        contextItemCount:
          loadedRef.current === null || page?.kind !== 'checkpoint'
            ? 0
            : checkpointUncertaintyIds(loadedRef.current.data.floor, page).length,
      },
      Date.now()
    );
  }, []);

  const dispatchCurrentReviewCommand = useCallback(
    (invocation: ReviewCommandInvocation): ReviewDispatchResult => {
      const state = controllerRef.current;
      const page = activeReaderPage(readerRef.current, state);
      const currentReader = readerRef.current;
      if (currentReader === null) return { state, command: { kind: 'none' }, consumed: false };
      return dispatchReaderReviewCommand(
        state,
        invocation,
        {
          reader: currentReader,
          lifecycle: loadedRef.current?.ledger.lifecycle ?? EMPTY_LIFECYCLE,
          contextItemCount:
            loadedRef.current === null || page?.kind !== 'checkpoint'
              ? 0
              : checkpointUncertaintyIds(loadedRef.current.data.floor, page).length,
        },
        Date.now()
      );
    },
    []
  );

  const beginReaderDestination = useCallback(
    (next: ReviewControllerState, sourceReader: ReaderModel) => {
      const sourceLayout = diffLayoutRef.current;
      beginDiffPage(next.diffSliceKey);
      if (next.activeStoryItemId === null) return;
      const placement = sourceReader.routeIndex.semanticPlacementsByItemId
        .get(next.activeStoryItemId)
        ?.find((candidate) => candidate.locationIndex === next.activeTarget);
      if (placement?.displayTarget.kind !== 'line') return;
      pendingDiffRowRef.current = {
        hunkKey: placement.destination.hunkKey,
        row: {
          side: placement.displayTarget.side,
          line: placement.displayTarget.line,
        },
        sourceLayout,
      };
    },
    [beginDiffPage]
  );

  /** Commit controller state before effects, regardless of invocation surface. */
  const commitDispatch = useCallback(
    (dispatched: ReviewDispatchResult): boolean => {
      if (!dispatched.consumed) return false;
      const previous = controllerRef.current;
      const loadedForDispatch = loadedRef.current;
      const sourceReader =
        dispatched.state.activeStoryItemId !== null &&
        loadedForDispatch !== null &&
        currentStoryAvailable(loadedForDispatch)
          ? projectionCaches.story.project(loadedForDispatch).model
          : readerRef.current;
      if (
        sourceReader !== null &&
        dispatched.state.activeStoryItemId !== null &&
        (dispatched.state.activeStoryItemId !== previous.activeStoryItemId ||
          dispatched.state.activeTarget !== previous.activeTarget) &&
        (dispatched.state.screen === 'walk' ||
          dispatched.state.screen === 'floor-diff' ||
          dispatched.state.screen === 'unassigned')
      ) {
        beginReaderDestination(dispatched.state, sourceReader);
      }
      setControllerState(dispatched.state);
      executeRef.current(dispatched.command);
      return true;
    },
    [beginReaderDestination, setControllerState]
  );

  const moveHelpSelection = useCallback((delta: number): void => {
    const commands = helpCommandsRef.current;
    if (commands.length === 0) return;
    const current = Math.min(helpSelectionRef.current, commands.length - 1);
    const next = Math.min(commands.length - 1, Math.max(0, current + delta));
    helpSelectionRef.current = next;
    setHelpSelection(next);
    if (next !== current && helpScrollRef.current !== null) {
      helpScrollRef.current.scrollTop = Math.max(0, commands[next]!.line - 1);
    }
  }, []);

  const executeHelpEntry = useCallback(
    (entry: ExecutableHelpEntry): void => {
      flushSync(() => setHelpOpen(false));
      if (entry.commandId.startsWith('review.')) {
        commitDispatch(
          dispatchCurrentReviewCommand({
            id: entry.commandId as ReviewCommandInvocation['id'],
            ...(entry.gesture === undefined ? {} : { gesture: entry.gesture }),
          })
        );
      } else {
        onShellCommand?.(entry.commandId as ShellCommandId);
      }
    },
    [commitDispatch, dispatchCurrentReviewCommand, onShellCommand]
  );

  const executeSelectedHelpCommand = useCallback((): void => {
    const entry = helpCommandsRef.current[helpSelectionRef.current];
    if (entry !== undefined) executeHelpEntry(entry);
  }, [executeHelpEntry]);

  const executeHelpEntryById = useCallback(
    (entryId: string): void => {
      const entry = helpCommandsRef.current.find((candidate) => candidate.entryId === entryId);
      if (entry !== undefined) executeHelpEntry(entry);
    },
    [executeHelpEntry]
  );

  useKeyboard((key: ReviewKeyLike) => {
    if (cacheUpgradePromptOpen) return;
    if (modal !== null) return;
    if (helpOpen) {
      const sequence = key.sequence ?? key.name ?? '';
      if (key.name === 'escape' || sequence === '\u001b' || sequence === '?' || sequence === 'q') {
        key.preventDefault?.();
        setHelpOpen(false);
      } else if (sequence === 'j' || key.name === 'down') {
        key.preventDefault?.();
        moveHelpSelection(1);
      } else if (sequence === 'k' || key.name === 'up') {
        key.preventDefault?.();
        moveHelpSelection(-1);
      } else if (key.name === 'return' || key.name === 'enter') {
        key.preventDefault?.();
        executeSelectedHelpCommand();
      }
      return;
    }
    if (inputSuspended) return;
    const sequence = key.sequence ?? key.name ?? '';
    if (error !== null && error.cacheBehind !== null && sequence.toLowerCase() === 'r') {
      key.preventDefault?.();
      setCacheUpgradePromptOpen(true);
      return;
    }
    const dispatched = dispatchCurrentReviewKey(key);
    if (!claimConsumedReviewKey(key, dispatched.consumed)) return;
    commitDispatch(dispatched);
  });

  useEffect(() => {
    if (shellRequest === null || shellRequest === undefined) return;
    if (shellRequest.id === 'help') {
      helpSelectionRef.current = 0;
      setHelpSelection(0);
      setHelpOpen(true);
      return;
    }
    const layer = shellLayerRef.current;
    if (
      layer.inputSuspended ||
      layer.modal !== null ||
      layer.helpOpen ||
      layer.cacheUpgradePromptOpen
    )
      return;
    if (shellRequest.id === 'back') {
      commitDispatch(dispatchReviewRouteBack(controllerRef.current));
      return;
    }
    if (shellRequest.id === 'story-lens') {
      switchReviewLens('story');
      return;
    }
    if (shellRequest.id === 'captured-checkpoint-lens') {
      switchReviewLens('deterministic');
      return;
    }
    const id =
      controllerRef.current.screen === 'walk'
        ? 'review.walk.focus-pane'
        : 'review.floor.focus-pane';
    commitDispatch(dispatchCurrentReviewCommand({ id }));
  }, [commitDispatch, dispatchCurrentReviewCommand, shellRequest, switchReviewLens]);

  // `useKeyboard` installs its subscription in an effect. This later effect is
  // therefore the first honest point at which a PTY driver may send input.
  useEffect(() => {
    onInputReady?.();
  }, [onInputReady]);

  useEffect(() => {
    onHelpOpenChange?.(helpOpen);
  }, [helpOpen, onHelpOpenChange]);

  useEffect(() => {
    onModalOpenChange?.(modal !== null || cacheUpgradePromptOpen);
  }, [cacheUpgradePromptOpen, modal, onModalOpenChange]);

  const activateFinishObligation = useCallback(
    (index: number) => {
      setControllerState({
        ...controllerRef.current,
        finishCursor: index,
        notice: null,
      });
      executeRef.current({ kind: 'finish-complete' });
    },
    [setControllerState]
  );
  // Pointer and keyboard resolve through the SAME functions, so a click and an
  // `↵` on the same row cannot reach different destinations. Both write the
  // cursor before routing, for the reason spelled out on `activateBriefDestination`.
  const activateBriefTreeRow = useCallback(
    (destination: number) => {
      const tree = briefTreeRef.current;
      const activeReader = readerRef.current;
      if (tree === null || activeReader === null) return;
      const activated = activateBriefDestination(
        controllerRef.current,
        activeReader,
        tree,
        destination
      );
      if (
        activated.screen === 'walk' ||
        activated.screen === 'floor-diff' ||
        activated.screen === 'unassigned'
      ) {
        beginReaderDestination(activated, activeReader);
      }
      setControllerState(activated);
    },
    [beginReaderDestination, setControllerState]
  );
  const activateBriefAttentionRow = useCallback(
    (index: number) => {
      setControllerState({
        ...controllerRef.current,
        attentionCursor: index,
        attentionRowKey: briefAttentionRef.current[index]?.key ?? null,
        notice: null,
      });
      executeRef.current({ kind: 'activate-brief-attention', intent: 'selected' });
    },
    [setControllerState]
  );
  const activateStoryRailItem = useCallback(
    (index: number) => {
      const activeReader = readerRef.current;
      if (activeReader?.lens !== 'story') return;
      const next = activateReaderRailItem(controllerRef.current, activeReader, index);
      if (next.screen === 'walk' || next.screen === 'floor-diff' || next.screen === 'unassigned') {
        beginReaderDestination(next, activeReader);
      }
      setControllerState(next);
    },
    [beginReaderDestination, setControllerState]
  );
  const activateFlatFile = useCallback(
    (index: number) => {
      setControllerState({
        ...controllerRef.current,
        flatFileCursor: Math.max(0, index),
        notice: null,
      });
      executeRef.current({ kind: 'activate' });
    },
    [setControllerState]
  );
  const activateComment = useCallback(
    (index: number) => {
      setControllerState({
        ...controllerRef.current,
        commentCursor: Math.max(0, index),
        notice: null,
      });
      executeRef.current({ kind: 'activate' });
    },
    [setControllerState]
  );
  const openCommentPin = useCallback(
    (commentId: string) => {
      const state = controllerRef.current;
      const comments = loadedRef.current?.comments.comments ?? [];
      const commentCursor = comments.findIndex((comment) => comment.comment_id === commentId);
      if (commentCursor < 0) {
        setControllerState({ ...state, notice: 'This comment is no longer available' });
        return;
      }
      setControllerState(
        pushReviewRoute(state, {
          ...state,
          screen: 'comments',
          commentCursor,
          notice: null,
        })
      );
    },
    [setControllerState]
  );
  const markReviewed = useCallback(() => executeRef.current({ kind: 'mark-reviewed' }), []);

  const gapExpansionValue = useMemo(
    () => ({
      source: patchSource,
      expandedGaps: gapStores.expandedGaps,
      sourceStatusByFile: gapStores.sourceStatusByFile,
      toggleGap,
    }),
    [gapStores.expandedGaps, gapStores.sourceStatusByFile, patchSource, toggleGap]
  );

  const theme = themeOverride ?? controls.diffTheme;
  const atReviewRoot = reviewIsAtRoot(controller);
  const helpSections = useMemo(() => {
    const [current, ...more] = storyReviewHelpSections(
      controller.screen,
      reader?.lens ?? 'deterministic',
      { atRoot: atReviewRoot },
      reader?.staleProjection === true
    );
    return [
      ...(current === undefined ? [] : [current]),
      {
        title: 'Application',
        rows: [
          ...selectShellHelpCommands({
            mode: 'review',
            reviewable: false,
            watchAtRoot: false,
            reviewAtRoot: atReviewRoot,
            storyAvailable: currentStoryAvailable(loaded),
            storyViewable: storyViewable(loaded),
            reviewLens: reader?.lens ?? 'deterministic',
          }).map((command) => {
            const invocation = executableHelpInvocation(command);
            return {
              commandId: command.id,
              commandGesture: invocation?.gesture,
              executable:
                onShellCommand !== undefined && invocation !== null && command.id !== 'help',
              keys: command.gestures.length === 0 ? ['menu'] : [...command.gestures],
              label: command.label,
            };
          }),
        ],
      },
      ...more,
    ];
  }, [atReviewRoot, controller.screen, loaded, onShellCommand, reader?.lens]);
  const helpCommands = executableHelpEntries(helpSections);
  helpCommandsRef.current = helpCommands;
  const helpDialog =
    modal === null && !cacheUpgradePromptOpen && helpOpen ? (
      <HelpDialog
        title="Review controls"
        context={storyReviewHelpContext(
          controller.screen,
          reader?.lens ?? 'deterministic',
          controller.focus
        )}
        sections={helpSections}
        width={width}
        height={height}
        scrollRef={helpScrollRef}
        selectedEntryId={
          helpCommands[Math.min(helpSelection, helpCommands.length - 1)]?.entryId ?? null
        }
        onExecute={executeHelpEntryById}
        onClose={() => setHelpOpen(false)}
      />
    ) : null;

  if (loading) {
    return (
      <CockpitThemeContext.Provider value={cockpit}>
        <box width={width} height={height} backgroundColor={theme.background}>
          <LoadingScreen
            width={width}
            height={height}
            message={
              rebuildingCache
                ? `Rebuilding local cache for ${branch}…`
                : `Loading review for ${branch}…`
            }
            background={theme.background}
            accent={cockpit.LIVE}
            fg={cockpit.DIM}
            onFrameCommitted={onLoadingFrameCommitted}
          />
          {helpDialog}
        </box>
      </CockpitThemeContext.Provider>
    );
  }
  if (error !== null) {
    return (
      <CockpitThemeContext.Provider value={cockpit}>
        <box
          width={width}
          height={height}
          backgroundColor={theme.background}
          flexDirection="column"
        >
          <ErrorState
            id="review-load-error"
            variant="screen"
            title={`Review unavailable for ${branch}`}
            message="The captured review bundle could not be loaded."
            detail={error.detail}
            action={
              error.cacheBehind === null
                ? undefined
                : {
                    id: 'review-cache-rebuild',
                    label: 'Rebuild cache',
                    onSelect: () => setCacheUpgradePromptOpen(true),
                  }
            }
          />
          {cacheUpgradePromptOpen && error.cacheBehind !== null ? (
            <CacheUpgradeDialog
              cacheVersion={error.cacheBehind.cacheVersion}
              currentVersion={error.cacheBehind.currentVersion}
              width={width}
              height={height}
              onConfirm={() => {
                setCacheUpgradePromptOpen(false);
                void load('active', false, true);
              }}
              onDecline={() => setCacheUpgradePromptOpen(false)}
            />
          ) : null}
          {helpDialog}
        </box>
      </CockpitThemeContext.Provider>
    );
  }
  if (loaded === null) {
    return (
      <CockpitThemeContext.Provider value={cockpit}>
        <box
          width={width}
          height={height}
          backgroundColor={theme.background}
          flexDirection="column"
        >
          <EmptyState
            id="review-empty-floor"
            variant="screen"
            title="No deterministic review floor"
            message={`No captured review floor was produced for ${branch}.`}
            detail="Capture and close implementation checkpoints, then reopen Review."
          />
          {helpDialog}
        </box>
      </CockpitThemeContext.Provider>
    );
  }

  return (
    <CockpitThemeContext.Provider value={cockpit}>
      <box width={width} height={height} backgroundColor={theme.background} flexDirection="column">
        <GapExpansionProvider value={gapExpansionValue}>
          <ReviewExperience
            floor={loaded.data.floor}
            lifecycle={loaded.ledger.lifecycle}
            targetsStatus={loaded.data.targetsStatus}
            storyStatus={loaded.data.routineStory.status}
            storyIssue={loaded.data.routineStory.issue}
            storyRunId={loaded.data.routineStory.runId}
            storyAnchorStatus={loaded.data.routineStory.anchors.status}
            storyAnchorIssue={loaded.data.routineStory.anchors.issue}
            staleness={staleness}
            screen={controller.screen}
            width={width}
            height={height}
            activeAct={controller.activeAct}
            activePart={controller.activePart}
            activeItem={controller.activeItem}
            activeStoryItemId={controller.activeStoryItemId}
            attentionCursor={controller.attentionCursor}
            commentCursor={controller.commentCursor}
            flatFileCursor={controller.flatFileCursor}
            fileFilter={controller.fileFilter}
            floorCursor={controller.floorCursor}
            briefCursor={controller.briefCursor}
            attentionRowKey={controller.attentionRowKey}
            briefTree={briefTree}
            briefAttention={briefAttention}
            diffGrain={controller.diffGrain}
            selectedFloorSliceKey={controller.diffSliceKey}
            selectedFloorHunkKey={controller.diffHunkKey}
            expandedForeignHunks={expandedForeignHunks}
            onToggleForeign={toggleForeignHunk}
            showLineNumbers={controller.showLineNumbers}
            wrapLines={controller.wrapLines}
            showHunkHeaders={controller.showHunkHeaders}
            diffLayout={controller.diffLayout}
            showOwnerLabels={controller.showOwnerLabels}
            codeHorizontalOffset={controller.codeHorizontalOffset}
            onRowMouseDown={onRowMouseDown}
            onRowMouseDrag={onRowMouseDrag}
            onDiffDragEdge={handleDiffDragEdge}
            diffRowCursor={controller.diffRowCursor}
            diffSelectionAnchor={controller.diffSelectionAnchor}
            focus={controller.focus}
            atReviewRoot={atReviewRoot}
            notice={controller.notice}
            reviewDiff={loaded.data.reviewDiff}
            patchIndex={patchIndex ?? undefined}
            patchEnrichmentRevision={patchEnrichmentRevision}
            theme={theme}
            walkScrollRef={walkScrollRef}
            capturedTrailScrollRef={capturedTrailScrollRef}
            comments={loaded.comments.comments}
            semanticAnnotation={semanticAnnotation}
            diffScrollTop={diffScrollTop}
            diffViewportHeight={diffViewport}
            diffViewportRevision={diffScrollRevision}
            diffTightViewportWindow={diffTightViewportWindow}
            diffVisibleViewportHeight={diffVisibleViewportHeight}
            diffOverscanRows={renderedDiffOverscanRows}
            preserveDiffSourceViewport={
              pendingDiffSliceRef.current === null && pendingDiffRowRef.current === null
            }
            diffSourceAnchor={pendingDiffSourceAnchorRef.current}
            preferredDiffSourceAnchorKey={preferredDiffSourceKeyRef.current}
            pendingDiffSourceDelta={pendingDiffSourceDeltaRef.current}
            onDiffWheel={handleDiffWheel}
            onDiffHorizontalWheel={handleDiffHorizontalWheel}
            onDiffMeasured={handleCurrentDiffMeasured}
            onDiffScrollSurface={bindDiffScrollSurface}
            finishObligations={finishObligations}
            finishCursor={controller.finishCursor}
            onActivateFinishObligation={activateFinishObligation}
            onActivateBriefDestination={activateBriefTreeRow}
            onActivateBriefAttention={activateBriefAttentionRow}
            onActivateFlatFile={activateFlatFile}
            onActivateComment={activateComment}
            onActivateCommentPin={openCommentPin}
            uncertaintyStates={uncertaintyStates}
            contextItemCursor={controller.contextItemCursor}
            onSelectContextItem={selectContextItem}
            onSelectDiffFile={selectDiffFile}
            fileNavigatorExpanded={controller.fileNavigatorExpanded}
            onToggleFileNavigator={toggleFileNavigator}
            readerPage={currentPage}
            pageNumber={
              reader === null ? undefined : clamp(controller.readerPage, reader.pages.length) + 1
            }
            pageCount={reader?.pages.length}
            reader={reader}
            onMarkReviewed={markReviewed}
            onActivateRailItem={activateStoryRailItem}
          />
        </GapExpansionProvider>
        {modal === null ? null : (
          <InputModal
            title={modal.title}
            context={modal.context}
            guidance={modal.guidance}
            placeholder={modal.placeholder}
            initial={modal.initial}
            submitLabel={modal.submitLabel}
            required={modal.required}
            emptyMessage={modal.emptyMessage}
            width={width}
            height={height}
            onSubmit={(text) => modal.onText(text.trim())}
            onCancel={() => setModal(null)}
          />
        )}
        {helpDialog}
      </box>
    </CockpitThemeContext.Provider>
  );
}
