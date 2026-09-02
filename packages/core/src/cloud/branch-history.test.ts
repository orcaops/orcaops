import { describe, expect, it } from 'vitest';

import { BRANCH_HISTORY_CAP, dedupAppend, stripCurrentFromHistory } from './branch-history.js';

describe('branch-history helpers (CLI side)', () => {
  describe('dedupAppend', () => {
    it('appends new entries preserving order', () => {
      expect(dedupAppend(['a'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('skips entries already present in `existing`', () => {
      expect(dedupAppend(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('skips entries duplicated within the same `additions` batch', () => {
      expect(dedupAppend([], ['a', 'b', 'a'])).toEqual(['a', 'b']);
    });

    it('drops empty strings', () => {
      expect(dedupAppend([], ['', 'a', ''])).toEqual(['a']);
    });

    it('caps at BRANCH_HISTORY_CAP, dropping oldest entries first', () => {
      const eleven = Array.from({ length: 11 }, (_, i) => `b${i}`);
      const result = dedupAppend([], eleven);
      expect(result).toHaveLength(BRANCH_HISTORY_CAP);
      expect(result[0]).toBe('b1');
      expect(result.at(-1)).toBe('b10');
    });

    it('cap dedup applies after merge — combined existing + additions trimmed from the front', () => {
      const existing = Array.from({ length: 8 }, (_, i) => `e${i}`);
      const additions = ['n0', 'n1', 'n2'];
      const result = dedupAppend(existing, additions);
      expect(result).toHaveLength(BRANCH_HISTORY_CAP);
      expect(result.at(-1)).toBe('n2');
      expect(result[0]).toBe('e1');
    });
  });

  describe('stripCurrentFromHistory', () => {
    it('removes the current branch when it appears in the history', () => {
      expect(stripCurrentFromHistory('feat-x', ['old', 'feat-x', 'older'])).toEqual([
        'old',
        'older',
      ]);
    });

    it('drops empty strings', () => {
      expect(stripCurrentFromHistory('feat-x', ['old', '', 'older'])).toEqual(['old', 'older']);
    });

    it('returns an empty array when only the current branch is present', () => {
      expect(stripCurrentFromHistory('feat-x', ['feat-x'])).toEqual([]);
    });
  });
});
