import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildReviewFloorFixture, slugifyBranch } from '@orcaops/review-core';
import { FsWatch } from '@orcaops/watch-data';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import { loadInstalledReview, loadReview, readReviewGenerations } from '../../data/reviewSource';
import { readWorktreeProbe } from '../../data/staleness';

const roots: string[] = [];
const diff = [
  'diff --git a/src/fixture.ts b/src/fixture.ts',
  '--- a/src/fixture.ts',
  '+++ b/src/fixture.ts',
  '@@ -1,0 +1 @@',
  '+stable fixture row',
  '',
].join('\n');

function buildRetainedHunkFixture(branch: string, changedRows = 25_402) {
  const floor = structuredClone(buildReviewFloorFixture('clean').floor);
  floor.scope.branch = branch;
  floor.scope.branch_slug = slugifyBranch(branch);
  const diffText = [
    'diff --git a/src/fixture.ts b/src/fixture.ts',
    '--- a/src/fixture.ts',
    '+++ b/src/fixture.ts',
    `@@ -1,0 +1,${changedRows} @@`,
    ...Array.from(
      { length: changedRows },
      (_, index) => `+export const retained_${index + 1} = ${index + 1};`
    ),
    '',
  ].join('\n');
  const item = floor.coverage.items[0]!;
  const unit = item.units[0]!;
  if (unit.kind !== 'owned_slice') throw new Error('fixture expected one owned slice');
  item.added_lines = changedRows;
  item.new_start = 1;
  unit.patch_row_end = changedRows - 1;
  unit.add_range = { start: 1, end: changedRows };
  unit.lines = changedRows;
  floor.coverage.summary.matched_rows = changedRows;
  floor.coverage.summary.reviewable_rows = changedRows;
  return { floor, diffText };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('real loader to mounted ReviewApp', () => {
  test('real filesystem events keep an installed legacy narrative off the TUI', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-watch-loader-'));
    roots.push(root);
    const live = buildReviewFloorFixture('clean');
    live.floor.scope.branch = 'probe';
    live.floor.scope.branch_slug = 'probe';
    const reviewDir = path.join(root, '.orcaops', 'reviews', 'probe');
    const sidecar = path.join(root, 'sidecar.mjs');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, 'floor.json'), `${JSON.stringify(live.floor)}\n`);
    await writeFile(path.join(reviewDir, 'diff.patch'), diff);
    // This is deliberately a one-shot sidecar stub, not a real producer process.
    // The test's production seams are loadReview, real installed files, FsWatch,
    // the live-generation refresh coordinator, and the mounted ReviewApp.
    await writeFile(sidecar, 'process.exitCode = 0;\n');

    const reviewLoader = () => loadReview({ root, branch: 'probe', sidecarPath: sidecar });
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      root,
      autoLoad: true,
      reviewLoader,
      installedReviewLoader: loadInstalledReview,
      reviewGenerationLoader: readReviewGenerations,
      worktreeProbeLoader: readWorktreeProbe,
      liveRefreshThrottleMs: 0,
    });
    await app.settleUntil((frame) => frame.includes('CAPTURED WORK'));
    expect(app.frame()).toContain('CAPTURED WORK');

    const watcher = new FsWatch({
      roots: [reviewDir],
      debounceMs: 10,
      onTick: () => {
        void app.liveRefresh();
      },
    });
    expect(watcher.start()).toBe(true);
    try {
      await writeFile(path.join(reviewDir, 'narrative.json'), '{retired publication bytes');
      await app.settle();
      expect(app.frame()).toContain('CAPTURED WORK');
      expect(app.frame()).not.toContain('Preserve deterministic review truth');

      await writeFile(path.join(reviewDir, 'diff.patch'), '');
      await app.settleUntil((frame) => frame.includes('COVERAGE UNAVAILABLE'));
      expect(app.frame()).toContain('COVERAGE UNAVAILABLE');
      expect(app.frame()).toContain('no retained parent hunk in diff.patch');
    } finally {
      watcher.close();
      app.unmount();
    }
  });

  test('keeps a retained 25,402-row hunk navigable and mount-bounded through the real loader seam', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-watch-giant-hunk-'));
    roots.push(root);
    const live = buildRetainedHunkFixture('giant');
    const reviewDir = path.join(root, '.orcaops', 'reviews', 'giant');
    const sidecar = path.join(root, 'sidecar.mjs');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, 'floor.json'), `${JSON.stringify(live.floor)}\n`);
    await writeFile(path.join(reviewDir, 'diff.patch'), live.diffText);
    await writeFile(sidecar, 'process.exitCode = 0;\n');

    const app = await mountReviewApp({
      scenario: 'no-narrative',
      root,
      autoLoad: true,
      reviewLoader: () => loadReview({ root, branch: 'giant', sidecarPath: sidecar }),
      width: 160,
    });
    try {
      await app.settleUntil((frame) => frame.includes('CAPTURED WORK'));
      expect(app.frame()).toContain('CAPTURED WORK');
      await app.press('return');
      expect(app.scrollBounds().content).toBeGreaterThan(25_000);
      expect(app.diffNodeCount()).toBeLessThan(500);
      await app.press('G');
      const bottom = app.scrollBounds();
      expect(bottom.top).toBe(Math.max(0, bottom.content - bottom.viewport));
      // A deep jump deliberately widens the mount band for 160 ms, but the
      // viewport/layout-priced working set remains inside the product cap.
      expect(app.diffNodeCount()).toBeLessThan(1_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 180));
      await app.settle();
      expect(app.diffNodeCount()).toBeLessThan(500);
      await app.press('g');
      expect(app.scrollBounds().top).toBe(0);
    } finally {
      app.unmount();
    }
  }, 30_000);
});
