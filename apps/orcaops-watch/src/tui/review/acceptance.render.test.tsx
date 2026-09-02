// A WHOLE REVIEW, END TO END, THROUGH THE REAL APP — on both lenses.
//
// Each of the suites beside this one proves a piece: the pager moves, the gate
// blocks, the key fires, the column stays bounded. This one proves that a human
// being can sit down in front of the app and finish a review.
//
// The journeys below drive the mounted `ReviewApp` with real keys and assert only
// what a reviewer could see or what the app durably wrote. No controller commands,
// no internal state stubbed in, no fixture asserting itself.

import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';

describe('the deterministic lens: a review, from the Brief to a durable COMPLETE', () => {
  test('read every checkpoint, discharge the unexplained rows, and finish', async () => {
    // THE DEFAULT STATE OF EVERY BRANCH. No Story is composed, because any commit
    // re-floors the branch and stales the narrative.
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'brief',
      width: 160,
    });

    // 1. THE BRIEF says what exists and what has been read.
    expect(app.frame()).toContain('CAPTURED WORK');
    expect(app.frame()).toContain('0/1 complete');

    // 2. INTO THE CODE. Enter on a thread opens its first hunk in the diff column.
    await app.press('\r');
    expect(app.state().screen).toBe('floor-diff');
    expect(app.frame()).toContain('Slice 1/');
    // The captured trail rides alongside — the record of WHY, next to the WHAT.
    expect(app.frame()).toContain('REVIEW CONTEXT · CHECKPOINT');

    // 3. THE CHECKPOINT PAGER. `[`/`]` walk checkpoints, not a flat list of every
    //    hunk on the branch. The header names which one, and how many there are.
    expect(app.frame()).toContain('Checkpoint 1/1');

    // 4. AUTHOR A COMMENT from the active slice. Row descent remains available for
    //    exact-line selection, but it is not mandatory ceremony for every comment.
    await app.press('c');
    expect(app.frame()).toContain('Comment on src/fixture.ts:1');
    await app.pressAll([...'why is this here?', '']);
    await app.settleUntil((frame) => frame.includes('Comment added'));

    // It is DURABLE — in the sidecar, which is what the agent's CLI track reads.
    const sidecar = app.sidecar();
    expect(sidecar).toHaveLength(1);
    expect(sidecar[0]!.body).toBe('why is this here?');

    // 5. An unanswered reviewer comment is a checkpoint obligation. Coverage and
    //    completion must not disagree about whether this page is reviewed.
    await app.press('m');
    expect(app.frame()).toContain('Mark reviewed is blocked by');
    expect(app.journalEvents.filter((event) => event.type === 'review_coverage')).toHaveLength(0);

    // Resolve the exact obligation and return to the same checkpoint. The gate
    // is derived from the sidecar on every rebuild, so no restart or narrative
    // synthesis is needed before the same m becomes truthful.
    await app.press('C');
    await app.press('x');
    await app.settleUntil((frame) => frame.includes('Comment resolved'));
    await app.press('C');
    expect(app.state().screen).toBe('floor-diff');
    await app.press('m');
    await app.settleUntil((frame) => frame.includes('Checkpoint coverage recorded'));
    expect(app.journalEvents.filter((event) => event.type === 'review_coverage')).toHaveLength(1);

    app.unmount();
  });

  test('the finish gate names what is left and opens the selected obligation', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-floor-only',
      screen: 'finish',
      width: 160,
    });

    // Nothing has been read. The gate says so, in obligations a reviewer can act on
    // — not '◐ Required review work remains' on its own.
    const frame = app.frame();
    expect(frame).toContain('Reading the captured checkpoints');
    expect(frame).toContain('Required review work remains');
    expect(frame).toContain('Read · Deterministic fixture section');
    expect(frame).toContain('Inspect · Unassigned changes');

    // Enter opens the highlighted obligation. Navigation never appends a result.
    await app.press('\r');
    expect(app.state().screen).toBe('floor-diff');
    expect(app.journalEvents.filter((event) => event.type === 'review_lifecycle')).toHaveLength(0);

    app.unmount();
  });

  test('a fully-read floor-only branch files a COMPLETE that survives a reload', async () => {
    // Every row covered and no Story anywhere — the state that makes "can a
    // fully-reviewed floor-only branch be finished?" answerable.
    const app = await mountReviewApp({
      scenario: 'complete-floor-only',
      screen: 'finish',
      width: 160,
    });

    expect(app.frame()).toContain('Ready to finish complete');
    await app.press('\r');
    await app.settleUntil((frame) => frame.includes('Durable complete'));

    const lifecycle = app.journalEvents.filter((event) => event.type === 'review_lifecycle');
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]).toMatchObject({
      action: 'COMPLETE',
      // The basis it was ACTUALLY read on. A null generation on its own cannot tell
      // an honest floor-only completion from a corrupt narrative one.
      review_basis: 'FLOOR_ONLY',
      story_generation: null,
    });

    // And it reads back non-stale: the record describes the branch it was made on.
    expect(app.frame()).toContain('Durable complete');
    expect(app.frame()).not.toContain('Generation changed');

    // REOPEN keeps the record rather than erasing it.
    await app.press('r');
    await app.settleUntil((frame) => frame.includes('Ready to finish complete'));
    expect(app.journalEvents.filter((event) => event.type === 'review_lifecycle')).toHaveLength(2);

    app.unmount();
  });
});

