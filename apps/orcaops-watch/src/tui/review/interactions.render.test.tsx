// The reader's interactions, asserted on what they actually produce.
//
// Every assertion here observes a RENDERED FRAME or an INJECTED EFFECT — the
// clipboard bytes the app actually wrote, the durable event it actually appended.
// Never "a command was emitted": a command is an intention, and intentions that
// render nothing are the regression class this suite exists to catch.

import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import { tallHarnessDiff } from '../../../tests/review/reviewAppHarness';
import type { EnrichedComment } from '../../data/commentsSource';

/**
 * A pin on a row the FLOOR declares changed.
 *
 * `diffRowCursor` indexes the hunk's
 * CHANGED rows, and the floor decides which those are. A 240-row patch hunk whose
 * floor entry claims one added line has exactly ONE row-grain position — the other
 * 239 are context the mask subdues. A pin on line 60 of such a hunk is a pin on a
 * row the cursor cannot occupy.
 */
function pinAt(
  id: string,
  hunkKey: string,
  line: number,
  file = 'src/fixture.ts'
): EnrichedComment {
  return {
    comment_id: id,
    ts: '2026-01-01T00:00:00.000Z',
    author: 'reviewer',
    body: `pinned at ${line}`,
    status: 'open',
    anchor: { kind: 'DIFF_LINE', file, side: 'add', line },
    replies: [],
    context: [],
    owner: null,
    trail: [],
    position: {
      rung: 'exact',
      file,
      side: 'add',
      line,
      endLine: null,
      hunkKey,
      threadKey: null,
      drifted: false,
    },
  } as unknown as EnrichedComment;
}

function firstVisibleTallRow(frame: string): number | null {
  const match = /tall fixture row (\d+)/.exec(frame);
  return match === null ? null : Number(match[1]);
}

async function waitForAnchorRetries(
  app: Awaited<ReturnType<typeof mountReviewApp>>
): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await app.settle();
}

async function clickSurface(
  app: Awaited<ReturnType<typeof mountReviewApp>>,
  id: string
): Promise<void> {
  const target = app.surfaceRect(id);
  expect(target.width, `${id} width`).toBeGreaterThan(0);
  expect(target.height, `${id} height`).toBeGreaterThan(0);
  await app.mockMouse.click(target.x + 1, target.y + Math.min(1, target.height - 1));
  await app.settle();
}

