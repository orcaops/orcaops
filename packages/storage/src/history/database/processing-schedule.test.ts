import { afterEach, expect, it } from 'vitest';

import { type ProjectDatabase } from './connection.js';
import { pauseProcessing, reopenProcessingJob, retryProcessingJob } from './processing-control.js';
import { takeProcessingLease } from './processing-lease.js';
import { readProcessingJob, readProcessingJobAttempts } from './processing-reader.js';
import { readLatestProcessingJobReopening } from './processing-reopenings.js';
import {
  claimProcessingJob,
  parkProcessingJob,
  type ProcessingAttemptStart,
  recordProcessingAttemptProcess,
  recoverProcessingAttempts,
  settleExhaustedProcessingJob,
  settleProcessingAttempt,
  startProcessingAttempt,
  unparkProcessingJobs,
} from './processing-schedule.js';
import { readProcessingUsageWindows, settleProcessingCall } from './processing-usage.js';
import {
  later,
  NOW,
  processingAttemptConfiguration,
  processingFixture,
} from '../../../tests/processing-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const TERM = 7 * 24 * 60 * 60 * 1000;
const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
const HOUR = 60 * 60 * 1000;
const CONFIGURATION = 'c'.repeat(64);
const LIFETIME = 120_000;

async function project() {
  const fixture = await processingFixture();
  fixtures.push(fixture);
  return fixture;
}
async function owned(expiresAt = later(NOW, HOUR)) {
  const fixture = await project();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt,
  });
  return { fixture, generation: lease.ownerGeneration };
}
/**
 * End the hold an attempt took, which settling the attempt requires: a settled attempt is out of
 * recovery's reach, so a hold left open beside it is one nothing would ever release.
 */
async function endHold(
  handle: ProjectDatabase,
  generation: number,
  started: Extract<ProcessingAttemptStart, { outcome: 'started' }>,
  settledAt: string
) {
  await settleProcessingCall(handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt,
    result: { kind: 'unknown' },
  });
}

function attemptInput(
  handle: ProjectDatabase,
  jobId: string,
  startedAt: string,
  maxAttempts = 3,
  cost: { maxCostUsdPerDay: number; reservationUsd: number } | null = null
) {
  const permission = processingAttemptConfiguration(
    handle,
    jobId,
    {
      model: 'original model',
      max_input_bytes: 131072,
    },
    'grant-1',
    { maxAttempts, maxCallsPerHour: 60, ...(cost ?? {}) }
  ).permission;
  return {
    jobId,
    attemptId: uuidv7(),
    usageId: uuidv7(),
    startedAt,
    maxAttempts,
    maxCallsPerHour: 60,
    ...(cost ?? {}),
    configurationIdentity: CONFIGURATION,
    configuration: {
      model: 'original model',
      max_input_bytes: 131072,
      permission,
    },
    confirmationId: permission.confirmation_id,
    grantId: 'grant-1',
  };
}

it('claims the oldest eligible job and marks it running under the generation', async () => {
  const { fixture, generation } = await owned();
  const first = await fixture.capture({ admittedAt: '2026-09-01T00:00:00.000Z' });
  await fixture.capture({ admittedAt: '2026-09-01T00:01:00.000Z' });
  const claim = await claimProcessingJob(fixture.handle, { generation, now: NOW });
  expect(claim).toMatchObject({
    outcome: 'claimed',
    job: { jobId: first.jobId, state: 'running', claimedGeneration: generation, updatedAt: NOW },
  });
  expect(await claimProcessingJob(fixture.handle, { generation, now: NOW })).toMatchObject({
    outcome: 'nothing_claimable',
    reason: 'call_in_flight',
  });
});

it('reports why nothing is claimable', async () => {
  const { fixture, generation } = await owned();
  expect(await claimProcessingJob(fixture.handle, { generation, now: NOW })).toEqual({
    outcome: 'nothing_claimable',
    reason: 'queue_empty',
    openJobs: 0,
    nextRetryAt: null,
    nextRetry: null,
  });
  const blocked = await fixture.capture({ withoutModel: true });
  expect(await claimProcessingJob(fixture.handle, { generation, now: NOW })).toMatchObject({
    outcome: 'nothing_claimable',
    reason: 'awaiting_model_resume',
    openJobs: 1,
  });
  const open = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, open.jobId, NOW),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await endHold(fixture.handle, generation, started, later(NOW, 1000));
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: open.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1000),
    usage: null,
    outcome: {
      kind: 'retryable_failure',
      waitReason: 'provider_unavailable',
      retryAt: later(NOW, 60_000),
    },
  });
  expect(await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })).toEqual({
    outcome: 'nothing_claimable',
    reason: 'waiting',
    openJobs: 2,
    nextRetryAt: later(NOW, 60_000),
    nextRetry: {
      jobId: open.jobId,
      retryAt: later(NOW, 60_000),
      waitReason: 'provider_unavailable',
    },
  });
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 60_000) })
  ).toMatchObject({ outcome: 'claimed', job: { jobId: open.jobId } });
  expect(readProcessingJob(fixture.handle, blocked.jobId)!.state).toBe('pending');
});

