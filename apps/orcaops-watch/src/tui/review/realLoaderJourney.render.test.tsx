import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildReviewFloorFixture, slugifyBranch } from '@orcaops/review-core';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import { loadReview } from '../../data/reviewSource';

const roots: string[] = [];
const PANE_SIDECAR = `
import { readFileSync } from 'node:fs';
import path from 'node:path';
const root = process.env.ORCAOPS_ROOT;
const branch = process.argv[process.argv.indexOf('--branch') + 1];
const dir = path.join(root, '.orcaops', 'reviews', branch);
let floor = null;
try {
  floor = JSON.parse(readFileSync(path.join(dir, 'floor.json'), 'utf8'));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, code: 'REVIEW_NOT_FOUND' }) + '\\n');
  process.exit(1);
}
let diff = '';
try {
  diff = readFileSync(path.join(dir, 'diff.patch'), 'utf8');
} catch {}
const generations = {
  floor: 'floor:' + diff.length,
  story: null,
  storyInstallation: null,
  storyAnchors: null,
  comments: '0:0',
  workflow: '0',
};
const routineStory = {
  model: null,
  status: 'absent',
  issue: null,
  runId: null,
  generation: null,
  anchors: { model: null, status: 'absent', issue: null, generation: null },
};
if (process.argv.includes('--generations-only')) {
  process.stdout.write(JSON.stringify({ ok: true, generations }) + '\\n');
} else {
  process.stdout.write(
    JSON.stringify({ ok: true, reviewId: 'review', floor, diff, routineStory, generations }) + '\\n'
  );
}
`;

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
  // The file-watching probe test that lived here drove the retired file-based
  // installed-review seam: it wrote floor.json/diff.patch/narrative.json into the
  // review directory and let FsWatch + loadInstalledReview refresh the TUI off
  // those files. The canonical loader reads the retained store through the
  // sidecar, not the review directory, so that seam is gone. Its two assertions
  // survive elsewhere: a legacy narrative never reaching the TUI is inherent (the
  // pane never reads it), and an empty diff yielding COVERAGE UNAVAILABLE is
  // reviewSource.test.ts's "reports an unusable diff instead of presenting unknown
  // rows as healthy". The giant-hunk journey below keeps the real loader-to-mount
  // seam under test through the pane sidecar.
  test('keeps a retained 25,402-row hunk navigable and mount-bounded through the real loader seam', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-watch-giant-hunk-'));
    roots.push(root);
    const live = buildRetainedHunkFixture('giant');
    const reviewDir = path.join(root, '.orcaops', 'reviews', 'giant');
    const sidecar = path.join(root, 'sidecar.mjs');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, 'floor.json'), `${JSON.stringify(live.floor)}\n`);
    await writeFile(path.join(reviewDir, 'diff.patch'), live.diffText);
    await writeFile(sidecar, PANE_SIDECAR);

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
