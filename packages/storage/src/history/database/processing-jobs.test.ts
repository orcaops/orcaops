import { afterEach, expect, it } from 'vitest';

import { readProcessingBacklog, readProcessingJob } from './processing-reader.js';
import { processingFixture, PROCESSOR_CONTRACT } from '../../../tests/processing-fixture.js';
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

it('admits a job in the transaction that publishes its source', async () => {
  const fixture = await project();
  const before = fixture.snapshot();
  const capture = await fixture.capture();
  expect(capture.admission.outcome).toBe('admitted');
  const job = readProcessingJob(fixture.handle, capture.jobId)!;
  expect(job).toMatchObject({
    source: { kind: 'capture_event', event_id: capture.eventId },
    processorContract: PROCESSOR_CONTRACT,
    admittingOperationId: capture.operationId,
    state: 'pending',
    withoutModel: false,
    modelResume: null,
  });
  expect(job.admission).toMatchObject({
    path: 'live_capture_settlement',
    origin_kind: 'captured',
    derived_by_processing: false,
  });
  const after = fixture.snapshot();
  // The admitting operation's own receipt and write sequence are the job's; admission adds none.
  expect(after.operations.length).toBe(before.operations.length + 1);
  expect(after.writeSequence).toBe(before.writeSequence + 1);
});

it('reports the admitted sequence as the publishing operation write sequence', async () => {
  const fixture = await project();
  const first = await fixture.capture();
  const firstSequence = fixture.snapshot().writeSequence;
  expect(readProcessingBacklog(fixture.handle)).toEqual({
    paused_jobs: 1,
    latest_admitted_sequence: firstSequence,
  });
  await fixture.capture();
  expect(readProcessingBacklog(fixture.handle)).toEqual({
    paused_jobs: 2,
    latest_admitted_sequence: fixture.snapshot().writeSequence,
  });
  expect(readProcessingJob(fixture.handle, first.jobId)!.admittingOperationId).toBe(
    first.operationId
  );
});

it('rolls the job back with the source when the publishing transaction refuses', async () => {
  const fixture = await project();
  const before = fixture.snapshot();
  const jobId = uuidv7();
  await expect(fixture.capture({ jobId, refuseAfterSettlement: true })).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
  });
  expect(fixture.snapshot()).toEqual(before);
  expect(readProcessingJob(fixture.handle, jobId)).toBeNull();
  const recovered = await fixture.capture();
  expect(recovered.admission.outcome).toBe('admitted');
});

it('admits nothing on a replay of the same source and contract and reports the standing job', async () => {
  const fixture = await project();
  const first = await fixture.capture();
  const before = fixture.snapshot();
  const replay = await fixture.capture({ sourceEventId: first.eventId });
  expect(replay.admission).toMatchObject({
    outcome: 'already_admitted',
    job: { jobId: first.jobId, admittingOperationId: first.operationId },
  });
  expect(fixture.snapshot().jobs).toEqual(before.jobs);
  expect(readProcessingBacklog(fixture.handle).paused_jobs).toBe(1);
});

it('admits a second job for the same source under a different processor contract', async () => {
  const fixture = await project();
  const first = await fixture.capture();
  const other = await fixture.capture({
    sourceEventId: first.eventId,
    processorContract: 'knowledge-relationships@1',
  });
  expect(other.admission.outcome).toBe('admitted');
  expect(readProcessingBacklog(fixture.handle).paused_jobs).toBe(2);
});

it('admits nothing for an imported artifact, an ineligible event type or derived output', async () => {
  const fixture = await project();
  const before = fixture.snapshot();
  for (const input of [
    { originKind: 'git-import' as const },
    { settledEventTypes: ['checkpoint_opened'] as const },
    { derivedByProcessing: true },
    { path: 'seed_import' as const },
    { path: 'legacy_conversion' as const },
    { path: 'restore' as const },
    { path: 'replay' as const },
    { path: 'synced_knowledge_record' as const },
  ]) {
    const capture = await fixture.capture(input);
    expect(capture.admission).toEqual({ outcome: 'not_eligible' });
  }
  expect(fixture.snapshot().jobs).toEqual(before.jobs);
  expect(readProcessingBacklog(fixture.handle)).toEqual({
    paused_jobs: 0,
    latest_admitted_sequence: null,
  });
});

it('admits a new live knowledge input, a reviewer comment and an observation', async () => {
  const fixture = await project();
  for (const path of [
    'live_knowledge_input',
    'live_review_feedback',
    'live_observation',
  ] as const) {
    const capture = await fixture.capture({ path, settledEventTypes: [] });
    expect(capture.admission.outcome).toBe('admitted');
  }
  expect(readProcessingBacklog(fixture.handle).paused_jobs).toBe(3);
});

it("keeps the invocation's no-model choice with the job", async () => {
  const fixture = await project();
  const capture = await fixture.capture({ withoutModel: true });
  expect(readProcessingJob(fixture.handle, capture.jobId)).toMatchObject({
    withoutModel: true,
    modelResume: null,
  });
});

it('refuses a job identity that already belongs to retained history', async () => {
  const fixture = await project();
  const first = await fixture.capture();
  const before = fixture.snapshot();
  await expect(fixture.capture({ jobId: first.jobId })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(fixture.snapshot()).toEqual(before);
});

it('refuses admission input that does not name an exact source, origin or time', async () => {
  const fixture = await project();
  for (const input of [
    { jobId: 'not-a-uuid' },
    { originKind: 'imported' as unknown as 'captured' },
    { settledEventTypes: ['not_an_event'] as unknown as ['plan_captured'] },
    { admittedAt: '2026-09-01' },
    { processorContract: ' ' },
  ])
    await expect(fixture.capture(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fixture.snapshot().jobs).toEqual([]);
});
