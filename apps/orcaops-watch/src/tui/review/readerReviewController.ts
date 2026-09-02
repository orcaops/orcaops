import type {
  CurrentThreadManifest,
  ReviewCoverageJournalEvent,
  ReviewLedgerV2,
  ReviewLifecycleLedger,
} from '@orcaops/review-core';

import type { JournalAppendResult } from '../../data/journalSource';
import { normalizeCommandGesture } from '../commandRegistry';
import type { BriefTree } from './briefTree';
import {
  resolveReviewCommand,
  type ReviewCommandId,
  selectVisibleReviewCommands,
  type StoryReviewFocus,
  type StoryReviewScreen,
} from './keymap';
import {
  preparePageCoverage,
  type ReaderAuxiliaryPage,
  type ReaderLens,
  type ReaderModel,
  type ReaderPage,
  type ReaderRailItem,
  type ReaderRouteDestination,
} from './readerModel';

export const REVIEW_PREFIX_TIMEOUT_MS = 700;
export const REVIEW_CODE_PAN_COLUMNS = 4;
export const REVIEW_ROUTE_HISTORY_LIMIT = 16;

const DIFF_SCREENS: ReadonlySet<StoryReviewScreen> = new Set(['walk', 'floor-diff', 'unassigned']);

export interface ReviewRouteSnapshot {
  screen: StoryReviewScreen;
  focus: StoryReviewFocus;
  readerPage: number;
  activeAct: number;
  activePart: number;
  activeItem: number;
  activeTarget: number;
  activeStoryItemId: string | null;
  attentionCursor: number;
  /** Durable identity of the selected Brief attention row; survives a rebuild. */
  attentionRowKey: string | null;
  commentCursor: number;
  flatFileCursor: number;
  floorCursor: number;
  /** Index into `BriefTree.destinations` — the Brief's tree-pane cursor. */
  briefCursor: number;
  /** Durable identity of the selected Brief destination; drives restoration. */
  briefDestinationKey: string | null;
  finishCursor: number;
  contextItemCursor: number;
  diffGrain: 'hunk' | 'row';
  diffSliceKey: string | null;
  diffHunkKey: string | null;
  diffRowCursor: number;
  diffSelectionAnchor: number | null;
  codeHorizontalOffset: number;
  fileNavigatorExpanded: boolean;
  fileFilter: string | null;
}

/**
 * Which Brief pane holds the cursor.
 *
 * `rail` is the LEFT pane on every screen in Review, so the Brief's overview and
 * attention queue take `rail` and the tree takes `diff`, which buys a focus
 * token that means the same thing spatially everywhere.
 */
export const BRIEF_TREE_FOCUS: StoryReviewFocus = 'diff';
export const BRIEF_OVERVIEW_FOCUS: StoryReviewFocus = 'rail';

/**
 * The pane a screen lands on when it is entered cold.
 *
 * Only matters because the Brief does not start on `rail`. Every in-app route
 * sets focus explicitly, so this is for the entry points that do not: the
 * initial controller state and the test harness. Deriving it from the screen is
 * what stops a harness from mounting Walk with the Brief's focus.
 */
export function initialFocusForReviewScreen(screen: StoryReviewScreen): StoryReviewFocus {
  // Every diff surface opens on the code, matching pageState: j/k drives the
  // diff cursor identically on parts and checkpoints.
  if (screen === 'brief') return BRIEF_TREE_FOCUS;
  return DIFF_SCREENS.has(screen) ? 'diff' : 'rail';
}

export interface ReviewControllerState extends ReviewRouteSnapshot {
  /** Null follows the default (Story when current); otherwise a session choice. */
  preferredLens: ReaderLens | null;
  routeHistory: readonly ReviewRouteSnapshot[];
  prefixStartedAt: number | null;
  showLineNumbers: boolean;
  wrapLines: boolean;
  showHunkHeaders: boolean;
  diffLayout: 'split' | 'stack' | 'auto';
  showOwnerLabels: boolean;
  notice: string | null;
}

export type ReviewControllerCommand =
  | { kind: 'none' }
  | { kind: 'refresh' }
  | { kind: 'quit' }
  | { kind: 'help' }
  | { kind: 'page'; direction: 1 | -1; half: boolean }
  | { kind: 'move-page'; direction: 1 | -1 }
  | { kind: 'move-unvisited'; direction: 1 | -1 }
  | { kind: 'scroll-diff-edge'; edge: 'top' | 'bottom' }
  | { kind: 'recenter-diff' }
  | { kind: 'move-diff-file'; direction: 1 | -1 }
  | { kind: 'move-list'; direction: 1 | -1 }
  | { kind: 'activate' }
  | { kind: 'activate-brief-attention'; intent: 'selected' | 'next' | 'previous' }
  | { kind: 'move-brief-attention'; direction: 1 | -1 }
  | { kind: 'move-diff-slice'; direction: 1 | -1 }
  | { kind: 'move-diff-row'; direction: 1 | -1 }
  | { kind: 'select-range' }
  | { kind: 'open-editor' }
  | { kind: 'expand-hidden'; wholeFile: boolean }
  | { kind: 'comment'; item: null }
  | {
      kind: 'story-item-action';
      itemId: string;
      action: 'ACKNOWLEDGE' | 'RESOLVE' | 'DISMISS' | 'REOPEN';
    }
  | { kind: 'copy-selection' }
  | { kind: 'move-pin'; direction: 1 | -1 }
  | { kind: 'filter-files' }
  | { kind: 'reply-selected-comment' }
  | { kind: 'resolve-selected-comment' }
  | {
      kind: 'context-item-action';
      action: 'ACKNOWLEDGE' | 'RESOLVE' | 'DISMISS' | 'REOPEN';
    }
  | { kind: 'acknowledge-all-context' }
  | { kind: 'set-thread-disposition'; action: 'SKIP' | 'PARTIAL' }
  | { kind: 'mark-reviewed' }
  | { kind: 'mark-inspected' }
  | { kind: 'finish-complete' }
  | { kind: 'finish-partial' }
  | { kind: 'resume' };

export interface ReviewDispatchResult {
  state: ReviewControllerState;
  command: ReviewControllerCommand;
  consumed: boolean;
}

