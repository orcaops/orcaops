import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { openProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { pauseProcessing } from './processing-control.js';
import { takeProcessingLease } from './processing-lease.js';
import {
  readGaveUpProcessingJobs,
  readProcessingBacklog,
  readProcessingJob,
  readProcessingJobAttempts,
  readProcessingQueue,
  readProcessingQueueAtBoundary,
} from './processing-reader.js';
import {
  claimProcessingJob,
  settleProcessingAttempt,
  startProcessingAttempt,
} from './processing-schedule.js';
import { settleProcessingCall } from './processing-usage.js';
import { PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { runProjectOperation } from './transactions.js';
import {
  capturePlan,
  discardKnowledgeStores,
  knowledgeStore,
} from '../../../tests/knowledge-store.js';
import {
  later,
  NOW,
  processingAttemptConfiguration,
  processingFixture,
  PROCESSOR_CONTRACT,
} from '../../../tests/processing-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const TERM = 7 * 24 * 60 * 60 * 1000;
const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  await discardKnowledgeStores();
});

function plan() {
  return {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [{ stepId: uuidv7(), criteria: [] }],
  };
}

const PROCESSING = {
  processorContract: PROCESSOR_CONTRACT,
  withoutModel: false,
  origin: { worktreeRoot: '/repo' },
};

it('reports an eligible capture whose atomic settlement omitted admission', async () => {
  const { handle } = await knowledgeStore();
  await capturePlan(handle, plan());
  const read = handle.read((view) =>
    readProcessingQueueAtBoundary(view, Number.MAX_SAFE_INTEGER)
  ).value;

  expect(read).toMatchObject({
    eligibleSources: 1,
    missingEligibleSources: 1,
    latestAdmittedSequence: null,
  });
  expect(read.latestEligibleSequence).not.toBeNull();
});

it('selects eligible and admitted sources through the requested boundary', async () => {
  const { handle } = await knowledgeStore();
  await capturePlan(handle, plan(), PROCESSING);
  const firstBoundary = handle.read(() => null).counters.writeSequence;
  await runProjectOperation(
    handle,
    {
      operationId: uuidv7(),
      kind: 'fixture.unrelated',
      target: null,
      payload: null,
      expectedState: null,
      intentChange: false,
    },
    () => null
  );
  const afterUnrelated = handle.read((view) =>
    readProcessingQueueAtBoundary(view, Number.MAX_SAFE_INTEGER)
  ).value;
  await capturePlan(handle, plan(), PROCESSING);
  const historical = handle.read((view) =>
    readProcessingQueueAtBoundary(view, firstBoundary)
  ).value;

  expect(afterUnrelated).toMatchObject({
    jobs: { pending: 1 },
    eligibleSources: 1,
    missingEligibleSources: 0,
    latestAdmittedSequence: firstBoundary,
    latestEligibleSequence: firstBoundary,
  });
  expect(historical).toMatchObject({
    jobs: { pending: 1 },
    eligibleSources: 1,
    missingEligibleSources: 0,
    latestAdmittedSequence: firstBoundary,
    latestEligibleSequence: firstBoundary,
  });
  expect(readProcessingQueue(handle)).toMatchObject({
    jobs: { pending: 2 },
    eligibleSources: 2,
    missingEligibleSources: 0,
  });
});
async function project() {
  const fixture = await processingFixture();
  fixtures.push(fixture);
  return fixture;
}
const HOUR = 60 * 60 * 1000;
const CONFIGURATION = 'c'.repeat(64);

it('reports an empty queue on a project that has admitted nothing', async () => {
  const fixture = await project();
  const reader = await fixture.open('reader');
  expect(readProcessingQueue(reader)).toMatchObject({
    jobs: { pending: 0, running: 0, completed: 0, retryable_failure: 0, terminal_failure: 0 },
    waiting: [],
    awaitingModelResume: 0,
    openAttempts: 0,
    latestAdmittedSequence: null,
    eligibleSources: 0,
    missingEligibleSources: 0,
    latestEligibleSequence: null,
    extraction: { sampledJobs: 0, omittedJobs: 0, settledUnits: 0, fields: [] },
  });
  expect(readProcessingBacklog(reader)).toEqual({
    paused_jobs: 0,
    latest_admitted_sequence: null,
  });
  expect(readProcessingJob(reader, uuidv7())).toBeNull();
  expect(readProcessingJobAttempts(reader, uuidv7())).toEqual([]);
});

