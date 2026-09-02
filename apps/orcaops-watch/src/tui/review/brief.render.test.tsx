import { describe, expect, test } from 'bun:test';

import type { Floor } from '@orcaops/review-core';

import { briefPlaneGround } from './ReviewExperience';
import { buildBriefAttention } from './briefAttention';
import { buildFinishObligations } from './finishPresentation';
import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import {
  buildReviewAppHarness,
  loadedReviewJournalHarness,
  loadedReviewWithStoryFixture,
} from '../../../tests/review/reviewAppHarness';
import { buildFixtureReader } from '../../../tests/review/reviewExperienceFixtures';
import {
  buildStoryReviewHarnessFixture,
  storyOverlay,
} from '../../../tests/review/storyReviewHarness';

/**
 * The Brief, as the reviewer actually sees it.
 *
 * These assert on `app.frame()` — the characters a terminal would paint — and on
 * measured surface geometry, because every defect this screen had was invisible
 * to a model-level test: rows that rendered but no cursor could reach, a cursor
 * that walked past the end of what was drawn, and a pane that measured fine and
 * wrapped anyway.
 */

function selectedRows(app: Awaited<ReturnType<typeof mountReviewApp>>): string[] {
  return app.rows().filter((row) => row.includes('❯'));
}

/** Mount the Brief on the STORY lens, over the production-shaped v4 harness. */
async function mountStoryBrief(input: { width?: number; height?: number } = {}) {
  const fixture = buildStoryReviewHarnessFixture();
  const base = await buildReviewAppHarness({ scenario: 'no-narrative' });
  const routineStory = await storyOverlay(fixture.model, { runId: 'brief-story' });
  const loaded = await loadedReviewWithStoryFixture({
    base: base.loaded,
    floor: fixture.floor,
    reviewDiff: fixture.reviewDiff,
    routineStory,
  });
  const journal = await loadedReviewJournalHarness(loaded);
  const app = await mountReviewApp({
    scenario: 'no-narrative',
    width: input.width ?? 160,
    height: input.height ?? 44,
    initialLoadedOverride: journal.loaded,
    journalEffects: journal.journalEffects,
  });
  return { app, fixture };
}

describe('the Brief, as one two-pane surface', () => {
  test('gives each pane about half the terminal above the split threshold', async () => {
    for (const width of [110, 160, 220] as const) {
      const app = await mountReviewApp({
        scenario: 'no-narrative',
        screen: 'brief',
        width,
        height: 44,
      });
      const overview = app.surfaceRect('review-brief-overview');
      const tree = app.surfaceRect('review-brief-tree');

      const divider = app.surfaceRect('review-brief-pane-divider');

      expect(overview.x, `${width} overview x`).toBe(0);
      // The rule occupies the column the geometry already withheld from the
      // tree, so the panes keep their widths and the three sum to the terminal.
      expect(divider.x, `${width} divider x`).toBe(overview.width);
      expect(divider.width, `${width} divider width`).toBe(1);
      expect(tree.x, `${width} tree x`).toBe(overview.width + 1);
      // Neither pane dominates, and together they never exceed the terminal.
      expect(Math.abs(overview.width - tree.width), `${width} balance`).toBeLessThanOrEqual(2);
      expect(overview.width + divider.width + tree.width, `${width} total`).toBe(width);
      app.unmount();
    }
  });

  test('stacks with the TREE on top below the split threshold', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 80,
      height: 40,
    });
    const overview = app.surfaceRect('review-brief-overview');
    const tree = app.surfaceRect('review-brief-tree');

    // The tree holds initial focus, and a focused pane below the fold is a pane
    // the reviewer cannot see themselves moving in. This deliberately diverges
    // from `reviewReaderGeometry`, which stacks its rail above the diff.
    expect(tree.y).toBeLessThan(overview.y);
    expect(tree.x).toBe(overview.x);
    expect(tree.width).toBe(overview.width);
    app.unmount();
  });

  test('keeps warnings and staleness in the initial viewport beside a long queue', async () => {
    // ONE fixture carrying many attention rows AND warnings together. Separate
    // fixtures would not prove the thing that matters: that the attention row
    // budget leaves the warnings band room.
    for (const width of [110, 160] as const) {
      const app = await mountReviewApp({
        scenario: 'rail-overflow-floor-only',
        screen: 'brief',
        width,
        height: 44,
        staleFloor: true,
      });
      const frame = app.frame();
      const reader = buildFixtureReader(app.fixture);
      const queue = buildBriefAttention({
        reader,
        obligations: buildFinishObligations({ floor: app.fixture.source.floor, reader }),
      });

      expect(queue.length, `${width} queue`).toBeGreaterThan(6);
      expect(frame, `${width} coverage`).toContain('COVERAGE');
      expect(frame, `${width} trail`).toContain('CAPTURED TRAIL');
      expect(frame, `${width} warnings`).toContain('WARNINGS');
      expect(frame, `${width} staleness`).toContain('HEAD moved');
      app.unmount();
    }
  });

  test('fits its single-line facts without wrapping at the split threshold', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 110,
      height: 44,
      staleFloor: true,
    });
    const rows = app.rows();

    // A wrap is not cosmetic: it changes a row's height, which invalidates the
    // attention budget below it. Each fitted fact must occupy exactly one line,
    // so its distinctive tail may appear on that line and nowhere else.
    for (const marker of ['Reading ·', 'Selected ·', 'resolved']) {
      expect(
        rows.filter((row) => row.includes(marker)),
        marker
      ).toHaveLength(1);
    }
    // The tree's leaf keeps its churn on the same line as its label.
    const leaf = rows.find((row) => row.includes('cp1 ·'));
    expect(leaf).toBeDefined();
    expect(leaf).toContain('−');
    app.unmount();
  });
});

