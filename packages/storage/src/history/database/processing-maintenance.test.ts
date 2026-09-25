import { afterEach, expect, it } from 'vitest';

import { pauseProcessing, resumeProcessing } from './processing-control.js';
import {
  releaseProcessingLease,
  renewProcessingLease,
  takeProcessingLease,
} from './processing-lease.js';
import { type ProcessingMaintenance, runProcessingMaintenance } from './processing-maintenance.js';
import { readProcessingJob } from './processing-reader.js';
import {
  claimProcessingJob,
  recoverProcessingAttempts,
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
const HOUR = 60 * 60 * 1000;
const CONFIGURATION = 'c'.repeat(64);

it('writes no operation receipt and moves neither counter for any scheduling write', async () => {
  const fixture = await project();
  const blocked = await fixture.capture({ withoutModel: true });
  await fixture.capture();
  const untouched = await fixture.capture();
  const before = fixture.snapshot();

  const taken = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, 1000),
  });
  const generation = taken.lease.ownerGeneration;
  await renewProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    generation,
    now: NOW,
    expiresAt: later(NOW, 1000),
  });
  await pauseProcessing(fixture.handle, {
    changedAt: NOW,
    changedBy: 'owner@example.test',
    changedByBasis: 'authenticated',
    reason: 'holding the queue',
  });
  await claimProcessingJob(fixture.handle, { generation, now: NOW });
  await resumeProcessing(fixture.handle, {
    changedAt: NOW,
    changedBy: 'owner@example.test',
    changedByBasis: 'authenticated',
  });
  await fixture.confirm(blocked.jobId, NOW);
  const claim = await claimProcessingJob(fixture.handle, { generation, now: NOW });
  if (claim.outcome !== 'claimed') throw new Error('nothing was claimable');
  const configuration = processingAttemptConfiguration(fixture.handle, claim.job.jobId);
  const started = await startProcessingAttempt(fixture.handle, {
    usageId: uuidv7(),
    maxCallsPerHour: 60,
    generation,
    jobId: claim.job.jobId,
    attemptId: uuidv7(),
    startedAt: NOW,
    maxAttempts: 3,
    configurationIdentity: CONFIGURATION,
    configuration,
    confirmationId: configuration.permission.confirmation_id,
    grantId: 'grant-1',
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  await settleProcessingCall(fixture.handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt: NOW,
    result: { kind: 'reported', costUsd: 0.02, usage: { input_tokens: 5 } },
  });
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: claim.job.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: NOW,
    usage: { input_tokens: 5 },
    outcome: { kind: 'succeeded', publishingOperationId: null, result: { records: 1 } },
  });
  const takeover = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-b',
    now: later(NOW, 1000),
    expiresAt: later(NOW, HOUR),
  });
  const replacement = takeover.lease.ownerGeneration;
  const lostClaim = await claimProcessingJob(fixture.handle, {
    generation: replacement,
    now: later(NOW, 1000),
  });
  if (lostClaim.outcome !== 'claimed') throw new Error('nothing was claimable');
  const lostConfiguration = processingAttemptConfiguration(fixture.handle, lostClaim.job.jobId);
  await startProcessingAttempt(fixture.handle, {
    usageId: uuidv7(),
    maxCallsPerHour: 60,
    generation: replacement,
    jobId: lostClaim.job.jobId,
    attemptId: uuidv7(),
    startedAt: later(NOW, 1000),
    maxAttempts: 3,
    configurationIdentity: CONFIGURATION,
    configuration: lostConfiguration,
    confirmationId: lostConfiguration.permission.confirmation_id,
    grantId: 'grant-1',
  });
  const third = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-c',
    now: later(NOW, HOUR),
    expiresAt: later(NOW, 2 * HOUR),
  });
  await recoverProcessingAttempts(fixture.handle, {
    generation: third.lease.ownerGeneration,
    now: later(NOW, 2 * HOUR),
    callLifetimeMs: 120_000,
    waitReason: 'owner_lost',
    retryAt: later(NOW, 2 * HOUR),
  });
  await releaseProcessingLease(fixture.handle, {
    ownerId: 'worker-c',
    generation: third.lease.ownerGeneration,
  });

  const after = fixture.snapshot();
  expect(after.operations).toEqual(before.operations);
  expect(after.writeSequence).toBe(before.writeSequence);
  expect(after.intentChangeCounter).toBe(before.intentChangeCounter);
  // The scheduling rows did move; only the counters and receipts stood still.
  expect(after.jobs).not.toEqual(before.jobs);
  expect(after.attempts).toHaveLength(2);
  // One hold per attempt: an attempt and the call it pays for begin together.
  expect(after.usage).toHaveLength(2);
  expect(readProcessingJob(fixture.handle, untouched.jobId)!.state).toBe('pending');
});

it('refuses a maintenance write that targets anything but a scheduling row', async () => {
  const fixture = await project();
  const before = fixture.snapshot();
  const refuse = (write: (transaction: ProcessingMaintenance) => unknown) =>
    expect(
      runProcessingMaintenance(fixture.handle, 'processing.fixture', write)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await refuse((transaction) =>
    transaction.run('UPDATE project_counters SET write_sequence=99 WHERE singleton=1')
  );
  await refuse((transaction) =>
    transaction.run(
      "INSERT INTO operations VALUES (?,'x',1,'{}','{}','a','{}','null',1,1)",
      uuidv7()
    )
  );
  await refuse((transaction) => transaction.run('DELETE FROM processing_jobs'));
  await refuse((transaction) => transaction.run('SELECT 1 FROM processing_jobs'));
  expect(fixture.snapshot()).toEqual(before);
});

it('refuses an unbounded maintenance name and a write after the transaction ended', async () => {
  const fixture = await project();
  await expect(
    runProcessingMaintenance(fixture.handle, 'Processing Fixture', () => null)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  let escaped: ProcessingMaintenance | undefined;
  await runProcessingMaintenance(fixture.handle, 'processing.fixture', (transaction) => {
    escaped = transaction;
    return null;
  });
  expect(() =>
    escaped!.run('UPDATE processing_control SET paused=1 WHERE singleton=1')
  ).toThrowError(/transaction ended/);
});

it('cancels a scheduling write before it starts', async () => {
  const fixture = await project();
  const before = fixture.snapshot();
  const controller = new AbortController();
  controller.abort();
  await expect(
    takeProcessingLease(
      fixture.handle,
      { maxTermMs: TERM, ownerId: 'worker-a', now: NOW, expiresAt: later(NOW, HOUR) },
      { signal: controller.signal }
    )
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(fixture.snapshot()).toEqual(before);
});