it('reports the earliest eligible retry from stored jobs rather than the last settled attempt', async () => {
  const { fixture, generation } = await owned();
  const first = await fixture.capture({ admittedAt: later(NOW, -2_000) });
  const second = await fixture.capture({ admittedAt: later(NOW, -1_000) });
  await fixture.capture({ withoutModel: true });
  for (const [job, delay] of [
    [first, 60_000],
    [second, 120_000],
  ] as const) {
    await claimProcessingJob(fixture.handle, { generation, now: NOW });
    const started = await startProcessingAttempt(fixture.handle, {
      generation,
      ...attemptInput(fixture.handle, job.jobId, NOW),
    });
    if (started.outcome !== 'started') throw new Error('the attempt did not start');
    await endHold(fixture.handle, generation, started, later(NOW, 1000));
    await settleProcessingAttempt(fixture.handle, {
      generation,
      jobId: job.jobId,
      attemptId: started.attempt.attemptId,
      finishedAt: later(NOW, 1000),
      usage: null,
      outcome: {
        kind: 'retryable_failure',
        waitReason: 'provider_failed',
        retryAt: later(NOW, delay),
      },
    });
  }
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })
  ).toMatchObject({
    outcome: 'nothing_claimable',
    reason: 'waiting',
    nextRetry: {
      jobId: first.jobId,
      retryAt: later(NOW, 60_000),
      waitReason: 'provider_failed',
    },
  });
  await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 60_000) });
  await parkProcessingJob(fixture.handle, {
    generation,
    jobId: first.jobId,
    waitReason: 'no_grant',
    now: later(NOW, 60_000),
  });
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 60_000) })
  ).toMatchObject({
    outcome: 'nothing_claimable',
    nextRetry: {
      jobId: second.jobId,
      retryAt: later(NOW, 120_000),
      waitReason: 'provider_failed',
    },
  });
});

it('does not let an exhausted retry hide a later retry with attempts remaining', async () => {
  const { fixture, generation } = await owned();
  const exhausted = await fixture.capture({ admittedAt: later(NOW, -2_000) });
  const eligible = await fixture.capture({ admittedAt: later(NOW, -1_000) });
  for (const [job, maxAttempts, delay] of [
    [exhausted, 1, 30_000],
    [eligible, 3, 60_000],
  ] as const) {
    await claimProcessingJob(fixture.handle, { generation, now: NOW });
    const started = await startProcessingAttempt(fixture.handle, {
      generation,
      ...attemptInput(fixture.handle, job.jobId, NOW, maxAttempts),
    });
    if (started.outcome !== 'started') throw new Error('the attempt did not start');
    await endHold(fixture.handle, generation, started, later(NOW, 1000));
    await settleProcessingAttempt(fixture.handle, {
      generation,
      jobId: job.jobId,
      attemptId: started.attempt.attemptId,
      finishedAt: later(NOW, 1000),
      usage: null,
      outcome: {
        kind: 'retryable_failure',
        waitReason: 'provider_failed',
        retryAt: later(NOW, delay),
      },
    });
  }
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })
  ).toMatchObject({
    outcome: 'nothing_claimable',
    nextRetryAt: later(NOW, 30_000),
    nextRetry: {
      jobId: eligible.jobId,
      retryAt: later(NOW, 60_000),
      waitReason: 'provider_failed',
    },
  });
});

it('parks a claimed job with its wait reason, spending nothing, and stops claiming it', async () => {
  const { fixture, generation } = await owned();
  const refused = await fixture.capture({ admittedAt: '2026-09-01T00:00:00.000Z' });
  const ready = await fixture.capture({ admittedAt: '2026-09-01T00:01:00.000Z' });
  await claimProcessingJob(fixture.handle, { generation, now: NOW });

  const parked = await parkProcessingJob(fixture.handle, {
    generation,
    jobId: refused.jobId,
    waitReason: 'dispatch_context_missing',
    now: later(NOW, 1000),
  });

  expect(parked).toMatchObject({
    state: 'pending',
    waitReason: 'dispatch_context_missing',
    retryAt: null,
    claimedGeneration: null,
  });
  expect(readProcessingJobAttempts(fixture.handle, refused.jobId, 5)).toEqual([]);
  // The one behind it is claimed next instead of the queue stopping.
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })
  ).toMatchObject({ outcome: 'claimed', job: { jobId: ready.jobId } });
});

it('returns a claimed job to the queue when nothing names a wait reason', async () => {
  const { fixture, generation } = await owned();
  const job = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });

  const parked = await parkProcessingJob(fixture.handle, {
    generation,
    jobId: job.jobId,
    waitReason: null,
    now: later(NOW, 1000),
  });

  expect(parked).toMatchObject({ state: 'pending', waitReason: null, retryAt: null });
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })
  ).toMatchObject({ outcome: 'claimed', job: { jobId: job.jobId } });
});

