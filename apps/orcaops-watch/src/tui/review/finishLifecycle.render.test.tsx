// Finishing a review you actually read — on the lens you actually read it on.
//
// A branch with no composed Story is the DEFAULT state, not an edge case: any
// commit re-floors the branch and stales the narrative. So finishing, finishing
// partial and reopening all have to work with no narrative anywhere — through the
// schema, the transport, the replay and the screen alike.
//
// Everything here runs with NO NARRATIVE, on purpose.

import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';

describe('the finish screen, with no narrative present', () => {
  test('renders the finish screen on the deterministic path', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', screen: 'finish', width: 160 });

    expect(app.frame()).toContain('REVIEW STATUS');
    // And it says which lens the reviewer is answering for. Finishing is a claim
    // about what you read; the record has to know which one.
    expect(app.frame()).toContain('Reading the captured checkpoints');
    app.unmount();
  });

  test('NAMES what is left, rather than only that something is', async () => {
    // Every blocker names an obligation that can actually be discharged.
    // '◐ Required review work remains' on its own is true, useless, and leaves the
    // reviewer no recourse but to go hunting.
    const app = await mountReviewApp({ scenario: 'no-narrative', screen: 'finish', width: 160 });

    const frame = app.frame();
    expect(frame).toContain('Required review work remains');
    expect(frame).toContain('changed row(s) remain');
    expect(frame).not.toContain('sec_fixture');
    expect(frame).toContain('Deterministic fixture section');
    app.unmount();
  });

  test('Enter on an obligation opens the place where it can be discharged', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', screen: 'finish', width: 160 });

    await app.press('\r');

    expect(app.state().screen).toBe('floor-diff');
    expect(app.frame()).toContain('Fixture checkpoint');
    app.unmount();
  });

  test('j/k selects a captured question and Enter opens it in checkpoint context', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', screen: 'finish', width: 160 });

    await app.press('j');
    expect(app.frame()).toContain('❯ Answer · The terminal density');
    await app.press('\r');

    expect(app.state().screen).toBe('floor-diff');
    expect(app.state().focus).toBe('rail');
    expect(app.frame()).toContain('❯ ⚑ OPEN The terminal density');
    // Opening the page may record VISIT, but never claims lifecycle completion.
    expect(app.journalEvents.filter((event) => event.type === 'review_lifecycle')).toHaveLength(0);
    app.unmount();
  });

  test('Unassigned and comment obligations open their actual reviewer screens', async () => {
    const unassigned = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'finish',
      width: 160,
    });
    await unassigned.press('j');
    expect(unassigned.frame()).toContain('❯ Inspect · Unassigned changes');
    await unassigned.press('\r');
    expect(unassigned.state().screen).toBe('unassigned');
    unassigned.unmount();

    const comments = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'finish',
      width: 160,
      comments: [
        {
          comment_id: 'cmt_route',
          ts: '2026-07-13T00:00:00.000Z',
          author: 'reviewer',
          body: 'route me to the comment index',
          status: 'open',
          anchor: {
            kind: 'DIFF_LINE',
            file: 'src/fixture.ts',
            side: 'add',
            line: 1,
            lineHash: 'lh_fixture',
          },
          replies: [],
          position: null,
          context: [],
          owner: null,
          trail: [],
        },
      ],
    });
    expect(comments.frame()).toContain('❯ Resolve reviewer comments');
    await comments.press('\r');
    expect(comments.state().screen).toBe('comments');
    expect(comments.frame()).toContain('route me to the comment index');
    comments.unmount();
  });

  test('an underivable-target obligation gives a concrete recovery action', async () => {
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'finish',
      width: 160,
      reviewDiff: '',
    });

    expect(app.frame()).toContain('❯ Refresh review obligations');
    await app.press('\r');
    expect(app.state().screen).toBe('finish');
    expect(app.frame()).toContain(
      'Refresh the review; if this persists, rebuild the review targets.'
    );
    app.unmount();
  });
});

