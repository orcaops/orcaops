import { describe, expect, test } from 'bun:test';

import type { ReanchoredPosition } from '@orcaops/review-core';

import { mountReviewApp, rowOf } from '../../../tests/review/mountReviewApp';
import { tallTwoFileHarnessDiff } from '../../../tests/review/reviewAppHarness';
import type { EnrichedComment } from '../../data/commentsSource';

function unanchoredComment(index: number): EnrichedComment {
  const position: ReanchoredPosition = {
    rung: 'unanchored',
    file: null,
    side: null,
    line: null,
    endLine: null,
    hunkKey: null,
    threadKey: null,
    drifted: false,
  };
  return {
    comment_id: `off-page-${index}`,
    ts: '2026-07-17T00:00:00.000Z',
    author: 'reviewer',
    body: `off-page comment ${index}`,
    status: 'open',
    anchor: {
      kind: 'DIFF_LINE',
      file: 'src/off-page.ts',
      side: 'add',
      line: index + 1,
      lineHash: `hash_off_page_${index}`,
    },
    replies: [],
    context: [],
    owner: null,
    trail: [],
    position,
  };
}

const ADDED_PATCH = [
  'diff --git a/src/fixture.ts b/src/fixture.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/fixture.ts',
  '@@ -0,0 +1 @@',
  '+stable fixture row',
  '',
].join('\n');

const DELETED_PATCH = [
  'diff --git a/src/fixture.ts b/src/fixture.ts',
  'deleted file mode 100644',
  '--- a/src/fixture.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-stable fixture row',
  '',
].join('\n');

const RENAMED_PATCH = [
  'diff --git a/src/old.ts b/src/fixture.ts',
  'similarity index 90%',
  'rename from src/old.ts',
  'rename to src/fixture.ts',
  '--- a/src/old.ts',
  '+++ b/src/fixture.ts',
  '@@ -1 +1 @@',
  '-old fixture row',
  '+stable fixture row',
  '',
].join('\n');

describe('the contextual review rail', () => {
  test('puts captured reviewer value before compact navigation and drops identifier noise', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 40,
    });
    const frame = app.frame();
    const rows = app.rows();

    expect(frame).toContain('REVIEW CONTEXT · CHECKPOINT');
    expect(frame).toContain('OUTCOME');
    expect(frame).toContain('Checkpoint 1 reworked the');
    expect(frame).toContain('configuration loader path.');
    expect(frame).toContain('CAPTURED QUESTIONS · 1 OPEN');
    expect(frame).toContain('OPEN The terminal density still');
    expect(frame).toContain('needs a real-width drive.');
    expect(frame).not.toContain('WHAT TO REVIEW');
    expect(frame).not.toContain('AUTOMATED CONCERNS');
    expect(frame).not.toContain('reader-contract');
    expect(frame).toContain('DECISION');
    expect(frame).toContain('FILES');
    expect(frame).not.toContain('artifact-fixture');
    expect(frame).not.toContain('NO SYNTHESIS · NO SEMANTIC CODE LINK');

    expect(rowOf(rows, 'OUTCOME')).toBeLessThan(rowOf(rows, 'CAPTURED QUESTIONS'));
    expect(rowOf(rows, 'CAPTURED QUESTIONS')).toBeLessThan(rowOf(rows, 'DECISION'));
    expect(rowOf(rows, 'DECISION')).toBeLessThan(rowOf(rows, 'FILES'));

    const panel = app.surfaceRect('review-context-panel');
    const panelFrame = rows
      .slice(panel.y, panel.y + panel.height)
      .map((row) => row.slice(panel.x, panel.x + panel.width))
      .join('\n');
    expect(panelFrame).toContain('─');
    expect(panelFrame).not.toMatch(/[┌┐└┘│]/u);
    app.unmount();
  });

  test('separates an actionable evaluator violation from review guidance', async () => {
    const app = await mountReviewApp({
      scenario: 'evaluator-concern-floor-only',
      screen: 'floor-diff',
      width: 160,
      height: 40,
    });
    const frame = app.frame();
    const rows = app.rows();

    expect(frame).not.toContain('WHAT TO REVIEW');
    expect(frame).toContain('AUTOMATED CONCERNS');
    expect(frame).toContain('reader-contract · WARN');
    expect(frame).toContain('Slice ownership needs verification.');
    expect(rowOf(rows, 'CAPTURED QUESTIONS')).toBeLessThan(rowOf(rows, 'AUTOMATED CONCERNS'));
    expect(rowOf(rows, 'AUTOMATED CONCERNS')).toBeLessThan(rowOf(rows, 'DECISION'));
    app.unmount();
  });
});

