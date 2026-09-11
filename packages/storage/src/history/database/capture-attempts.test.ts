import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest, recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  appendProjectArtifactEvents,
  prepareArtifactAppend,
  prepareArtifactAppendRequest,
  readProjectArtifact,
} from './artifacts.js';
import {
  prepareArtifactAttemptSettlement,
  publishProjectArtifactAttempt,
  readProjectArtifactAttemptRevision,
  readProjectArtifactAttempts,
  settleProjectArtifactAttemptChanges,
} from './capture-attempts.js';
import {
  type ArtifactAttemptInput,
  artifactAttemptPreparation,
  prepareAuthoredArtifactAttempt,
  prepareHistoricalArtifactAttempt,
} from './capture-operation-input.js';
import { captureOperation } from './capture-records.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { runProjectOperation } from './transactions.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const refusal = { secretAllow: [] };
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'capture-attempt-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const file = projectDatabasePath(authority);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(handle);
  const data = JSON.parse(
    await readFile(new URL('./fixtures/execution-history.json', import.meta.url), 'utf8')
  );
  const { checksum: _checksum, ...record } = JSON.parse(
    Buffer.from(data.rows.artifact_events[0].record_bytes.blobHex, 'hex').toString()
  );
  const artifactId = uuidv7();
  record.event_id = uuidv7();
  record.idempotency_key = uuidv7();
  record.payload.artifact_id = artifactId;
  await appendProjectArtifactEvents(handle, {
    artifactId,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(
      ' ' + JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n'
    ),
    sidecarPayloads: [],
    secretAllow: [],
  });
  return { handle, authority, file, artifactId, record };
}
function attempt(
  handle: ProjectDatabase,
  artifactId: string,
  outcome: 'soft_blocked' | 'hard_rejected' = 'soft_blocked'
): Extract<ArtifactAttemptInput, { action: 'set' }> {
  const bytes = Buffer.from(
    ' ' +
      JSON.stringify({
        artifact_id: artifactId,
        event_type: 'checkpoint_closed',
        idempotency_key: 'original-key',
        outcome,
        payload_hash: 'a'.repeat(64),
        evaluator_fingerprint: 'original fingerprint',
        envelope: '{"original":true}',
        recorded_at: 'original time',
      }) +
      '\n'
  );
  return {
    action: 'set',
    operationId: uuidv7(),
    revisionId: uuidv7(),
    artifactId,
    artifactRevision: readProjectArtifact(handle, artifactId)!.revision,
    expectedSelection: null,
    bytes,
    source: {
      identity: 'original attempt',
      locator: 'sqlite:idempotency_blocks#7',
      revisionId: null,
      eventId: null,
      operationId: null,
      sha256: digest(bytes),
    },
  };
}
function clear(
  input: ArtifactAttemptInput,
  selection: { revisionId: string; version: number }
): Extract<ArtifactAttemptInput, { action: 'clear' }> {
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    artifactId: input.artifactId,
    artifactRevision: input.artifactRevision,
    expectedSelection: selection,
    source: { ...input.source, sha256: null },
    action: 'clear',
    eventType: 'checkpoint_closed',
    idempotencyKey: 'original-key',
  };
}
function saved(handle: ProjectDatabase) {
  return handle.read((v) => ({
    attempts: v.all(
      'SELECT revision_id,action,hex(record_bytes) AS bytes FROM artifact_attempt_revisions ORDER BY revision_id'
    ),
    current: v.all('SELECT * FROM artifact_attempt_current'),
    operations: v.all('SELECT * FROM operations ORDER BY operation_id'),
    artifacts: v.all('SELECT * FROM artifacts ORDER BY artifact_id'),
    events: v.all('SELECT event_id,record_hash FROM artifact_events ORDER BY event_id'),
  }));
}
it.each(['soft_blocked', 'hard_rejected'] as const)(
  'retains exact %s outcome and original identity without intent changes',
  async (outcome) => {
    const { handle, artifactId } = await fixture();
    const input = attempt(handle, artifactId, outcome);
    const before = saved(handle).counters;
    const result = await publishProjectArtifactAttempt(handle, input, refusal);
    expect(result.counters).toEqual({
      writeSequence: before.writeSequence + 1,
      intentChangeCounter: before.intentChangeCounter,
    });
    const row = readProjectArtifactAttempts(handle, artifactId).records[0]!;
    expect(row.action).toBe('set');
    expect(row.bytes).toEqual(input.bytes);
    expect(row.source).toEqual(input.source);
    expect(row.record).toMatchObject({
      outcome,
      evaluator_fingerprint: 'original fingerprint',
      envelope: '{"original":true}',
      recorded_at: 'original time',
    });
    const unchanged = saved(handle);
    expect(await publishProjectArtifactAttempt(handle, input, refusal)).toEqual({
      ...result,
      replayed: true,
    });
    expect(saved(handle)).toEqual(unchanged);
  }
);
it('distinguishes selected clear from missing state and preserves original set replay afterward', async () => {
  const { handle, artifactId } = await fixture();
  expect(readProjectArtifactAttempts(handle, artifactId).records).toEqual([]);
  const input = attempt(handle, artifactId);
  const first = await publishProjectArtifactAttempt(handle, input, refusal);
  const clearInput = clear(input, first.value.selection);
  const result = await publishProjectArtifactAttempt(handle, clearInput, refusal);
  expect(result.value.selection.version).toBe(2);
  expect(readProjectArtifactAttempts(handle, artifactId).records[0]).toMatchObject({
    action: 'clear',
    record: null,
    bytes: null,
    selection: result.value.selection,
  });
  const original = readProjectArtifactAttemptRevision(handle, artifactId, input.revisionId);
  expect(original.bytes).toEqual(input.bytes);
  expect(original.selection).toBeNull();
  const before = saved(handle);
  expect(await publishProjectArtifactAttempt(handle, input, refusal)).toEqual({
    ...first,
    replayed: true,
  });
  expect(await publishProjectArtifactAttempt(handle, clearInput, refusal)).toEqual({
    ...result,
    replayed: true,
  });
  expect(saved(handle)).toEqual(before);
});
it('refuses authored envelope secrets before any handle access or attempt row', async () => {
  const { handle, artifactId } = await fixture();
  const input = attempt(handle, artifactId);
  const row = JSON.parse(Buffer.from(input.bytes).toString());
  row.envelope = JSON.stringify({ nested: 'ghp_' + 'a'.repeat(36) });
  input.bytes = Buffer.from(JSON.stringify(row));
  input.source.sha256 = digest(input.bytes);
  const fake = { read: vi.fn() } as unknown as ProjectDatabase;
  await expect(publishProjectArtifactAttempt(fake, input, refusal)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(fake.read).not.toHaveBeenCalled();
  const before = saved(handle);
  await expect(publishProjectArtifactAttempt(handle, input, refusal)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(saved(handle)).toEqual(before);
});
it('rejects stale clear and operation conflict without replacing original outcomes', async () => {
  const { handle, artifactId } = await fixture();
  const input = attempt(handle, artifactId);
  const first = await publishProjectArtifactAttempt(handle, input, refusal);
  const next = attempt(handle, artifactId, 'hard_rejected');
  next.expectedSelection = first.value.selection;
  const advanced = await publishProjectArtifactAttempt(handle, next, refusal);
  const before = saved(handle);
  await expect(
    publishProjectArtifactAttempt(handle, clear(input, first.value.selection), refusal)
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await expect(
    publishProjectArtifactAttempt(
      handle,
      { ...next, operationId: input.operationId, expectedSelection: advanced.value.selection },
      refusal
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(saved(handle)).toEqual(before);
});
it('allows only one competing result for the same originally empty slot', async () => {
  const { handle, authority, artifactId } = await fixture();
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  const first = attempt(handle, artifactId);
  const results = await Promise.allSettled([
    publishProjectArtifactAttempt(handle, first, refusal),
    publishProjectArtifactAttempt(
      other,
      { ...first, operationId: uuidv7(), revisionId: uuidv7() },
      refusal
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'STALE_CONTEXT' },
  });
});
it('refuses missing original selection while preserving retained attempt bytes', async () => {
  const { handle, file, artifactId } = await fixture();
  const input = attempt(handle, artifactId);
  await publishProjectArtifactAttempt(handle, input, refusal);
  const db = new Database(file);
  const guard = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name='artifact_attempt_current_no_delete'")
    .get() as { sql: string };
  db.exec('DROP TRIGGER artifact_attempt_current_no_delete;DELETE FROM artifact_attempt_current');
  db.exec(guard.sql);
  db.close();
  const before = saved(handle);
  expect(() => readProjectArtifactAttempts(handle, artifactId)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  await expect(
    publishProjectArtifactAttempt(
      handle,
      { ...input, operationId: uuidv7(), revisionId: uuidv7() },
      refusal
    )
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(saved(handle)).toEqual(before);
});
it('rolls back capture and attempt clear together under the original operation identity', async () => {
  const { handle, artifactId, record } = await fixture();
  const input = attempt(handle, artifactId);
  const blocked = JSON.parse(Buffer.from(input.bytes).toString());
  blocked.event_type = 'plan_revised';
  input.bytes = Buffer.from(JSON.stringify(blocked));
  input.source.sha256 = digest(input.bytes);
  const first = await publishProjectArtifactAttempt(handle, input, refusal);
  const operationId = uuidv7();
  const next = {
    ...record,
    event_id: uuidv7(),
    idempotency_key: 'original-key',
    type: 'plan_revised',
    payload: {
      ...record.payload,
      revision_n: 1,
      revised_at: '2026-06-02T00:00:00.000Z',
      rationale: 'Retain updated plan',
      prior_plan_event_id: record.event_id,
    },
  };
  const request = prepareArtifactAppendRequest({
    artifactId,
    operationId,
    expectedRevision: input.artifactRevision,
    eventBytes: Buffer.from(JSON.stringify({ ...next, checksum: recordChecksum(next) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  });
  const append = await prepareArtifactAppend(handle, request);
  const clearInput = {
    ...clear(input, first.value.selection),
    eventType: 'plan_revised',
    operationId,
    artifactRevision: append.revision,
  };
  const prepared = prepareAuthoredArtifactAttempt(clearInput, refusal);
  const settlement = prepareArtifactAttemptSettlement(prepared);
  const operation = {
    ...request.operation,
    kind: 'fixture.capture.clear',
    payload: {
      capture: request.operation.payload,
      attempt: captureOperation(artifactAttemptPreparation(prepared), 'attempt.publish', null)
        .payload,
    },
  };
  const settle = (tx: Parameters<typeof settleProjectArtifactAttemptChanges>[0]) => {
    append.settle(tx);
    return settleProjectArtifactAttemptChanges(tx, settlement, operationId);
  };
  const before = saved(handle);
  await expect(
    runProjectOperation(handle, operation, (tx) => {
      settle(tx);
      throw new ProjectDatabaseError('STALE_CONTEXT', 'fixture late capture refusal');
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(saved(handle)).toEqual(before);
  const result = await runProjectOperation(handle, operation, settle);
  expect(result.value.action).toBe('clear');
  expect(readProjectArtifactAttempts(handle, artifactId).records[0]!.operationId).toBe(operationId);
  expect(readProjectArtifact(handle, artifactId)!.revision.generation).toBe(2);
});
it('retains the detached authored input and honors cancellation before publication', async () => {
  const { handle, artifactId } = await fixture();
  const input = attempt(handle, artifactId);
  const bytes = Buffer.from(input.bytes);
  const promise = publishProjectArtifactAttempt(handle, input, refusal);
  input.bytes.fill(0);
  input.source.locator = 'changed';
  const first = await promise;
  expect(readProjectArtifactAttempts(handle, artifactId).records[0]!.bytes).toEqual(bytes);
  const controller = new AbortController();
  controller.abort();
  const before = saved(handle);
  await expect(
    publishProjectArtifactAttempt(handle, clear(input, first.value.selection), refusal, {
      signal: controller.signal,
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(saved(handle)).toEqual(before);
});

it('retains historical original result bytes through the private import seam without reapplying authored refusal', async () => {
  const { handle, artifactId } = await fixture();
  const input = attempt(handle, artifactId);
  const row = JSON.parse(Buffer.from(input.bytes).toString());
  row.envelope = JSON.stringify({ original: 'ghp_' + 'a'.repeat(36) });
  input.bytes = Buffer.from(' ' + JSON.stringify(row) + '\n');
  input.source.sha256 = digest(input.bytes);
  const prepared = prepareHistoricalArtifactAttempt(input, { sourceProfile: '0.2.0-rc.2' });
  const record = artifactAttemptPreparation(prepared);
  const settlement = prepareArtifactAttemptSettlement(prepared);
  await runProjectOperation(
    handle,
    captureOperation(record, 'fixture.import.attempt', null),
    (tx) => settleProjectArtifactAttemptChanges(tx, settlement, input.operationId)
  );
  const retained = readProjectArtifactAttemptRevision(handle, artifactId, input.revisionId);
  expect(retained.bytes).toEqual(input.bytes);
  expect(retained.sourceProfile).toBe('0.2.0-rc.2');
  expect(retained.source.eventId).toBeNull();
  expect(() => readProjectArtifactAttemptRevision(handle, artifactId, uuidv7())).toThrow(
    expect.objectContaining({ code: 'HISTORY_MISSING' })
  );
});