it('refuses to park a job this owner does not hold or whose call may be in flight', async () => {
  const { fixture, generation } = await owned();
  const job = await fixture.capture();

  await expect(
    parkProcessingJob(fixture.handle, {
      generation,
      jobId: job.jobId,
      waitReason: 'source_not_eligible',
      now: NOW,
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });

  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, job.jobId, NOW),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  // Recovery frees a job whose paid call may still be running, never parking.
  await expect(
    parkProcessingJob(fixture.handle, {
      generation,
      jobId: job.jobId,
      waitReason: 'source_not_eligible',
      now: later(NOW, 1000),
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

it('frees only the parked jobs whose wait reason is named, and the operator frees the rest', async () => {
  const { fixture, generation } = await owned();
  const origin = await fixture.capture({ admittedAt: '2026-09-01T00:00:00.000Z' });
  const permanent = await fixture.capture({ admittedAt: '2026-09-01T00:01:00.000Z' });
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  await parkProcessingJob(fixture.handle, {
    generation,
    jobId: origin.jobId,
    waitReason: 'configuration_paused',
    now: NOW,
  });
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  await parkProcessingJob(fixture.handle, {
    generation,
    jobId: permanent.jobId,
    waitReason: 'source_not_eligible',
    now: NOW,
  });

  const freed = await unparkProcessingJobs(fixture.handle, {
    generation,
    waitReasons: ['configuration_paused'],
    now: later(NOW, 1000),
  });

  expect(freed.map((job) => job.jobId)).toEqual([origin.jobId]);
  expect(readProcessingJob(fixture.handle, origin.jobId)!.waitReason).toBeNull();
  expect(readProcessingJob(fixture.handle, permanent.jobId)!.waitReason).toBe(
    'source_not_eligible'
  );
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })
  ).toMatchObject({ outcome: 'claimed', job: { jobId: origin.jobId } });

  // Only an operator's retry moves the permanent one.
  const retried = await retryProcessingJob(fixture.handle, {
    jobId: permanent.jobId,
    now: later(NOW, 3000),
  });
  expect(retried.outcome).toBe('due');
  expect(readProcessingJob(fixture.handle, permanent.jobId)!.waitReason).toBeNull();
});

it('stops claiming while the project is paused and touches no job', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  const before = fixture.snapshot();
  await pauseProcessing(fixture.handle, {
    changedAt: NOW,
    changedBy: 'owner@example.test',
    changedByBasis: 'authenticated',
    reason: 'the provider is being replaced',
  });
  expect(await claimProcessingJob(fixture.handle, { generation, now: NOW })).toMatchObject({
    outcome: 'nothing_claimable',
    reason: 'paused',
    openJobs: 1,
  });
  const after = fixture.snapshot();
  expect(after.jobs).toEqual(before.jobs);
  expect(readProcessingJob(fixture.handle, capture.jobId)!.state).toBe('pending');
});

it('claims a job whose no-model choice a recorded resume has lifted', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture({ withoutModel: true });
  expect(await claimProcessingJob(fixture.handle, { generation, now: NOW })).toMatchObject({
    reason: 'awaiting_model_resume',
  });
  await fixture.confirm(capture.jobId, NOW);
  expect(await claimProcessingJob(fixture.handle, { generation, now: NOW })).toMatchObject({
    outcome: 'claimed',
    job: { jobId: capture.jobId, withoutModel: true },
  });
});

it('binds a no-model attempt to its retained origin and confirmed envelope', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture({ withoutModel: true });
  await fixture.confirm(capture.jobId, NOW);
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const valid = attemptInput(fixture.handle, capture.jobId, NOW);
  const permission = valid.configuration.permission;

  for (const execution_terms of [
    {
      ...permission.execution_terms,
      origin: { worktree_root: '/another-origin' },
    },
    {
      ...permission.execution_terms,
      limits: {
        ...permission.execution_terms.limits,
        max_output_bytes: permission.execution_terms.limits.max_output_bytes + 1,
      },
    },
  ]) {
    const before = fixture.snapshot();
    await expect(
      startProcessingAttempt(fixture.handle, {
        generation,
        ...valid,
        attemptId: uuidv7(),
        configuration: {
          ...valid.configuration,
          permission: { ...permission, execution_terms },
        },
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(fixture.snapshot()).toEqual(before);
  }
});

it('refuses every scheduling write under a superseded generation', async () => {
  const { fixture, generation } = await owned(later(NOW, 1000));
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });
  const before = fixture.snapshot();
  const stale = { code: 'STALE_CONTEXT' };
  await expect(
    claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })
  ).rejects.toMatchObject(stale);
  await expect(
    parkProcessingJob(fixture.handle, {
      generation,
      jobId: capture.jobId,
      waitReason: 'source_not_eligible',
      now: later(NOW, 2000),
    })
  ).rejects.toMatchObject(stale);
  await expect(
    unparkProcessingJobs(fixture.handle, {
      generation,
      waitReasons: ['configuration_paused'],
      now: later(NOW, 2000),
    })
  ).rejects.toMatchObject(stale);
  await expect(
    startProcessingAttempt(fixture.handle, {
      generation,
      ...attemptInput(fixture.handle, capture.jobId, later(NOW, 2000)),
    })
  ).rejects.toMatchObject(stale);
  await expect(
    settleProcessingCall(fixture.handle, {
      generation,
      usageId: started.usage.usageId,
      settledAt: later(NOW, 2000),
      result: { kind: 'released' },
    })
  ).rejects.toMatchObject(stale);
  await expect(
    settleProcessingAttempt(fixture.handle, {
      generation,
      jobId: capture.jobId,
      attemptId: started.attempt.attemptId,
      finishedAt: later(NOW, 2000),
      usage: null,
      outcome: { kind: 'succeeded', publishingOperationId: null, result: { records: 1 } },
    })
  ).rejects.toMatchObject(stale);
  await expect(
    recoverProcessingAttempts(fixture.handle, {
      generation,
      now: later(NOW, 2000),
      callLifetimeMs: LIFETIME,
      waitReason: 'owner_lost',
      retryAt: later(NOW, 2000),
    })
  ).rejects.toMatchObject(stale);
  expect(fixture.snapshot()).toEqual(before);
});