export interface ReviewKeyLike {
  name?: string;
  sequence?: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export interface ReviewCommandInvocation {
  id: ReviewCommandId;
  gesture?: string;
}

export type ReviewEscapeStep =
  | { kind: 'clear-range' }
  | { kind: 'exit-row-grain' }
  | { kind: 'route'; route: ReviewRouteSnapshot | null }
  | { kind: 'review-root' };

export function initialReviewControllerState(): ReviewControllerState {
  return {
    screen: 'brief',
    preferredLens: null,
    routeHistory: [],
    focus: initialFocusForReviewScreen('brief'),
    readerPage: 0,
    activeAct: 0,
    activePart: 0,
    activeItem: 0,
    activeTarget: 0,
    activeStoryItemId: null,
    attentionCursor: 0,
    attentionRowKey: null,
    commentCursor: 0,
    flatFileCursor: 0,
    floorCursor: 0,
    briefCursor: 0,
    briefDestinationKey: null,
    finishCursor: 0,
    contextItemCursor: 0,
    diffGrain: 'hunk',
    diffSliceKey: null,
    diffHunkKey: null,
    diffRowCursor: 0,
    diffSelectionAnchor: null,
    prefixStartedAt: null,
    showLineNumbers: true,
    wrapLines: false,
    showHunkHeaders: true,
    diffLayout: 'auto',
    showOwnerLabels: false,
    codeHorizontalOffset: 0,
    fileNavigatorExpanded: true,
    fileFilter: null,
    notice: null,
  };
}

export function captureReviewRoute(state: ReviewControllerState): ReviewRouteSnapshot {
  return {
    screen: state.screen,
    focus: state.focus,
    readerPage: state.readerPage,
    activeAct: state.activeAct,
    activePart: state.activePart,
    activeItem: state.activeItem,
    activeTarget: state.activeTarget,
    activeStoryItemId: state.activeStoryItemId,
    attentionCursor: state.attentionCursor,
    attentionRowKey: state.attentionRowKey,
    commentCursor: state.commentCursor,
    flatFileCursor: state.flatFileCursor,
    floorCursor: state.floorCursor,
    briefCursor: state.briefCursor,
    briefDestinationKey: state.briefDestinationKey,
    finishCursor: state.finishCursor,
    contextItemCursor: state.contextItemCursor,
    diffGrain: state.diffGrain,
    diffSliceKey: state.diffSliceKey,
    diffHunkKey: state.diffHunkKey,
    diffRowCursor: state.diffRowCursor,
    diffSelectionAnchor: state.diffSelectionAnchor,
    codeHorizontalOffset: state.codeHorizontalOffset,
    fileNavigatorExpanded: state.fileNavigatorExpanded,
    fileFilter: state.fileFilter,
  };
}

export function pushReviewRoute(
  state: ReviewControllerState,
  next: ReviewControllerState
): ReviewControllerState {
  if (next.screen === state.screen) return { ...next, routeHistory: state.routeHistory };
  return {
    ...next,
    routeHistory: [...state.routeHistory, captureReviewRoute(state)].slice(
      -REVIEW_ROUTE_HISTORY_LIMIT
    ),
  };
}

export function popReviewRoute(state: ReviewControllerState): ReviewControllerState {
  const route = state.routeHistory.at(-1);
  if (route === undefined) {
    return {
      ...state,
      screen: 'brief',
      routeHistory: [],
      focus: BRIEF_TREE_FOCUS,
      diffGrain: 'hunk',
      diffRowCursor: 0,
      diffSelectionAnchor: null,
      prefixStartedAt: null,
      notice: null,
    };
  }
  return {
    ...state,
    ...route,
    routeHistory: state.routeHistory.slice(0, -1),
    prefixStartedAt: null,
    notice: null,
  };
}

export function resolveReviewEscapeStep(state: ReviewControllerState): ReviewEscapeStep {
  if (state.diffSelectionAnchor !== null) return { kind: 'clear-range' };
  if (DIFF_SCREENS.has(state.screen) && state.diffGrain === 'row') {
    return { kind: 'exit-row-grain' };
  }
  const route = state.routeHistory.at(-1) ?? null;
  if (state.screen === 'brief' && route === null) return { kind: 'review-root' };
  return { kind: 'route', route };
}

export function reviewIsAtRoot(state: ReviewControllerState): boolean {
  return state.screen === 'brief' && state.routeHistory.length === 0;
}

export function toggleReviewFileNavigator(state: ReviewControllerState): ReviewControllerState {
  return {
    ...state,
    fileNavigatorExpanded: !state.fileNavigatorExpanded,
    notice: null,
  };
}

export function panReviewCodeHorizontally(
  state: ReviewControllerState,
  delta: number
): ReviewControllerState {
  if (delta === 0) return state;
  if (state.wrapLines) {
    return { ...state, notice: 'Horizontal pan is unavailable while line wrapping is on' };
  }
  const codeHorizontalOffset = Math.max(0, state.codeHorizontalOffset + delta);
  return codeHorizontalOffset === state.codeHorizontalOffset
    ? {
        ...state,
        notice:
          delta < 0
            ? 'Already at the left edge of the code'
            : 'Already at the right edge of the code',
      }
    : { ...state, codeHorizontalOffset, notice: null };
}

export function clampReviewCodeHorizontalOffset(
  state: ReviewControllerState,
  maximumOffset: number
): ReviewControllerState {
  const codeHorizontalOffset = Math.min(
    Math.max(0, maximumOffset),
    Math.max(0, state.codeHorizontalOffset)
  );
  return codeHorizontalOffset === state.codeHorizontalOffset
    ? state
    : { ...state, codeHorizontalOffset };
}

export function resetReviewCodeHorizontalOffset(
  state: ReviewControllerState
): ReviewControllerState {
  return state.codeHorizontalOffset === 0 ? state : { ...state, codeHorizontalOffset: 0 };
}

export function reviewCommandOwnerViolation(
  state: ReviewControllerState,
  command: ReviewControllerCommand,
  page: ReaderPage | ReaderAuxiliaryPage | null
): string | null {
  switch (command.kind) {
    case 'mark-reviewed':
      return (state.screen === 'walk' && page?.kind === 'part') ||
        (state.screen === 'floor-diff' && page?.kind === 'checkpoint')
        ? null
        : 'Mark reviewed is unavailable outside its owning review page';
    case 'mark-inspected':
      return state.screen === 'unassigned' ||
        (state.screen === 'walk' &&
          page?.kind === 'part' &&
          page.ambiguousHunkKeys.includes(state.diffHunkKey ?? ''))
        ? null
        : 'Mark inspected is unavailable outside inspectable Story residue or ambiguity';
    case 'comment':
      return DIFF_SCREENS.has(state.screen)
        ? null
        : 'Comment authoring is unavailable on this screen';
    case 'story-item-action':
      return state.screen === 'walk' || state.screen === 'brief'
        ? null
        : 'Story item actions are unavailable on this screen';
    case 'context-item-action':
    case 'acknowledge-all-context':
    case 'set-thread-disposition':
      return state.screen === 'floor-diff'
        ? null
        : 'Checkpoint actions are available only on the deterministic diff';
    case 'reply-selected-comment':
    case 'resolve-selected-comment':
      return state.screen === 'comments' ? null : 'Comment actions are available only on Comments';
    case 'finish-complete':
    case 'finish-partial':
    case 'resume':
      return state.screen === 'finish' ? null : 'Lifecycle actions are available only on Finish';
    default:
      return null;
  }
}

function result(
  state: ReviewControllerState,
  command: ReviewControllerCommand = { kind: 'none' },
  consumed = true
): ReviewDispatchResult {
  return { state, command, consumed };
}

function dispatchEscape(state: ReviewControllerState): ReviewDispatchResult {
  const step = resolveReviewEscapeStep(state);
  if (step.kind === 'review-root') return result(state, { kind: 'quit' });
  if (step.kind === 'clear-range') {
    return result({ ...state, diffSelectionAnchor: null, notice: 'Range selection cleared' });
  }
  if (step.kind === 'exit-row-grain') {
    return result({
      ...state,
      diffGrain: 'hunk',
      diffRowCursor: 0,
      diffSelectionAnchor: null,
      notice: null,
    });
  }
  return result(popReviewRoute(state));
}

export function dispatchReviewRouteBack(state: ReviewControllerState): ReviewDispatchResult {
  return reviewIsAtRoot(state) ? result(state, { kind: 'quit' }) : result(popReviewRoute(state));
}

function dispatchPaneLeft(state: ReviewControllerState): ReviewDispatchResult | null {
  if (DIFF_SCREENS.has(state.screen) && state.diffGrain === 'row') {
    return result({
      ...state,
      diffGrain: 'hunk',
      diffRowCursor: 0,
      diffSelectionAnchor: null,
      notice: null,
    });
  }
  // The rail is the physically LEFT pane on walk and floor-diff alike
  // (ReaderWalk renders rail | diff for both), so ← moves focus toward it on
  // both. `unassigned` has no focusable rail.
  if (state.screen === 'walk' || state.screen === 'floor-diff') {
    return result(state.focus === 'diff' ? { ...state, focus: 'rail', notice: null } : state);
  }
  return null;
}

function dispatchShared(
  state: ReviewControllerState,
  gesture: string
): ReviewDispatchResult | null {
  if (gesture === 'R') return result(state, { kind: 'refresh' });
  if (gesture === '?') return result(state, { kind: 'help' });
  if (gesture === 'q' || gesture === 'esc') return dispatchEscape(state);
  // The Brief owns BOTH arrows, in its own block below. Every other screen sends
  // `←` to the pane/grain walk, where it has no `→` counterpart to stay beside.
  if (gesture === '←' && state.screen !== 'brief') return dispatchPaneLeft(state);
  if (gesture === 'C') {
    return state.screen === 'comments'
      ? result(popReviewRoute(state))
      : result(pushReviewRoute(state, { ...state, screen: 'comments', notice: null }));
  }
  if (gesture === 'F') {
    return state.screen === 'flat-files'
      ? result(popReviewRoute(state))
      : result(pushReviewRoute(state, { ...state, screen: 'flat-files', notice: null }));
  }
  if (gesture === '/' && (state.screen === 'flat-files' || DIFF_SCREENS.has(state.screen))) {
    return result(state, { kind: 'filter-files' });
  }
  if (state.screen === 'brief') {
    if (gesture === '⇥') {
      return result({
        ...state,
        focus: state.focus === BRIEF_TREE_FOCUS ? BRIEF_OVERVIEW_FOCUS : BRIEF_TREE_FOCUS,
        notice: null,
      });
    }
    // `←`/`→` NAME a pane: `←` the overview, `→` the tree. Directional rather
    // than a toggle, so pressing the same arrow twice is a settled no-op and
    // the arrow carries information `⇥` cannot. The Brief's panes are SIBLINGS,
    // not a container and its contents, so there is no grain for `→` to descend
    // into the way there is on a diff — which is what freed it from `↵`.
    if (gesture === '←' || gesture === '→') {
      const focus = gesture === '←' ? BRIEF_OVERVIEW_FOCUS : BRIEF_TREE_FOCUS;
      return result(state.focus === focus ? state : { ...state, focus, notice: null });
    }
    // `n`/`N` SELECT (two-step): they walk a visible cursor through the
    // attention queue and `↵` opens it. A one-press open teleports the reviewer
    // off the Brief with no visible selection to explain why.
    if (gesture === 'n') return result(state, { kind: 'move-brief-attention', direction: 1 });
    if (gesture === 'N') {
      return result(state, { kind: 'move-brief-attention', direction: -1 });
    }
    if (gesture === '↵') {
      // `↵` opens whatever the FOCUSED pane has selected — the Brief's ONE open.
      // `n`/`N` stay dedicated to the attention queue from either pane and never
      // move the tree cursor.
      return state.focus === BRIEF_OVERVIEW_FOCUS
        ? result(state, { kind: 'activate-brief-attention', intent: 'selected' })
        : result(state, { kind: 'activate' });
    }
  }
  if (
    (gesture === '[' || gesture === ']') &&
    (state.screen === 'walk' || state.screen === 'floor-diff')
  ) {
    return result(state, { kind: 'move-page', direction: gesture === ']' ? 1 : -1 });
  }
  if (!DIFF_SCREENS.has(state.screen)) return null;
  if (gesture === '1') return result({ ...state, diffLayout: 'split', notice: null });
  if (gesture === '2') return result({ ...state, diffLayout: 'stack', notice: null });
  if (gesture === '0') return result({ ...state, diffLayout: 'auto', notice: null });
  if (gesture === '\\') return result(toggleReviewFileNavigator(state));
  if (gesture === 'i' && state.screen === 'floor-diff') {
    return result({ ...state, showOwnerLabels: !state.showOwnerLabels, notice: null });
  }
  if (gesture === 'S-→') {
    return result(panReviewCodeHorizontally(state, REVIEW_CODE_PAN_COLUMNS));
  }
  if (gesture === 'S-←') {
    return result(panReviewCodeHorizontally(state, -REVIEW_CODE_PAN_COLUMNS));
  }
  if (gesture === 'C-l') return result(state, { kind: 'recenter-diff' });
  if (gesture === 'u' || gesture === 'C-u') {
    return result(state, { kind: 'page', direction: -1, half: true });
  }
  if (gesture === 'b' || gesture === 'pgup') {
    return result(state, { kind: 'page', direction: -1, half: false });
  }
  if (gesture === 'D' || gesture === 'C-d') {
    return result(state, { kind: 'page', direction: 1, half: true });
  }
  if (gesture === 'f' || gesture === 'space' || gesture === 'pgdn') {
    return result(state, { kind: 'page', direction: 1, half: false });
  }
  if (gesture === 'g') return result(state, { kind: 'scroll-diff-edge', edge: 'top' });
  if (gesture === 'G') return result(state, { kind: 'scroll-diff-edge', edge: 'bottom' });
  if (gesture === ',') return result(state, { kind: 'move-diff-file', direction: -1 });
  if (gesture === '.') return result(state, { kind: 'move-diff-file', direction: 1 });
  if (gesture === 'l') {
    return result({ ...state, showLineNumbers: !state.showLineNumbers, notice: null });
  }
  if (gesture === 'w') {
    return result({
      ...state,
      wrapLines: !state.wrapLines,
      codeHorizontalOffset: 0,
      notice: null,
    });
  }
  if (gesture === 'M') {
    return result({ ...state, showHunkHeaders: !state.showHunkHeaders, notice: null });
  }
  if (gesture === '{' || gesture === '}') {
    return result(state, { kind: 'move-pin', direction: gesture === '}' ? 1 : -1 });
  }
  if (gesture === 'v') {
    return state.diffGrain === 'row'
      ? result(state, { kind: 'select-range' })
      : result({ ...state, notice: 'Press Enter to select changed rows' });
  }
  if (gesture === 'Y') return result(state, { kind: 'copy-selection' });
  if (gesture === 'e') return result(state, { kind: 'open-editor' });
  if (gesture === 'z' || gesture === 'Z') {
    return result(state, { kind: 'expand-hidden', wholeFile: gesture === 'Z' });
  }
  return null;
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function pageState(
  state: ReviewControllerState,
  reader: ReaderModel,
  pageIndex: number,
  requested: { hunkKey: string | null; sliceKey: string | null }
): ReviewControllerState {
  const page = reader.pages[pageIndex];
  if (page === undefined) {
    return { ...state, notice: 'The requested review page is no longer available' };
  }
  const stop =
    page.sliceStops.find((candidate) => candidate.sliceKey === requested.sliceKey) ??
    page.sliceStops.find((candidate) => candidate.hunkKey === requested.hunkKey) ??
    page.sliceStops[0] ??
    null;
  return pushReviewRoute(state, {
    ...state,
    screen: page.kind === 'part' ? 'walk' : 'floor-diff',
    // Parts open on the code exactly like checkpoints; the rail is a passive
    // cursor reached via Tab/←.
    focus: 'diff',
    readerPage: pageIndex,
    activeAct: page.kind === 'part' ? page.actIndex : 0,
    activePart: page.kind === 'part' ? page.partIndex : 0,
    activeItem: 0,
    activeTarget: 0,
    activeStoryItemId: null,
    contextItemCursor: 0,
    diffGrain: 'hunk',
    diffSliceKey: stop?.sliceKey ?? null,
    diffHunkKey: stop?.hunkKey ?? null,
    diffRowCursor: 0,
    diffSelectionAnchor: null,
    notice: null,
  });
}

/**
 * What to say when a floor row's hunk reaches no page in the live reader.
 *
 * When a Part AUTHORED that hunk and the projection is stale, this is not a
 * mystery: the exact-match join no longer holds, so the mapping dropped while
 * the Part that owned it still reads. Saying only that no page carries the row
 * describes the mechanism rather than the cause, and a reviewer had to already
 * know the lens was degraded to decode it. The wording is the Part rail's, so
 * someone who has met `Code mappings unavailable` on a Part meets it again here
 * instead of a second name for one thing.
 *
 * Authorship is the gate, NOT staleness on its own. Contested, gap and unowned
 * residue reach no Story page whether every mapping survived or none did — they
 * were never Part mappings, so nothing dropped them, and blaming the projection
 * for those rows is simply false. A surviving authored mapping does still get a
 * page, so authored + stale + no page is sound evidence that it was dropped.
 *
 * Takes the reader and the hunkKey together rather than two booleans: a caller
 * can otherwise pair a stale flag with a hunk it does not describe, and a
 * signature that carries both makes that pairing impossible.
 */
export function unavailableEvidenceNotice(reader: ReaderModel | null, hunkKey: string): string {
  const authoredByPart =
    reader?.story?.parts.some(
      (part) =>
        part.segments.some((segment) => segment.hunkKey === hunkKey) ||
        part.ambiguous.some((entry) => entry.hunkKey === hunkKey)
    ) === true;
  return reader?.staleProjection === true && authoredByPart
    ? 'Code mapping unavailable · dropped by the stale Story projection'
    : 'Selected evidence is not represented on any review page';
}

export function activateReaderDestination(
  state: ReviewControllerState,
  reader: ReaderModel,
  destination: ReaderRouteDestination
): ReviewControllerState {
  switch (destination.kind) {
    case 'page': {
      const routed = pageState(state, reader, destination.pageIndex, destination);
      if (destination.semanticPlacementId === undefined) return routed;
      const placement = reader.routeIndex.semanticPlacementById.get(
        destination.semanticPlacementId
      );
      return placement === undefined
        ? routed
        : {
            ...routed,
            activeStoryItemId: placement.itemId,
            activeTarget: placement.locationIndex,
            diffGrain: placement.displayTarget.kind === 'line' ? 'row' : 'hunk',
            diffRowCursor: placement.rowCursor,
            notice:
              placement.target.focus_status === 'REJECTED_INVALID'
                ? `Requested focus was rejected: ${placement.target.focus_diagnostic_code}`
                : null,
          };
    }
    case 'auxiliary': {
      const stop =
        reader.auxiliaryPage.sliceStops.find(
          (candidate) => candidate.sliceKey === destination.sliceKey
        ) ??
        reader.auxiliaryPage.sliceStops.find(
          (candidate) => candidate.hunkKey === destination.hunkKey
        ) ??
        reader.auxiliaryPage.sliceStops[0] ??
        null;
      const routed = pushReviewRoute(state, {
        ...state,
        screen: 'unassigned',
        focus: 'diff',
        diffGrain: 'hunk',
        diffSliceKey: stop?.sliceKey ?? null,
        diffHunkKey: stop?.hunkKey ?? null,
        diffRowCursor: 0,
        diffSelectionAnchor: null,
        notice: null,
      });
      if (destination.semanticPlacementId === undefined) return routed;
      const placement = reader.routeIndex.semanticPlacementById.get(
        destination.semanticPlacementId
      );
      return placement === undefined
        ? routed
        : {
            ...routed,
            activeStoryItemId: placement.itemId,
            activeTarget: placement.locationIndex,
            diffGrain: placement.displayTarget.kind === 'line' ? 'row' : 'hunk',
            diffRowCursor: placement.rowCursor,
          };
    }
    case 'deterministic-page': {
      const placement = reader.routeIndex.semanticPlacementById.get(
        destination.semanticPlacementId
      );
      return pushReviewRoute(state, {
        ...state,
        preferredLens: 'deterministic',
        screen: 'floor-diff',
        focus: 'diff',
        readerPage: destination.pageIndex,
        activeStoryItemId: placement?.itemId ?? null,
        activeTarget: placement?.locationIndex ?? 0,
        diffGrain: placement?.displayTarget.kind === 'line' ? 'row' : 'hunk',
        diffSliceKey: destination.sliceKey,
        diffHunkKey: destination.hunkKey,
        diffRowCursor: placement?.rowCursor ?? 0,
        diffSelectionAnchor: null,
        notice: 'Opened the deterministic floor because this target is foreign to every Story Part',
      });
    }
    case 'item-detail':
      return pushReviewRoute(state, {
        ...state,
        screen: 'captured-context',
        focus: 'rail',
        activeStoryItemId: destination.itemId,
        notice: null,
      });
    case 'finish':
      return pushReviewRoute(state, {
        ...state,
        screen: 'finish',
        finishCursor: 0,
        notice: null,
      });
    case 'flat-file':
      return pushReviewRoute(state, {
        ...state,
        screen: 'flat-files',
        notice: `Select ${destination.file}`,
      });
    case 'attention': {
      const attentionCursor = reader.routeIndex.attentionItems.findIndex(
        (item) => item.id === destination.itemId
      );
      const floorCursor = reader.routeIndex.briefRows.findIndex(
        (row) =>
          row.destination.kind === 'attention' && row.destination.itemId === destination.itemId
      );
      return {
        ...state,
        screen: 'brief',
        attentionCursor: Math.max(0, attentionCursor),
        attentionRowKey: `item:${destination.itemId}`,
        floorCursor: Math.max(0, floorCursor),
        activeStoryItemId: destination.itemId,
        notice: null,
      };
    }
  }
}

/**
 * Open the Brief's TREE selection — the one activation path for Checkpoints,
 * Parts, Unassigned/Residue and Finish, on both lenses.
 *
 * Takes the cursor INDEX rather than a bare destination so the selection
 * identity is written before the push. `pushReviewRoute` snapshots the ORIGIN
 * state, so a route entered without first recording cursor and key would leave
 * Back restoring the row the reviewer left from instead of the one they opened.
 * Requiring the index here makes that impossible to forget.
 */
export function activateBriefDestination(
  state: ReviewControllerState,
  reader: ReaderModel,
  tree: BriefTree,
  index: number
): ReviewControllerState {
  const destination = tree.destinations[index];
  if (destination === undefined) {
    return { ...state, notice: 'No Brief destination is selected' };
  }
  const selected: ReviewControllerState = {
    ...state,
    briefCursor: index,
    briefDestinationKey: destination.key,
  };
  if (destination.kind === 'finish') {
    return pushReviewRoute(selected, {
      ...selected,
      screen: 'finish',
      finishCursor: 0,
      notice: null,
    });
  }
  if (destination.kind === 'unassigned') {
    return activateReaderDestination(selected, reader, {
      kind: 'auxiliary',
      pageKey: reader.auxiliaryPage.key,
      hunkKey: null,
      sliceKey: null,
    });
  }
  // A leaf already names its own ReaderPage. Do NOT reconstruct that identity
  // from a parent hunk: hunks are rendering context and can be shared by
  // checkpoints in different artifacts, so the round trip can land elsewhere.
  return pageState(selected, reader, destination.pageIndex, { hunkKey: null, sliceKey: null });
}

/**
 * Open one ATTENTION row that routes through the Story's rail items.
 *
 * The obligation-backed rows on the deterministic lens are opened by the app,
 * which owns the finish-obligation routes; both paths write cursor and key
 * before pushing, for the reason spelled out on `activateBriefDestination`.
 */
export function activateBriefAttentionItem(
  state: ReviewControllerState,
  reader: ReaderModel,
  itemId: string
): ReviewControllerState {
  const item = reader.routeIndex.itemById.get(itemId);
  if (item === undefined) {
    return { ...state, notice: 'This attention item is no longer available' };
  }
  const destinations = reader.routeIndex.destinationsByItemId.get(itemId) ?? [];
  if (destinations.length === 0) {
    // An unplaced item still has a detail surface; Enter must not be a no-op.
    return activateReaderDestination(
      { ...state, activeStoryItemId: itemId, notice: null },
      reader,
      {
        kind: 'item-detail',
        itemId,
      }
    );
  }
  return activateStoryItemTarget(state, reader, item, 0);
}

function currentRailItems(
  state: ReviewControllerState,
  reader: ReaderModel
): readonly ReaderRailItem[] {
  const page = reader.pages[state.readerPage];
  return page?.kind === 'part' ? page.railItems : [];
}

function selectedStoryItem(
  state: ReviewControllerState,
  reader: ReaderModel
): ReaderRailItem | undefined {
  if (state.screen === 'walk') return currentRailItems(state, reader)[state.activeItem];
  if (state.screen === 'captured-context' && state.activeStoryItemId !== null) {
    return reader.routeIndex.itemById.get(state.activeStoryItemId);
  }
  if (state.screen !== 'brief') return undefined;
  // The Brief's disposition target is its ATTENTION selection. The durable row
  // key already names the item; before traversal starts, the queue's order is
  // the rail's attention order, so the numeric cursor resolves the same row the
  // pane paints.
  if (state.attentionRowKey?.startsWith('item:') === true) {
    return reader.routeIndex.itemById.get(state.attentionRowKey.slice('item:'.length));
  }
  const item =
    reader.routeIndex.attentionItems[
      clampIndex(state.attentionCursor, reader.routeIndex.attentionItems.length)
    ];
  return item === undefined ? undefined : reader.routeIndex.itemById.get(item.id);
}

export function activateReaderRailItem(
  state: ReviewControllerState,
  reader: ReaderModel,
  itemIndex: number,
  targetIndex = 0
): ReviewControllerState {
  const items = currentRailItems(state, reader);
  const item = items[clampIndex(itemIndex, items.length)];
  if (item === undefined) return { ...state, notice: 'No Story context item is available' };
  return activateStoryItemTarget(state, reader, item, targetIndex, itemIndex);
}

function activateStoryItemTarget(
  state: ReviewControllerState,
  reader: ReaderModel,
  item: ReaderRailItem,
  targetIndex: number,
  itemIndex = state.activeItem
): ReviewControllerState {
  const destinations = reader.routeIndex.destinationsByItemId.get(item.id) ?? [];
  const destination = destinations[clampIndex(targetIndex, destinations.length)];
  const selected = {
    ...state,
    activeItem: itemIndex,
    activeTarget: clampIndex(targetIndex, destinations.length),
    activeStoryItemId: item.id,
    notice: null,
  };
  if (destination === undefined || destination.kind === 'attention') return selected;
  const routed = activateReaderDestination(
    destination.kind === 'deterministic-page' ? selected : { ...selected, preferredLens: 'story' },
    reader,
    destination
  );
  const destinationPage = reader.pages[routed.readerPage];
  const destinationItem =
    routed.screen === 'walk' && destinationPage?.kind === 'part'
      ? destinationPage.railItems.findIndex((candidate) => candidate.id === item.id)
      : -1;
  return {
    ...routed,
    activeItem: destinationItem < 0 ? selected.activeItem : destinationItem,
    activeTarget: selected.activeTarget,
    activeStoryItemId: item.id,
    focus: destination.kind === 'page' ? 'diff' : routed.focus,
  };
}

/** Keep the compact rail selection aligned with an exact semantic code target. */
export function synchronizeRailToTarget(
  state: ReviewControllerState,
  reader: ReaderModel,
  target: {
    pageKey: string;
    hunkKey: string;
    row?: { side: 'add' | 'delete'; line: number } | null;
  }
): ReviewControllerState {
  const matches = [...reader.routeIndex.semanticPlacementById.values()].filter((candidate) => {
    if (
      candidate.destination.pageKey !== target.pageKey ||
      candidate.destination.hunkKey !== target.hunkKey
    ) {
      return false;
    }
    return (
      target.row === null ||
      target.row === undefined ||
      candidate.highlightedRows.some(
        (row) => row.side === target.row!.side && row.line === target.row!.line
      )
    );
  });
  // Overlapping semantic targets are legal. Keep the active canonical item
  // selected while its target still contains the code cursor; otherwise use
  // stable placement order. This prevents cursor motion on one focused card
  // from jumping the rail to an overlapping whole-block citation.
  const placement =
    matches.find((candidate) => candidate.itemId === state.activeStoryItemId) ?? matches[0];
  if (placement === undefined) return state;
  const page = reader.pages.find((candidate) => candidate.key === target.pageKey);
  const activeItem =
    page?.kind === 'part'
      ? Math.max(
          0,
          page.railItems.findIndex((item) => item.id === placement.itemId)
        )
      : state.activeItem;
  return {
    ...state,
    activeItem,
    activeTarget: placement.locationIndex,
    activeStoryItemId: placement.itemId,
  };
}

function navigateStoryAttention(
  state: ReviewControllerState,
  reader: ReaderModel,
  direction: 1 | -1
): ReviewControllerState {
  const items = reader.routeIndex.attentionItems;
  if (items.length === 0) return { ...state, notice: 'No Story Attention items' };
  const attentionCursor = (state.attentionCursor + direction + items.length) % items.length;
  const item = items[attentionCursor]!;
  return activateReaderDestination({ ...state, attentionCursor, notice: null }, reader, {
    kind: 'attention',
    itemId: item.id,
  });
}

/**
 * Blocks shared VERBATIM by both gesture dispatchers, extracted so the aligned
 * behavior cannot drift again. The keys that stay in the dispatchers are the
 * intentional lens differences (`;`-prefix, walk attention, `(`/`)`, `i`/`A`/
 * `s`/`p`), not duplication.
 */
function dispatchFinishLifecycleGesture(
  state: ReviewControllerState,
  gesture: string,
  lifecycle: ReviewLifecycleLedger
): ReviewDispatchResult | null {
  if (state.screen !== 'finish') return null;
  if (gesture === '↵') {
    return lifecycle.state === 'OPEN'
      ? result(state, { kind: 'finish-complete' })
      : result({ ...state, notice: 'This review is already finished; reopen it first' });
  }
  if (gesture === 'p' && lifecycle.state === 'OPEN') {
    return result(state, { kind: 'finish-partial' });
  }
  if (gesture === 'r') {
    return lifecycle.state === 'OPEN'
      ? result({ ...state, notice: 'Review is already open' })
      : result(state, { kind: 'resume' });
  }
  return null;
}

function dispatchCommentListGesture(
  state: ReviewControllerState,
  gesture: string
): ReviewDispatchResult | null {
  if (state.screen !== 'comments') return null;
  if (gesture === 'y') return result(state, { kind: 'reply-selected-comment' });
  if (gesture === 'x') return result(state, { kind: 'resolve-selected-comment' });
  return null;
}

/** ⇥ flips between the screen's two panes; identical on walk and floor-diff. */
function toggledPaneFocus(state: ReviewControllerState): ReviewControllerState {
  return { ...state, focus: state.focus === 'rail' ? 'diff' : 'rail', notice: null };
}

/** ↵ at hunk grain descends into rows; at row grain it is a settled no-op. */
function enteredRowGrain(state: ReviewControllerState): ReviewControllerState {
  return { ...state, diffGrain: 'row', diffRowCursor: 0, diffSelectionAnchor: null };
}

/** A passive rail cursor: clamp plus boundary notice, never a route. */
function passiveCursorStep(
  index: number,
  direction: 1 | -1,
  count: number,
  labels: { first: string; last: string }
): { index: number; notice: string | null } {
  const next = clampIndex(index + direction, count);
  return {
    index: next,
    notice: next === index ? (direction === 1 ? labels.last : labels.first) : null,
  };
}

function dispatchStoryGesture(
  state: ReviewControllerState,
  gesture: string,
  reader: ReaderModel,
  lifecycle: ReviewLifecycleLedger,
  nowMs: number
): ReviewDispatchResult {
  if (state.prefixStartedAt !== null) {
    if (nowMs - state.prefixStartedAt > REVIEW_PREFIX_TIMEOUT_MS) {
      return result({ ...state, prefixStartedAt: null, notice: 'Unvisited prefix timed out' });
    }
    if (gesture === 'n' || gesture === 'p') {
      return result(
        { ...state, prefixStartedAt: null },
        { kind: 'move-unvisited', direction: gesture === 'n' ? 1 : -1 }
      );
    }
    return result({
      ...state,
      prefixStartedAt: null,
      notice: `Unknown unvisited command ;${gesture}`,
    });
  }
  if ((gesture === ';n' || gesture === ';p') && state.screen === 'walk') {
    return result(state, { kind: 'move-unvisited', direction: gesture === ';n' ? 1 : -1 });
  }
  if (gesture === ';' && state.screen === 'walk') {
    return result({ ...state, prefixStartedAt: nowMs, notice: '; waiting for unvisited n/p' });
  }
  const shared = dispatchShared(state, gesture);
  if (shared !== null) return shared;
  if (gesture === 'n' && state.screen === 'walk') {
    return result(navigateStoryAttention(state, reader, 1));
  }
  if (gesture === 'N' && state.screen === 'walk') {
    return result(navigateStoryAttention(state, reader, -1));
  }
  if ((gesture === '(' || gesture === ')') && DIFF_SCREENS.has(state.screen)) {
    const item =
      (state.activeStoryItemId === null
        ? undefined
        : reader.routeIndex.itemById.get(state.activeStoryItemId)) ??
      (state.screen === 'walk' ? currentRailItems(state, reader)[state.activeItem] : undefined);
    const targets =
      item === undefined ? [] : (reader.routeIndex.destinationsByItemId.get(item.id) ?? []);
    if (targets.length < 2) return result({ ...state, notice: 'No other related locations' });
    const activeTarget =
      (state.activeTarget + (gesture === ')' ? 1 : -1) + targets.length) % targets.length;
    return result(activateStoryItemTarget(state, reader, item!, activeTarget));
  }
  if (gesture === '⇥' && state.screen === 'walk') {
    return result(toggledPaneFocus(state));
  }
  if (gesture === 'c' && (state.screen === 'walk' || state.screen === 'unassigned')) {
    return result(state, { kind: 'comment', item: null });
  }
  const finish = dispatchFinishLifecycleGesture(state, gesture, lifecycle);
  if (finish !== null) return finish;
  if (gesture === 'm' && state.screen === 'unassigned') {
    return result(state, { kind: 'mark-inspected' });
  }
  if (gesture === 'm' && state.screen === 'walk') {
    const page = reader.pages[state.readerPage];
    if (page?.kind !== 'part') return result({ ...state, notice: 'No Story Part is selected' });
    if (page.ambiguousHunkKeys.includes(state.diffHunkKey ?? '')) {
      return result(state, { kind: 'mark-inspected' });
    }
    return page.markReviewedEnabled
      ? result(state, { kind: 'mark-reviewed' })
      : result({ ...state, notice: 'Mark reviewed is blocked' });
  }
  if (
    (state.screen === 'brief' ||
      state.screen === 'captured-context' ||
      (state.screen === 'walk' && state.focus === 'rail')) &&
    (gesture === 'a' || gesture === 'r' || gesture === 'd' || gesture === 'o')
  ) {
    const item = selectedStoryItem(state, reader);
    if (item === undefined || item.kind === 'citation' || item.kind === 'ledger') {
      return result({ ...state, notice: 'This context record has no reviewer disposition' });
    }
    return result(state, {
      kind: 'story-item-action',
      itemId: item.id,
      action:
        gesture === 'a'
          ? 'ACKNOWLEDGE'
          : gesture === 'r'
            ? 'RESOLVE'
            : gesture === 'd'
              ? 'DISMISS'
              : 'REOPEN',
    });
  }
  if ((gesture === '↵' || gesture === '→') && state.screen === 'walk') {
    if (state.focus === 'rail') {
      // The rail cursor is passive, so `activeTarget` still describes the LAST
      // activated item. Re-activating that same item keeps its cycled target;
      // activating a newly selected one starts at its first location.
      const selected = currentRailItems(state, reader)[state.activeItem];
      const target =
        selected !== undefined && selected.id === state.activeStoryItemId ? state.activeTarget : 0;
      return result(activateReaderRailItem(state, reader, state.activeItem, target));
    }
    return state.diffGrain === 'hunk' ? result(enteredRowGrain(state)) : result(state);
  }
  if ((gesture === '↵' || gesture === '→') && state.screen === 'unassigned') {
    return result(enteredRowGrain(state));
  }
  if (
    (gesture === '↵' || gesture === '→') &&
    (state.screen === 'comments' || state.screen === 'flat-files')
  ) {
    return result(state, { kind: 'activate' });
  }
  const commentList = dispatchCommentListGesture(state, gesture);
  if (commentList !== null) return commentList;
  if (gesture === 'j' || gesture === '↓' || gesture === 'k' || gesture === '↑') {
    const direction: 1 | -1 = gesture === 'j' || gesture === '↓' ? 1 : -1;
    if (state.screen === 'walk' && state.focus === 'rail') {
      // A PASSIVE cursor, exactly like the checkpoint rail: moving the
      // selection must not re-route the diff — Enter activates. Activating every
      // step yanks the code pane while the reviewer browses.
      const items = currentRailItems(state, reader);
      if (items.length === 0) {
        return result({ ...state, notice: 'No Story context items on this Part' });
      }
      const step = passiveCursorStep(state.activeItem, direction, items.length, {
        first: 'First context item',
        last: 'Last context item',
      });
      return result({ ...state, activeItem: step.index, notice: step.notice });
    }
    return result(
      state,
      state.screen === 'walk' || state.screen === 'unassigned'
        ? state.diffGrain === 'row'
          ? { kind: 'move-diff-row', direction }
          : { kind: 'move-diff-slice', direction }
        : { kind: 'move-list', direction }
    );
  }
  return result(state, { kind: 'none' }, false);
}

function dispatchFloorGesture(
  state: ReviewControllerState,
  gesture: string,
  lifecycle: ReviewLifecycleLedger,
  context: { contextItemCount: number }
): ReviewDispatchResult {
  const shared = dispatchShared(state, gesture);
  if (shared !== null) return shared;
  const finish = dispatchFinishLifecycleGesture(state, gesture, lifecycle);
  if (finish !== null) return finish;
  if (gesture === 'm' && (state.screen === 'floor-diff' || state.screen === 'unassigned')) {
    return result(
      state,
      state.screen === 'unassigned' ? { kind: 'mark-inspected' } : { kind: 'mark-reviewed' }
    );
  }
  if (gesture === '⇥' && state.screen === 'floor-diff') {
    return result(toggledPaneFocus(state));
  }
  if (state.screen === 'floor-diff' && gesture === 'A') {
    return result(state, { kind: 'acknowledge-all-context' });
  }
  if (state.screen === 'floor-diff' && gesture === 's') {
    return result(state, { kind: 'set-thread-disposition', action: 'SKIP' });
  }
  if (state.screen === 'floor-diff' && gesture === 'p') {
    return result(state, { kind: 'set-thread-disposition', action: 'PARTIAL' });
  }
  if (
    state.screen === 'floor-diff' &&
    state.focus === 'rail' &&
    (gesture === 'a' || gesture === 'r' || gesture === 'd' || gesture === 'o')
  ) {
    return result(state, {
      kind: 'context-item-action',
      action:
        gesture === 'a'
          ? 'ACKNOWLEDGE'
          : gesture === 'r'
            ? 'RESOLVE'
            : gesture === 'd'
              ? 'DISMISS'
              : 'REOPEN',
    });
  }
  if (gesture === 'c' && (state.screen === 'floor-diff' || state.screen === 'unassigned')) {
    return result(state, { kind: 'comment', item: null });
  }
  const commentList = dispatchCommentListGesture(state, gesture);
  if (commentList !== null) return commentList;
  if (
    (gesture === '↵' || gesture === '→') &&
    (state.screen === 'floor-diff' || state.screen === 'unassigned')
  ) {
    return result(enteredRowGrain(state));
  }
  if (
    (gesture === '↵' || gesture === '→') &&
    (state.screen === 'flat-files' || state.screen === 'comments')
  ) {
    return result(state, { kind: 'activate' });
  }
  if (gesture === 'j' || gesture === '↓' || gesture === 'k' || gesture === '↑') {
    const direction: 1 | -1 = gesture === 'j' || gesture === '↓' ? 1 : -1;
    if (state.screen === 'floor-diff' && state.focus === 'rail') {
      if (context.contextItemCount === 0) {
        return result({ ...state, notice: 'No actionable captured items on this checkpoint' });
      }
      const step = passiveCursorStep(state.contextItemCursor, direction, context.contextItemCount, {
        first: 'First captured item',
        last: 'Last captured item',
      });
      return result({ ...state, contextItemCursor: step.index, notice: step.notice });
    }
    return result(
      state,
      state.screen === 'floor-diff' || state.screen === 'unassigned'
        ? state.diffGrain === 'row'
          ? { kind: 'move-diff-row', direction }
          : { kind: 'move-diff-slice', direction }
        : { kind: 'move-list', direction }
    );
  }
  return result(state, { kind: 'none' }, false);
}

function gestureForReviewCommand(
  state: ReviewControllerState,
  invocation: ReviewCommandInvocation,
  lens: ReaderLens
): string | null {
  const command = resolveReviewCommand(
    invocation.id,
    state.screen,
    {
      atRoot: reviewIsAtRoot(state),
    },
    lens
  );
  if (!command.visible || !command.enabled) return null;
  const gesture = invocation.gesture ?? command.gestures[0];
  return gesture !== undefined && command.gestures.includes(gesture) ? gesture : null;
}

function commandForGesture(
  state: ReviewControllerState,
  gesture: string,
  lens: ReaderLens,
  staleStory = false
): ReviewCommandId | null {
  return (
    selectVisibleReviewCommands(
      state.screen,
      { atRoot: reviewIsAtRoot(state) },
      lens,
      staleStory
    ).find((command) => command.gestures.includes(gesture))?.id ?? null
  );
}

export function dispatchFloorReviewCommand(
  state: ReviewControllerState,
  invocation: ReviewCommandInvocation,
  lifecycle: ReviewLifecycleLedger,
  context: { contextItemCount: number } = { contextItemCount: 0 }
): ReviewDispatchResult {
  const gesture = gestureForReviewCommand(state, invocation, 'deterministic');
  return gesture === null
    ? result(state, { kind: 'none' }, false)
    : dispatchFloorGesture(state, gesture, lifecycle, context);
}

export function dispatchFloorReviewKey(
  state: ReviewControllerState,
  key: ReviewKeyLike,
  lifecycle: ReviewLifecycleLedger,
  context: { contextItemCount: number } = { contextItemCount: 0 }
): ReviewDispatchResult {
  const gesture = normalizeCommandGesture(key);
  const id = commandForGesture(state, gesture, 'deterministic');
  return id === null
    ? result(state, { kind: 'none' }, false)
    : dispatchFloorReviewCommand(state, { id, gesture }, lifecycle, context);
}

export interface ReaderReviewDispatchContext {
  reader: ReaderModel;
  lifecycle: ReviewLifecycleLedger;
  contextItemCount?: number;
}

export function dispatchReaderReviewCommand(
  state: ReviewControllerState,
  invocation: ReviewCommandInvocation,
  context: ReaderReviewDispatchContext,
  nowMs: number
): ReviewDispatchResult {
  if (context.reader.lens === 'deterministic') {
    return dispatchFloorReviewCommand(state, invocation, context.lifecycle, {
      contextItemCount: context.contextItemCount ?? 0,
    });
  }
  const gesture = gestureForReviewCommand(state, invocation, 'story');
  return gesture === null
    ? result(state, { kind: 'none' }, false)
    : dispatchStoryGesture(state, gesture, context.reader, context.lifecycle, nowMs);
}

export function dispatchReaderReviewKey(
  state: ReviewControllerState,
  key: ReviewKeyLike,
  context: ReaderReviewDispatchContext,
  nowMs: number
): ReviewDispatchResult {
  const gesture = normalizeCommandGesture(key);
  if (
    context.reader.lens === 'story' &&
    state.activeStoryItemId !== null &&
    DIFF_SCREENS.has(state.screen) &&
    (gesture === '(' || gesture === ')')
  ) {
    return dispatchStoryGesture(state, gesture, context.reader, context.lifecycle, nowMs);
  }
  if (
    context.reader.lens === 'story' &&
    (state.prefixStartedAt !== null || (gesture === ';' && state.screen === 'walk'))
  ) {
    return dispatchStoryGesture(state, gesture, context.reader, context.lifecycle, nowMs);
  }
  const id = commandForGesture(
    state,
    gesture,
    context.reader.lens,
    context.reader.staleProjection === true
  );
  return id === null
    ? result(state, { kind: 'none' }, false)
    : dispatchReaderReviewCommand(state, { id, gesture }, context, nowMs);
}

export function claimConsumedReviewKey(key: ReviewKeyLike, consumed: boolean): boolean {
  if (consumed) key.preventDefault?.();
  return consumed;
}

export type GuardedCoverageAppendResult =
  | { status: 'appended'; event: ReviewCoverageJournalEvent }
  | { status: 'retry'; message: string }
  | { status: 'no_rows'; message: string }
  | { status: 'blocked'; message: string };

export async function appendPageCoverageGuarded(input: {
  page: ReaderPage;
  floorInputHash: string;
  ledger: ReviewLedgerV2;
  currentThreads: readonly CurrentThreadManifest[];
  readGeneration: () => { floorInputHash: string; ledgerGeneration: string };
  append: (event: ReviewCoverageJournalEvent) => Promise<JournalAppendResult>;
}): Promise<GuardedCoverageAppendResult> {
  const prepared = await preparePageCoverage({
    page: input.page,
    floorInputHash: input.floorInputHash,
    ledger: input.ledger,
    currentThreads: input.currentThreads,
  });
  if (prepared.status === 'no_rows') {
    return { status: 'no_rows', message: 'This page owns no rows — nothing to cover' };
  }
  if (prepared.status === 'invalid') return { status: 'blocked', message: prepared.message };
  const current = input.readGeneration();
  if (
    current.floorInputHash !== input.floorInputHash ||
    current.ledgerGeneration !== input.ledger.ledgerGeneration
  ) {
    return { status: 'retry', message: 'Review data refreshed mid-mark — press m again' };
  }
  const append = await input.append(prepared.event);
  if (append.status === 'appended') return { status: 'appended', event: prepared.event };
  if (
    append.code === 'STALE_FLOOR' ||
    append.code === 'STALE_STORY' ||
    append.code === 'STALE_LEDGER'
  ) {
    return { status: 'retry', message: 'Review data refreshed mid-mark — press m again' };
  }
  return { status: 'blocked', message: append.message };
}
