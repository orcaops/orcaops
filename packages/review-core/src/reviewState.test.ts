import { describe, expect, it } from 'vitest';

import { matchReviewedRows, type ReviewedRow, reviewedRowsDigest } from './reviewState.js';

const row = (over: Partial<ReviewedRow> = {}): ReviewedRow => ({
  file: 'src/a.ts',
  side: 'add',
  lineHash: 'h1',
  line: 5,
  ...over,
});

describe('matchReviewedRows', () => {
  it('an identical set matches fully and is not stale', () => {
    const rows = [row(), row({ lineHash: 'h2', line: 9 })];
    expect(matchReviewedRows(rows, rows)).toEqual({
      matched: 2,
      newRows: 0,
      removedRows: 0,
      stale: false,
    });
  });

  it('growth stales: an unmatched CURRENT row is genuinely new', () => {
    const reviewed = [row()];
    const current = [row(), row({ lineHash: 'hNEW', line: 6 })];
    expect(matchReviewedRows(reviewed, current)).toEqual({
      matched: 1,
      newRows: 1,
      removedRows: 0,
      stale: true,
    });
  });

  it('shrink does not stale: an unmatched REVIEWED row just disappeared', () => {
    const reviewed = [row(), row({ lineHash: 'hGONE', line: 6 })];
    const current = [row()];
    expect(matchReviewedRows(reviewed, current)).toEqual({
      matched: 1,
      newRows: 0,
      removedRows: 1,
      stale: false,
    });
  });

  it('a pure move (same content, shifted line, re-keyed hunk) stays matched', () => {
    const reviewed = [row({ line: 5, hunkKey: 'hunk_old' })];
    const current = [row({ line: 42, hunkKey: 'hunk_new' })];
    expect(matchReviewedRows(reviewed, current).stale).toBe(false);
  });

  it('duplicate line hashes match 1:1 — a current row is never consumed twice', () => {
    const dupA = row({ line: 5 });
    const dupB = row({ line: 9 });
    // Two records, two duplicates → both match.
    expect(matchReviewedRows([dupA, dupB], [dupA, dupB])).toMatchObject({
      matched: 2,
      newRows: 0,
      stale: false,
    });
    // ONE record, two identical current rows → the second is genuine growth.
    expect(matchReviewedRows([dupA], [dupA, dupB])).toMatchObject({
      matched: 1,
      newRows: 1,
      stale: true,
    });
  });

  it('prefers the same surviving hunk over a nearer line', () => {
    const reviewed = [row({ line: 5, hunkKey: 'H' })];
    const near = row({ line: 4, hunkKey: 'X' });
    const sameHunkFar = row({ line: 50, hunkKey: 'H' });
    const result = matchReviewedRows(reviewed, [near, sameHunkFar]);
    // The same-hunk candidate is consumed; the near foreign one is leftover growth.
    expect(result).toMatchObject({ matched: 1, newRows: 1 });
  });

  it('falls back to the nearest line among same-content candidates', () => {
    const reviewed = [row({ line: 10 })];
    const far = row({ line: 100 });
    const near = row({ line: 12 });
    // Only one reviewed record: it should consume `near`, leaving `far` as growth.
    const result = matchReviewedRows(reviewed, [far, near]);
    expect(result).toMatchObject({ matched: 1, newRows: 1, stale: true });
    // Symmetric check: two records consume both, no growth.
    expect(matchReviewedRows([row({ line: 10 }), row({ line: 99 })], [far, near]).stale).toBe(
      false
    );
  });
});

describe('reviewedRowsDigest', () => {
  it('is order-independent and ignores the positional/hunk hints', async () => {
    const a = [row({ line: 5, hunkKey: 'H1' }), row({ lineHash: 'h2', line: 9 })];
    const moved = [row({ lineHash: 'h2', line: 90 }), row({ line: 55, hunkKey: 'H9' })];
    expect(await reviewedRowsDigest(a)).toBe(await reviewedRowsDigest(moved));
  });

  it('changes when content identities change', async () => {
    const base = [row()];
    expect(await reviewedRowsDigest(base)).not.toBe(
      await reviewedRowsDigest([row(), row({ lineHash: 'h2' })])
    );
    expect(await reviewedRowsDigest(base)).not.toBe(
      await reviewedRowsDigest([row({ side: 'delete' })])
    );
  });
});
