// Pins and virtualization, against the real mounted app.
//
// "Bounded" is not a claim a frame can settle — a frame only ever shows one
// viewport's worth, so a 5,000-row hunk and a 30-row hunk look identical in it.
// These assertions therefore read the live renderable: how many nodes actually
// mounted, and how tall the scroll content actually is. Both are effects a user
// feels (a stalled frame; a scrollbar that lies), and neither can be faked by a
// component that merely intends to virtualize.

import { describe, expect, test } from 'bun:test';

import type { ReanchoredPosition } from '@orcaops/review-core';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import { tallHarnessDiff } from '../../../tests/review/reviewAppHarness';
import type { EnrichedComment } from '../../data/commentsSource';

/** Tall enough that mounting it whole is unmistakable in the node count. */
const TALL_ROWS = 5000;
const TALL_DIFF = tallHarnessDiff(TALL_ROWS);

function at(over: Partial<ReanchoredPosition>): ReanchoredPosition {
  return {
    rung: 'line_hash',
    file: null,
    side: null,
    line: null,
    endLine: null,
    hunkKey: null,
    threadKey: null,
    drifted: false,
    ...over,
  };
}

function comment(over: Partial<EnrichedComment> & { position: ReanchoredPosition | null }) {
  return {
    comment_id: 'c1',
    ts: '2026-01-01T00:00:00.000Z',
    author: 'reviewer' as const,
    body: 'this allocation looks unbounded',
    status: 'open' as const,
    anchor: {
      kind: 'DIFF_LINE' as const,
      file: 'src/fixture.ts',
      side: 'add' as const,
      line: 1,
      lineHash: 'hash_fixture_1',
    },
    replies: [],
    context: [],
    owner: null,
    trail: [],
    ...over,
  } satisfies EnrichedComment;
}

/** The owned row of `hunk_fixture_first` — add line 1 of src/fixture.ts. */
const ON_FIRST_HUNK = at({
  hunkKey: 'hunk_fixture_first',
  file: 'src/fixture.ts',
  side: 'add',
  line: 1,
});

/** The owned row of the TALL hunk — add line 11 of src/fixture.ts. */
const ON_TALL_HUNK = at({
  hunkKey: 'hunk_fixture_second',
  file: 'src/fixture.ts',
  side: 'add',
  line: 11,
});

describe('comment pins in the diff', () => {
  test('a comment on an owned row renders as a pin, with no narrative present', async () => {
    // The point of the comment loop, proved at its foundation: the sidecar and the
    // re-anchor ladder are narrative-independent, so a pin must render on the
    // deterministic path — which is the ONLY path that exists until a Story is
    // composed, and the state any commit returns the branch to.
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      width: 160,
      comments: [comment({ position: ON_FIRST_HUNK })],
    });
    await app.press('\r');

    const frame = app.frame();
    expect(frame).toContain('✎ reviewer');
    expect(frame).toContain('open');
    expect(frame).toContain('this allocation looks unbounded');
    app.unmount();
  });

  test('a reply count and a drifted anchor are both visible on the pin', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      width: 160,
      comments: [
        comment({
          position: at({ ...ON_FIRST_HUNK, drifted: true }),
          replies: [{ ts: '2026-01-02T00:00:00.000Z', author: 'agent', body: 'fixed in cp3' }],
        }),
      ],
    });
    await app.press('\r');

    const frame = app.frame();
    expect(frame).toContain('↳ 1');
    // Drift is REPORTED, never silently moved — the reviewer decides what it means.
    expect(frame).toContain('anchor drifted');
    app.unmount();
  });

  test('a comment this page cannot place still surfaces, above the diff', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      width: 160,
      comments: [
        comment({
          comment_id: 'lost',
          body: 'filed against code that has since moved',
          position: at({ rung: 'unanchored' }),
        }),
      ],
    });
    await app.press('\r');

    const frame = app.frame();
    // Not dropped. A comment the reviewer cannot see is one they conclude was
    // never filed — and the agent's reply then lands on code nobody is reading.
    expect(frame).toContain('unanchored');
    expect(frame).toContain('filed against code that has since moved');
    app.unmount();
  });
});

