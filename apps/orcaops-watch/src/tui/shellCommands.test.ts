import { describe, expect, it } from 'vitest';

import { commandGestureCollisions } from './commandRegistry';
import {
  resolveShellCommand,
  resolveShellCommandForKey,
  selectShellFooterCommands,
  selectShellHelpCommands,
  selectShellMenuSections,
  selectVisibleShellCommands,
  SHELL_COMMAND_IDS,
  SHELL_COMMANDS,
  SHELL_INPUT_PRECEDENCE,
  type ShellContext,
} from './shellCommands';

const watch = (reviewable: boolean, watchAtRoot = true): ShellContext => ({
  mode: 'watch',
  reviewable,
  watchAtRoot,
  reviewAtRoot: true,
  storyAvailable: false,
  storyViewable: false,
  reviewLens: 'deterministic',
});

const review = (
  reviewAtRoot = true,
  storyAvailable = true,
  reviewLens: ShellContext['reviewLens'] = 'story'
): ShellContext => ({
  mode: 'review',
  reviewable: false,
  watchAtRoot: false,
  reviewAtRoot,
  storyAvailable,
  storyViewable: storyAvailable,
  reviewLens,
});

const ids = (commands: readonly { id: string }[]): string[] =>
  commands.map((command) => command.id);

describe('shell command catalog', () => {
  it('publishes one deterministic input ownership order', () => {
    expect(SHELL_INPUT_PRECEDENCE).toEqual([
      'text-input',
      'help',
      'theme-selector',
      'application-menu',
      'contextual-popover',
      'screen',
    ]);
  });

  it('defines every stable command id exactly once', () => {
    expect(ids(SHELL_COMMANDS)).toEqual([...SHELL_COMMAND_IDS]);
    expect(new Set(ids(SHELL_COMMANDS)).size).toBe(SHELL_COMMAND_IDS.length);
  });

  it('keeps complete projection metadata and collision-free contextual gestures', () => {
    for (const command of SHELL_COMMANDS) {
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.shortLabel.length).toBeGreaterThan(0);
      expect(command.helpLabel.length).toBeGreaterThan(0);
      expect(command.placements).toContain('help');
      expect(command.placements).toContain('palette');
    }
    expect(commandGestureCollisions(selectVisibleShellCommands(watch(true)))).toEqual([]);
    expect(commandGestureCollisions(selectVisibleShellCommands(watch(true, false)))).toEqual([]);
    expect(commandGestureCollisions(selectVisibleShellCommands(review()))).toEqual([]);
    expect(commandGestureCollisions(selectVisibleShellCommands(review(false)))).toEqual([]);
  });

  it('registers F10 once instead of appending a Help-only special case', () => {
    expect(resolveShellCommand('open-menu', watch(true))).toMatchObject({
      gestures: ['F10'],
      helpLabel: 'Open application menus',
      visible: true,
      enabled: true,
    });
    expect(
      selectShellMenuSections(watch(true)).flatMap((group) => ids(group.commands))
    ).not.toContain('open-menu');
  });

  it('reserves shell q for Watch-root Quit and Review Back transitions', () => {
    const watchQ = selectVisibleShellCommands(watch(true)).filter((command) =>
      command.gestures.includes('q')
    );
    const nestedWatchQ = selectVisibleShellCommands(watch(true, false)).filter((command) =>
      command.gestures.includes('q')
    );
    const reviewRootQ = selectVisibleShellCommands(review()).filter((command) =>
      command.gestures.includes('q')
    );
    const reviewNestedQ = selectVisibleShellCommands(review(false)).filter((command) =>
      command.gestures.includes('q')
    );

    expect(watchQ).toMatchObject([{ id: 'quit', label: 'Quit', enabled: true }]);
    expect(nestedWatchQ).toEqual([]);
    expect(reviewRootQ).toMatchObject([
      { id: 'back-to-watch', label: 'Back to Watch', enabled: true },
    ]);
    expect(reviewNestedQ).toMatchObject([
      { id: 'review-back', label: 'Back One Review Level', enabled: true },
    ]);
    expect(resolveShellCommandForKey(watch(true), { sequence: 'q' })?.id).toBe('quit');
    expect(resolveShellCommandForKey(watch(true, false), { sequence: 'q' })).toBeNull();
    expect(resolveShellCommandForKey(review(), { sequence: 'q' })?.id).toBe('back-to-watch');
    expect(resolveShellCommandForKey(review(false), { sequence: 'q' })?.id).toBe('review-back');
    expect(resolveShellCommandForKey(watch(true), { name: 'tab', sequence: '\t' })?.id).toBe(
      'next-pane'
    );
  });

  it('derives the chrome display key: override, else first gesture, else null for menu-only', () => {
    expect(resolveShellCommand('next-pane', watch(true))).toMatchObject({
      gestures: ['⇥'],
      keyLabel: 'Tab',
    });
    expect(resolveShellCommand('help', watch(true))).toMatchObject({
      gestures: ['?'],
      keyLabel: '?',
    });
    expect(resolveShellCommand('story-lens', review()).keyLabel).toBeNull();
    expect(resolveShellCommand('captured-checkpoint-lens', review()).keyLabel).toBeNull();
  });

  it('keeps Open Review visible for discovery and enables it only for a reviewable selection', () => {
    expect(resolveShellCommand('open-review', watch(false))).toMatchObject({
      label: 'Review This Branch',
      shortLabel: 'Review',
      keyLabel: 'v',
      visible: true,
      enabled: false,
    });
    expect(resolveShellCommand('open-review', watch(true))).toMatchObject({
      visible: true,
      enabled: true,
    });
    expect(resolveShellCommand('open-review', review())).toMatchObject({
      visible: false,
      enabled: false,
    });
  });

  it('keeps theme and help available in both modes without promising a nonexistent pane', () => {
    for (const context of [watch(false), review()]) {
      expect(resolveShellCommand('theme', context)).toMatchObject({
        label: 'Choose Theme',
        shortLabel: 'Theme',
        keyLabel: 't',
        visible: true,
        enabled: true,
      });
      expect(resolveShellCommand('help', context)).toMatchObject({
        label: 'Help',
        shortLabel: 'Help',
        keyLabel: '?',
        visible: true,
        enabled: true,
      });
    }
    expect(resolveShellCommand('next-pane', watch(false))).toMatchObject({
      label: 'Next Pane',
      shortLabel: 'Pane',
      keyLabel: 'Tab',
      visible: true,
      enabled: true,
    });
    expect(resolveShellCommand('next-pane', review())).toMatchObject({
      visible: false,
      enabled: false,
    });
  });

  it('enables only a different available review lens', () => {
    expect(resolveShellCommand('story-lens', review(true, true, 'story'))).toMatchObject({
      visible: true,
      enabled: false,
    });
    expect(
      resolveShellCommand('captured-checkpoint-lens', review(true, true, 'story'))
    ).toMatchObject({ visible: true, enabled: true });
    expect(resolveShellCommand('story-lens', review(true, true, 'deterministic'))).toMatchObject({
      visible: true,
      enabled: true,
    });
    expect(
      resolveShellCommand('captured-checkpoint-lens', review(true, true, 'deterministic'))
    ).toMatchObject({ visible: true, enabled: false });
    expect(resolveShellCommand('story-lens', review(true, false, 'deterministic'))).toMatchObject({
      visible: true,
      enabled: false,
    });
  });
});