describe('single-click Review routing indexes', () => {
  test('deterministic Brief rows activate only on a committed click and restore their cursor', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
    });
    const leaf = app.surfaceRect('review-brief-leaf-0');
    const finish = app.surfaceRect('review-brief-finish');
    expect(leaf.width).toBeGreaterThan(0);
    expect(finish.width).toBeGreaterThan(0);

    await app.mockMouse.pressDown(leaf.x + 1, leaf.y);
    await app.settle();
    expect(app.state().screen).toBe('brief');

    // Releasing over a different target must not commit the armed leaf row.
    await app.mockMouse.release(finish.x + 1, finish.y);
    await app.settle();
    expect(app.state().screen).toBe('brief');

    await clickSurface(app, 'review-brief-leaf-0');
    expect(app.state().screen).toBe('floor-diff');
    await app.press('q');
    expect(app.state().screen).toBe('brief');
    expect(app.state().briefCursor).toBe(0);

    await clickSurface(app, 'review-brief-finish');
    expect(app.state().screen).toBe('finish');
    await app.press('q');
    expect(app.state().screen).toBe('brief');
    expect(app.state().briefCursor).toBeGreaterThan(0);
    app.unmount();

    const unassigned = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'brief',
      width: 160,
    });
    await clickSurface(unassigned, 'review-brief-unassigned');
    expect(unassigned.state().screen).toBe('unassigned');
    await unassigned.press('q');
    expect(unassigned.state()).toMatchObject({
      screen: 'brief',
      briefDestinationKey: 'unassigned',
    });
    unassigned.unmount();
  });

  test('Flat Files, Comments, and Finish obligations invoke their keyboard activation paths', async () => {
    const files = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'flat-files',
      width: 160,
    });
    await clickSurface(files, 'review-flat-file-1');
    expect(files.state()).toMatchObject({
      screen: 'floor-diff',
      flatFileCursor: 1,
    });
    await files.press('q');
    expect(files.state()).toMatchObject({ screen: 'flat-files', flatFileCursor: 1 });
    files.unmount();

    const comment = pinAt('index_comment', 'hunk_fixture', 1);
    const comments = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'comments',
      width: 160,
      comments: [comment],
    });
    await clickSurface(comments, 'review-comment-0');
    expect(comments.state()).toMatchObject({
      screen: 'floor-diff',
      commentCursor: 0,
      diffHunkKey: 'hunk_fixture',
    });
    await comments.press('q');
    expect(comments.state()).toMatchObject({ screen: 'comments', commentCursor: 0 });
    comments.unmount();

    const finish = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'finish',
      width: 160,
    });
    await clickSurface(finish, 'review-finish-obligation-0');
    expect(finish.state().screen).not.toBe('finish');
    await finish.press('q');
    expect(finish.state()).toMatchObject({ screen: 'finish', finishCursor: 0 });
    finish.unmount();
  });

  test('a four-row CommentPin opens Comments without changing measured geometry', async () => {
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
      comments: [pinAt('clickable_pin', 'hunk_fixture', 1)],
    });
    const before = app.state();
    const pin = app.surfaceRect('review-comment-pin-clickable_pin');
    expect(pin.height).toBe(4);
    expect(pin.width).toBeGreaterThan(0);

    await app.mockMouse.moveTo(pin.x + 2, pin.y + 1);
    await app.settle();
    expect(app.surfaceRect('review-comment-pin-clickable_pin').backgroundAlpha).toBeGreaterThan(0);
    expect(app.state()).toEqual(before);

    await clickSurface(app, 'review-comment-pin-clickable_pin');
    expect(app.state()).toMatchObject({ screen: 'comments', commentCursor: 0 });
    await app.press('q');
    expect(app.state()).toMatchObject({
      screen: before.screen,
      readerPage: before.readerPage,
      diffHunkKey: before.diffHunkKey,
      diffGrain: before.diffGrain,
      focus: before.focus,
    });
    app.unmount();
  });
});

describe('`{` / `}` — jump to the comment pins', () => {
  test('lands on a pin and says which one', async () => {
    // Without a pin jump, reaching your own unanswered comment means scrolling
    // until it appears — on a branch of any size that is searching, not navigation.
    // `two-checkpoints` reviews a patch where `hunk_fixture_second` carries TWO
    // changed rows and the floor says so — so a pin can sit on the second one and
    // the cursor can actually get there.
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
      height: 14,
      comments: [pinAt('pin_a', 'hunk_fixture_second', 11), pinAt('pin_b', 'hunk_fixture', 1)],
    });

    // The app mounts with `hunk_fixture` selected at row 0 — which IS pin 1's row.
    // So `}` moves to the NEXT pin, and that is the whole point of the key.
    await app.press('}');
    expect(app.frame()).toContain('Pin 2/2');
    expect(app.state().diffHunkKey).toBe('hunk_fixture_second');
    expect(app.state().diffSliceKey).toBe('hunk_fixture_second:s0');
    expect(app.state().diffGrain).toBe('row');
    expect(app.scrollTop()).toBeGreaterThan(0);
    // ROW 0, and this is the assertion that distinguishes the two ways to compute it.
    //
    // The pin sits on line 11. The FLOOR says `hunk_fixture_second` has two changed
    // rows (11 and 12); cp1's PAGE owns only line 11. Resolution is against that
    // exact page-local row list.
    expect(app.state().diffRowCursor).toBe(0);

    await app.press('{');
    expect(app.frame()).toContain('Pin 1/2');
    expect(app.state().diffHunkKey).toBe('hunk_fixture');
    expect(app.state().diffSliceKey).toBe('hunk_fixture:s0');
    // Ordered by the PAGE's hunk order, not by comment id — the jump the eye makes.
    expect(app.state().diffRowCursor).toBe(0);
    app.unmount();
  });

  test('says so when this page has no pins, rather than moving somewhere arbitrary', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
    });

    await app.press('}');

    expect(app.frame()).toContain('No comment pins on this page');
    app.unmount();
  });

  test('keeps an off-page line pin visible without coercing it to row zero', async () => {
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
      comments: [pinAt('pin_cp2', 'hunk_fixture_second', 12)],
    });
    const before = app.state();

    await app.press('}');

    expect(app.frame()).toContain('1 comment pin(s) are visible but not row-resolvable');
    expect(app.state().diffHunkKey).toBe(before.diffHunkKey);
    expect(app.state().diffRowCursor).toBe(before.diffRowCursor);
    app.unmount();
  });

  test('Unassigned draws pins on the same code rows as checkpoint pages', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'unassigned',
      width: 160,
      comments: [pinAt('unassigned_pin', 'hunk_unassigned', 1, 'src/unassigned.ts')],
    });

    expect(app.frame()).toContain('pinned at 1');
    expect(app.frame()).toContain('unassigned row 1');
    app.unmount();
  });
});

