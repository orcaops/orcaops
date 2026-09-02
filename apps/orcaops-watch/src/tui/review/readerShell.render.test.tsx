// The reader shell: the checkpoint pager, the page-local cursor, and the rail.
//
// Every one of these needs a branch with MORE THAN ONE checkpoint. With a single
// page, a broken pager, a cursor that walks straight out of the checkpoint it is
// displaying and a rail that reprints the same decisions beside every hunk are all
// indistinguishable from correct.
//
// `two-checkpoints`: cp1 owns both hunks of src/fixture.ts, cp2 owns src/second.ts.

import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import type { EnrichedComment } from '../../data/commentsSource';

function checkpointComment(cp: number): EnrichedComment {
  return {
    comment_id: `comment-cp${cp}`,
    ts: '2026-07-14T00:00:00.000Z',
    author: 'reviewer',
    body: `Open comment owned by checkpoint ${cp}`,
    status: 'open',
    anchor: {
      kind: 'DIFF_LINE',
      file: cp === 1 ? 'src/fixture.ts' : 'src/second.ts',
      side: 'add',
      line: 1,
      lineHash: `hash_cp${cp}`,
    },
    replies: [],
    context: [],
    owner: { artifact: 'artifact-fixture', cp },
    trail: [],
    position: null,
  } as unknown as EnrichedComment;
}

describe('the checkpoint pager', () => {
  test('an owned open comment blocks only its exact checkpoint page', async () => {
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
      comments: [checkpointComment(1)],
    });
    const coverageCount = () =>
      app.journalEvents.filter((event) => event.action === 'RECORD_REVIEW_COVERAGE').length;

    await app.press('m');
    expect(app.frame()).toContain('Mark reviewed is blocked by');
    expect(app.frame()).toContain('comments');
    expect(coverageCount()).toBe(0);

    await app.press(']');
    await app.press('m');
    expect(await app.settleUntil((frame) => frame.includes('Checkpoint coverage recorded'))).toBe(
      true
    );
    expect(coverageCount()).toBe(1);
    app.unmount();
  });

  test('] moves to the next CHECKPOINT and the diff column follows it', async () => {
    const app = await mountReviewApp({ scenario: 'two-checkpoints', width: 160 });
    await app.press('\r');

    // Page one: cp1, and its card is the file cp1 touched.
    const first = app.frame();
    expect(first).toContain('Checkpoint 1/2 · Fixture checkpoint');
    expect(first).toContain('src/fixture.ts');
    expect(first).not.toContain('M src/second.ts');

    await app.press(']');

    // Page two: a different checkpoint, and the files IT touched. The reviewer moved
    // through the captured record, not through a flat list of hunks.
    const second = app.frame();
    expect(second).toContain('Checkpoint 2/2 · Second checkpoint');
    expect(second).toContain('M src/second.ts');
    // cp2 shares `src/fixture.ts` with cp1 — so the card is here, but cp1's own hunk
    // is COLLAPSED as another checkpoint's context while cp2's shared slice is lit.
    // The page shows the file, and marks whose rows are whose.
    expect(second).toContain('hunk hidden');
    app.unmount();
  });

  test('[ walks back, and the ends of the branch say so rather than wrapping', async () => {
    const app = await mountReviewApp({ scenario: 'two-checkpoints', width: 160 });
    await app.press('\r');

    await app.press('[');
    // Already on the first page. Silently wrapping to the last checkpoint would
    // teleport the reviewer across the whole branch.
    expect(app.frame()).toContain('First page');
    expect(app.frame()).toContain('Checkpoint 1/2');

    await app.pressAll([']', ']']);
    expect(app.frame()).toContain('Last page');
    expect(app.frame()).toContain('Checkpoint 2/2');
    app.unmount();
  });

  test('the cursor stays INSIDE the page — j does not walk into the next checkpoint', async () => {
    // The cursor walks the PAGE. Walking `floor.coverage.items` — every hunk on the
    // branch — lands the last `j` of one checkpoint on the first hunk of the next
    // with nothing to mark the crossing, and the diff column silently re-pages
    // underneath the reviewer.
    const app = await mountReviewApp({ scenario: 'two-checkpoints', width: 160 });
    await app.press('\r');
    expect(app.frame()).toContain('Slice 1/2'); // cp1 owns TWO slices, not the branch's four

    await app.pressAll(['j', 'j', 'j', 'j']);

    // Hard against the bottom of cp1's own hunks, and still on cp1.
    const frame = app.frame();
    expect(frame).toContain('Slice 2/2');
    expect(frame).toContain('Checkpoint 1/2 · Fixture checkpoint');
    expect(app.state().readerPage).toBe(0);
    app.unmount();
  });

  test('a page transition drops the old scroll and reveals the new first slice', async () => {
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
      height: 10,
    });

    await app.press(']');
    await app.press('G');
    expect(app.scrollTop()).toBeGreaterThan(0);

    await app.press('[');

    expect(app.state().readerPage).toBe(0);
    expect(app.state().diffSliceKey).toBe('hunk_fixture:s0');
    expect(app.scrollTop()).toBe(0);
    expect(app.frame()).toContain('stable fixture row');
    app.unmount();
  });

  test('direct entry scrolls the selected first slice into view after measurement', async () => {
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
      // With the sticky header outside the native viewport this must be short
      // enough that the selected slice cannot already fit at scrollTop zero.
      height: 9,
      controllerState: {
        readerPage: 1,
        diffHunkKey: 'hunk_fixture_second',
        diffSliceKey: 'hunk_fixture_second:s1',
      },
    });

    expect(app.frame()).toContain('Checkpoint 2/2 · Second checkpoint');
    expect(app.frame()).toContain('cp2 added this row');
    expect(app.scrollTop()).toBeGreaterThan(0);
    app.unmount();
  });
});

