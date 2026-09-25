import { afterEach, expect, it } from 'vitest';

import { takeProcessingLease } from './processing-lease.js';
import { readProcessingJob } from './processing-reader.js';
import {
  claimProcessingJob,
  type ProcessingAttemptStart,
  settleProcessingAttempt,
  startProcessingAttempt,
} from './processing-schedule.js';
import {
  PROCESSING_CALL_WINDOW_MS,
  PROCESSING_SPEND_WINDOW_MS,
  type ProcessingCallLimits,
  readProcessingUsageWindows,
  settleProcessingCall,
} from './processing-usage.js';
import {
  later,
  NOW,
  processingAttemptConfiguration,
  processingFixture,
} from '../../../tests/processing-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
const DAY = 24 * 60 * 60 * 1000;
const TERM = 7 * DAY;
const CONFIGURATION = 'c'.repeat(64);

/**
 * One owner with as many admitted jobs as a test needs calls. Only one job runs
 * at a time, so each call claims a job, starts its attempt with the hold that
 * pays for it, and settles the attempt so the next job can run.
 */
async function worker(jobs: number) {
  const fixture = await processingFixture();
  fixtures.push(fixture);
  const { lease } = await takeProcessingLease(fixture.handle, {
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, TERM),
    maxTermMs: TERM,
  });
  const generation = lease.ownerGeneration;
  for (let index = 0; index < jobs; index++) await fixture.capture();

  async function start(startedAt: string, limits: ProcessingCallLimits) {
    const claim = await claimProcessingJob(fixture.handle, { generation, now: startedAt });
    if (claim.outcome !== 'claimed') throw new Error(`nothing claimable: ${claim.reason}`);
    const configuration = processingAttemptConfiguration(
      fixture.handle,
      claim.job.jobId,
      {},
      'grant-1',
      { maxAttempts: 3, ...limits }
    );
    return {
      jobId: claim.job.jobId,
      result: await startProcessingAttempt(fixture.handle, {
        generation,
        jobId: claim.job.jobId,
        attemptId: uuidv7(),
        usageId: uuidv7(),
        startedAt,
        maxAttempts: 3,
        configurationIdentity: CONFIGURATION,
        configuration,
        confirmationId: configuration.permission.confirmation_id,
        grantId: 'grant-1',
        ...limits,
      }),
    };
  }
  /**
   * Start a call and settle it, then settle its attempt, so the next job can run. The hold ends as
   * `unknown`, which keeps the whole reservation against both windows exactly as holding it does.
   */
  async function call(
    startedAt: string,
    limits: ProcessingCallLimits
  ): Promise<ProcessingAttemptStart> {
    const { jobId, result } = await start(startedAt, limits);
    if (result.outcome === 'started') {
      await settleProcessingCall(fixture.handle, {
        generation,
        usageId: result.usage.usageId,
        settledAt: startedAt,
        result: { kind: 'unknown' },
      });
      await settleProcessingAttempt(fixture.handle, {
        generation,
        jobId,
        attemptId: result.attempt.attemptId,
        finishedAt: startedAt,
        usage: null,
        outcome: { kind: 'terminal_failure', result: null },
      });
    }
    return result;
  }
  return { fixture, generation, start, call };
}

it('refuses a call once the hour window is full and admits one as the oldest leaves', async () => {
  const { fixture, call } = await worker(5);
  const limits = { maxCallsPerHour: 2 };
  expect(await call(NOW, limits)).toMatchObject({ outcome: 'started' });
  expect(await call(later(NOW, 1000), limits)).toMatchObject({ outcome: 'started' });
  expect(await call(later(NOW, 2000), limits)).toMatchObject({
    outcome: 'refused',
    limit: 'calls_per_hour',
    freesUpAt: later(NOW, PROCESSING_CALL_WINDOW_MS),
    windows: { calls: { used: 2, limit: 2, available: 0 } },
  });
  // The oldest reservation is still inside the window one millisecond early.
  expect(await call(later(NOW, PROCESSING_CALL_WINDOW_MS - 1), limits)).toMatchObject({
    outcome: 'refused',
  });
  expect(await call(later(NOW, PROCESSING_CALL_WINDOW_MS), limits)).toMatchObject({
    outcome: 'started',
  });
  expect(fixture.snapshot().usage).toHaveLength(3);
});

