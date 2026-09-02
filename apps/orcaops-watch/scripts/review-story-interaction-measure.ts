import { performance } from 'node:perf_hooks';

import { waitForMountedDiffHighlightsIdle } from '@orcaops/diff-render';

import type { LoadedReview } from '../src/tui/review/ReviewApp';
import type { ReviewControllerState } from '../src/tui/review/readerReviewController';
import { mountReviewApp } from '../tests/review/mountReviewApp';
import type { StoryReviewHarnessFixture } from '../tests/review/storyReviewHarness';

export const STORY_NAVIGATION_SAMPLES = 20;
export const STORY_WHEEL_SAMPLES = 32;
export const STORY_WHEEL_SETUP_SAMPLES = 2;
const STORY_INTERACTION_CADENCE_MS = 16;

export interface StoryInteractionMeasurement {
  navigationCommitSamples: readonly number[];
  navigationActiveCpuSamples: readonly number[];
  wheelCommitSamples: readonly number[];
  wheelActiveCpuSamples: readonly number[];
  eventLoopStallSamples: readonly number[];
  eventLoopActiveSamples: readonly number[];
  validNavigationCommits: number;
  finalNavigationFrameValid: boolean;
  validWheelCommits: number;
  finalWheelFrameValid: boolean;
  maxMountedNodes: number;
}

async function startEventLoopStallProbe(): Promise<
  () => {
    wallGapMs: number;
    activeCpuMs: number;
  }
> {
  let running = true;
  let lastTickAt = 0;
  let lastCpu = process.cpuUsage();
  let maxGapMs = 0;
  let activeCpuAtMaxGapMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = (): void => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const wallGapMs = now - lastTickAt;
    const activeCpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1_000;
    if (wallGapMs > maxGapMs) {
      maxGapMs = wallGapMs;
      activeCpuAtMaxGapMs = activeCpuMs;
    }
    lastTickAt = now;
    lastCpu = cpu;
    if (running) timer = setTimeout(tick, 0);
  };
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      lastTickAt = performance.now();
      lastCpu = process.cpuUsage();
      timer = setTimeout(tick, 0);
      resolve();
    }, 0);
  });
  return () => {
    running = false;
    if (timer !== null) clearTimeout(timer);
    const now = performance.now();
    const cpu = process.cpuUsage();
    const wallGapMs = now - lastTickAt;
    const activeCpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1_000;
    if (wallGapMs > maxGapMs) {
      maxGapMs = wallGapMs;
      activeCpuAtMaxGapMs = activeCpuMs;
    }
    return { wallGapMs: maxGapMs, activeCpuMs: activeCpuAtMaxGapMs };
  };
}

function activeCpuSince(started: NodeJS.CpuUsage): number {
  const elapsed = process.cpuUsage(started);
  return (elapsed.user + elapsed.system) / 1_000;
}

