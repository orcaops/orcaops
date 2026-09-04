import { parseColor } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { expect, test } from 'bun:test';

import { THEMES } from '@orcaops/diff-render';
import type { WatchSnapshot } from '@orcaops/watch-data/ui';

import {
  journeyReviewTarget,
  REVIEWABLE_JOURNEY_INDEX,
  reviewableWatchSnapshot,
} from '../../../tests/review/appJourneyFixture';
import { buildReviewAppHarness } from '../../../tests/review/reviewAppHarness';
import type { SnapshotSource } from '../../data/snapshot';
import { App, composeWatchFooterNotice, MIXED_ARCHIVE_NOTICE_PREFIX } from '../App';
import { ThemeProvider } from '../ThemeProvider';
import { executableHelpInvocation } from '../commandRegistry';
import { selectShellHelpCommands } from '../shellCommands';
import { selectWatchCommands } from '../watchCommands';

interface RenderNode {
  id?: string;
  height?: number;
  scrollTop?: number;
  backgroundColor?: { toInts(): number[] };
  getChildren?: () => unknown[];
}

function findNode(node: unknown, id: string): RenderNode | null {
  const candidate = node as RenderNode;
  if (candidate?.id === id) return candidate;
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findNode(child, id);
    if (found !== null) return found;
  }
  return null;
}

function selectedPreviewTheme(frame: string) {
  const selectedRow = frame.split('\n').find((row) => row.includes('›')) ?? '';
  return [...THEMES]
    .sort((left, right) => right.label.length - left.label.length)
    .find((theme) => selectedRow.includes(theme.label) && selectedRow.includes(theme.appearance));
}

