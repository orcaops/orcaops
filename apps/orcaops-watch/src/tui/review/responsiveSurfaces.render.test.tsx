import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';
import { tallTwoFileHarnessDiff } from '../../../tests/review/reviewAppHarness';
import type { EnrichedComment } from '../../data/commentsSource';

const WIDE_COMMENT = {
  comment_id: 'cmt_wide_prose',
  ts: '2026-07-22T00:00:00.000Z',
  author: 'reviewer',
  body: 'This required reviewer disclosure remains visible inside the readable prose measure.',
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
} satisfies EnrichedComment;

function offPageComments(): EnrichedComment[] {
  return Array.from({ length: 8 }, (_, index) => ({
    ...WIDE_COMMENT,
    comment_id: `cmt_short_off_page_${index}`,
    body: `off-page comment ${index}`,
    anchor: {
      kind: 'DIFF_LINE',
      file: 'src/off-page.ts',
      side: 'add',
      line: index + 1,
      lineHash: `hash_off_page_${index}`,
    },
    position: {
      rung: 'unanchored',
      file: null,
      side: null,
      line: null,
      endLine: null,
      hunkKey: null,
      threadKey: null,
      drifted: false,
    },
  }));
}

describe('responsive review surfaces', () => {
  test.each([12, 24])('keeps the primary body and footer usable at %i rows', async (height) => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 110,
      height,
    });

    const body = app.surfaceRect('review-screen-plane');
    const footer = app.surfaceRect('review-footer');
    expect(app.rows().slice(0, height)).toHaveLength(height);
    expect(body.height).toBeGreaterThanOrEqual(6);
    expect(footer.height).toBe(1);
    expect(footer.y + footer.height).toBe(height);
    expect(app.frame()).toContain('CAPTURED WORK');
    expect(app.frame()).toContain('? help');
    app.unmount();
  });

  test('bounds off-page pins only when needed to preserve a six-row diff viewport', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      comments: offPageComments(),
      width: 160,
      height: 12,
    });

    expect(app.surface('review-off-page-pins').height).toBe(3);
    expect(app.scrollBounds().viewport).toBe(6);
    expect(app.frame()).toContain('off-page comment 0');
    app.unmount();
  });

  test('caps wide brief, finish, and comment prose without hiding required disclosures', async () => {
    const brief = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'brief',
      width: 220,
    });
    // The Brief is two bounded panes now, not one capped prose column: at 220
    // columns it uses the whole terminal rather than leaving half of it dead.
    const overview = brief.surface('review-brief-overview');
    const tree = brief.surface('review-brief-tree');
    expect(overview.width).toBe(110);
    expect(tree.width).toBe(109);
    expect(overview.width + tree.width).toBeLessThanOrEqual(220);
    expect(brief.frame()).toContain('captured checkpoints');
    brief.unmount();

    const finish = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'finish',
      width: 220,
    });
    expect(finish.surface('review-finish-prose').width).toBe(106);
    expect(finish.frame()).toContain('Required review work remains');
    finish.unmount();

    const comments = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'comments',
      comments: [WIDE_COMMENT],
      width: 220,
    });
    expect(comments.surface('review-comments-prose').width).toBe(106);
    expect(comments.frame()).toContain('required reviewer disclosure remains visible');
    comments.unmount();
  });

  test('paints diff focus in the existing header inset without changing measured geometry', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'floor-diff',
      reviewDiff: tallTwoFileHarnessDiff(120, 120, true),
      controllerState: { wrapLines: true },
      width: 160,
      height: 22,
    });
    await app.pressAll(['f', 'f']);
    expect(app.state().focus).toBe('diff');
    expect(app.surface('review-diff-focus-marker')).toMatchObject({ width: 1, height: 1 });

    const focusedGeometry = {
      pane: app.surfaceRect('review-diff-pane'),
      readerHeader: app.surfaceRect('review-reader-header'),
      stickyHeader: app.surfaceRect('review-pinned-file-header'),
      scroll: app.scrollBounds(),
      scrollTop: app.scrollTop(),
      nodes: app.diffNodeCount(),
    };

    await app.press('tab');

    expect(app.state().focus).toBe('rail');
    expect(app.surface('review-diff-focus-marker')).toMatchObject({ width: 0, height: 0 });
    expect({
      pane: app.surfaceRect('review-diff-pane'),
      readerHeader: app.surfaceRect('review-reader-header'),
      stickyHeader: app.surfaceRect('review-pinned-file-header'),
      scroll: app.scrollBounds(),
      scrollTop: app.scrollTop(),
      nodes: app.diffNodeCount(),
    }).toEqual(focusedGeometry);

    await app.press('tab');
    expect(app.state().focus).toBe('diff');
    expect(app.surface('review-diff-focus-marker')).toMatchObject({ width: 1, height: 1 });
    expect(app.scrollBounds()).toEqual(focusedGeometry.scroll);
    app.unmount();
  });
});