it('finishes a held job only once its retained attempts fill the allowance', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, later(NOW, 1000), 2),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await endHold(fixture.handle, generation, started, later(NOW, 1400));
  const exhaust = (maxAttempts: number) =>
    settleExhaustedProcessingJob(fixture.handle, {
      generation,
      jobId: capture.jobId,
      maxAttempts,
      at: later(NOW, 2000),
    });

  await expect(exhaust(1)).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: capture.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1500),
    usage: null,
    outcome: { kind: 'retryable_failure', waitReason: 'rate_limited', retryAt: NOW },
  });
  await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) });
  await expect(exhaust(2)).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProcessingJob(fixture.handle, capture.jobId)?.state).toBe('running');

  expect(await exhaust(1)).toMatchObject({
    outcome: 'attempts_exhausted',
    attempts: 1,
    maxAttempts: 1,
    job: {
      state: 'terminal_failure',
      claimedGeneration: null,
      result: { outcome: 'attempts_exhausted', attempts: 1, max_attempts: 1 },
    },
  });
});

it('numbers attempts as it makes them and never resets the allowance on a retry', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  for (const number of [1, 2]) {
    await claimProcessingJob(fixture.handle, { generation, now: NOW });
    const started = await startProcessingAttempt(fixture.handle, {
      generation,
      ...attemptInput(fixture.handle, capture.jobId, later(NOW, number * 1000), 2),
    });
    if (started.outcome !== 'started') throw new Error('the attempt did not start');
    await endHold(fixture.handle, generation, started, later(NOW, number * 1000 + 400));
    expect(started.attempt).toMatchObject({
      attemptNumber: number,
      ownerGeneration: generation,
      configurationIdentity: CONFIGURATION,
      configuration: { model: 'original model', max_input_bytes: 131072 },
      grantId: 'grant-1',
      outcome: null,
    });
    await settleProcessingAttempt(fixture.handle, {
      generation,
      jobId: capture.jobId,
      attemptId: started.attempt.attemptId,
      finishedAt: later(NOW, number * 1000 + 500),
      usage: null,
      outcome: { kind: 'retryable_failure', waitReason: 'rate_limited', retryAt: NOW },
    });
  }
  await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 5000) });
  const spent = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, later(NOW, 5000), 2),
  });
  expect(spent).toMatchObject({
    outcome: 'attempts_exhausted',
    attempts: 2,
    maxAttempts: 2,
    job: {
      state: 'terminal_failure',
      claimedGeneration: null,
      waitReason: null,
      retryAt: null,
      result: { outcome: 'attempts_exhausted', attempts: 2, max_attempts: 2 },
    },
  });
  expect(
    readProcessingJobAttempts(fixture.handle, capture.jobId).map((a) => a.attemptNumber)
  ).toEqual([2, 1]);
  // The queue moves on: a spent allowance finishes its job rather than holding the running slot.
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 6000) })
  ).toMatchObject({ outcome: 'nothing_claimable', reason: 'queue_empty' });
});

type Fixture = Awaited<ReturnType<typeof project>>;

async function failAttempt(
  fixture: Fixture,
  generation: number,
  jobId: string,
  at: string,
  maxAttempts: number,
  retryAt = at
) {
  await claimProcessingJob(fixture.handle, { generation, now: at });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, jobId, at, maxAttempts),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await endHold(fixture.handle, generation, started, later(at, 400));
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(at, 500),
    usage: null,
    outcome: { kind: 'retryable_failure', waitReason: 'provider_failed', retryAt },
  });
  return started.attempt;
}

async function nextAttempt(
  fixture: Fixture,
  generation: number,
  jobId: string,
  at: string,
  maxAttempts: number
) {
  await claimProcessingJob(fixture.handle, { generation, now: at });
  return startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, jobId, at, maxAttempts),
  });
}

async function gaveUp(fixture: Fixture, generation: number, jobId: string) {
  await failAttempt(fixture, generation, jobId, NOW, 1);
  const spent = await nextAttempt(fixture, generation, jobId, later(NOW, 1000), 1);
  if (spent.outcome !== 'attempts_exhausted') throw new Error('the job did not give up');
}

async function reopen(fixture: Fixture, jobId: string, attemptsAllowed: number, at: string) {
  const job = readProcessingJob(fixture.handle, jobId)!;
  const previous = fixture.handle.read((view) =>
    readLatestProcessingJobReopening(view, jobId)
  ).value;
  return reopenProcessingJob(fixture.handle, {
    reopeningId: uuidv7(),
    jobId,
    expectedUpdatedAt: job.updatedAt,
    expectedPreviousSequence: previous?.reopeningSequence ?? null,
    attemptsAllowed,
    reopenedAt: at,
    reopenedBy: 'owner@example.test',
    reopenedByBasis: 'authenticated',
    grantId: 'grant-1',
  });
}