describe('the Brief tree, where only leaves are destinations', () => {
  test('a click on a group heading is inert', async () => {
    const { app } = await mountStoryBrief();
    const before = app.state();
    const heading = app.rows().findIndex((row) => row.includes('ACT 1 ·'));
    expect(heading).toBeGreaterThanOrEqual(0);
    const tree = app.surfaceRect('review-brief-tree');
    const column = tree.x + 4;

    await app.mockMouse.click(column, heading);
    await app.settle();

    // No route, no cursor move: a heading is not somewhere to go.
    expect(app.state().screen).toBe('brief');
    expect(app.state().briefCursor).toBe(before.briefCursor);
    expect(app.state().briefDestinationKey).toBe(before.briefDestinationKey);

    // And the same column IS live one row down, so the miss above was the
    // heading being inert rather than the click landing nowhere.
    await app.mockMouse.click(column, heading + 1);
    await app.settle();
    expect(app.state().screen).not.toBe('brief');
    app.unmount();
  });

  test('keyboard and pointer reach the same destination for every leaf', async () => {
    const keyboard = await mountStoryBrief();
    const leaves = keyboard.fixture.model.parts.length;
    expect(leaves).toBeGreaterThan(1);
    keyboard.app.unmount();

    for (let index = 0; index < leaves; index += 1) {
      const viaKeys = await mountStoryBrief();
      for (let step = 0; step < index; step += 1) await viaKeys.app.press('j');
      await viaKeys.app.press('\r');
      const keyed = viaKeys.app.state();
      viaKeys.app.unmount();

      const viaMouse = await mountStoryBrief();
      const target = viaMouse.app.surfaceRect(`review-brief-leaf-${index}`);
      await viaMouse.app.mockMouse.click(target.x + 1, target.y);
      await viaMouse.app.settle();
      const clicked = viaMouse.app.state();
      viaMouse.app.unmount();

      expect(clicked.screen, `leaf ${index} screen`).toBe(keyed.screen);
      expect(clicked.readerPage, `leaf ${index} page`).toBe(keyed.readerPage);
      expect(clicked.briefDestinationKey, `leaf ${index} key`).toBe(keyed.briefDestinationKey);
    }
  });

  test('scrolls a long tree and keeps the selected leaf on screen', async () => {
    const app = await mountReviewApp({
      scenario: 'rail-overflow-floor-only',
      screen: 'brief',
      width: 160,
      height: 20,
    });
    const destinations = app.state();
    expect(destinations.briefCursor).toBe(0);

    for (let step = 0; step < 40; step += 1) await app.press('j');

    // Wherever the clamp landed, that row is painted and it is the last one.
    expect(app.state().briefDestinationKey).toBe('finish');
    expect(selectedRows(app).length).toBeGreaterThan(0);
    expect(app.frame()).toContain('Finish');
    app.unmount();
  });
});

