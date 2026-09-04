import type { ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { stripTerminalFormatting } from '@orcaops/evaluator-protocol/terminal';
import { DEFAULT_THRESHOLDS } from '@orcaops/watch-data/ui';
import { reclassify } from '@orcaops/watch-data/ui';

import { CockpitThemeContext, type ThemeRow, useThemeControls } from './ThemeProvider';
import { executableHelpInvocation, normalizeCommandGesture } from './commandRegistry';
import {
  buildDetail,
  buildTaskDetail,
  detailRefLine,
  type TaskDetailModel,
  taskMemberRefLine,
} from './detail';
import { EmptyState, ErrorState, Notice, Section } from './kit';
import { displayLen, truncate } from './layout';
import { type ResolveReviewTarget, resolveReviewTarget } from '../data/reviewTarget';
import type { SnapshotSource } from '../data/snapshot';
import { createSnapshotSource } from '../data/source';
import { DetailPane } from './components/DetailPane';
import { KeyHints } from './components/KeyHints';
import { LiveEvents } from './components/LiveEvents';
import { LoadingScreen } from './components/LoadingScreen';
import { type ShellAction, ShellMenuBar, ShellMenuDropdown } from './components/ShellMenuBar';
import { TaskDetailPane } from './components/TaskDetailPane';
import { ThreadRail } from './components/ThreadRail';
import { TopBar } from './components/TopBar';
import { useSnapshot } from './hooks/useSnapshot';
import { shutdown } from './lifecycle';
import { allocateShellHeight } from './responsiveLayout';
import { executableHelpEntries, type ExecutableHelpEntry, HelpDialog } from './review/HelpDialog';
import { ReviewApp, type ReviewAppProps } from './review/ReviewApp';
import { ThemeSelectorDialog } from './review/ThemeSelectorDialog';
import { type HelpSection, storyReviewRouteLabel, type StoryReviewScreen } from './review/keymap';
import { reviewIsAtRoot } from './review/readerReviewController';
import { scrollBy, scrollByViewport, scrollTo } from './scroll';
import {
  resolveShellCommand,
  resolveShellCommandForKey,
  selectShellHelpCommands,
  selectShellMenuSections,
  type ShellCommandId,
  type ShellContext,
} from './shellCommands';
import {
  nextShellMenuItem,
  type ShellMenuGroup as ShellMenuGroupModel,
  type ShellMenuId,
} from './shellMenuModel';
import {
  nextAppearanceFilter,
  reselectAfterFilter,
  type ThemeAppearanceFilter,
  themeRowsForFilter,
} from './themeSelection';
import { fmtLocalTime } from './time';
import {
  findThread,
  type GroupBy,
  GROUPBY_ORDER,
  navOrder,
  navRows,
  railGroups,
  railLineCount,
  railLineOffset,
  type RailSelectionAnchor,
  railSelectionAnchor,
  repoNames,
  resolveRailSelection,
  type StatusFilter,
  totalThreads,
} from './viewModel';
import {
  resolveWatchCommand,
  resolveWatchCommandForKey,
  selectWatchCommands,
  type WatchCommandContext,
  type WatchCommandId,
} from './watchCommands';

const INLINE_NOTICE_GLYPH_WIDTH = 2;
export const MIXED_ARCHIVE_NOTICE_PREFIX = 'ID+archive · doctor/repair · ';

/**
 * Persistent archive disclosure wins the left edge of the one-row footer.
 * A transient notice still follows it, but only that transient half is
 * truncated while the compact persistent prefix fits.
 */
export function composeWatchFooterNotice(
  notice: string | null,
  archiveIssueNotice: string | null,
  width: number,
  persistentPrefix: string
): string | null {
  if (archiveIssueNotice === null) return notice;
  if (notice === null) return archiveIssueNotice;
  const copyWidth = Math.max(0, width - INLINE_NOTICE_GLYPH_WIDTH);
  const transientWidth = Math.max(0, copyWidth - displayLen(persistentPrefix));
  return `${persistentPrefix}${truncate(notice, transientWidth)}`;
}

export interface AppOptions {
  root?: string;
  intervalMs: number;
  /** Terminal light/dark mode probed at startup (undefined = detection failed). */
  detectedThemeMode?: 'light' | 'dark';
  /** Mounted-app seam: production always creates the streaming/polling source. */
  snapshotSource?: SnapshotSource;
  /**
   * Mounted-app seam: production always resolves the review worktree off disk
   * (git worktree list + the archive registry). Tests inject a resolver so
   * entering review never depends on the checkout the suite happens to run in.
   */
  resolveReviewTarget?: ResolveReviewTarget;
  /** Mounted-app seam: production always lets ReviewApp load its own branch data. */
  reviewOptions?: Omit<
    Partial<ReviewAppProps>,
    | 'root'
    | 'branch'
    | 'width'
    | 'height'
    | 'shellRequest'
    | 'onShellCommand'
    | 'inputSuspended'
    | 'onExit'
    | 'onHelpOpenChange'
    | 'onModalOpenChange'
    | 'liveGen'
  >;
}

const FILTER_ORDER: readonly StatusFilter[] = ['all', 'attention', 'working', 'ready', 'idle'];

interface KeyLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  preventDefault?: () => void;
}

function matchKey(key: KeyLike, ch: string): boolean {
  return key.name === ch || key.sequence === ch;
}

function matchF10(key: KeyLike): boolean {
  return key.name?.toLowerCase() === 'f10' || key.sequence === '\u001b[21~';
}

/** Retention key for one review target. `root` is undefined only when unlaunched. */
function reviewTargetKey(root: string | undefined, branch: string): string {
  return `${root ?? ''}\u0000${branch}`;
}

