// EVERY ADVERTISED KEY DOES SOMETHING.
//
// The keymap is the product's promise to the reviewer: these keys work, on this
// screen. A key that is advertised and inert is worse than a missing one — the
// reviewer presses it, sees nothing, and concludes the tool is broken rather than
// that the key is. So the promise has to be checked against the product.
//
// This enumerates BOTH exports, on every screen that advertises them, under BOTH
// lenses, and asserts each consumed key produces an OBSERVABLE EFFECT: a changed
// frame, a durable append, a clipboard write, an $EDITOR spawn, an exit. Never "a
// command was emitted" — a command is an intention, and the regression this suite
// exists to catch is intentions that render nothing.
//
// The visible command registry includes the global keys too, deliberately. A
// test that walked only the per-screen table would miss global drift.

import { describe, expect, test } from 'bun:test';

import {
  selectVisibleReviewCommands,
  type StoryReviewLens,
  type StoryReviewScreen,
} from './keymap';
import { type MountedReviewApp, mountReviewApp } from '../../../tests/review/mountReviewApp';
import {
  buildReviewAppHarness,
  loadedReviewJournalHarness,
  loadedReviewWithStoryFixture,
  multiRowHarnessDiff,
  tallHarnessDiff,
} from '../../../tests/review/reviewAppHarness';
import type { WatchReviewFixtureScenario } from '../../../tests/review/reviewExperienceFixtures';
import {
  buildStoryReviewHarnessFixture,
  storyOverlay,
} from '../../../tests/review/storyReviewHarness';
import type { EnrichedComment } from '../../data/commentsSource';

/**
 * The glyph the keymap shows the reviewer → the name `mountReviewApp.press`
 * resolves to a real terminal code.
 *
 * Going through the NAMED keys rather than hand-writing escape sequences here is
 * deliberate: an arrow code missing its ESC prefix is typed as the literal
 * characters `[`, `A` and reports the key as dead.
 */
const KEY_CODE: Readonly<Record<string, string>> = {
  '↵': 'return',
  '→': 'right',
  '←': 'left',
  '↑': 'up',
  '↓': 'down',
  '⇥': 'tab',
  esc: 'escape',
  space: ' ',
  pgup: 'pageup',
  pgdn: 'pagedown',
  'S-←': 'shift-left',
  'S-→': 'shift-right',
};

/** The Walk's rail and item keys — they need Parts and open items, not a tall column. */

/**
 * Extra keys pressed before a given key, so that key has somewhere to act FROM.
 *
 * `k` at the top of a list is a correct no-op, not a dead key — as is `u` on a
 * column that is already scrolled to the top. Testing an upward key from the top
 * measures nothing and reports a false death.
 */
const WARMUP_FOR: Readonly<Record<string, readonly string[]>> = {
  k: ['j'],
  '↑': ['j'],
  u: ['f'],
  'C-u': ['f'],
  b: ['f'],
  pgup: ['f'],
  g: ['f'],
  'C-l': ['f'],
  '1': ['2'],
  '0': ['2'],
  'S-←': ['shift-right'],
};

/**
 * Keys whose warmup REPLACES the screen's, because the screen's would put them
 * somewhere they have nothing to do.
 *
 * `↵`/`→` DESCEND into rows, so they must be pressed AT hunk grain — the diff
 * screen's own warmup already descends, and Enter at row grain on a hunk that owns
 * one row is a correct no-op (you are already on that row). `j` alone selects the
 * tall hunk and stays at hunk grain, which is where Enter means something.
 */
const WARMUP_INSTEAD: Readonly<Record<string, readonly string[]>> = {
  // The Brief opens on its TREE, which is the pane `→` names — pressed from
  // there it is a correct no-op, so press `←` first to be somewhere it moves
  // FROM. (`←` needs no warmup: the tree is where it moves from.)
  '→:brief': ['left'],
  '↵:floor-diff': ['j'],
  '→:floor-diff': ['j'],
  '↵:unassigned': [],
  '→:unassigned': [],
  'Y:unassigned': ['j'],
  'a:floor-diff': ['tab'],
  'r:floor-diff': ['tab'],
  'd:floor-diff': ['tab'],
  'o:floor-diff': ['tab'],
};

/**
 * Keys whose no-op is CORRECT, with the reason named.
 *
 * This list is the only place a key is allowed to do nothing, and every entry
 * says why. It is short on purpose: an escape hatch that grows is a keymap that
 * has stopped being a promise.
 */