describe('the Brief’s meters', () => {
  test('each Act heading carries a completion meter', async () => {
    const { app } = await mountStoryBrief();
    const heading = app.rows().find((row) => row.includes('ACT 1 ·'));
    expect(heading).toBeDefined();
    // A ▓/░ completion bar and its count, right-aligned on the heading.
    expect(heading).toMatch(/[▓░]/u);
    expect(heading).toMatch(/\d+\/\d+/u);
    app.unmount();
  });

  test('OVERVIEW shows Progress and Plan as step-dot runs that fit', async () => {
    for (const width of [110, 160] as const) {
      const app = await mountReviewApp({
        scenario: 'no-narrative',
        screen: 'brief',
        width,
        height: 44,
      });
      // A painted row spans BOTH panes, so read only up to the pane rule —
      // otherwise the tree's churn column (`· +3 −0 · 2f`) is mistaken for an
      // overflow marker on the overview's row.
      const leftPane = (row: string | undefined) => (row ?? '').split('│')[0] ?? '';
      const rows = app.rows();
      // The tile above carries the count; the row carries the SHAPE of the run.
      const progress = leftPane(rows.find((row) => row.includes('Progress ·')));
      const plan = leftPane(rows.find((row) => row.includes('Plan ·')));

      expect(progress, `${width} progress`).not.toBe('');
      expect(progress).toMatch(/[●○]/u);
      expect(plan, `${width} plan`).not.toBe('');
      expect(plan).toMatch(/[●○]/u);
      // The run fits at these widths, so no truncation marker is drawn.
      expect(progress, `${width} progress overflow`).not.toContain(' +');
      expect(plan, `${width} plan overflow`).not.toContain(' +');
      app.unmount();
    }
  });

  test('the COVERAGE tile carries a mini-meter, and the bar is not duplicated', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    const rows = app.rows();

    // The tile pairs its percentage with a small meter …
    expect(rows.find((row) => /\d+% [▓░]+/u.test(row))).toBeDefined();
    // … while the full bar stays the COVERAGE band's alone.
    expect(rows.filter((row) => row.includes('matched ('))).toHaveLength(1);
    app.unmount();
  });

  test('the captured trail shows a segmented uncertainty meter when there is room', async () => {
    const app = await mountReviewApp({
      scenario: 'uncertainty-floor-only',
      screen: 'brief',
      width: 200,
      height: 44,
    });
    const line = app.rows().find((row) => row.includes('open') && row.includes('resolved'));
    expect(line).toBeDefined();
    expect(line).toMatch(/[▓░]/u);
    app.unmount();
  });
});

describe('the Brief’s page ground', () => {
  test('paints the page ground rather than the panel colour, and stays opaque', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    // The plane spans the viewport, so it IS the page ground. The footer is the
    // panel chrome. Painting them the same colour makes the Brief read lighter
    // than every other surface in the app.
    expect(app.surfaceBackground('review-screen-plane')).not.toEqual(
      app.surfaceBackground('review-footer')
    );
    // It must stay opaque: the plane exists so the previous screen cannot bleed
    // through on the way back.
    expect(app.surface('review-screen-plane').backgroundAlpha).toBe(1);
    app.unmount();
  });

  test('falls back to the panel colour rather than going transparent', () => {
    // A theme whose background is the literal 'transparent' would drop the
    // plane's alpha to zero and lose the anti-bleed cover.
    expect(briefPlaneGround({ background: '#0d1117' } as never, '#1e2329')).toBe('#0d1117');
    expect(briefPlaneGround({ background: 'transparent' } as never, '#1e2329')).toBe('#1e2329');
    expect(briefPlaneGround(undefined, '#1e2329')).toBe('#1e2329');
  });

  test('leaves every other Review screen’s plane unpainted', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 44,
    });
    // Only the brief branch paints a plane; the rest sit on ReviewApp's root.
    expect(app.surface('review-screen-plane').backgroundAlpha).toBe(0);
    app.unmount();
  });
});

