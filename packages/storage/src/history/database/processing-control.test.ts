import { afterEach, expect, it } from 'vitest';

import {
  pauseProcessing,
  readProcessingControl,
  recordProcessingModelResume,
  reopenProcessingJob,
  resumeProcessing,
  retryProcessingJob,
} from './processing-control.js';
import { takeProcessingLease } from './processing-lease.js';
import { readProcessingJob, readProcessingJobAttempts } from './processing-reader.js';
import { readProcessingJobReopenings } from './processing-reopenings.js';
import {
  claimProcessingJob,
  settleProcessingAttempt,
  startProcessingAttempt,
} from './processing-schedule.js';
import { settleProcessingCall } from './processing-usage.js';
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
async function project() {
  const fixture = await processingFixture();
  fixtures.push(fixture);
  return fixture;
}
const owner = { changedBy: 'owner@example.test', changedByBasis: 'authenticated' as const };

it('records who paused processing and why, and resumes without touching a job', async () => {
  const fixture = await project();
  const capture = await fixture.capture();
  expect(readProcessingControl(fixture.handle)).toBeNull();
  const jobs = fixture.snapshot().jobs;
  const paused = await pauseProcessing(fixture.handle, {
    ...owner,
    changedAt: NOW,
    reason: 'the provider is being replaced',
  });
  expect(paused).toEqual({
    paused: true,
    changedAt: NOW,
    changedBy: 'owner@example.test',
    changedByBasis: 'authenticated',
    reason: 'the provider is being replaced',
  });
  expect(readProcessingControl(fixture.handle)).toEqual(paused);
  expect(fixture.snapshot().jobs).toEqual(jobs);
  const resumed = await resumeProcessing(fixture.handle, { ...owner, changedAt: later(NOW, 1000) });
  expect(resumed).toMatchObject({ paused: false, changedAt: later(NOW, 1000), reason: null });
  expect(fixture.snapshot().jobs).toEqual(jobs);
  expect(readProcessingJob(fixture.handle, capture.jobId)!.state).toBe('pending');
});

it("refuses a superseded owner's pause and accepts a person's, which names none", async () => {
  const fixture = await project();
  const first = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 1000),
  });
  const superseded = first.lease.ownerGeneration;
  await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, 60_000),
  });

  await expect(
    pauseProcessing(fixture.handle, {
      generation: superseded,
      changedAt: later(NOW, 2000),
      changedBy: 'orcaops knowledge worker',
      changedByBasis: 'other_assertion',
      reason: 'a worker that no longer owns this project',
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProcessingControl(fixture.handle)).toBeNull();

  // A person's pause outlives every worker and names no generation.
  await pauseProcessing(fixture.handle, {
    changedAt: later(NOW, 3000),
    changedBy: 'a person',
    changedByBasis: 'other_assertion',
    reason: 'by hand',
  });
  expect(readProcessingControl(fixture.handle)).toMatchObject({ paused: true });
});

