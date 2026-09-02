// The comment/revision loop — the reviewer↔agent loop, which is the product.
//
// Every test here uses the fixture without a Current Story. The comment sidecar,
// CLI track, and floor + patch reanchor ladder remain available independently.

import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import { multiRowHarnessDiff } from '../../../tests/review/reviewAppHarness';

describe('authoring without a Current Story', () => {
  test('c on a row files a DIFF_LINE anchored where the cursor actually is', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r'); // into the diff
    await app.press('\r'); // descend to row grain — the anchor is the row you are ON

    await app.press('c');
    expect(app.frame()).toContain('Comment on src/fixture.ts:1');

    await app.pressAll([...'this allocation is unbounded', '']); // ^S submits
    await app.settleUntil((frame) => frame.includes('Comment filed'));

    const [filed] = app.sidecar();
    expect(filed).toBeDefined();
    expect(filed!.body).toBe('this allocation is unbounded');
    expect(filed!.anchor).toMatchObject({
      kind: 'DIFF_LINE',
      file: 'src/fixture.ts',
      side: 'add',
      line: 1,
      hunkKey: 'hunk_fixture',
    });
    // A content hash, not a line number — that is what survives a re-floor.
    expect(filed!.anchor).toHaveProperty('lineHash');
    app.unmount();
  });

  test('c at slice grain anchors inside the active slice without row-mode ceremony', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r'); // diff, slice grain

    await app.press('c');
    expect(app.frame()).toContain('Comment on src/fixture.ts:1');
    await app.pressAll([...'slice-level concern', '\u0013']);
    await app.settleUntil((frame) => frame.includes('Comment filed'));

    const [filed] = app.sidecar();
    expect(filed!.anchor).toMatchObject({
      kind: 'DIFF_LINE',
      file: 'src/fixture.ts',
      side: 'add',
      line: 1,
      hunkKey: 'hunk_fixture',
    });

    await app.press('C');
    expect(app.frame()).toContain('src/fixture.ts:1');
    app.unmount();
  });

  test('a v-span files a DIFF_RANGE — which is what v was drawing a selection FOR', async () => {
    // `v` is the DIFF_RANGE authoring gesture: it draws the range this files.
    //
    // `multiRowHarnessDiff` because every hunk in the default fixture is a SINGLE
    // changed row -- so `v` selects a span of one, the range collapses to a point, and
    // DIFF_LINE is the correct answer. A range is unrepresentable in that fixture.
    const app = await mountReviewApp({
      scenario: 'wide-hunk',
      width: 160,
      reviewDiff: multiRowHarnessDiff(),
    });
    await app.press('\r');
    await app.press('\r'); // row grain, on the first changed row
    await app.press('v'); // anchor the span here
    await app.press('j'); // extend it over the second row

    await app.press('c');
    expect(app.frame()).toContain('Comment on src/fixture.ts:1–2');
    await app.pressAll([...'both of these', '']);
    await app.settleUntil((frame) => frame.includes('Comment filed'));

    const [filed] = app.sidecar();
    expect(filed!.anchor).toMatchObject({
      kind: 'DIFF_RANGE',
      file: 'src/fixture.ts',
      side: 'add',
      line: 1,
      endLine: 2,
    });
    // EVERY line in the span is hashed, not just the first — a range that re-anchors
    // off one line is a range that silently shrinks when that line moves.
    expect((filed!.anchor as { lineHashes: string[] }).lineHashes).toHaveLength(2);
    app.unmount();
  });
});

describe('the index without a Current Story', () => {
  test('C opens the comments index without a Current Story', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('C');

    expect(app.state().screen).toBe('comments');
    expect(app.frame()).toContain('COMMENTS');
    app.unmount();
  });

  test('reads the comment sidecar independently of the Story model', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r');
    await app.press('\r');
    await app.press('c');
    await app.pressAll([...'a comment with no Story around it', '']);
    await app.settleUntil((frame) => frame.includes('Comment filed'));

    await app.press('C');

    const frame = app.frame();
    expect(frame).toContain('a comment with no Story around it');
    // And it says WHERE it landed — the re-anchor fate.
    expect(frame).toContain('src/fixture.ts:1');
    app.unmount();
  });
});