describe('`/` — filter the flat file list', () => {
  test('narrows the list, and the cursor stays inside what is on screen', async () => {
    // A large branch puts hundreds of hunks across a hundred-plus files behind this
    // escape hatch, which exists FOR "just show me everything" — so without a filter
    // it is an unsearchable wall.
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'flat-files',
      width: 160,
    });

    expect(app.frame()).toContain('src/fixture.ts');
    expect(app.frame()).toContain('src/second.ts');

    await app.press('/');
    // The modal saves on ^S — Enter inserts a newline. Its own footer says so.
    await app.pressAll([...'second', '\u0013']);

    const frame = app.frame();
    expect(frame).toContain('/ second · 1/3 hunk(s)');
    expect(frame).toContain('src/second.ts');
    expect(frame).not.toContain('src/fixture.ts');
    app.unmount();
  });

  test('Enter opens the hunk the cursor is ON, not the one at that index unfiltered', async () => {
    // The filtered list is what the reviewer is looking at. Indexing the unfiltered
    // one means Enter opens a different hunk than the highlighted row — and the
    // further down they are, the further off it lands.
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'flat-files',
      width: 160,
    });

    await app.press('/');
    await app.pressAll([...'second', '\u0013']);
    await app.press('\r');

    expect(app.state().screen).toBe('floor-diff');
    expect(app.state().diffHunkKey).toBe('hunk_fixture_third');
    app.unmount();
  });
});

describe('`/` — filter navigator destinations without filtering the diff', () => {
  test('jumps among matching destinations, clears, and leaves deterministic coverage measured', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 18,
      reviewDiff: tallHarnessDiff(80),
    });
    const fullContent = app.scrollBounds().content;
    const journalBefore = app.journalEvents.length;

    await app.press('/');
    await app.pressAll([...'second', '\u0013']);

    expect(app.state().fileFilter).toBe('second');
    expect(app.state().diffHunkKey).toBe('hunk_fixture_third');
    expect(app.frame()).toContain('FILES · 1/2  / second');
    expect(app.scrollBounds().content).toBe(fullContent);
    expect(app.journalEvents).toHaveLength(journalBefore);

    await app.press('/');
    await app.pressAll([
      ...Array.from({ length: 6 }, () => 'right'),
      ...Array.from({ length: 6 }, () => '\x7f'),
      '\u0013',
    ]);
    expect(app.state().fileFilter).toBeNull();
    expect(app.state().diffHunkKey).toBe('hunk_fixture_third');
    expect(app.frame()).toContain('FILES · 2');
    expect(app.scrollBounds().content).toBe(fullContent);
    app.unmount();
  });
});

