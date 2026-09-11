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
  prepareLifecycleCompletionSettlement,
  preparePlanIdempotencySettlement,
  publishProjectLifecycleCompletion,
  publishProjectPlanIdempotency,
  readProjectLifecycleCompletions,
  readProjectPlanIdempotency,
  settleProjectLifecycleCompletion,
  settleProjectPlanIdempotency,
} from './capture-lifecycles.js';
import {
  type LifecycleCompletionInput,
  lifecycleCompletionPreparation,
  type PlanIdempotencyInput,
  planIdempotencyPreparation,
  prepareAuthoredLifecycleCompletion,
  prepareAuthoredPlanIdempotency,
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
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const refusal = { secretAllow: [] };
async function planBytes(artifactId: string) {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/execution-history.json', import.meta.url), 'utf8')
  );
  const { checksum: _checksum, ...record } = JSON.parse(
    Buffer.from(fixture.rows.artifact_events[0].record_bytes.blobHex, 'hex').toString()
  );
  record.event_id = uuidv7();
  record.idempotency_key = uuidv7();
  record.payload.artifact_id = artifactId;
  return Buffer.from(' ' + JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n');
}
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'capture-lifecycle-')),
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
  const artifactId = uuidv7();
  await appendProjectArtifactEvents(handle, {
    artifactId,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: await planBytes(artifactId),
    sidecarPayloads: [],
    secretAllow: [],
  });
  return { handle, authority, file, artifactId };
}
function lifecycle(handle: ProjectDatabase, artifactId: string): LifecycleCompletionInput {
  const bytes = Buffer.from(' {"fires_at":"pre-pr","cp_n":0,"triggered_at":"original time"}\n');
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    artifactId,
    artifactRevision: readProjectArtifact(handle, artifactId)!.revision,
    expectedSelection: null,
    source: {
      identity: 'original lifecycle source',
      locator: 'sqlite:evaluator_lifecycles#0',
      revisionId: null,
      eventId: null,
      operationId: null,
      sha256: digest(bytes),
    },
    bytes,
  };
}
function planKey(input: LifecycleCompletionInput): PlanIdempotencyInput {
  const { revisionId: _revision, expectedSelection: _selection, ...base } = input;
  const bytes = Buffer.from(
    ' ' +
      JSON.stringify({
        idempotency_key: 'original key',
        artifact_id: input.artifactId,
        created_at: 'original date',
      }) +
      '\n'
  );
  return {
    ...base,
    bytes,
    source: { ...base.source, identity: 'original plan key', sha256: digest(bytes) },
  };
}
function saved(handle: ProjectDatabase) {
  return handle.read((view) => ({
    lifecycle: view.all(
      'SELECT revision_id,hex(record_bytes) AS bytes FROM artifact_lifecycle_revisions ORDER BY revision_id'
    ),
    current: view.all(
      'SELECT * FROM artifact_lifecycle_current ORDER BY artifact_id,fires_at,cp_n'
    ),
    plans: view.all(
      'SELECT idempotency_key,artifact_id,hex(record_bytes) AS bytes FROM plan_idempotency_records ORDER BY idempotency_key'
    ),
    receipts: view.all('SELECT * FROM operations ORDER BY operation_id'),
    artifacts: view.all('SELECT * FROM artifacts ORDER BY artifact_id'),
  }));
}
it('retains zero-run completion, exact bytes and original source while changing only write sequence', async () => {
  const { handle, artifactId } = await fixture();
  const input = lifecycle(handle, artifactId);
  const before = saved(handle).counters;
  const result = await publishProjectLifecycleCompletion(handle, input, refusal);
  expect(result.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const read = readProjectLifecycleCompletions(handle, artifactId);
  expect(read.records).toHaveLength(1);
  expect(read.records[0]!.bytes).toEqual(input.bytes);
  expect(read.records[0]!.source).toEqual(input.source);
  expect(read.records[0]!.record.cp_n).toBe(0);
  const unchanged = saved(handle);
  expect(await publishProjectLifecycleCompletion(handle, input, refusal)).toEqual({
    ...result,
    replayed: true,
  });
  expect(saved(handle)).toEqual(unchanged);
});
it('returns original replay after another selected completion and rejects stale or reused identities', async () => {
  const { handle, artifactId } = await fixture();
  const first = lifecycle(handle, artifactId);
  const original = await publishProjectLifecycleCompletion(handle, first, refusal);
  const second = {
    ...first,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    expectedSelection: original.value.selection,
  };
  const advanced = await publishProjectLifecycleCompletion(handle, second, refusal);
  expect(advanced.value.selection.version).toBe(2);
  const before = saved(handle);
  expect(await publishProjectLifecycleCompletion(handle, first, refusal)).toEqual({
    ...original,
    replayed: true,
  });
  await expect(
    publishProjectLifecycleCompletion(
      handle,
      { ...first, operationId: uuidv7(), revisionId: uuidv7() },
      refusal
    )
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await expect(
    publishProjectLifecycleCompletion(
      handle,
      { ...first, expectedSelection: advanced.value.selection },
      refusal
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(saved(handle)).toEqual(before);
});
it('serializes competing completions against one original selection', async () => {
  const { handle, authority, artifactId } = await fixture();
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  const first = lifecycle(handle, artifactId);
  const results = await Promise.allSettled([
    publishProjectLifecycleCompletion(handle, first, refusal),
    publishProjectLifecycleCompletion(
      other,
      { ...first, operationId: uuidv7(), revisionId: uuidv7() },
      refusal
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'STALE_CONTEXT' },
  });
  expect(readProjectLifecycleCompletions(handle, artifactId).records).toHaveLength(1);
});
it('refuses secrets before consulting even a fabricated handle and never initializes attempts', async () => {
  const { handle, artifactId } = await fixture();
  const input = lifecycle(handle, artifactId);
  input.source.locator = 'ghp_' + 'a'.repeat(36);
  const read = vi.fn();
  const fake = { read } as unknown as ProjectDatabase;
  await expect(publishProjectLifecycleCompletion(fake, input, refusal)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(read).not.toHaveBeenCalled();
  const before = saved(handle);
  await expect(publishProjectLifecycleCompletion(handle, input, refusal)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(saved(handle)).toEqual(before);
  expect(
    handle.read((v) =>
      v.get<{ count: number }>('SELECT count(*) AS count FROM artifact_attempt_revisions')
    ).value?.count
  ).toBe(0);
  expect(() => readProjectLifecycleCompletions(fake, artifactId)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
});
it('refuses missing expected artifact or lifecycle selection without treating history as empty', async () => {
  const { handle, file, artifactId } = await fixture();
  expect(() => readProjectLifecycleCompletions(handle, uuidv7())).toThrow(
    expect.objectContaining({ code: 'HISTORY_MISSING' })
  );
  const input = lifecycle(handle, artifactId);
  await publishProjectLifecycleCompletion(handle, input, refusal);
  const db = new Database(file);
  const sql = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name='artifact_lifecycle_current_no_delete'")
    .get() as { sql: string };
  db.exec(
    'DROP TRIGGER artifact_lifecycle_current_no_delete;DELETE FROM artifact_lifecycle_current'
  );
  db.exec(sql.sql);
  db.close();
  const before = saved(handle);
  expect(() => readProjectLifecycleCompletions(handle, artifactId)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  await expect(
    publishProjectLifecycleCompletion(
      handle,
      { ...input, operationId: uuidv7(), revisionId: uuidv7() },
      refusal
    )
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(saved(handle)).toEqual(before);
});
it('retains immutable original plan key bytes and rejects conflicting mapping or provenance', async () => {
  const { handle, artifactId } = await fixture();
  const input = planKey(lifecycle(handle, artifactId));
  const result = await publishProjectPlanIdempotency(handle, input, refusal);
  expect(readProjectPlanIdempotency(handle, 'missing')).toBeNull();
  const record = readProjectPlanIdempotency(handle, 'original key')!;
  expect(record.bytes).toEqual(input.bytes);
  expect(record.source.eventId).toBeNull();
  expect(await publishProjectPlanIdempotency(handle, input, refusal)).toEqual({
    ...result,
    replayed: true,
  });
  const equal = await publishProjectPlanIdempotency(
    handle,
    { ...input, operationId: uuidv7() },
    refusal
  );
  expect(equal.value.publicationOperationId).toBe(input.operationId);
  const before = saved(handle);
  await expect(
    publishProjectPlanIdempotency(
      handle,
      { ...input, operationId: uuidv7(), source: { ...input.source, locator: 'different' } },
      refusal
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(saved(handle)).toEqual(before);
});
it('rolls back retained completion and selection when the operation receipt cannot commit', async () => {
  const { handle, artifactId } = await fixture();
  const input = lifecycle(handle, artifactId);
  const before = saved(handle);
  const original = Database.prototype.prepare;
  const fault = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.startsWith('INSERT INTO operations'))
      throw new Database.SqliteError('fixture full', 'SQLITE_FULL');
    return original.call(this, sql);
  });
  await expect(publishProjectLifecycleCompletion(handle, input, refusal)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'disk-full',
  });
  fault.mockRestore();
  expect(saved(handle)).toEqual(before);
  await expect(publishProjectLifecycleCompletion(handle, input, refusal)).resolves.toMatchObject({
    replayed: false,
  });
});
it('composes new artifact, completion and original plan key in one receipt and rollback boundary', async () => {
  const { handle, artifactId: existing } = await fixture();
  const artifactId = uuidv7();
  const operationId = uuidv7();
  const request = prepareArtifactAppendRequest({
    artifactId,
    operationId,
    expectedRevision: null,
    eventBytes: await planBytes(artifactId),
    sidecarPayloads: [],
    secretAllow: [],
  });
  const append = await prepareArtifactAppend(handle, request);
  const input = {
    ...lifecycle(handle, existing),
    artifactId,
    operationId,
    artifactRevision: append.revision,
  };
  const lifecycleInput = prepareAuthoredLifecycleCompletion(input, refusal);
  const planInput = prepareAuthoredPlanIdempotency(planKey(input), refusal);
  const completion = prepareLifecycleCompletionSettlement(lifecycleInput);
  const key = preparePlanIdempotencySettlement(planInput);
  const operation = {
    ...request.operation,
    kind: 'fixture.capture.operational',
    payload: {
      capture: request.operation.payload,
      lifecycle: captureOperation(
        lifecycleCompletionPreparation(lifecycleInput),
        'lifecycle.publish',
        null
      ).payload,
      planKey: captureOperation(planIdempotencyPreparation(planInput), 'plan-key.publish', null)
        .payload,
    },
  };
  const before = saved(handle);
  const settle = (tx: Parameters<typeof settleProjectLifecycleCompletion>[0]) => {
    const artifact = append.settle(tx);
    settleProjectLifecycleCompletion(tx, completion, operationId);
    settleProjectPlanIdempotency(tx, key, operationId);
    return { artifactId: artifact.artifactId };
  };
  await expect(
    runProjectOperation(handle, operation, (tx) => {
      settle(tx);
      throw new ProjectDatabaseError('STALE_CONTEXT', 'fixture final refusal');
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(saved(handle)).toEqual(before);
  const result = await runProjectOperation(handle, operation, settle);
  expect(result.value.artifactId).toBe(artifactId);
  expect(readProjectLifecycleCompletions(handle, artifactId).records[0]!.operationId).toBe(
    operationId
  );
  expect(readProjectPlanIdempotency(handle, 'original key')!.operationId).toBe(operationId);
});

it('copies authored completion input before waiting and preserves the supplied cancellation signal', async () => {
  const { handle, artifactId } = await fixture();
  const input = lifecycle(handle, artifactId);
  const bytes = Buffer.from(input.bytes);
  const expectedId = input.revisionId;
  const promise = publishProjectLifecycleCompletion(handle, input, refusal);
  input.bytes.fill(0);
  input.revisionId = uuidv7();
  input.source.locator = 'changed';
  const result = await promise;
  expect(result.value.selection.revisionId).toBe(expectedId);
  expect(readProjectLifecycleCompletions(handle, artifactId).records[0]!.bytes).toEqual(bytes);
  const next = lifecycle(handle, artifactId);
  next.expectedSelection = result.value.selection;
  const controller = new AbortController();
  controller.abort();
  const before = saved(handle);
  await expect(
    publishProjectLifecycleCompletion(handle, next, refusal, { signal: controller.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(saved(handle)).toEqual(before);
});
it('decodes materialized records after the short read and never scans artifact event bytes', async () => {
  const { handle, artifactId } = await fixture();
  await publishProjectLifecycleCompletion(handle, lifecycle(handle, artifactId), refusal);
  const queries: string[] = [];
  const original = Database.prototype.prepare;
  const probe = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    queries.push(sql);
    return original.call(this, sql);
  });
  expect(readProjectLifecycleCompletions(handle, artifactId).records).toHaveLength(1);
  probe.mockRestore();
  expect(queries.some((sql) => /artifact_events/.test(sql))).toBe(false);
});

it.each([false, true])(
  'refuses new and replayed publication when original lifecycle receipt history is missing, later selection: %s',
  async (later) => {
    const { handle, artifactId, file } = await fixture();
    const first = lifecycle(handle, artifactId);
    const initial = await publishProjectLifecycleCompletion(handle, first, refusal);
    if (later) {
      const next = lifecycle(handle, artifactId);
      next.expectedSelection = initial.value.selection;
      await publishProjectLifecycleCompletion(handle, next, refusal);
      expect((await publishProjectLifecycleCompletion(handle, first, refusal)).replayed).toBe(true);
    }
    const db = new Database(file);
    const triggers = db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('artifact_lifecycle_current','artifact_lifecycle_revisions')"
      )
      .all() as { name: string; sql: string }[];
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    if (!later)
      db.prepare('DELETE FROM artifact_lifecycle_current WHERE artifact_id=?').run(artifactId);
    db.prepare('DELETE FROM artifact_lifecycle_revisions WHERE revision_id=?').run(
      first.revisionId
    );
    for (const trigger of triggers) db.exec(trigger.sql);
    db.close();
    const before = saved(handle);
    expect
      .soft(() => readProjectLifecycleCompletions(handle, artifactId))
      .toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
    await expect
      .soft(publishProjectLifecycleCompletion(handle, first, refusal))
      .rejects.toMatchObject({
        code: 'HISTORY_INTEGRITY_REQUIRED',
      });
    await expect(
      publishProjectLifecycleCompletion(handle, lifecycle(handle, artifactId), refusal)
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect.soft(saved(handle)).toEqual(before);
  }
);