describe('the round trip', () => {
  test('author → agent replies out-of-band → reviewer resolves without a Current Story', async () => {
    // THE LOOP. The agent's half arrives through the CLI track while the TUI is open,
    // which is exactly how `orcaops-task-review address-comments` works.
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });

    // 1. The reviewer files a comment on a row.
    await app.press('\r');
    await app.press('\r');
    await app.press('c');
    await app.pressAll([...'why is this unbounded', '']);
    await app.settleUntil((frame) => frame.includes('Comment filed'));

    const [filed] = app.sidecar();
    expect(filed!.status).toBe('open');
    expect(filed!.replies).toHaveLength(0);

    // 2. The AGENT replies out of band — no keystroke, no reader involvement.
    app.agentReplies(filed!.comment_id, 'bounded it in cp4; see the new guard');

    // 3. The reviewer refreshes and SEES it, in the index and on the pin.
    await app.press('C');
    await app.settleUntil((frame) => frame.includes('bounded it in cp4'));
    expect(app.frame()).toContain('bounded it in cp4; see the new guard');

    // 4. The reviewer resolves it.
    await app.press('x');
    await app.settleUntil((frame) => frame.includes('Comment resolved'));

    const [resolved] = app.sidecar();
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.replies).toHaveLength(1);
    expect(resolved!.replies[0]!.author).toBe('agent');
    app.unmount();
  });

  test('the reviewer can reply too — y, on the deterministic path', async () => {
    const app = await mountReviewApp({ scenario: 'no-narrative', width: 160 });
    await app.press('\r');
    await app.press('\r');
    await app.press('c');
    await app.pressAll([...'question', '']);
    await app.settleUntil((frame) => frame.includes('Comment filed'));

    await app.press('C');
    await app.press('y');
    expect(app.frame()).toContain('Reply to comment');

    await app.pressAll([...'answering my own question', '']);
    await app.settleUntil((frame) => frame.includes('Reply filed'));

    const [comment] = app.sidecar();
    expect(comment!.replies.map((reply) => reply.body)).toEqual(['answering my own question']);
    app.unmount();
  });
});

describe('the anchor is the row the cursor is ON', () => {
  test('on a SHARED hunk, c anchors this page’s row — not the one above it', async () => {
    // The row cursor walks `changedRowsForFloorHunk` — the rows the PAGE owns. The line
    // BODIES, which the content hash covers, exist only in the patch, and the patch
    // hunk carries every changed row in it including rows another checkpoint owns.
    //
    // Those two lists are different lengths, so indexing the patch by the cursor's
    // number anchors the comment on a different line than the one under the cursor —
    // silently, and off by however many rows another checkpoint owns above it.
    //
    // `hunk_fixture_second` has add row 11 (cp1's) and add row 12 (cp2's). Standing on
    // cp2's page, the cursor's ONLY row is 12. A patch-indexed anchor would take
    // index 0 of the patch, which is row ELEVEN — cp1's code, filed under cp2's page,
    // against a line the reviewer was not looking at.
    const app = await mountReviewApp({ scenario: 'two-checkpoints', width: 160 });
    await app.press('\r'); // diff, on cp1
    await app.press(']'); // page to cp2 — its first owned hunk is the shared one
    await app.press('\r'); // row grain

    expect(app.frame()).toContain('Checkpoint 2/2 · Second checkpoint');
    await app.press('c');
    await app.pressAll([...'this row is cp2s', '']);
    await app.settleUntil((frame) => frame.includes('Comment filed'));

    const [filed] = app.sidecar();
    expect(filed!.anchor).toMatchObject({
      kind: 'DIFF_LINE',
      file: 'src/fixture.ts',
      side: 'add',
      line: 12,
      hunkKey: 'hunk_fixture_second',
    });
    app.unmount();
  });
});