it('counts jobs by state and wait reason and names the newest admitted sequence', async () => {
  const fixture = await project();
  const waiting = await fixture.capture();
  const blocked = await fixture.capture({ withoutModel: true });
  await fixture.capture();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, HOUR),
  });
  const generation = lease.ownerGeneration;
  const claim = await claimProcessingJob(fixture.handle, { generation, now: NOW });
  if (claim.outcome !== 'claimed') throw new Error('nothing was claimable');
  expect(claim.job.jobId).toBe(waiting.jobId);
  const configuration = processingAttemptConfiguration(fixture.handle, waiting.jobId, {
    model: 'original model',
  });
  const started = await startProcessingAttempt(fixture.handle, {
    usageId: uuidv7(),
    maxCallsPerHour: 60,
    generation,
    jobId: waiting.jobId,
    attemptId: uuidv7(),
    startedAt: NOW,
    maxAttempts: 3,
    configurationIdentity: CONFIGURATION,
    configuration,
    confirmationId: configuration.permission.confirmation_id,
    grantId: 'grant-1',
  });
  if (started.outcome !== 'started') throw new Error('the attempt did not start');
  expect(readProcessingQueue(fixture.handle)).toMatchObject({
    jobs: { pending: 2, running: 1, completed: 0 },
    openAttempts: 1,
    awaitingModelResume: 1,
  });
  await settleProcessingCall(fixture.handle, {
    generation,
    usageId: started.usage.usageId,
    settledAt: later(NOW, 900),
    result: { kind: 'unknown' },
  });
  await settleProcessingAttempt(fixture.handle, {
    generation,
    jobId: waiting.jobId,
    attemptId: started.attempt.attemptId,
    finishedAt: later(NOW, 1000),
    usage: null,
    outcome: {
      kind: 'retryable_failure',
      waitReason: 'provider_unavailable',
      retryAt: later(NOW, 60_000),
    },
  });
  const queue = readProcessingQueue(fixture.handle);
  expect(queue).toMatchObject({
    jobs: { pending: 2, running: 0, retryable_failure: 1 },
    openAttempts: 0,
    awaitingModelResume: 1,
    waiting: [{ waitReason: 'provider_unavailable', jobs: 1, nextRetryAt: later(NOW, 60_000) }],
  });
  expect(queue.latestAdmittedSequence).toBe(fixture.snapshot().writeSequence);
  expect(readProcessingBacklog(fixture.handle).paused_jobs).toBe(3);
  expect(readProcessingJob(fixture.handle, blocked.jobId)).toMatchObject({ withoutModel: true });
});

it('returns the newest attempts of a job with their configuration and grant', async () => {
  const fixture = await project();
  const capture = await fixture.capture();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, HOUR),
  });
  const generation = lease.ownerGeneration;
  for (const number of [1, 2, 3]) {
    await claimProcessingJob(fixture.handle, { generation, now: NOW });
    const configuration = processingAttemptConfiguration(
      fixture.handle,
      capture.jobId,
      { model: 'original model', attempt: number },
      'grant-1',
      { maxAttempts: 5, maxCallsPerHour: 60 }
    );
    const started = await startProcessingAttempt(fixture.handle, {
      usageId: uuidv7(),
      maxCallsPerHour: 60,
      generation,
      jobId: capture.jobId,
      attemptId: uuidv7(),
      startedAt: later(NOW, number * 1000),
      maxAttempts: 5,
      configurationIdentity: CONFIGURATION,
      configuration,
      confirmationId: configuration.permission.confirmation_id,
      grantId: 'grant-1',
    });
    if (started.outcome !== 'started') throw new Error('the attempt did not start');
    await settleProcessingCall(fixture.handle, {
      generation,
      usageId: started.usage.usageId,
      settledAt: later(NOW, number * 1000 + 400),
      result: { kind: 'unknown' },
    });
    await settleProcessingAttempt(fixture.handle, {
      generation,
      jobId: capture.jobId,
      attemptId: started.attempt.attemptId,
      finishedAt: later(NOW, number * 1000 + 500),
      usage: number === 1 ? null : { input_tokens: number },
      outcome: { kind: 'retryable_failure', waitReason: 'rate_limited', retryAt: NOW },
    });
  }
  const attempts = readProcessingJobAttempts(fixture.handle, capture.jobId, 2);
  expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([3, 2]);
  expect(attempts[0]).toMatchObject({
    outcome: 'failed',
    configurationIdentity: CONFIGURATION,
    configuration: { model: 'original model', attempt: 3 },
    grantId: 'grant-1',
    usage: { input_tokens: 3 },
  });
  expect(readProcessingJobAttempts(fixture.handle, capture.jobId)[2]).toMatchObject({
    attemptNumber: 1,
    usage: null,
  });
});

