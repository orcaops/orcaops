import { describe, expect, it } from 'vitest';

import { bucketize, DEFAULT_SPARKLINE } from './sparkline.js';

const NOW = 10_000_000;
const { buckets, bucketMs } = DEFAULT_SPARKLINE; // 20 × 180_000 → 60m window
const WINDOW_START = NOW - buckets * bucketMs;

describe('bucketize', () => {
  it('empty events → all zeros', () => {
    expect(bucketize([], NOW)).toEqual(new Array(20).fill(0));
  });

  it('a burst in one bucket counts together', () => {
    const t = WINDOW_START + 5_000; // bucket 0
    const out = bucketize([{ tsMs: t }, { tsMs: t + 1_000 }, { tsMs: t + 2_000 }], NOW);
    expect(out[0]).toBe(3);
    expect(out.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('straddling a bucket boundary splits into adjacent buckets', () => {
    const out = bucketize(
      [{ tsMs: WINDOW_START + bucketMs - 1 }, { tsMs: WINDOW_START + bucketMs }],
      NOW
    );
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(1);
  });

  it('the exact-now edge lands in the last bucket', () => {
    expect(bucketize([{ tsMs: NOW }], NOW)[19]).toBe(1);
  });

  it('drops events outside the window', () => {
    const out = bucketize([{ tsMs: WINDOW_START - 1 }, { tsMs: NOW + 1_000 }], NOW);
    expect(out.reduce((a, b) => a + b, 0)).toBe(0);
  });
});