const CONDITIONAL: Readonly<Record<string, string>> = {
  // The complete fixtures intentionally have no Finish obligations. These keys
  // select an obligation when the gate is blocked; with an empty list there is
  // no valid cursor movement to observe.
  'j:finish': 'the complete fixture has no Finish obligations',
  'k:finish': 'the complete fixture has no Finish obligations',
  '↑:finish': 'the complete fixture has no Finish obligations',
  '↓:finish': 'the complete fixture has no Finish obligations',
  // The attention queue ranks open narrative items. With no Story there are none,
  // so there is nothing to jump between.
  'n:deterministic': 'attention queue is narrative-only',
  'N:deterministic': 'attention queue is narrative-only',
  // A LONE ESC BYTE CANNOT BE DRIVEN THROUGH mockInput — it is the prefix of every
  // CSI sequence, so the parser cannot know it is a key until something else
  // arrives, and nothing does. The PTY drives a real `\033` at 80/110/160.
  esc: 'lone ESC is undeliverable through mockInput — covered by controller and PTY tests',
  'u:unassigned:story': 'three units — the column fits the viewport',
  'C-u:unassigned:story': 'three units — the column fits the viewport',
  'D:unassigned:story': 'three units — the column fits the viewport',
  'C-d:unassigned:story': 'three units — the column fits the viewport',
  'b:unassigned:story': 'three units — the column fits the viewport',
  'pgup:unassigned:story': 'three units — the column fits the viewport',
  'f:unassigned:story': 'three units — the column fits the viewport',
  'space:unassigned:story': 'three units — the column fits the viewport',
  'pgdn:unassigned:story': 'three units — the column fits the viewport',
  'g:unassigned:story': 'three units — the column fits the viewport',
  'G:unassigned:story': 'three units — the column fits the viewport',
  'C-l:unassigned:story': 'three units — the column fits the viewport',
};

interface Observation {
  frame: string;
  screen: string;
  journal: number;
  comments: number;
  clipboard: number;
  exits: number;
}

function observe(app: MountedReviewApp): Observation {
  return {
    frame: app.frame(),
    screen: app.state().screen,
    journal: app.journalEvents.length,
    comments: app.sidecar().length,
    clipboard: app.clipboardWrites().length,
    exits: app.exits(),
  };
}

/** What changed, in the reviewer's terms. Never "a command was emitted". */
function effectsOf(before: Observation, after: Observation): string[] {
  const effects: string[] = [];
  if (before.frame !== after.frame) effects.push('frame');
  if (before.journal !== after.journal) effects.push('journal');
  if (before.comments !== after.comments) effects.push('comment');
  if (before.clipboard !== after.clipboard) effects.push('clipboard');
  if (before.exits !== after.exits) effects.push('exit');
  return effects;
}

/**
 * Two comments in the sidecar, so the comments screen has a list to walk.
 *
 * Built to the real `EnrichedComment` shape — `ts` and `threadKey` included. A
 * hand-rolled one behind an `as unknown as` cast renders nothing and makes every
 * key on the screen look dead, which is the failure mode this suite exists to
 * catch: a fixture that cannot express the state, reporting on the state.
 */
function comment(id: string, line: number, author: 'reviewer' | 'agent'): EnrichedComment {
  return {
    comment_id: id,
    ts: '2026-01-01T00:00:00.000Z',
    author,
    body: `comment on line ${line}`,
    status: 'open',
    anchor: { kind: 'DIFF_LINE', file: 'src/fixture.ts', side: 'add', line },
    replies: [],
    context: [],
    owner: null,
    trail: [],
    position: {
      rung: 'exact',
      file: 'src/fixture.ts',
      side: 'add',
      line,
      endLine: null,
      hunkKey: 'hunk_fixture',
      threadKey: null,
      drifted: false,
    },
  } as unknown as EnrichedComment;
}

const SIDECAR: readonly EnrichedComment[] = [
  comment('comment_one', 1, 'reviewer'),
  comment('comment_two', 2, 'agent'),
];

/** The keys a screen advertises, per-screen map plus the globals. */
function advertisedKeys(screen: StoryReviewScreen, lens: StoryReviewLens): string[] {
  return selectVisibleReviewCommands(screen, { atRoot: screen === 'brief' }, lens).flatMap(
    (command) => [...command.gestures]
  );
}

/**
 * Screens, the fixture that puts a reviewer on each, and the keys pressed to get
 * them somewhere a key can actually DO something.
 *
 * `warmup` is load-bearing, and it is the mirror image of the failure above. A
 * fixture too SMALL to show an effect makes a working key look dead:
 * `k` at the top of a list, `f` on a list that already fits the viewport, `,` in a
 * change that touches one file. Those are correct no-ops, and a sweep that starts
 * every key at index 0 on a three-row fixture reports six false deaths and buries
 * the two real ones. So the sweep starts each screen where the reviewer would
 * actually be: scrolled in, cursor moved, something selected.
 */