it('gives a reopened job exactly the approved allowance, numbered after its earlier attempts', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await gaveUp(fixture, generation, capture.jobId);

  expect(await reopen(fixture, capture.jobId, 2, later(NOW, 2000))).toMatchObject({
    outcome: 'reopened',
    job: { state: 'pending', result: null },
    reopening: {
      reopeningSequence: 1,
      attemptsBefore: 1,
      attemptsAllowed: 2,
      gaveUp: { outcome: 'attempts_exhausted', attempts: 1, max_attempts: 1 },
    },
  });
  for (const [number, at] of [
    [2, 3000],
    [3, 4000],
  ] as const) {
    const attempt = await failAttempt(fixture, generation, capture.jobId, later(NOW, at), 2);
    expect(attempt.attemptNumber).toBe(number);
  }
  expect(await nextAttempt(fixture, generation, capture.jobId, later(NOW, 5000), 2)).toMatchObject({
    outcome: 'attempts_exhausted',
    attempts: 2,
    maxAttempts: 2,
    job: {
      state: 'terminal_failure',
      result: { outcome: 'attempts_exhausted', attempts: 2, max_attempts: 2 },
    },
  });
  expect(
    readProcessingJobAttempts(fixture.handle, capture.jobId).map((a) => a.attemptNumber)
  ).toEqual([3, 2, 1]);
});

it('never lets configuration raise the allowance a reopening approved, and lets it lower one', async () => {
  for (const [approved, configured] of [
    [1, 3],
    [3, 1],
  ] as const) {
    const { fixture, generation } = await owned();
    const capture = await fixture.capture();
    await gaveUp(fixture, generation, capture.jobId);
    await reopen(fixture, capture.jobId, approved, later(NOW, 2000));

    await failAttempt(fixture, generation, capture.jobId, later(NOW, 3000), configured);
    expect(
      await nextAttempt(fixture, generation, capture.jobId, later(NOW, 4000), configured),
      `approved ${approved}, configured ${configured}`
    ).toMatchObject({
      outcome: 'attempts_exhausted',
      attempts: 1,
      maxAttempts: 1,
      job: { state: 'terminal_failure' },
    });
  }
});

it('judges a reopened job by its approved allowance when finishing it and naming its next retry', async () => {
  const finished = await owned();
  const capped = await finished.fixture.capture();
  await gaveUp(finished.fixture, finished.generation, capped.jobId);
  await reopen(finished.fixture, capped.jobId, 1, later(NOW, 2000));
  await failAttempt(finished.fixture, finished.generation, capped.jobId, later(NOW, 3000), 3);
  await claimProcessingJob(finished.fixture.handle, {
    generation: finished.generation,
    now: later(NOW, 4000),
  });
  expect(
    await settleExhaustedProcessingJob(finished.fixture.handle, {
      generation: finished.generation,
      jobId: capped.jobId,
      maxAttempts: 3,
      at: later(NOW, 4000),
    })
  ).toMatchObject({ outcome: 'attempts_exhausted', attempts: 1, maxAttempts: 1 });

  const waiting = await owned();
  const retried = await waiting.fixture.capture();
  await gaveUp(waiting.fixture, waiting.generation, retried.jobId);
  await reopen(waiting.fixture, retried.jobId, 2, later(NOW, 2000));
  await failAttempt(
    waiting.fixture,
    waiting.generation,
    retried.jobId,
    later(NOW, 3000),
    2,
    later(NOW, 60_000)
  );
  expect(
    await claimProcessingJob(waiting.fixture.handle, {
      generation: waiting.generation,
      now: later(NOW, 4000),
    })
  ).toMatchObject({
    outcome: 'nothing_claimable',
    nextRetry: { jobId: retried.jobId, retryAt: later(NOW, 60_000) },
  });
});

it('refuses a second unsettled attempt and an attempt on a job this owner does not hold', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await expect(
    startProcessingAttempt(fixture.handle, {
      generation,
      ...attemptInput(fixture.handle, capture.jobId, NOW),
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  await expect(
    startProcessingAttempt(fixture.handle, {
      generation,
      ...attemptInput(fixture.handle, capture.jobId, later(NOW, 1000)),
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProcessingJobAttempts(fixture.handle, capture.jobId)).toHaveLength(1);
});

it('settles a successful attempt with the operation that published what it derived', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  // Publishes a real receipt without admitting a second job of its own.
  const publication = await fixture.capture({ originKind: 'git-import' });
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await endHold(fixture.handle, generation, started, later(NOW, 900));
  const settled = await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: capture.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1000),
    usage: { input_tokens: 120, output_tokens: 40 },
    outcome: {
      kind: 'succeeded',
      publishingOperationId: publication.operationId,
      result: { requirements: 2 },
    },
  });
  expect(settled.attempt).toMatchObject({
    outcome: 'succeeded',
    finishedAt: later(NOW, 1000),
    usage: { input_tokens: 120, output_tokens: 40 },
    publishingOperationId: publication.operationId,
  });
  expect(settled.job).toMatchObject({
    state: 'completed',
    claimedGeneration: null,
    waitReason: null,
    retryAt: null,
    result: { requirements: 2 },
  });
  await expect(
    claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })
  ).resolves.toMatchObject({ reason: 'queue_empty' });
});

