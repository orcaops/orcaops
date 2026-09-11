import { describe, expect, it } from 'vitest';

import { normalizeHistoryFilters, parseHistoryTime } from './history-filters.js';

describe('history filters', () => {
  it('normalizes UTC bounds and rejects invalid, escaping or inverted filters', () => {
    expect(parseHistoryTime('2026-09-05', 'upper')).toBe('2026-09-05T23:59:59.999Z');
    expect(parseHistoryTime('2026-09-05T12:00:00', 'lower')).toBe('2026-09-05T12:00:00.000Z');
    for (const touching of ['../src', '/tmp/**', 'C:\\outside', 'src/../../secret'])
      expect(() => normalizeHistoryFilters({ touching })).toThrow();
    for (const since of ['2026-02-30', '09/05/2026', 'invalid'])
      expect(() => normalizeHistoryFilters({ since })).toThrow();
    expect(() => normalizeHistoryFilters({ since: '2026-09-06', until: '2026-09-05' })).toThrow();
    expect(() => normalizeHistoryFilters({ limit: 0 })).toThrow();
    expect(() => normalizeHistoryFilters({ offset: -1 })).toThrow();
  });
});