describe('virtualization', () => {
  test('a 5,000-row hunk mounts a bounded band at full measured height', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      width: 160,
      reviewDiff: TALL_DIFF,
    });
    await app.press('\r');

    const bounds = app.scrollBounds();
    const nodes = app.diffNodeCount();

    // EXACT TOTAL HEIGHT: the rows that did not mount were replaced by spacers of
    // precisely their measured height, so the scrollable content is still the full
    // 5,000+ rows. Drop the spacers and this collapses to the mounted band — the
    // scrollbar would then promise a document that ends hundreds of rows early.
    expect(bounds.content).toBeGreaterThan(TALL_ROWS);

    // BOUNDED BAND: and yet nowhere near 5,000 renderables are alive. Without the
    // row window this is ~5,000 <text> nodes, which stalls the frame.
    expect(nodes).toBeLessThan(TALL_ROWS / 5);
    app.unmount();
  });

  test('scrolling into the band keeps it bounded and the geometry stable', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      width: 160,
      reviewDiff: TALL_DIFF,
    });
    await app.press('\r');
    const before = app.scrollBounds();

    // Page down through the tall hunk. The window slides; the document does not resize.
    await app.pressAll(['f', 'f', 'f', 'f']);

    const after = app.scrollBounds();
    expect(after.top).toBeGreaterThan(before.top);
    expect(after.content).toBe(before.content);
    // A burst temporarily widens the row halo within a viewport-priced host
    // budget. This still fails if the 5,000-row hunk mounts whole.
    expect(app.diffNodeCount()).toBeLessThan(TALL_ROWS / 4);
    app.unmount();
  });

  test('a narrow stacked deep jump reaches the true bottom under the product node cap', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      width: 120,
      height: 30,
      reviewDiff: TALL_DIFF,
    });
    await app.press('\r');
    await app.press('G');

    const bounds = app.scrollBounds();
    // At 120 columns the real shell leaves fewer than 88 columns for the diff,
    // so auto layout is stacked — the same expensive product shape as the cap.
    expect(app.surface('review-diff-scroll').width).toBeLessThan(88);
    // The LAST card is now on screen. If a spacer were priced short, the content
    // height would be under-reported and `G` would stop above the final card —
    // the reader would simply never see the end of the checkpoint.
    expect(bounds.top).toBe(Math.max(0, bounds.content - bounds.viewport));
    expect(app.frame()).toContain('src/second.ts');
    expect(app.diffNodeCount()).toBeLessThan(1_000);
    app.unmount();
  });

  test('a narrow stacked wheel burst stays painted under the product node cap', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      width: 120,
      height: 30,
      reviewDiff: TALL_DIFF,
    });
    await app.press('\r');
    const surface = app.surfaceRect('review-diff-scroll');
    const x = surface.x + Math.floor(surface.width / 2);
    const y = surface.y + Math.min(3, Math.max(0, surface.height - 1));

    for (let step = 0; step < 6; step += 1) {
      await app.mockMouse.scroll(x, y, 'down', { delayMs: 0 });
      await app.settle();
    }

    expect(app.scrollTop()).toBeGreaterThan(0);
    expect(app.frame()).toContain('tall fixture row');
    expect(app.diffNodeCount()).toBeLessThan(1_000);
    app.unmount();
  });

  test('a PINNED tall hunk stays bounded at full pin-aware measured height', async () => {
    // Hunk-style inline rows: the comment participates in the measured row plan,
    // so it adds exactly four rows without disabling the 5,000-line row window.
    const plain = await mountReviewApp({
      scenario: 'no-narrative',
      width: 160,
      reviewDiff: TALL_DIFF,
    });
    await plain.press('\r');
    const plainBounds = plain.scrollBounds();
    plain.unmount();

    const pinned = await mountReviewApp({
      scenario: 'no-narrative',
      width: 160,
      reviewDiff: TALL_DIFF,
      comments: [comment({ position: ON_TALL_HUNK })],
    });
    await pinned.press('\r');
    const pinnedBounds = pinned.scrollBounds();

    expect(pinnedBounds.content).toBe(plainBounds.content + 4);
    expect(pinned.diffNodeCount()).toBeLessThan(TALL_ROWS / 4);
    // The bounded band still includes the anchored row and its complete pin.
    expect(pinned.frame()).toContain('✎ reviewer');
    pinned.unmount();
  });
});
