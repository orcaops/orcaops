// The STORY STALE banner belongs to the Brief. Rendered in the warning region
// ABOVE the per-screen body switch, it costs a reviewer walking checkpoints three
// rows of "regenerate the Story" on every screen — screens that cannot act on it.
// These tests pin the scope: full banner on the Brief, nothing anywhere else
// while the deterministic lens is active.

import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';

const STALE_STORY = {
  model: null,
  status: 'stale' as const,
  issue: 'Story was generated against a different floor',
  runId: 'run-fixture',
  generation: null,
  installationToken: null,
  anchors: { model: null, status: 'absent' as const, issue: null, generation: null },
};

describe('stale-story warning scope', () => {
  test('the Brief carries the full STORY STALE banner', async () => {
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'brief',
      width: 160,
      routineStory: STALE_STORY,
    });

    const frame = app.frame();
    expect(frame).toContain('STORY STALE');
    expect(frame).toContain('Story was generated against a different floor');
    app.unmount();
  });

  test('the checkpoint screen does not', async () => {
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'floor-diff',
      width: 160,
      routineStory: STALE_STORY,
    });

    expect(app.frame()).not.toContain('STORY STALE');
    app.unmount();
  });

  test('unhealthy anchors stay a Brief concern too', async () => {
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'floor-diff',
      width: 160,
      routineStory: {
        ...STALE_STORY,
        anchors: {
          model: null,
          status: 'stale' as const,
          issue: 'anchors were generated against a different floor',
          generation: null,
        },
      },
    });

    expect(app.frame()).not.toContain('ANCHORED CONTEXT');
    app.unmount();
  });
});
