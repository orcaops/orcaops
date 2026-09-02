import {
  measureStoryInteraction,
  type StoryInteractionMeasurement,
} from './review-story-interaction-measure';
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
// Fixture construction clones production-shaped floor and Story inputs that a
// running Watch process would already own. Collect that setup garbage before
// mounting so the steady-state interaction measurement does not inherit the
// test generator's heap pressure.
Bun.gc(true);
await Bun.sleep(25);
const measurement: StoryInteractionMeasurement = await measureStoryInteraction({
  width,
  fixture,
  loaded,
});

process.stdout.write(`${JSON.stringify(measurement)}\n`);
