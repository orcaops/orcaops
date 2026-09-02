import { performance } from 'node:perf_hooks';

import { mountReviewApp } from '../tests/review/mountReviewApp';
import {
  buildReviewAppHarness,
  loadedReviewWithStoryFixture,
} from '../tests/review/reviewAppHarness';
import {
  buildProductionStoryReviewHarnessFixture,
  storyOverlay,
} from '../tests/review/storyReviewHarness';

const width = Number(process.argv[2]);
if (!Number.isInteger(width) || width <= 0) {
  throw new Error(`expected a positive terminal width, received ${process.argv[2] ?? '<missing>'}`);
}
const sampleCount = Number(process.argv[3] ?? 1);
if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
  throw new Error(`expected a positive sample count, received ${process.argv[3] ?? '<missing>'}`);
}

const fixture = buildProductionStoryReviewHarnessFixture();
const base = await buildReviewAppHarness({ scenario: 'no-narrative' });
const routineStory = await storyOverlay(fixture.model, {
  runId: '77777777-7777-7777-8777-777777777777',
  installationToken: 'story-performance-installation',
});
const loaded = await loadedReviewWithStoryFixture({
  base: base.loaded,
  floor: fixture.floor,
  reviewDiff: fixture.reviewDiff,
  routineStory,
});

// Watch and React are already running when the user enters Review. Keep this
// untimed root live while measuring the fresh immutable-generation mount: it
// warms the real code path without manufacturing detached renderer garbage.
const warm = await mountReviewApp({
  scenario: 'no-narrative',
  width,
  height: 40,
  initialLoadedOverride: loaded,
});
warm.frame();

const samples = [];
for (let index = 0; index < sampleCount; index += 1) {
  const startedCpu = process.cpuUsage();
  const started = performance.now();
  const app = await mountReviewApp({
    scenario: 'no-narrative',
    width,
    height: 40,
    initialLoadedOverride: loaded,
  });
  const latencyMs = performance.now() - started;
  const elapsedCpu = process.cpuUsage(startedCpu);
  const frame = app.frame();
  samples.push({
    latencyMs,
    activeCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1_000,
    useful:
      // The two-pane Brief: the Story's banner in the overview, the tree pane's
      // STORY header with its first Act, and no leaked source paths.
      frame.includes('Production-scale Story fixture') &&
      frame.includes('STORY') &&
      frame.includes('ACT 1 ·') &&
      !frame.includes('src/scale-part-'),
    mountedNodes: app.mountedNodeCount(),
  });
  app.unmount();
  await Bun.sleep(0);
}
warm.unmount();

process.stdout.write(`${JSON.stringify({ samples })}\n`);