describe('compact file navigation', () => {
  test('the visible header and backslash key share one collapse transition', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 40,
    });

    expect(app.surface('review-file-navigator').height).toBeGreaterThan(3);
    await app.press('\\');
    expect(app.state().fileNavigatorExpanded).toBe(false);
    expect(app.surface('review-file-navigator').height).toBe(3);
    expect(app.frame()).not.toContain('src/ · 2');

    const headerRow = rowOf(app.rows(), 'FILES · 2');
    expect(headerRow).toBeGreaterThan(-1);
    await app.mockMouse.click(5, headerRow);
    await app.settle();
    expect(app.state().fileNavigatorExpanded).toBe(true);
    expect(app.frame()).toContain('src/ · 2');
    app.unmount();
  });

  test.each([80, 109])(
    'compact %i-column layouts give file expansion real rows and a one-row collapse',
    async (width) => {
      const app = await mountReviewApp({
        scenario: 'no-narrative',
        screen: 'floor-diff',
        width,
        height: 24,
      });

      expect(app.surface('review-file-navigator').height).toBe(5);
      expect(app.frame()).toContain('fixture.ts');
      await app.press('\\');
      expect(app.state().fileNavigatorExpanded).toBe(false);
      expect(app.surface('review-file-navigator').height).toBe(1);
      expect(app.frame()).toContain('FILES · 2');
      await app.press('\\');
      expect(app.surface('review-file-navigator').height).toBe(5);
      app.unmount();
    }
  );

  test('file hover is visible but never mutates the review cursor', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 40,
    });
    const beforeState = app.state();
    // Row 1 is the viewport-oriented file and already owns the stronger violet
    // background. Hover the cursor-only row so this assertion isolates hover.
    const row = app.surfaceRect('review-file-navigator-row-0');
    const beforeBackground = app.surfaceBackground('review-file-navigator-row-0');

    await app.mockMouse.moveTo(row.x + 2, row.y);
    await app.settle();

    expect(app.surfaceBackground('review-file-navigator-row-0')).not.toEqual(beforeBackground);
    expect(app.state()).toEqual(beforeState);
    app.unmount();
  });

  test.each([
    ['A', 'A fixture.ts', ADDED_PATCH],
    ['D', 'D fixture.ts', DELETED_PATCH],
    ['R', 'R old.ts → fixture.ts', RENAMED_PATCH],
  ] as const)(
    'renders a truthful %s badge in the contextual rail',
    async (_badge, label, reviewDiff) => {
      const app = await mountReviewApp({
        scenario: 'no-narrative',
        screen: 'floor-diff',
        width: 160,
        height: 40,
        reviewDiff,
      });

      expect(app.frame()).toContain(label);
      expect(app.state().focus).toBe('diff');
      app.unmount();
    }
  );

  test('a click and keyboard file move use the same selected-slice transition', async () => {
    const clicked = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 40,
      reviewDiff: tallTwoFileHarnessDiff(120, 120),
    });
    const fileRow = clicked.surfaceRect('review-file-navigator-row-1');
    await clicked.mockMouse.click(fileRow.x + 2, fileRow.y);
    await clicked.settle();
    const clickedState = clicked.state();

    expect(clickedState.diffSliceKey).toBe('hunk_fixture_third:s0');
    expect(clicked.scrollTop()).toBeGreaterThan(120);
    expect(clicked.rows()[1]).toContain('src/second.ts');
    expect(clicked.frame()).toContain('▌•M second.ts');

    const keyed = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 40,
      reviewDiff: tallTwoFileHarnessDiff(120, 120),
    });
    await keyed.press('.');
    expect(keyed.state()).toMatchObject({
      diffSliceKey: clickedState.diffSliceKey,
      diffHunkKey: clickedState.diffHunkKey,
      diffGrain: clickedState.diffGrain,
      diffRowCursor: clickedState.diffRowCursor,
    });
    expect(keyed.scrollTop()).toBe(clicked.scrollTop());
    expect(keyed.rows()[1]).toContain('src/second.ts');
    expect(keyed.frame()).toContain('▌•M second.ts');
    clicked.unmount();
    keyed.unmount();
  });

  test('an in-stream file header selects the same file before it becomes sticky', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 40,
      reviewDiff: tallTwoFileHarnessDiff(120, 120),
    });
    await app.pressAll(['f', 'f', 'f']);
    const row = app.rows().findIndex((line) => line.slice(42).includes('M src/second.ts'));
    expect(row).toBeGreaterThan(-1);
    const column = app.rows()[row]!.indexOf('M src/second.ts') + 2;

    await app.mockMouse.click(column, row);
    await app.settle();

    expect(app.state().diffSliceKey).toBe('hunk_fixture_third:s0');
    expect(app.scrollTop()).toBeGreaterThan(120);
    expect(app.rows()[1]).toContain('src/second.ts');
    app.unmount();
  });

  test('free scrolling updates pinned and viewport files without moving the semantic cursor', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 22,
      reviewDiff: tallTwoFileHarnessDiff(120, 120),
    });
    const cursor = app.state().diffSliceKey;

    await app.press('G');

    expect(app.state().diffSliceKey).toBe(cursor);
    expect(app.rows()[1]).toContain('src/second.ts');
    expect(app.frame()).toContain('▌ M second.ts');
    expect(app.frame()).toContain('•M fixture.ts');
    app.unmount();
  });

  test('viewport file highlighting uses the native height left below off-page pins', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 22,
      reviewDiff: tallTwoFileHarnessDiff(1, 5),
      comments: Array.from({ length: 8 }, (_, index) => unanchoredComment(index)),
    });
    await app.settle();

    expect(app.scrollBounds().viewport).toBe(11);
    expect(app.frame()).toContain('▌•M fixture.ts');
    expect(app.frame()).not.toContain('▌ M second.ts');
    app.unmount();
  });

  test('native scrollbar dragging synchronizes virtualization before the next wheel event', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 22,
      reviewDiff: tallTwoFileHarnessDiff(400, 400),
    });
    const cursor = app.state().diffSliceKey;
    const surface = app.surfaceRect('review-diff-scroll');

    await app.mockMouse.drag(
      surface.x + surface.width - 1,
      surface.y + 1,
      surface.x + surface.width - 1,
      surface.y + surface.height - 2
    );
    await app.settle();
    // The deep jump deliberately widens overscan for one short burst; prove it
    // contracts again after the same idle window production uses.
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    await app.settle();

    expect(app.scrollTop()).toBeGreaterThan(100);
    expect(app.state().diffSliceKey).toBe(cursor);
    expect(app.rows()[1]).toContain('src/second.ts');
    expect(app.frame()).toContain('second file row');
    expect(app.diffNodeCount()).toBeLessThan(1_000);
    app.unmount();
  });

  test('native scrollbar synchronization survives a comment modal remount', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      width: 160,
      height: 22,
      reviewDiff: tallTwoFileHarnessDiff(400, 400),
    });
    const cursor = app.state().diffSliceKey;

    await app.press('c');
    expect(app.frame()).toContain('Comment on src/fixture.ts');
    await app.press('\x1b');

    const surface = app.surfaceRect('review-diff-scroll');
    await app.mockMouse.drag(
      surface.x + surface.width - 1,
      surface.y + 1,
      surface.x + surface.width - 1,
      surface.y + surface.height - 2
    );
    await app.settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    await app.settle();

    expect(app.scrollTop()).toBeGreaterThan(100);
    expect(app.state().diffSliceKey).toBe(cursor);
    expect(app.rows()[1]).toContain('src/second.ts');
    expect(app.frame()).toContain('second file row');
    expect(app.diffNodeCount()).toBeLessThan(1_000);
    app.unmount();
  });

  test.each([80, 110, 160])(
    'Unassigned uses the same rail and truthful file rows at %i columns',
    async (width) => {
      const app = await mountReviewApp({
        scenario: 'unassigned-floor-only',
        screen: 'unassigned',
        width,
        height: 40,
      });
      const frame = app.frame();
      expect(frame).toContain('REVIEW CONTEXT · UNASSIGNED');
      expect(frame).toContain('No checkpoint owns these rows');
      expect(frame).toContain('FILES');
      expect(frame).toContain('A src/unassigned.ts');
      expect(frame).toContain('M src/ambiguous.ts');
      expect(frame).not.toContain('WHAT TO REVIEW');
      expect(rowOf(app.rows(), 'No checkpoint owns')).toBeLessThan(rowOf(app.rows(), 'FILES'));
      app.unmount();
    }
  );
});

