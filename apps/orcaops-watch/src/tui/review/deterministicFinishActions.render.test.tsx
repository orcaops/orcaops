import { describe, expect, test } from 'bun:test';

import { THREAD_DISPOSITION, UNCERTAINTY_STATE, uncertaintyState } from '@orcaops/review-core';

import { buildDeterministicReader } from './readerModel';
import { mountReviewApp } from '../../../tests/review/mountReviewApp';

const FIRST = 'cite:artifact-fixture:cp1:uncertainty:0';
const SECOND = 'cite:artifact-fixture:cp1:uncertainty:1';

describe('deterministic captured-item actions', () => {
  test('mark-reviewed waits for checkpoint uncertainties and reload preserves completion', async () => {
    const app = await mountReviewApp({
      scenario: 'uncertainty-floor-only',
      screen: 'floor-diff',
      width: 160,
    });

    await app.press('m');
    expect(app.frame()).toContain('Mark reviewed is blocked by uncertainties');
    expect(app.journalEvents.filter((event) => event.type === 'review_coverage')).toHaveLength(0);

    await app.press('A');
    await app.pressAll([...'verified at the checkpoint boundary', '\u0013']);
    await app.settleUntil((frame) => frame.includes('acknowledged 2 open uncertainties'));
    await app.press('m');
    await app.settleUntil((frame) => frame.includes('Checkpoint coverage recorded'));
    expect(app.journalEvents.filter((event) => event.type === 'review_coverage')).toHaveLength(1);

    const ledger = await app.journalEffects.load({ root: undefined, branch: 'probe' });
    const reloaded = buildDeterministicReader({
      floor: app.fixture.source.floor,
      eligibleTargets: app.fixture.eligibleTargets,
      ledger,
      currentThreads: app.fixture.currentThreads,
      finishFacts: {
        targets: { ok: true },
        currentGapRows: app.fixture.currentGapRows,
        comments: app.sidecar(),
      },
    });
    expect(reloaded.pages[0]?.markReviewedEnabled).toBe(true);
    expect(reloaded.pages[0]?.complete).toBe(true);
    app.unmount();
  });

  test('selects, resolves, reopens, and durably reloads a real uncertainty', async () => {
    const app = await mountReviewApp({
      scenario: 'uncertainty-floor-only',
      screen: 'floor-diff',
      width: 160,
    });

    await app.press('\t');
    expect(app.frame()).toContain('❯ ⚑ OPEN The terminal density');

    await app.press('j');
    expect(app.frame()).toContain('❯ ⚑ OPEN The refresh boundary');
    await app.press('r');
    await app.settleUntil((frame) => frame.includes('RESOLVED The refresh boundary'));
    expect(app.journalEvents.at(-1)).toMatchObject({
      type: 'uncertainty',
      citationId: SECOND,
      action: 'RESOLVE',
    });

    await app.press('o');
    await app.settleUntil((frame) => frame.includes('OPEN The refresh boundary'));
    expect(app.journalEvents.at(-1)).toMatchObject({
      type: 'uncertainty',
      citationId: SECOND,
      action: 'REOPEN',
    });

    const beforeDismiss = app.journalEvents.length;
    await app.press('d');
    expect(app.frame()).toContain('uncertainties cannot be dismissed');
    expect(app.journalEvents).toHaveLength(beforeDismiss);

    await app.press('a');
    await app.settleUntil((frame) => frame.includes('ACKNOWLEDGED The refresh boundary'));
    const reloaded = await app.journalEffects.load({ root: undefined, branch: 'probe' });
    expect(uncertaintyState(reloaded, SECOND)).toBe(UNCERTAINTY_STATE.ACKNOWLEDGED);
    app.unmount();
  });

  test('bulk acknowledge requires one reason and links only the open uncertainties', async () => {
    const app = await mountReviewApp({
      scenario: 'uncertainty-floor-only',
      screen: 'floor-diff',
      width: 160,
    });

    await app.press('A');
    expect(app.frame()).toContain('Acknowledge 2 open uncertainties');
    await app.pressAll([...'verified together at the checkpoint boundary', '\u0013']);
    await app.settleUntil((frame) => frame.includes('acknowledged 2 open uncertainties'));

    const events = app.journalEvents.filter((event) => event.type === 'uncertainty');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.citationId)).toEqual([FIRST, SECOND]);
    expect(new Set(events.map((event) => event.ts)).size).toBe(1);
    expect(
      events.every((event) => event.reason === 'verified together at the checkpoint boundary')
    ).toBe(true);
    app.unmount();
  });

  test.each([
    ['s', THREAD_DISPOSITION.SKIP, 'generated output is inspected elsewhere'],
    ['p', THREAD_DISPOSITION.PARTIAL, 'the integration boundary remains'],
  ] as const)(
    '%s records the checkpoint thread disposition with a required reason',
    async (key, action, reason) => {
      const app = await mountReviewApp({
        scenario: 'uncertainty-floor-only',
        screen: 'floor-diff',
        width: 160,
      });

      await app.press(key);
      expect(app.frame()).toContain('reason');
      await app.pressAll([...reason, '\u0013']);
      await app.settleUntil((frame) => frame.includes(action === 'SKIP' ? 'skipped' : 'partial'));
      expect(app.journalEvents.at(-1)).toMatchObject({
        type: 'section',
        action,
        reason,
      });
      app.unmount();
    }
  );
});

describe('non-vacuous deterministic Finish', () => {
  test('stays blocked by real citations, then completes only after they are durable', async () => {
    const blocked = await mountReviewApp({
      scenario: 'uncertainty-floor-only',
      screen: 'finish',
      width: 160,
    });
    expect(blocked.frame()).toContain('The terminal density still needs a real-width drive.');
    expect(blocked.frame()).toContain('The refresh boundary still needs a real reload.');
    await blocked.press('\r');
    expect(blocked.state().screen).toBe('floor-diff');
    expect(blocked.journalEvents.some((event) => event.type === 'review_lifecycle')).toBe(false);
    blocked.unmount();

    const app = await mountReviewApp({
      scenario: 'uncertainty-floor-only',
      screen: 'floor-diff',
      width: 160,
    });
    await app.press('A');
    await app.pressAll([...'reviewed both captured uncertainties', '\u0013']);
    await app.settleUntil((frame) => frame.includes('acknowledged 2 open uncertainties'));

    await app.press('escape');
    expect(app.state().screen).toBe('brief');
    // Finish is the last TREE destination, so `j` walks to it by name.
    await app.press('j');
    expect(app.frame()).toContain('Ready to finish complete');
    expect(app.state().briefDestinationKey).toBe('finish');
    await app.press('\r');
    expect(app.state().screen).toBe('finish');
    expect(app.frame()).toContain('Ready to finish complete');

    await app.press('\r');
    await app.settleUntil((frame) => frame.includes('Durable COMPLETE recorded'));
    expect(app.journalEvents.at(-1)).toMatchObject({
      type: 'review_lifecycle',
      action: 'COMPLETE',
      review_basis: 'FLOOR_ONLY',
    });
    app.unmount();
  });
});