test('the real App keeps one reversible keyboard and pointer journey across Watch and Review', async () => {
  const review = await buildReviewAppHarness({ scenario: 'two-checkpoints', screen: 'floor-diff' });
  const snapshot = reviewableWatchSnapshot();
  const source: SnapshotSource = {
    start({ onSnapshot }) {
      onSnapshot(snapshot);
      return () => {};
    },
  };
  const harness = await createTestRenderer({ width: 160, height: 42, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider
      detectedThemeMode={undefined}
      persistThemeEffect={async () => {
        throw new Error('read-only test config');
      }}
    >
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
          },
        }}
      />
    </ThemeProvider>
  );

  const settle = async () => {
    let previous = '';
    let stablePasses = 0;
    for (let pass = 0; pass < 16; pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      stablePasses = frame === previous ? stablePasses + 1 : 0;
      if (stablePasses >= 2) return;
      previous = frame;
    }
  };
  const press = async (key: string) => {
    const code =
      {
        f10: '\u001b[21~',
        right: '\u001b[C',
        down: '\u001b[B',
        return: '\r',
      }[key] ?? key;
    harness.mockInput.pressKey(code);
    await settle();
  };
  const clickTopAction = async (label: string) => {
    const row = harness.captureCharFrame().split('\n')[0] ?? '';
    const x = row.indexOf(label);
    expect(x).toBeGreaterThanOrEqual(0);
    await harness.mockMouse.click(x + 1, 0);
    await settle();
  };
  const clickFrameText = async (label: string, startRow = 0) => {
    const rows = harness.captureCharFrame().split('\n');
    const y = rows.findIndex((row, index) => index >= startRow && row.includes(label));
    expect(y).toBeGreaterThanOrEqual(startRow);
    const x = rows[y]!.indexOf(label);
    await harness.mockMouse.click(x + 1, y);
    await settle();
  };
  const hoverFrameText = async (label: string, startRow = 0) => {
    const rows = harness.captureCharFrame().split('\n');
    const y = rows.findIndex((row, index) => index >= startRow && row.includes(label));
    expect(y).toBeGreaterThanOrEqual(startRow);
    const x = rows[y]!.indexOf(label);
    await harness.mockMouse.moveTo(x + 1, y);
    await settle();
  };
  const selectedIsVisibleInRail = (): boolean =>
    harness
      .captureCharFrame()
      .split('\n')
      .some((row) => row.slice(0, 54).includes('/probe'));

  await settle();
  expect(harness.captureCharFrame()).toContain('journey-project · branch-00');
  expect(harness.captureCharFrame()).toContain('Review  v');

  // The Watch landing rail is pointer-operable without changing its
  // master-detail contract: hover paints only and one click selects a preview.
  await hoverFrameText('branch-01', 1);
  expect(harness.captureCharFrame()).toContain('journey-project · branch-00');
  await clickFrameText('branch-01', 1);
  expect(harness.captureCharFrame()).toContain('journey-project · branch-01');
  expect(harness.captureCharFrame()).toContain('Background fixture 01');
  await clickFrameText('branch-00', 1);
  expect(harness.captureCharFrame()).toContain('journey-project · branch-00');

  // Help is the executable command surface: its first unambiguous Watch row is
  // the registered filter command, and one click closes Help before running it.
  const allFilterBackground = findNode(harness.renderer.root, 'watch-filter-all')?.backgroundColor;
  await press('?');
  expect(harness.captureCharFrame()).toContain('Enter run');
  await clickFrameText('Cycle the status filter', 1);
  expect(harness.captureCharFrame()).not.toContain('Watch controls');
  expect(
    findNode(harness.renderer.root, 'watch-filter-attention')?.backgroundColor?.toInts()
  ).toEqual(allFilterBackground?.toInts());
  for (let index = 0; index < 4; index += 1) await press('/');

  // The same surface reaches shared-shell commands. Derive how many executable
  // rows precede Theme from BOTH registries so new commands cannot silently
  // retarget this journey. The Help layer is gone before Theme takes focus.
  await press('?');
  const watchExecutables = selectWatchCommands(
    { connected: true, pane: 'rail', detailMode: 'overview' },
    'help'
  ).filter((command) => executableHelpInvocation(command) !== null).length;
  const shellExecutablesBeforeTheme = selectShellHelpCommands({
    mode: 'watch',
    reviewable: true,
    watchAtRoot: true,
    reviewAtRoot: true,
    storyAvailable: false,
    storyViewable: false,
    reviewLens: 'deterministic',
  })
    .filter((command) => executableHelpInvocation(command) !== null && command.id !== 'help')
    .findIndex((command) => command.id === 'theme');
  expect(shellExecutablesBeforeTheme).toBeGreaterThanOrEqual(0);
  for (let index = 0; index < watchExecutables + shellExecutablesBeforeTheme; index += 1)
    await press('j');
  await press('return');
  expect(harness.captureCharFrame()).not.toContain('Watch controls');
  expect(harness.captureCharFrame()).toContain('Theme preview ·');
  await press('\u001b');

  // Review is offered on every row — which worktree owns a branch costs disk
  // I/O to learn, so the refusal arrives from the resolve rather than a
  // synchronous guard. Refused actions keep keyboard and pointer parity and
  // still explain themselves.
  await press('f10');
  await press('right');
  expect(findNode(harness.renderer.root, 'shell-menu-item-open-review')).not.toBeNull();
  await press('return');
  expect(harness.captureCharFrame()).toContain('no live worktree');
  await clickTopAction('Review  v');
  expect(harness.captureCharFrame()).toContain('no live worktree');

  for (let index = 0; index < REVIEWABLE_JOURNEY_INDEX; index += 1) await press('j');
  expect(harness.captureCharFrame()).toContain('journey-project · probe');
  expect(selectedIsVisibleInRail()).toBe(true);
  const watchRailTop = findNode(harness.renderer.root, 'watch-rail-scroll')?.scrollTop ?? 0;
  expect(watchRailTop).toBeGreaterThan(0);

  await press('v');
  expect(harness.captureCharFrame()).toContain('Review · probe · Checkpoint diff');
  expect(harness.captureCharFrame()).not.toContain('Review Composed Story');
  expect(harness.captureCharFrame()).not.toContain('Review Captured Checkpoints');
  expect(harness.captureCharFrame()).toContain('Back  q');
  expect(harness.captureCharFrame()).toContain('REVIEW CONTEXT · CHECKPOINT');

  // The persistent menu invokes the same Help layer while the consumed request
  // does not replay.
  await clickTopAction('Help');
  expect(harness.captureCharFrame()).toContain('Help          ?');
  await clickFrameText('Help', 1);
  expect(harness.captureCharFrame()).toContain('Review controls');
  expect(harness.captureCharFrame()).toContain('Open application menus');
  await clickTopAction('Back  q');
  expect(harness.captureCharFrame()).toContain('Review controls');
  await clickFrameText('Open application menus', 1);
  expect(harness.captureCharFrame()).not.toContain('Review controls');
  expect(findNode(harness.renderer.root, 'shell-dropdown-review')).not.toBeNull();
  await press('q');

  // Theme persistence feedback stays on Review's visible status row.
  await press('t');
  expect(harness.captureCharFrame()).toContain('Theme preview ·');
  await press('down');
  const previewTheme = selectedPreviewTheme(harness.captureCharFrame());
  expect(previewTheme).toBeDefined();
  for (const id of ['shell-menu-bar', 'review-context-rail', 'theme-selector-dialog']) {
    expect(findNode(harness.renderer.root, id)?.backgroundColor?.toInts(), id).toEqual(
      parseColor(previewTheme!.panel).toInts()
    );
  }
  await press('return');
  expect(harness.captureCharFrame()).toContain('config write failed');

  // q dismisses shared overlays, but remains ordinary input in the composer.
  await press('t');
  expect(harness.captureCharFrame()).toContain('Theme preview ·');
  await press('q');
  expect(harness.captureCharFrame()).not.toContain('Theme preview ·');

  // Pointer selection runs the same preview/commit transition as Enter.
  await press('t');
  const themeRows = harness.captureCharFrame().split('\n');
  const selectedThemeRow = themeRows.findIndex((row) => /›\s+\S+\s+(dark|light)/.test(row));
  expect(selectedThemeRow).toBeGreaterThanOrEqual(0);
  const selectedThemeColumn = themeRows[selectedThemeRow]!.indexOf('›');
  await harness.mockMouse.click(selectedThemeColumn + 2, selectedThemeRow);
  await settle();
  expect(harness.captureCharFrame()).not.toContain('Theme preview ·');
  expect(harness.captureCharFrame()).toContain('config write failed');

  await press('c');
  expect(findNode(harness.renderer.root, 'review-input-modal')).not.toBeNull();
  await press('q');
  expect(findNode(harness.renderer.root, 'review-input-modal')).not.toBeNull();
  await press('\u0013');
  expect(findNode(harness.renderer.root, 'review-input-modal')).toBeNull();
  expect(review.sidecar().at(-1)?.body).toBe('q');

  await press(']');
  expect(harness.captureCharFrame()).toContain('Checkpoint 2/2');

  await press('q');
  expect(harness.captureCharFrame()).toContain('CAPTURED WORK');
  expect(harness.captureCharFrame()).toContain('Review · probe · Overview');
  expect(harness.captureCharFrame()).not.toContain('journey-project · probe');
  await press('q');
  expect(harness.captureCharFrame()).toContain('journey-project · probe');
  expect(selectedIsVisibleInRail()).toBe(true);
  expect(findNode(harness.renderer.root, 'watch-rail-scroll')?.scrollTop).toBe(watchRailTop);

  // Watch q is depth-aware: it backs out of Detail, while root q remains Quit.
  await press('return');
  expect(harness.captureCharFrame()).toContain('q back');
  expect(harness.captureCharFrame()).not.toContain('q quit');
  await press('q');
  expect(harness.captureCharFrame()).toContain('q quit');

  await press('t');
  expect(harness.captureCharFrame()).toContain('Theme preview ·');
  await press('q');
  expect(harness.captureCharFrame()).not.toContain('Theme preview ·');
  await press('f10');
  expect(findNode(harness.renderer.root, 'shell-menu-item-quit')).not.toBeNull();
  await press('q');
  expect(findNode(harness.renderer.root, 'shell-menu-item-quit')).toBeNull();
  await press('r');
  expect(findNode(harness.renderer.root, 'watch-repository-picker')).not.toBeNull();
  await press('q');
  expect(findNode(harness.renderer.root, 'watch-repository-picker')).toBeNull();

  await press('v');
  expect(harness.captureCharFrame()).toContain('CAPTURED WORK');
  await press('return');
  expect(harness.captureCharFrame()).toContain('REVIEW CONTEXT · CHECKPOINT');
  expect(harness.captureCharFrame()).not.toContain('Review controls');

  // Review's application menu exposes navigation only; there are no lens-switch
  // controls.
  await clickTopAction('Review');
  expect(findNode(harness.renderer.root, 'shell-menu-item-review-back')).not.toBeNull();
  expect(harness.captureCharFrame()).not.toContain('Review Composed Story');
  expect(harness.captureCharFrame()).not.toContain('Review Captured Checkpoints');
  await press('q');

  await clickTopAction('Back  q');
  expect(harness.captureCharFrame()).toContain('CAPTURED WORK');
  expect(harness.captureCharFrame()).toContain('Watch  q');
  await clickTopAction('Watch  q');
  expect(harness.captureCharFrame()).toContain('journey-project · probe');
  expect(harness.captureCharFrame()).toContain('Premium journey fixture');
  expect(selectedIsVisibleInRail()).toBe(true);

  await clickTopAction('Review  v');
  expect(harness.captureCharFrame()).toContain('Review · probe · Overview');
  expect(harness.captureCharFrame()).toContain('CAPTURED WORK');

  harness.renderer.destroy();
});

