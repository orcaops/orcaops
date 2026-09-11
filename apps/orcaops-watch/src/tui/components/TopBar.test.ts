import { describe, expect, it } from 'vitest';

import type { WatchSnapshot } from '@orcaops/watch-data/ui';

import { formatSessionTokens, selectTopBarLayout } from './TopBar';

function snapshotWith(totals: Partial<WatchSnapshot['totals']>): WatchSnapshot {
  return {
    generated_at: '2026-09-05T00:02:00.000Z',
    generatedAtMs: Date.parse('2026-09-05T00:02:00.000Z'),
    dataRoot: '/data',
    rootKey: 'root',
    state: 'current',
    completeness: { complete: true, issues: [] },
    totals: {
      activeThreads: 0,
      openCheckpoints: 0,
      sessionTokens: 0,
      usageStatus: 'exact',
      ...totals,
    },
    projects: [],
    ticker: [],
  };
}
function tokenTile(snapshot: WatchSnapshot) {
  return selectTopBarLayout(snapshot, '12:34:56', 120).items.find((item) => item.id === 'tokens')!;
}

describe('top bar session tokens', () => {
  it('states the accounting completeness behind the total', () => {
    expect(formatSessionTokens(snapshotWith({ sessionTokens: 12_300 }).totals)).toBe('12.3k');
    expect(
      formatSessionTokens(snapshotWith({ sessionTokens: 12_300, usageStatus: 'partial' }).totals)
    ).toBe('≥12.3k');
    expect(formatSessionTokens(snapshotWith({ usageStatus: 'unavailable' }).totals)).toBe('—');
  });

  it('renders unavailable usage as no number rather than as zero', () => {
    const unavailable = tokenTile(snapshotWith({ usageStatus: 'unavailable' }));
    expect(unavailable.value).toBe('—');
    expect(unavailable.value).not.toMatch(/\d/u);
    expect(tokenTile(snapshotWith({ sessionTokens: 0 })).value).toBe('0');
  });

  it('keeps the tile width policy and the responsive drop order across the three states', () => {
    for (const totals of [
      { sessionTokens: 1_234_567 },
      { sessionTokens: 1_234_567, usageStatus: 'partial' as const },
      { usageStatus: 'unavailable' as const },
    ]) {
      const snapshot = snapshotWith(totals);
      const wide = selectTopBarLayout(snapshot, '12:34:56', 120);
      const tile = wide.items.find((item) => item.id === 'tokens')!;
      expect(tile.width).toBeGreaterThanOrEqual(tile.label.length + 3);
      expect(tile.width).toBeGreaterThanOrEqual(tile.value.length + 3);
      let squeezedOut = false;
      for (let width = 20; width <= 120; width += 1) {
        const layout = selectTopBarLayout(snapshot, '12:34:56', width);
        expect(layout.occupiedWidth).toBeLessThanOrEqual(width);
        expect(layout.requiredDroppedIds).toEqual([]);
        // Tokens carries the lowest priority, so nothing above it is dropped first.
        if (layout.droppedIds.some((id) => id === 'tasks' || id === 'checkpoints'))
          expect(layout.droppedIds).toContain('tokens');
        squeezedOut ||= layout.droppedIds.includes('tokens');
      }
      expect(squeezedOut).toBe(true);
    }
  });
});