it('refuses a call the daily budget cannot hold and admits one that fits exactly', async () => {
  const { fixture, call } = await worker(3);
  const budget = { maxCallsPerHour: 60, maxCostUsdPerDay: 0.3 };
  expect(await call(NOW, { ...budget, reservationUsd: 0.1 })).toMatchObject({
    outcome: 'started',
  });
  expect(await call(later(NOW, 1000), { ...budget, reservationUsd: 0.2 })).toMatchObject({
    outcome: 'started',
    windows: { spend: { usedUsd: 0.3, budgetUsd: 0.3, availableUsd: 0 } },
  });
  expect(await call(later(NOW, 2000), { ...budget, reservationUsd: 0.000001 })).toMatchObject({
    outcome: 'refused',
    limit: 'cost_per_day',
    freesUpAt: later(NOW, PROCESSING_SPEND_WINDOW_MS),
    windows: { spend: { usedUsd: 0.3, availableUsd: 0 } },
  });
  expect(fixture.snapshot().usage).toHaveLength(2);
});

it('frees the daily budget as the oldest reservation leaves the day window', async () => {
  const { call } = await worker(3);
  const budget = { maxCallsPerHour: 60, maxCostUsdPerDay: 0.3, reservationUsd: 0.3 };
  expect(await call(NOW, budget)).toMatchObject({ outcome: 'started' });
  expect(await call(later(NOW, PROCESSING_SPEND_WINDOW_MS - 1), budget)).toMatchObject({
    outcome: 'refused',
    limit: 'cost_per_day',
  });
  expect(await call(later(NOW, PROCESSING_SPEND_WINDOW_MS), budget)).toMatchObject({
    outcome: 'started',
  });
});

it('spends no attempt on a refused call and leaves no attempt behind', async () => {
  const { fixture, generation, call, start } = await worker(2);
  expect(await call(NOW, { maxCallsPerHour: 1 })).toMatchObject({ outcome: 'started' });
  const refused = await start(later(NOW, 1000), { maxCallsPerHour: 1 });
  expect(refused.result).toMatchObject({ outcome: 'refused', limit: 'calls_per_hour' });
  expect(fixture.snapshot().attempts).toHaveLength(1);
  // The refused job waits on the window that refused it instead of holding the running slot.
  expect(readProcessingJob(fixture.handle, refused.jobId)).toMatchObject({
    state: 'retryable_failure',
    waitReason: 'calls_per_hour',
    retryAt: later(NOW, PROCESSING_CALL_WINDOW_MS),
    claimedGeneration: null,
  });
  expect(
    await claimProcessingJob(fixture.handle, {
      generation,
      now: later(NOW, PROCESSING_CALL_WINDOW_MS),
    })
  ).toMatchObject({ outcome: 'claimed', job: { jobId: refused.jobId } });
});

it('holds nothing against spend when no daily budget is configured', async () => {
  const { call } = await worker(2);
  expect(await call(NOW, { maxCallsPerHour: 60 })).toMatchObject({
    outcome: 'started',
    usage: { reservedCostUsd: null },
    windows: { spend: { usedUsd: 0, budgetUsd: null, availableUsd: null } },
  });
  await expect(call(NOW, { maxCallsPerHour: 60, maxCostUsdPerDay: 1 })).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
});

