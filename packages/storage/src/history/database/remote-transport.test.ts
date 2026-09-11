import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import * as secretGuard from '../../text/secret-guard.js';
import { recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import { readProjectArtifact } from './artifacts.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { appendProjectExecutionCapture } from './execution-capture.js';
import { readProjectExecution } from './execution-records.js';
import {
  type ProjectRemoteOutcomeInput,
  type ProjectRemoteRequestInput,
  type RemoteTransportSelection,
} from './remote-transport-input.js';
import { readProjectRemoteCurrent, readProjectRemoteRequest } from './remote-transport-reader.js';
import {
  admitProjectRemoteAttempt,
  recordProjectRemoteOutcome,
  retainProjectRemoteRequest,
} from './remote-transport.js';
import { prepareProjectGitRetention } from './retention-input.js';
import { beginProjectGitRetention, settleProjectGitRetention } from './retention.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const refusal = { secretAllow: [] as string[] };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'remote-transport-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(handle);
  return { handle, authority };
}
function request(): ProjectRemoteRequestInput {
  return {
    operationId: uuidv7(),
    requestId: uuidv7(),
    expectedSelection: null,
    scope: {
      target: {
        server_url: 'https://example.test/API',
        org_id: 'organization',
        account_id: 'account',
      },
      artifactId: null,
      method: 'captureThread.attachCheckpoint',
      targetExternalId: `${uuidv7()}:12`,
      idempotencyKey: 'original-key',
    },
    payloadBytes: Buffer.from(' {"body":"original text", "n":2}\n'),
    preparedAt: '2026-09-01T00:02:00.000Z',
  };
}
async function pendingGit(handle: ProjectDatabase) {
  const prior = JSON.parse(
    readFileSync(new URL('./fixtures/retention-inputs.json', import.meta.url), 'utf8')
  );
  const event = prior.rows.artifact_events[0];
  const { checksum: _checksum, ...original } = JSON.parse(
    Buffer.from(event.record_bytes.blobHex, 'hex').toString()
  );
  const record = {
    ...original,
    payload: { ...original.payload, baseline_seed_tree_sha: 'b'.repeat(40) },
  };
  const artifactId = event.artifact_id as string;
  await appendProjectExecutionCapture(handle, {
    artifactId,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n'),
    sidecarPayloads:
      event.sidecar_payload_bytes === null
        ? []
        : [
            {
              eventId: event.event_id,
              bytes: Buffer.from(event.sidecar_payload_bytes.blobHex, 'hex'),
            },
          ],
    secretAllow: [],
    execution: {
      kind: 'create',
      context: {
        repository_instance_id: handle.authority.repositoryInstanceId,
        worktree_id: uuidv7(),
        git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
      },
      ts: '2026-09-01T00:00:00.000Z',
    },
  });
  const artifact = readProjectArtifact(handle, artifactId)!;
  const execution = readProjectExecution(handle, artifactId)!;
  const operationId = uuidv7(),
    preparedTransitionId = uuidv7();
  const prepared = prepareProjectGitRetention({
    operationId,
    admissionOperationId: uuidv7(),
    preparedTransitionId,
    repositoryInstanceId: handle.authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:01:00.000Z',
    target: {
      kind: 'capture',
      artifactId,
      expectedRevision: artifact.revision,
      expectedExecutionVersion: execution.version,
      expectedBindingGeneration: execution.state.binding_generation,
      expectedBaselinePublicationId: null,
    },
    publications: [
      {
        publicationId: uuidv7(),
        role: 'baseline',
        targetId: event.event_id,
        checkpointNumber: null,
        checkpointPhase: null,
        objectOid: 'a'.repeat(40),
        treeOid: 'b'.repeat(40),
      },
    ],
    secretAllow: [],
  });
  await beginProjectGitRetention(handle, prepared);
  expect(
    handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id=?', operationId)
    ).value
  ).toBeNull();
  return { operationId, prepared, preparedTransitionId };
}
it.each(['request', 'attempt'] as const)(
  'protects an admitted Git operation identity from remote %s settlement',
  async (kind) => {
    const { handle } = await fixture();
    const pending = await pendingGit(handle);
    const input = request();
    const initial =
      kind === 'attempt' ? await retainProjectRemoteRequest(handle, input, refusal) : null;
    const before = handle.read((view) => ({
      remote: view.all('SELECT * FROM remote_current'),
      attempts: view.all('SELECT * FROM remote_attempts'),
      requests: view.all(
        'SELECT request_id,operation_id,hex(payload_bytes) AS payload FROM remote_requests'
      ),
    }));
    const result =
      kind === 'request'
        ? retainProjectRemoteRequest(
            handle,
            { ...input, operationId: pending.operationId },
            refusal
          )
        : admitProjectRemoteAttempt(
            handle,
            {
              operationId: pending.operationId,
              requestId: input.requestId,
              attemptId: uuidv7(),
              scope: input.scope,
              expectedSelection: initial!.value.selection,
              attemptedAt: input.preparedAt,
            },
            refusal
          );
    await expect(result).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      handle.read((view) => ({
        remote: view.all('SELECT * FROM remote_current'),
        attempts: view.all('SELECT * FROM remote_attempts'),
        requests: view.all(
          'SELECT request_id,operation_id,hex(payload_bytes) AS payload FROM remote_requests'
        ),
      }))
    ).toEqual(before);
    const settled = await settleProjectGitRetention(
      handle,
      pending.prepared,
      pending.preparedTransitionId,
      uuidv7()
    );
    expect(settled.replayed).toBe(false);
  }
);

