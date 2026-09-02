/** Real-PTY probe for the persistent Watch → Review → Watch application shell. */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

import { findPtyProbeNode, ptyProbeNodeLine, ptyProbeText } from './ptyProbeObserver';
import type { SnapshotSource } from '../../src/data/snapshot';
import { App } from '../../src/tui/App';
import { ThemeProvider } from '../../src/tui/ThemeProvider';
import { journeyReviewTarget, reviewableWatchSnapshot } from '../../tests/review/appJourneyFixture';
import {
  buildReviewAppHarness,
  commandLabel,
  createHarnessLog,
  loadedReviewJournalHarness,
  loadedReviewWithStoryFixture,
} from '../../tests/review/reviewAppHarness';
import {
  buildStoryReviewHarnessAnchors,
  buildStoryReviewHarnessFixture,
  storyOverlay,
} from '../../tests/review/storyReviewHarness';

const OUT = process.env.PROBE_OUT ?? '/tmp/orcaops-app-journey-pty.txt';

async function main(): Promise<void> {
  const log = createHarnessLog(OUT);
  const width = process.stdout.columns || Number(process.env.COLUMNS ?? 110);
  const height = process.stdout.rows || Number(process.env.LINES ?? 36);
  const baseReview = await buildReviewAppHarness({ scenario: 'mixed-parts', screen: 'walk' });
  const storyFixture = buildStoryReviewHarnessFixture();
  const routineStory = await storyOverlay(storyFixture.model, {
    runId: 'pty-app-story-shared-shell',
    anchors: buildStoryReviewHarnessAnchors(storyFixture),
  });
  const storyLoaded = await loadedReviewWithStoryFixture({
    base: baseReview.loaded,
    floor: storyFixture.floor,
    reviewDiff: storyFixture.reviewDiff,
    routineStory,
  });
  const storyJournal = await loadedReviewJournalHarness(storyLoaded);
  const review = {
    ...baseReview,
    loaded: storyJournal.loaded,
    journalEffects: storyJournal.journalEffects,
    journalEvents: storyJournal.journalEvents,
  };
  const snapshot = reviewableWatchSnapshot();
  const source: SnapshotSource = {
    start({ onSnapshot }) {
      onSnapshot(snapshot);
      return () => {};
    },
  };

  log(`BOOT app=App scenario=watch-review width=${width} height=${height}`);
  const renderer = await createCliRenderer({
    useMouse: true,
    useAlternateScreen: true,
    exitOnCtrlC: true,
  });

  const observedNodeIds = [
    'shell-menu-help',
    'shell-menu-view',
    'shell-menu-item-help',
    'shell-menu-item-watch.cycle-grouping',
    'shell-action-open-review',
    'shell-action-review-back',
    'shell-action-back-to-watch',
    'shell-menu-review',
    'shell-menu-item-story-lens',
    'shell-menu-item-captured-checkpoint-lens',
    'help-entry-0-3',
    'watch-task-row-task:journey-project:probe',
    'watch-task-member:thread:journey-artifact',
    'review-help-backdrop',
    'review-input-modal-action-save',
  ] as const;
  const nodeSignatures = new Map<string, string>();
  let routeSignature = '';
  let watchSelectionSignature = '';
  let overlaySignature = '';
  let watchDetailSignature = '';
  let watchPaneSignature = '';
  let watchGroupingSignature = '';
  let ready = false;
  let reviewReadyCount = 0;

  setInterval(() => {
    const root = renderer.root;
    for (const id of observedNodeIds) {
      const line = ptyProbeNodeLine(id, findPtyProbeNode(root, id));
      if (nodeSignatures.get(id) === line) continue;
      nodeSignatures.set(id, line);
      log(line);
    }

    const watchAction = findPtyProbeNode(root, 'shell-action-open-review');
    const reviewAction =
      findPtyProbeNode(root, 'shell-action-review-back') ??
      findPtyProbeNode(root, 'shell-action-back-to-watch');
    const route = reviewAction !== null ? 'review' : watchAction !== null ? 'watch' : 'loading';
    if (route !== routeSignature) {
      routeSignature = route;
      log(`ROUTE mode=${route}`);
    }
    const shellText = ptyProbeText(findPtyProbeNode(root, 'shell-menu-bar'));
    const watchSelection = shellText.match(/journey-project · (branch-[0-9]+|probe)/)?.[1] ?? '-';
    if (route === 'watch' && watchSelection !== watchSelectionSignature) {
      watchSelectionSignature = watchSelection;
      log(`WATCH_SELECTION branch=${watchSelection}`);
    }
    const taskMember = findPtyProbeNode(root, 'watch-task-member:thread:journey-artifact');
    const watchDetail =
      route !== 'watch' || watchSelection !== 'probe'
        ? '-'
        : taskMember !== null
          ? 'task'
          : 'thread';
    if (watchDetail !== watchDetailSignature) {
      watchDetailSignature = watchDetail;
      log(`WATCH_DETAIL level=${watchDetail}`);
    }
    const railSection = ptyProbeText(findPtyProbeNode(root, 'watch-rail-section'));
    const watchPane = railSection.includes('▸') ? 'rail' : 'detail';
    if (route === 'watch' && watchPane !== watchPaneSignature) {
      watchPaneSignature = watchPane;
      log(`WATCH_PANE value=${watchPane}`);
    }
    const watchGrouping = railSection.match(/\b(project|none|task)\b/)?.[1] ?? '-';
    if (watchGrouping !== watchGroupingSignature) {
      watchGroupingSignature = watchGrouping;
      log(`WATCH_GROUP value=${watchGrouping}`);
    }
    if (!ready && route === 'watch' && watchSelection === 'branch-00') {
      ready = true;
      log(`READY app=App scenario=watch-review width=${width} route=watch`);
    }

    const helpOpen = findPtyProbeNode(root, 'review-help-dialog') !== null;
    const nextOverlaySignature = String(helpOpen);
    if (nextOverlaySignature !== overlaySignature) {
      overlaySignature = nextOverlaySignature;
      log(`APP_OVERLAY help=${helpOpen ? 'open' : 'closed'}`);
    }
  }, 20);

  createRoot(renderer).render(
    <ThemeProvider detectedThemeMode={undefined}>
      <App
        options={{
          intervalMs: 2_000,
          snapshotSource: source,
          resolveReviewTarget: journeyReviewTarget,
          reviewOptions: {
            initialLoaded: review.loaded,
            initialControllerState: review.initialState,
            disableAutoLoad: true,
            journalEffects: review.journalEffects,
            commentEffects: review.commentEffects,
            onInputReady: () => {
              reviewReadyCount += 1;
              log(`REVIEW_READY count=${reviewReadyCount}`);
            },
            onCommandExecuted: (command, state) => {
              log(
                `REVIEW_COMMAND command=${commandLabel(command)} screen=${state.screen} depth=${state.routeHistory.length} page=${state.readerPage} hunk=${state.diffHunkKey ?? '-'} offset=${state.codeHorizontalOffset}`
              );
            },
            onLensStateChange: ({ activeLens }) => {
              log(
                `LENSES checkpoints=${activeLens === 'deterministic' ? '✓ ' : ''}Checkpoints story=${activeLens === 'story' ? '✓ ' : ''}Story`
              );
            },
            onControllerStateChange: (state) => {
              log(
                `REVIEW_STATE screen=${state.screen} depth=${state.routeHistory.length} page=${state.readerPage} focus=${state.focus} hunk=${state.diffHunkKey ?? '-'} offset=${state.codeHorizontalOffset} notice=${state.notice ?? '-'}`
              );
            },
          },
        }}
      />
    </ThemeProvider>
  );

  setTimeout(
    () => {
      log('TIMEOUT');
      process.exit(2);
    },
    Number(process.env.PROBE_TIMEOUT_MS ?? 30_000)
  );
}

void main();