it('refuses limits that could never admit a single call', async () => {
  const { fixture, generation } = await worker(1);
  const claim = await claimProcessingJob(fixture.handle, { generation, now: NOW });
  if (claim.outcome !== 'claimed') throw new Error('nothing was claimable');
  for (const limits of [
    { maxCallsPerHour: 0 },
    { maxCallsPerHour: 60, maxCostUsdPerDay: 0.1, reservationUsd: 0.2 },
    { maxCallsPerHour: 60, maxCostUsdPerDay: 1, reservationUsd: 0 },
  ])
    await expect(
      startProcessingAttempt(fixture.handle, {
        generation,
        jobId: claim.job.jobId,
        attemptId: uuidv7(),
        usageId: uuidv7(),
        startedAt: NOW,
        maxAttempts: 3,
        configurationIdentity: CONFIGURATION,
        configuration: processingAttemptConfiguration(fixture.handle, claim.job.jobId),
        confirmationId: null,
        grantId: 'grant-1',
        ...limits,
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fixture.snapshot().usage).toEqual([]);
  expect(fixture.snapshot().attempts).toEqual([]);
});

it('settles a call with reported usage and keeps a missing cost null', async () => {
  const { fixture, generation, start } = await worker(1);
  const { result: started } = await start(NOW, {
    maxCallsPerHour: 60,
    maxCostUsdPerDay: 5,
    reservationUsd: 0.25,
  });
  if (started.outcome !== 'started') throw new Error('the call was refused');
  const settled = await settleProcessingCall(fixture.handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt: later(NOW, 1000),
    result: { kind: 'reported', costUsd: null, usage: { input_tokens: 10, output_tokens: 2 } },
  });
  expect(settled).toEqual({
    usageId: started.usage.usageId,
    attemptId: started.attempt.attemptId,
    reservedAt: NOW,
    reservedCostUsd: 0.25,
    state: 'settled',
    settledAt: later(NOW, 1000),
    reportedCostUsd: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  // A reported call with no cost keeps its conservative hold rather than counting as free.
  expect(
    readProcessingUsageWindows(fixture.handle, {
      now: later(NOW, 2000),
      maxCallsPerHour: 60,
      maxCostUsdPerDay: 5,
    })
  ).toMatchObject({ spend: { usedUsd: 0.25, availableUsd: 4.75 }, calls: { used: 1 } });
  await expect(
    settleProcessingCall(fixture.handle, {
      generation,
      usageId: started.usage.usageId,
      settledAt: later(NOW, 3000),
      result: { kind: 'unknown' },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

it.each([
  ['reported', { kind: 'reported' as const, costUsd: 0.04, usage: null }, 0.04, 1],
  ['unknown', { kind: 'unknown' as const }, 0.25, 1],
  ['released', { kind: 'released' as const }, 0, 0],
])('counts a %s call against the windows', async (_name, result, usedUsd, calls) => {
  const { fixture, generation, start } = await worker(1);
  const { result: started } = await start(NOW, {
    maxCallsPerHour: 60,
    maxCostUsdPerDay: 5,
    reservationUsd: 0.25,
  });
  if (started.outcome !== 'started') throw new Error('the call was refused');
  const settled = await settleProcessingCall(fixture.handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt: later(NOW, 1000),
    result,
  });
  expect(settled.reservedCostUsd).toBe(0.25);
  expect(
    readProcessingUsageWindows(fixture.handle, {
      now: later(NOW, 2000),
      maxCallsPerHour: 60,
      maxCostUsdPerDay: 5,
    })
  ).toMatchObject({ spend: { usedUsd, availableUsd: 5 - usedUsd }, calls: { used: calls } });
});

it('refuses to settle a call an earlier owner made', async () => {
  const { fixture, start } = await worker(1);
  const { result: started } = await start(NOW, {
    maxCallsPerHour: 60,
    maxCostUsdPerDay: 5,
    reservationUsd: 0.25,
  });
  if (started.outcome !== 'started') throw new Error('the call was refused');
  const takeover = await takeProcessingLease(fixture.handle, {
    ownerId: 'worker-b',
    now: later(NOW, TERM),
    expiresAt: later(NOW, TERM + 1000),
    maxTermMs: TERM,
  });
  const before = fixture.snapshot();
  for (const result of [
    { kind: 'reported' as const, costUsd: 9, usage: null },
    { kind: 'released' as const },
    { kind: 'unknown' as const },
  ])
    await expect(
      settleProcessingCall(fixture.handle, {
        generation: takeover.lease.ownerGeneration,
        usageId: started.usage.usageId,
        settledAt: later(NOW, TERM + 1),
        result,
      })
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(fixture.snapshot().usage).toEqual(before.usage);
});

it('shares the windows across every connection to the project database', async () => {
  const { fixture, generation, call } = await worker(2);
  const other = await fixture.open('writer');
  expect(await call(NOW, { maxCallsPerHour: 1 })).toMatchObject({ outcome: 'started' });
  const claim = await claimProcessingJob(other, { generation, now: later(NOW, 1000) });
  if (claim.outcome !== 'claimed') throw new Error('nothing was claimable');
  expect(
    await startProcessingAttempt(other, {
      generation,
      jobId: claim.job.jobId,
      attemptId: uuidv7(),
      usageId: uuidv7(),
      startedAt: later(NOW, 1000),
      maxAttempts: 3,
      configurationIdentity: CONFIGURATION,
      configuration: processingAttemptConfiguration(other, claim.job.jobId, {}, 'grant-1', {
        maxAttempts: 3,
        maxCallsPerHour: 1,
      }),
      confirmationId: null,
      grantId: 'grant-1',
      maxCallsPerHour: 1,
    })
  ).toMatchObject({ outcome: 'refused', limit: 'calls_per_hour' });
  const reader = await fixture.open('reader');
  expect(
    readProcessingUsageWindows(reader, { now: later(NOW, 2000), maxCallsPerHour: 1 })
  ).toMatchObject({ calls: { used: 1, available: 0 } });
});

it('settles nothing for a reservation that is missing or has already ended', async () => {
  const { fixture, generation, start } = await worker(1);
  await expect(
    settleProcessingCall(fixture.handle, {
      generation,
      usageId: uuidv7(),
      settledAt: NOW,
      result: { kind: 'released' },
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  const { result: started } = await start(NOW, { maxCallsPerHour: 60 });
  if (started.outcome !== 'started') throw new Error('the call was refused');
  await settleProcessingCall(fixture.handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt: later(NOW, 1000),
    result: { kind: 'released' },
  });
  const before = fixture.snapshot();
  await expect(
    settleProcessingCall(fixture.handle, {
      generation,
      usageId: started.usage.usageId,
      settledAt: later(NOW, 2000),
      result: { kind: 'released' },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(fixture.snapshot().usage).toEqual(before.usage);
});