describe('recording a floor-only completion', () => {
  test('Enter files a durable COMPLETE whose basis is FLOOR_ONLY', async () => {
    // `complete` is the fixture whose rows are all covered — a reviewer who read
    // every checkpoint.
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'finish',
      width: 160,
    });
    expect(app.frame()).toContain('Ready to finish complete');

    await app.press('\r');
    await app.settleUntil((frame) => frame.includes('Durable COMPLETE recorded'));

    const [event] = app.journalEvents;
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: 'review_lifecycle',
      action: 'COMPLETE',
      // The lens they read. Without it, a null generation is ambiguous between
      // "there was no narrative" and "there was one and it was not pinned".
      review_basis: 'FLOOR_ONLY',
      story_generation: null,
      actor: 'REVIEWER',
      source: 'WATCH',
    });
    app.unmount();
  });

  test('the recorded completion reads back NON-stale', async () => {
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'finish',
      width: 160,
    });

    await app.press('\r');
    await app.settleUntil((frame) => frame.includes('Durable complete'));

    // A floor-only completion must not be compared against a narrative generation:
    // with no narrative anywhere the comparison can never match, so the completion
    // would be stale the instant it was written.
    const frame = app.frame();
    expect(frame).toContain('✓ Durable complete');
    expect(frame).not.toContain('Generation changed');
    app.unmount();
  });

  test('finishes PARTIAL with a required note, and keeps it', async () => {
    // A reviewer with work outstanding must still be able to record that they
    // stopped, and why — otherwise the only honest option is to record nothing.
    const app = await mountReviewApp({ scenario: 'no-narrative', screen: 'finish', width: 160 });

    await app.press('p');
    expect(app.frame()).toContain('Finish as partial');

    await app.pressAll([...'checkpoints 3 onward still unread', '']);
    await app.settleUntil((frame) => frame.includes('Durable partial'));

    expect(app.journalEvents[0]).toMatchObject({
      type: 'review_lifecycle',
      action: 'PARTIAL',
      review_basis: 'FLOOR_ONLY',
      story_generation: null,
      remaining_work: 'checkpoints 3 onward still unread',
    });
    expect(app.frame()).toContain('checkpoints 3 onward still unread');
    app.unmount();
  });

  test('reopens a finished review, and the completion record survives it', async () => {
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'finish',
      width: 160,
    });
    await app.press('\r');
    await app.settleUntil((frame) => frame.includes('Durable complete'));

    await app.press('r');
    await app.settleUntil((frame) => frame.includes('Ready to finish complete'));

    // Two durable events, both floor-only. REOPEN does not erase the COMPLETE —
    // the reviewer did finish this review once, and no later event makes that
    // untrue. The lifecycle is append-only for exactly this reason.
    expect(app.journalEvents.map((event) => (event as { action: string }).action)).toEqual([
      'COMPLETE',
      'REOPEN',
    ]);
    app.unmount();
  });
});

describe('the gate the transport also checks', () => {
  test('an open reviewer comment blocks the finish — branch-wide, not per-thread', async () => {
    // The reviewer's own unanswered question. There is no 'blocking' flag in the
    // schema (only OPEN/RESOLVED and REVIEWER/AGENT), so open-and-mine IS the
    // definition. Finishing over it files the review as done with the reviewer
    // still waiting on an answer.
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'finish',
      width: 160,
    });
    expect(app.frame()).toContain('Ready to finish complete');
    app.unmount();

    const withComment = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'finish',
      width: 160,
      comments: [
        {
          comment_id: 'cmt_open',
          ts: '2026-07-13T00:00:00.000Z',
          author: 'reviewer',
          body: 'why is this unbounded?',
          status: 'open',
          anchor: {
            kind: 'DIFF_LINE',
            file: 'src/fixture.ts',
            side: 'add',
            line: 1,
            lineHash: 'lh_fixture',
          },
          replies: [],
          position: null,
          context: [],
          owner: null,
          trail: [],
        },
      ],
    });

    const frame = withComment.frame();
    expect(frame).toContain('Required review work remains');
    expect(frame).toContain('1 open comment(s) remain');

    await withComment.press('\r');
    expect(withComment.journalEvents).toHaveLength(0);
    withComment.unmount();
  });

  test('an underivable floor fails CLOSED, and says so rather than claiming nothing is left', async () => {
    // A failed target build is what makes every other input a lie: no gap rows
    // derived reads exactly like no gap rows outstanding. Reporting "0 rows
    // outstanding" underneath it would be worse than saying nothing at all.
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'finish',
      width: 160,
      reviewDiff: '',
    });

    const frame = app.frame();
    expect(frame).toContain('Required review work remains');
    expect(frame).toContain('could not be derived');

    await app.press('\r');
    expect(app.journalEvents).toHaveLength(0);
    app.unmount();
  });
});
