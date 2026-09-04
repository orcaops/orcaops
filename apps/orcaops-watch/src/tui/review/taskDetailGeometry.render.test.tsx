// GEOMETRY PROOF for the task-member reveal pitch: `taskMemberRefLine` is the
// line model `App.tsx` feeds `revealDetailLine`, so it must equal the ROW the
// rendered pane actually places each member card on. TaskDetailPane renders a
// 3-row card plus a 1-row spacer before every non-first card — a 4-row stride —
// and a model that advances 3 rows per member under-scrolls every late member
// by its index. This test MEASURES the rendered offsets and requires the model
// to match them exactly.
//
// This lives beside the review harness because the pane under test is part of
// the same TUI app that harness exercises.

import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';
import { createRef } from 'react';

import type { WatchTask, WatchThread } from '@orcaops/watch-data/ui';

import { ThemeProvider } from '../ThemeProvider';
import { TaskDetailPane } from '../components/TaskDetailPane';
import { buildTaskDetail, taskMemberRefLine } from '../detail';

interface RenderNode {
  id?: string;
  y?: number;
  height?: number;
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

function thread(id: string, lastWriteMs: number): WatchThread {
  return {
    artifactId: id,
    artifactStatus: 'active',
    source: 'hot',
    branch: 'feature/demo-detail',
    title: `Thread ${id}`,
    agent: 'codex',
    sessions: [{ agent: 'codex', session_id: `session-${id}`, tokens: 12_345 }],
    openCheckpoints: 0,
    openComments: 0,
    isCurrentCheckout: false,
    currentLine: 'Refine the task to thread journey',
    steps: { completed: 1, total: 3 },
    lastWriteMs,
    lastClosed: null,
    state: 'working',
    sparkline: [0, 1, 3],
    planSteps: [],
    checkpoints: [],
    startedAtMs: 0,
    planDecisions: [],
    nonGoals: [],
    recentEvents: [],
  };
}

describe('task member reveal geometry', () => {
  test('taskMemberRefLine matches the rendered row of every member card', async () => {
    const memberCount = 6;
    const task: WatchTask = {
      id: 'task:orcaops:feature/demo-detail',
      title: 'feature/demo-detail',
      projectId: 'orcaops',
      project: 'orcaops',
      branch: 'feature/demo-detail',
      state: 'working',
      // Descending lastWriteMs pins the member order to t0..t5.
      threads: Array.from({ length: memberCount }, (_, at) =>
        thread(`t${String(at)}`, 10_000 - at * 1_000)
      ),
    };
    const model = buildTaskDetail(task);
    expect(model.members).toHaveLength(memberCount);

    const harness = await createTestRenderer({ width: 100, height: 48 });
    const root = createRoot(harness.renderer);
    root.render(
      <ThemeProvider detectedThemeMode={undefined}>
        <TaskDetailPane
          task={task}
          model={model}
          width={100}
          nowMs={20_000}
          focused
          scrollRef={createRef()}
          selectedRef={model.members[0]!.id}
          reviewable={false}
          onMemberActivate={() => undefined}
          onReview={() => undefined}
        />
      </ThemeProvider>
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await harness.renderOnce();

    // Content line 1 is where the first card sits (line 0 is the THREADS
    // header), so each card's content line is 1 + its rendered offset from
    // card 0 — no dependence on the scrollbox's absolute origin.
    const cardY = (memberId: string): number => {
      const node = findNode(harness.renderer.root, `watch-task-member:${memberId}`);
      if (node?.y === undefined) throw new Error(`card not found or unmeasured: ${memberId}`);
      return node.y;
    };
    const firstY = cardY(model.members[0]!.id);
    for (const [at, member] of model.members.entries()) {
      const renderedLine = 1 + (cardY(member.id) - firstY);
      expect(
        { member: member.id, index: at, line: taskMemberRefLine(model, member.id) },
        `member ${member.id} at index ${String(at)}`
      ).toEqual({ member: member.id, index: at, line: renderedLine });
    }

    root.unmount();
  });
});