it('refuses a pause whose actor and attribution basis disagree', async () => {
  const fixture = await project();
  for (const input of [
    { changedBy: null, changedByBasis: 'authenticated' as const },
    { changedBy: 'owner@example.test', changedByBasis: 'unknown' as const },
    { changedBy: 'owner@example.test', changedByBasis: 'guessed' as unknown as 'authenticated' },
  ])
    await expect(
      pauseProcessing(fixture.handle, { ...input, changedAt: NOW })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(readProcessingControl(fixture.handle)).toBeNull();
});

it('retains an unknown actor without a name', async () => {
  const fixture = await project();
  const paused = await pauseProcessing(fixture.handle, {
    changedAt: NOW,
    changedBy: null,
    changedByBasis: 'unknown',
    reason: null,
  });
  expect(paused).toMatchObject({ changedBy: null, changedByBasis: 'unknown' });
});

it('records a consented model resume once and refuses a second', async () => {
  const fixture = await project();
  const capture = await fixture.capture({ withoutModel: true });
  const grantId = uuidv7();
  const resumed = await recordProcessingModelResume(fixture.handle, {
    jobId: capture.jobId,
    resumedAt: NOW,
    resumedBy: 'owner@example.test',
    resumedByBasis: 'authenticated',
    grantId,
  });
  expect(resumed).toMatchObject({
    withoutModel: true,
    modelResume: {
      resumedAt: NOW,
      resumedBy: 'owner@example.test',
      resumedByBasis: 'authenticated',
      grantId,
    },
  });
  const before = fixture.snapshot();
  await expect(
    recordProcessingModelResume(fixture.handle, {
      jobId: capture.jobId,
      resumedAt: later(NOW, 1000),
      resumedBy: 'other@example.test',
      resumedByBasis: 'authenticated',
      grantId: uuidv7(),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(fixture.snapshot()).toEqual(before);
});

it('refuses a model resume for a job that was admitted with a model', async () => {
  const fixture = await project();
  const capture = await fixture.capture();
  await expect(
    recordProcessingModelResume(fixture.handle, {
      jobId: capture.jobId,
      resumedAt: NOW,
      resumedBy: 'owner@example.test',
      resumedByBasis: 'authenticated',
      grantId: uuidv7(),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    recordProcessingModelResume(fixture.handle, {
      jobId: uuidv7(),
      resumedAt: NOW,
      resumedBy: 'owner@example.test',
      resumedByBasis: 'authenticated',
      grantId: uuidv7(),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(readProcessingJob(fixture.handle, capture.jobId)!.modelResume).toBeNull();
});

it('refuses a model resume that names no consent grant', async () => {
  const fixture = await project();
  const capture = await fixture.capture({ withoutModel: true });
  await expect(
    recordProcessingModelResume(fixture.handle, {
      jobId: capture.jobId,
      resumedAt: NOW,
      resumedBy: 'owner@example.test',
      resumedByBasis: 'authenticated',
      grantId: '',
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(readProcessingJob(fixture.handle, capture.jobId)!.modelResume).toBeNull();
});

it('makes a waiting job due now without resetting its allowance', async () => {
  const fixture = await project();
  const capture = await fixture.capture();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 60 * 60 * 1000),
  });
  const generation = lease.ownerGeneration;
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const configuration = processingAttemptConfiguration(fixture.handle, capture.jobId);
  const started = await startProcessingAttempt(fixture.handle, {
    usageId: uuidv7(),
    maxCallsPerHour: 60,
    generation,
    jobId: capture.jobId,
    attemptId: uuidv7(),
    startedAt: NOW,
    maxAttempts: 3,
    configurationIdentity: 'c'.repeat(64),
    configuration,
    confirmationId: configuration.permission.confirmation_id,
    grantId: 'grant-1',
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await settleProcessingCall(fixture.handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt: later(NOW, 900),
    result: { kind: 'unknown' },
  });
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: capture.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1000),
    usage: null,
    outcome: {
      kind: 'retryable_failure',
      waitReason: 'provider_unavailable',
      retryAt: later(NOW, 365 * 24 * 60 * 60 * 1000),
    },
  });
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })
  ).toMatchObject({ reason: 'waiting' });
  const retried = await retryProcessingJob(fixture.handle, {
    jobId: capture.jobId,
    now: later(NOW, 2000),
  });
  expect(retried).toMatchObject({
    outcome: 'due',
    job: {
      state: 'retryable_failure',
      retryAt: later(NOW, 2000),
      waitReason: 'provider_unavailable',
    },
  });
  expect(
    await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) })
  ).toMatchObject({ outcome: 'claimed', job: { jobId: capture.jobId } });
  expect(readProcessingJobAttempts(fixture.handle, capture.jobId)).toHaveLength(1);
});

it('frees a pending job that a wait reason parked', async () => {
  const fixture = await project();
  const capture = await fixture.capture();
  fixture
    .driver()
    .prepare("UPDATE processing_jobs SET wait_reason='disabled' WHERE job_id=?")
    .run(capture.jobId);
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 60 * 60 * 1000),
  });
  const generation = lease.ownerGeneration;
  expect(await claimProcessingJob(fixture.handle, { generation, now: NOW })).toMatchObject({
    reason: 'waiting',
  });
  expect(
    await retryProcessingJob(fixture.handle, { jobId: capture.jobId, now: NOW })
  ).toMatchObject({ outcome: 'due', job: { state: 'pending', waitReason: null, retryAt: null } });
  expect(await claimProcessingJob(fixture.handle, { generation, now: NOW })).toMatchObject({
    outcome: 'claimed',
  });
});

it('never reopens a finished job and never disturbs a call in flight', async () => {
  const fixture = await project();
  const done = await fixture.capture();
  const running = await fixture.capture();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 60 * 60 * 1000),
  });
  const generation = lease.ownerGeneration;
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const configuration = processingAttemptConfiguration(fixture.handle, done.jobId);
  const started = await startProcessingAttempt(fixture.handle, {
    usageId: uuidv7(),
    maxCallsPerHour: 60,
    generation,
    jobId: done.jobId,
    attemptId: uuidv7(),
    startedAt: NOW,
    maxAttempts: 3,
    configurationIdentity: 'c'.repeat(64),
    configuration,
    confirmationId: configuration.permission.confirmation_id,
    grantId: 'grant-1',
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await settleProcessingCall(fixture.handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt: later(NOW, 900),
    result: { kind: 'unknown' },
  });
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: done.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1000),
    usage: null,
    outcome: { kind: 'succeeded', publishingOperationId: null, result: { records: 1 } },
  });
  await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) });
  const before = fixture.snapshot();
  expect(
    await retryProcessingJob(fixture.handle, { jobId: done.jobId, now: later(NOW, 3000) })
  ).toMatchObject({ outcome: 'finished', job: { state: 'completed' } });
  expect(
    await retryProcessingJob(fixture.handle, { jobId: running.jobId, now: later(NOW, 3000) })
  ).toMatchObject({ outcome: 'running', job: { state: 'running' } });
  expect(fixture.snapshot()).toEqual(before);
  await expect(
    retryProcessingJob(fixture.handle, { jobId: uuidv7(), now: NOW })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
});

