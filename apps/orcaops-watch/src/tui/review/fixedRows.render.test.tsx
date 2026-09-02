import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { expect, test } from 'bun:test';

import { ModalFrame } from './ModalFrame';
import { selectReaderHeaderLayout } from './ReviewExperience';
import { selectStoryReviewFooterLayout } from './keymap';
import { reviewableWatchSnapshot } from '../../../tests/review/appJourneyFixture';
import { ThemeProvider } from '../ThemeProvider';
import { selectFilterBarLayout } from '../components/FilterBar';
import { selectTopBarLayout, TopBar } from '../components/TopBar';
import { selectCompactVitalStripLayout, VitalStrip } from '../components/VitalStrip';
import { statusCounts } from '../viewModel';

async function settle(harness: Awaited<ReturnType<typeof createTestRenderer>>): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  }
}

for (const width of [80, 110, 160]) {
  test(`fixed Watch rows fit mounted ${width}-column chrome`, async () => {
    const snapshot = reviewableWatchSnapshot();
    const railWidth = Math.max(34, Math.min(60, Math.floor(width * 0.34)));
    const chromeWidth = width - railWidth - 2;
    const clock = '12:34:56';
    const top = selectTopBarLayout(snapshot, clock, chromeWidth);
    const filters = selectFilterBarLayout({
      width: chromeWidth,
      counts: statusCounts(snapshot),
      filter: 'all',
      repo: 'journey-project',
      open: false,
    });
    expect(top.occupiedWidth).toBeLessThanOrEqual(chromeWidth);
    expect(filters.occupiedWidth).toBeLessThanOrEqual(chromeWidth);
    expect(top.requiredDroppedIds).toEqual([]);
    expect(filters.requiredDroppedIds).toEqual([]);

    const harness = await createTestRenderer({ width, height: 6 });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <box width={width} height={6}>
          <TopBar
            snapshot={snapshot}
            clock={clock}
            width={width}
            railWidth={railWidth}
            filter="all"
            repo="journey-project"
            repoOpen={false}
            onFilter={() => {}}
            onRepo={() => {}}
          />
        </box>
      </ThemeProvider>
    );
    await settle(harness);
    const frame = harness.captureCharFrame();
    for (const item of top.items) expect(frame).toContain(item.label);
    for (const item of filters.items) expect(frame).toContain(item.label);
    expect(frame).toContain('journey-project');
    harness.renderer.destroy();
  });
}

test('compact vitals retain token and step truth inside their panel', async () => {
  const snapshot = reviewableWatchSnapshot();
  const thread = snapshot.projects[0]!.threads.find(
    (candidate) => candidate.artifactId === 'journey-artifact'
  )!;
  const tokens = thread.sessions.reduce((total, session) => total + session.tokens, 0);
  const done = thread.planSteps.filter((step) => step.done).length;
  const layout = selectCompactVitalStripLayout({
    width: 32,
    tokens,
    done,
    total: thread.planSteps.length,
    activity: '0s ago',
  });
  expect(layout.occupiedWidth).toBeLessThanOrEqual(32);
  expect(layout.requiredDroppedIds).toEqual([]);
  expect(layout.parts.map((part) => part.id)).toEqual(expect.arrayContaining(['tokens', 'steps']));

  const harness = await createTestRenderer({ width: 34, height: 3 });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <VitalStrip thread={thread} width={34} nowMs={thread.lastWriteMs ?? 0} />
    </ThemeProvider>
  );
  await settle(harness);
  const row = harness.captureCharFrame().split('\n')[1] ?? '';
  for (const part of layout.parts) expect(row).toContain(part.label);
  harness.renderer.destroy();
});

for (const width of [80, 110, 160]) {
  test(`Review footer, reader suffix, and modal actions fit at ${width} columns`, async () => {
    const footer = selectStoryReviewFooterLayout('floor-diff', 'diff', width - 1);
    const header = selectReaderHeaderLayout({
      width,
      page: 'Checkpoint 12/28 · A deliberately long captured checkpoint label',
      slice: 'Slice 3/14',
      file: 'Cursor · packages/application/src/review/very-long-file-name.ts',
      row: 'Row 18/44',
    });
    expect(footer.occupiedWidth).toBeLessThanOrEqual(width - 1);
    expect(header.occupiedWidth).toBeLessThanOrEqual(width - 2);
    expect(footer.requiredDroppedIds).toEqual([]);
    expect(header.requiredDroppedIds).toEqual([]);

    const harness = await createTestRenderer({ width, height: 12 });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <ModalFrame
          id="fixed-row-modal"
          title="Responsive actions"
          width={width}
          height={12}
          desiredWidth={82}
          desiredHeight={18}
          actions={[
            {
              id: 'save',
              keyLabel: '^S',
              label: 'Save comment draft',
              shortLabel: 'Save',
              priority: 0,
              required: true,
              onSelect: () => {},
            },
            {
              id: 'cancel',
              keyLabel: 'Esc',
              label: 'Cancel',
              priority: 0,
              required: true,
              onSelect: () => {},
            },
          ]}
        >
          {(geometry) => <text>{`body ${geometry.bodyRows}`}</text>}
        </ModalFrame>
      </ThemeProvider>
    );
    await settle(harness);
    const frame = harness.captureCharFrame();
    expect(frame).toContain('^S');
    expect(frame).toContain('Esc');
    expect(frame).toContain('Cancel');
    harness.renderer.destroy();
  });
}
