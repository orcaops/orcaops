// The mode roots are KEYED. Unkeyed, the review and watch shells reconcile onto
// the SAME host box, and the reused yoga subtree carries a stale layout across
// the mode switch — so changing the theme in Review and returning to Watch lays
// the body out below the footer, off the terminal. These tests pin the round trip.

import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { expect, test } from 'bun:test';

import type { WatchSnapshot, WatchThread } from '@orcaops/watch-data/ui';

import type { SnapshotSource } from '../../data/snapshot';
import { App } from '../App';
import { ThemeProvider } from '../ThemeProvider';

const NOW = 1_753_000_000_000;

function thread(index: number): WatchThread {
  return {
    artifactId: `debug-artifact-${index}`,
    artifactStatus: 'active',
    source: 'hot',
    branch: 'feat/debug-theme',
    title: `Debug member ${index + 1}`,
    agent: 'claude-code',
    sessions: [{ agent: 'claude-code', session_id: `s-${index}`, tokens: 1_000 }],
    openCheckpoints: 0,
    openComments: 0,
    isCurrentCheckout: index === 0,
    currentLine: 'Current work',
    steps: { completed: 1, total: 2 },
    lastWriteMs: NOW,
    lastClosed: null,
    state: 'working',
    sparkline: [0, 1],
    planSteps: [],
    planDecisions: [],
    nonGoals: [],
    recentEvents: [],
    startedAtMs: NOW - 90_000,
    checkpoints: [],
  } as unknown as WatchThread;
}

function snapshot(): WatchSnapshot {
  const threads = [thread(0), thread(1)];
  return {
    generated_at: new Date(NOW).toISOString(),
    generatedAtMs: NOW,
    dataRoot: '/tmp/orcaops-debug-theme',
    archiveEnabled: false,
    totals: { activeThreads: threads.length, openCheckpoints: 0, sessionTokens: 2_000 },
    projects: [{ projectId: 'debug', displayName: 'debug-project', threads }],
    ticker: [],
  } as unknown as WatchSnapshot;
}

async function mountShell() {
  const harness = await createTestRenderer({ width: 160, height: 40, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <App
        options={{
          intervalMs: 2_000,
          snapshotSource: {
            start({ onSnapshot }) {
              onSnapshot(snapshot());
              return () => {};
            },
          } satisfies SnapshotSource,
          resolveReviewTarget: async () => ({ ok: true, root: '/tmp/orcaops-debug-review' }),
        }}
      />
    </ThemeProvider>
  );
  const settle = async () => {
    let previous = '';
    let stable = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      stable = frame === previous ? stable + 1 : 0;
      if (stable >= 2) return;
      previous = frame;
    }
  };
  const press = async (sequence: string) => {
    harness.mockInput.pressKey(sequence);
    await settle();
  };
  await settle();
  return { harness, settle, press };
}

/** The watch body must sit directly under the TopBar, not below the footer. */
function expectIntactWatchBody(frame: string): void {
  const rows = frame.split('\n');
  const railCap = rows.findIndex((row) => row.includes('▸ THREADS'));
  expect(railCap).toBeGreaterThan(0);
  expect(railCap).toBeLessThan(12);
  expect(frame).toContain('debug-project');
  expect(rows.findIndex((row) => row.includes('select'))).toBeGreaterThan(railCap);
}

test('committing a theme inside Review keeps the Watch body intact on return', async () => {
  const app = await mountShell();
  await app.press('v');
  await app.settle();
  expect(app.harness.captureCharFrame()).toContain('Review');

  await app.press('t');
  expect(app.harness.captureCharFrame()).toContain('Theme preview');
  await app.press('j');
  await app.press('\r');
  await app.settle();

  await app.press('q');
  await app.settle();
  expectIntactWatchBody(app.harness.captureCharFrame());
  app.harness.renderer.destroy();
});

test('a plain Review round trip stays intact too', async () => {
  const app = await mountShell();
  await app.press('v');
  await app.settle();
  await app.press('q');
  await app.settle();
  expectIntactWatchBody(app.harness.captureCharFrame());
  app.harness.renderer.destroy();
});