export function App({ options }: { options: AppOptions }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const controls = useThemeControls();
  const source = useMemo(
    () =>
      options.snapshotSource ??
      createSnapshotSource({ root: options.root, intervalMs: options.intervalMs }),
    [options.snapshotSource, options.root, options.intervalMs]
  );
  const { snapshot, error, connected } = useSnapshot(source);

  // Local 1s ticker: advances the clock and re-runs liveness classification in
  // memory between data ticks, so relative times and working→quiet→stalled
  // transitions stay smooth even while the sidecar sits on its idle heartbeat.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const classifiedSnapshot = useMemo(
    () => (snapshot ? reclassify(snapshot, nowMs, DEFAULT_THRESHOLDS) : null),
    [snapshot, nowMs]
  );
  const live = connected ? classifiedSnapshot : null;
  const archiveIssueDisclosure = useMemo(() => {
    const issues = classifiedSnapshot?.archiveIssues ?? [];
    if (issues.length === 0) return null;
    const identityIssues = issues.filter((issue) => issue.kind === 'project_identity_unavailable');
    const artifactIssues = issues.filter((issue) => issue.kind === 'artifact_unavailable');
    const indexIssues = issues.filter((issue) => issue.kind === 'project_index_degraded');
    const projectionIssues = issues.filter((issue) => issue.kind === 'hot_projection_incomplete');
    if (
      identityIssues.length > 0 &&
      artifactIssues.length > 0 &&
      indexIssues.length === 0 &&
      projectionIssues.length === 0
    ) {
      return {
        full: 'Project identity problem · Partial archive · doctor + archive repair',
        compact: MIXED_ARCHIVE_NOTICE_PREFIX,
      };
    }
    if (
      [
        identityIssues.length > 0,
        artifactIssues.length > 0,
        indexIssues.length > 0,
        projectionIssues.length > 0,
      ].filter(Boolean).length > 1
    ) {
      return {
        full: 'Multiple data problems · doctor + archive repair',
        compact: 'Data degraded · doctor · ',
      };
    }
    if (identityIssues.length > 0) {
      return {
        full:
          `Project identity problem · ${identityIssues.length} ` +
          `${identityIssues.length === 1 ? 'project needs' : 'projects need'} attention · ` +
          'run doctor or inspect archive projects',
        compact: 'Identity · doctor · ',
      };
    }
    if (indexIssues.length > 0) {
      return {
        full:
          `Archive index degraded · ${indexIssues.length} ` +
          `${indexIssues.length === 1 ? 'project needs' : 'projects need'} a retry · run doctor`,
        compact: 'Index degraded · doctor · ',
      };
    }
    if (projectionIssues.length > 0) {
      return {
        full:
          `Local projection incomplete · ${projectionIssues.length} ` +
          `${projectionIssues.length === 1 ? 'project needs' : 'projects need'} repair · ` +
          'run doctor, then rebuild',
        compact: 'Projection incomplete · doctor · ',
      };
    }
    const projects = [...new Set(artifactIssues.map((issue) => issue.project))].join(', ');
    // Deliberately NOT `archive status`: that command diffs the hot store
    // against the archive, so an artifact the archive holds alone is never
    // examined and it answers "all clean". Repair completes the archived log
    // from the hot copy, which only the worktree owning it has; prune is the
    // only exit once no worktree does. Which case applies is unknowable from
    // here — watch sees just this checkout's hot store — so name both.
    return {
      full:
        `Partial archive data · ${artifactIssues.length} ` +
        `${artifactIssues.length === 1 ? 'artifact' : 'artifacts'} unavailable in ${projects} · ` +
        'archive repair from the owning worktree, else archive prune',
      compact: 'Partial archive · repair/prune · ',
    };
  }, [classifiedSnapshot]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [repo, setRepo] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('project');
  const [activePane, setActivePane] = useState<'rail' | 'detail'>('rail');
  const [notify, setNotify] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  // Highlighted row while the repo dropdown is open (keyboard + mouse hover land here).
  const [repoSel, setRepoSel] = useState(0);
  // Detail nav stack: drilled checkpoint, stable selections for the task and
  // artifact levels, and stable ids for expanded step/decision rows.
  const [detailCp, setDetailCp] = useState<number | null>(null);
  const [artifactSelection, setArtifactSelection] = useState<string | null>(null);
  const [taskMemberSelection, setTaskMemberSelection] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<ReadonlySet<string>>(() => new Set());
  // Which member thread of a selected task is drilled into (null = the task's THREADS list).
  const [detailThread, setDetailThread] = useState<string | null>(null);
  // Top-level mode: the live cockpit, or the capture-grounded review of a branch.
  const [mode, setMode] = useState<'cockpit' | 'review'>('cockpit');
  const [reviewBranch, setReviewBranch] = useState<string | null>(null);
  // The on-disk worktree the current review runs against — resolved per-row at
  // review-entry time (may be a sibling worktree or another project entirely):
  // the review runs against the worktree that owns the branch, not the one watch
  // was launched from.
  const [reviewRoot, setReviewRoot] = useState<string | null>(null);
  const [reviewShellRequest, setReviewShellRequest] = useState<{
    id: 'help' | 'next-pane' | 'back' | 'story-lens' | 'captured-checkpoint-lens';
    nonce: number;
  } | null>(null);
  const [reviewShellLocation, setReviewShellLocation] = useState<{
    screen: StoryReviewScreen;
    atRoot: boolean;
  }>({ screen: 'brief', atRoot: true });
  const [reviewLensContext, setReviewLensContext] = useState<{
    storyAvailable: boolean;
    storyViewable: boolean;
    activeLens: 'deterministic' | 'story';
  }>({ storyAvailable: false, storyViewable: false, activeLens: 'deterministic' });
  const externalLensStateChange = options.reviewOptions?.onLensStateChange;
  const handleReviewLensStateChange = useCallback(
    (state: {
      storyAvailable: boolean;
      storyViewable: boolean;
      activeLens: 'deterministic' | 'story';
    }): void => {
      setReviewLensContext(state);
      externalLensStateChange?.(state);
    },
    [externalLensStateChange]
  );
  const [reviewHelpOpen, setReviewHelpOpen] = useState(false);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [watchHelpOpen, setWatchHelpOpen] = useState(false);
  const [watchHelpSelection, setWatchHelpSelection] = useState(0);
  const watchHelpSelectionRef = useRef(0);
  // Desktop-style menu state. Its row remains mounted in both modes; only the
  // contextual commands change.
  const [shellMenu, setShellMenu] = useState<ShellMenuId | null>(null);
  const [shellMenuIndex, setShellMenuIndex] = useState(0);
  // Shared transient feedback. Watch uses its footer; Review overlays the same
  // final row so theme and unavailable-action feedback stays in the active view.
  const [notice, setNotice] = useState<string | null>(null);
  const footerNotice = composeWatchFooterNotice(
    notice,
    archiveIssueDisclosure?.full ?? null,
    width,
    archiveIssueDisclosure?.compact ?? ''
  );
  // Cockpit theme selector (t): open state + live preview id. Plain setState —
  // functional updaters keep the j/k cycle burst-safe without a cur-store.
  const [themeSel, setThemeSel] = useState<{
    index: number;
    preview: string | null;
    filter: ThemeAppearanceFilter;
  } | null>(null);

  const railRef = useRef<ScrollBoxRenderable | null>(null);
  const detailRef = useRef<ScrollBoxRenderable | null>(null);
  const watchHelpScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const taskOverviewScrollRef = useRef(0);
  const artifactOverviewScrollRef = useRef(0);
  const pendingDetailScrollRestoreRef = useRef<number | null>(null);
  const watchScrollSnapshotRef = useRef({ rail: 0, detail: 0 });
  const restoreWatchScrollRef = useRef(false);
  // Retained review controller state, keyed by the worktree AND the branch.
  // Review spans projects, so a bare branch key would let two checkouts that
  // both have `main` inherit each other's screen and scroll position.
  const reviewControllerByTargetRef = useRef(
    new Map<string, NonNullable<ReviewAppProps['initialControllerState']>>()
  );
  const railSelectionAnchorRef = useRef<RailSelectionAnchor | null>(null);
  // True while a review-target resolution is in flight — re-entrant open-review
  // is ignored so a double-press can't launch two overlapping resolves.
  const reviewResolvingRef = useRef(false);

  const groups = useMemo(
    () => (classifiedSnapshot ? railGroups(classifiedSnapshot, { groupBy, filter, repo }) : []),
    [classifiedSnapshot, groupBy, filter, repo]
  );
  const nav = useMemo(() => navOrder(groups), [groups]);
  const railGeometryKey = groups
    .map((group) => `${group.key}:${group.rows.map((row) => row.id).join(',')}`)
    .join('|');

  // Repo dropdown menu: "all repos" + each distinct project name (deduped/sorted).
  const repoOptions = useMemo(() => {
    const names = classifiedSnapshot
      ? [...new Set(repoNames(classifiedSnapshot))].sort((a, b) => a.localeCompare(b))
      : [];
    return [
      { name: 'all repos', value: null as string | null },
      ...names.map((r) => ({ name: r, value: r as string | null })),
    ];
  }, [classifiedSnapshot]);
  // Index of the repo currently in effect (where the highlight lands when the menu opens).
  const repoActiveIdx = Math.max(
    0,
    repoOptions.findIndex((o) => o.value === repo)
  );

  // Footer and primary body survive first; logo/stats and events yield at short heights.
  // Narrow terminals stack the body: detail on top, thread rail below, no events.
  const shellHeight = allocateShellHeight(height, width);
  const stacked = shellHeight.stacked;
  const bodyHeight = shellHeight.bodyRows;
  const topBarHeight = shellHeight.topBarRows;
  const eventsHeight = shellHeight.eventRows;
  const railHeight = shellHeight.railRows;
  const railViewport = Math.max(1, railHeight - 2);

  // Responsive rail: ~a third of the width side-by-side, clamped so it's neither
  // cramped nor huge; the full width when stacked. TopBar keeps the wide formula
  // either way — its logo band is a width policy, not the rail pane's.
  const railWidth = Math.max(34, Math.min(60, Math.floor(width * 0.34)));
  const railPaneWidth = stacked ? width : railWidth;
  const railInner = railPaneWidth - 4;
  const detailInner = stacked ? Math.max(24, width - 8) : Math.max(24, width - railWidth - 8);
  // Artifact rows reserve one non-color focus marker inside the pane measure.
  const detailContentW = Math.min(111, Math.max(12, detailInner - 3));
  const rows = useMemo(() => navRows(groups), [groups]);
  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId]
  );
  const selectedTask = selectedRow?.kind === 'task' ? selectedRow.task : null;
  // A task shows its THREADS list until you drill into a member (detailThread set).
  const isTaskOverview = selectedTask !== null && detailThread === null;
  const activeThread =
    selectedRow?.kind === 'thread'
      ? selectedRow.thread
      : selectedTask && detailThread !== null
        ? findThread(classifiedSnapshot, detailThread)
        : null;
  const activeProject =
    selectedRow?.kind === 'thread' ? selectedRow.project : (selectedTask?.project ?? null);
  // Branch of the selected row — the entry point for `v` (review this branch).
  const selectedBranch =
    selectedRow?.kind === 'thread' ? selectedRow.thread.branch : (selectedTask?.branch ?? null);
  // The selected row's project id — review entry resolves the owning worktree on
  // disk from this (via the archive registry) so any project's branch is
  // reachable, not just one checked out where watch was launched.
  const selectedProjectId =
    selectedRow?.kind === 'thread' ? selectedRow.projectId : (selectedTask?.projectId ?? null);
  const taskDetail = useMemo<TaskDetailModel>(
    () => (selectedTask ? buildTaskDetail(selectedTask) : { members: [], refs: [] }),
    [selectedTask]
  );
  const artifactDetail = useMemo(
    () =>
      activeThread
        ? buildDetail(activeThread, expandedDetail, detailContentW)
        : { lines: [], refs: [] },
    [activeThread, expandedDetail, detailContentW]
  );
  const detailRefs = isTaskOverview ? taskDetail.refs : artifactDetail.refs;
  const detailLines = isTaskOverview ? [] : artifactDetail.lines;
  const detailSelection = isTaskOverview ? taskMemberSelection : artifactSelection;
  const taskRefKey = taskDetail.refs.map((ref) => ref.id).join('\u0000');
  const artifactRefKey = artifactDetail.refs.map((ref) => ref.id).join('\u0000');
  const artifactGeometryKey = artifactDetail.lines.map((line) => line.id).join('\u0000');
  const checkpointKey = activeThread?.checkpoints.map((checkpoint) => checkpoint.n).join(',') ?? '';
  const taskParent =
    selectedTask !== null && detailThread !== null
      ? {
          memberIndex: Math.max(
            0,
            taskDetail.members.findIndex((member) => member.threadId === detailThread)
          ),
          memberCount: taskDetail.members.length,
        }
      : null;

  // Whether opening review is even meaningful. Review can target any project, so
  // the only synchronous precondition is that a row with a branch is selected —
  // whether that branch has a live worktree on disk costs I/O to learn, so it is
  // answered by the resolve and surfaced as a notice.
  const reviewable = live !== null && selectedBranch !== null;
  const shellContext: ShellContext = {
    mode: mode === 'cockpit' ? 'watch' : 'review',
    reviewable,
    watchAtRoot: activePane === 'rail',
    reviewAtRoot: reviewShellLocation.atRoot,
    storyAvailable: reviewLensContext.storyAvailable,
    storyViewable: reviewLensContext.storyViewable,
    reviewLens: reviewLensContext.activeLens,
  };

  function shellUnavailableReason(id: ShellCommandId): string | null {
    if (id === 'open-review' && !reviewable) {
      return 'Select a branch to open Review';
    }
    return null;
  }

  /**
   * Open the capture-grounded review of the selected row's branch. The row can
   * belong to any project the dashboard shows, so the worktree that owns the
   * branch on disk is resolved first and the review runs against THAT root. A
   * refusal (no live worktree, or the project isn't on disk here) surfaces as a
   * notice. The resolve is async, so a re-entrant open is ignored while one is
   * already in flight, and the Watch scroll snapshot is taken at press time —
   * not after the await, when the rail may have moved.
   */
  function enterSelectedReview(): void {
    if (selectedBranch === null || reviewResolvingRef.current) return;
    const branch = selectedBranch;
    const watchScroll = {
      rail: railRef.current?.scrollTop ?? 0,
      detail: detailRef.current?.scrollTop ?? 0,
    };
    reviewResolvingRef.current = true;
    setNotice(`resolving review for ${branch}…`);
    void (options.resolveReviewTarget ?? resolveReviewTarget)({
      projectId: selectedProjectId,
      branch,
      launchRoot: options.root,
      projectLabel: activeProject ?? undefined,
    })
      .then((target) => {
        if (!target.ok) {
          setNotice(target.reason);
          return;
        }
        setNotice(null);
        watchScrollSnapshotRef.current = watchScroll;
        setReviewRoot(target.root);
        setReviewBranch(branch);
        const retainedController =
          reviewControllerByTargetRef.current.get(reviewTargetKey(target.root, branch)) ??
          options.reviewOptions?.initialControllerState;
        setReviewShellLocation(
          retainedController === undefined
            ? { screen: 'brief', atRoot: true }
            : {
                screen: retainedController.screen,
                atRoot: reviewIsAtRoot(retainedController),
              }
        );
        setReviewShellRequest(null);
        setReviewLensContext({
          storyAvailable: false,
          storyViewable: false,
          activeLens: 'deterministic',
        });
        setReviewHelpOpen(false);
        setMode('review');
      })
      .catch((err: unknown) => {
        setNotice(`review unavailable: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        reviewResolvingRef.current = false;
      });
  }

  function exitReview(): void {
    setShellMenu(null);
    setReviewShellRequest(null);
    setReviewHelpOpen(false);
    setReviewModalOpen(false);
    restoreWatchScrollRef.current = true;
    setMode('cockpit');
  }

  // Every theme-selector index — hover, move, commit — is an index into the
  // SAME filtered array. Filtering only at the JSX layer while committing
  // against the full list is how the wrong theme gets applied.
  function visibleThemeRows(appearanceFilter: ThemeAppearanceFilter): readonly ThemeRow[] {
    return themeRowsForFilter(controls.themeRows, appearanceFilter);
  }

  function openThemeSelector(): void {
    const at = controls.themeRows.findIndex((row) => row.id === controls.themeId);
    setShellMenu(null);
    setRepoOpen(false);
    setWatchHelpOpen(false);
    setThemeSel({ index: at >= 0 ? at : 0, preview: null, filter: 'all' });
  }

  function previewTheme(index: number): void {
    const current = stateRef.current.themeSel;
    if (current === null) return;
    const rows = visibleThemeRows(current.filter);
    if (rows.length === 0) return;
    const normalized = ((index % rows.length) + rows.length) % rows.length;
    setThemeSel({ ...current, index: normalized, preview: rows[normalized]!.id });
  }

  function moveThemePreview(delta: number): void {
    const current = stateRef.current.themeSel;
    if (current === null) return;
    previewTheme(current.index + delta);
  }

  function cycleThemeFilter(): void {
    const current = stateRef.current.themeSel;
    if (current === null) return;
    const nextFilter = nextAppearanceFilter(current.filter);
    const previousRows = visibleThemeRows(current.filter);
    const carriedThemeId = current.preview ?? previousRows[current.index]?.id ?? controls.themeId;
    const reselected = reselectAfterFilter(visibleThemeRows(nextFilter), carriedThemeId);
    if (reselected === null) return;
    setThemeSel({ index: reselected.index, preview: reselected.id, filter: nextFilter });
  }

  function commitThemeSelection(index: number): void {
    const current = stateRef.current.themeSel;
    const row = visibleThemeRows(current?.filter ?? 'all')[index];
    if (row === undefined) return;
    setThemeSel(null);
    void controls
      .commitTheme(row.id)
      .then(() => setNotice(`✓ theme ${row.label} (saved to your user config)`))
      .catch(() => setNotice(`Theme ${row.label} is active for this session; config write failed`));
  }

  function requestReviewShellCommand(
    id: 'help' | 'next-pane' | 'back' | 'story-lens' | 'captured-checkpoint-lens'
  ): void {
    setReviewShellRequest((current) => ({ id, nonce: (current?.nonce ?? 0) + 1 }));
  }

  function executeShellCommand(
    id: ShellCommandId,
    source: 'shell' | 'review-help' = 'shell'
  ): void {
    const layer = stateRef.current;
    if (
      layer.themeSel !== null ||
      layer.watchHelpOpen ||
      (layer.reviewHelpOpen && source !== 'review-help') ||
      layer.reviewModalOpen
    )
      return;
    const command = resolveShellCommand(id, shellContext);
    if (!command.visible) return;
    setShellMenu(null);
    setNotice(null);
    switch (id) {
      case 'open-review':
        enterSelectedReview();
        return;
      case 'back-to-watch':
        exitReview();
        return;
      case 'review-back':
        requestReviewShellCommand('back');
        return;
      case 'story-lens':
      case 'captured-checkpoint-lens':
        requestReviewShellCommand(id);
        return;
      case 'theme':
        openThemeSelector();
        return;
      case 'help':
        setShellMenu(null);
        if (mode === 'review') requestReviewShellCommand('help');
        else {
          watchHelpSelectionRef.current = 0;
          setWatchHelpSelection(0);
          setWatchHelpOpen(true);
        }
        return;
      case 'next-pane':
        if (mode === 'review') requestReviewShellCommand('next-pane');
        else setActivePane((pane) => (pane === 'rail' ? 'detail' : 'rail'));
        return;
      case 'open-menu': {
        const first = selectShellMenuSections(shellContext)[0];
        if (first !== undefined) openShellMenu(first.id, source === 'review-help');
        return;
      }
      case 'quit':
        shutdown(renderer);
        return;
    }
  }

  const watchCommandContext: WatchCommandContext = {
    connected: live !== null,
    pane: activePane,
    detailMode: detailCp === null ? 'overview' : 'checkpoint',
  };
  const shellGroups: readonly ShellMenuGroupModel[] = selectShellMenuSections(shellContext).map(
    (section) => {
      const shellItems = section.commands.map((command) => ({
        id: command.id,
        label: command.label,
        hint: command.keyLabel ?? undefined,
        enabled: command.enabled,
        disabledReason: command.enabled
          ? undefined
          : (shellUnavailableReason(command.id) ?? undefined),
        action: () => executeShellCommand(command.id),
      }));
      const watchItems =
        mode === 'cockpit' && section.id === 'view'
          ? selectWatchCommands(watchCommandContext, 'menu').map((command) => ({
              id: command.id,
              label: command.label,
              hint: command.gestures[0],
              enabled: command.enabled,
              action: () => executeWatchCommand(command.id),
            }))
          : [];
      return {
        id: section.id,
        label: section.label,
        items: [...shellItems, ...watchItems],
      };
    }
  );
  const activeShellGroup = shellGroups.find((group) => group.id === shellMenu) ?? null;
  const actionPresentation = (id: ShellCommandId) => resolveShellCommand(id, shellContext);
  const compactActionLabel = (id: ShellCommandId): string => {
    const command = actionPresentation(id);
    return command.keyLabel === null
      ? command.shortLabel
      : `${command.shortLabel}  ${command.keyLabel}`;
  };
  const shellActions: readonly ShellAction[] =
    mode === 'review'
      ? [
          {
            id: reviewShellLocation.atRoot ? 'back-to-watch' : 'review-back',
            label: compactActionLabel(reviewShellLocation.atRoot ? 'back-to-watch' : 'review-back'),
            enabled: actionPresentation(
              reviewShellLocation.atRoot ? 'back-to-watch' : 'review-back'
            ).enabled,
            onSelect: () =>
              executeShellCommand(reviewShellLocation.atRoot ? 'back-to-watch' : 'review-back'),
          },
        ]
      : [
          {
            id: 'open-review',
            label: compactActionLabel('open-review'),
            enabled: actionPresentation('open-review').enabled,
            onSelect: () => executeShellCommand('open-review'),
          },
        ];
  const watchHelpContext =
    live === null
      ? 'Watch is connecting · application controls remain available'
      : activePane === 'rail'
        ? 'Thread list · choose work to inspect'
        : detailCp !== null
          ? 'Checkpoint detail · inspect captured scope and evidence'
          : selectedTask !== null
            ? 'Task detail · choose a captured thread'
            : 'Thread detail · inspect progress and captured decisions';
  const watchContextRows: HelpSection['rows'] =
    live === null
      ? selectShellHelpCommands(shellContext)
          .filter((command) => command.id === 'theme' || command.id === 'help')
          .map((command) => {
            const invocation = executableHelpInvocation(command);
            return {
              commandId: command.id,
              commandGesture: invocation?.gesture,
              executable: invocation !== null && command.id !== 'help',
              keys: [...command.gestures],
              label:
                command.id === 'help'
                  ? 'Keep this guide open while Watch connects'
                  : command.helpLabel,
            };
          })
      : selectWatchCommands(watchCommandContext, 'help').map((command) => {
          const invocation = executableHelpInvocation(command);
          return {
            commandId: command.id,
            commandGesture: invocation?.gesture,
            executable: invocation !== null,
            keys: [...command.gestures],
            label: command.helpLabel,
          };
        });
  const watchHelpSections: HelpSection[] = [
    {
      title: 'Here',
      rows: watchContextRows,
    },
    {
      title: 'Application',
      rows: [
        ...selectShellHelpCommands(shellContext).map((command) => {
          const invocation = executableHelpInvocation(command);
          return {
            commandId: command.id,
            commandGesture: invocation?.gesture,
            executable: invocation !== null && command.id !== 'help',
            keys: command.gestures.length === 0 ? ['menu'] : [...command.gestures],
            label:
              command.enabled || shellUnavailableReason(command.id) === null
                ? command.label
                : `${command.label} — ${shellUnavailableReason(command.id)}`,
          };
        }),
      ],
    },
    {
      title: 'Mouse',
      rows: [
        { keys: ['Click'], label: 'Select visible rows and actions' },
        { keys: ['Wheel'], label: 'Scroll the pane under the pointer' },
      ],
    },
  ];
  const watchHelpCommands = executableHelpEntries(watchHelpSections);

  function moveWatchHelpSelection(delta: number): void {
    if (watchHelpCommands.length === 0) return;
    const current = Math.min(watchHelpSelectionRef.current, watchHelpCommands.length - 1);
    const next = Math.min(watchHelpCommands.length - 1, Math.max(0, current + delta));
    watchHelpSelectionRef.current = next;
    setWatchHelpSelection(next);
    if (next !== current && watchHelpScrollRef.current !== null) {
      watchHelpScrollRef.current.scrollTop = Math.max(0, watchHelpCommands[next]!.line - 1);
    }
  }

  function executeWatchHelpEntry(entry: ExecutableHelpEntry): void {
    flushSync(() => setWatchHelpOpen(false));
    if (entry.commandId.startsWith('watch.')) {
      executeWatchCommand(entry.commandId as WatchCommandId, entry.gesture);
    } else {
      executeShellCommand(entry.commandId as ShellCommandId);
    }
  }

  function executeSelectedWatchHelpCommand(): void {
    const entry = watchHelpCommands[watchHelpSelectionRef.current];
    if (entry !== undefined) executeWatchHelpEntry(entry);
  }

  // Latest render state, read by the (closure-captured) keyboard handler.
  const stateRef = useRef({
    connected: live !== null,
    groups,
    nav,
    selectedId,
    activePane,
    controls,
    themeSel,
    shellMenu,
    shellMenuIndex,
    shellGroups,
    watchHelpOpen,
    reviewHelpOpen,
    reviewModalOpen,
    repoOpen,
    repoSel,
    repoOptions,
    repoActiveIdx,
    railViewport,
    detailCp,
    detailThread,
    mode,
    selectedBranch,
    selectedProjectId,
    selectedProjectLabel: activeProject,
    isTaskSelected: selectedTask !== null,
    isTaskOverview,
    detailSelection,
    detailRefs,
    detailLines,
    taskDetail,
  });
  stateRef.current = {
    connected: live !== null,
    groups,
    nav,
    selectedId,
    activePane,
    controls,
    themeSel,
    shellMenu,
    shellMenuIndex,
    shellGroups,
    watchHelpOpen,
    reviewHelpOpen,
    reviewModalOpen,
    repoOpen,
    repoSel,
    repoOptions,
    repoActiveIdx,
    railViewport,
    detailCp,
    detailThread,
    mode,
    selectedBranch,
    selectedProjectId,
    selectedProjectLabel: activeProject,
    isTaskSelected: selectedTask !== null,
    isTaskOverview,
    detailSelection,
    detailRefs,
    detailLines,
    taskDetail,
  };

  function selectAndFollow(id: string) {
    const s = stateRef.current;
    setActivePane('rail');
    setSelectedId(id);
    const offset = railLineOffset(s.groups, id);
    const maxTop = Math.max(0, railLineCount(s.groups) - s.railViewport);
    scrollTo(railRef, Math.min(maxTop, Math.max(0, offset - Math.floor(s.railViewport / 2))));
  }

  function moveSelection(delta: number) {
    const s = stateRef.current;
    if (s.nav.length === 0) return;
    const idx = Math.max(0, s.nav.indexOf(s.selectedId ?? ''));
    const next = Math.min(s.nav.length - 1, Math.max(0, idx + delta));
    const id = s.nav[next];
    if (id !== undefined) selectAndFollow(id);
  }

  function revealDetailLine(line: number, rowHeight: number): void {
    const box = detailRef.current;
    if (box === null) return;
    const top = box.scrollTop ?? 0;
    const viewport = Math.max(1, box.viewport?.height ?? 1);
    if (line < top) scrollTo(detailRef, line);
    else if (line + rowHeight > top + viewport) {
      scrollTo(detailRef, Math.max(0, line + rowHeight - viewport));
    }
  }

  function revealRailLine(line: number, rowHeight: number): void {
    const box = railRef.current;
    if (box === null) return;
    const top = box.scrollTop ?? 0;
    const viewport = Math.max(1, box.viewport?.height ?? 1);
    if (line < top) scrollTo(railRef, line);
    else if (line + rowHeight > top + viewport) {
      scrollTo(railRef, Math.max(0, line + rowHeight - viewport));
    }
  }

  function setCurrentDetailSelection(ref: string): void {
    if (stateRef.current.isTaskOverview) setTaskMemberSelection(ref);
    else setArtifactSelection(ref);
  }

  function moveDetailSelection(delta: number) {
    const s = stateRef.current;
    if (s.detailRefs.length === 0) return;
    const current = Math.max(
      0,
      s.detailRefs.findIndex((ref) => ref.id === s.detailSelection)
    );
    const next = Math.min(s.detailRefs.length - 1, Math.max(0, current + delta));
    const nextRef = s.detailRefs[next];
    if (nextRef === undefined) return;
    setCurrentDetailSelection(nextRef.id);
    const line = s.isTaskOverview
      ? taskMemberRefLine(s.taskDetail, nextRef.id)
      : detailRefLine(s.detailLines, nextRef.id);
    revealDetailLine(line, s.isTaskOverview ? 3 : 1);
  }

  function toggleExpand(refId: string) {
    setExpandedDetail((prev) => {
      const next = new Set(prev);
      if (next.has(refId)) next.delete(refId);
      else next.add(refId);
      return next;
    });
  }

  // Act on an overview row: a checkpoint pushes the drill-in; a step/decision
  // toggles its inline expansion.
  function activateDetail(refId: string) {
    const ref = stateRef.current.detailRefs.find((candidate) => candidate.id === refId);
    if (ref === undefined) return;
    if (ref.kind === 'thread' && ref.threadId !== undefined) {
      // Drill from a task's THREADS list into that member thread.
      taskOverviewScrollRef.current = detailRef.current?.scrollTop ?? 0;
      pendingDetailScrollRestoreRef.current = 0;
      setDetailThread(ref.threadId);
    } else if (ref.kind === 'checkpoint' && ref.n !== undefined) {
      artifactOverviewScrollRef.current = detailRef.current?.scrollTop ?? 0;
      pendingDetailScrollRestoreRef.current = 0;
      setDetailCp(ref.n);
    } else {
      toggleExpand(refId);
    }
  }

  function pickDetailRow(refId: string) {
    setActivePane('detail');
    setCurrentDetailSelection(refId);
    activateDetail(refId);
  }

  function backDetail(): void {
    const s = stateRef.current;
    if (s.detailCp !== null) {
      pendingDetailScrollRestoreRef.current = artifactOverviewScrollRef.current;
      setDetailCp(null);
    } else if (s.isTaskSelected && s.detailThread !== null) {
      pendingDetailScrollRestoreRef.current = taskOverviewScrollRef.current;
      setDetailThread(null);
    } else {
      setActivePane('rail');
    }
  }

  /** One contextual Watch executor shared by keys, Help, menus, and pointer affordances. */
  function executeWatchCommand(id: WatchCommandId, gesture?: string): void {
    const s = stateRef.current;
    const context: WatchCommandContext = {
      connected: s.connected,
      pane: s.activePane,
      detailMode: s.detailCp === null ? 'overview' : 'checkpoint',
    };
    const command = resolveWatchCommand(id, context);
    if (!command.visible || !command.enabled) return;
    if (gesture !== undefined && !command.gestures.includes(gesture)) return;
    const activeGesture = gesture ?? command.gestures[0] ?? '';
    const direction = activeGesture === 'j' || activeGesture === '↓' ? 1 : -1;
    switch (id) {
      case 'watch.move':
        if (s.activePane === 'rail') moveSelection(direction);
        else if (s.detailCp !== null) scrollBy(detailRef, direction);
        else if (s.detailRefs.length > 0) moveDetailSelection(direction);
        else scrollBy(detailRef, direction);
        return;
      case 'watch.open-detail':
        if (s.activePane === 'rail') setActivePane('detail');
        else if (s.detailCp === null && s.detailSelection !== null)
          activateDetail(s.detailSelection);
        return;
      case 'watch.back-detail':
        backDetail();
        return;
      case 'watch.cycle-filter':
        setFilter(
          (current) =>
            FILTER_ORDER[(FILTER_ORDER.indexOf(current) + 1) % FILTER_ORDER.length] ?? 'all'
        );
        return;
      case 'watch.cycle-grouping':
        setGroupBy(
          (current) =>
            GROUPBY_ORDER[(GROUPBY_ORDER.indexOf(current) + 1) % GROUPBY_ORDER.length] ?? 'project'
        );
        return;
      case 'watch.choose-repository':
        setRepoOpen(true);
        return;
      case 'watch.toggle-notifications':
        setNotify((on) => !on);
        return;
      case 'watch.half-page-up':
        scrollByViewport(s.activePane === 'rail' ? railRef : detailRef, -1, true);
        return;
      case 'watch.half-page-down':
        scrollByViewport(s.activePane === 'rail' ? railRef : detailRef, 1, true);
        return;
      case 'watch.page-up':
        scrollByViewport(s.activePane === 'rail' ? railRef : detailRef, -1);
        return;
      case 'watch.page-down':
        scrollByViewport(s.activePane === 'rail' ? railRef : detailRef, 1);
        return;
      case 'watch.scroll-top':
        scrollTo(s.activePane === 'rail' ? railRef : detailRef, 0);
        return;
      case 'watch.scroll-bottom':
        scrollTo(s.activePane === 'rail' ? railRef : detailRef, 1_000_000);
        return;
    }
  }

  // Apply the repo option at `index` (from a click or ↵) and close the dropdown.
  function commitRepo(index: number) {
    const opt = stateRef.current.repoOptions[index];
    setRepo(opt?.value ?? null);
    setRepoOpen(false);
  }

  function openShellMenu(id: ShellMenuId, allowReviewHelpOpen = false): void {
    const s = stateRef.current;
    if (
      s.themeSel !== null ||
      s.watchHelpOpen ||
      (s.reviewHelpOpen && !allowReviewHelpOpen) ||
      s.reviewModalOpen
    )
      return;
    const group = s.shellGroups.find((candidate) => candidate.id === id);
    if (group === undefined) return;
    setRepoOpen(false);
    setShellMenu(id);
    setShellMenuIndex(nextShellMenuItem(group.items, -1, 1));
  }

  function toggleShellMenu(id: ShellMenuId): void {
    if (stateRef.current.shellMenu === id) setShellMenu(null);
    else openShellMenu(id);
  }

  function switchShellMenu(delta: number): void {
    const groups = stateRef.current.shellGroups;
    if (groups.length === 0) return;
    const current = Math.max(
      0,
      groups.findIndex((group) => group.id === stateRef.current.shellMenu)
    );
    openShellMenu(groups[(current + delta + groups.length) % groups.length]!.id);
  }

  function moveShellMenuItem(delta: number): void {
    const s = stateRef.current;
    const group = s.shellGroups.find((candidate) => candidate.id === s.shellMenu);
    if (group === undefined) return;
    setShellMenuIndex(nextShellMenuItem(group.items, s.shellMenuIndex, delta));
  }

  function activateShellMenuItem(index = stateRef.current.shellMenuIndex): void {
    const s = stateRef.current;
    const item = s.shellGroups.find((group) => group.id === s.shellMenu)?.items[index];
    if (item === undefined) return;
    setShellMenu(null);
    if (item.enabled === false) {
      setNotice(item.disabledReason ?? `${item.label} is unavailable`);
      return;
    }
    item.action();
  }

  // Remember semantic location before a grouping/filter refresh replaces row ids.
  useEffect(() => {
    const anchor = railSelectionAnchor(rows, selectedId, railSelectionAnchorRef.current);
    if (anchor !== null) railSelectionAnchorRef.current = anchor;
  }, [rows, selectedId]);

  // Keep a valid selection while preserving exact artifact/branch orientation.
  useEffect(() => {
    if (nav.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !nav.includes(selectedId)) {
      setSelectedId(resolveRailSelection(groups, railSelectionAnchorRef.current));
    }
  }, [groups, nav, selectedId]);

  // Reset the detail nav stack whenever the selected row changes.
  useEffect(() => {
    setDetailCp(null);
    setArtifactSelection(null);
    setTaskMemberSelection(null);
    setExpandedDetail(new Set());
    setDetailThread(null);
    scrollTo(detailRef, 0);
  }, [selectedId]);

  // A different artifact starts with a clean inner overview. Task-member
  // selection remains separate, so Back retains the member that was opened.
  useEffect(() => {
    setDetailCp(null);
    setArtifactSelection(null);
    setExpandedDetail(new Set());
  }, [activeThread?.artifactId]);

  // Land the highlight on the active repo each time the dropdown opens.
  useEffect(() => {
    if (repoOpen) setRepoSel(stateRef.current.repoActiveIdx);
  }, [repoOpen]);

  // Stable presentation ids keep selection attached across polling/reordering.
  useEffect(() => {
    const ids = taskDetail.refs.map((ref) => ref.id);
    setTaskMemberSelection((current) =>
      current !== null && ids.includes(current) ? current : (ids[0] ?? null)
    );
  }, [taskRefKey]);

  useEffect(() => {
    const ids = artifactDetail.refs.map((ref) => ref.id);
    setArtifactSelection((current) =>
      current !== null && ids.includes(current) ? current : (ids[0] ?? null)
    );
  }, [artifactRefKey, activeThread?.artifactId]);

  // Live ordering can move a stable selection without a keypress. Reveal only
  // when it exits the viewport; never recenter a row that is already visible.
  useEffect(() => {
    if (selectedId === null || !nav.includes(selectedId)) return;
    const reveal = () => revealRailLine(railLineOffset(groups, selectedId), 2);
    reveal();
    const timer = setTimeout(reveal, 0);
    return () => clearTimeout(timer);
  }, [railGeometryKey, selectedId]);

  useEffect(() => {
    if (!isTaskOverview || taskMemberSelection === null) return;
    const reveal = () => revealDetailLine(taskMemberRefLine(taskDetail, taskMemberSelection), 3);
    reveal();
    const timer = setTimeout(reveal, 0);
    return () => clearTimeout(timer);
  }, [isTaskOverview, taskMemberSelection, taskRefKey]);

  useEffect(() => {
    if (isTaskOverview || artifactSelection === null || detailCp !== null) return;
    const reveal = () =>
      revealDetailLine(detailRefLine(artifactDetail.lines, artifactSelection), 1);
    reveal();
    const timer = setTimeout(reveal, 0);
    return () => clearTimeout(timer);
  }, [artifactGeometryKey, artifactSelection, detailCp, isTaskOverview]);

  // A live plan revision may remove the checkpoint currently drilled into.
  // Pop back to the still-valid artifact overview instead of trapping input in
  // checkpoint-scroll mode over an overview frame.
  useEffect(() => {
    if (
      detailCp !== null &&
      activeThread !== null &&
      !activeThread.checkpoints.some((checkpoint) => checkpoint.n === detailCp)
    ) {
      pendingDetailScrollRestoreRef.current = artifactOverviewScrollRef.current;
      setDetailCp(null);
    }
  }, [activeThread, checkpointKey, detailCp]);

  // If a refresh/filter removes the drilled member, return to the owning task
  // instead of showing a stale empty artifact pane.
  useEffect(() => {
    if (
      detailThread !== null &&
      selectedTask !== null &&
      !taskDetail.members.some((member) => member.threadId === detailThread)
    ) {
      pendingDetailScrollRestoreRef.current = taskOverviewScrollRef.current;
      setDetailThread(null);
    }
  }, [detailThread, selectedTask, taskRefKey]);

  // The task overview, artifact overview, and checkpoint card share one native
  // scrollbox. Restore the saved level only after the destination has mounted.
  useEffect(() => {
    const target = pendingDetailScrollRestoreRef.current;
    if (target === null) return;
    const restore = () => scrollTo(detailRef, target);
    restore();
    const timer = setTimeout(() => {
      restore();
      pendingDetailScrollRestoreRef.current = null;
    }, 0);
    return () => clearTimeout(timer);
  }, [detailThread, detailCp]);

  // Watch is deliberately unmounted while Review owns the terminal. Restore
  // both native scrollboxes in the first layout pass after returning so the
  // selected rail row and detail context do not jump back to the top.
  useEffect(() => {
    if (mode !== 'cockpit' || !restoreWatchScrollRef.current) return;
    const saved = watchScrollSnapshotRef.current;
    const restore = () => {
      scrollTo(railRef, saved.rail);
      scrollTo(detailRef, saved.detail);
    };
    // Refs exist in this effect, but OpenTUI may publish scrollHeight one layout
    // turn later. Restore once now and once after that publication.
    restore();
    const timer = setTimeout(() => {
      restore();
      restoreWatchScrollRef.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [mode]);

  useKeyboard((key: KeyLike) => {
    const s = stateRef.current;
    // Ctrl-C is the one process-level escape hatch. Every other input follows the
    // documented layer order: text input → help → theme → menu → popover → screen.
    if (matchKey(key, 'c') && key.ctrl === true) {
      shutdown(renderer);
      return;
    }
    // Review owns its text and Help layers. The root must not open a menu behind
    // either one, but ReviewApp still needs to receive the key that closes them.
    if (s.mode === 'review' && (s.reviewModalOpen || s.reviewHelpOpen)) return;
    if (s.watchHelpOpen) {
      const sequence = key.sequence ?? key.name ?? '';
      if (key.name === 'escape' || sequence === '\u001b' || sequence === '?' || sequence === 'q') {
        key.preventDefault?.();
        setWatchHelpOpen(false);
      } else if (sequence === 'j' || key.name === 'down') {
        key.preventDefault?.();
        moveWatchHelpSelection(1);
      } else if (sequence === 'k' || key.name === 'up') {
        key.preventDefault?.();
        moveWatchHelpSelection(-1);
      } else if (key.name === 'return' || key.name === 'enter') {
        key.preventDefault?.();
        executeSelectedWatchHelpCommand();
      }
      return;
    }
    // The theme selector owns every key while open (↑/↓/⇥ preview, ↵ commits,
    // Escape/q cancel). This is shared chrome, so it works identically in Review.
    if (stateRef.current.themeSel !== null) {
      const sel = stateRef.current.themeSel;
      if (key.name === 'escape' || matchKey(key, 'q')) setThemeSel(null);
      else if (key.name === 'return' || key.name === 'enter') commitThemeSelection(sel.index);
      else if (key.name === 'up' || matchKey(key, 'k')) moveThemePreview(-1);
      else if (key.name === 'down' || matchKey(key, 'j') || key.name === 'tab') moveThemePreview(1);
      else if (matchKey(key, 'd')) cycleThemeFilter();
      return;
    }
    if (s.shellMenu !== null) {
      key.preventDefault?.();
      if (key.name === 'escape' || matchKey(key, 'q')) setShellMenu(null);
      else if (key.name === 'left') switchShellMenu(-1);
      else if (key.name === 'right' || key.name === 'tab') switchShellMenu(1);
      else if (key.name === 'up' || matchKey(key, 'k')) moveShellMenuItem(-1);
      else if (key.name === 'down' || matchKey(key, 'j')) moveShellMenuItem(1);
      else if (key.name === 'return' || key.name === 'enter') activateShellMenuItem();
      return;
    }
    if (matchF10(key)) {
      key.preventDefault?.();
      executeShellCommand('open-menu');
      return;
    }
    // ReviewApp owns every screen-local key. `t` remains a shell command and is
    // handled here because both surfaces use the same selector and persistence.
    if (s.mode === 'review') {
      setNotice(null);
      const command = resolveShellCommandForKey(shellContext, key);
      if (command?.id === 'theme') executeShellCommand(command.id);
      return;
    }
    // Any key other than another `v` dismisses a lingering review-entry notice.
    if (!matchKey(key, 'v')) setNotice(null);
    // While the repo dropdown is open, arrows/j/k move the highlight (wrapping),
    // ↵ commits it, esc/←/q/r closes. No screen-level shortcut leaks through.
    if (s.repoOpen) {
      const count = s.repoOptions.length;
      if (key.name === 'escape' || key.name === 'left' || matchKey(key, 'q')) setRepoOpen(false);
      else if (matchKey(key, 'r')) setRepoOpen(false);
      else if (key.name === 'up' || matchKey(key, 'k')) setRepoSel((i) => (i - 1 + count) % count);
      else if (key.name === 'down' || matchKey(key, 'j')) setRepoSel((i) => (i + 1) % count);
      else if (key.name === 'return' || key.name === 'enter') commitRepo(s.repoSel);
      return;
    }
    const shellCommand = resolveShellCommandForKey(shellContext, key);
    if (shellCommand !== null) {
      executeShellCommand(shellCommand.id);
      return;
    }
    const watchCommand = resolveWatchCommandForKey(
      {
        connected: s.connected,
        pane: s.activePane,
        detailMode: s.detailCp === null ? 'overview' : 'checkpoint',
      },
      key
    );
    if (watchCommand !== null) {
      executeWatchCommand(watchCommand.id, normalizeCommandGesture(key));
      return;
    }
  });

  // Live theme preview: while the `t` selector is open, the cockpit + its root
  // background flip to the concrete preview theme; otherwise the committed
  // selection holds. The provider-owned resolver keeps chrome and diff preview
  // on one adapter path instead of reducing the selection to light/dark.
  const themePreviewId = themeSel?.preview ?? controls.themeId;
  const previewSelection = controls.themeSelectionFor(themePreviewId);
  const cockpitPreview = previewSelection.cockpitTheme;
  const { BRIGHT, DIM, FRAME, FOCUS_BG, LIVE, PANEL_BG } = cockpitPreview;
  const selectorTheme = previewSelection.diffBaseTheme;
  const shellInteractionBlocked =
    themeSel !== null || watchHelpOpen || reviewHelpOpen || reviewModalOpen;
  const shellTitle =
    mode === 'review'
      ? `Review · ${reviewBranch ?? 'current branch'} · ${storyReviewRouteLabel(
          reviewShellLocation.screen
        )}`
      : live === null || selectedBranch === null
        ? 'Watch'
        : `${activeProject ?? 'Watch'} · ${selectedBranch}`;
  const shellBar = (
    <ShellMenuBar
      width={width}
      title={shellTitle}
      groups={shellGroups}
      activeMenu={shellMenu}
      actions={shellActions}
      interactionEnabled={!shellInteractionBlocked}
      onToggleMenu={toggleShellMenu}
      onHoverMenu={(id) => {
        if (stateRef.current.shellMenu !== null && stateRef.current.shellMenu !== id) {
          openShellMenu(id);
        }
      }}
    />
  );
  const watchHelpOverlay = watchHelpOpen ? (
    <HelpDialog
      title="Watch controls"
      context={watchHelpContext}
      sections={watchHelpSections}
      width={width}
      height={height}
      scrollRef={watchHelpScrollRef}
      selectedEntryId={
        watchHelpCommands[Math.min(watchHelpSelection, watchHelpCommands.length - 1)]?.entryId ??
        null
      }
      onExecute={(entryId) => {
        const entry = watchHelpCommands.find((candidate) => candidate.entryId === entryId);
        if (entry !== undefined) executeWatchHelpEntry(entry);
      }}
      onClose={() => setWatchHelpOpen(false)}
    />
  ) : null;
  const reviewNoticeOverlay =
    mode === 'review' && notice !== null ? (
      <box
        position="absolute"
        left={0}
        top={Math.max(1, height - 1)}
        width={width}
        height={1}
        zIndex={80}
      >
        <Notice id="review-shell-notice" variant="inline" rows={1} message={notice} width={width} />
      </box>
    ) : null;
  const shellMenuOverlay =
    activeShellGroup === null ? null : (
      <>
        <box
          id="shell-menu-backdrop"
          position="absolute"
          top={1}
          left={0}
          width={width}
          height={Math.max(0, height - 1)}
          zIndex={90}
          onMouseDown={() => setShellMenu(null)}
        />
        <ShellMenuDropdown
          group={activeShellGroup}
          groups={shellGroups}
          selectedIndex={shellMenuIndex}
          terminalWidth={width}
          onHoverItem={setShellMenuIndex}
          onSelectItem={activateShellMenuItem}
        />
      </>
    );
  const themeSelectorOverlay =
    themeSel === null ? null : (
      <box position="absolute" top={0} left={0} width={width} height={height} zIndex={120}>
        <ThemeSelectorDialog
          items={themeRowsForFilter(controls.themeRows, themeSel.filter).map((row) => ({
            ...row,
            active: row.id === controls.themeId,
          }))}
          selectedIndex={themeSel.index}
          filter={themeSel.filter}
          activeLabel={controls.themeRows.find((row) => row.id === controls.themeId)?.label ?? null}
          width={width}
          height={height}
          theme={selectorTheme}
          onClose={() => setThemeSel(null)}
          onPreview={previewTheme}
          onSelect={commitThemeSelection}
          onMove={moveThemePreview}
        />
      </box>
    );

  // One detail pane, mounted on either side of the stack/row switch: full-height
  // beside the rail when wide, its allocated share above the rail when stacked.
  const watchDetailPane = (
    <box
      border
      borderColor={FRAME}
      flexDirection="column"
      flexGrow={1}
      height={stacked ? shellHeight.detailRows : bodyHeight}
    >
      {isTaskOverview && selectedTask ? (
        <TaskDetailPane
          task={selectedTask}
          model={taskDetail}
          width={detailInner}
          nowMs={nowMs}
          focused={activePane === 'detail' && !repoOpen}
          scrollRef={detailRef}
          selectedRef={taskMemberSelection}
          reviewable={reviewable}
          onMemberActivate={pickDetailRow}
          onReview={enterSelectedReview}
        />
      ) : (
        <DetailPane
          thread={activeThread}
          project={activeProject}
          width={detailInner}
          nowMs={nowMs}
          focused={activePane === 'detail' && !repoOpen}
          scrollRef={detailRef}
          detailCp={detailCp}
          selectedRef={artifactSelection}
          lines={artifactDetail.lines}
          taskParent={taskParent}
          reviewable={reviewable}
          onRowActivate={pickDetailRow}
          onBack={backDetail}
          onReview={enterSelectedReview}
        />
      )}
    </box>
  );

  if (mode === 'review' && reviewBranch !== null) {
    const activeReviewRoot = reviewRoot ?? options.root;
    const retainedKey = reviewTargetKey(activeReviewRoot, reviewBranch);
    const retainedController =
      reviewControllerByTargetRef.current.get(retainedKey) ??
      options.reviewOptions?.initialControllerState;
    return (
      <CockpitThemeContext.Provider value={cockpitPreview}>
        <box
          key="review-shell-root"
          width={width}
          height={height}
          flexDirection="column"
          backgroundColor={
            themeSel?.preview != null
              ? previewSelection.diffTheme.background
              : controls.diffTheme.background
          }
        >
          {shellBar}
          <ReviewApp
            {...options.reviewOptions}
            initialControllerState={retainedController}
            // The per-row resolved worktree (the checkout that owns the branch),
            // falling back to the launch root only if a review somehow entered
            // without one.
            root={activeReviewRoot}
            branch={reviewBranch}
            width={width}
            height={Math.max(1, height - 1)}
            themeOverride={previewSelection.diffTheme}
            shellRequest={reviewShellRequest}
            onShellCommand={(id) => executeShellCommand(id, 'review-help')}
            inputSuspended={shellMenu !== null || themeSel !== null}
            onHelpOpenChange={setReviewHelpOpen}
            onModalOpenChange={setReviewModalOpen}
            onLensStateChange={handleReviewLensStateChange}
            onControllerStateChange={(state) => {
              reviewControllerByTargetRef.current.set(retainedKey, state);
              const nextLocation = {
                screen: state.screen,
                atRoot: reviewIsAtRoot(state),
              };
              setReviewShellLocation((current) =>
                current.screen === nextLocation.screen && current.atRoot === nextLocation.atRoot
                  ? current
                  : nextLocation
              );
              options.reviewOptions?.onControllerStateChange?.(state);
            }}
            // The snapshot stream keeps flowing under review mode. This is only a
            // heartbeat: ReviewApp probes per-file generations and reloads the one
            // changed layer, so a clock tick cannot rebuild or rewrite the floor.
            liveGen={snapshot?.generatedAtMs ?? 0}
            onExit={exitReview}
          />
          {reviewNoticeOverlay}
          {shellMenuOverlay}
          {themeSelectorOverlay}
        </box>
      </CockpitThemeContext.Provider>
    );
  }

  if (live === null) {
    if (error !== null) {
      return (
        <CockpitThemeContext.Provider value={cockpitPreview}>
          <box
            key="watch-shell-root"
            width={width}
            height={height}
            backgroundColor={controls.diffTheme.background}
            flexDirection="column"
          >
            {shellBar}
            <ErrorState
              id="watch-data-error"
              variant="screen"
              title="Live data unavailable"
              message="Watch could not read the current capture snapshot."
              detail={stripTerminalFormatting(error.message)}
            />
            {shellMenuOverlay}
            {themeSelectorOverlay}
            {watchHelpOverlay}
          </box>
        </CockpitThemeContext.Provider>
      );
    }
    return (
      <CockpitThemeContext.Provider value={cockpitPreview}>
        <box
          key="watch-shell-root"
          width={width}
          height={height}
          backgroundColor={controls.diffTheme.background}
          flexDirection="column"
        >
          {shellBar}
          <LoadingScreen
            width={width}
            height={Math.max(1, height - 1)}
            message="connecting…"
            background={controls.diffTheme.background}
            accent={LIVE}
            fg={DIM}
          />
          {shellMenuOverlay}
          {themeSelectorOverlay}
          {watchHelpOverlay}
        </box>
      </CockpitThemeContext.Provider>
    );
  }

  // Repo dropdown sizing (options themselves are memoized above).
  const popLongest = repoOptions.reduce((m, o) => Math.max(m, o.name.length), 0);
  const popW = Math.min(38, Math.max(16, popLongest + 4));
  const popInnerH = Math.min(repoOptions.length, Math.max(3, bodyHeight - 2));
  const popH = popInnerH + 2;
  // Scroll a window of `popInnerH` rows so the highlighted repo stays visible.
  const popStart = Math.max(
    0,
    Math.min(repoSel - Math.floor(popInnerH / 2), repoOptions.length - popInnerH)
  );
  const popRows = repoOptions.slice(popStart, popStart + popInnerH);
  const root = `~/${live.dataRoot.split('/').filter(Boolean).pop() ?? '.orcaops'}`;

  return (
    <CockpitThemeContext.Provider value={cockpitPreview}>
      <box
        // Keyed per mode: the review and watch shells must NEVER reconcile onto
        // the same host box. When they do, the reused yoga subtree can carry a
        // stale layout across the mode switch (observed: change the theme in
        // Review, return to Watch, and the body lays out below the footer).
        key="watch-shell-root"
        flexDirection="column"
        width={width}
        height={height}
        backgroundColor={
          themeSel?.preview != null
            ? previewSelection.diffTheme.background
            : controls.diffTheme.background
        }
      >
        {shellBar}
        {topBarHeight === 0 ? null : (
          <box height={topBarHeight} flexShrink={0}>
            <TopBar
              snapshot={live}
              clock={fmtLocalTime(nowMs)}
              width={width}
              rows={topBarHeight}
              railWidth={railWidth}
              filter={filter}
              repo={repo}
              repoOpen={repoOpen}
              onFilter={setFilter}
              onRepo={() => setRepoOpen((o) => !o)}
            />
          </box>
        )}
        <box
          flexDirection={stacked ? 'column' : 'row'}
          height={bodyHeight}
          flexShrink={0}
          overflow="hidden"
        >
          {stacked ? watchDetailPane : null}
          {railHeight === 0 ? null : (
            <box flexDirection="column" width={railPaneWidth} flexShrink={0}>
              <box border borderColor={FRAME} flexDirection="column" height={railHeight}>
                <Section
                  id="watch-rail-section"
                  variant="cap"
                  title={groupBy === 'task' ? 'TASKS & THREADS' : 'THREADS'}
                  right={
                    railInner < 44
                      ? `${groupBy} · ${nav.length}/${totalThreads(live)}`
                      : `${groupBy} · ${nav.length} rows/${totalThreads(live)} threads`
                  }
                  focused={activePane === 'rail'}
                />
                {totalThreads(live) === 0 ? (
                  <EmptyState
                    id="watch-empty-capture"
                    variant="screen"
                    title="No captured work yet"
                    message="Captured plans and checkpoints will appear here as they are recorded."
                  />
                ) : nav.length === 0 && filter !== 'all' ? (
                  <EmptyState
                    id="watch-empty-filter"
                    variant="screen"
                    title="No destinations match this filter"
                    message={`The ${filter} filter excludes every captured destination${repo === null ? '.' : ` in ${repo}.`}`}
                    action={{
                      id: 'watch-clear-empty-filter',
                      label: 'Clear filter',
                      onSelect: () => setFilter('all'),
                    }}
                  />
                ) : nav.length === 0 && repo !== null ? (
                  <EmptyState
                    id="watch-empty-repo"
                    variant="screen"
                    title={`No captured work in ${repo}`}
                    message="Other repositories still have captured destinations."
                    action={{
                      id: 'watch-clear-empty-repo',
                      label: 'Show all repos',
                      onSelect: () => setRepo(null),
                    }}
                  />
                ) : nav.length === 0 ? (
                  <EmptyState
                    id="watch-empty-destinations"
                    variant="screen"
                    title="No visible destinations"
                    message="Change the current grouping or scope to restore the captured work list."
                  />
                ) : (
                  <ThreadRail
                    groups={groups}
                    selectedId={selectedId}
                    width={railInner}
                    nowMs={nowMs}
                    focused={activePane === 'rail' && !repoOpen}
                    scrollRef={railRef}
                    onSelect={selectAndFollow}
                  />
                )}
              </box>
              {eventsHeight === 0 ? null : (
                <box border borderColor={FRAME} flexDirection="column" height={eventsHeight}>
                  <Section
                    id="watch-events-section"
                    variant="cap"
                    title="LIVE EVENTS"
                    right="ALL PROJECTS"
                  />
                  <LiveEvents ticker={live.ticker} width={railInner} />
                </box>
              )}
            </box>
          )}
          {stacked ? null : watchDetailPane}
        </box>
        {shellHeight.footerRows === 0 ? null : (
          <box height={1} flexShrink={0}>
            {footerNotice !== null ? (
              <Notice
                id="watch-footer-notice"
                variant="inline"
                rows={1}
                message={footerNotice}
                width={width}
              />
            ) : (
              <KeyHints
                width={width}
                notify={notify}
                root={root}
                projectCount={live.projects.length}
                reviewable={reviewable}
                pane={activePane}
                detailMode={detailCp === null ? 'overview' : 'checkpoint'}
                onCommand={(id) => {
                  if (id.startsWith('watch.')) executeWatchCommand(id as WatchCommandId);
                  else executeShellCommand(id as ShellCommandId);
                }}
              />
            )}
          </box>
        )}
        {repoOpen ? (
          <>
            <box
              position="absolute"
              top={1}
              left={0}
              width={width}
              height={Math.max(0, height - 1)}
              zIndex={90}
              onMouseDown={() => setRepoOpen(false)}
            />
            <box
              id="watch-repository-picker"
              position="absolute"
              top={6}
              right={2}
              zIndex={100}
              border
              borderColor={FRAME}
              backgroundColor={PANEL_BG}
              flexDirection="column"
              width={popW}
              height={popH}
            >
              {popRows.map((opt, i) => {
                const idx = popStart + i;
                const active = idx === repoSel;
                return (
                  <box
                    key={opt.value ?? '__all'}
                    backgroundColor={active ? FOCUS_BG : undefined}
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseOver={() => setRepoSel(idx)}
                    onMouseDown={() => commitRepo(idx)}
                  >
                    <text fg={active ? BRIGHT : DIM}>
                      {truncate(opt.name, Math.max(4, popW - 4))}
                    </text>
                  </box>
                );
              })}
            </box>
          </>
        ) : null}
        {watchHelpOverlay}
        {shellMenuOverlay}
        {themeSelectorOverlay}
      </box>
    </CockpitThemeContext.Provider>
  );
}