it('refuses a settlement that names an operation this store never committed', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await endHold(fixture.handle, generation, started, later(NOW, 900));
  const before = fixture.snapshot();
  await expect(
    settleProcessingAttempt(fixture.handle, {
      generation,
      jobId: capture.jobId,
      attemptId: started.attempt.attemptId,
      finishedAt: later(NOW, 1000),
      usage: null,
      outcome: { kind: 'succeeded', publishingOperationId: uuidv7(), result: null },
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(fixture.snapshot()).toEqual(before);
});

it('starts an attempt that makes no call, holding nothing and spending an attempt', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const { usageId: _unused, ...record } = attemptInput(fixture.handle, capture.jobId, NOW);
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...record,
    usageId: null,
  });
  expect(started).toMatchObject({
    outcome: 'started_without_call',
    attempt: { attemptNumber: 1, ownerGeneration: generation, outcome: null },
  });
  expect(fixture.snapshot().usage).toEqual([]);
  expect(
    readProcessingUsageWindows(fixture.handle, { now: later(NOW, 1000), maxCallsPerHour: 60 })
  ).toMatchObject({ calls: { used: 0 } });
  // It spends an attempt of the job's allowance, which is the only thing that bounds it.
  expect(readProcessingJobAttempts(fixture.handle, capture.jobId, 5)).toHaveLength(1);
});

it('refuses limits that can never admit a call even for an attempt that makes none', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const { usageId: _unused, ...record } = attemptInput(fixture.handle, capture.jobId, NOW);
  const before = fixture.snapshot();
  await expect(
    startProcessingAttempt(fixture.handle, {
      generation,
      ...record,
      usageId: null,
      maxCallsPerHour: 0,
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fixture.snapshot()).toEqual(before);
});

it('refuses to settle an attempt whose call is still reserved, naming the reservation', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const input = attemptInput(fixture.handle, capture.jobId, NOW);
  const started = await startProcessingAttempt(fixture.handle, { generation, ...input });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  const before = fixture.snapshot();

  await expect(
    settleProcessingAttempt(fixture.handle, {
      generation,
      jobId: capture.jobId,
      attemptId: started.attempt.attemptId,
      finishedAt: later(NOW, 1000),
      usage: null,
      outcome: { kind: 'succeeded', publishingOperationId: null, result: null },
    })
  ).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
    message: `The call this attempt reserved is still held as reservation ${input.usageId}; settle the call before the attempt`,
  });
  expect(fixture.snapshot()).toEqual(before);

  // The order the worker keeps: the call ends, and then the attempt it paid for.
  await endHold(fixture.handle, generation, started, later(NOW, 900));
  const settled = await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: capture.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1000),
    usage: null,
    outcome: { kind: 'succeeded', publishingOperationId: null, result: null },
  });
  expect(settled.attempt).toMatchObject({ outcome: 'succeeded' });
});

it('keeps a completed job as it ended and takes no further attempt on a terminal failure', async () => {
  const { fixture, generation } = await owned();
  const done = await fixture.capture();
  const dead = await fixture.capture();
  for (const [capture, outcome] of [
    [done, { kind: 'succeeded' as const, publishingOperationId: null, result: { records: 0 } }],
    [dead, { kind: 'terminal_failure' as const, result: { reason: 'input too large' } }],
  ] as const) {
    await claimProcessingJob(fixture.handle, { generation, now: NOW });
    const started = await startProcessingAttempt(fixture.handle, {
      generation,
      ...attemptInput(fixture.handle, capture.jobId, NOW),
    });
    if (started.outcome !== 'started') throw new Error('the attempt did not start');
    await endHold(fixture.handle, generation, started, later(NOW, 900));
    await settleProcessingAttempt(fixture.handle, {
      generation,
      jobId: capture.jobId,
      attemptId: started.attempt.attemptId,
      finishedAt: later(NOW, 1000),
      usage: null,
      outcome,
    });
  }
  expect(readProcessingJob(fixture.handle, done.jobId)).toMatchObject({ state: 'completed' });
  expect(readProcessingJob(fixture.handle, dead.jobId)).toMatchObject({
    state: 'terminal_failure',
    result: { reason: 'input too large' },
  });
  const before = fixture.snapshot();
  for (const capture of [done, dead])
    await expect(
      startProcessingAttempt(fixture.handle, {
        generation,
        ...attemptInput(fixture.handle, capture.jobId, later(NOW, 2000)),
      })
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(fixture.snapshot()).toEqual(before);
});

it('keeps a lost call unclaimable until its bounded lifetime has elapsed', async () => {
  const { fixture, generation } = await owned(later(NOW, 1000));
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW, 3, {
      maxCostUsdPerDay: 5,
      reservationUsd: 0.25,
    }),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  const takeover = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });
  const replacement = takeover.lease.ownerGeneration;
  const early = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(NOW, LIFETIME - 1),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(NOW, LIFETIME),
  });
  expect(early).toEqual({
    settled: [],
    reclaimed: [],
    waiting: [
      {
        attemptId: started.attempt.attemptId,
        jobId: capture.jobId,
        eligibleAt: later(NOW, LIFETIME),
        process: null,
      },
    ],
  });
  expect(
    await claimProcessingJob(fixture.handle, {
      generation: replacement,
      now: later(NOW, LIFETIME - 1),
    })
  ).toMatchObject({ outcome: 'nothing_claimable', reason: 'call_in_flight' });

  const recovered = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(NOW, LIFETIME),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(NOW, LIFETIME),
  });
  expect(recovered.waiting).toEqual([]);
  expect(recovered.settled[0]!.attempt).toMatchObject({
    outcome: 'unknown',
    finishedAt: later(NOW, LIFETIME),
    usage: null,
    publishingOperationId: null,
  });
  expect(recovered.settled[0]!.job).toMatchObject({
    state: 'retryable_failure',
    waitReason: 'owner_lost',
    retryAt: later(NOW, LIFETIME),
    claimedGeneration: null,
  });
  const usage = fixture.snapshot().usage as { state: string; reserved_cost_usd: number }[];
  expect(usage).toEqual([
    expect.objectContaining({ state: 'unknown', reserved_cost_usd: 0.25, reported_cost_usd: null }),
  ]);
  expect(
    await claimProcessingJob(fixture.handle, {
      generation: replacement,
      now: later(NOW, LIFETIME),
    })
  ).toMatchObject({ outcome: 'claimed', job: { jobId: capture.jobId } });
});