describe('rail cursor-follow', () => {
  test.each([80, 110, 160])(
    'keeps the selected deterministic uncertainty visible at %i columns',
    async (width) => {
      const app = await mountReviewApp({
        scenario: 'rail-overflow-floor-only',
        screen: 'floor-diff',
        width,
        height: 22,
      });
      expect(app.railScrollBounds().content).toBeGreaterThan(app.railScrollBounds().viewport);

      await app.press('\t');
      await app.pressAll(Array.from({ length: 11 }, () => 'j'));

      expect(app.state().contextItemCursor).toBe(11);
      expect(app.frame()).toContain('❯ ⚑ OPEN Rail overflow concern');
      expect(app.railScrollBounds().top).toBeGreaterThan(0);
      app.unmount();
    }
  );

  test('dispositions the uncertainty that cursor-follow leaves visibly selected', async () => {
    const app = await mountReviewApp({
      scenario: 'rail-overflow-floor-only',
      screen: 'floor-diff',
      width: 160,
      height: 22,
    });
    await app.press('\t');
    await app.pressAll(Array.from({ length: 11 }, () => 'j'));
    expect(app.frame()).toContain('❯ ⚑ OPEN Rail overflow concern');

    await app.press('a');
    await app.settleUntil((frame) => frame.includes('ACKNOWLEDGED Rail overflow'));
    expect(app.journalEvents.at(-1)).toMatchObject({
      type: 'uncertainty',
      citationId: 'cite:artifact-fixture:cp1:uncertainty:11',
      action: 'ACKNOWLEDGE',
    });
    expect(app.frame()).toContain('❯ ⚑ ACKNOWLEDGED Rail overflow');
    app.unmount();
  });
});

