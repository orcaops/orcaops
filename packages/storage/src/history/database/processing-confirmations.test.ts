import { afterEach, expect, it } from 'vitest';

import {
  readLatestProcessingModelConfirmation,
  readProcessingModelConfirmation,
  readProcessingModelConfirmationHistory,
  recordProcessingModelConfirmation,
} from './processing-confirmations.js';
import { takeProcessingLease } from './processing-lease.js';
import { claimProcessingJob, startProcessingAttempt } from './processing-schedule.js';
import {
  later,
  NOW,
  processingAttemptConfiguration,
  processingAttemptPermission,
  processingFixture,
} from '../../../tests/processing-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function project() {
  const fixture = await processingFixture();
  fixtures.push(fixture);
  return fixture;
}

it('appends confirmations while retaining the first audit marker and no operation receipt', async () => {
  const fixture = await project();
  const capture = await fixture.capture({ withoutModel: true });
  const before = fixture.snapshot();
  const first = await fixture.confirm(capture.jobId, NOW);
  const second = await fixture.confirm(capture.jobId, later(NOW, 1000));

  expect(first.confirmationSequence).toBe(1);
  expect(second.confirmationSequence).toBe(2);
  expect(
    fixture.handle.read((view) => readProcessingModelConfirmation(view, first.confirmationId)).value
  ).toEqual(first);
  expect(
    fixture.handle.read((view) => readLatestProcessingModelConfirmation(view, capture.jobId)).value
  ).toEqual(second);
  expect(
    fixture.handle.read((view) => readProcessingModelConfirmationHistory(view, capture.jobId)).value
  ).toEqual([first, second]);
  const after = fixture.snapshot();
  expect(after.operations).toEqual(before.operations);
  expect(after.writeSequence).toBe(before.writeSequence);
  expect(after.intentChangeCounter).toBe(before.intentChangeCounter);
  expect(after.jobs[0]).toMatchObject({
    model_resumed_at: NOW,
    model_resume_grant_id: 'grant-1',
  });
});

it('refuses stale sequences, mismatched sources and jobs admitted with a model', async () => {
  const fixture = await project();
  const held = await fixture.capture({ withoutModel: true });
  const enabled = await fixture.capture();
  const first = await fixture.confirm(held.jobId, NOW);
  const terms = processingAttemptPermission(fixture.handle, held.jobId).execution_terms;

  await expect(
    recordProcessingModelConfirmation(fixture.handle, {
      confirmationId: uuidv7(),
      jobId: held.jobId,
      expectedPreviousSequence: null,
      confirmedAt: later(NOW, 1000),
      confirmedBy: 'owner@example.test',
      confirmedByBasis: 'authenticated',
      grantId: 'grant-2',
      terms,
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await expect(
    recordProcessingModelConfirmation(fixture.handle, {
      confirmationId: uuidv7(),
      jobId: held.jobId,
      expectedPreviousSequence: first.confirmationSequence,
      confirmedAt: later(NOW, 1000),
      confirmedBy: 'owner@example.test',
      confirmedByBasis: 'authenticated',
      grantId: 'grant-2',
      terms: { ...terms, source: { kind: 'capture_event', event_id: enabled.eventId } },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    recordProcessingModelConfirmation(fixture.handle, {
      confirmationId: uuidv7(),
      jobId: held.jobId,
      expectedPreviousSequence: first.confirmationSequence,
      confirmedAt: later(NOW, 1000),
      confirmedBy: 'owner@example.test',
      confirmedByBasis: 'authenticated',
      grantId: 'grant-2',
      terms: { ...terms, origin: { worktree_root: '/another-origin' } },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    recordProcessingModelConfirmation(fixture.handle, {
      confirmationId: uuidv7(),
      jobId: enabled.jobId,
      expectedPreviousSequence: null,
      confirmedAt: NOW,
      confirmedBy: 'owner@example.test',
      confirmedByBasis: 'authenticated',
      grantId: 'grant-1',
      terms: processingAttemptPermission(fixture.handle, enabled.jobId).execution_terms,
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('requires the latest confirmation and retains its exact terms on the attempt', async () => {
  const fixture = await project();
  const capture = await fixture.capture({ withoutModel: true });
  const first = await fixture.confirm(capture.jobId, NOW);
  const second = await fixture.confirm(capture.jobId, later(NOW, 1000));
  const lease = await takeProcessingLease(fixture.handle, {
    ownerId: 'worker-a',
    now: later(NOW, 2000),
    expiresAt: later(NOW, 60_000),
    maxTermMs: 60_000,
  });
  const generation = lease.lease.ownerGeneration;
  await claimProcessingJob(fixture.handle, { generation, now: later(NOW, 2000) });
  const configuration = processingAttemptConfiguration(fixture.handle, capture.jobId);

  await expect(
    startProcessingAttempt(fixture.handle, {
      generation,
      jobId: capture.jobId,
      attemptId: uuidv7(),
      usageId: null,
      startedAt: later(NOW, 2000),
      maxAttempts: 3,
      configurationIdentity: 'c'.repeat(64),
      configuration: {
        ...configuration,
        permission: {
          ...configuration.permission,
          confirmation_id: first.confirmationId,
          confirmed_terms: first.terms,
        },
      },
      confirmationId: first.confirmationId,
      grantId: 'grant-1',
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });

  const started = await startProcessingAttempt(fixture.handle, {
    generation,
    jobId: capture.jobId,
    attemptId: uuidv7(),
    usageId: null,
    startedAt: later(NOW, 2000),
    maxAttempts: 3,
    configurationIdentity: 'c'.repeat(64),
    configuration,
    confirmationId: second.confirmationId,
    grantId: 'grant-1',
  });
  expect(started).toMatchObject({
    outcome: 'started_without_call',
    attempt: {
      configuration: {
        permission: {
          confirmation_id: second.confirmationId,
          confirmed_terms: second.terms,
        },
      },
    },
  });
  await expect(
    recordProcessingModelConfirmation(fixture.handle, {
      confirmationId: uuidv7(),
      jobId: capture.jobId,
      expectedPreviousSequence: second.confirmationSequence,
      confirmedAt: later(NOW, 3000),
      confirmedBy: 'owner@example.test',
      confirmedByBasis: 'authenticated',
      grantId: 'grant-2',
      terms: second.terms,
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});

it('prevents replacement, update and deletion of retained confirmations', async () => {
  const fixture = await project();
  const capture = await fixture.capture({ withoutModel: true });
  const confirmation = await fixture.confirm(capture.jobId, NOW);
  const driver = fixture.driver();
  try {
    expect(() =>
      driver
        .prepare('UPDATE processing_model_confirmations SET grant_id=? WHERE confirmation_id=?')
        .run('another-grant', confirmation.confirmationId)
    ).toThrow(/append-only/);
    expect(() =>
      driver
        .prepare('DELETE FROM processing_model_confirmations WHERE confirmation_id=?')
        .run(confirmation.confirmationId)
    ).toThrow(/retained/);
    expect(() =>
      driver
        .prepare(
          `INSERT OR REPLACE INTO processing_model_confirmations
            (confirmation_id,job_id,confirmation_sequence,confirmed_at,confirmed_by,
              confirmed_by_basis,grant_id,terms_json) VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          uuidv7(),
          capture.jobId,
          1,
          NOW,
          'owner@example.test',
          'authenticated',
          'grant-2',
          JSON.stringify(confirmation.terms)
        )
    ).toThrow(/cannot be replaced/);
  } finally {
    driver.close();
  }
});