test('Watch Help remains visible and closable while the snapshot source is connecting', async () => {
  const source: SnapshotSource = { start: () => () => {} };
  const harness = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <App options={{ intervalMs: 2_000, snapshotSource: source }} />
    </ThemeProvider>
  );
  const settle = async () => {
    for (let pass = 0; pass < 6; pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await harness.renderOnce();
    }
  };

  await settle();
  expect(harness.captureCharFrame()).toContain('connecting…');
  harness.mockInput.pressKey('?');
  await settle();
  expect(harness.captureCharFrame()).toContain('Watch controls');
  expect(harness.captureCharFrame()).toContain('Open application menus');

  harness.mockInput.pressKey('q');
  await settle();
  expect(harness.captureCharFrame()).not.toContain('Watch controls');
  expect(harness.captureCharFrame()).toContain('connecting…');
  harness.renderer.destroy();
});

test('Watch replaces a stale dashboard with the source error after disconnecting', async () => {
  let reportFailure: ((error: Error) => void) | undefined;
  let publishSnapshot: ((snapshot: WatchSnapshot) => void) | undefined;
  const snapshot = reviewableWatchSnapshot();
  const source: SnapshotSource = {
    start({ onSnapshot, onError }) {
      reportFailure = onError;
      publishSnapshot = onSnapshot;
      onSnapshot(snapshot);
      return () => {};
    },
  };
  const harness = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <App options={{ intervalMs: 2_000, snapshotSource: source }} />
    </ThemeProvider>
  );
  const settle = async () => {
    for (let pass = 0; pass < 8; pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await harness.renderOnce();
    }
  };

  await settle();
  expect(harness.captureCharFrame()).toContain('journey-project');
  harness.mockInput.pressKey('\r');
  await settle();
  expect(harness.captureCharFrame()).toContain('q back');

  reportFailure?.(
    new Error('sidecar refused \u001b[2Jhidden controls\rfor a poisoned artifacts root')
  );
  await settle();
  const frame = harness.captureCharFrame();
  expect(frame).toContain('Live data unavailable');
  expect(frame).toContain('sidecar refused hidden controlsfor a poisoned artifacts root');
  expect(frame).not.toContain('\u001b');
  expect(frame).not.toContain('\r');
  expect(frame).not.toContain('journey-project');

  publishSnapshot?.(snapshot);
  await settle();
  expect(harness.captureCharFrame()).toContain('journey-project');
  expect(harness.captureCharFrame()).toContain('q back');
  harness.renderer.destroy();
});