describe('the Brief’s stat band', () => {
  test('names the deterministic vitals as tiles above the panes', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    const frame = app.frame();
    for (const label of ['SCOPE', 'PROGRESS', 'ATTENTION', 'UNCERTAINTY']) {
      expect(frame, label).toContain(label);
    }
    // Scope is a tile only — no flat line. Progress and Plan are step-dot rows —
    // the tile carries the count, the row carries the shape — so they are not
    // expected to be absent here.
    expect(frame).not.toContain('Review scope ·');
    // The band sits above both panes.
    const band = app.surfaceRect('review-brief-statband');
    const overview = app.surfaceRect('review-brief-overview');
    expect(band.y).toBeLessThan(overview.y);
    app.unmount();
  });

  test('names the Story vitals, including ownership and open items', async () => {
    const { app } = await mountStoryBrief();
    const frame = app.frame();
    // Story v4 records no change type and no composition outcomes; the
    // never-conflated ownership label and the open-item count are the v4 facts
    // that carry the same triage weight.
    for (const label of ['PARTS', 'OWNERSHIP', 'ATTENTION', 'ITEMS', 'UNCERTAINTY']) {
      expect(frame, label).toContain(label);
    }
    expect(frame).toContain('derived');
    app.unmount();
  });

  test('keeps its fixed height without wrapping across widths', async () => {
    for (const width of [80, 110, 160] as const) {
      const app = await mountReviewApp({
        scenario: 'no-narrative',
        screen: 'brief',
        width,
        height: 44,
      });
      // The band sheds tiles rather than wrapping, so it never grows past its
      // four rows — a wrap would silently eat into the panes' height budget.
      expect(app.surfaceRect('review-brief-statband').height, `${width}`).toBe(4);
      app.unmount();
    }
  });

  test('separates its tiles with a rule and breathes above and between', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    const rows = app.rows();
    const labels = rows.findIndex((row) => row.includes('SCOPE'));

    expect(labels).toBeGreaterThan(0);
    // A rule stands between adjacent tiles.
    expect(rows[labels]).toContain('│');
    // A wholly blank row off the menu bar — the rules start below it.
    expect(rows[labels - 1]?.trim()).toBe('');
    // The row between labels and values carries the rules and nothing else, so
    // the two lines of every tile are separated.
    expect(rows[labels + 1]).toContain('│');
    expect(rows[labels + 1]?.replaceAll('│', '').trim()).toBe('');
    // The values land two rows below their labels.
    expect(rows[labels + 2]?.trim()).not.toBe('');
    app.unmount();
  });
});

describe('the Brief’s quieter rows', () => {
  test('caps the attention queue so the bands stay off the floor on a tall terminal', async () => {
    // A dozen open captured uncertainties become a dozen finish obligations, so
    // the deterministic queue itself overflows the cap.
    const app = await mountReviewApp({
      scenario: 'rail-overflow-floor-only',
      screen: 'brief',
      width: 160,
      height: 60,
      staleFloor: true,
    });
    const rows = app.rows();

    // There is room to paint every row, and the queue still stops at its cap
    // and offers the remainder behind `n` — so the bands are not pushed down.
    expect(app.frame()).toContain('more · n/N select');
    const coverage = rows.findIndex((row) => row.includes('▸ COVERAGE'));
    const warnings = rows.findIndex((row) => row.includes('▸ WARNINGS'));

    expect(coverage).toBeGreaterThan(0);
    expect(warnings).toBeGreaterThan(coverage);
    expect(coverage, 'COVERAGE pushed to the floor').toBeLessThan(30);
    app.unmount();
  });

  test('leaves never badge the raw blocker kind', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    // Every checkpoint of a fresh review carries the `rows` blocker, so badging it
    // would print `rows…` on every line of the tree.
    expect(app.frame()).not.toContain('rows…');
    app.unmount();
  });
});

