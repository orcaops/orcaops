import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { expect, test } from 'bun:test';

import { ThemeProvider } from '../ThemeProvider';
import { KeyHints, selectKeyHintsLayout } from '../components/KeyHints';

const REQUIRED_COPY = ['↑↓ select', '↵ open', 'v review', '? help', 'Tab pane', 'q quit'];

for (const width of [80, 110, 160]) {
  test(`Watch key hints stay complete and non-clipping at ${width} columns`, async () => {
    const layout = selectKeyHintsLayout({
      width,
      notify: true,
      root: '~/.orcaops',
      projectCount: 7,
      reviewable: true,
    });
    expect(layout.occupiedWidth).toBeLessThanOrEqual(width);

    const harness = await createTestRenderer({ width, height: 2 });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <box width={width} height={1}>
          <KeyHints
            width={width}
            notify={true}
            root="~/.orcaops"
            projectCount={7}
            reviewable={true}
            pane="rail"
            detailMode="overview"
          />
        </box>
      </ThemeProvider>
    );
    for (let pass = 0; pass < 3; pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await harness.renderOnce();
    }

    const row = harness.captureCharFrame().split('\n')[0] ?? '';
    for (const copy of REQUIRED_COPY) expect(row).toContain(copy);
    expect(row).toContain(layout.context);
    expect(row.trimEnd().endsWith(layout.context)).toBe(true);

    if (width === 80) {
      expect(row).not.toContain('/ filter');
      expect(layout.context).toBe('.orcaops · 7p');
    } else if (width === 110) {
      expect(row).toContain('/ filter');
      expect(row).toContain('r repo');
      expect(row).not.toContain('g group');
    } else {
      expect(row).toContain('/ cycle status filter');
      expect(row).not.toContain('g group');
      expect(row).toContain('w group');
      expect(row).toContain('r choose repository');
      // `w group` joined the footer, so the notifications label compacts.
      expect(row).toContain('n notify on');
    }

    harness.renderer.destroy();
  });
}

test('disabled Review remains discoverable without borrowing active styling', () => {
  const layout = selectKeyHintsLayout({
    width: 80,
    notify: false,
    root: '~/.orcaops',
    projectCount: 1,
    reviewable: false,
  });
  expect(layout.hints.find((hint) => hint.id === 'open-review')).toMatchObject({
    key: 'v',
    label: 'review',
    enabled: false,
  });
});

test('footer hits execute their registered command only after a complete click', async () => {
  const invoked: string[] = [];
  const harness = await createTestRenderer({ width: 110, height: 2 });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <KeyHints
        width={110}
        notify={false}
        root="~/.orcaops"
        projectCount={2}
        reviewable={false}
        pane="rail"
        detailMode="overview"
        onCommand={(id) => invoked.push(id)}
      />
    </ThemeProvider>
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await harness.renderOnce();
  const row = harness.captureCharFrame().split('\n')[0] ?? '';
  const helpX = row.indexOf('? help');
  const reviewX = row.indexOf('v review');

  await harness.mockMouse.pressDown(helpX + 1, 0);
  expect(invoked).toEqual([]);
  await harness.mockMouse.release(helpX + 1, 0);
  expect(invoked).toEqual(['help']);
  await harness.mockMouse.click(reviewX + 1, 0);
  expect(invoked).toEqual(['help']);

  harness.renderer.destroy();
});

test('long data roots yield to required commands at the minimum width', () => {
  const layout = selectKeyHintsLayout({
    width: 80,
    notify: false,
    root: '~/an-intentionally-long-data-root-name-that-cannot-fit',
    projectCount: 123,
    reviewable: true,
  });
  expect(layout.occupiedWidth).toBeLessThanOrEqual(80);
  expect(layout.context).toContain('· 123p');
  expect(layout.hints.filter((hint) => hint.id === 'open-review')).toHaveLength(1);
});

test('grouping is advertised on w and detail footer advertises the real back command', () => {
  const layout = selectKeyHintsLayout({
    width: 160,
    notify: false,
    root: '~/.orcaops',
    projectCount: 2,
    reviewable: true,
    pane: 'detail',
    detailMode: 'checkpoint',
  });
  expect(layout.hints.find((hint) => hint.id === 'watch.cycle-grouping')).toMatchObject({
    key: 'w',
  });
  expect(layout.hints.find((hint) => hint.id === 'watch.back-detail')).toMatchObject({
    key: 'q',
    label: 'back',
  });
  expect(layout.hints.find((hint) => hint.id === 'quit')).toBeUndefined();
  expect(layout.hints.find((hint) => hint.id === 'watch.open-detail')).toBeUndefined();
});
