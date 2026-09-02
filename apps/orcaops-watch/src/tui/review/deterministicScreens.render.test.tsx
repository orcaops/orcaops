// Brief and Unassigned, on the lens every branch actually lives on.
//
// The deterministic path is the default, since any commit re-floors the branch and
// stales its narrative. A `model === null` short-circuit above the screen router
// collapses `brief`, `unassigned`, `comments` and `finish` into one fallback
// screen — not a screen so much as the absence of the others.
//
// This suite covers the Brief the reviewer starts on, and the unexplained rows
// they finish on.
//
// Everything here runs with NO NARRATIVE, on purpose.

import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';

describe('the Brief, with no narrative present', () => {
  test('says what has been READ, not just what exists', async () => {
    // The glyph must track the ledger: a thread the reviewer has completed reads
    // differently from one they have not. A hardcoded '○' makes the reviewer's own
    // progress — the entire point of a brief — invisible.
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'brief',
      width: 160,
    });

    const frame = app.frame();
    expect(frame).toContain('CAPTURED WORK');
    expect(frame).toContain('1/1 complete');
    // The fixture covered every row, so the checkpoint reads complete.
    expect(frame).toContain('✓');
    app.unmount();
  });

  test('an unreviewed branch reads unreviewed — the glyph tracks the ledger', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', screen: 'brief', width: 160 });

    const frame = app.frame();
    expect(frame).toContain('0/1 complete');
    expect(frame).not.toContain('✓');
    app.unmount();
  });

  test('counts the unexplained rows it can actually route to', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'brief',
      width: 160,
    });

    expect(app.frame()).toContain('Unassigned · 2 unexplained row(s) · 1 ambiguous hunk(s)');
    app.unmount();
  });
});

describe('Unassigned, with no narrative present', () => {
  test('the Brief routes to Unassigned on Enter', async () => {
    // Reaching the screen only through `stateForLocation`, the attention route,
    // requires a narrative — so on the deterministic path no key opens it: the
    // Brief lists the unexplained rows, and Enter on that row drops the reviewer
    // into the diff of the first gap hunk instead of the screen where that work
    // can be inspected and discharged.
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'brief',
      width: 160,
    });

    // Walk past the one thread, onto the Unassigned row, and open it.
    await app.pressAll(['j', '\r']);

    expect(app.state().screen).toBe('unassigned');
    expect(app.frame()).toContain('Unassigned · Slice 1/2');
    expect(app.frame()).toContain('unassigned row 1');
    app.unmount();
  });

  test('a screen change resets the scroll window — a stale one paints blank spacers', async () => {
    // Without the reset, the app's mirror of scrollTop goes on describing a
    // scrollbox that has been unmounted. On the diff column that is invisible
    // (entering it re-centers on the selected hunk, which overwrites the stale
    // value first). It stops being invisible the moment a
    // second column virtualizes off the same mirror: a stale scrollTop plans the
    // Unassigned mount window thousands of rows below where the reviewer is
    // looking, and the screen paints as spacers — blank, silent, and perfectly
    // self-consistent.
    const app = await mountReviewApp({
      scenario: 'unassigned-huge',
      screen: 'unassigned',
      width: 160,
    });

    // Page down hard, so the column is scrolled a long way from the top.
    await app.pressAll(['f', 'f', 'f']);
    expect(app.scrollBounds().top).toBeGreaterThan(0);

    // The global Files route returns to its exact semantic origin. Native scroll
    // is owned by the remounted surface, so it starts at the top rather than
    // inheriting a stale mirrored position.
    await app.press('F'); // → flat-files
    expect(app.state().screen).toBe('flat-files');
    await app.press('F'); // → exact Unassigned origin
    expect(app.state().screen).toBe('unassigned');

    expect(app.scrollBounds().top).toBe(0);
    expect(app.frame()).toContain('unassigned row 1');

    // THE NODE COUNT is what actually catches this, and it is worth saying why.
    //
    // The re-mounted scrollbox is a NEW renderable, so its own scrollTop is 0
    // whatever the app believes, and the cursor is force-mounted, so the first row
    // renders either way. Both of the obvious assertions above therefore pass even
    // with the reset removed — they are true, and they are not the point.
    //
    // What a stale scrollTop of ~2,000 actually does is plan the band from the
    // cursor at 0 all the way DOWN to where the app thinks the viewport is: two
    // thousand mounted nodes, on a screen showing thirty. The window is gone and
    // nothing looks wrong.
    expect(app.diffNodeCount()).toBeLessThan(400);
    app.unmount();
  });

  test('renders the Unassigned page on the deterministic path', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'unassigned',
      width: 160,
    });

    const frame = app.frame();
    expect(frame).toContain('Unassigned · Slice 1/2');
    expect(frame).toContain('src/unassigned.ts');
    expect(frame).toContain('unassigned row 1');
    expect(frame).toContain('src/ambiguous.ts');
    expect(frame).toContain('ambiguous before');
    app.unmount();
  });

  test('`j` moves the cursor between unassigned slices', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'unassigned',
      width: 160,
    });

    const before = app.state().diffSliceKey;
    await app.press('j');
    expect(app.state().diffSliceKey).not.toBe(before);
    expect(app.state().diffHunkKey).toBe('hunk_ambiguous_fixture');
    expect(app.frame()).toContain('Unassigned · Slice 2/2');
    app.unmount();
  });

  test('Enter descends into rows without leaving the canonical Unassigned page', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'unassigned',
      width: 160,
    });

    await app.press('\r');

    expect(app.state().screen).toBe('unassigned');
    expect(app.state().diffHunkKey).toBe('hunk_unassigned');
    expect(app.state().diffGrain).toBe('row');
    expect(app.frame()).toContain('Row 1/2');
    app.unmount();
  });

  test('`m` records a durable inspection of the unassigned rows', async () => {
    // Gating `mark-inspected` on the narrative model means that on the one branch
    // state where inspecting the unexplained rows IS the review, the key that
    // records it claims there is nothing selected.
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'unassigned',
      width: 160,
    });

    await app.press('m');
    await app.settleUntil((frame) => frame.includes('Unassigned work inspected'));

    const appended = app.journalEvents.filter((event) => event.type === 'unassigned');
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      action: 'MARK_INSPECTED',
      target: { kind: 'GAP_ROWS' },
    });
    app.unmount();
  });

  test('`m` on an ambiguous hunk records THAT hunk, not the gap rows', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'unassigned',
      width: 160,
    });

    await app.pressAll(['j', 'm']);
    await app.settleUntil((frame) => frame.includes('Unassigned work inspected'));

    const appended = app.journalEvents.filter((event) => event.type === 'unassigned');
    expect(appended[0]).toMatchObject({
      target: { kind: 'AMBIGUOUS_HUNK', hunkKey: 'hunk_ambiguous_fixture' },
    });
    app.unmount();
  });
});