describe('the reader survives degenerate branch shapes', () => {
  test('an underivable floor fails CLOSED, and says so on every screen', async () => {
    // A missing or truncated `diff.patch` means owned rows cannot be derived. That
    // must fail CLOSED and say so: swallowed, the review renders as healthy while
    // `m` does nothing at all, with no message, indefinitely.
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 160,
      reviewDiff: '',
    });

    expect(app.frame()).toContain('COVERAGE UNAVAILABLE');
    expect(app.frame()).toContain('no retained parent hunk in diff.patch');

    // `F` toggles All Changed Files — exercise that navigation surviving the
    // broken floor, and require the fail-closed banner to survive it too.
    await app.press('F');
    await app.press('F');
    expect(app.frame()).toContain('COVERAGE UNAVAILABLE');
    expect(app.journalEvents.filter((event) => event.type === 'review_lifecycle')).toHaveLength(0);
    app.unmount();
  });

  test('Finish stays closed on an underivable floor: no lifecycle write from its commands', async () => {
    // The ACTUAL Finish surface: mount the finish screen itself over the
    // underivable floor and drive the keys that produce lifecycle commands.
    // Fail-closed here means COMPLETE is unavailable and nothing is appended
    // to the journal without an explicit confirmation. `p` legitimately opens
    // the partial-completion modal — it is the designed escape hatch for
    // recording what remains when something is wrong — but merely opening and
    // Esc-ing it must write nothing.
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'finish',
      width: 160,
      reviewDiff: '',
    });
    expect(app.frame()).toContain('COVERAGE UNAVAILABLE');
    expect(app.frame()).not.toContain('Ready to finish');

    await app.press('\r');
    expect(app.frame()).toContain('COVERAGE UNAVAILABLE');
    expect(app.frame()).not.toContain('Ready to finish');

    await app.press('p');
    expect(app.frame()).toContain('Finish as partial');
    // Escape closes the modal (deliverable here as a bare byte because the
    // modal consumes it directly rather than waiting on a CSI tail).
    await app.press('\u001b');
    expect(await app.settleUntil((frame) => frame.includes('COVERAGE UNAVAILABLE'))).toBe(true);
    expect(app.frame()).not.toContain('Finish as partial');

    expect(app.journalEvents.filter((event) => event.type === 'review_lifecycle')).toHaveLength(0);
    app.unmount();
  });

  test('4,057 unexplained rows stay a bounded render', async () => {
    const app = await mountReviewApp({
      scenario: 'unassigned-huge',
      screen: 'unassigned',
      width: 160,
    });

    expect(app.frame()).toContain('Unassigned · Slice 1/2');
    expect(app.frame()).toContain('unassigned row 1');
    expect(app.diffNodeCount()).toBeLessThan(400);
    // The column is its FULL height — the reviewer can scroll to the end of the work.
    expect(app.scrollBounds().content).toBeGreaterThan(4_000);

    app.unmount();
  });
});

describe('the reviewer↔agent loop, on the path that actually exists', () => {
  test('an agent reply arrives out-of-band and the reviewer resolves it', async () => {
    // The half of the loop the reader cannot initiate: an agent appends a reply
    // through the CLI track while the TUI is open. Composition and comment-addressing
    // are different skill tracks.
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
    });

    await app.pressAll(['\r', 'c']);
    await app.pressAll([...'is this bound?', '']);
    await app.settleUntil((frame) => frame.includes('Comment added'));
    const [comment] = app.sidecar();
    expect(comment).toBeDefined();

    // The agent answers, out of band.
    app.agentReplies(comment!.comment_id, 'yes — bounded by the caller');
    await app.settle();

    await app.press('C');
    expect(app.state().screen).toBe('comments');
    expect(await app.settleUntil((frame) => frame.includes('bounded by the caller'))).toBe(true);

    // The reviewer resolves it, and the resolution is durable.
    await app.press('x');
    await app.settleUntil((frame) => frame.includes('resolved'));
    expect(app.sidecar()[0]!.status).toBe('resolved');

    app.unmount();
  });
});
