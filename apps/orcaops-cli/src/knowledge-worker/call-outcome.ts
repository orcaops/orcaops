import type { EffectiveProcessingLimits } from '@orcaops/core';
import type { PreparedInputCallFailed, PreparedInputFailureCode } from '@orcaops/llm';

/**
 * What a failed provider call means for the job that paid for it. The call
 * never throws, so every ending arrives here as a code, and the code alone
 * decides whether the same input could ever succeed.
 */

export type CallFailureClass =
  /** The no-tool guarantee did not hold: a safety property, not availability. */
  | 'pause_workload'
  /** This machine cannot make the call right now. The job waits; the project does not. */
  | 'local_provider'
  /** The same input would end the same way, so the job is finished, not retried. */
  | 'terminal'
  /** Worth another attempt inside the same allowance. */
  | 'retryable';

const CLASS_BY_CODE: Readonly<Record<PreparedInputFailureCode, CallFailureClass>> = {
  // The three the no-tool tripwire raises. A provider that was given no tools
  // and used one, was offered one, or never said which it was offered, has not
  // held the guarantee this whole workload rests on, so nothing else is sent.
  TOOL_USE_OBSERVED: 'pause_workload',
  TOOLS_AVAILABLE: 'pause_workload',
  NO_TOOL_MODE_UNCONFIRMED: 'pause_workload',
  // Nothing was spent, and nothing about the JOB would change the answer — but
  // the configuration was resolved against a live provider probe minutes
  // earlier, so reaching one of these means the machine changed underneath the
  // worker: a provider being upgraded, a flag gone from a new build, a TMPDIR
  // pointed somewhere new. The project-wide pause is durable and shared by
  // every worktree, so writing it for a five-second local window would turn an
  // upgrade into an operator incident. The job waits and the machine is left to
  // recover; three of the same in one run escalates.
  PROVIDER_UNAVAILABLE: 'local_provider',
  CAPABILITY_REFUSED: 'local_provider',
  WORKING_DIRECTORY_IN_REPOSITORY: 'local_provider',
  // Size and shape refusals: the same bytes would be refused again.
  INPUT_TOO_LARGE: 'terminal',
  OUTPUT_TOO_LARGE: 'terminal',
  ANSWER_CUT_OFF: 'terminal',
  INVALID_REQUEST: 'terminal',
  // Everything else may differ on another attempt, inside the same allowance.
  TIMEOUT: 'retryable',
  CANCELLED: 'retryable',
  BUDGET_EXCEEDED: 'retryable',
  PROVIDER_ERROR: 'retryable',
  UNPARSEABLE_STREAM: 'retryable',
  MULTIPLE_RESULTS: 'retryable',
  EMPTY_RESPONSE: 'retryable',
  STRUCTURED_ANSWER_MISSING: 'retryable',
  SPAWN_FAILURE: 'retryable',
};

export function classifyCallFailure(code: PreparedInputFailureCode): CallFailureClass {
  return CLASS_BY_CODE[code] ?? 'retryable';
}

/** What a job waits on while this machine cannot make its call. */
const LOCAL_PROVIDER_WAIT_REASON: Readonly<Partial<Record<PreparedInputFailureCode, string>>> = {
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  CAPABILITY_REFUSED: 'capability_refused',
  WORKING_DIRECTORY_IN_REPOSITORY: 'provider_environment',
};

export function localProviderWaitReason(code: PreparedInputFailureCode): string {
  return LOCAL_PROVIDER_WAIT_REASON[code] ?? 'provider_environment';
}

/**
 * How many attempts one worker run may end on the SAME local condition before
 * it stops treating it as a moment and pauses the project. Three is enough to
 * outlast an upgrade or a moved temporary directory and short enough that a
 * machine that really cannot call a provider stops burning the allowance of
 * every job in the queue.
 */
export const LOCAL_PROVIDER_ESCALATION = 3;

/**
 * A call whose provider was not observed to stop may still be running and
 * spending, so its result is unknown rather than failed: the attempt keeps its
 * whole conservative hold and the job waits out the call's lifetime.
 */
export function callResultIsLost(failure: PreparedInputCallFailed): boolean {
  return failure.providerStarted && !failure.terminationConfirmed;
}

const BACKOFF_BASE_MS = 30_000;
export const RETRY_DELAY_CEILING_MS = 15 * 60_000;

/**
 * Bounded backoff, doubling per attempt already made against a job and capped,
 * so a provider that is failing is not asked again immediately and a long queue
 * is not held by one job. Retries spend the same call and cost budgets, so the
 * delay is the only thing that grows.
 */
export function retryDelayMs(attemptsMade: number): number {
  const exponent = Math.max(0, Math.min(attemptsMade - 1, 10));
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, RETRY_DELAY_CEILING_MS);
}

/**
 * What an attempt holds against the shared ledger, from the limits in force.
 *
 * The daily budget is enforced by reserving each call's hard ceiling before the
 * call is sent, so the two travel together: a budget with nothing to reserve
 * would not be a budget, and a per-call ceiling without a budget is the
 * provider's own business and holds nothing here. Getting either wrong is
 * invisible at run time — the store simply stops counting money — which is why
 * it is one function and not two expressions inlined at two call sites.
 */
export function callLimitsFor(limits: EffectiveProcessingLimits): {
  maxCallsPerHour: number;
  maxCostUsdPerDay: number | null;
  reservationUsd: number | null;
} {
  const perDay = limits.max_cost_usd_per_day;
  const perCall = limits.max_cost_usd_per_call;
  if (perDay === 'none') {
    return {
      maxCallsPerHour: limits.max_calls_per_hour,
      maxCostUsdPerDay: null,
      reservationUsd: null,
    };
  }
  return {
    maxCallsPerHour: limits.max_calls_per_hour,
    maxCostUsdPerDay: perDay,
    // `none` cannot occur beside a budget — configuration pauses the workload
    // rather than resolving one — and the store refuses a budget with no
    // positive reservation, so this stays null and is refused loudly.
    reservationUsd: perCall === 'none' ? null : perCall.usd,
  };
}