/**
 * THE FUNCTIONAL BOUNDS GATE.
 *
 * Not "no frame stall" — a number. The Unassigned column is the longest in the
 * reader: the fixture's floor carries 4,057 unexplained rows, and an unwindowed
 * column mounts a <text> node for each, on every frame, while the reviewer holds
 * down `j`.
 *
 * Wall-clock budgets deliberately live in the dedicated production benchmark;
 * correctness suites assert only observable state and mounted geometry. Three
 * claims are independently falsifiable against the shared diff shell:
 *   · the mounted node count is BOUNDED, and does not grow with the row count;
 *   · the scrollbox preserves the full 4,057-row document height;
 *   · repeated keypresses continue to move the real cursor.
 */
describe('Unassigned remains functionally bounded at 4,057 rows', () => {
  const PASSES = 24;

  test('mounts a bounded band, not four thousand text nodes', async () => {
    const huge = await mountReviewApp({
      scenario: 'unassigned-huge',
      screen: 'unassigned',
      width: 160,
    });
    const small = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'unassigned',
      width: 160,
    });

    // The honest form of "bounded": 2,000x the rows must not be 2,000x the nodes.
    // Asserting a constant here would pass on an unwindowed column too, as long as
    // the constant was picked after the fact.
    expect(huge.diffNodeCount()).toBeLessThan(small.diffNodeCount() * 10);
    expect(huge.diffNodeCount()).toBeLessThan(400);

    huge.unmount();
    small.unmount();
  });

  test('keeps the full document height while mounting only a bounded window', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-huge',
      screen: 'unassigned',
      width: 160,
    });
    expect(app.scrollBounds().content).toBeGreaterThan(4_000);
    expect(app.diffNodeCount()).toBeLessThan(400);

    await app.press('G');
    const bounds = app.scrollBounds();
    expect(bounds.top).toBe(Math.max(0, bounds.content - bounds.viewport));

    app.unmount();
  });

  test('repeated `j` keypresses move the 4,057-row cursor and clamp the 2-row cursor', async () => {
    const huge = await mountReviewApp({
      scenario: 'unassigned-huge',
      screen: 'unassigned',
      width: 160,
    });
    const small = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'unassigned',
      width: 160,
    });
    await huge.press('return');
    await small.press('return');
    for (let pass = 0; pass < PASSES; pass += 1) {
      await huge.press('j');
      await small.press('j');
    }
    expect(huge.state().diffRowCursor).toBe(PASSES);
    expect(small.state().diffRowCursor).toBe(1);
    huge.unmount();
    small.unmount();
  });

  test('a short stacked terminal follows sustained row navigation in its real viewport', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-huge',
      screen: 'unassigned',
      width: 80,
      height: 12,
    });
    await app.press('return');
    expect(app.scrollBounds().viewport).toBe(3);
    expect(app.scrollBounds().content).toBeGreaterThan(4_000);
    for (let pass = 0; pass < 11; pass += 1) await app.press('j');

    expect(app.state().diffRowCursor).toBe(11);
    expect(app.frame()).toContain('unassigned row 12');
    app.unmount();
  });

  test('row-grain `j` reveals the measured source row in wrapped split and stack layouts', async () => {
    for (const layout of ['split', 'stack'] as const) {
      const app = await mountReviewApp({
        scenario: 'unassigned-huge',
        screen: 'unassigned',
        width: 80,
        height: 12,
      });
      await app.press('w');
      await app.press(layout === 'split' ? '1' : '2');
      await app.press('return');

      expect(app.state().diffGrain).toBe('row');
      expect(app.state().diffRowCursor).toBe(0);

      // Row two is intentionally 400 columns wide. With wrapping it occupies
      // several visual lines in either layout. Semantic navigation uses that
      // row's measured anchor and keeps the selected source row visible whether
      // the compact viewport must move or already contains its beginning.
      await app.press('j');

      expect(app.state().diffRowCursor).toBe(1);
      // Replacement wrap/layout geometry publishes asynchronously. Wait for its
      // bounded row callback instead of sampling the stable pre-publication frame
      // that a concurrently loaded mounted suite can briefly expose.
      expect(await app.settleUntil((frame) => frame.includes('unassigned row 2'))).toBe(true);

      await app.press('k');

      expect(app.state().diffRowCursor).toBe(0);
      expect(await app.settleUntil((frame) => frame.includes('unassigned row 1'))).toBe(true);
      app.unmount();
    }
  });
});
