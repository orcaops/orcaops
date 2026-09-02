// The task pane's polish contract: header hierarchy, honest empty states, and
// the defined narrow-width collapse orders — pinned at one narrow and one wide
// mount per state so the acceptance criteria stay checkable.

import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { expect, test } from 'bun:test';

import type { WatchTask } from '../../core/types';
import type { WatchThread } from '../../data/types';
import { ThemeProvider } from '../ThemeProvider';
import { TaskDetailPane } from '../components/TaskDetailPane';
import { buildTaskDetail } from '../detail';

const NOW = 1_753_000_000_000;

function thread(index: number): WatchThread {
  return {
    artifactId: `fixture-artifact-${index}`,
    artifactStatus: 'active',
    source: 'hot',
    branch: 'feat/task-pane-polish',
    title: `Member ${index + 1} title long enough to need an ellipsis at narrow widths`,
    agent: 'claude-code',
    sessions: [{ agent: 'claude-code', session_id: `s-${index}`, tokens: 12_000 }],
    openCheckpoints: 1,
    openComments: index === 0 ? 2 : 0,
    isCurrentCheckout: index === 0,
    currentLine: `Current checkpoint summary for member ${index + 1}`,
    steps: { completed: index + 2, total: 9 },
    lastWriteMs: NOW - index * 1_000,
    lastClosed: null,
    state: 'working',
    sparkline: [0, 1, 2],
    planSteps: [],
    checkpoints: [],
  } as unknown as WatchThread;
}

function task(threads: WatchThread[]): WatchTask {
  return {
    id: 'task:fixture:feat/task-pane-polish',
    title: 'feat/task-pane-polish',
    projectId: 'fixture',
    project: 'fixture-project',
    branch: 'feat/task-pane-polish',
    state: 'working',
    threads,
  };
}

async function mountPane(input: { width: number; height?: number; threads: WatchThread[] }) {
  const harness = await createTestRenderer({
    width: input.width,
    height: input.height ?? 30,
    kittyKeyboard: true,
  });
  const subject = task(input.threads);
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <box width={input.width} height={input.height ?? 30} flexDirection="column">
        <TaskDetailPane
          task={subject}
          model={buildTaskDetail(subject)}
          width={input.width}
          nowMs={NOW}
          focused={true}
          scrollRef={{ current: null }}
          selectedRef={null}
          reviewable={true}
          onMemberActivate={() => {}}
          onReview={() => {}}
        />
      </box>
    </ThemeProvider>
  );
  for (let pass = 0; pass < 3; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
  }
  return harness;
}

test('a populated pane keeps hierarchy and full metrics at a wide width', async () => {
  const harness = await mountPane({ width: 100, threads: [thread(0), thread(1), thread(2)] });
  const frame = harness.captureCharFrame();
  expect(frame).toContain('TASK');
  expect(frame).toContain('fixture-project/feat/task-pane-polish');
  expect(frame).toContain('3 threads');
  // Capture meta shows only the segments that exist, verbose at this width.
  expect(frame).toContain('3 sessions');
  expect(frame).toContain('session tokens');
  expect(frame).toContain('✎ 2 open');
  expect(frame).toContain('Review branch');
  // Member metrics keep the verbose spelling and the open-checkpoint suffix.
  expect(frame).toContain('steps · 1cp/1 open');
  expect(frame).toContain('THREADS · 3');
  harness.renderer.destroy();
});

test('a narrow pane collapses metrics in the documented order and never overflows', async () => {
  const harness = await mountPane({ width: 44, threads: [thread(0), thread(1)] });
  const frame = harness.captureCharFrame();
  // Compact review label, compact member metrics: no verbose "steps ·" form,
  // no open-checkpoint suffix at this width — but the counts survive.
  expect(frame).toContain('Review  v');
  expect(frame).not.toContain('steps · 1cp/1 open');
  expect(frame).toContain('cp');
  for (const row of frame.split('\n')) {
    expect(row.length).toBeLessThanOrEqual(44);
  }
  harness.renderer.destroy();
});

test('zero threads reads as an explicit empty state, not a bare list', async () => {
  const harness = await mountPane({ width: 100, threads: [] });
  const frame = harness.captureCharFrame();
  expect(frame).toContain('No threads captured for this task yet');
  // With no sessions, tokens, or checkpoints the capture-meta line disappears
  // instead of rendering zero-noise.
  expect(frame).not.toContain('0 sessions');
  expect(frame).not.toContain('0 checkpoints');
  harness.renderer.destroy();
});