it('retains exact request bytes once and conflicts on changed original input', async () => {
  const { handle } = await fixture();
  const input = request();
  const first = await retainProjectRemoteRequest(handle, input, refusal);
  expect(first).toMatchObject({
    replayed: false,
    counters: { writeSequence: 2, intentChangeCounter: 0 },
    value: {
      selection: { requestId: input.requestId, attemptId: null, outcomeId: null, version: 1 },
    },
  });
  expect(
    handle.read((view) =>
      view.get<{ payload: string }>(
        'SELECT hex(payload_bytes) AS payload FROM remote_requests WHERE request_id=?',
        input.requestId
      )
    ).value!.payload
  ).toBe(Buffer.from(input.payloadBytes).toString('hex').toUpperCase());
  expect(await retainProjectRemoteRequest(handle, input, refusal)).toEqual({
    ...first,
    replayed: true,
  });
  await expect(
    retainProjectRemoteRequest(
      handle,
      { ...input, payloadBytes: Buffer.from('{"body":"changed"}') },
      refusal
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(handle.read(() => null).counters).toEqual(first.counters);
  const receipt = handle.read((view) =>
    view.get<{ payload: string }>(
      'SELECT payload_json AS payload FROM operations WHERE operation_id=?',
      input.operationId
    )
  ).value!;
  expect(receipt.payload).not.toContain('original text');
});
it('isolates full account and method namespaces while protecting original request identities', async () => {
  const { handle } = await fixture();
  const input = request();
  await retainProjectRemoteRequest(handle, input, refusal);
  for (const scope of [
    { ...input.scope, target: { ...input.scope.target, account_id: 'other-account' } },
    { ...input.scope, target: { ...input.scope.target, org_id: 'other-organization' } },
    { ...input.scope, target: { ...input.scope.target, server_url: 'https://other.test/API' } },
    { ...input.scope, idempotencyKey: 'other-key' },
  ])
    await retainProjectRemoteRequest(
      handle,
      { ...input, scope, requestId: uuidv7(), operationId: uuidv7() },
      refusal
    );
  expect(
    handle.read((view) => view.all('SELECT request_id FROM remote_current')).value
  ).toHaveLength(5);
  await expect(
    retainProjectRemoteRequest(
      handle,
      { ...input, scope: { ...input.scope, idempotencyKey: 'third-key' }, operationId: uuidv7() },
      refusal
    )
  ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
});
it('refuses replacing an unresolved request under a new payload and operation identity', async () => {
  const { handle } = await fixture();
  const input = request();
  const first = await retainProjectRemoteRequest(handle, input, refusal);
  await expect(
    retainProjectRemoteRequest(
      handle,
      {
        ...input,
        operationId: uuidv7(),
        requestId: uuidv7(),
        expectedSelection: first.value.selection,
        payloadBytes: Buffer.from('{"changed":true}'),
      },
      refusal
    )
  ).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
    message: expect.stringMatching(
      /preserve the original request.*inspection cannot prove remote absence.*rather than resending/i
    ),
  });
  expect(handle.read(() => null).counters).toEqual(first.counters);
});
function attempt(
  input: ProjectRemoteRequestInput,
  selected: {
    value: { selection: { requestId: string; attemptId: null; outcomeId: null; version: number } };
  }
) {
  return {
    operationId: uuidv7(),
    requestId: input.requestId,
    attemptId: uuidv7(),
    scope: input.scope,
    expectedSelection: selected.value.selection,
    attemptedAt: input.preparedAt,
  };
}
it('grants send permission only to the original newly committed admission', async () => {
  const { handle, authority } = await fixture();
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  const input = request();
  const initial = await retainProjectRemoteRequest(handle, input, refusal);
  const admission = attempt(input, initial);
  const results = await Promise.all([
    admitProjectRemoteAttempt(handle, admission, refusal),
    admitProjectRemoteAttempt(other, admission, refusal),
  ]);
  expect(results.map((value) => value.sendAllowed).sort()).toEqual([false, true]);
  expect(results.map((value) => value.replayed).sort()).toEqual([false, true]);
  expect(results[0]!.value).toEqual(results[1]!.value);
  expect(handle.read((view) => view.all('SELECT attempt_id FROM remote_attempts')).value).toEqual([
    { attempt_id: admission.attemptId },
  ]);
  const original = results.find((value) => !value.replayed)!;
  expect(await retainProjectRemoteRequest(other, input, refusal)).toEqual({
    ...initial,
    replayed: true,
  });
  expect(handle.read((view) => view.get('SELECT version FROM remote_current')).value).toEqual({
    version: 2,
  });
  await expect(
    admitProjectRemoteAttempt(
      handle,
      { ...admission, operationId: uuidv7(), attemptId: uuidv7() },
      refusal
    )
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(handle.read(() => null).counters).toEqual(original.counters);
});
it('rolls back an admission when selection publication fails and retries the original identity', async () => {
  const { handle } = await fixture();
  const input = request();
  const initial = await retainProjectRemoteRequest(handle, input, refusal);
  const admission = attempt(input, initial);
  const prepare = Database.prototype.prepare;
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.startsWith('UPDATE remote_current')) throw new Error('Injected selection fault');
    return prepare.call(this, sql);
  });
  await expect(admitProjectRemoteAttempt(handle, admission, refusal)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
  });
  spy.mockRestore();
  expect(handle.read((view) => view.all('SELECT * FROM remote_attempts')).value).toEqual([]);
  expect(handle.read(() => null).counters).toEqual(initial.counters);
  expect(await admitProjectRemoteAttempt(handle, admission, refusal)).toMatchObject({
    sendAllowed: true,
    replayed: false,
  });
});
it('keeps committed admission while refusing send permission after cancellation', async () => {
  const { handle } = await fixture();
  const input = request();
  const initial = await retainProjectRemoteRequest(handle, input, refusal);
  const admission = attempt(input, initial);
  const controller = new AbortController();
  const exec = Database.prototype.exec;
  const spy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT') controller.abort();
    return result;
  });
  const result = await admitProjectRemoteAttempt(handle, admission, refusal, {
    signal: controller.signal,
  });
  spy.mockRestore();
  expect(result).toMatchObject({ replayed: false, sendAllowed: false });
  expect(await admitProjectRemoteAttempt(handle, admission, refusal)).toEqual({
    ...result,
    replayed: true,
  });
  expect(handle.read((view) => view.all('SELECT attempt_id FROM remote_attempts')).value).toEqual([
    { attempt_id: admission.attemptId },
  ]);
});
it('refuses canceled admission without changing its original request', async () => {
  const { handle } = await fixture();
  const input = request();
  const initial = await retainProjectRemoteRequest(handle, input, refusal);
  const controller = new AbortController();
  controller.abort();
  await expect(
    admitProjectRemoteAttempt(handle, attempt(input, initial), refusal, {
      signal: controller.signal,
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(handle.read(() => null).counters).toEqual(initial.counters);
});
it('refuses secret-bearing request and admission fields before transaction admission', async () => {
  const { handle } = await fixture();
  const input = request();
  const initial = await retainProjectRemoteRequest(handle, input, refusal);
  const secret = 'ghp_' + 'a'.repeat(36);
  const exec = vi.spyOn(Database.prototype, 'exec');
  await expect(
    retainProjectRemoteRequest(
      handle,
      { ...request(), payloadBytes: Buffer.from(JSON.stringify({ body: secret })) },
      refusal
    )
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  await expect(
    admitProjectRemoteAttempt(
      handle,
      { ...attempt(input, initial), scope: { ...input.scope, targetExternalId: secret } },
      refusal
    )
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(exec).not.toHaveBeenCalled();
  exec.mockRestore();
  expect(handle.read(() => null).counters).toEqual(initial.counters);
});
it('retains detached request bytes and cancellation identity while admission waits', async () => {
  const { handle } = await fixture();
  const input = request();
  const original = structuredClone(input);
  const blocker = new Database(handle.databasePath);
  blocker.exec('BEGIN IMMEDIATE');
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    onWait: vi.fn(() => {
      input.requestId = uuidv7();
      input.scope.target.account_id = 'changed-account';
      input.payloadBytes = Buffer.from('{"changed":true}');
      options.signal = AbortSignal.abort();
      blocker.exec('ROLLBACK');
    }),
  };
  try {
    const result = await retainProjectRemoteRequest(handle, input, refusal, options);
    expect(options.onWait).toHaveBeenCalledWith({
      operation: 'remote.request',
      reason: 'admission',
      attempt: 1,
    });
    expect(result.value.selection.requestId).toBe(original.requestId);
    expect(
      handle.read((view) =>
        view.get('SELECT account_id,hex(payload_bytes) AS payload FROM remote_requests')
      ).value
    ).toEqual({
      account_id: original.scope.target.account_id,
      payload: Buffer.from(original.payloadBytes).toString('hex').toUpperCase(),
    });
  } finally {
    blocker.close();
  }
});
it('refuses missing current selection while preserving the original retained request', async () => {
  const { handle } = await fixture();
  const input = request();
  const first = await retainProjectRemoteRequest(handle, input, refusal);
  const raw = new Database(handle.databasePath);
  try {
    const trigger = raw
      .prepare("SELECT sql FROM sqlite_schema WHERE name='remote_current_no_delete'")
      .get() as { sql: string };
    raw.exec('DROP TRIGGER remote_current_no_delete; DELETE FROM remote_current');
    raw.exec(trigger.sql);
    await expect(
      retainProjectRemoteRequest(
        handle,
        { ...input, requestId: uuidv7(), operationId: uuidv7() },
        refusal
      )
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(handle.read(() => null).counters).toEqual(first.counters);
    expect(raw.prepare('SELECT request_id FROM remote_requests').all()).toEqual([
      { request_id: input.requestId },
    ]);
    expect(raw.prepare('SELECT * FROM remote_current').all()).toEqual([]);
  } finally {
    raw.close();
  }
});

async function admitted(handle: ProjectDatabase) {
  const input = request();
  const retained = await retainProjectRemoteRequest(handle, input, refusal);
  const admission = attempt(input, retained);
  const result = await admitProjectRemoteAttempt(handle, admission, refusal);
  return { input, admission, result };
}
function observation(
  input: ProjectRemoteRequestInput,
  selection: RemoteTransportSelection,
  kind: 'ack_unknown' | 'acknowledged'
): ProjectRemoteOutcomeInput {
  const common = {
    operationId: uuidv7(),
    requestId: input.requestId,
    attemptId: selection.attemptId!,
    outcomeId: uuidv7(),
    scope: input.scope,
    expectedSelection: selection,
    observedAt: '2026-09-01T00:03:00.000Z',
  };
  return kind === 'ack_unknown'
    ? {
        ...common,
        kind,
        responseBytes: null,
        failure: { kind: 'unknown', message: 'Connection interrupted' },
      }
    : {
        ...common,
        kind,
        responseBytes: Buffer.from(' {"external_id":"original-response","accepted":true}\n'),
        failure: null,
      };
}
it('retains unknown observations and exact acknowledgment bytes with original replay', async () => {
  const { handle } = await fixture();
  const { input, result, admission } = await admitted(handle);
  const unknown = observation(input, result.value.selection, 'ack_unknown');
  const first = await recordProjectRemoteOutcome(handle, unknown, refusal);
  const acknowledged = observation(input, first.value.selection, 'acknowledged');
  const second = await recordProjectRemoteOutcome(handle, acknowledged, refusal);
  expect(second.counters).toEqual({ writeSequence: 5, intentChangeCounter: 0 });
  const exact = readProjectRemoteRequest(handle, input.requestId);
  expect(exact.value!.request.payloadBytes).toEqual(input.payloadBytes);
  expect(exact.value!.attempt!.attemptId).toBe(admission.attemptId);
  expect(exact.value!.outcomes.map((value) => [value.kind, value.ordinal])).toEqual([
    ['ack_unknown', 1],
    ['acknowledged', 2],
  ]);
  expect(exact.value!.outcomes[1]!.responseBytes).toEqual(acknowledged.responseBytes);
  expect(readProjectRemoteCurrent(handle, input.scope)).toEqual(exact);
  expect(await recordProjectRemoteOutcome(handle, unknown, refusal)).toEqual({
    ...first,
    replayed: true,
  });
  expect(await recordProjectRemoteOutcome(handle, acknowledged, refusal)).toEqual({
    ...second,
    replayed: true,
  });
  expect(await admitProjectRemoteAttempt(handle, admission, refusal)).toMatchObject({
    sendAllowed: false,
    replayed: true,
  });
  await expect(
    recordProjectRemoteOutcome(
      handle,
      { ...unknown, operationId: uuidv7(), outcomeId: uuidv7() },
      refusal
    )
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await expect(
    recordProjectRemoteOutcome(
      handle,
      {
        ...unknown,
        operationId: uuidv7(),
        outcomeId: uuidv7(),
        expectedSelection: second.value.selection,
      },
      refusal
    )
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProjectRemoteRequest(handle, input.requestId)).toEqual(exact);
});
it('keeps old acknowledged history and replay while selecting a new request', async () => {
  const { handle } = await fixture();
  const { input, result } = await admitted(handle);
  const acknowledged = observation(input, result.value.selection, 'acknowledged');
  const accepted = await recordProjectRemoteOutcome(handle, acknowledged, refusal);
  const next = {
    ...input,
    operationId: uuidv7(),
    requestId: uuidv7(),
    payloadBytes: Buffer.from('{"body":"new request"}'),
    expectedSelection: accepted.value.selection,
  };
  const current = await retainProjectRemoteRequest(handle, next, refusal);
  expect(readProjectRemoteCurrent(handle, input.scope).value!.request.requestId).toBe(
    next.requestId
  );
  expect(readProjectRemoteRequest(handle, input.requestId).value!.outcomes).toHaveLength(1);
  expect(await recordProjectRemoteOutcome(handle, acknowledged, refusal)).toEqual({
    ...accepted,
    replayed: true,
  });
  expect(readProjectRemoteCurrent(handle, input.scope).value!.current).toEqual(
    current.value.selection
  );
});
it('protects a pending Git identity from remote outcome settlement', async () => {
  const { handle } = await fixture();
  const pending = await pendingGit(handle);
  const { input, result } = await admitted(handle);
  const before = readProjectRemoteCurrent(handle, input.scope);
  await expect(
    recordProjectRemoteOutcome(
      handle,
      {
        ...observation(input, result.value.selection, 'ack_unknown'),
        operationId: pending.operationId,
      },
      refusal
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(readProjectRemoteCurrent(handle, input.scope)).toEqual(before);
  expect(
    await settleProjectGitRetention(
      handle,
      pending.prepared,
      pending.preparedTransitionId,
      uuidv7()
    )
  ).toMatchObject({ replayed: false });
});
it('decodes copied original bytes after the read transaction ends', async () => {
  const { handle, authority } = await fixture();
  const { input, result } = await admitted(handle);
  const acknowledged = observation(input, result.value.selection, 'acknowledged');
  await recordProjectRemoteOutcome(handle, acknowledged, refusal);
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  let active = false;
  const exec = Database.prototype.exec;
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const result = exec.call(this, sql);
    active = this.inTransaction;
    return result;
  });
  const parse = JSON.parse;
  const decoded: string[] = [];
  vi.spyOn(JSON, 'parse').mockImplementation((text: string, ...rest) => {
    if (
      text === Buffer.from(input.payloadBytes).toString() ||
      text === Buffer.from(acknowledged.responseBytes!).toString()
    ) {
      expect(active).toBe(false);
      decoded.push(text);
    }
    return parse(text, ...rest);
  });
  const current = readProjectRemoteCurrent(reader, input.scope);
  expect(decoded).toHaveLength(2);
  current.value!.request.payloadBytes.fill(0);
  current.value!.outcomes[0]!.responseBytes!.fill(0);
  vi.restoreAllMocks();
  expect(readProjectRemoteCurrent(reader, input.scope).value!.request.payloadBytes).toEqual(
    input.payloadBytes
  );
  expect(reader.read(() => null).counters).toEqual(current.counters);
});
it('refuses changed response content under the original outcome identity', async () => {
  const { handle } = await fixture();
  const { input, result } = await admitted(handle);
  const accepted = observation(input, result.value.selection, 'acknowledged');
  const first = await recordProjectRemoteOutcome(handle, accepted, refusal);
  await expect(
    recordProjectRemoteOutcome(
      handle,
      {
        ...accepted,
        kind: 'acknowledged',
        failure: null,
        responseBytes: Buffer.from('{"different":true}'),
      },
      refusal
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(handle.read(() => null).counters).toEqual(first.counters);
});
it('refuses response secrets before transaction admission without retaining an outcome', async () => {
  const { handle } = await fixture();
  const { input, result } = await admitted(handle);
  const accepted = observation(input, result.value.selection, 'acknowledged');
  const exec = vi.spyOn(Database.prototype, 'exec');
  await expect(
    recordProjectRemoteOutcome(
      handle,
      {
        ...accepted,
        kind: 'acknowledged',
        failure: null,
        responseBytes: Buffer.from(JSON.stringify({ body: 'ghp_' + 'a'.repeat(36) })),
      },
      refusal
    )
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(exec).not.toHaveBeenCalled();
  exec.mockRestore();
  expect(readProjectRemoteRequest(handle, input.requestId).value!.outcomes).toEqual([]);
  expect(handle.read(() => null).counters).toEqual(result.counters);
});

it.each(['receipt', 'selection', 'outcome'] as const)(
  'refuses visibly missing original %s without read repair',
  async (missing) => {
    const { handle } = await fixture();
    const { input, result } = await admitted(handle);
    const outcome = observation(input, result.value.selection, 'acknowledged');
    await recordProjectRemoteOutcome(handle, outcome, refusal);
    const before = readProjectRemoteCurrent(handle, input.scope);
    const raw = new Database(handle.databasePath);
    try {
      const table =
        missing === 'receipt'
          ? 'operations'
          : missing === 'selection'
            ? 'remote_current'
            : 'remote_outcomes';
      const triggers = raw
        .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
        .all(table) as Array<{ name: string; sql: string }>;
      raw.pragma('foreign_keys = OFF');
      for (const trigger of triggers) raw.exec(`DROP TRIGGER ${trigger.name}`);
      const predicate =
        missing === 'receipt'
          ? 'WHERE operation_id=?'
          : missing === 'outcome'
            ? 'WHERE outcome_id=?'
            : '';
      raw
        .prepare(`DELETE FROM ${table} ${predicate}`)
        .run(
          ...(missing === 'selection'
            ? []
            : [missing === 'receipt' ? outcome.operationId : outcome.outcomeId])
        );
      for (const trigger of triggers) raw.exec(trigger.sql);
      raw.pragma('foreign_keys = ON');
      const counts = raw
        .prepare(
          `SELECT (SELECT count(*) FROM remote_requests) AS requests,(SELECT count(*) FROM remote_attempts) AS attempts,(SELECT count(*) FROM remote_outcomes) AS outcomes,(SELECT count(*) FROM remote_current) AS selections,(SELECT count(*) FROM operations) AS receipts`
        )
        .get();
      expect(() => readProjectRemoteCurrent(handle, input.scope)).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
      expect(() => readProjectRemoteRequest(handle, input.requestId)).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
      expect(
        raw
          .prepare(
            `SELECT (SELECT count(*) FROM remote_requests) AS requests,(SELECT count(*) FROM remote_attempts) AS attempts,(SELECT count(*) FROM remote_outcomes) AS outcomes,(SELECT count(*) FROM remote_current) AS selections,(SELECT count(*) FROM operations) AS receipts`
          )
          .get()
      ).toEqual(counts);
      expect(handle.read(() => null).counters).toEqual(before.counters);
    } finally {
      raw.close();
    }
  }
);
it('returns absent only for never-retained identities and refuses malformed selectors before SQL', async () => {
  const { handle } = await fixture();
  expect(readProjectRemoteRequest(handle, uuidv7()).value).toBeNull();
  expect(readProjectRemoteCurrent(handle, request().scope).value).toBeNull();
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  expect(() => readProjectRemoteRequest(handle, '')).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(() =>
    readProjectRemoteCurrent(handle, null as unknown as ProjectRemoteRequestInput['scope'])
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(prepare).not.toHaveBeenCalled();
});
it('rolls back outcome and selection together and retries the original observation', async () => {
  const { handle } = await fixture();
  const { input, result } = await admitted(handle);
  const outcome = observation(input, result.value.selection, 'ack_unknown');
  const prepare = Database.prototype.prepare;
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.startsWith('UPDATE remote_current'))
      throw new Error('Injected outcome selection failure');
    return prepare.call(this, sql);
  });
  await expect(recordProjectRemoteOutcome(handle, outcome, refusal)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
  });
  spy.mockRestore();
  expect(readProjectRemoteRequest(handle, input.requestId).value!.outcomes).toEqual([]);
  expect(handle.read(() => null).counters).toEqual(result.counters);
  expect(await recordProjectRemoteOutcome(handle, outcome, refusal)).toMatchObject({
    replayed: false,
  });
});

it('reads original explicitly allowed bytes without applying authored refusal again', async () => {
  const { handle } = await fixture();
  const input = request();
  const sample = 'ghp_' + 'b'.repeat(36);
  input.payloadBytes = Buffer.from(JSON.stringify({ body: sample }));
  await retainProjectRemoteRequest(handle, input, { secretAllow: [sample] });
  const guard = vi.spyOn(secretGuard, 'assertNoSecretsInPayload').mockImplementation(() => {
    throw new Error('Authored refusal must not run on a retained read');
  });
  expect(readProjectRemoteRequest(handle, input.requestId).value!.request.payloadBytes).toEqual(
    input.payloadBytes
  );
  expect(readProjectRemoteCurrent(handle, input.scope).value!.request.payloadBytes).toEqual(
    input.payloadBytes
  );
  expect(guard).not.toHaveBeenCalled();
});
