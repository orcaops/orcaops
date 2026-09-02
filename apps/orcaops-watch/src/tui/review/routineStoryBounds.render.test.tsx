import { afterAll, expect, test } from 'bun:test';

import { type MountedReviewApp, mountReviewApp } from '../../../tests/review/mountReviewApp';
import {
  buildReviewAppHarness,
  loadedReviewWithStoryFixture,
} from '../../../tests/review/reviewAppHarness';
import {
  buildProductionStoryReviewHarnessFixture,
  storyOverlay,
} from '../../../tests/review/storyReviewHarness';

const STORY_MOUNTED_NODE_CAP = 1_000;

let productionAppPromise: Promise<MountedReviewApp> | null = null;

function productionApp(): Promise<MountedReviewApp> {
  productionAppPromise ??= (async () => {
    const base = await buildReviewAppHarness({ scenario: 'no-narrative' });
    const fixture = buildProductionStoryReviewHarnessFixture();
    const routineStory = await storyOverlay(fixture.model, {
      runId: 'production-scale-run',
      installationToken: 'production-scale-installation',
    });
    const loaded = await loadedReviewWithStoryFixture({
      base: base.loaded,
      floor: fixture.floor,
      reviewDiff: fixture.reviewDiff,
      routineStory,
    });
    return mountReviewApp({
      scenario: 'no-narrative',
      width: 110,
      height: 40,
      initialLoadedOverride: loaded,
    });
  })();
  return productionAppPromise;
}

afterAll(async () => {
  if (productionAppPromise !== null) {
    (await productionAppPromise).unmount();
  }
});

test('the production-scale Story opens on its mount-bounded Brief', async () => {
  const app = await productionApp();
  expect(app.frame()).toContain('Production-scale Story fixture');
  expect(app.frame()).toContain('STORY');
  expect(app.frame()).toContain('ACT 1 ·');
  expect(app.frame()).not.toContain('src/production/');
  expect(app.mountedNodeCount()).toBeLessThanOrEqual(STORY_MOUNTED_NODE_CAP);
}, 60_000);