describe('`C-l` — recenter the semantic diff cursor', () => {
  test('recenters hunk and row grain in the deterministic lens without changing selection', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 14,
      reviewDiff: tallHarnessDiff(80),
    });

    await app.press('j');
    expect(app.state().diffHunkKey).toBe('hunk_fixture_second');
    await app.press('f');
    const hunkPaged = app.scrollTop();
    expect(hunkPaged).toBeGreaterThan(0);
    await app.press('C-l');
    expect(app.scrollTop()).not.toBe(hunkPaged);
    expect(app.state().diffHunkKey).toBe('hunk_fixture_second');
    expect(app.state().diffGrain).toBe('hunk');

    await app.pressAll(['return', 'j']);
    const rowBefore = app.state().diffRowCursor;
    await app.press('f');
    const rowPaged = app.scrollTop();
    expect(rowPaged).toBeGreaterThan(0);
    await app.press('C-l');
    expect(app.scrollTop()).not.toBe(rowPaged);
    expect(app.state().diffGrain).toBe('row');
    expect(app.state().diffRowCursor).toBe(rowBefore);
    app.unmount();
  });
});

describe('rapid review entry keeps cursor and viewport in one transaction', () => {
  test('Enter then rapid j input before the first diff commit aligns to the newest slice', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
      height: 18,
      reviewDiff: tallHarnessDiff(80),
    });

    // Deliberately do not settle between keys. A real terminal can deliver this
    // burst before the page-entry setTimeout has aligned its first slice.
    app.mockInput.pressKey('\r');
    app.mockInput.pressKey('j');
    app.mockInput.pressKey('j');
    // The burst may land before the first diff commit, in which case the final
    // alignment arrives on the anchor-retry timer rather than synchronously.
    await waitForAnchorRetries(app);
    expect(
      await app.settleUntil(
        (frame) =>
          app.state().diffSliceKey === 'hunk_fixture_third:s0' &&
          app.scrollTop() > 0 &&
          frame.includes('third fixture hunk')
      )
    ).toBe(true);

    expect(app.state().diffSliceKey).toBe('hunk_fixture_third:s0');
    expect(app.scrollTop()).toBeGreaterThan(0);
    expect(app.frame()).toContain('third fixture hunk');
    app.unmount();
  });

  test('Enter then next-file input replaces pending first-slice alignment', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
      height: 18,
      reviewDiff: tallHarnessDiff(80),
    });

    app.mockInput.pressKey('\r');
    app.mockInput.pressKey('.');
    await waitForAnchorRetries(app);
    expect(
      await app.settleUntil(
        (frame) =>
          app.state().diffSliceKey === 'hunk_fixture_third:s0' &&
          app.scrollTop() > 0 &&
          frame.includes('third fixture hunk')
      )
    ).toBe(true);

    expect(app.state().diffSliceKey).toBe('hunk_fixture_third:s0');
    expect(app.scrollTop()).toBeGreaterThan(0);
    expect(app.frame()).toContain('Cursor · src/second.ts');
    expect(app.frame()).toContain('third fixture hunk');
    app.unmount();
  });
});

describe('`l` / `w` / `M` — view toggles, threaded into the measured geometry', () => {
  test('each one changes what is drawn', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      reviewDiff: tallHarnessDiff(240),
    });

    const base = app.frame();
    await app.press('l');
    expect(app.frame()).not.toBe(base);
    expect(app.state().showLineNumbers).toBe(false);

    await app.press('l');
    expect(app.state().showLineNumbers).toBe(true);

    const withNumbers = app.frame();
    await app.press('M');
    expect(app.frame()).not.toBe(withNumbers);
    expect(app.state().showHunkHeaders).toBe(false);
    app.unmount();
  });

  test('wrap changes the GEOMETRY, not just the text — the scroll height grows', async () => {
    // These are geometry inputs: `measureSliceRowBounds` prices a wrapped row
    // differently, so the layout, the mount plan and the render must read the same
    // booleans or the spacers stop adding up. A wrapped 400-character row is
    // several rows tall, and the column must know it.
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      reviewDiff: tallHarnessDiff(240),
    });

    const before = app.scrollBounds().content;
    await app.press('w');

    expect(app.state().wrapLines).toBe(true);
    expect(app.scrollBounds().content).toBeGreaterThan(before);
    app.unmount();
  });
});

