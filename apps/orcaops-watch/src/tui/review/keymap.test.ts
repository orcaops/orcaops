import { describe, expect, it } from 'vitest';

import { commandGestureCollisions } from '../commandRegistry';
import {
  REVIEW_COMMAND_IDS,
  REVIEW_COMMANDS,
  selectReviewCommands,
  selectStoryReviewFooterLayout,
  selectVisibleReviewCommands,
  STALE_STORY_SUPPRESSED_COMMANDS,
  STORY_REVIEW_GLOBAL_KEYS,
  STORY_REVIEW_KEYMAP,
  storyReviewHelpSections,
  type StoryReviewScreen,
} from './keymap';

const SCREENS = Object.keys(STORY_REVIEW_KEYMAP) as StoryReviewScreen[];

describe('final Story review keymap', () => {
  it('has one table for all final screens with no duplicate screen binding', () => {
    expect([...SCREENS].sort()).toEqual([
      'brief',
      'captured-context',
      'comments',
      'finish',
      'flat-files',
      'floor-diff',
      'unassigned',
      'walk',
    ]);
    for (const screen of SCREENS) {
      const seen = new Set<string>();
      for (const binding of STORY_REVIEW_KEYMAP[screen]) {
        for (const key of binding.keys) {
          expect(seen.has(key), `${screen} binds ${key} twice`).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it('registers every advertised shortcut under one stable identity', () => {
    expect(new Set(REVIEW_COMMAND_IDS).size).toBe(REVIEW_COMMAND_IDS.length);
    expect(REVIEW_COMMANDS.map((command) => command.id)).toEqual([...REVIEW_COMMAND_IDS]);

    const registered = new Set(REVIEW_COMMAND_IDS);
    for (const binding of [
      ...Object.values(STORY_REVIEW_KEYMAP).flat(),
      ...STORY_REVIEW_GLOBAL_KEYS,
    ]) {
      expect(registered.has(binding.id), `${binding.id} is not registered`).toBe(true);
    }
  });

  it('has no distinct command collision in any effective screen context', () => {
    for (const screen of SCREENS) {
      expect(commandGestureCollisions(selectVisibleReviewCommands(screen)), screen).toEqual([]);
    }
  });

  it('projects contextual Help, footer, and future palette rows from the same IDs', () => {
    for (const screen of SCREENS) {
      const helpIds = new Set(selectReviewCommands(screen, 'help').map((command) => command.id));
      const paletteIds = new Set(
        selectReviewCommands(screen, 'palette').map((command) => command.id)
      );
      expect(helpIds).toEqual(paletteIds);
      for (const footer of selectReviewCommands(screen, 'footer')) {
        expect(
          helpIds.has(footer.id),
          `${screen} footer command ${footer.id} missing from Help`
        ).toBe(true);
      }
    }
  });

  it('advertises spatial Left separately from cancel/Back and Watch exit', () => {
    const nested = selectVisibleReviewCommands('walk', { atRoot: false });
    expect(nested.find((command) => command.id === 'review.back-or-watch')).toMatchObject({
      gestures: ['q'],
      shortLabel: 'back',
      helpLabel: 'Back One Review Level',
    });
    expect(nested.find((command) => command.id === 'review.back')).toMatchObject({
      gestures: ['esc'],
      shortLabel: 'back',
      helpLabel: 'Cancel Current Mode or Back',
    });
    expect(nested.find((command) => command.id === 'review.walk.left-pane')).toMatchObject({
      gestures: ['←'],
      helpLabel: 'Move focus left to review context',
    });

    const root = selectVisibleReviewCommands('brief', { atRoot: true });
    expect(root.find((command) => command.id === 'review.back')).toMatchObject({
      gestures: ['esc'],
      shortLabel: 'Watch',
      helpLabel: 'Back to Watch',
    });
    expect(root.find((command) => command.id === 'review.back-or-watch')).toMatchObject({
      gestures: ['q'],
      shortLabel: 'Watch',
      helpLabel: 'Back to Watch',
    });
    expect(
      selectStoryReviewFooterLayout('brief', 'rail', Number.MAX_SAFE_INTEGER, { atRoot: true })
        .parts
    ).toContain('q back to Watch');
    expect(
      selectStoryReviewFooterLayout('walk', 'rail', Number.MAX_SAFE_INTEGER, { atRoot: false })
        .parts
    ).toContain('q back');
  });

  it('pins the controls the reader is built around', () => {
    const walk = new Map(
      STORY_REVIEW_KEYMAP.walk.flatMap((binding) =>
        binding.keys.map((key) => [key, binding.label] as const)
      )
    );
    expect(walk.get('[')).toBe('previous/next page');
    expect(walk.get(']')).toBe('previous/next page');
    expect(walk.get(';n')).toBe('previous/next unvisited');
    expect(walk.get(';p')).toBe('previous/next unvisited');
    expect(walk.get('v')).toBe('select span');
    expect(walk.get('e')).toBe('$EDITOR');
    expect(walk.has('V')).toBe(false);
    // `E` and `P` are not bound: no dispatcher branch handles them.
    expect(walk.has('E')).toBe(false);
    expect(walk.has('P')).toBe(false);
    expect(walk.get('j')).toBe('move at current grain');
    expect(walk.get('(')).toBe('related location');
    // `z`/`Z` ARE on the Walk. `DiffSlice` accepts `onToggleGap` there, so a keymap
    // that omits them to match an "expansion is unavailable on the bounded review
    // route" notice is matching a false message — and a test that pins the omission
    // holds the lie in place as firmly as it would hold a truth.
    expect(walk.get('z')).toBe('expand hidden / whole file');
    expect(walk.get('Z')).toBe('expand hidden / whole file');
    expect(walk.get('C-u')).toBe('half-page up');
    expect(walk.get('C-d')).toBe('half-page down');
    expect(walk.get('C-l')).toBe('center cursor');
    expect(walk.get('/')).toBe('filter files');
  });

  it('advertises as GLOBAL only the keys that work on every screen', () => {
    const global = new Set(STORY_REVIEW_GLOBAL_KEYS.flatMap((binding) => binding.keys));
    for (const key of ['R', 'C', 'F', 'esc', '?', 'q']) {
      expect(global.has(key), `${key} should be global`).toBe(true);
    }
    expect(global.has('←'), 'Left is spatial and must remain screen-scoped').toBe(false);

    // `1`/`2`/`0` are screen-scoped layout keys rather than global commands.
    // The paging and file-jump keys move the diff column's scroll coordinator. On
    // Brief, Comments, Finish and Flat Files there is no such column, so every one
    // of them would be a no-op. They belong to the screens that have one.
    for (const scopedLayout of ['1', '2', '0']) {
      expect(global.has(scopedLayout), `${scopedLayout} is screen-scoped`).toBe(false);
    }
    for (const scoped of ['u', 'C-u', 'b', 'D', 'C-d', 'f', 'g', 'G', 'C-l', '/', ',', '.']) {
      expect(global.has(scoped), `${scoped} belongs to the scrolling screens`).toBe(false);
    }

    const brief = new Set(STORY_REVIEW_KEYMAP.brief.flatMap((binding) => binding.keys));
    const floorDiff = new Set(STORY_REVIEW_KEYMAP['floor-diff'].flatMap((b) => b.keys));
    for (const scoped of ['u', 'C-u', 'b', 'D', 'C-d', 'f', 'g', 'G', 'C-l', '/']) {
      expect(brief.has(scoped), `Brief does not scroll — it must not claim ${scoped}`).toBe(false);
      expect(floorDiff.has(scoped), `the diff column scrolls — it must claim ${scoped}`).toBe(true);
    }
  });

  it('shows only the current screen plus shared review controls', () => {
    const captured = storyReviewHelpSections('floor-diff', 'deterministic');
    expect(captured.map((section) => section.title)).toEqual([
      'Here · Captured checkpoint diff',
      'More on this screen',
      'Mouse',
      'Anywhere in Review',
    ]);
    expect(captured.flatMap((section) => section.rows).map((row) => row.label)).not.toContain(
      'Move through the focused rail or diff level'
    );

    const story = storyReviewHelpSections('walk', 'story');
    expect(story[0]?.title).toBe('Here · Composed Story walkthrough');
    expect(story[0]?.rows.map((row) => row.label)).toContain(
      'Move through the focused rail or diff level'
    );
  });

  it('does not advertise Story-only Attention actions on the deterministic Brief', () => {
    const captured = storyReviewHelpSections('brief', 'deterministic')
      .flatMap((section) => section.rows)
      .flatMap((row) => row.keys);
    expect(captured).not.toEqual(expect.arrayContaining(['n', 'N', 'a', 'r', 'd', 'o']));

    const story = storyReviewHelpSections('brief', 'story')
      .flatMap((section) => section.rows)
      .flatMap((row) => row.keys);
    expect(story).toEqual(expect.arrayContaining(['n', 'N', 'a', 'r', 'd', 'o']));
  });

  it('projects the same table into screen-aware footers', () => {
    const walk = selectStoryReviewFooterLayout('walk', 'rail', Number.MAX_SAFE_INTEGER).parts.join(
      ' · '
    );
    expect(walk).toContain('[/] previous/next page');
    expect(walk).toContain(';n/;p previous/next unvisited');
    expect(walk).toContain('⇥ diff');
    expect(walk).toContain('esc cancel/back');
  });
});

/**
 * A read-only stale Story must not ADVERTISE what its executor refuses.
 *
 * Three surfaces, two call sites: `selectVisibleReviewCommands` feeds both the
 * footer/visible set AND gesture resolution (`commandForGesture` is a `find`
 * over exactly this projection), while `storyReviewHelpSections` filters help
 * on its own. Asserting only through a mounted app proves nothing here — the
 * executor already refuses these commands, so a "pressing it writes nothing"
 * assertion passes whether or not the id is in the set.
 */
describe('stale Story command suppression', () => {
  const helpCommandIds = (screen: StoryReviewScreen, staleStory: boolean): (string | undefined)[] =>
    storyReviewHelpSections(screen, 'story', { atRoot: screen === 'brief' }, staleStory)
      .flatMap((section) => section.rows)
      .map((row) => row.commandId);

  it('withholds the residue page mark-inspected from visible commands, help, and the m gesture', () => {
    const nav = { atRoot: false };
    // Live first, so the stale assertions below cannot pass vacuously.
    const live = selectVisibleReviewCommands('unassigned', nav, 'story', false);
    expect(live.map((command) => command.id)).toContain('review.unassigned.mark-inspected');
    expect(live.find((command) => command.gestures.includes('m'))?.id).toBe(
      'review.unassigned.mark-inspected'
    );
    expect(helpCommandIds('unassigned', false)).toContain('review.unassigned.mark-inspected');

    const stale = selectVisibleReviewCommands('unassigned', nav, 'story', true);
    expect(stale.map((command) => command.id)).not.toContain('review.unassigned.mark-inspected');
    // Gesture resolution reads this exact projection, so `m` resolves to nothing.
    expect(stale.find((command) => command.gestures.includes('m'))).toBeUndefined();
    expect(helpCommandIds('unassigned', true)).not.toContain('review.unassigned.mark-inspected');
  });

  it('withholds every suppressed id from both surfaces on every screen that binds it', () => {
    for (const id of STALE_STORY_SUPPRESSED_COMMANDS) {
      const screens = SCREENS.filter((screen) =>
        STORY_REVIEW_KEYMAP[screen].some((binding) => binding.id === id)
      );
      expect(screens.length, `${id} is bound on no screen`).toBeGreaterThan(0);
      for (const screen of screens) {
        const nav = { atRoot: screen === 'brief' };
        expect(
          selectVisibleReviewCommands(screen, nav, 'story', true).map((command) => command.id),
          `${id} still visible on ${screen}`
        ).not.toContain(id);
        expect(helpCommandIds(screen, true), `${id} still in ${screen} help`).not.toContain(id);
      }
    }
  });
});
