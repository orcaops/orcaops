import { describe, expect, it } from 'vitest';

import { FileSlottedBoundedCache } from './fileSlottedBoundedCache';
import type { DiffFile } from '../../core/types';

// The cache only uses a DiffFile as a WeakMap key, so a bare object stands in.
function file(): DiffFile {
  return {} as DiffFile;
}

describe('FileSlottedBoundedCache', () => {
  it('promotes a valid hit and evicts a slot whose value no longer validates', () => {
    const cache = new FileSlottedBoundedCache<{ key: string }>(10, 1000, 1000);
    const f = file();
    cache.set(f, 's', { key: 'a' }, 10);
    expect(cache.get(f, 's', (v) => v.key === 'a')).toEqual({ key: 'a' });
    expect(cache.get(f, 's', (v) => v.key === 'b')).toBeUndefined(); // stale -> evicted
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
  });

  it('rejects an oversized value without displacing existing entries', () => {
    const cache = new FileSlottedBoundedCache<number>(10, 1000, 100);
    const f = file();
    cache.set(f, 'a', 1, 50);
    expect(cache.set(f, 'b', 2, 200)).toBe(false); // over maxEntryWeight
    expect(cache.size).toBe(1);
    expect(cache.weight).toBe(50);
  });

  it('replacement in a slot updates weight, not the entry count', () => {
    const cache = new FileSlottedBoundedCache<number>(10, 1000, 1000);
    const f = file();
    cache.set(f, 's', 1, 30);
    cache.set(f, 's', 2, 70);
    expect(cache.size).toBe(1);
    expect(cache.weight).toBe(70);
    expect(cache.get(f, 's', () => true)).toBe(2);
  });

  it('evicts the least-recently-used first', () => {
    const cache = new FileSlottedBoundedCache<number>(2, 1000, 1000);
    const f = file();
    cache.set(f, 'a', 1, 10);
    cache.set(f, 'b', 2, 10);
    cache.get(f, 'a', () => true); // promote a
    cache.set(f, 'c', 3, 10); // evicts b (LRU), keeps a and c
    expect(cache.get(f, 'a', () => true)).toBe(1);
    expect(cache.get(f, 'b', () => true)).toBeUndefined();
    expect(cache.get(f, 'c', () => true)).toBe(3);
  });

  it('stays within maxEntries under churn of many temporary owners', () => {
    const cache = new FileSlottedBoundedCache<number>(8, 10_000, 10_000);
    for (let i = 0; i < 500; i += 1) {
      cache.set(file(), `slot-${i}`, i, 10); // each set uses a fresh, soon-unreferenced owner
    }
    expect(cache.size).toBeLessThanOrEqual(8);
    expect(cache.weight).toBeLessThanOrEqual(8 * 10);
  });

  it('stays within maxWeight', () => {
    const cache = new FileSlottedBoundedCache<number>(1000, 100, 100);
    const f = file();
    for (let i = 0; i < 50; i += 1) cache.set(f, `slot-${i}`, i, 20); // only 5 fit in weight 100
    expect(cache.weight).toBeLessThanOrEqual(100);
    expect(cache.size).toBeLessThanOrEqual(5);
  });
});
