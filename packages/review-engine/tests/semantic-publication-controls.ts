import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import {
  publishDatabaseSemanticGeneration,
  type PublishDatabaseSemanticGeneration,
} from '../src/database/semantic-publish.js';
import { readDatabaseSemanticGeneration } from '../src/database/semantic-read.js';

export async function exerciseSemanticPublication(input: {
  authority: store.ProjectDatabaseAuthority;
  reviewId: string;
  runId: string;
  expected: PublishDatabaseSemanticGeneration['expected'];
  submissionBytes: Uint8Array;
  inputFile: string;
}) {
  const request: PublishDatabaseSemanticGeneration = {
    authority: input.authority,
    reviewId: input.reviewId,
    runId: input.runId,
    operationId: uuidv7(),
    generationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
    expected: input.expected,
    authored: {
      startedAt: '2026-06-01T00:06:00.000Z',
      submittedAt: '2026-06-01T00:06:01.000Z',
      runtimeIdentity: null,
      profile: 'semantic-anchor-profile-v1',
    },
    attempt: { kind: 'initial' },
    submissionBytes: input.submissionBytes,
    secretAllow: [],
  };
  const read = { authority: input.authority, reviewId: input.reviewId, runId: input.runId };
  vi.mocked(store.openProjectDatabase).mockClear();
  await expect(
    publishDatabaseSemanticGeneration({
      ...request,
      submissionBytes: Buffer.from('{"x":"' + 'ghp_' + 'a'.repeat(36) + '","x":null}'),
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const canceled = publishDatabaseSemanticGeneration(request, options);
  options.signal = new AbortController().signal;
  controller.abort();
  await expect(canceled).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(
    (await readDatabaseSemanticGeneration({ ...read, generationId: request.generationId })).value
  ).toBeNull();

  const before = (await readDatabaseSemanticGeneration(read)).counters;
  const mutable = { ...request, submissionBytes: new Uint8Array(input.submissionBytes) };
  const publishing = publishDatabaseSemanticGeneration(mutable);
  mutable.submissionBytes.fill(32);
  mutable.expected = { ...request.expected, version: 999 };
  const accepted = await publishing;
  expect(accepted.replayed).toBe(false);
  expect(accepted.value).toMatchObject({
    accepted: true,
    status: 'VALID',
    currentVersion: input.expected.semanticVersion + 1,
  });
  expect(accepted.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const retained = (await readDatabaseSemanticGeneration(read)).value!;
  expect(retained.generationId).toBe(request.generationId);
  expect(retained.attempts[0]!.event.raw_submission_sha256).toBe(
    createHash('sha256').update(input.submissionBytes).digest('hex')
  );
  expect(retained.model!.value.items.some((item) => item.disposition === 'ANCHORED')).toBe(true);
  const inspect = await store.openProjectDatabase({ authority: input.authority, mode: 'reader' });
  const payload = inspect.read((view) =>
    view.get<{ payload_json: string }>(
      'SELECT payload_json FROM operations WHERE operation_id=?',
      request.operationId
    )
  ).value!;
  inspect.close();
  expect(Object.keys(JSON.parse(payload.payload_json)).sort()).toEqual([
    'attempt',
    'attemptRevisionId',
    'authored',
    'modelPublicationId',
    'rawSubmissionSha256',
  ]);
  const modelFile = path.join(
    path.dirname(store.projectDatabasePath(input.authority)),
    'evidence',
    request.modelPublicationId!,
    'semantic-anchor-model-v3.json'
  );
  const modelBytes = await readFile(modelFile);
  const inputBytes = await readFile(input.inputFile);
  try {
    await rm(modelFile);
    await rm(input.inputFile);
    vi.mocked(store.readProjectEvidence).mockClear();
    vi.mocked(store.publishProjectEvidence).mockClear();
    expect(await publishDatabaseSemanticGeneration(request)).toEqual({
      ...accepted,
      replayed: true,
    });
    expect(store.readProjectEvidence).not.toHaveBeenCalled();
    expect(store.publishProjectEvidence).not.toHaveBeenCalled();
    await expect(
      publishDatabaseSemanticGeneration({ ...request, submissionBytes: Buffer.from('{}') })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(readFile(modelFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await writeFile(modelFile, modelBytes);
    await writeFile(input.inputFile, inputBytes);
  }
  const rejected: PublishDatabaseSemanticGeneration = {
    ...request,
    operationId: uuidv7(),
    generationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: null,
    expected: {
      ...request.expected,
      semanticGenerationId: request.generationId,
      semanticVersion: accepted.value.currentVersion,
    },
    submissionBytes: Buffer.from('{invalid'),
  };
  const pending = await publishDatabaseSemanticGeneration(rejected);
  expect(pending.value).toMatchObject({
    accepted: false,
    status: 'PENDING',
    currentGenerationId: request.generationId,
  });
  const rejectedRead = (
    await readDatabaseSemanticGeneration({ ...read, generationId: rejected.generationId })
  ).value!;
  expect(rejectedRead.terminal).toBeNull();
  expect(rejectedRead.attempts[0]!.event.normalization).toBe('INVALID_JSON');
  const repair: PublishDatabaseSemanticGeneration = {
    ...rejected,
    operationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
    submissionBytes: input.submissionBytes,
    authored: {
      ...request.authored,
      startedAt: '2026-06-01T00:06:02.000Z',
      submittedAt: '2026-06-01T00:06:03.000Z',
    },
    attempt: {
      kind: 'repair',
      firstRevisionId: rejected.attemptRevisionId,
      firstRecordSha256: rejectedRead.attempts[0]!.hash,
    },
  };
  vi.mocked(store.openProjectDatabase).mockClear();
  await expect(
    publishDatabaseSemanticGeneration({
      ...repair,
      attempt: {
        kind: 'repair',
        firstRevisionId: rejected.attemptRevisionId,
        firstRecordSha256: '0'.repeat(64),
      },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([value]) => value.mode === 'reader')
  ).toBe(true);
  const repaired = await publishDatabaseSemanticGeneration(repair);
  expect(repaired.value).toMatchObject({
    accepted: true,
    status: 'VALID',
    attemptNumber: 2,
    currentGenerationId: repair.generationId,
  });
  const repairRead = (await readDatabaseSemanticGeneration(read)).value!;
  expect(repairRead.attempts).toHaveLength(2);
  expect(repairRead.terminal!.manifest.final_attempt_outcome).toBe('ACCEPTED_REPAIRED');
  expect(repairRead.terminal!.manifest.lifecycle_started_at).toBe(request.authored.startedAt);
  expect((await publishDatabaseSemanticGeneration(rejected)).replayed).toBe(true);
  expect((await readDatabaseSemanticGeneration(read)).value!.generationId).toBe(
    repair.generationId
  );

  const terminalRejected = {
    ...rejected,
    operationId: uuidv7(),
    generationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    expected: {
      ...repair.expected,
      semanticGenerationId: repair.generationId,
      semanticVersion: repaired.value.currentVersion,
    },
  };
  const first = await publishDatabaseSemanticGeneration(terminalRejected);
  const finalRejected = await publishDatabaseSemanticGeneration({
    ...terminalRejected,
    operationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    authored: repair.authored,
    attempt: {
      kind: 'repair',
      firstRevisionId: terminalRejected.attemptRevisionId,
      firstRecordSha256: first.value.attemptSha256,
    },
  });
  expect(finalRejected.value).toMatchObject({
    status: 'REJECTED',
    accepted: false,
    modelPublicationId: null,
    currentGenerationId: repair.generationId,
  });
  expect(
    (await readDatabaseSemanticGeneration({ ...read, generationId: terminalRejected.generationId }))
      .value!.terminal!.manifest.status
  ).toBe('REJECTED');
  const stale = {
    ...request,
    operationId: uuidv7(),
    generationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
  };
  await expect(publishDatabaseSemanticGeneration(stale)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  await expect(
    publishDatabaseSemanticGeneration({
      ...stale,
      expected: { ...terminalRejected.expected, version: 999 },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });

  const contender = {
    ...request,
    operationId: uuidv7(),
    generationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
    expected: terminalRejected.expected,
  };
  const winner = {
    ...contender,
    operationId: uuidv7(),
    generationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
  };
  const realPublish = (await vi.importActual<typeof store>('@orcaops/storage/history/database'))
    .publishProjectEvidence;
  vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (...args) => {
    const effects = await realPublish(...args);
    await publishDatabaseSemanticGeneration(winner);
    return effects;
  });
  await expect(publishDatabaseSemanticGeneration(contender)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect((await readDatabaseSemanticGeneration(read)).value!.generationId).toBe(
    winner.generationId
  );
  expect(
    (await readDatabaseSemanticGeneration({ ...read, generationId: contender.generationId })).value
  ).toBeNull();
  const unused = path.join(
    path.dirname(store.projectDatabasePath(input.authority)),
    'evidence',
    contender.modelPublicationId!,
    'semantic-anchor-model-v3.json'
  );
  expect((await readFile(unused)).length).toBeGreaterThan(0);
  const selectedWinner = (await readDatabaseSemanticGeneration(read)).value!;
  const transactional = {
    ...winner,
    operationId: uuidv7(),
    generationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
    expected: {
      ...winner.expected,
      semanticGenerationId: winner.generationId,
      semanticVersion: selectedWinner.current!.version,
    },
  };
  const Driver = createRequire(new URL('../../storage/package.json', import.meta.url))(
    'better-sqlite3'
  );
  const driver = new Driver(store.projectDatabasePath(input.authority));
  const countReceipt = (id: string) =>
    driver.prepare('SELECT count(*) AS count FROM operations WHERE operation_id=?').get(id).count;
  const counters = (await readDatabaseSemanticGeneration(read)).counters;
  try {
    driver.exec(
      "CREATE TRIGGER refuse_semantic_selection BEFORE UPDATE ON review_semantic_current BEGIN SELECT RAISE(ABORT,'qualification selection refusal'); END"
    );
    await expect(publishDatabaseSemanticGeneration(transactional)).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      reason: 'constraint',
    });
    expect(countReceipt(transactional.operationId)).toBe(0);
    expect(
      driver
        .prepare('SELECT count(*) AS count FROM review_semantic_generations WHERE generation_id=?')
        .get(transactional.generationId).count
    ).toBe(0);
    expect(
      driver
        .prepare('SELECT count(*) AS count FROM review_semantic_attempts WHERE generation_id=?')
        .get(transactional.generationId).count
    ).toBe(0);
    expect((await readDatabaseSemanticGeneration(read)).counters).toEqual(counters);
    driver.exec('DROP TRIGGER refuse_semantic_selection');
    const retried = await publishDatabaseSemanticGeneration(transactional);
    expect(retried.replayed).toBe(false);
    expect(retried.counters.writeSequence).toBe(counters.writeSequence + 1);
    expect(countReceipt(transactional.operationId)).toBe(1);
    const concurrent = {
      ...transactional,
      operationId: uuidv7(),
      generationId: uuidv7(),
      attemptRevisionId: uuidv7(),
      modelPublicationId: uuidv7(),
      expected: {
        ...transactional.expected,
        semanticGenerationId: transactional.generationId,
        semanticVersion: retried.value.currentVersion,
      },
    };
    const both = await Promise.all([
      publishDatabaseSemanticGeneration(concurrent),
      publishDatabaseSemanticGeneration(concurrent),
    ]);
    expect(both.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(both[0]!.value).toEqual(both[1]!.value);
    expect(both[0]!.counters).toEqual(both[1]!.counters);
    expect(countReceipt(concurrent.operationId)).toBe(1);
    const canceledController = new AbortController();
    const canceledAfterEvidence = {
      ...concurrent,
      operationId: uuidv7(),
      generationId: uuidv7(),
      attemptRevisionId: uuidv7(),
      modelPublicationId: uuidv7(),
      expected: {
        ...concurrent.expected,
        semanticGenerationId: concurrent.generationId,
        semanticVersion: both[0]!.value.currentVersion,
      },
    };
    vi.mocked(store.publishProjectEvidence).mockImplementationOnce(async (...args) => {
      const effects = await realPublish(...args);
      canceledController.abort();
      return effects;
    });
    await expect(
      publishDatabaseSemanticGeneration(canceledAfterEvidence, {
        signal: canceledController.signal,
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(countReceipt(canceledAfterEvidence.operationId)).toBe(0);
    expect((await readDatabaseSemanticGeneration(read)).value!.generationId).toBe(
      concurrent.generationId
    );
  } finally {
    driver.exec('DROP TRIGGER IF EXISTS refuse_semantic_selection');
    driver.close();
  }
  return { request, accepted };
}