it('reopens a job that gave up with the approved allowance, keeping what it gave up with', async () => {
  const fixture = await project();
  const dead = await fixture.capture();
  const pending = await fixture.capture();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 60 * 60 * 1000),
  });
  const generation = lease.ownerGeneration;
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const configuration = processingAttemptConfiguration(fixture.handle, dead.jobId);
  const started = await startProcessingAttempt(fixture.handle, {
    usageId: uuidv7(),
    maxCallsPerHour: 60,
    generation,
    jobId: dead.jobId,
    attemptId: uuidv7(),
    startedAt: NOW,
    maxAttempts: 3,
    configurationIdentity: 'c'.repeat(64),
    configuration,
    confirmationId: configuration.permission.confirmation_id,
    grantId: 'grant-1',
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await settleProcessingCall(fixture.handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt: later(NOW, 900),
    result: { kind: 'unknown' },
  });
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: dead.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1000),
    usage: null,
    outcome: { kind: 'terminal_failure', result: { reason: 'input too large' } },
  });
  const gaveUp = readProcessingJob(fixture.handle, dead.jobId)!;
  const reopening = (changes: Partial<Parameters<typeof reopenProcessingJob>[1]> = {}) =>
    reopenProcessingJob(fixture.handle, {
      reopeningId: uuidv7(),
      jobId: dead.jobId,
      expectedUpdatedAt: gaveUp.updatedAt,
      expectedPreviousSequence: null,
      attemptsAllowed: 2,
      reopenedAt: later(NOW, 2000),
      reopenedBy: 'owner@example.test',
      reopenedByBasis: 'authenticated',
      grantId: 'grant-1',
      ...changes,
    });

  expect(
    await retryProcessingJob(fixture.handle, { jobId: dead.jobId, now: later(NOW, 1500) })
  ).toMatchObject({ outcome: 'finished', job: { state: 'terminal_failure' } });
  const before = fixture.snapshot();
  await expect(reopening({ expectedUpdatedAt: NOW })).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  await expect(reopening({ expectedPreviousSequence: 1 })).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  await expect(reopening({ reopenedBy: null })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(reopening({ attemptsAllowed: 0 })).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(await reopening({ jobId: pending.jobId, expectedUpdatedAt: NOW })).toMatchObject({
    outcome: 'open',
    job: { state: 'pending' },
  });
  await expect(reopening({ jobId: uuidv7() })).rejects.toMatchObject({
    code: 'HISTORY_MISSING',
  });
  expect(fixture.snapshot()).toEqual(before);

  const reopened = await reopening();
  expect(reopened).toMatchObject({
    outcome: 'reopened',
    job: { state: 'pending', waitReason: null, retryAt: null, result: null },
  });
  expect(readProcessingJob(fixture.handle, dead.jobId)).toMatchObject({
    state: 'pending',
    result: null,
    updatedAt: later(NOW, 2000),
  });
  expect(
    fixture.handle.read((view) => readProcessingJobReopenings(view, dead.jobId)).value
  ).toEqual([
    {
      reopeningId: expect.any(String),
      jobId: dead.jobId,
      reopeningSequence: 1,
      attemptsBefore: 1,
      attemptsAllowed: 2,
      gaveUp: { reason: 'input too large' },
      grantId: 'grant-1',
      reopenedAt: later(NOW, 2000),
      reopenedBy: 'owner@example.test',
      reopenedByBasis: 'authenticated',
    },
  ]);
  expect(fixture.snapshot().attempts).toEqual(before.attempts);
  expect(await reopening()).toMatchObject({ outcome: 'open' });
});

it('never reopens a completed job', async () => {
  const fixture = await project();
  const done = await fixture.capture();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 60 * 60 * 1000),
  });
  const generation = lease.ownerGeneration;
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  const configuration = processingAttemptConfiguration(fixture.handle, done.jobId);
  const started = await startProcessingAttempt(fixture.handle, {
    usageId: uuidv7(),
    maxCallsPerHour: 60,
    generation,
    jobId: done.jobId,
    attemptId: uuidv7(),
    startedAt: NOW,
    maxAttempts: 3,
    configurationIdentity: 'c'.repeat(64),
    configuration,
    confirmationId: configuration.permission.confirmation_id,
    grantId: 'grant-1',
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await settleProcessingCall(fixture.handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt: later(NOW, 900),
    result: { kind: 'unknown' },
  });
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: done.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1000),
    usage: null,
    outcome: { kind: 'succeeded', publishingOperationId: null, result: { records: 1 } },
  });
  const completed = readProcessingJob(fixture.handle, done.jobId)!;
  const before = fixture.snapshot();
  expect(
    await reopenProcessingJob(fixture.handle, {
      reopeningId: uuidv7(),
      jobId: done.jobId,
      expectedUpdatedAt: completed.updatedAt,
      expectedPreviousSequence: null,
      attemptsAllowed: 2,
      reopenedAt: later(NOW, 2000),
      reopenedBy: 'owner@example.test',
      reopenedByBasis: 'authenticated',
      grantId: 'grant-1',
    })
  ).toMatchObject({ outcome: 'finished', job: { state: 'completed' } });
  expect(fixture.snapshot()).toEqual(before);
});