const SCREENS: ReadonlyArray<{
  screen: StoryReviewScreen;
  lens: StoryReviewLens;
  scenario: WatchReviewFixtureScenario;
  warmup: readonly string[];
  /** Put comments in the sidecar — the comments screen needs some to have a cursor. */
  comments?: boolean;
  /** Override the patch, for screens that need a column with room to move in. */
  reviewDiff?: string;
  /** Enumerate ONLY these keys (the rest are covered by the paired entry). */
  only?: readonly string[];
  /** Enumerate everything EXCEPT these. */
  skip?: readonly string[];
}> = [
  // Cursor moved off the top so `k`/`↑` have somewhere to go back to.
  // No base warmup: Brief has two rows here, so parking the cursor at the bottom
  // would make `j` look dead. `k`/`↑` get their own warmup from WARMUP_FOR.
  { screen: 'brief', lens: 'deterministic', scenario: 'unassigned-floor-only', warmup: [] },
  // 4,057 rows, so paging, `g`/`G` and the cursor all have room to move.
  { screen: 'unassigned', lens: 'deterministic', scenario: 'unassigned-huge', warmup: [] },
  {
    screen: 'comments',
    lens: 'deterministic',
    scenario: 'no-narrative',
    warmup: [],
    comments: true,
  },
  { screen: 'finish', lens: 'deterministic', scenario: 'complete-floor-only', warmup: [] },
  { screen: 'flat-files', lens: 'deterministic', scenario: 'no-narrative', warmup: ['j'] },
  // Into the diff, at row grain, with a span selected — the state where `Y`, `v`,
  // `z`/`Z` and the row keys all have something to act on.
  // A TALL hunk across two files. Movement, paging, `g`/`G` and `,`/`.` all need
  // somewhere to go: in a two-row hunk every one of them is a correct no-op, and a
  // sweep run against one reports thirteen false deaths.
  {
    screen: 'floor-diff',
    lens: 'deterministic',
    scenario: 'no-narrative',
    // `j` first, at HUNK grain, to land on the TALL hunk — the diff's first hunk
    // owns a single row, so Enter/←/row-movement have nowhere to go inside it.
    warmup: ['j', '\r', 'j'],
    reviewDiff: tallHarnessDiff(240),
    // This fixture is tall because it has 239 subdued context rows but only one
    // owned row. Semantic row navigation makes `j` at that row's boundary a correct
    // no-op. Prove the row keys against the paired two-owned-row fixture below.
    skip: ['i', 'j', 'k', '↑', '↓'],
  },
  {
    screen: 'floor-diff',
    lens: 'deterministic',
    scenario: 'wide-hunk',
    warmup: ['\r'],
    reviewDiff: multiRowHarnessDiff(),
    only: ['j', 'k', '↑', '↓'],
  },
  {
    screen: 'floor-diff',
    lens: 'deterministic',
    scenario: 'two-checkpoints',
    warmup: ['j'],
    only: ['i'],
  },
];

