/**
 * Preemption policy for the review performance samplers — pure and
 * importable, so controlled-preemption shapes can be injected in unit tests
 * (the perf script itself is a top-level-await executable).
 */

/**
 * A sample is classified as externally descheduled when it blew its wall-clock
 * budget while its process was NOT busy. Active CPU below `activeRatio` of the
 * wall time is consistent with the process losing the core; it does not identify
 * the scheduler as the only possible source of inactive time.
 */
export function externallyDescheduled(input: {
  wallMs: number;
  activeCpuMs: number;
  budgetMs: number;
  activeRatio: number;
}): boolean {
  return input.wallMs > input.budgetMs && input.activeCpuMs < input.wallMs * input.activeRatio;
}

export type SampleVerdict = 'accept' | 'discard' | 'fail';

/**
 * Bounded retry-then-explicit-fail: clean samples are accepted; preempted
 * samples are discarded while the budget lasts; once the budget is exhausted
 * a preempted sample FAILS the run — accepting it would silently pollute the
 * measurement with host-scheduler noise, which is exactly the release-gate
 * hazard this policy exists to prevent.
 */
export function judgePreemptedSample(input: {
  preempted: boolean;
  discardedSoFar: number;
  discardBudget: number;
}): SampleVerdict {
  if (!input.preempted) return 'accept';
  return input.discardedSoFar < input.discardBudget ? 'discard' : 'fail';
}

export function collectCpuAttributedWallSamples(input: {
  sampleCount: number;
  discardBudget: number;
  budgetMs: number;
  activeRatio: number;
  label: string;
  measure: () => { wallMs: number; activeCpuMs: number };
}): { wallSamples: number[]; schedulerDiscardedSamples: number } {
  const wallSamples: number[] = [];
  let schedulerDiscardedSamples = 0;
  while (wallSamples.length < input.sampleCount) {
    const sample = input.measure();
    const verdict = judgePreemptedSample({
      preempted: externallyDescheduled({
        ...sample,
        budgetMs: input.budgetMs,
        activeRatio: input.activeRatio,
      }),
      discardedSoFar: schedulerDiscardedSamples,
      discardBudget: input.discardBudget,
    });
    if (verdict === 'discard') {
      schedulerDiscardedSamples += 1;
      continue;
    }
    if (verdict === 'fail') {
      throw new Error(
        `${input.label} sampling discarded ${String(schedulerDiscardedSamples)} scheduler-preempted samples (budget ${String(input.discardBudget)}) and the next sample was still classified as preempted — rerun on a quieter host.`
      );
    }
    wallSamples.push(sample.wallMs);
  }
  return { wallSamples, schedulerDiscardedSamples };
}
