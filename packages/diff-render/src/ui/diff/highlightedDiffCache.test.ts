import { describe, expect, it } from 'vitest';

import {
  estimateHighlightedDiffWeight,
  HighlightedDiffCache,
  MAX_HIGHLIGHT_CACHE_ENTRY_WEIGHT,
} from './highlightedDiffCache';
import type { HighlightedDiffCode } from './pierre';

function highlightedLines(count: number, width = 24): HighlightedDiffCode {
  return {
    deletionLines: [],
    additionLines: Array.from({ length: count }, (_, index) => ({
      type: 'text' as const,
      value: `${index.toString().padStart(6, '0')} ${'x'.repeat(width)}`,
    })),
  };
}

describe('HighlightedDiffCache', () => {
  it('does not globally retain a 5,000-line result', () => {
    const cache = new HighlightedDiffCache();
    const huge = highlightedLines(5_000);

    expect(estimateHighlightedDiffWeight(huge)).toBeGreaterThan(MAX_HIGHLIGHT_CACHE_ENTRY_WEIGHT);
    expect(cache.set('huge', huge)).toBe(false);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
  });

  it('retains and reuses ordinary highlight results', () => {
    const cache = new HighlightedDiffCache();
    const ordinary = highlightedLines(120);

    expect(cache.set('ordinary', ordinary)).toBe(true);
    expect(cache.get('ordinary')).toBe(ordinary);
    expect(cache.size).toBe(1);
    expect(cache.weight).toBe(estimateHighlightedDiffWeight(ordinary));
  });

  it('evicts least-recently-used entries under the weight budget', () => {
    const one = highlightedLines(4, 8);
    const entryWeight = estimateHighlightedDiffWeight(one);
    const cache = new HighlightedDiffCache({
      maxEntries: 10,
      maxEntryWeight: entryWeight,
      maxWeight: entryWeight * 2,
    });

    expect(cache.set('first', one)).toBe(true);
    expect(cache.set('second', highlightedLines(4, 8))).toBe(true);
    expect(cache.get('first')).toBe(one); // Promote first; second is now the LRU.
    expect(cache.set('third', highlightedLines(4, 8))).toBe(true);

    expect(cache.has('first')).toBe(true);
    expect(cache.has('second')).toBe(false);
    expect(cache.has('third')).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.weight).toBeLessThanOrEqual(entryWeight * 2);
  });

  it('keeps the existing entry-count guardrail for many small results', () => {
    const cache = new HighlightedDiffCache({
      maxEntries: 2,
      maxEntryWeight: Number.POSITIVE_INFINITY,
      maxWeight: Number.POSITIVE_INFINITY,
    });

    expect(cache.set('first', highlightedLines(1))).toBe(true);
    expect(cache.set('second', highlightedLines(1))).toBe(true);
    expect(cache.set('third', highlightedLines(1))).toBe(true);

    expect(cache.has('first')).toBe(false);
    expect(cache.has('second')).toBe(true);
    expect(cache.has('third')).toBe(true);
  });
});