test('Watch keeps the dashboard usable while visibly warning about partial archive data', async () => {
  const snapshot = reviewableWatchSnapshot();
  snapshot.archiveIssues = [
    {
      kind: 'artifact_unavailable',
      project_id: 'proj-a',
      project: 'sample-service',
      artifact_id: '01999999-9999-7000-8000-0000000000ee',
      message: 'checkpoint abandonment has no matching open',
    },
  ];
  const source: SnapshotSource = {
    start({ onSnapshot }) {
      onSnapshot(snapshot);
      return () => {};
    },
  };
  const width = 48;
  const harness = await createTestRenderer({ width, height: 30, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <App
        options={{
          intervalMs: 2_000,
          snapshotSource: source,
          resolveReviewTarget: async () => ({
            ok: false,
            reason: 'review temporarily unavailable while the worktree index refreshes',
          }),
        }}
      />
    </ThemeProvider>
  );
  for (let pass = 0; pass < 8; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  }

  const frame = harness.captureCharFrame();
  expect(frame).toContain('Partial archive data');
  expect(frame).toContain('1 artifact unavailable');
  expect(frame).not.toContain('Live data unavailable');

  harness.mockInput.pressKey('v');
  for (let pass = 0; pass < 8; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  }
  const withTransient = harness.captureCharFrame();
  expect(withTransient).toContain('Partial archive · repair/prune · review');
  expect(withTransient).not.toContain('while the worktree index refreshes');
  expect(
    composeWatchFooterNotice(
      'review temporarily unavailable while the worktree index refreshes',
      'Partial archive data · 1 artifact unavailable in sample-service',
      width,
      'Partial archive · repair/prune · '
    )
  ).toBe('Partial archive · repair/prune · review tempo…');
  harness.renderer.destroy();
});

test('Watch keeps the dashboard usable while visibly warning about project identity', async () => {
  const snapshot = reviewableWatchSnapshot();
  snapshot.archiveIssues = [
    {
      kind: 'project_identity_unavailable',
      source: 'hot',
      project_id: null,
      project: 'sample-service',
      message: 'stored project identity is invalid',
    },
  ];
  const source: SnapshotSource = {
    start({ onSnapshot }) {
      onSnapshot(snapshot);
      return () => {};
    },
  };
  const harness = await createTestRenderer({ width: 72, height: 30, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <App
        options={{
          intervalMs: 2_000,
          snapshotSource: source,
          resolveReviewTarget: async () => ({
            ok: false,
            reason: 'review temporarily unavailable while the worktree index refreshes',
          }),
        }}
      />
    </ThemeProvider>
  );
  for (let pass = 0; pass < 8; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  }

  const frame = harness.captureCharFrame();
  expect(frame).toContain('Project identity problem');
  expect(frame).toContain('run doctor');
  expect(frame).not.toContain('Live data unavailable');

  harness.mockInput.pressKey('v');
  for (let pass = 0; pass < 8; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  }
  const withTransient = harness.captureCharFrame();
  expect(withTransient).toContain('Identity · doctor');
  expect(withTransient).toContain('review temporarily');
  harness.renderer.destroy();
});

test('Watch keeps the dashboard usable while visibly warning about an incomplete hot projection', async () => {
  const snapshot = reviewableWatchSnapshot();
  snapshot.archiveIssues = [
    {
      kind: 'hot_projection_incomplete',
      project_id: 'proj-a',
      project: 'sample-service',
      health: 'degraded',
      message: 'one durable artifact was skipped during rebuild',
    },
  ];
  const source: SnapshotSource = {
    start({ onSnapshot }) {
      onSnapshot(snapshot);
      return () => {};
    },
  };
  const harness = await createTestRenderer({ width: 72, height: 30, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <App options={{ intervalMs: 2_000, snapshotSource: source }} />
    </ThemeProvider>
  );
  for (let pass = 0; pass < 8; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  }

  const frame = harness.captureCharFrame();
  expect(frame).toContain('Local projection incomplete');
  expect(frame).toContain('needs repair');
  expect(frame).toContain('run doctor');
  expect(frame).not.toContain('Live data unavailable');
  harness.renderer.destroy();
});

test('Watch discloses both project identity and archive artifact problems', async () => {
  const snapshot = reviewableWatchSnapshot();
  snapshot.archiveIssues = [
    {
      kind: 'project_identity_unavailable',
      source: 'hot',
      project_id: null,
      project: 'sample-service',
      message: 'stored project identity is invalid',
    },
    {
      kind: 'artifact_unavailable',
      project_id: '019fc200-0000-7000-8000-00000000ccc1',
      project: 'sample-service',
      artifact_id: '019fc200-0000-7000-8000-00000000ddd1',
      message: 'archive artifact cannot be reconstructed',
    },
  ];
  const source: SnapshotSource = {
    start({ onSnapshot }) {
      onSnapshot(snapshot);
      return () => {};
    },
  };
  const harness = await createTestRenderer({ width: 72, height: 30, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <App
        options={{
          intervalMs: 2_000,
          snapshotSource: source,
          resolveReviewTarget: async () => ({
            ok: false,
            reason: 'review temporarily unavailable while the worktree index refreshes',
          }),
        }}
      />
    </ThemeProvider>
  );
  for (let pass = 0; pass < 8; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  }

  const frame = harness.captureCharFrame();
  expect(frame).toContain('Project identity problem');
  expect(frame).toContain('Partial archive');
  expect(frame).toContain('archive repair');
  expect(frame).not.toContain('Live data unavailable');

  harness.mockInput.pressKey('v');
  for (let pass = 0; pass < 8; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  }
  const withTransient = harness.captureCharFrame();
  expect(withTransient).toContain('ID+archive');
  expect(withTransient).toContain('doctor/repair');
  expect(withTransient).toContain('review temporarily');
  expect(
    composeWatchFooterNotice(
      'review temporarily unavailable',
      'Project identity problem · Partial archive',
      40,
      MIXED_ARCHIVE_NOTICE_PREFIX
    )
  ).toBe('ID+archive · doctor/repair · review t…');
  harness.renderer.destroy();
});

for (const width of [80, 110, 160]) {
  test(`Review keeps one-row route chrome and contextual Back at ${width} columns`, async () => {
    const review = await buildReviewAppHarness({ scenario: 'mixed-parts', screen: 'walk' });
    const source: SnapshotSource = {
      start({ onSnapshot }) {
        onSnapshot(reviewableWatchSnapshot());
        return () => {};
      },
    };
    const harness = await createTestRenderer({ width, height: 30, kittyKeyboard: true });
    const root = createRoot(harness.renderer);
    root.render(
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
            },
          }}
        />
      </ThemeProvider>
    );
    const settle = async () => {
      for (let pass = 0; pass < 8; pass += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await harness.renderOnce();
      }
    };
    await settle();
    for (let index = 0; index < REVIEWABLE_JOURNEY_INDEX; index += 1) {
      harness.mockInput.pressKey('j');
      await settle();
    }
    harness.mockInput.pressKey('v');
    await settle();

    const shellRow = harness.captureCharFrame().split('\n')[0] ?? '';
    expect(shellRow).toContain('Review');
    expect(shellRow).toContain('Back  q');
    expect(shellRow).toContain(width === 80 ? 'Review · probe · S' : 'Review · probe · Story');
    expect(findNode(harness.renderer.root, 'shell-menu-bar')?.height).toBe(1);
    harness.renderer.destroy();
  });
}

for (const width of [80, 110]) {
  test(`the complete Watch shell keeps primary chrome and context visible at ${width} columns`, async () => {
    const snapshot = reviewableWatchSnapshot();
    const source: SnapshotSource = {
      start({ onSnapshot }) {
        onSnapshot(snapshot);
        return () => {};
      },
    };
    const harness = await createTestRenderer({ width, height: 30, kittyKeyboard: true });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <App options={{ intervalMs: 2_000, snapshotSource: source }} />
      </ThemeProvider>
    );
    const settle = async () => {
      for (let pass = 0; pass < 8; pass += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await harness.renderOnce();
      }
    };
    await settle();

    const rows = harness.captureCharFrame().split('\n');
    expect(rows[0]).toContain('Orcaops');
    expect(rows[0]).toContain('Review');
    expect(rows[0]).toContain('Help');
    expect(rows[0]).toContain('Review  v');
    const footer = rows.find((row) => row.includes('v review')) ?? '';
    expect(footer).toContain('v review');
    expect(footer).toContain('? help');
    expect(footer).toContain('q quit');
    expect(footer).toMatch(/1(?:p| projects)/);

    harness.mockInput.pressKey('?');
    await settle();
    expect(harness.captureCharFrame()).toContain('Watch controls');
    expect(harness.captureCharFrame()).toContain('Thread list · choose work to inspect');
    expect(harness.captureCharFrame()).toContain('Here');
    harness.mockInput.pressKey('q');
    await settle();

    harness.mockInput.pressKey('t');
    await settle();
    expect(harness.captureCharFrame()).toContain('Theme preview ·');
    expect(harness.captureCharFrame()).toContain('Enter applies');
    expect(harness.captureCharFrame()).toContain('[Esc]');
    harness.mockInput.pressKey('\u001b');
    await settle();
    expect(harness.captureCharFrame()).not.toContain('Theme preview ·');
    harness.renderer.destroy();
  });
}