describe('the captured trail rail', () => {
  test('shows the PAGE’s record — not every checkpoint that touched the hunk', async () => {
    const app = await mountReviewApp({ scenario: 'two-checkpoints', width: 160 });
    await app.press('\r');

    // cp1's reasoning, on cp1's page.
    expect(app.frame()).toContain('REVIEW CONTEXT · CHECKPOINT');
    expect(app.frame()).toContain('cp1 · Fixture checkpoint');
    expect(app.frame()).not.toContain('cp2 kept the second file separate');

    await app.press(']');

    // cp2's reasoning, on cp2's. The rail is keyed to the page, so it changes when
    // the page does — and shows one checkpoint's record, not a merge of both.
    const frame = app.frame();
    expect(frame).toContain('cp2 kept the second file separate');
    expect(frame).toContain('Second checkpoint');
    app.unmount();
  });

  test('is stable across the page — moving the cursor does not re-derive it', async () => {
    // Keying the rail to the CURSOR'S HUNK re-derives the trail from a hunk two
    // checkpoints own: cp1's second hunk is shared with cp2, so moving `j` onto it
    // would suddenly start showing cp2's reasoning while the reviewer was still
    // reading cp1's page, with nothing to say whose decision they were looking at.
    const app = await mountReviewApp({ scenario: 'two-checkpoints', width: 160 });
    await app.press('\r');
    expect(app.frame()).toContain('cp1 · Fixture checkpoint');
    expect(app.frame()).not.toContain('cp2 kept the second file separate');

    await app.press('j'); // onto the hunk cp2 ALSO owns a slice of

    // Still cp1's record. The rail is keyed to the page, so it changes when the page
    // changes and at no other time.
    expect(app.frame()).toContain('cp1 · Fixture checkpoint');
    expect(app.frame()).not.toContain('cp2 kept the second file separate');
    app.unmount();
  });

  test('RULED OUT still renders — it is the only thing that shows rejected alternatives', async () => {
    const app = await mountReviewApp({ scenario: 'two-checkpoints', width: 160 });
    await app.press('\r');
    expect(app.frame()).toContain('RULED OUT');
    app.unmount();
  });
});
