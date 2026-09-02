import { describe, expect, it } from 'vitest';

import { getHwmBaseline, type HwmBaselineEvent } from './hwm-baseline.js';

// Synthetic event builders — only the fields getHwmBaseline actually reads.
const opened = (n: number): HwmBaselineEvent => ({
  record: { type: 'checkpoint_opened' },
  payload: { n },
});
const closed = (n: number, tree: string | null): HwmBaselineEvent => ({
  record: { type: 'checkpoint_closed' },
  payload: { n, close_snapshot: { tree_sha: tree } },
});
const abandoned = (n: number, tree: string | null): HwmBaselineEvent => ({
  record: { type: 'checkpoint_abandoned' },
  payload: { n, abandon_snapshot: { tree_sha: tree } },
});

describe('getHwmBaseline', () => {
  it('serial chain → latest prior finalized cp close tree', () => {
    // Closing cp2; cp1 opened+closed serially before cp2 opened.
    const events = [opened(1), closed(1, 'T1'), opened(2)];
    expect(getHwmBaseline(events, 2, 2)).toEqual({
      hwmBaselineTreeSha: 'T1',
      recoveryBlocked: false,
    });
  });

  it('serial chain → HIGHEST-n prior finalized cp, not an older one', () => {
    // Closing cp3; cp1 and cp2 both finalized serially → HWM is cp2 (T2).
    const events = [opened(1), closed(1, 'T1'), opened(2), closed(2, 'T2'), opened(3)];
    expect(getHwmBaseline(events, 3, 4)).toEqual({
      hwmBaselineTreeSha: 'T2',
      recoveryBlocked: false,
    });
  });

  it('serial-abandon → recovers from the abandoned cp abandon tree, NOT the seed', () => {
    // cp1 abandoned after edits, then cp2 opened serially. HWM = cp1 abandon tree.
    const events = [opened(1), abandoned(1, 'TA1'), opened(2)];
    expect(getHwmBaseline(events, 2, 2)).toEqual({
      hwmBaselineTreeSha: 'TA1',
      recoveryBlocked: false,
    });
  });

  it('no prior finalized cp → null tree, recoveryBlocked false (seed path)', () => {
    // Closing cp1, the first cp — nothing finalized before it.
    const events = [opened(1)];
    expect(getHwmBaseline(events, 1, 0)).toEqual({
      hwmBaselineTreeSha: null,
      recoveryBlocked: false,
    });
  });

  it('latest finalized cp with a NULL terminal tree → recoveryBlocked, NOT seed (no double-count)', () => {
    // cp1 closed but its close snapshot was skipped (tree_sha null).
    const events = [opened(1), closed(1, null), opened(2)];
    expect(getHwmBaseline(events, 2, 2)).toEqual({
      hwmBaselineTreeSha: null,
      recoveryBlocked: true,
    });
  });

  it('live overlap (two concurrent opens) blocks recovery on EITHER close', () => {
    // cp1 and cp2 both open; closing either over an empty fence is blocked.
    const events = [opened(1), opened(2)];
    expect(getHwmBaseline(events, 2, 1)).toEqual({
      hwmBaselineTreeSha: null,
      recoveryBlocked: true,
    });
    expect(getHwmBaseline(events, 1, 0)).toEqual({
      hwmBaselineTreeSha: null,
      recoveryBlocked: true,
    });
  });

  it('historical overlap (cp1 & cp2 open together, cp1 closes, then cp2 closes) → recoveryBlocked', () => {
    // cp1 closed BEFORE cp2's close, but the intervals overlapped, so cp1's
    // close tree is not a clean HWM — blocked even though cp1 has a tree.
    const events = [opened(1), opened(2), closed(1, 'T1')];
    expect(getHwmBaseline(events, 2, 1)).toEqual({
      hwmBaselineTreeSha: null,
      recoveryBlocked: true,
    });
  });

  it('an overlapping ABANDONED cp also blocks (its edits are in the tree)', () => {
    const events = [opened(1), opened(2), abandoned(1, 'TA1')];
    expect(getHwmBaseline(events, 2, 1)).toEqual({
      hwmBaselineTreeSha: null,
      recoveryBlocked: true,
    });
  });

  it('a serial chain past an overlap still picks the clean prior HWM once intervals are disjoint', () => {
    // cp1 closed serially (clean), cp2 opened+closed serially, cp3 being closed.
    // No interval overlaps the current cp3 → HWM = cp2 (T2).
    const events = [opened(1), closed(1, 'T1'), opened(2), closed(2, 'T2'), opened(3)];
    expect(getHwmBaseline(events, 3, 4)).toEqual({
      hwmBaselineTreeSha: 'T2',
      recoveryBlocked: false,
    });
  });

  it('out-of-order concurrent closes → HWM is the LATEST close, not the highest n', () => {
    // cp1 & cp2 open together; cp2 closes FIRST (T2), then cp1 closes LAST (T1late);
    // cp3 opens after both. cp3 overlapped neither, so recovery is NOT blocked — but
    // the true high-water mark is cp1's later close (T1late), not the higher-n cp2
    // (T2). The by-n bug picked T2 and would mis-attribute cp1's T2→T1late delta.
    const events = [opened(1), opened(2), closed(2, 'T2'), closed(1, 'T1late'), opened(3)];
    expect(getHwmBaseline(events, 3, 4)).toEqual({
      hwmBaselineTreeSha: 'T1late',
      recoveryBlocked: false,
    });
  });

  it('out-of-order closes where the LATEST close has a null tree → recoveryBlocked, not the older non-null', () => {
    // Same shape, but cp1 (the latest close) skipped its snapshot (null tree). Keying
    // on the latest close must BLOCK; the by-n bug picked cp2's non-null T2 and ran
    // recovery from a stale tree (double-count).
    const events = [opened(1), opened(2), closed(2, 'T2'), closed(1, null), opened(3)];
    expect(getHwmBaseline(events, 3, 4)).toEqual({
      hwmBaselineTreeSha: null,
      recoveryBlocked: true,
    });
  });
});
