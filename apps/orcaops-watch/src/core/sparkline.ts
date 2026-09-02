export interface SparklineConfig {
  /** Number of buckets (default 20). */
  buckets: number;
  /** Bucket width in ms (default 180_000 → a 60-minute window over 20 buckets). */
  bucketMs: number;
}

export const DEFAULT_SPARKLINE: SparklineConfig = { buckets: 20, bucketMs: 180_000 };

/**
 * Pure bucketing: count event timestamps into `buckets` × `bucketMs` buckets over
 * the trailing window ending at `nowMs`. Bucket 0 is the oldest, bucket N-1 the
 * most recent; the exact-now edge lands in the last bucket. Events outside the
 * window are dropped.
 */
export function bucketize(
  events: ReadonlyArray<{ tsMs: number }>,
  nowMs: number,
  config: SparklineConfig = DEFAULT_SPARKLINE
): number[] {
  const { buckets, bucketMs } = config;
  const windowStart = nowMs - buckets * bucketMs;
  const out = new Array<number>(buckets).fill(0);
  for (const e of events) {
    if (e.tsMs < windowStart || e.tsMs > nowMs) continue;
    const idx = Math.min(buckets - 1, Math.floor((e.tsMs - windowStart) / bucketMs));
    out[idx] += 1;
  }
  return out;
}