describe('the Brief panes, and which one the keys move', () => {
  test('Tab switches panes and j moves only the focused one', async () => {
    const app = await mountReviewApp({
      scenario: 'rail-overflow-floor-only',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    // The Brief lands on its TREE, which is the right pane on every screen.
    expect(app.state().focus).toBe('diff');

    await app.press('j');
    const movedTree = app.state();
    expect(movedTree.briefCursor).toBe(1);
    expect(movedTree.attentionCursor).toBe(0);

    await app.press('\t');
    expect(app.state().focus).toBe('rail');
    await app.press('j');
    const movedAttention = app.state();
    // The tree cursor did NOT follow: each pane owns its own selection.
    expect(movedAttention.briefCursor).toBe(1);
    expect(movedAttention.attentionCursor).toBe(1);
    expect(movedAttention.attentionRowKey).not.toBeNull();
    app.unmount();
  });

  test('← names the overview and → the tree, and neither toggles', async () => {
    const app = await mountReviewApp({
      scenario: 'rail-overflow-floor-only',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    expect(app.state().focus).toBe('diff');

    await app.press('left');
    expect(app.state().focus).toBe('rail');
    // Directional, not a toggle: the arrow NAMES a pane, so pressing it again
    // stays there rather than bouncing back the way ⇥ would.
    await app.press('left');
    expect(app.state().focus).toBe('rail');

    await app.press('right');
    expect(app.state().focus).toBe('diff');
    await app.press('right');
    expect(app.state().focus).toBe('diff');
    app.unmount();
  });

  test('the arrows keep naming the same panes where the layout stacks them', async () => {
    // Below the split threshold the panes are stacked, not side by side — the
    // tree ABOVE the overview. The binding deliberately does not follow the
    // geometry: `←` still means the overview and `→` the tree, because a key
    // that changes meaning with terminal width is worse than one that is
    // spatially imprecise on a narrow terminal.
    const app = await mountReviewApp({
      scenario: 'rail-overflow-floor-only',
      screen: 'brief',
      width: 80,
      height: 40,
    });
    const overview = app.surfaceRect('review-brief-overview');
    const tree = app.surfaceRect('review-brief-tree');
    expect(tree.y).toBeLessThan(overview.y);

    expect(app.state().focus).toBe('diff');
    await app.press('left');
    expect(app.state().focus).toBe('rail');
    await app.press('right');
    expect(app.state().focus).toBe('diff');
    app.unmount();
  });

  test('→ moves focus instead of opening, leaving ↵ as the Brief’s one open', async () => {
    const app = await mountReviewApp({
      scenario: 'rail-overflow-floor-only',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    // From the tree — where a destination IS selected — `→` moves focus and stays
    // on the Brief rather than routing.
    await app.press('right');
    expect(app.state().screen).toBe('brief');
    expect(app.state().routeHistory).toHaveLength(0);

    // ↵ on the same selection is the one open.
    await app.press('\r');
    expect(app.state().screen).not.toBe('brief');
    app.unmount();
  });

  test('→ walks back to the tree after n moved focus to the queue', async () => {
    const app = await mountReviewApp({
      scenario: 'attention-rich',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    await app.press('n');
    expect(app.state().focus).toBe('rail');
    const selected = app.state().attentionRowKey;
    expect(selected).not.toBeNull();
    const filled = app.surfaceBackground('review-brief-attention-0');

    // The whole point of the arrows: the pane `n` moved focus to is one
    // keystroke from the tree again, and the selection it left behind survives.
    await app.press('right');
    expect(app.state().focus).toBe('diff');
    expect(app.state().attentionRowKey).toBe(selected);
    expect(app.surfaceBackground('review-brief-attention-0')).toEqual(filled);
    app.unmount();
  });

  test('fills the focused pane’s selected row and leaves the blurred pane’s unfilled', async () => {
    const app = await mountReviewApp({
      scenario: 'attention-rich',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    // The tree's fill still follows focus, but the attention selection stays
    // filled from EITHER pane — under the two-step n/N contract the selection
    // must stay visible after focus returns to the tree, or the reviewer loses
    // what ↵ would open.
    expect(app.state().focus).toBe('diff');
    const treeLeaf = app.surfaceBackground('review-brief-leaf-0');
    const treeAttn = app.surfaceBackground('review-brief-attention-0');

    await app.press('\t');
    expect(app.state().focus).toBe('rail');
    const railLeaf = app.surfaceBackground('review-brief-leaf-0');
    const railAttn = app.surfaceBackground('review-brief-attention-0');
    // The leaf's fill follows focus; the attention fill is focus-independent.
    expect(treeLeaf).not.toEqual(railLeaf);
    expect(railAttn).toEqual(treeAttn);
    app.unmount();
  });

  test('the footer names the Brief’s own panes, not diff and rail', async () => {
    const floor = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    expect(floor.frame()).toContain('⇥ overview');
    await floor.press('\t');
    expect(floor.frame()).toContain('⇥ checkpoints');
    floor.unmount();

    const story = await mountStoryBrief();
    await story.app.press('\t');
    expect(story.app.frame()).toContain('⇥ parts');
    story.app.unmount();
  });

  test('n selects visibly without routing; Enter opens the selection', async () => {
    const app = await mountReviewApp({
      scenario: 'attention-rich',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    await app.press('j');
    const before = app.state();
    expect(before.briefCursor).toBe(1);

    await app.press('n');
    // Two-step: the first press SELECTS — still on the Brief, focus on the
    // overview pane so the highlight is visible — and never moves the tree.
    expect(app.state().screen).toBe('brief');
    expect(app.state().focus).toBe('rail');
    expect(app.state().attentionCursor).toBe(0);
    expect(app.state().attentionRowKey).not.toBeNull();
    expect(app.state().briefCursor).toBe(before.briefCursor);
    expect(app.state().briefDestinationKey).toBe(before.briefDestinationKey);
    // The orientation row mirrors the selection instead of advancing past it.
    expect(app.frame()).toContain('Selected ·');

    // Further presses keep selecting (never routing); Enter opens.
    await app.press('n');
    expect(app.state().screen).toBe('brief');
    await app.press('\r');
    expect(app.state().screen).not.toBe('brief');
    app.unmount();
  });

  test('n selects the first obligation from a fresh Brief on the deterministic lens too', async () => {
    // `n` selects on the deterministic lens too — the floor's finish obligations
    // are its attention queue.
    const app = await mountReviewApp({
      scenario: 'uncertainty-floor-only',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    expect(app.state().attentionRowKey).toBeNull();

    await app.press('n');
    expect(app.state().screen).toBe('brief');
    expect(app.state().attentionCursor).toBe(0);
    expect(app.state().attentionRowKey).toStartWith('obligation:');
    // Enter routes the selected obligation (the finish modal or its screen).
    await app.press('\r');
    expect(app.state().screen).not.toBe('brief');
    app.unmount();
  });

  test('a single-item queue selects its sole item and Enter opens it', async () => {
    const app = await mountReviewApp({
      scenario: 'sole-part',
      screen: 'brief',
      width: 160,
      height: 44,
    });
    const reader = buildFixtureReader(app.fixture);
    expect(
      buildBriefAttention({
        reader,
        obligations: buildFinishObligations({ floor: app.fixture.source.floor, reader }),
      })
    ).toHaveLength(1);

    await app.press('n');
    expect(app.state().screen).toBe('brief');
    expect(app.state().attentionCursor).toBe(0);
    await app.press('\r');
    expect(app.state().screen).not.toBe('brief');
    app.unmount();
  });
});

describe('the Brief’s selection, across a data change', () => {
  test('restores a leaf by KEY when the list around it changes', async () => {
    const twoPages = await buildReviewAppHarness({ scenario: 'two-checkpoints' });
    const onePage = await buildReviewAppHarness({ scenario: 'no-narrative' });
    let data = twoPages.loaded.data;
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      autoLoad: true,
      reviewLoader: async () => data,
      width: 160,
      height: 44,
    });
    await app.settleUntil((frame) => frame.includes('CAPTURED WORK'));

    // Move by plain `j` — NOT by activating. A cursor/key drift would hide
    // behind the activation paths, which write both fields explicitly.
    await app.press('j');
    expect(app.state().briefCursor).toBe(1);
    const selected = app.state().briefDestinationKey;
    expect(selected).toStartWith('checkpoint:');

    data = onePage.loaded.data;
    await app.liveRefresh();
    await app.settle();

    // The selected checkpoint is gone. The cursor clamps AND adopts the
    // fallback row's key, so the pair never drifts apart.
    const after = app.state();
    expect(after.briefDestinationKey).not.toBe(selected);
    expect(after.briefDestinationKey).not.toBeNull();
    expect(after.briefCursor).toBeLessThan(2);
    expect(selectedRows(app).length).toBeGreaterThan(0);
    app.unmount();
  });

  test('drops a Back destination whose evidence vanished instead of rewriting it', async () => {
    const twoPages = await buildReviewAppHarness({ scenario: 'two-checkpoints' });
    const emptied = await buildReviewAppHarness({ scenario: 'two-checkpoints' });
    // A floor with no retained hunks at all: nothing a history entry could be
    // reconciled onto. Silently rewriting it to the first hunk is the failure.
    const floor = structuredClone(emptied.loaded.data.floor) as Floor;
    floor.coverage.items = [];

    let data = twoPages.loaded.data;
    const app = await mountReviewApp({
      scenario: 'two-checkpoints',
      autoLoad: true,
      reviewLoader: async () => data,
      width: 160,
      height: 44,
    });
    await app.settleUntil((frame) => frame.includes('CAPTURED WORK'));
    await app.press('\r');
    expect(app.state().screen).toBe('floor-diff');
    const anchored = app.state().diffHunkKey;
    expect(anchored).not.toBeNull();

    data = { ...emptied.loaded.data, floor };
    await app.liveRefresh();
    await app.settle();

    // The evidence this route was anchored to no longer exists on the floor. Rather
    // than silently rewriting it to an unrelated first hunk, the reviewer is
    // returned to the Brief and TOLD.
    const after = app.state();
    expect(floor.coverage.items).toHaveLength(0);
    expect(after.screen).toBe('brief');
    expect(after.notice).toBe('The requested evidence is no longer represented in this reader');
    app.unmount();
  });
});
