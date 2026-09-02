/**
 * Real-application PTY probe for Task Review v2.
 *
 * This mounts the real ReviewApp with injected fixture data and drives it
 * through an actual terminal, so keyboard input crosses the real
 * useKeyboard → dispatch → executeCommand → rendered-state seam at real widths.
 *
 * It logs only REAL effects — the command the controller ran, the state it
 * produced, and the durable journal events it appended. It deliberately does
 * NOT re-render the UI into the log — a hand-written renderer would let the PTY
 * assert something the product never emits. The rendered frame is asserted by the
 * mounted-app tests (`reviewApp.render.test.tsx`), against the renderer users
 * actually see.
 */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

import { findPtyProbeNode, ptyProbeNodeLine, ptyProbeText } from './ptyProbeObserver';
import { ThemeProvider } from '../../src/tui/ThemeProvider';
import { ReviewApp } from '../../src/tui/review/ReviewApp';
import type { StoryReviewScreen } from '../../src/tui/review/keymap';
import type { ReviewControllerState } from '../../src/tui/review/readerReviewController';
import {
  assertScenario,
  buildReviewAppHarness,
  commandLabel,
  createHarnessLog,
  loadedReviewJournalHarness,
  loadedReviewWithStoryFixture,
  tallTwoFileHarnessDiff,
} from '../../tests/review/reviewAppHarness';
import {
  buildStoryReviewHarnessAnchors,
  buildStoryReviewHarnessFixture,
  storyOverlay,
} from '../../tests/review/storyReviewHarness';

const OUT = process.env.PROBE_OUT ?? '/tmp/orcaops-review-experience-pty.txt';
const scenario = assertScenario(process.env.PROBE_SCENARIO ?? 'multi-location');
const requestedScreen = (process.env.PROBE_SCREEN ?? 'brief') as StoryReviewScreen;
const reviewDiff =
  process.env.PROBE_DIFF === 'tall-two-file' ? tallTwoFileHarnessDiff(400, 400, true) : undefined;

