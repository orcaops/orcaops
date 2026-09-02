import { describe, expect, it } from 'vitest';

import { commandGestureCollisions } from './commandRegistry';
import {
  resolveWatchCommandForKey,
  selectVisibleWatchCommands,
  selectWatchCommands,
  WATCH_COMMAND_IDS,
  WATCH_COMMANDS,
  type WatchCommandContext,
} from './watchCommands';

const context = (
  pane: WatchCommandContext['pane'],
  detailMode: WatchCommandContext['detailMode'] = 'overview'
): WatchCommandContext => ({ connected: true, pane, detailMode });

describe('Watch command registry', () => {
  it('defines every stable ID once with complete presentation metadata', () => {
    expect(WATCH_COMMANDS.map((command) => command.id)).toEqual([...WATCH_COMMAND_IDS]);
    expect(new Set(WATCH_COMMANDS.map((command) => command.id)).size).toBe(
      WATCH_COMMAND_IDS.length
    );
    for (const command of WATCH_COMMANDS) {
      expect(command.gestures.length).toBeGreaterThan(0);
      expect(command.placements).toContain('help');
      expect(command.placements).toContain('palette');
    }
  });

  it('has no contextual key collision and makes g/G top/bottom everywhere', () => {
    const rail = selectVisibleWatchCommands(context('rail'));
    const detail = selectVisibleWatchCommands(context('detail'));
    expect(commandGestureCollisions(rail)).toEqual([]);
    expect(commandGestureCollisions(detail)).toEqual([]);
    expect(rail.find((command) => command.gestures.includes('g'))?.id).toBe('watch.scroll-top');
    expect(detail.find((command) => command.gestures.includes('g'))?.id).toBe('watch.scroll-top');
    expect(resolveWatchCommandForKey(context('rail'), { sequence: 'g' })?.id).toBe(
      'watch.scroll-top'
    );
    expect(resolveWatchCommandForKey(context('detail'), { sequence: 'g' })?.id).toBe(
      'watch.scroll-top'
    );
    expect(resolveWatchCommandForKey(context('detail'), { name: 'pagedown' })?.id).toBe(
      'watch.page-down'
    );
    expect(
      resolveWatchCommandForKey(context('rail'), { name: 'u', sequence: '\x15', ctrl: true })?.id
    ).toBe('watch.half-page-up');
    expect(
      resolveWatchCommandForKey(context('detail'), { name: 'd', sequence: '\x04', ctrl: true })?.id
    ).toBe('watch.half-page-down');
    expect(resolveWatchCommandForKey(context('detail'), { sequence: 'q' })?.id).toBe(
      'watch.back-detail'
    );
    expect(resolveWatchCommandForKey(context('rail'), { sequence: 'q' })).toBeNull();
    // Grouping is bound to `w` (g/G are scroll; t is Choose Theme).
    expect(resolveWatchCommandForKey(context('rail'), { sequence: 'w' })?.id).toBe(
      'watch.cycle-grouping'
    );
    expect(resolveWatchCommandForKey(context('detail'), { sequence: 'w' })?.id).toBe(
      'watch.cycle-grouping'
    );
  });

  it('derives Help, footer, menu, and palette from the same contextual entries', () => {
    const rail = context('rail');
    const footerIds = selectWatchCommands(rail, 'footer').map((command) => command.id);
    expect(footerIds).toEqual([
      'watch.move',
      'watch.open-detail',
      'watch.cycle-filter',
      'watch.cycle-grouping',
      'watch.choose-repository',
      'watch.toggle-notifications',
    ]);
    expect(selectWatchCommands(rail, 'menu').map((command) => command.id)).toEqual([
      'watch.cycle-filter',
      'watch.cycle-grouping',
      'watch.choose-repository',
      'watch.toggle-notifications',
    ]);
    expect(selectWatchCommands(rail, 'help').map((command) => command.id)).toEqual(
      selectWatchCommands(rail, 'palette').map((command) => command.id)
    );
    expect(selectWatchCommands(rail, 'help').map((command) => command.id)).toContain(
      'watch.cycle-grouping'
    );
  });
});
