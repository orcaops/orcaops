import { describe, expect, it } from 'vitest';

import { createWheelScrollAcceleration } from './scrollAcceleration';

function clock(...times: number[]): () => number {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)]!;
}

describe('bounded wheel acceleration', () => {
  it('keeps the first tick precise and deterministically accelerates a tight burst', () => {
    const acceleration = createWheelScrollAcceleration({
      now: clock(1_000, 1_020, 1_040, 1_060),
    });
    expect([
      acceleration.tick(1),
      acceleration.tick(1),
      acceleration.tick(1),
      acceleration.tick(1),
    ]).toEqual([1, 2, 2, 2]);
  });

  it('preserves direction, bounds the multiplier, and resets after a pause', () => {
    const acceleration = createWheelScrollAcceleration({
      now: clock(1_000, 1_006, 1_012, 1_400, 1_420),
    });
    expect(acceleration.tick(-2)).toBe(-2);
    expect(acceleration.tick(-2)).toBe(-6);
    expect(acceleration.tick(-2)).toBe(-6);
    expect(acceleration.tick(-2)).toBe(-2);
    expect(acceleration.tick(-2)).toBe(-4);
  });

  it('allows an explicit reset to start the next gesture at base speed', () => {
    const acceleration = createWheelScrollAcceleration({
      now: clock(1_000, 1_020, 1_040),
    });
    expect(acceleration.tick(1)).toBe(1);
    expect(acceleration.tick(1)).toBe(2);
    acceleration.reset();
    expect(acceleration.tick(1)).toBe(1);
  });
});

describe('zero-magnitude input', () => {
  // A phantom zero-delta event must not mutate acceleration history, so the
  // next nonzero tick stays identical to a control sequence with no phantom.
  const burst = (withZero: boolean): number[] => {
    let clock = 0;
    const accel = createWheelScrollAcceleration({ now: () => clock });
    const out: number[] = [];
    out.push(accel.tick(1)); // t=0: first tick, precise
    clock = 25;
    if (withZero) expect(accel.tick(0)).toBe(0); // phantom event mid-burst
    clock = 50;
    out.push(accel.tick(1)); // the next REAL tick
    clock = 100;
    out.push(accel.tick(1));
    return out;
  };

  it('a zero tick leaves the next real ticks identical to the control sequence', () => {
    expect(burst(true)).toEqual(burst(false));
  });
});