async function main(): Promise<void> {
  const log = createHarnessLog(OUT);
  const width = process.stdout.columns || Number(process.env.COLUMNS ?? 110);
  const height = process.stdout.rows || Number(process.env.LINES ?? 36);

  let harness = await buildReviewAppHarness({
    scenario,
    screen: requestedScreen,
    ...(reviewDiff === undefined ? {} : { reviewDiff }),
  });
  if (scenario === 'reader-parity') {
    const storyFixture = buildStoryReviewHarnessFixture();
    const routineStory = await storyOverlay(storyFixture.model, {
      runId: 'pty-story-shared-shell',
      anchors: buildStoryReviewHarnessAnchors(storyFixture),
    });
    const storyLoaded = await loadedReviewWithStoryFixture({
      base: harness.loaded,
      floor: storyFixture.floor,
      reviewDiff: storyFixture.reviewDiff,
      routineStory,
    });
    const storyJournal = await loadedReviewJournalHarness(storyLoaded);
    harness = {
      ...harness,
      loaded: storyJournal.loaded,
      journalEffects: storyJournal.journalEffects,
      journalEvents: storyJournal.journalEvents,
    };
  }
  const { loaded, initialState, journalEffects, commentEffects } = harness;
  const initialLoaded =
    process.env.PROBE_WARNINGS === '1'
      ? {
          ...loaded,
          data: {
            ...loaded.data,
            floor: {
              ...loaded.data.floor,
              scope: { ...loaded.data.floor.scope, head_sha: 'floor-head' },
              plan_coverage: loaded.data.floor.plan_coverage.map((step, index) =>
                index === 0 ? { ...step, unclaimed: true } : step
              ),
            },
            worktreeHeadSha: 'current-head',
          },
        }
      : loaded;

  log(`BOOT app=ReviewApp scenario=${scenario} width=${width} height=${height}`);

  const renderer = await createCliRenderer({
    useMouse: true,
    useAlternateScreen: true,
    exitOnCtrlC: true,
  });
  let inputReady = false;
  let firstState: StoryReviewScreen | null = null;
  let latestState: ReviewControllerState | null = null;
  let ready = false;
  const signalReady = (): void => {
    if (ready || !inputReady || firstState === null) return;
    ready = true;
    log(`READY app=ReviewApp scenario=${scenario} width=${width} screen=${firstState}`);
  };
  const observedNodeIds = [
    'review-diff-scroll',
    'review-file-navigator-row-1',
    'review-input-modal-action-save',
    'review-input-modal-action-cancel',
  ] as const;
  const nodeSignatures = new Map<string, string>();
  let overlaySignature = '';
  let viewportSignature = '';
  setInterval(() => {
    const root = renderer.root;
    const helpOpen = findPtyProbeNode(root, 'review-help-dialog') !== null;
    const inputOpen = findPtyProbeNode(root, 'review-input-modal') !== null;
    const nextOverlaySignature = `${helpOpen}:${inputOpen}`;
    if (nextOverlaySignature !== overlaySignature) {
      overlaySignature = nextOverlaySignature;
      log(
        `PTY_OVERLAY help=${helpOpen ? 'open' : 'closed'} input=${inputOpen ? 'open' : 'closed'}`
      );
    }

    for (const id of observedNodeIds) {
      const line = ptyProbeNodeLine(id, findPtyProbeNode(root, id));
      if (nodeSignatures.get(id) === line) continue;
      nodeSignatures.set(id, line);
      log(line);
    }

    const surface = findPtyProbeNode(root, 'review-diff-scroll');
    if (surface === null) return;
    const header = ptyProbeText(findPtyProbeNode(root, 'review-pinned-file-header'));
    const files = ptyProbeText(findPtyProbeNode(root, 'review-file-navigator'));
    const state = latestState;
    const nextViewportSignature = [
      Math.floor(surface.scrollTop ?? 0),
      Math.floor(surface.scrollHeight ?? 0),
      Math.floor(surface.viewport?.height ?? surface.height ?? 0),
      header,
      files,
      state?.diffHunkKey ?? '-',
      state?.codeHorizontalOffset ?? 0,
    ].join('|');
    if (nextViewportSignature === viewportSignature) return;
    viewportSignature = nextViewportSignature;
    log(
      `VIEWPORT top=${Math.floor(surface.scrollTop ?? 0)} content=${Math.floor(surface.scrollHeight ?? 0)} viewport=${Math.floor(surface.viewport?.height ?? surface.height ?? 0)} header=${header || '-'} files=${files || '-'} hunk=${state?.diffHunkKey ?? '-'} offset=${state?.codeHorizontalOffset ?? 0}`
    );
  }, 20);
  createRoot(renderer).render(
    <ThemeProvider detectedThemeMode={undefined}>
      <ReviewApp
        root={undefined}
        branch="probe"
        width={width}
        height={height}
        initialLoaded={initialLoaded}
        initialControllerState={initialState}
        disableAutoLoad={true}
        onExit={() => process.exit(0)}
        journalEffects={{
          ...journalEffects,
          append: async (opts, event) => {
            const replayed = await journalEffects.append(opts, event);
            const lifecycle =
              replayed.status === 'appended'
                ? replayed.ledger.lifecycle
                : initialLoaded.ledger.lifecycle;
            log(
              `JOURNAL action=${event.type === 'review_lifecycle' ? event.action : event.type} state=${lifecycle.state} history=${lifecycle.history.length}`
            );
            return replayed;
          },
        }}
        commentEffects={commentEffects}
        onCommandExecuted={(command, state) => {
          log(
            `command=${commandLabel(command)} screen=${state.screen} focus=${state.focus} grain=${state.diffGrain} hunk=${state.diffHunkKey ?? '-'} act=${state.activeAct} part=${state.activePart} item=${state.activeItem} target=${state.activeTarget} row=${state.diffRowCursor} context=${state.contextItemCursor}`
          );
        }}
        onInputReady={() => {
          inputReady = true;
          signalReady();
        }}
        onHelpOpenChange={(open) => {
          log(`OVERLAY help=${open ? 'open' : 'closed'}`);
        }}
        onControllerStateChange={(state) => {
          latestState = state;
          firstState ??= state.screen;
          signalReady();
          log(
            `STATE screen=${state.screen} focus=${state.focus} grain=${state.diffGrain} hunk=${state.diffHunkKey ?? '-'} context=${state.contextItemCursor} offset=${state.codeHorizontalOffset} files=${state.fileNavigatorExpanded ? 'open' : 'closed'} notice=${state.notice ?? '-'}`
          );
        }}
        onModalOpenChange={(open) => {
          log(`OVERLAY input=${open ? 'open' : 'closed'}`);
        }}
      />
    </ThemeProvider>
  );
  setTimeout(
    () => {
      log('TIMEOUT');
      process.exit(2);
    },
    Number(process.env.PROBE_TIMEOUT_MS ?? 15_000)
  );
}

void main();