for (const height of [12, 24]) {
  test(`Watch yields secondary chrome while keeping body and footer at ${height} rows`, async () => {
    const snapshot = reviewableWatchSnapshot();
    const source: SnapshotSource = {
      start({ onSnapshot }) {
        onSnapshot(snapshot);
        return () => {};
      },
    };
    const harness = await createTestRenderer({ width: 110, height, kittyKeyboard: true });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <App options={{ intervalMs: 2_000, snapshotSource: source }} />
      </ThemeProvider>
    );
    for (let pass = 0; pass < 8; pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await harness.renderOnce();
    }

    const rows = harness.captureCharFrame().split('\n').slice(0, height);
    expect(rows).toHaveLength(height);
    expect(rows.join('\n')).toContain('THREADS');
    expect(rows[height - 1]).toContain('? help');
    expect(rows[height - 1]).toContain('q quit');
    if (height === 12) {
      expect(rows.join('\n')).not.toContain('LIVE EVENTS');
      expect(rows.join('\n')).not.toContain('⣀⣤');
    } else {
      expect(rows.join('\n')).toContain('LIVE EVENTS');
    }
    harness.renderer.destroy();
  });
}

test('Watch distinguishes true, filter, and repository empty states with recovery actions', async () => {
  const mountWatch = async (snapshot: WatchSnapshot) => {
    const source: SnapshotSource = {
      start({ onSnapshot }) {
        onSnapshot(snapshot);
        return () => {};
      },
    };
    const harness = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <App options={{ intervalMs: 2_000, snapshotSource: source }} />
      </ThemeProvider>
    );
    const settle = async () => {
      for (let pass = 0; pass < 8; pass += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await harness.renderOnce();
      }
    };
    await settle();
    return { harness, settle };
  };

  const base = reviewableWatchSnapshot();
  const empty = await mountWatch({
    ...base,
    totals: { activeThreads: 0, openCheckpoints: 0, sessionTokens: 0 },
    projects: [],
  });
  expect(empty.harness.captureCharFrame()).toContain('No captured work yet');
  expect(empty.harness.captureCharFrame()).not.toContain('No destinations match this filter');
  empty.harness.renderer.destroy();

  const scoped = await mountWatch({
    ...base,
    projects: [{ projectId: null, displayName: 'empty-project', threads: [] }, ...base.projects],
  });
  scoped.harness.mockInput.pressKey('/');
  await scoped.settle();
  expect(scoped.harness.captureCharFrame()).toContain('No destinations match this');
  expect(scoped.harness.captureCharFrame()).toContain('[Clear filter]');

  let rows = scoped.harness.captureCharFrame().split('\n');
  let y = rows.findIndex((row) => row.includes('[Clear filter]'));
  let x = rows[y]!.indexOf('[Clear filter]');
  await scoped.harness.mockMouse.click(x + 1, y);
  await scoped.settle();
  expect(scoped.harness.captureCharFrame()).toContain('Background fixture');

  scoped.harness.mockInput.pressKey('r');
  await scoped.settle();
  scoped.harness.mockInput.pressKey('\u001b[B');
  await scoped.settle();
  scoped.harness.mockInput.pressKey('\r');
  await scoped.settle();
  expect(scoped.harness.captureCharFrame()).toContain('No captured work in');
  expect(scoped.harness.captureCharFrame()).toContain('empty-project');
  expect(scoped.harness.captureCharFrame()).toContain('[Show all repos]');

  rows = scoped.harness.captureCharFrame().split('\n');
  y = rows.findIndex((row) => row.includes('[Show all repos]'));
  x = rows[y]!.indexOf('[Show all repos]');
  await scoped.harness.mockMouse.click(x + 1, y);
  await scoped.settle();
  expect(scoped.harness.captureCharFrame()).toContain('Background fixture');
  scoped.harness.renderer.destroy();
});