describe('the full-context presentation controls', () => {
  test('1 / 2 / 0 drive split, stack, and responsive-auto rendering', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
    });

    const automatic = app.frame();
    await app.press('2');
    const stacked = app.frame();
    expect(app.state().diffLayout).toBe('stack');
    expect(stacked).not.toBe(automatic);

    await app.press('1');
    expect(app.state().diffLayout).toBe('split');
    expect(app.frame()).not.toBe(stacked);

    await app.press('0');
    expect(app.state().diffLayout).toBe('auto');
    await app.settleUntil((frame) => frame === automatic);
    expect(app.frame()).toBe(automatic);
    app.unmount();
  });

  test('i reveals ownership for subdued context in a shared parent hunk', async () => {
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
    });
    await app.press('j');
    expect(app.frame()).not.toContain('subdued context');

    await app.press('i');
    expect(app.state().showOwnerLabels).toBe(true);
    expect(app.frame()).toContain('subdued context');
    expect(app.frame()).toContain('cp2');
    app.unmount();
  });

  test('shared hunks retain semantic rails while marking foreign cells as context', async () => {
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
    });
    await app.press('j');

    expect(app.frame()).toContain('▌');
    expect(app.frame()).toContain('┊');

    await app.press('2');
    expect(app.state().diffLayout).toBe('stack');
    expect(app.frame()).toContain('┊');
    app.unmount();
  });

  test('shift-arrow pans long unwrapped code through the canonical shell', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      reviewDiff: tallHarnessDiff(240),
    });
    await app.press('j');
    const before = app.frame();

    await app.press('shift-right');
    expect(app.state().codeHorizontalOffset).toBe(4);
    expect(app.frame()).not.toBe(before);

    await app.press('shift-left');
    expect(app.state().codeHorizontalOffset).toBe(0);
    app.unmount();
  });

  test('repeated horizontal input cannot pan a short page into blank space', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
    });
    await app.settle();
    const verticalTop = app.scrollTop();

    await app.pressAll(Array.from({ length: 24 }, () => 'shift-right'));

    expect(app.state().codeHorizontalOffset).toBe(0);
    expect(app.scrollTop()).toBe(verticalTop);
    expect(app.frame()).toContain('stable fixture row');
    expect(app.frame()).toContain('No horizontally hidden code on this page');
    app.unmount();
  });

  test('layout and terminal width changes reconcile retained horizontal pan', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 18,
      reviewDiff: tallHarnessDiff(80),
      controllerState: { diffLayout: 'split', codeHorizontalOffset: 10_000 },
    });
    const splitOffset = app.state().codeHorizontalOffset;
    expect(splitOffset).toBeGreaterThan(0);
    expect(splitOffset).toBeLessThan(10_000);

    await app.press('l');
    const noGutterOffset = app.state().codeHorizontalOffset;
    expect(app.state().showLineNumbers).toBe(false);
    expect(noGutterOffset).toBeLessThan(splitOffset);

    await app.press('2');
    const stackOffset = app.state().codeHorizontalOffset;
    expect(app.state().diffLayout).toBe('stack');
    expect(stackOffset).toBeLessThan(noGutterOffset);

    await app.resize(220, 18);
    expect(app.surface('review-diff-scroll').width).toBeGreaterThan(100);
    expect(app.state().codeHorizontalOffset).toBeLessThan(stackOffset);
    expect(app.state().codeHorizontalOffset).toBeGreaterThan(0);
    app.unmount();
  });

  test('shift and native horizontal wheel pan code without disturbing vertical review position', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 18,
      reviewDiff: tallHarnessDiff(240),
    });

    await app.press('shift-right');
    await app.press('j');
    // This assertion isolates wheel-axis routing. Let the initial viewport
    // measurement transaction finish; the separate relayout test below covers
    // wheel input intentionally arriving while an anchor is pending.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    await app.settle();
    expect(app.state().codeHorizontalOffset).toBe(4);
    const surface = app.surfaceRect('review-diff-scroll');
    const x = surface.x + Math.floor(surface.width / 2);
    const y = surface.y + Math.min(3, Math.max(0, surface.height - 1));

    const beforeVerticalWheel = app.scrollTop();
    await app.mockMouse.scroll(x, y, 'down');
    await app.settleUntil(() => app.scrollTop() > beforeVerticalWheel);
    expect(app.state().codeHorizontalOffset).toBe(4);
    const verticalTop = app.scrollTop();
    expect(verticalTop).toBeGreaterThan(beforeVerticalWheel);

    await app.mockMouse.scroll(x, y, 'down', { modifiers: { shift: true } });
    await app.settle();
    expect(app.state().codeHorizontalOffset).toBe(8);
    expect(app.scrollTop()).toBe(verticalTop);

    await app.mockMouse.scroll(x, y, 'right');
    await app.settle();
    expect(app.state().codeHorizontalOffset).toBe(12);
    expect(app.scrollTop()).toBe(verticalTop);

    // OpenTUI normally remaps Shift+Right-wheel back to vertical Down. The app
    // must consume that native direction before the ScrollBox can move itself.
    await app.mockMouse.scroll(x, y, 'right', { modifiers: { shift: true } });
    await app.settle();
    expect(app.state().codeHorizontalOffset).toBe(16);
    expect(app.scrollTop()).toBe(verticalTop);
    app.unmount();
  });

  test('a clock-controlled vertical wheel burst accelerates once at the app-owned seam', async () => {
    const times = [1_000, 1_020, 1_040];
    let tick = 0;
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 18,
      reviewDiff: tallHarnessDiff(240),
      wheelAccelerationClock: () => times[Math.min(tick++, times.length - 1)]!,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    await app.settle();
    const surface = app.surfaceRect('review-diff-scroll');
    const x = surface.x + Math.floor(surface.width / 2);
    const y = surface.y + Math.min(3, Math.max(0, surface.height - 1));

    await app.mockMouse.scroll(x, y, 'down');
    await app.mockMouse.scroll(x, y, 'down');
    await app.mockMouse.scroll(x, y, 'down');
    await app.settleUntil(() => app.scrollTop() >= 5);

    expect(app.scrollTop()).toBe(5);
    app.unmount();
  });

  test('successful checkpoint and pointer file navigation reset horizontal code pan', async () => {
    const checkpoint = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
      height: 40,
      reviewDiff: tallHarnessDiff(80),
    });
    await checkpoint.press('shift-right');
    expect(checkpoint.state().codeHorizontalOffset).toBe(4);
    await checkpoint.press(']');
    expect(checkpoint.state().readerPage).toBe(1);
    expect(checkpoint.state().codeHorizontalOffset).toBe(0);
    checkpoint.unmount();

    const file = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 40,
      reviewDiff: tallHarnessDiff(80),
    });
    await file.press('shift-right');
    const fileRow = file.surfaceRect('review-file-navigator-row-1');
    await file.mockMouse.click(fileRow.x + 2, fileRow.y);
    await file.settle();
    expect(file.state().diffSliceKey).toBe('hunk_fixture_third:s0');
    expect(file.state().codeHorizontalOffset).toBe(0);
    file.unmount();
  });

  test('slice traversal preserves pan within a file and resets it at the next file', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      reviewDiff: tallHarnessDiff(80),
    });
    await app.press('shift-right');
    expect(app.state().codeHorizontalOffset).toBe(4);

    await app.press('j');
    expect(app.state().diffSliceKey).toBe('hunk_fixture_second:s0');
    expect(app.state().codeHorizontalOffset).toBe(4);

    await app.press('j');
    expect(app.state().diffSliceKey).toBe('hunk_fixture_third:s0');
    expect(app.state().codeHorizontalOffset).toBe(0);

    await app.press('shift-right');
    await app.press('k');
    expect(app.state().diffSliceKey).toBe('hunk_fixture_second:s0');
    expect(app.state().codeHorizontalOffset).toBe(0);
    app.unmount();
  });

  test('re-entering review starts at the first code column', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      reviewDiff: tallHarnessDiff(80),
    });
    await app.pressAll(['shift-right', 'shift-right', 'shift-right']);
    expect(app.state().codeHorizontalOffset).toBe(12);

    await app.press('escape');
    expect(app.state().screen).toBe('brief');
    await app.press('return');
    expect(app.state().screen).toBe('floor-diff');
    expect(app.state().codeHorizontalOffset).toBe(0);
    expect(app.frame()).toContain('stable fixture row');
    app.unmount();
  });

  test('line-number geometry round trips keep the exact source row at viewport top', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 110,
      height: 16,
      reviewDiff: tallHarnessDiff(80),
      controllerState: { wrapLines: true, showLineNumbers: true },
    });
    await app.pressAll(['f', 'f', 'f', 'f', 'f']);
    const sourceRow = firstVisibleTallRow(app.frame());
    expect(sourceRow).not.toBeNull();

    await app.press('l');
    await waitForAnchorRetries(app);
    expect(firstVisibleTallRow(app.frame())).toBe(sourceRow);
    await app.press('l');
    await waitForAnchorRetries(app);
    expect(firstVisibleTallRow(app.frame())).toBe(sourceRow);
    app.unmount();
  });

  test('wheel input during a relayout advances from the preserved source instead of snapping back', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 110,
      height: 16,
      reviewDiff: tallHarnessDiff(80),
    });
    await app.pressAll(['f', 'f', 'f', 'f', 'f']);
    const before = firstVisibleTallRow(app.frame());
    expect(before).not.toBeNull();

    const surface = app.surfaceRect('review-diff-scroll');
    app.mockInput.pressKey('w');
    await app.mockMouse.scroll(
      surface.x + Math.floor(surface.width / 2),
      surface.y + Math.min(3, Math.max(0, surface.height - 1)),
      'down'
    );
    await waitForAnchorRetries(app);
    const after = firstVisibleTallRow(app.frame());
    expect(after).not.toBeNull();
    expect(after).toBe(before! + 1);
    app.unmount();
  });

  test('same-turn wrap and repeated row input reveals the newest row in replacement geometry', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-huge',
      screen: 'unassigned',
      width: 80,
      height: 20,
    });
    await app.press('w');
    await app.press('return');
    for (let pass = 0; pass < 10; pass += 1) await app.press('j');

    // Real terminals can deliver all three keys before React commits the unwrap.
    // Each row command must supersede the older pending destination, then reveal
    // the newest row against replacement geometry rather than the wrapped layout.
    app.mockInput.pressKey('w');
    app.mockInput.pressKey('j');
    app.mockInput.pressKey('j');
    await app.settle();

    expect(app.state().diffRowCursor).toBe(12);
    expect(app.frame()).toContain('unassigned row 13');
    app.unmount();
  });
});

