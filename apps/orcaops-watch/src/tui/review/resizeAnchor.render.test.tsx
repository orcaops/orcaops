import { describe, expect, test } from 'bun:test';

import { deferMountedDiffHighlightsForInteraction } from '@orcaops/diff-render';

import { RAPID_SCROLL_OVERSCAN_IDLE_MS } from './hunkMounting';
import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import { tallHarnessDiff } from '../../../tests/review/reviewAppHarness';

function firstVisibleTallRow(frame: string): number | null {
  const match = /tall fixture row (\d+)/.exec(frame);
  return match === null ? null : Number(match[1]);
}

function visibleTallRows(frame: string): number[] {
  return Array.from(frame.matchAll(/tall fixture row (\d+)/g), (match) => Number(match[1]));
}

function deeplyWrappedTallDiff(rows: number): string {
  return tallHarnessDiff(rows).replace(
    /^\+tall fixture row (\d+).*$/gm,
    (_line, ordinal: string) => `+tall fixture row ${ordinal} ${`deep-row-${ordinal}-`.repeat(40)}`
  );
}

function firstVisibleDeepMarker(frame: string): number | null {
  const match = /deep-row-(\d+)-/.exec(frame);
  return match === null ? null : Number(match[1]);
}

async function waitForAnchorRetries(
  app: Awaited<ReturnType<typeof mountReviewApp>>
): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await app.settle();
}

async function waitForRapidScrollHaloToRetire(
  app: Awaited<ReturnType<typeof mountReviewApp>>
): Promise<void> {
  // Keep syntax behind its interaction quiet window while the independent
  // 160ms row halo expires. Otherwise this geometry regression accidentally
  // benchmarks Shiki over a deliberately enormous wrapped fixture.
  for (let elapsed = 0; elapsed <= RAPID_SCROLL_OVERSCAN_IDLE_MS; elapsed += 40) {
    deferMountedDiffHighlightsForInteraction();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
  deferMountedDiffHighlightsForInteraction();
  await app.settle();
}

describe('terminal resize preserves semantic diff position', () => {
  test('explicit split/stack and hunk-header changes retain the source row', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 16,
      reviewDiff: tallHarnessDiff(80),
      controllerState: { diffLayout: 'split' },
    });
    await app.pressAll(['f', 'f', 'f', 'f', 'f']);
    const sourceRow = firstVisibleTallRow(app.frame());
    expect(sourceRow).not.toBeNull();

    for (const key of ['2', 'M', 'M', '1']) {
      await app.press(key);
      await waitForAnchorRetries(app);
      expect(firstVisibleTallRow(app.frame())).toBe(sourceRow);
    }
    app.unmount();
  });

  test('width and responsive layout changes retain the source row at viewport top', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 110,
      height: 16,
      reviewDiff: tallHarnessDiff(80),
      controllerState: { wrapLines: true },
    });
    await app.pressAll(['f', 'f', 'f', 'f', 'f']);
    const sourceRow = firstVisibleTallRow(app.frame());
    expect(sourceRow).not.toBeNull();

    await app.resize(80, 16);
    await waitForAnchorRetries(app);
    expect(app.surface('review-diff-scroll').width).toBeLessThan(88);
    expect(firstVisibleTallRow(app.frame())).toBe(sourceRow);

    await app.resize(160, 16);
    await waitForAnchorRetries(app);
    expect(app.surface('review-diff-scroll').width).toBeGreaterThan(88);
    expect(firstVisibleTallRow(app.frame())).toBe(sourceRow);
    app.unmount();
  });

  test('a deep wrapped resize paints its semantic destination on the first frame', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 16,
      reviewDiff: deeplyWrappedTallDiff(240),
      controllerState: { wrapLines: true, diffLayout: 'split' },
    });
    await app.pressAll(Array.from({ length: 18 }, () => 'f'));
    await waitForRapidScrollHaloToRetire(app);
    const sourceMarker = firstVisibleDeepMarker(app.frame());
    const nodesBeforeResize = app.diffNodeCount();
    // Responsive split/stack chrome can legitimately change the small fixed
    // host-node cost. Semantic restoration must not allocate the old ~3x
    // rapid-scroll halo around a destination CheckpointDiff already mounted.
    const resizeNodeBudget = Math.ceil(nodesBeforeResize * 1.5);
    expect(sourceMarker).not.toBeNull();

    // Every preceding row changes height here, so the old numeric scrollTop is
    // far outside the new semantic mount window. The committed resize frame must
    // move the native viewport with that window instead of exposing its spacers.
    await app.resizeOneFrame(80, 16);
    expect(firstVisibleDeepMarker(app.frame())).toBe(sourceMarker);
    expect(app.diffNodeCount()).toBeLessThanOrEqual(resizeNodeBudget);

    await waitForAnchorRetries(app);
    expect(firstVisibleDeepMarker(app.frame())).toBe(sourceMarker);
    expect(app.diffNodeCount()).toBeLessThanOrEqual(resizeNodeBudget);
    app.unmount();
  }, 10_000);

  test('height growth at EOF keeps the last source row visible without a blank frame', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 110,
      height: 12,
      reviewDiff: tallHarnessDiff(80),
    });
    await app.press('G');
    expect(app.frame()).toContain('tall fixture row 79');

    await app.resizeOneFrame(110, 24);
    const immediateBounds = app.scrollBounds();
    expect(app.frame()).toContain('tall fixture row 79');
    expect(firstVisibleTallRow(app.frame())).not.toBeNull();
    expect(immediateBounds.top).toBe(
      Math.max(0, immediateBounds.content - immediateBounds.viewport)
    );
    await waitForAnchorRetries(app);

    const bounds = app.scrollBounds();
    expect(app.frame()).toContain('tall fixture row 79');
    expect(firstVisibleTallRow(app.frame())).not.toBeNull();
    expect(bounds.top).toBe(Math.max(0, bounds.content - bounds.viewport));
    app.unmount();
  });

  test('height growth mid-stream paints the newly exposed source rows on the first frame', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 110,
      height: 12,
      reviewDiff: tallHarnessDiff(240),
    });
    await app.pressAll(['f', 'f', 'f', 'f', 'f']);
    // Let the rapid-scroll rescue halo retire. The resize frame must be complete
    // because it planned against the new terminal, not because stale key input
    // happened to leave a larger-than-normal row window mounted nearby.
    await waitForRapidScrollHaloToRetire(app);
    const sourceRow = firstVisibleTallRow(app.frame());
    const before = visibleTallRows(app.frame());
    expect(sourceRow).not.toBeNull();
    expect(before.length).toBeGreaterThan(0);

    await app.resizeOneFrame(110, 80);
    const immediate = visibleTallRows(app.frame());
    expect(firstVisibleTallRow(app.frame())).toBe(sourceRow);
    expect(immediate.length).toBeGreaterThan(before.length);
    expect(immediate.length).toBeGreaterThanOrEqual(app.surface('review-diff-scroll').height - 8);

    await waitForAnchorRetries(app);
    expect(firstVisibleTallRow(app.frame())).toBe(sourceRow);
    expect(visibleTallRows(app.frame())).toEqual(immediate);
    app.unmount();
  });
});
