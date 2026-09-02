import type { ScrollBoxRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { expect, test } from 'bun:test';

import type { SnapshotSource } from '../../data/snapshot';
import type { WatchSnapshot, WatchThread } from '../../data/types';
import { App } from '../App';
import { ThemeProvider } from '../ThemeProvider';

const NOW = Date.now();

interface RenderNode {
  id?: string;
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

function richThread(index: number): WatchThread {
  return {
    artifactId: `demo-artifact-${index}`,
    artifactStatus: 'active',
    source: index % 2 === 0 ? 'hot' : 'archive',
    branch: 'feature/demo-watch-detail',
    title:
      index === 0
        ? 'Premium artifact detail fixture with a deliberately long but readable title'
        : `Member ${index + 1} retained after task drill in`,
    agent: index % 2 === 0 ? 'codex' : 'claude-code',
    sessions: [
      {
        agent: index % 2 === 0 ? 'codex' : 'claude-code',
        session_id: `demo-session-${index}`,
        tokens: 10_000 + index,
      },
    ],
    openCheckpoints: index === 0 ? 0 : 1,
    openComments: index === 0 ? 2 : 0,
    isCurrentCheckout: true,
    currentLine: `Current work for member ${index + 1} remains visible and width safe`,
    steps: { completed: index + 1, total: 12 },
    lastWriteMs: NOW - index * 1_000,
    lastClosed: null,
    state: index < 5 ? 'working' : index < 7 ? 'quiet' : 'idle',
    sparkline: [0, 1, index + 1],
    planSteps:
      index === 0
        ? [
            {
              idx: 0,
              text: 'Preserve every captured artifact semantic while refining presentation',
              label: 'Preserve captured semantics',
              done: true,
              current: false,
            },
            {
              idx: 1,
              text: 'Make the task member journey predictable for keyboard and pointer users',
              label: 'Refine task member journey',
              done: false,
              current: true,
            },
          ]
        : [],
    checkpoints:
      index === 0
        ? [
            {
              n: 3,
              status: 'closed',
              summary: 'Validated presentation-only changes',
              uncertainties: [
                'Whether every supported terminal publishes viewport height immediately',
              ],
              decisions: [
                {
                  decision: 'Keep stable view identifiers',
                  reason: 'Polling can reorder rows.',
                  alternatives: [
                    { option: 'Array indexes', reason: 'They retarget live selection.' },
                  ],
                },
              ],
              steps: [{ idx: 0, label: 'Preserve captured semantics' }],
              linesAdded: 0,
              linesRemoved: 0,
              filesChanged: 0,
            },
          ]
        : [],
    startedAtMs: NOW - 90_000,
    planDecisions:
      index === 0
        ? [
            {
              decision: 'Retain the Watch snapshot and capture lifecycle',
              reason: 'The quality pass is presentation-only.',
              alternatives: [
                { option: 'Replace the controller', reason: 'It would be destructive.' },
              ],
            },
          ]
        : [],
    nonGoals:
      index === 0 ? ['Do not replace storage, capture, or artifact lifecycle behavior'] : [],
    recentEvents:
      index === 0
        ? [
            {
              tsMs: NOW,
              ts: new Date(NOW).toISOString(),
              type: 'checkpoint_closed',
              project: 'demo-monorepo-project',
              branch: 'feature/demo-watch-detail',
            },
          ]
        : [],
  };
}

function snapshot(): WatchSnapshot {
  const threads = Array.from({ length: 8 }, (_, index) => richThread(index));
  return {
    generated_at: new Date(NOW).toISOString(),
    generatedAtMs: NOW,
    dataRoot: '/tmp/orcaops-demo-detail',
    archiveEnabled: true,
    totals: { activeThreads: threads.length, openCheckpoints: 7, sessionTokens: 80_028 },
    projects: [
      {
        projectId: 'demo-project',
        displayName: 'demo-monorepo-project',
        threads,
      },
    ],
    ticker: [],
  };
}

function mutableSource(initial: WatchSnapshot): {
  source: SnapshotSource;
  update: (next: WatchSnapshot) => void;
} {
  let publish: ((next: WatchSnapshot) => void) | null = null;
  return {
    source: {
      start({ onSnapshot }) {
        publish = onSnapshot;
        onSnapshot(initial);
        return () => {
          publish = null;
        };
      },
    },
    update(next) {
      publish?.(next);
    },
  };
}

async function mount(width: number, height = 34, sourceOverride?: SnapshotSource) {
  const source: SnapshotSource =
    sourceOverride ??
    ({
      start({ onSnapshot }) {
        onSnapshot(snapshot());
        return () => {};
      },
    } satisfies SnapshotSource);
  const harness = await createTestRenderer({ width, height, kittyKeyboard: true });
  const root = createRoot(harness.renderer);
  root.render(
    <ThemeProvider detectedThemeMode={undefined}>
      <App options={{ intervalMs: 2_000, snapshotSource: source }} />
    </ThemeProvider>
  );
  const settle = async () => {
    let previous = '';
    let stable = 0;
    for (let pass = 0; pass < 16; pass += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      stable = frame === previous ? stable + 1 : 0;
      if (stable >= 2) return;
      previous = frame;
    }
  };
  const press = async (key: string) => {
    const sequence =
      {
        enter: '\r',
        left: '\u001b[D',
        right: '\u001b[C',
        tab: '\t',
        pageup: '\u001b[5~',
        pagedown: '\u001b[6~',
      }[key] ?? key;
    const control = /^C-(.)$/.exec(sequence);
    if (control?.[1] !== undefined) harness.mockInput.pressKey(control[1], { ctrl: true });
    else harness.mockInput.pressKey(sequence);
    await settle();
  };
  const click = async (label: string) => {
    const rows = harness.captureCharFrame().split('\n');
    const y = rows.findIndex((row) => row.includes(label));
    expect(y, harness.captureCharFrame()).toBeGreaterThanOrEqual(0);
    const x = rows[y]!.indexOf(label);
    await harness.mockMouse.click(x + 1, y);
    await settle();
  };
  const hover = async (label: string) => {
    const rows = harness.captureCharFrame().split('\n');
    const y = rows.findIndex((row) => row.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = rows[y]!.indexOf(label);
    await harness.mockMouse.moveTo(x + 1, y);
    await settle();
  };
  await settle();
  const resize = async (nextWidth: number, nextHeight: number) => {
    harness.resize(nextWidth, nextHeight);
    await settle();
  };
  return { harness, settle, press, click, hover, resize };
}

async function enterTaskMode(app: Awaited<ReturnType<typeof mount>>) {
  await cycleGrouping(app);
  await cycleGrouping(app);
  expect(app.harness.captureCharFrame()).toContain('TASKS & THREADS');
  expect(app.harness.captureCharFrame()).toContain('THREADS · 8');
}

async function cycleGrouping(app: Awaited<ReturnType<typeof mount>>) {
  await app.click('View');
  await app.click('Change Work Group');
}

function selectedTaskMember(frame: string): { member: number; row: string } {
  const row = frame
    .split('\n')
    .find((candidate) => candidate.includes('▸') && /Member \d+ retained/.test(candidate));
  expect(row).toBeDefined();
  const match = row!.match(/Member (\d+) retained/);
  expect(match).not.toBeNull();
  return { member: Number(match![1]), row: row! };
}

test('task member q and Left each back one level while retaining the exact selection', async () => {
  const app = await mount(110, 30);
  await enterTaskMode(app);
  await app.press('tab');
  for (let index = 0; index < 6; index += 1) await app.press('j');

  let frame = app.harness.captureCharFrame();
  const selected = selectedTaskMember(frame);
  expect(selected.row).toContain('▸ ●');

  await app.press('enter');
  frame = app.harness.captureCharFrame();
  expect(frame).toContain('TASK › THREAD');
  expect(frame).toContain('‹ Task');
  expect(frame).toContain(`Member ${selected.member} retained after task drill in`);
  expect(frame).toContain('q back');
  expect(frame).not.toContain('q quit');

  await app.press('q');
  frame = app.harness.captureCharFrame();
  expect(frame).toContain('demo-monorepo-project/feature/demo-watch-detail');
  let restored = selectedTaskMember(frame);
  expect(restored.member).toBe(selected.member);
  expect(restored.row).toContain('▸ ●');

  await app.press('enter');
  expect(app.harness.captureCharFrame()).toContain('TASK › THREAD');
  await app.press('left');
  frame = app.harness.captureCharFrame();
  restored = selectedTaskMember(frame);
  expect(restored.member).toBe(selected.member);
  expect(restored.row).toContain('▸ ●');
  app.harness.renderer.destroy();
});

test('pointer hover paints only and one click opens a task member', async () => {
  const app = await mount(160);
  await enterTaskMode(app);
  await app.hover('Member 3 retained');
  const hovered = app.harness
    .captureCharFrame()
    .split('\n')
    .find((row) => row.includes('Member 3 retained'));
  expect(hovered).not.toContain('▌');
  expect(app.harness.captureCharFrame()).toContain('▸ TASKS & THREADS');
  expect(app.harness.captureCharFrame()).not.toContain('TASK › THREAD');
  await app.click('Member 3 retained');
  expect(app.harness.captureCharFrame()).toContain('TASK › THREAD');
  expect(app.harness.captureCharFrame()).toContain('Member 3 retained after task drill in');
  expect(app.harness.captureCharFrame()).toContain('‹ Task');

  await app.click('‹ Task');
  const frame = app.harness.captureCharFrame();
  expect(frame).toContain('THREADS · 8');
  expect(frame).toContain('Member 3 retained');
  expect(frame).toContain('Review branch  v');
  app.harness.renderer.destroy();
});

test('one click activates artifact disclosures and checkpoint routes', async () => {
  const disclosure = await mount(160, 42);
  expect(disclosure.harness.captureCharFrame()).not.toContain(
    'Preserve every captured artifact semantic while refining presentation'
  );
  await disclosure.hover('Preserve captured semantics');
  expect(disclosure.harness.captureCharFrame()).not.toContain(
    'Preserve every captured artifact semantic while refining presentation'
  );
  await disclosure.click('Preserve captured semantics');
  expect(disclosure.harness.captureCharFrame()).toContain(
    'Preserve every captured artifact semantic while refining presentation'
  );
  disclosure.harness.renderer.destroy();

  const checkpoint = await mount(160, 42);
  await checkpoint.click('Validated presentation-only changes');
  expect(checkpoint.harness.captureCharFrame()).toContain('ARTIFACT › CHECKPOINT 3');
  expect(checkpoint.harness.captureCharFrame()).toContain('‹ Artifact');
  checkpoint.harness.renderer.destroy();
});

test('grouping changes retain the selected artifact and Right opens the advertised detail pane', async () => {
  const app = await mount(160);
  for (let index = 0; index < 3; index += 1) await app.press('j');
  expect(app.harness.captureCharFrame()).toContain('Member 4 retained after task drill in');

  await cycleGrouping(app);
  await cycleGrouping(app);
  expect(app.harness.captureCharFrame()).toContain('TASKS & THREADS');
  await cycleGrouping(app);
  expect(app.harness.captureCharFrame()).toContain('Member 4 retained after task drill in');

  await app.press('right');
  expect(
    app.harness
      .captureCharFrame()
      .split('\n')
      .some((row) => row.includes('│ · THREADS'))
  ).toBe(true);
  app.harness.renderer.destroy();
});

test('a live revision that removes the drilled checkpoint returns to a working artifact overview', async () => {
  const live = mutableSource(snapshot());
  const app = await mount(160, 42, live.source);
  await app.press('tab');
  await app.press('j');
  await app.press('j');
  await app.press('enter');
  expect(app.harness.captureCharFrame()).toContain('ARTIFACT › CHECKPOINT 3');

  const revised = snapshot();
  revised.projects[0]!.threads[0] = {
    ...revised.projects[0]!.threads[0]!,
    checkpoints: [],
  };
  live.update(revised);
  await app.settle();
  expect(app.harness.captureCharFrame()).not.toContain('ARTIFACT › CHECKPOINT 3');
  expect(app.harness.captureCharFrame()).toContain('PLAN · 1/2 complete');

  await app.press('enter');
  expect(app.harness.captureCharFrame()).toContain(
    'Preserve every captured artifact semantic while refining presentation'
  );
  app.harness.renderer.destroy();
});

test('a live task-member reorder keeps the stable selection visible without recentering beforehand', async () => {
  const live = mutableSource(snapshot());
  const app = await mount(110, 30, live.source);
  await enterTaskMode(app);
  await app.press('tab');
  for (let index = 0; index < 6; index += 1) await app.press('j');
  const selected = selectedTaskMember(app.harness.captureCharFrame());

  const reordered = snapshot();
  const selectedIndex = selected.member - 1;
  reordered.projects[0]!.threads[selectedIndex] = {
    ...reordered.projects[0]!.threads[selectedIndex]!,
    lastWriteMs: NOW - 1_000_000,
    openCheckpoints: 1,
    state: 'stalled',
  };
  live.update(reordered);
  await app.settle();
  const frame = app.harness.captureCharFrame();
  const selectedAfterRefresh = frame
    .split('\n')
    .find((row) => row.includes(`Member ${selected.member} retained`));
  expect(selectedAfterRefresh).toContain('▸');
  app.harness.renderer.destroy();
});

test('artifact and checkpoint hierarchy expose guardrails, provenance, neutral zero-diff, and Back', async () => {
  const app = await mount(160, 42);
  await app.press('tab');
  await app.press('j');
  await app.press('j');
  await app.press('enter');
  const frame = app.harness.captureCharFrame();
  expect(frame).toContain('ARTIFACT › CHECKPOINT 3');
  expect(frame).toContain('‹ Artifact');
  expect(frame).toContain('No line delta recorded');
  expect(frame).toContain('Array indexes');
  expect(frame).toContain('RECORDED UNCERTAINTIES · 1');

  await app.press('G');
  expect(app.harness.captureCharFrame()).toContain('‹ Artifact');
  expect(app.harness.captureCharFrame()).toContain('q back');
  expect(app.harness.captureCharFrame()).not.toContain('q quit');
  await app.press('q');
  expect(app.harness.captureCharFrame()).toContain('GUARDRAILS · 1 non-goal');
  app.harness.renderer.destroy();
});

test('Watch uses live viewport paging and normalized top/bottom keys in detail', async () => {
  const app = await mount(160, 24);
  await app.press('tab');
  let detail = findNode(app.harness.renderer.root, 'watch-detail-scroll') as ScrollBoxRenderable;
  expect(detail).not.toBeNull();
  detail.scrollTop = 0;
  await app.press('pagedown');
  detail = findNode(app.harness.renderer.root, 'watch-detail-scroll') as ScrollBoxRenderable;
  const firstViewport = Math.max(1, detail.viewport.height);
  expect(detail.scrollHeight - firstViewport).toBeGreaterThan(firstViewport);
  const firstPage = detail.scrollTop;
  expect(firstPage).toBeGreaterThan(0);
  expect(firstPage).toBeLessThan(10);

  await app.press('C-u');
  detail = findNode(app.harness.renderer.root, 'watch-detail-scroll') as ScrollBoxRenderable;
  expect(detail.scrollTop).toBeLessThan(firstPage);
  await app.press('G');
  detail = findNode(app.harness.renderer.root, 'watch-detail-scroll') as ScrollBoxRenderable;
  expect(detail.scrollTop).toBe(Math.max(0, detail.scrollHeight - detail.viewport.height));
  await app.press('g');
  detail = findNode(app.harness.renderer.root, 'watch-detail-scroll') as ScrollBoxRenderable;
  expect(detail.scrollTop).toBe(0);

  await app.resize(160, 30);
  detail = findNode(app.harness.renderer.root, 'watch-detail-scroll') as ScrollBoxRenderable;
  detail.scrollTop = 0;
  await app.press('pagedown');
  detail = findNode(app.harness.renderer.root, 'watch-detail-scroll') as ScrollBoxRenderable;
  const resizedPage = detail.scrollTop;
  expect(resizedPage).toBeGreaterThan(firstPage);
  await app.press('C-d');
  detail = findNode(app.harness.renderer.root, 'watch-detail-scroll') as ScrollBoxRenderable;
  const resizedHalfPage = detail.scrollTop - resizedPage;
  expect(resizedHalfPage).toBeGreaterThan(0);
  expect(resizedHalfPage).toBeLessThan(resizedPage);
  await app.press('pageup');
  detail = findNode(app.harness.renderer.root, 'watch-detail-scroll') as ScrollBoxRenderable;
  expect(detail.scrollTop).toBeLessThan(resizedPage + resizedHalfPage);
  app.harness.renderer.destroy();
});

for (const width of [80, 110, 160, 220]) {
  test(`task detail keeps fixed rows, focus, and primary actions legible at ${width} columns`, async () => {
    const app = await mount(width, 34);
    await enterTaskMode(app);
    const rows = app.harness.captureCharFrame().split('\n');
    expect(rows.some((row) => row.includes('demo-monorepo') && row.includes('8 threads'))).toBe(
      true
    );
    expect(rows.some((row) => row.includes('Review') && row.includes('v'))).toBe(true);
    expect(rows.some((row) => row.includes('Current work for member'))).toBe(true);
    expect(rows.some((row) => row.includes('● here'))).toBe(true);
    expect(rows.every((row) => row.length <= width)).toBe(true);
    app.harness.renderer.destroy();
  });

  test(`checkpoint detail remains width-safe for open and large diffs at ${width} columns`, async () => {
    const custom = snapshot();
    custom.projects[0]!.threads[0] = {
      ...custom.projects[0]!.threads[0]!,
      openCheckpoints: 1,
      checkpoints: [
        {
          ...custom.projects[0]!.threads[0]!.checkpoints[0]!,
          linesAdded: 9_999_999,
          linesRemoved: 8_888_888,
          filesChanged: 777_777,
        },
        {
          n: 4,
          status: 'open',
          summary: null,
          uncertainties: [],
          decisions: [],
          steps: [{ idx: 1, label: 'Refine task member journey' }],
          linesAdded: null,
          linesRemoved: null,
          filesChanged: null,
        },
      ],
    };
    const source = mutableSource(custom);
    const app = await mount(width, 42, source.source);
    await app.press('tab');
    await app.press('j');
    await app.press('j');
    await app.press('enter');
    expect(app.harness.captureCharFrame()).toContain('CHECKPOINT 3');
    expect(app.harness.captureCharFrame()).toContain('+9999999');

    await app.press('left');
    await app.press('j');
    await app.press('enter');
    const frame = app.harness.captureCharFrame();
    expect(frame).toContain('CHECKPOINT 4');
    expect(frame).toContain('Diff metrics available');
    expect(frame).toContain('▸ 2. Refine task member journey');
    app.harness.renderer.destroy();
  });
}

test('a narrow terminal stacks the body: detail on top, thread rail below, no events', async () => {
  const app = await mount(100, 30);
  const frame = app.harness.captureCharFrame();
  // Live Events yield entirely in stacked mode.
  expect(frame).not.toContain('LIVE EVENTS');
  // The detail pane renders ABOVE the thread rail.
  const rows = frame.split('\n');
  // Search from the bottom: the TopBar's THREADS stat tile also matches.
  const railCapRow =
    rows.length - 1 - [...rows].reverse().findIndex((row) => row.includes('THREADS'));
  const detailRow = rows.findIndex((row) => row.includes('demo-monorepo-project/feature/'));
  expect(railCapRow).toBeGreaterThanOrEqual(0);
  expect(detailRow).toBeGreaterThanOrEqual(0);
  expect(detailRow).toBeLessThan(railCapRow);

  // Widening across the breakpoint restores the side-by-side shell and events.
  await app.resize(160, 30);
  const wide = app.harness.captureCharFrame();
  expect(wide).toContain('LIVE EVENTS');
  const wideRows = wide.split('\n');
  const wideRail = wideRows.findIndex((row, at) => row.includes('THREADS') && at > 6);
  const wideDetail = wideRows.findIndex((row) => row.includes('demo-monorepo-project/feature/'));
  expect(wideRail).toBeGreaterThanOrEqual(0);
  // Side-by-side again: the rail cap and detail share the same band of rows.
  expect(Math.abs(wideRail - wideDetail)).toBeLessThanOrEqual(2);
  app.harness.renderer.destroy();
});