describe('production rail acceptance', () => {
  test.each([80, 110, 160])(
    'keeps guidance semantics truthful across every page kind at %i columns',
    async (width) => {
      const checkpoint = await mountReviewApp({
        scenario: 'no-narrative',
        screen: 'floor-diff',
        width,
        height: 70,
      });
      expect(checkpoint.frame()).toContain('REVIEW CONTEXT · CHECKPOINT');
      expect(checkpoint.frame()).toContain('OUTCOME');
      expect(checkpoint.frame()).toContain('CAPTURED QUESTIONS');
      expect(checkpoint.frame()).toContain('FILES');
      expect(checkpoint.frame()).not.toContain('WHAT TO REVIEW');
      expect(checkpoint.frame()).not.toContain('AUTOMATED CONCERNS');
      expect(checkpoint.surface('review-footer').backgroundAlpha).toBe(1);
      checkpoint.unmount();

      const concern = await mountReviewApp({
        scenario: 'evaluator-concern-floor-only',
        screen: 'floor-diff',
        width,
        height: 70,
      });
      expect(concern.frame()).toContain('AUTOMATED CONCERNS');
      expect(concern.frame()).toContain('Slice ownership needs');
      expect(concern.frame()).toContain('verification.');
      expect(concern.frame()).not.toContain('WHAT TO REVIEW');
      concern.unmount();

      const unassigned = await mountReviewApp({
        scenario: 'unassigned-floor-only',
        screen: 'unassigned',
        width,
        height: 70,
      });
      expect(unassigned.frame()).toContain('REVIEW CONTEXT · UNASSIGNED');
      expect(unassigned.frame()).toContain('FILES');
      expect(unassigned.frame()).not.toContain('WHAT TO REVIEW');
      unassigned.unmount();
    }
  );
});