describe('shell command selectors', () => {
  it('builds menu groups from the visible catalog and omits empty groups', () => {
    const watchMenu = selectShellMenuSections(watch(false));
    expect(watchMenu.map((section) => section.label)).toEqual([
      'Orcaops',
      'Review',
      'View',
      'Help',
    ]);
    expect(ids(watchMenu.find((section) => section.id === 'review')?.commands ?? [])).toEqual([
      'open-review',
    ]);

    const reviewMenu = selectShellMenuSections(review());
    expect(reviewMenu.map((section) => section.label)).toEqual(['Review', 'View', 'Help']);
    expect(ids(reviewMenu.find((section) => section.id === 'review')?.commands ?? [])).toEqual([
      'back-to-watch',
      'story-lens',
      'captured-checkpoint-lens',
    ]);
    expect(
      ids(
        selectShellMenuSections(review(false)).find((section) => section.id === 'review')
          ?.commands ?? []
      )
    ).toEqual(['review-back', 'story-lens', 'captured-checkpoint-lens']);
  });

  it('derives help and the compact footer from the same contextual definitions', () => {
    const context = review();
    const help = selectShellHelpCommands(context);
    const footer = selectShellFooterCommands(context);

    expect(ids(help)).toEqual(ids(selectVisibleShellCommands(context)));
    expect(ids(footer)).toEqual(['back-to-watch', 'help']);
    expect(footer.find((command) => command.gestures.includes('q'))?.label).toBe('Back to Watch');
    expect(footer.find((command) => command.gestures.includes('q'))?.shortLabel).toBe('Watch');
    const nested = review(false);
    const nestedFooter = selectShellFooterCommands(nested);
    expect(ids(nestedFooter)).toEqual(['review-back', 'help']);
    expect(nestedFooter.find((command) => command.gestures.includes('q'))?.shortLabel).toBe('Back');
    expect(
      selectShellHelpCommands(nested).find((command) => command.gestures.includes('q'))?.label
    ).toBe('Back One Review Level');
  });
});
