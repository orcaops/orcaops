import { performance } from 'node:perf_hooks';

import { SPINNER_FRAMES } from '../src/tui/components/LoadingScreen';
import { mountReviewApp } from '../tests/review/mountReviewApp';

let lastFrame: string | null = null;
let changedAt = 0;
let changedCpu = process.cpuUsage();
const samples: Array<{ wallMs: number; activeCpuMs: number }> = [];
let finish!: () => void;
const complete = new Promise<void>((resolve) => {
  finish = resolve;
});

const app = await mountReviewApp({
  scenario: 'no-narrative',
  autoLoad: true,
  startWithoutReview: true,
  reviewLoader: ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  onLoadingFrameCommitted: (frame) => {
    if (frame === lastFrame || samples.length >= SPINNER_FRAMES.length) return;
    const now = performance.now();
    const cpu = process.cpuUsage(changedCpu);
    if (lastFrame !== null) {
      samples.push({
        wallMs: now - changedAt,
        activeCpuMs: (cpu.user + cpu.system) / 1_000,
      });
      if (samples.length === SPINNER_FRAMES.length) finish();
    }
    lastFrame = frame;
    changedAt = now;
    changedCpu = process.cpuUsage();
  },
});

try {
  await Promise.race([complete, Bun.sleep(2_000)]);
} finally {
  app.unmount();
}

process.stdout.write(
  `${JSON.stringify({
    samples,
    observedFrames: samples.length,
    expectedFrames: SPINNER_FRAMES.length,
  })}\n`
);
