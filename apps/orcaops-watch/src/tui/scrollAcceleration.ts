export interface WheelScrollAcceleration {
  tick(deltaRows: number): number;
  reset(): void;
}

export interface WheelScrollAccelerationOptions {
  now?: () => number;
  maxMultiplier?: number;
}

/**
 * Precise on the first wheel tick, then bounded during a sustained burst.
 *
 * The curve is applied at the app-owned intercept seam, so the native ScrollBox
 * cannot accelerate a second time.
 */
export function createWheelScrollAcceleration({
  now = Date.now,
  maxMultiplier = 3,
}: WheelScrollAccelerationOptions = {}): WheelScrollAcceleration {
  let lastTickTime: number | null = null;
  let intervals: number[] = [];
  const reset = (): void => {
    lastTickTime = null;
    intervals = [];
  };
  return {
    tick(deltaRows) {
      const magnitude = Math.abs(deltaRows);
      // A phantom zero-delta event observes nothing and mutates nothing —
      // not even the clock read — so it cannot skew the next real tick's
      // interval window.
      if (magnitude === 0) return 0;
      const tickAt = now();
      const interval = lastTickTime === null ? Number.POSITIVE_INFINITY : tickAt - lastTickTime;
      let multiplier = 1;
      if (!Number.isFinite(interval) || interval > 150) {
        intervals = [];
        lastTickTime = tickAt;
      } else if (interval >= 6) {
        lastTickTime = tickAt;
        intervals = [...intervals.slice(-2), interval];
        const average = intervals.reduce((total, value) => total + value, 0) / intervals.length;
        const velocity = 100 / average;
        multiplier = Math.min(maxMultiplier, 1 + 0.4 * (Math.exp(velocity / 4) - 1));
      }
      const accelerated = Math.max(magnitude, Math.round(magnitude * multiplier));
      return Math.sign(deltaRows) * accelerated;
    },
    reset,
  };
}