it('lists the jobs that gave up, newest first, with what their last attempt settled with', async () => {
  const fixture = await project();
  const captures = [await fixture.capture(), await fixture.capture(), await fixture.capture()];
  await fixture.capture();
  const { lease } = await takeProcessingLease(fixture.handle, {
    maxTermMs: TERM,
    ownerId: 'worker-a',
    now: NOW,
    expiresAt: later(NOW, HOUR),
  });
  const generation = lease.ownerGeneration;
  for (const [index, capture] of captures.entries()) {
    const at = later(NOW, (index + 1) * 1000);
    await claimProcessingJob(fixture.handle, { generation, now: at });
    const configuration = processingAttemptConfiguration(fixture.handle, capture.jobId);
    const started = await startProcessingAttempt(fixture.handle, {
      usageId: uuidv7(),
      maxCallsPerHour: 60,
      generation,
      jobId: capture.jobId,
      attemptId: uuidv7(),
      startedAt: at,
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
      settledAt: later(at, 400),
      result: { kind: 'unknown' },
    });
    await settleProcessingAttempt(fixture.handle, {
      generation,
      jobId: capture.jobId,
      attemptId: started.attempt.attemptId,
      finishedAt: later(at, 500),
      usage: null,
      outcome: {
        kind: 'terminal_failure',
        result: { call: { code: 'INPUT_TOO_LARGE' } },
        detail: { call: { code: 'INPUT_TOO_LARGE', message: `capture ${index}` } },
      },
    });
  }

  const gaveUp = readGaveUpProcessingJobs(fixture.handle, 2);
  expect(gaveUp.total).toBe(3);
  expect(gaveUp.jobs.map((entry) => entry.job.jobId)).toEqual([
    captures[2]!.jobId,
    captures[1]!.jobId,
  ]);
  expect(gaveUp.jobs[0]).toMatchObject({
    job: { state: 'terminal_failure', result: { call: { code: 'INPUT_TOO_LARGE' } } },
    lastAttemptDetail: { call: { code: 'INPUT_TOO_LARGE', message: 'capture 2' } },
  });
  expect(readGaveUpProcessingJobs(fixture.handle).jobs).toHaveLength(3);
});

it('reads through a read-only connection and starts nothing', async () => {
  const fixture = await project();
  await fixture.capture();
  await pauseProcessing(fixture.handle, {
    changedAt: NOW,
    changedBy: 'owner@example.test',
    changedByBasis: 'authenticated',
    reason: 'holding the queue',
  });
  const reader = await fixture.open('reader');
  const before = fixture.snapshot();
  expect(readProcessingQueue(reader).jobs.pending).toBe(1);
  expect(readProcessingBacklog(reader).paused_jobs).toBe(1);
  expect(fixture.snapshot()).toEqual(before);
});

it('refuses to open a store this build does not support, so no reader runs against one', async () => {
  const fixture = await project();
  await fixture.capture();
  const driver = fixture.driver();
  driver.pragma('user_version = 29');
  driver.close();
  const refusal = await openProjectDatabase({ authority: fixture.authority, mode: 'reader' }).then(
    (handle) => {
      handle.close();
      return null;
    },
    (cause: unknown) => cause
  );
  expect(refusal).toBeInstanceOf(ProjectDatabaseError);
  const restored = new Database(fixture.databasePath);
  restored.pragma(`user_version = ${PROJECT_DATABASE_SCHEMA_VERSION}`);
  restored.close();
  expect(readProcessingBacklog(fixture.handle).paused_jobs).toBe(1);
});

it('refuses a reader that does not name an original job identity', async () => {
  const fixture = await project();
  expect(() => readProcessingJob(fixture.handle, 'not-a-uuid')).toThrowError(/original/);
  expect(() => readProcessingJobAttempts(fixture.handle, uuidv7(), 0)).toThrowError(/whole number/);
});