it('settles a lost call at once when the recovering owner watched its provider go', async () => {
  const { fixture, generation } = await owned(later(NOW, 1000));
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW, 3, {
      maxCostUsdPerDay: 5,
      reservationUsd: 0.25,
    }),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  const takeover = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });
  const replacement = takeover.lease.ownerGeneration;

  // Well inside the lifetime, but this owner has seen the provider group go.
  const recovered = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(NOW, 2000),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(NOW, 3000),
    confirmedGone: [started.attempt.attemptId],
  });

  expect(recovered.waiting).toEqual([]);
  expect(recovered.settled[0]!.attempt).toMatchObject({ outcome: 'unknown', usage: null });
  // The hold is kept in full: an observed termination says the call is over, not
  // that it was free.
  const usage = fixture.snapshot().usage as { state: string; reserved_cost_usd: number }[];
  expect(usage).toEqual([
    expect.objectContaining({ state: 'unknown', reserved_cost_usd: 0.25, reported_cost_usd: null }),
  ]);
  // The project's one running slot is free again without waiting the bound out.
  expect(
    await claimProcessingJob(fixture.handle, { generation: replacement, now: later(NOW, 3000) })
  ).toMatchObject({ outcome: 'claimed', job: { jobId: capture.jobId } });
});

it('names no attempt but the one it confirmed, and waits out the rest', async () => {
  const { fixture, generation } = await owned(later(NOW, 1000));
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  const takeover = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });

  const recovered = await recoverProcessingAttempts(fixture.handle, {
    generation: takeover.lease.ownerGeneration,
    now: later(NOW, 2000),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(NOW, 3000),
    confirmedGone: [uuidv7()],
  });

  expect(recovered.settled).toEqual([]);
  expect(recovered.waiting).toMatchObject([{ attemptId: started.attempt.attemptId }]);
});

it('leaves the running owner its own open attempt when recovery sweeps', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  const before = fixture.snapshot();
  expect(
    await recoverProcessingAttempts(fixture.handle, {
      generation,
      now: later(NOW, 10 * LIFETIME),
      callLifetimeMs: LIFETIME,
      waitReason: 'owner_lost',
      retryAt: later(NOW, 10 * LIFETIME),
    })
  ).toEqual({ settled: [], waiting: [], reclaimed: [] });
  expect(fixture.snapshot()).toEqual(before);
});

it('returns to the queue a job a lost owner claimed and never attempted', async () => {
  const fixture = await project();
  const first = await fixture.capture();
  const second = await fixture.capture();
  const held = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 30_000),
  });
  const claim = await claimProcessingJob(fixture.handle, {
    generation: held.lease.ownerGeneration,
    now: NOW,
  });
  if (claim.outcome !== 'claimed') throw new Error('nothing was claimable');
  expect(claim.job.jobId).toBe(first.jobId);
  const takeover = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 30_000),
    expiresAt: later(NOW, HOUR),
  });
  const replacement = takeover.lease.ownerGeneration;
  const recovered = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(NOW, 30_000),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(NOW, 30_000),
  });
  expect(recovered.settled).toEqual([]);
  expect(recovered.waiting).toEqual([]);
  expect(recovered.reclaimed).toMatchObject([
    { jobId: first.jobId, state: 'pending', claimedGeneration: null, waitReason: null },
  ]);
  // A single stuck claim held the whole project's queue, not only its own job.
  expect(
    await claimProcessingJob(fixture.handle, { generation: replacement, now: later(NOW, 30_000) })
  ).toMatchObject({ outcome: 'claimed', job: { jobId: first.jobId } });
  expect(readProcessingJob(fixture.handle, second.jobId)!.state).toBe('pending');
  expect(readProcessingJobAttempts(fixture.handle, first.jobId)).toEqual([]);
});

it('leaves a lost claim alone while its attempt may still be spending', async () => {
  const { fixture, generation } = await owned(later(NOW, 1000));
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  const takeover = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });
  const replacement = takeover.lease.ownerGeneration;
  const recovered = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(NOW, LIFETIME - 1),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(NOW, LIFETIME),
  });
  expect(recovered.reclaimed).toEqual([]);
  expect(recovered.waiting).toHaveLength(1);
  expect(readProcessingJob(fixture.handle, capture.jobId)!.state).toBe('running');
});