describe('every key the keymap advertises produces an observable effect', () => {
  for (const entry of SCREENS) {
    const { screen, lens, scenario, warmup, comments, reviewDiff, only, skip } = entry;
    test(`${screen} · ${lens} · ${scenario}`, async () => {
      const dead: string[] = [];
      const swept: string[] = [];

      for (const glyph of new Set(advertisedKeys(screen, lens))) {
        // `q` changes navigation depth and `?` opens a modal that swallows the next
        // key; both are asserted on their own below rather than mid-sweep, where
        // they would change the app the remaining keys are being pressed against.
        if (glyph === 'q' || glyph === '?') continue;
        if (only !== undefined && !only.includes(glyph)) continue;
        if (skip !== undefined && skip.includes(glyph)) continue;
        if (CONDITIONAL[glyph] !== undefined) continue;
        if (CONDITIONAL[`${glyph}:${lens}`] !== undefined) continue;
        if (CONDITIONAL[`${glyph}:${screen}`] !== undefined) continue;
        if (CONDITIONAL[`${glyph}:${screen}:${lens}`] !== undefined) continue;
        swept.push(glyph);

        const app = await mountReviewApp({
          scenario,
          screen,
          width: 160,
          ...(comments === true ? { comments: SIDECAR } : {}),
          ...(reviewDiff !== undefined ? { reviewDiff } : {}),
        });
        const pre = WARMUP_INSTEAD[`${glyph}:${screen}`] ?? [
          ...warmup,
          ...(WARMUP_FOR[glyph] ?? []),
        ];
        if (pre.length > 0) await app.pressAll(pre);
        const before = observe(app);
        await app.press(KEY_CODE[glyph] ?? glyph);
        const effects = effectsOf(before, observe(app));
        app.unmount();

        if (effects.length === 0) dead.push(glyph);
      }

      expect(dead).toEqual([]);
      // An `only` list is a promise, not a filter: every listed key must have
      // actually been exercised, so a key that stops being advertised fails
      // loudly instead of silently vanishing from the sweep.
      if (only !== undefined) {
        expect([...swept].sort()).toEqual([...only].sort());
      }
      // Each screen mounts a fresh app PER KEY — up to thirty of them, some over a
      // 240-row diff. That is deliberate: a key pressed after another key is a key
      // tested in whatever state the previous one left behind, and this sweep exists
      // to find keys that do nothing, not to discover that `g` works only after `f`.
      // The cost is wall-clock, and under a loaded suite it exceeds the 5s default.
    }, 60_000);
  }

  test('q backs out one nested level and exits Review only from its Brief', async () => {
    const nested = await mountReviewApp({ scenario: 'no-narrative', screen: 'comments' });
    const nestedBefore = observe(nested);
    await nested.press('q');
    expect(observe(nested)).toMatchObject({
      screen: 'brief',
      exits: nestedBefore.exits,
      journal: nestedBefore.journal,
    });
    nested.unmount();

    const root = await mountReviewApp({ scenario: 'no-narrative', screen: 'brief' });
    const rootBefore = observe(root);
    await root.press('q');
    const rootAfter = observe(root);
    expect(rootAfter.exits).toBe(rootBefore.exits + 1);
    expect(rootAfter.journal).toBe(rootBefore.journal);
    root.unmount();
  });

  test('every Walk paging key moves the tall Part hunk on the REAL Story Walk', async () => {
    // The generic sweep cannot mount the Story reader (its entries mount by
    // scenario, and without a Story overlay the app falls back to the
    // deterministic projection). Paging keys therefore use a Story overlay
    // whose Part-1 hunk is 200 rows tall, enter from the Brief onto the real
    // Walk surface, and require an observable effect from a fresh mount per
    // key. Dedicated interaction suites cover semantic keys whose movement,
    // comment, and part actions require per-key fixture state.
    const WALK_PAGING = [
      'u',
      'C-u',
      'D',
      'C-d',
      'b',
      'pgup',
      'f',
      'space',
      'pgdn',
      'g',
      'G',
      'C-l',
      'w',
    ] as const;
    const dead: string[] = [];
    for (const glyph of WALK_PAGING) {
      const fixture = buildStoryReviewHarnessFixture({ tallP1Rows: 200 });
      const base = await buildReviewAppHarness({ scenario: 'no-narrative' });
      const routineStory = await storyOverlay(fixture.model, {
        runId: 'keymap-walk-paging',
        installationToken: 'keymap-walk-paging-install',
      });
      const loaded = await loadedReviewWithStoryFixture({
        base: base.loaded,
        floor: fixture.floor,
        reviewDiff: fixture.reviewDiff,
        routineStory,
      });
      const journal = await loadedReviewJournalHarness(loaded);
      const app = await mountReviewApp({
        scenario: 'no-narrative',
        width: 160,
        height: 40,
        initialLoadedOverride: journal.loaded,
        journalEffects: journal.journalEffects,
        controllerState: {
          screen: 'walk',
          readerPage: 0,
          preferredLens: 'story',
          focus: 'diff',
        },
      });
      // The surface under test must BE the Story Walk on the tall Part hunk.
      expect(app.state()).toMatchObject({ screen: 'walk' });
      expect(app.frame()).toContain('hunk_story_owned_p1 row 1');
      const warmup = WARMUP_FOR[glyph] ?? [];
      if (warmup.length > 0) await app.pressAll(warmup);
      const before = observe(app);
      await app.press(KEY_CODE[glyph] ?? glyph);
      if (effectsOf(before, observe(app)).length === 0) dead.push(glyph);
      app.unmount();
    }
    expect(dead).toEqual([]);
  }, 120_000);

  test('? opens help, and help renders the keys it claims to', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', screen: 'brief', width: 160 });
    await app.press('?');

    const frame = app.frame();
    expect(frame).toContain('Here · Review overview');
    expect(frame).toContain('Anywhere in Review');
    // Context-aware: the overview must not advertise another lens's screen.
    expect(frame).not.toContain('Walk');
    app.unmount();
  });
});
