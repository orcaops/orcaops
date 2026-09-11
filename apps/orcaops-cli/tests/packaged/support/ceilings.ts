/**
 * Every fixed ceiling the packaged scenarios use, in one place so the boundaries
 * report can name each one and its source. None of these is ever raised to turn a
 * failing scenario green: a scenario that needs more than its ceiling under load is
 * retained as a failure and disclosed.
 */
export const ceilings = {
  /**
   * Per-test ceiling for the `packaged` vitest project. Each scenario spawns several
   * real processes and drives suspension, so it sits above the 30s `smoke` project
   * ceiling that covers single uncontended spawns.
   */
  testTimeoutMs: 60_000,

  /** Ceiling for a single packaged CLI run that is expected to finish promptly. */
  cliRunMs: 20_000,

  /**
   * Ceiling for observing a pattern on a live child's stream (the named wait, a
   * sidecar snapshot line). Deliberately well under testTimeoutMs so the failure
   * message names the stream that never produced it.
   */
  streamPatternMs: 20_000,

  /**
   * How long a contender is left waiting on a suspended holder before the scenario
   * sends its real SIGINT. Long enough that the wait is genuinely observed, short
   * enough to leave headroom under testTimeoutMs.
   */
  observeWaitMs: 2_000,

  /**
   * Ceiling for a cancelled contender to exit after its SIGINT. This measures the
   * property the gate cares about — cancellation is timely BETWEEN short attempts —
   * so it is an assertion, not just a guard.
   */
  cancellationMs: 10_000,

  /** Ceiling for the long-lived sidecar to emit its first snapshot line. */
  sidecarFirstSnapshotMs: 30_000,
} as const;

export type CeilingName = keyof typeof ceilings;