it('refuses a settlement or a recovery that names no retry time', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  const before = fixture.snapshot();
  for (const kind of ['retryable_failure', 'unknown'] as const)
    await expect(
      settleProcessingAttempt(fixture.handle, {
        generation,
        jobId: capture.jobId,
        attemptId: started.attempt.attemptId,
        finishedAt: later(NOW, 1000),
        usage: null,
        outcome: {
          kind,
          waitReason: 'provider_unavailable',
          retryAt: null as unknown as string,
        },
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    recoverProcessingAttempts(fixture.handle, {
      generation,
      now: later(NOW, 1000),
      callLifetimeMs: LIFETIME,
      waitReason: 'owner_lost',
      retryAt: null as unknown as string,
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fixture.snapshot()).toEqual(before);
});

it('bounds a lost attempt dated in the future by the moment this owner took the lease', async () => {
  const { fixture, generation } = await owned(later(NOW, 1000));
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  // The lost owner's clock ran a year ahead.
  const ahead = later(NOW, 365 * 24 * HOUR);
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, ahead),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  const takenAt = later(NOW, 1000);
  const takeover = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: takenAt,
    expiresAt: later(takenAt, HOUR),
  });
  const replacement = takeover.lease.ownerGeneration;
  const early = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(takenAt, LIFETIME - 1),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(takenAt, LIFETIME),
  });
  expect(early.waiting).toEqual([
    {
      attemptId: started.attempt.attemptId,
      jobId: capture.jobId,
      eligibleAt: later(takenAt, LIFETIME),
      process: null,
    },
  ]);
  const recovered = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(takenAt, LIFETIME),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(takenAt, LIFETIME),
  });
  expect(recovered.settled).toHaveLength(1);
  expect(recovered.settled[0]!.attempt).toMatchObject({ outcome: 'unknown', startedAt: ahead });
});

it('bounds a lost attempt dated long before the lease by the moment this owner took it', async () => {
  const { fixture, generation } = await owned(later(NOW, 1000));
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  // The lost owner's clock ran two hours behind, so its call looks older than a whole lifetime.
  const behind = later(NOW, -2 * HOUR);
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, behind),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  const takenAt = later(NOW, 31_000);
  const takeover = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: takenAt,
    expiresAt: later(takenAt, HOUR),
  });
  const replacement = takeover.lease.ownerGeneration;
  const early = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(takenAt, 1),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(takenAt, LIFETIME),
  });
  expect(early.waiting).toEqual([
    {
      attemptId: started.attempt.attemptId,
      jobId: capture.jobId,
      eligibleAt: later(takenAt, LIFETIME),
      process: null,
    },
  ]);
  expect(early.settled).toEqual([]);
  expect(
    await claimProcessingJob(fixture.handle, { generation: replacement, now: later(takenAt, 2) })
  ).toMatchObject({ outcome: 'nothing_claimable', reason: 'call_in_flight' });
});

it('records what an attempt spawned once and hands it to a recovering owner', async () => {
  const { fixture, generation } = await owned(later(NOW, 1000));
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  expect(started.attempt).toMatchObject({ grantId: 'grant-1', process: null });
  const recorded = await recordProcessingAttemptProcess(fixture.handle, {
    generation,
    attemptId: started.attempt.attemptId,
    process: { process_group: 4242, provider: 'claude' },
  });
  expect(recorded.process).toEqual({ process_group: 4242, provider: 'claude' });
  await expect(
    recordProcessingAttemptProcess(fixture.handle, {
      generation,
      attemptId: started.attempt.attemptId,
      process: { process_group: 77 },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  const takeover = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });
  const replacement = takeover.lease.ownerGeneration;
  await expect(
    recordProcessingAttemptProcess(fixture.handle, {
      generation: replacement,
      attemptId: started.attempt.attemptId,
      process: { process_group: 77 },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  // The recovering owner is handed what to terminate, both while it waits and once it settles.
  const early = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(NOW, LIFETIME - 1),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(NOW, LIFETIME),
  });
  expect(early.waiting[0]!.process).toEqual({ process_group: 4242, provider: 'claude' });
  const recovered = await recoverProcessingAttempts(fixture.handle, {
    generation: replacement,
    now: later(NOW, LIFETIME),
    callLifetimeMs: LIFETIME,
    waitReason: 'owner_lost',
    retryAt: later(NOW, LIFETIME),
  });
  expect(recovered.settled[0]!.attempt).toMatchObject({
    outcome: 'unknown',
    process: { process_group: 4242, provider: 'claude' },
    grantId: 'grant-1',
  });
});

it('refuses a process record on a settled attempt or with nothing recorded', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    ...attemptInput(fixture.handle, capture.jobId, NOW),
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await expect(
    recordProcessingAttemptProcess(fixture.handle, {
      generation,
      attemptId: started.attempt.attemptId,
      process: null,
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await endHold(fixture.handle, generation, started, later(NOW, 900));
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: capture.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1000),
    usage: null,
    outcome: { kind: 'succeeded', publishingOperationId: null, result: null },
  });
  const before = fixture.snapshot();
  await expect(
    recordProcessingAttemptProcess(fixture.handle, {
      generation,
      attemptId: started.attempt.attemptId,
      process: { process_group: 4242 },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await expect(
    recordProcessingAttemptProcess(fixture.handle, {
      generation,
      attemptId: uuidv7(),
      process: { process_group: 4242 },
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(fixture.snapshot()).toEqual(before);
});

it('refuses an attempt that names no consent grant', async () => {
  const { fixture, generation } = await owned();
  const capture = await fixture.capture();
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const before = fixture.snapshot();
  await expect(
    startProcessingAttempt(fixture.handle, {
      generation,
      ...attemptInput(fixture.handle, capture.jobId, NOW),
      grantId: '',
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fixture.snapshot()).toEqual(before);
});
