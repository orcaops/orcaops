import { describe, expect, test } from 'bun:test';

import { ReviewCacheBehindError } from '@orcaops/watch-data/ui';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import { buildReviewAppHarness } from '../../../tests/review/reviewAppHarness';

describe('persistent App shell → Review bridge', () => {
  test('the Help menu opens the same review overlay as the keyboard command', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 140,
    });

    await app.requestShell('help');

    expect(app.frame()).toContain('Review controls');
    expect(app.frame()).toContain('Captured checkpoints · Captured checkpoint diff · diff focused');
    expect(app.frame()).toContain('Here · Captured checkpoint diff');
    expect(app.frame()).toContain('Application');
    expect(app.frame()).toContain('Choose Theme');
    expect(app.frame()).not.toContain('Review Composed Story');

    await app.press('q');
    expect(app.frame()).not.toContain('Review controls');
    expect(app.exits()).toBe(0);

    await app.requestShell('help');
    const rows = app.rows();
    const closeRow = rows.findIndex(
      (row) => row.includes('Review controls') && row.includes('[Esc]')
    );
    expect(closeRow).toBeGreaterThanOrEqual(0);
    const closeColumn = rows[closeRow]!.indexOf('[Esc]');
    await app.mockMouse.click(closeColumn + 1, closeRow);
    await app.settle();
    expect(app.frame()).not.toContain('Review controls');
    app.unmount();
  });

  test('Help remains visible and closes normally while the review is loading', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      autoLoad: true,
      startWithoutReview: true,
      reviewLoader: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    expect(app.frame()).toContain('Loading review for probe');

    await app.requestShell('help');

    expect(app.frame()).toContain('Review controls');
    expect(app.frame()).toContain('Application');

    await app.press('q');
    expect(app.frame()).not.toContain('Review controls');
    expect(app.frame()).toContain('Loading review for probe');
    expect(app.exits()).toBe(0);
    app.unmount();
  });

  test('Help remains visible and closes normally when the review load fails', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      autoLoad: true,
      startWithoutReview: true,
      reviewLoader: async () => {
        throw new Error(
          'review data sidecar exited 1: ConfigValidationError: fixture review is unavailable\n' +
            '    at loadConfig (/tmp/load.ts:1:1)'
        );
      },
    });
    await app.settleUntil((frame) =>
      frame.includes('Review rebuild failed: fixture review is unavailable')
    );
    expect(app.frame()).toContain('Review unavailable for probe');
    expect(app.frame()).toContain('The captured review bundle could not be loaded.');
    expect(app.frame()).not.toContain('ConfigValidationError');
    expect(app.frame()).not.toContain('sidecar exited');
    expect(app.frame()).not.toContain('at loadConfig');

    await app.requestShell('help');

    expect(app.frame()).toContain('Review controls');
    expect(app.frame()).toContain('Application');

    await app.press('q');
    expect(app.frame()).not.toContain('Review controls');
    expect(app.frame()).toContain('Review rebuild failed: fixture review is unavailable');
    expect(app.exits()).toBe(0);
    app.unmount();
  });

  test('an older cache prompts before rebuilding and retains a retry after decline', async () => {
    const fixture = await buildReviewAppHarness({ scenario: 'no-narrative' });
    const calls: boolean[] = [];
    let resolveRebuild!: (data: typeof fixture.loaded.data) => void;
    const rebuild = new Promise<typeof fixture.loaded.data>((resolve) => {
      resolveRebuild = resolve;
    });
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      autoLoad: true,
      startWithoutReview: true,
      reviewLoader: async (options) => {
        calls.push(options.rebuildCache === true);
        if (options.rebuildCache !== true) {
          throw new ReviewCacheBehindError(23, 24, 'cache 23 is behind 24');
        }
        return rebuild;
      },
    });

    await app.settleUntil((frame) => frame.includes('Rebuild local cache?'));
    expect(app.frame()).toContain("This repository's local cache uses schema 23");
    expect(app.frame()).toContain('Captured history will not be changed.');

    await app.press('n');
    expect(app.frame()).not.toContain('Rebuild local cache?');
    expect(app.frame()).toContain('[Rebuild cache]');

    await app.press('r');
    expect(app.frame()).toContain('Rebuild local cache?');
    await app.press('y');
    await app.settleUntil((frame) => frame.includes('Rebuilding local cache for probe'));
    expect(calls).toEqual([false, true]);

    resolveRebuild(fixture.loaded.data);
    await app.settleUntil((frame) => frame.includes('Captured checkpoints'));
    expect(app.frame()).not.toContain('Review unavailable for probe');
    app.unmount();
  });

  test('a pointer/menu pane request uses the same controller transition as Tab', async () => {
    const effectStates: string[] = [];
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 140,
      onCommandExecuted: (_command, state) => effectStates.push(state.focus),
    });
    const before = app.state().focus;

    await app.requestShell('next-pane');

    expect(app.state().focus).not.toBe(before);
    expect(effectStates.at(-1)).toBe(app.state().focus);
    app.unmount();
  });

  test('a pointer/menu Back request consumes one Review level without exiting', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 140,
    });

    await app.requestShell('back');

    expect(app.state().screen).toBe('brief');
    expect(app.exits()).toBe(0);
    app.unmount();
  });

  test('selectable Help executes an unambiguous Review command by stable ID', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 140,
    });
    const before = app.state().focus;

    await app.requestShell('help');
    expect(app.frame()).toContain('Enter run');
    await app.press('return');

    expect(app.frame()).not.toContain('Review controls');
    expect(app.state().focus).not.toBe(before);
    app.unmount();
  });

  test('higher shell layers suspend screen commands without changing review state', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', screen: 'brief' });
    const before = app.state();

    await app.setInputSuspended(true);
    await app.pressAll(['j', 'q']);

    expect(app.state()).toEqual(before);
    expect(app.exits()).toBe(0);

    await app.setInputSuspended(false);
    await app.press('q');
    expect(app.exits()).toBe(1);
    app.unmount();
  });
});
