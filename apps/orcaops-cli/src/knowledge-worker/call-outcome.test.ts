import { describe, expect, it } from 'vitest';

import type { EffectiveProcessingLimits } from '@orcaops/core';
import type { PreparedInputCallFailed, PreparedInputFailureCode } from '@orcaops/llm';

import {
  callLimitsFor,
  callResultIsLost,
  classifyCallFailure,
  localProviderWaitReason,
  retryDelayMs,
} from './call-outcome.js';

/**
 * What each ending of a paid call means for the job. The table decides whether
 * money is spent again on the same input, so every code is pinned by name.
 */

const failed = (parts: Partial<PreparedInputCallFailed>): PreparedInputCallFailed =>
  ({
    status: 'failed',
    code: 'PROVIDER_ERROR',
    message: '',
    providerStarted: true,
    terminationConfirmed: true,
    hardKilled: false,
    ...parts,
  }) as PreparedInputCallFailed;

describe('what a failed call means for its job', () => {
  it('pauses the whole workload when the no-tool guarantee did not hold', () => {
    for (const code of [
      'TOOL_USE_OBSERVED',
      'TOOLS_AVAILABLE',
      'NO_TOOL_MODE_UNCONFIRMED',
    ] as const) {
      expect([code, classifyCallFailure(code)]).toEqual([code, 'pause_workload']);
    }
  });

  it('waits, rather than pausing the project, when this machine cannot make the call', () => {
    // These are local and transient — the configuration was resolved against a
    // live probe before dispatch — and the project pause is durable and shared.
    for (const [code, waitReason] of [
      ['PROVIDER_UNAVAILABLE', 'provider_unavailable'],
      ['CAPABILITY_REFUSED', 'capability_refused'],
      ['WORKING_DIRECTORY_IN_REPOSITORY', 'provider_environment'],
    ] as const) {
      expect([code, classifyCallFailure(code)]).toEqual([code, 'local_provider']);
      expect([code, localProviderWaitReason(code)]).toEqual([code, waitReason]);
    }
  });

  it('finishes the job when the same input would end the same way', () => {
    for (const code of [
      'INPUT_TOO_LARGE',
      'OUTPUT_TOO_LARGE',
      'ANSWER_CUT_OFF',
      'INVALID_REQUEST',
    ] as const) {
      expect([code, classifyCallFailure(code)]).toEqual([code, 'terminal']);
    }
  });

  it('retries the endings another attempt could survive', () => {
    for (const code of [
      'TIMEOUT',
      'CANCELLED',
      'BUDGET_EXCEEDED',
      'PROVIDER_ERROR',
      'UNPARSEABLE_STREAM',
      'MULTIPLE_RESULTS',
      'EMPTY_RESPONSE',
      'STRUCTURED_ANSWER_MISSING',
      'SPAWN_FAILURE',
    ] as const) {
      expect([code, classifyCallFailure(code)]).toEqual([code, 'retryable']);
    }
  });

  it('classifies a code it has never met as retryable rather than terminal', () => {
    expect(classifyCallFailure('SOMETHING_NEW' as PreparedInputFailureCode)).toBe('retryable');
  });
});

describe('whether a call’s result is lost', () => {
  it('is lost when a started provider was not observed to stop', () => {
    expect(callResultIsLost(failed({ providerStarted: true, terminationConfirmed: false }))).toBe(
      true
    );
  });

  it('is not lost when nothing was ever started', () => {
    expect(callResultIsLost(failed({ providerStarted: false, terminationConfirmed: false }))).toBe(
      false
    );
  });

  it('is not lost when the provider was observed to stop', () => {
    expect(callResultIsLost(failed({ providerStarted: true, terminationConfirmed: true }))).toBe(
      false
    );
  });
});

describe('how long a retry waits', () => {
  it('doubles with each attempt already made and stops at its ceiling', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(64)).toBe(15 * 60_000);
  });
});

describe('what an attempt holds against the shared ledger', () => {
  const limits = (overrides: Partial<EffectiveProcessingLimits>): EffectiveProcessingLimits => ({
    max_cost_usd_per_call: 'none',
    max_cost_usd_per_day: 'none',
    max_calls_per_hour: 60,
    max_input_bytes: 131_072,
    max_output_bytes: 65_536,
    ...overrides,
  });

  it('holds only a call slot when no daily budget is in force', () => {
    expect(
      callLimitsFor(limits({ max_cost_usd_per_call: { usd: 0.5, holds: 'ceiling' } }))
    ).toEqual({
      maxCallsPerHour: 60,
      maxCostUsdPerDay: null,
      // A per-call ceiling with no budget is the provider's own business; there
      // is nothing here to reserve it against.
      reservationUsd: null,
    });
  });

  it('reserves the per-call ceiling against the daily budget', () => {
    expect(
      callLimitsFor(
        limits({
          max_cost_usd_per_call: { usd: 0.25, holds: 'ceiling' },
          max_cost_usd_per_day: 4,
          max_calls_per_hour: 12,
        })
      )
    ).toEqual({ maxCallsPerHour: 12, maxCostUsdPerDay: 4, reservationUsd: 0.25 });
  });

  it('reserves nothing it cannot, so the store refuses the call rather than the budget', () => {
    expect(callLimitsFor(limits({ max_cost_usd_per_day: 4 }))).toEqual({
      maxCallsPerHour: 60,
      maxCostUsdPerDay: 4,
      reservationUsd: null,
    });
  });

  it('carries the calls-per-hour limit whatever the dollar limits say', () => {
    expect(callLimitsFor(limits({ max_calls_per_hour: 7 })).maxCallsPerHour).toBe(7);
  });
});
