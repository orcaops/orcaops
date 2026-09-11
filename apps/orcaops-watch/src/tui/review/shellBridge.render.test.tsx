import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import { ReviewPaneError } from '../../data/reviewSource';

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

  test('an unsupported history format renders read-only Doctor guidance without retrying', async () => {
    let calls = 0;
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      autoLoad: true,
      startWithoutReview: true,
      width: 140,
      reviewLoader: async () => {
        calls += 1;
        throw new ReviewPaneError(
          'HISTORY_FORMAT_UNSUPPORTED',
          'This database needs an explicitly supported schema upgrade or repair'
        );
      },
    });

    await app.settleUntil((frame) => frame.includes('Review unavailable for probe'));
    expect(app.frame()).toContain('canonical history database format is unsupported');
    expect(app.frame()).toContain('Watch did not modify the database.');
    expect(app.frame().replace(/\s+/gu, ' ')).toContain('orcaops doctor');
    expect(app.frame()).not.toContain('Rebuild');

    await app.press('r');
    await app.press('y');
    await app.settle();
    expect(calls).toBe(1);
    expect(app.frame()).toContain('Review unavailable for probe');
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