describe('`Y` — copy, asserted on the bytes the app actually wrote', () => {
  test('puts the selected code on the clipboard, with no gutter', async () => {
    // Asserting only the NOTICE — 'Copied 3 row(s)' — is the app agreeing with
    // itself about a thing it may not have done. This reads the OSC 52 escape back
    // off the terminal stream and decodes it.
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
    });

    // Onto the shared hunk, down to row grain, span from the cursor, copy.
    //
    // The span is ONE row, and that is the product being correct: `hunk_fixture_second`
    // carries two changed rows, but cp1's PAGE owns one of them — the other belongs to
    // cp2. The cursor walks what the page owns, so that is what `v` spans and what `Y`
    // copies. A copy that reached into cp2's row would be copying code this page is not
    // showing as its own.
    await app.pressAll(['j', '\r', 'v', 'j', 'Y']);

    const copied = app.clipboardWrites();
    expect(copied).toEqual(['second fixture hunk']);
    // Raw bodies, no gutter. A paste carrying `+` signs and line numbers is a paste
    // the reviewer has to clean up by hand.
    expect(copied[0]).not.toContain('+');
    app.unmount();
  });
});

describe('the mouse, through the same controller seam the keys use', () => {
  test('drag-edge selection crosses virtual windows through the app-owned coordinator', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-huge',
      screen: 'unassigned',
      width: 110,
      height: 18,
    });
    const surface = app.surfaceRect('review-diff-scroll');
    const startY = app.rows().findIndex((row) => row.includes('unassigned row 1'));
    expect(startY).toBeGreaterThanOrEqual(surface.y);
    const x = surface.x + Math.min(30, Math.max(2, surface.width - 3));
    const edgeY = surface.y + surface.height - 1;

    await app.mockMouse.pressDown(x, startY);
    await app.mockMouse.moveTo(x, edgeY);
    await new Promise<void>((resolve) => setTimeout(resolve, 320));
    await app.settle();
    await app.mockMouse.release(x, edgeY);
    await app.settle();

    expect(app.state().diffGrain).toBe('row');
    expect(app.state().diffSelectionAnchor).not.toBeNull();
    expect(app.state().diffRowCursor).toBeGreaterThan(app.scrollBounds().viewport);
    expect(app.scrollTop()).toBeGreaterThan(0);
    expect(app.frame()).toContain('unassigned row');
    expect(app.diffNodeCount()).toBeLessThan(1_000);
    app.unmount();
  });

  test('split-row clicks select only the cell actually under the pointer', async () => {
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
    });
    // At HUNK grain, so the click has a state change to make.
    await app.press('j');
    expect(app.state().diffGrain).toBe('hunk');

    const rows = app.rows();
    const target = rows.findIndex((row) => row.includes('second fixture hunk'));
    expect(target).toBeGreaterThan(-1);

    // This is an addition-only row. Its empty left cell must not borrow the
    // owned addition from the right half of the same rendered row.
    await app.mockMouse.click(60, target);
    await app.settle();
    expect(app.state().diffGrain).toBe('hunk');

    // The shared parent hunk also renders cp2's addition as a subdued foreign
    // cell. Clicking it must not create a cp1 row cursor.
    const foreign = rows.findIndex((row) => row.includes('cp2 added this row'));
    expect(foreign).toBeGreaterThan(-1);
    await app.mockMouse.click(125, foreign);
    await app.settle();
    expect(app.state().diffGrain).toBe('hunk');

    // The right half owns this addition, so the same click there descends to
    // the row-grain cursor through the canonical controller seam.
    await app.mockMouse.click(125, target);
    await app.settle();

    expect(app.state().diffGrain).toBe('row');
    expect(app.state().diffRowCursor).toBe(0);
    app.unmount();
  });

  test('stack rows remain selectable across their full width with wrapping enabled', async () => {
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      screen: 'floor-diff',
      width: 160,
    });
    await app.pressAll(['j', '2', 'w']);
    expect(app.state().diffGrain).toBe('hunk');
    expect(app.state().diffLayout).toBe('stack');
    expect(app.state().wrapLines).toBe(true);

    const target = app.rows().findIndex((row) => row.includes('second fixture hunk'));
    expect(target).toBeGreaterThan(-1);
    await app.mockMouse.click(60, target);
    await app.settle();

    expect(app.state().diffGrain).toBe('row');
    expect(app.state().diffRowCursor).toBe(0);
    app.unmount();
  });
});