export async function measureStoryInteraction(input: {
  width: number;
  fixture: StoryReviewHarnessFixture;
  loaded: LoadedReview;
}): Promise<StoryInteractionMeasurement> {
  const firstSegment = input.fixture.model.parts[0]!.segments[0]!;
  const wheelCommitSamples: number[] = [];
  const wheelActiveCpuSamples: number[] = [];
  const navigationCommitSamples: number[] = [];
  const navigationActiveCpuSamples: number[] = [];
  const eventLoopStallSamples: number[] = [];
  const eventLoopActiveSamples: number[] = [];
  let pendingWheelCommit: {
    readonly startedCpu: NodeJS.CpuUsage;
    readonly resolve: (sample: { latencyMs: number; scrollTop: number }) => void;
  } | null = null;
  let pendingNavigation: {
    page: number;
    startedAt: number;
    startedCpu: NodeJS.CpuUsage;
    resolve: (state: ReviewControllerState) => void;
  } | null = null;
  const app = await mountReviewApp({
    scenario: 'no-narrative',
    width: input.width,
    height: 40,
    initialLoadedOverride: { ...input.loaded },
    controllerState: {
      screen: 'walk',
      preferredLens: 'story',
      readerPage: 0,
      activeAct: 0,
      activePart: 0,
      focus: 'diff',
      diffHunkKey: firstSegment.hunkKey,
      diffSliceKey: `${firstSegment.hunkKey}:s${firstSegment.slice}`,
    },
    onDiffWheelCommitted: (sample) => {
      wheelCommitSamples.push(sample.latencyMs);
      const pending = pendingWheelCommit;
      pendingWheelCommit = null;
      if (pending !== null) {
        wheelActiveCpuSamples.push(activeCpuSince(pending.startedCpu));
        pending.resolve(sample);
      }
    },
    onControllerStateCommitted: (state) => {
      if (
        pendingNavigation !== null &&
        state.screen === 'walk' &&
        state.readerPage === pendingNavigation.page
      ) {
        const pending = pendingNavigation;
        pendingNavigation = null;
        navigationCommitSamples.push(performance.now() - pending.startedAt);
        navigationActiveCpuSamples.push(activeCpuSince(pending.startedCpu));
        pending.resolve(state);
      }
    },
  });
  let maxMountedNodes = 0;
  let validNavigationCommits = 0;
  try {
    await waitForMountedDiffHighlightsIdle();
    await app.settle();
    maxMountedNodes = Math.max(maxMountedNodes, app.mountedNodeCount());

    // Watch and React are already warm when the user enters Review. Exercise
    // every Part shape once so the steady-state samples do not price JIT work
    // or deferred setup from the synthetic fixture as an interaction stall.
    for (let warmPage = 1; warmPage < input.fixture.model.parts.length; warmPage += 1) {
      await app.pressToCommit(']');
    }
    for (let warmPage = input.fixture.model.parts.length - 1; warmPage > 0; warmPage -= 1) {
      await app.pressToCommit('[');
    }
    await waitForMountedDiffHighlightsIdle();
    await app.settle();
    await Bun.sleep(25);

    let page = 0;
    let direction: 1 | -1 = 1;
    for (let index = 0; index < STORY_NAVIGATION_SAMPLES; index += 1) {
      if (page === input.fixture.model.parts.length - 1) direction = -1;
      if (page === 0) direction = 1;
      page += direction;
      const committed = new Promise<ReviewControllerState>((resolve) => {
        pendingNavigation = {
          page,
          startedAt: performance.now(),
          startedCpu: process.cpuUsage(),
          resolve,
        };
      });
      const stopStallProbe = await startEventLoopStallProbe();
      const press = app.pressToCommit(direction === 1 ? ']' : '[');
      const committedState = await committed;
      const stall = stopStallProbe();
      eventLoopStallSamples.push(stall.wallGapMs);
      eventLoopActiveSamples.push(stall.activeCpuMs);
      await press;
      if (committedState.screen === 'walk' && committedState.readerPage === page) {
        validNavigationCommits += 1;
      }
      maxMountedNodes = Math.max(maxMountedNodes, app.mountedNodeCount());
      await Bun.sleep(STORY_INTERACTION_CADENCE_MS);
    }
    await waitForMountedDiffHighlightsIdle();
    await app.settle();
    const finalNavigationFrameValid = app.frame().includes(`Review scale Part ${page + 1}`);

    while (page > 0) {
      await app.press('[');
      page -= 1;
    }
    await waitForMountedDiffHighlightsIdle();
    await app.settle();

    const surface = app.surfaceRect('review-diff-scroll');
    const wheelX = surface.x + Math.min(8, Math.max(1, surface.width - 2));
    const wheelY = surface.y + Math.min(8, Math.max(1, surface.height - 2));
    for (let index = 0; index < STORY_WHEEL_SETUP_SAMPLES; index += 1) {
      await app.mockMouse.scroll(wheelX, wheelY, 'down', { delayMs: 0 });
      await app.settle();
    }
    wheelCommitSamples.length = 0;
    let validWheelCommits = 0;
    for (let index = 0; index < STORY_WHEEL_SAMPLES; index += 1) {
      const before = app.scrollTop();
      const committed = new Promise<{ latencyMs: number; scrollTop: number }>((resolve) => {
        pendingWheelCommit = { startedCpu: process.cpuUsage(), resolve };
      });
      const stopStallProbe = await startEventLoopStallProbe();
      const scroll = app.mockMouse.scroll(wheelX, wheelY, 'down', { delayMs: 0 });
      const sample = await committed;
      const stall = stopStallProbe();
      eventLoopStallSamples.push(stall.wallGapMs);
      eventLoopActiveSamples.push(stall.activeCpuMs);
      await scroll;
      if (sample.scrollTop > before) validWheelCommits += 1;
      maxMountedNodes = Math.max(maxMountedNodes, app.mountedNodeCount());
      await Bun.sleep(STORY_INTERACTION_CADENCE_MS);
    }
    await waitForMountedDiffHighlightsIdle();
    await app.settle();
    const finalWheelFrameValid = app.frame().includes('production row');

    if (wheelCommitSamples.length !== STORY_WHEEL_SAMPLES) {
      throw new Error(
        `Story wheel published ${wheelCommitSamples.length}/${STORY_WHEEL_SAMPLES} commits at ${input.width} columns`
      );
    }
    if (navigationCommitSamples.length !== STORY_NAVIGATION_SAMPLES) {
      throw new Error(
        `Story navigation published ${navigationCommitSamples.length}/${STORY_NAVIGATION_SAMPLES} commits at ${input.width} columns`
      );
    }
    return {
      navigationCommitSamples,
      navigationActiveCpuSamples,
      wheelCommitSamples,
      wheelActiveCpuSamples,
      eventLoopStallSamples,
      eventLoopActiveSamples,
      validNavigationCommits,
      finalNavigationFrameValid,
      validWheelCommits,
      finalWheelFrameValid,
      maxMountedNodes,
    };
  } finally {
    app.unmount();
  }
}
