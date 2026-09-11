import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

import type { ProjectArtifactPushInput } from './artifact-push-input.js';
import { readProjectArtifactPush, readProjectArtifactPushCurrent } from './artifact-push-reader.js';
import { completeProjectArtifactPush } from './artifact-push-terminal.js';
import { beginProjectArtifactPush } from './artifact-push.js';
import { appendProjectArtifactEvents, readProjectArtifact } from './artifacts.js';
import { readProjectCloudSyncState, recordProjectCloudSyncFailure } from './cloud-sync.js';
import type { ProjectDatabase } from './connection.js';
import * as transportInput from './remote-transport-input.js';
import { readProjectRemoteRequest } from './remote-transport-reader.js';
import { retainProjectRemoteRequest } from './remote-transport.js';
import * as branchCodec from './session-branch-codec.js';
import { observeProjectSessionBranch, readProjectSessionBranch } from './session-branch.js';
import {
  artifactPushFixture,
  artifactPushRows,
  corruptPushFixture,
  pushOptions,
  pushTarget,
} from '../../../tests/artifact-push-fixture.js';
import {
  acknowledgeCalls as acknowledge,
  admitAttempt as attempt,
  completedPush as completed,
  observeMain,
  observeOutcome,
  renamed,
  renamedAgain,
  retainedPushRows as retained,
  sessionKey,
  sessionPush,
  sessionState,
  terminalInput as terminal,
} from '../../../tests/artifact-push-settlement.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { recordChecksum } from '../event-integrity.js';

type Fixture = Awaited<ReturnType<typeof artifactPushFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((value) => value.close()));
});
async function fixture() {
  const f = await artifactPushFixture();
  fixtures.push(f);
  return f;
}
const integrity = { code: 'HISTORY_INTEGRITY_REQUIRED' };
const conflict = { code: 'IDEMPOTENCY_CONFLICT' };
const incomplete = {
  code: 'STALE_CONTEXT',
  message: expect.stringMatching(/resume it so unsent calls can run.*orcaops push-status/i),
};
function successor(f: Fixture, previous: ProjectArtifactPushInput) {
  const next = f.input();
  next.expectedPushSelection = { pushId: previous.pushId, version: 1 };
  next.expectedCloudSelection = readProjectCloudSyncState(
    f.handle,
    f.artifactId,
    pushTarget
  )!.selection;
  return next;
}
async function reviseArtifact(f: Fixture) {
  const snapshot = readProjectArtifact(f.handle, f.artifactId)!;
  const revised = {
    ...snapshot.thread.plan!,
    label: 'Revised plan',
    revision_n: 1,
    revised_at: '2026-09-01T00:00:05Z',
    rationale: 'Clarified intent',
    prior_plan_event_id: snapshot.thread.plan!.source_event_id,
  };
  const record = {
    event_id: uuidv7(),
    type: 'plan_revised',
    ts: '2026-09-01T00:00:05Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: revised,
  };
  await appendProjectArtifactEvents(f.handle, {
    operationId: uuidv7(),
    artifactId: f.artifactId,
    expectedRevision: snapshot.revision,
    eventBytes: Buffer.from(JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  });
}
function failure(f: Fixture, attemptStartedAt = '2026-09-01T00:00:04Z') {
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    artifactId: f.artifactId,
    target: pushTarget,
    kind: 'network' as const,
    message: 'original failure',
    attemptedAt: '2026-09-01T00:00:05Z',
    attemptStartedAt,
  };
}
it('settles actual acknowledged calls under the original terminal and replays its result', async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  await acknowledge(f, input);
  const before = artifactPushRows(f.handle).counters;
  const settled = await completeProjectArtifactPush(f.handle, terminal(input));
  expect(settled).toMatchObject({
    replayed: false,
    value: { pushId: input.pushId, sessionApplied: null, cloudApplied: true, result: input.result },
    counters: {
      writeSequence: before.writeSequence + 1,
      intentChangeCounter: before.intentChangeCounter,
    },
  });
  expect(readProjectArtifactPush(f.handle, input.pushId).value!.terminal!.result).toEqual(
    settled.value
  );
  expect(readProjectCloudSyncState(f.handle, f.artifactId, pushTarget)).toMatchObject({
    pending: false,
    consecutiveFailures: 0,
    lastError: null,
    publicState: { hash: input.artifactPayloadHash },
  });
  const rows = retained(f.handle);
  expect(await completeProjectArtifactPush(f.handle, terminal(input))).toMatchObject({
    replayed: true,
    value: settled.value,
  });
  expect(retained(f.handle)).toEqual(rows);
});
it('retains a genuine session acknowledgment in the same terminal operation', async () => {
  const f = await fixture(),
    { input } = await sessionPush(f);
  await acknowledge(f, input);
  const result = await completeProjectArtifactPush(f.handle, terminal(input));
  expect(result.value).toMatchObject({ sessionApplied: true, cloudApplied: true });
  expect(readProjectSessionBranch(f.handle, sessionKey)).toMatchObject({
    selection: { revisionId: input.session!.resultRevisionId, version: 2 },
    state: {
      current_branch: 'main',
      branch_history: [],
      last_acked_at: result.value.acknowledgedAt,
    },
  });
  expect(readProjectArtifactPush(f.handle, input.pushId).value!.terminal!.result).toEqual(
    result.value
  );
});
it('refuses incomplete transport without creating any local acknowledgment', async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  const before = retained(f.handle);
  await expect(completeProjectArtifactPush(f.handle, terminal(input))).rejects.toMatchObject(
    incomplete
  );
  expect(retained(f.handle)).toEqual(before);
  expect(before.value.terminals).toEqual([]);
  expect(before.value.cloudRecords).toEqual([]);
});
it.each(['unsent', 'admitted without outcome', 'ack_unknown'] as const)(
  'refuses a %s second call as partial delivery and completes once it is acknowledged',
  async (state) => {
    const f = await fixture(),
      input = f.input();
    await beginProjectArtifactPush(f.handle, input, pushOptions);
    await acknowledge(f, input, [0]);
    const second = input.calls[1]!;
    const admitted = state === 'unsent' ? null : await attempt(f.handle, second.requestId);
    const unknown =
      state === 'ack_unknown'
        ? await observeOutcome(f.handle, second.requestId, admitted!.attemptId, 'ack_unknown')
        : null;
    const before = retained(f.handle);
    await expect(completeProjectArtifactPush(f.handle, terminal(input))).rejects.toMatchObject(
      incomplete
    );
    expect(retained(f.handle)).toEqual(before);
    const sent = admitted ?? (await attempt(f.handle, second.requestId));
    const acknowledged = await observeOutcome(
      f.handle,
      second.requestId,
      sent.attemptId,
      'acknowledged'
    );
    const settled = await completeProjectArtifactPush(f.handle, terminal(input));
    expect(settled.value).toMatchObject({ cloudApplied: true, sessionApplied: null });
    expect(retained(f.handle).value.terminalCalls).toEqual([
      expect.objectContaining({ ordinal: 1 }),
      expect.objectContaining({
        ordinal: 2,
        attempt_id: sent.attemptId,
        outcome_id: acknowledged.outcomeId,
      }),
    ]);
    if (unknown)
      expect(
        retained(f.handle).value.outcomes.map((row) => (row as { kind: string }).kind)
      ).toEqual(expect.arrayContaining(['ack_unknown', 'acknowledged']));
  }
);
it("completes from each original request's own acknowledged outcome after its slot moved on", async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  await acknowledge(f, input);
  const first = readProjectRemoteRequest(f.handle, input.calls[0]!.requestId).value!;
  await retainProjectRemoteRequest(
    f.handle,
    {
      operationId: uuidv7(),
      requestId: uuidv7(),
      scope: first.request.scope,
      expectedSelection: first.current,
      payloadBytes: Buffer.from(JSON.stringify({ externalId: f.artifactId, later: true })),
      preparedAt: '2026-09-01T00:00:06Z',
    },
    pushOptions
  );
  const moved = readProjectRemoteRequest(f.handle, input.calls[0]!.requestId).value!;
  expect(moved.current.requestId).not.toBe(input.calls[0]!.requestId);
  const settled = await completeProjectArtifactPush(f.handle, terminal(input));
  expect(settled.value).toMatchObject({ cloudApplied: true, sessionApplied: null });
  expect(retained(f.handle).value.terminalCalls[0]).toMatchObject({
    ordinal: 1,
    request_id: input.calls[0]!.requestId,
    outcome_id: moved.outcomes.find((row) => row.kind === 'acknowledged')!.outcomeId,
  });
  expect(readProjectArtifactPush(f.handle, input.pushId).value!.terminal!.result).toEqual(
    settled.value
  );
});
it('leaves the session unapplied when its selection changed after admission while the cloud applies', async () => {
  const f = await fixture(),
    { input, selection } = await sessionPush(f);
  const later = await observeProjectSessionBranch(f.handle, renamed(selection), pushOptions);
  await acknowledge(f, input);
  const settled = await completeProjectArtifactPush(f.handle, terminal(input));
  expect(settled.value).toMatchObject({ sessionApplied: false, cloudApplied: true });
  const rows = retained(f.handle).value;
  expect(rows.sessionRevisions).toHaveLength(2);
  expect(rows.sessionAcks).toEqual([
    expect.objectContaining({
      acknowledgement_id: input.session!.acknowledgementId,
      push_id: input.pushId,
      expected_revision_id: selection.revisionId,
      expected_version: 1,
      applied: 0,
      result_revision_id: null,
      acked_at: settled.value.acknowledgedAt,
    }),
  ]);
  expect(rows.terminals[0]).toMatchObject({ session_applied: 0, cloud_applied: 1 });
  expect(readProjectSessionBranch(f.handle, sessionKey)).toMatchObject({
    selection: later.value.selection,
    state: { current_branch: 'renamed', branch_history: ['main'], last_acked_at: null },
  });
  expect(readProjectArtifactPush(f.handle, input.pushId).value!.terminal!.result).toEqual(
    settled.value
  );
  const retainedRows = retained(f.handle);
  expect(await completeProjectArtifactPush(f.handle, terminal(input))).toMatchObject({
    replayed: true,
    value: settled.value,
  });
  expect(retained(f.handle)).toEqual(retainedRows);
});
it('leaves the cloud unapplied when its selection changed after admission while the session applies', async () => {
  const f = await fixture(),
    { input } = await sessionPush(f);
  const failed = await recordProjectCloudSyncFailure(f.handle, failure(f), pushOptions);
  await acknowledge(f, input);
  const settled = await completeProjectArtifactPush(f.handle, terminal(input));
  expect(settled.value).toMatchObject({ sessionApplied: true, cloudApplied: false });
  expect(readProjectCloudSyncState(f.handle, f.artifactId, pushTarget)).toMatchObject({
    selection: failed.value.selection,
    publicState: null,
    consecutiveFailures: 1,
    pending: true,
  });
  expect(readProjectSessionBranch(f.handle, sessionKey)).toMatchObject({
    selection: { revisionId: input.session!.resultRevisionId, version: 2 },
    state: { branch_history: [], last_acked_at: settled.value.acknowledgedAt },
  });
  const rows = retained(f.handle).value;
  expect(
    rows.cloudRecords.find((row) => (row as { push_id: string }).push_id === input.pushId)
  ).toMatchObject({ applied: 0, previous_revision_id: null, previous_version: null });
  expect(rows.terminals[0]).toMatchObject({ session_applied: 1, cloud_applied: 0 });
  expect(readProjectArtifactPush(f.handle, input.pushId).value!.terminal!.result).toEqual(
    settled.value
  );
});
it.each(['another artifact usage append', 'unrelated non-usage writes'] as const)(
  'holds the cloud result at applied:false only for %s after admission',
  async (change) => {
    const f = await fixture(),
      input = f.input();
    await beginProjectArtifactPush(f.handle, input, pushOptions);
    const other = await f.artifact();
    if (change === 'another artifact usage append') await f.usage(other.artifactId);
    else
      await observeMain(f.handle, {
        ...sessionKey,
        repoUrl: 'ssh://example.test/unrelated',
      });
    await acknowledge(f, input);
    const settled = await completeProjectArtifactPush(f.handle, terminal(input));
    const applied = change === 'unrelated non-usage writes';
    expect(settled.value).toMatchObject({ cloudApplied: applied, sessionApplied: null });
    expect(readProjectCloudSyncState(f.handle, f.artifactId, pushTarget)).toMatchObject({
      pending: !applied,
      publicState: applied ? { hash: input.artifactPayloadHash } : null,
    });
    expect(readProjectArtifactPush(f.handle, input.pushId).value!.terminal!.result).toEqual(
      settled.value
    );
  }
);
it('holds the cloud result at applied:false when the source revision changes under an equal payload hash', async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  await reviseArtifact(f);
  await acknowledge(f, input);
  const settled = await completeProjectArtifactPush(f.handle, terminal(input));
  expect(settled.value).toMatchObject({ cloudApplied: false });
  expect(readProjectCloudSyncState(f.handle, f.artifactId, pushTarget)).toMatchObject({
    pending: true,
    publicState: null,
    sources: { artifactGeneration: 2 },
  });
  expect(readProjectArtifactPush(f.handle, input.pushId).value!.input.artifactRevision).toEqual(
    input.artifactRevision
  );
  const rows = retained(f.handle);
  expect((await completeProjectArtifactPush(f.handle, terminal(input))).value).toEqual(
    settled.value
  );
  expect(retained(f.handle)).toEqual(rows);
});
it('replays the exact original terminal result after a later push is selected', async () => {
  const f = await fixture(),
    { input: first, result: original } = await completed(f);
  const next = successor(f, first);
  await beginProjectArtifactPush(f.handle, next, pushOptions);
  const pendingRows = retained(f.handle);
  expect(await completeProjectArtifactPush(f.handle, terminal(first))).toMatchObject({
    replayed: true,
    value: original.value,
  });
  expect(retained(f.handle)).toEqual(pendingRows);
  await acknowledge(f, next);
  const second = await completeProjectArtifactPush(f.handle, terminal(next));
  expect(second.value).toMatchObject({ cloudApplied: true });
  expect(readProjectCloudSyncState(f.handle, f.artifactId, pushTarget)!.selection).toEqual({
    revisionId: next.cloudAcknowledgementId,
    version: 2,
  });
  const rows = retained(f.handle);
  expect(await completeProjectArtifactPush(f.handle, terminal(first))).toMatchObject({
    replayed: true,
    value: original.value,
  });
  expect(readProjectArtifactPush(f.handle, first.pushId).value!.terminal!.result).toEqual(
    original.value
  );
  expect(
    readProjectArtifactPushCurrent(f.handle, f.artifactId, pushTarget).value!.input.pushId
  ).toBe(next.pushId);
  expect(retained(f.handle)).toEqual(rows);
});
it('serializes two writers on one terminal identity and retains one settlement', async () => {
  const f = await fixture(),
    input = f.input(),
    other = await f.open();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  await acknowledge(f, input);
  const waiting = new Set<string>();
  f.db.exec('BEGIN IMMEDIATE');
  const wait = (name: string) => {
    waiting.add(name);
    if (waiting.size === 2 && f.db.inTransaction) f.db.exec('ROLLBACK');
  };
  const results = await Promise.all([
    completeProjectArtifactPush(f.handle, terminal(input), { onWait: () => wait('first') }),
    completeProjectArtifactPush(other, terminal(input), { onWait: () => wait('second') }),
  ]);
  expect(waiting.size).toBe(2);
  expect(results.map((value) => value.replayed).sort()).toEqual([false, true]);
  expect(results[0]!.value).toEqual(results[1]!.value);
  const rows = retained(f.handle).value;
  expect(rows.terminals).toHaveLength(1);
  expect(rows.cloudRecords).toHaveLength(1);
});
it('cancels a real admission wait without settlement and completes on retry with the original identities', async () => {
  const f = await fixture(),
    input = f.input(),
    controller = new AbortController();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  await acknowledge(f, input);
  const before = retained(f.handle);
  f.db.exec('BEGIN IMMEDIATE');
  await expect(
    completeProjectArtifactPush(f.handle, terminal(input), {
      signal: controller.signal,
      onWait: () => controller.abort(),
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  f.db.exec('ROLLBACK');
  expect(retained(f.handle)).toEqual(before);
  const settled = await completeProjectArtifactPush(f.handle, terminal(input));
  expect(settled).toMatchObject({ replayed: false, value: { cloudApplied: true } });
  expect(retained(f.handle).value.terminals).toEqual([
    expect.objectContaining({ push_id: input.pushId, operation_id: input.terminalOperationId }),
  ]);
});
it('rolls back partial terminal call insertion and keeps the connection usable', async () => {
  const f = await fixture(),
    input = f.input(),
    other = await f.open('reader');
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  const [, second] = await acknowledge(f, input);
  const foreign = uuidv7();
  let before: ReturnType<typeof retained> | null = null;
  f.db.exec('BEGIN IMMEDIATE');
  await expect(
    completeProjectArtifactPush(f.handle, terminal(input), {
      onWait() {
        if (before) return;
        f.db.exec('ROLLBACK');
        corruptPushFixture(f.db, () =>
          f.db
            .prepare('INSERT INTO artifact_push_terminal_calls VALUES (?,?,?,?,?)')
            .run(foreign, 1, uuidv7(), second!.attemptId, uuidv7())
        );
        before = retained(other);
      },
    })
  ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
  expect(before).not.toBeNull();
  expect(retained(f.handle)).toEqual(before);
  expect(retained(f.handle).value.terminalCalls).toHaveLength(1);
  corruptPushFixture(f.db, () =>
    f.db.prepare('DELETE FROM artifact_push_terminal_calls WHERE push_id=?').run(foreign)
  );
  const settled = await completeProjectArtifactPush(f.handle, terminal(input));
  expect(settled).toMatchObject({ replayed: false, value: { cloudApplied: true } });
  expect(retained(f.handle).value.terminalCalls).toHaveLength(2);
});
it('refuses wrong and cross-family terminal identities and an unretained push', async () => {
  const f = await fixture(),
    input = f.input(),
    other = f.input();
  other.target.account_id = 'other account';
  const sessionOperationId = uuidv7();
  await observeProjectSessionBranch(
    f.handle,
    {
      operationId: sessionOperationId,
      revisionId: uuidv7(),
      key: sessionKey,
      expectedSelection: null,
      stateBytes: Buffer.from(JSON.stringify(sessionState('main'))),
      observation: { headOid: 'a'.repeat(40), priorBranchExists: null },
    },
    pushOptions
  );
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  await beginProjectArtifactPush(f.handle, other, pushOptions);
  await acknowledge(f, input);
  await acknowledge(f, other);
  const before = retained(f.handle);
  for (const wrong of [
    { pushId: input.pushId, operationId: uuidv7() },
    { pushId: input.pushId, operationId: input.operationId },
    { pushId: input.pushId, operationId: sessionOperationId },
    { pushId: input.pushId, operationId: other.terminalOperationId },
    { pushId: other.pushId, operationId: input.terminalOperationId },
    { pushId: uuidv7(), operationId: input.terminalOperationId },
  ])
    await expect(completeProjectArtifactPush(f.handle, wrong)).rejects.toMatchObject(conflict);
  await expect(
    completeProjectArtifactPush(f.handle, { pushId: uuidv7(), operationId: uuidv7() })
  ).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
    message: expect.stringMatching(/^No retained push/),
  });
  expect(retained(f.handle)).toEqual(before);
  const settled = await completeProjectArtifactPush(f.handle, terminal(input));
  await expect(
    completeProjectArtifactPush(f.handle, {
      pushId: other.pushId,
      operationId: input.terminalOperationId,
    })
  ).rejects.toMatchObject(conflict);
  expect(retained(f.handle).value.terminals).toEqual([
    expect.objectContaining({ operation_id: settled.value.pushId && input.terminalOperationId }),
  ]);
});
it('guards counterfeit and readonly handles before settlement', async () => {
  const read = vi.fn(),
    fake = { read } as unknown as ProjectDatabase;
  await expect(
    completeProjectArtifactPush(fake, { pushId: uuidv7(), operationId: uuidv7() })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(read).not.toHaveBeenCalled();
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  await acknowledge(f, input);
  const reader = await f.open('reader'),
    before = retained(f.handle);
  await expect(completeProjectArtifactPush(reader, terminal(input))).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  expect(retained(f.handle)).toEqual(before);
  await completeProjectArtifactPush(f.handle, terminal(input));
  expect(readProjectArtifactPush(reader, input.pushId)).toEqual(
    readProjectArtifactPush(f.handle, input.pushId)
  );
  expect(readProjectArtifactPush(reader, input.pushId).value!.terminal).not.toBeNull();
});
it.each(['header', 'current', 'member', 'admission receipt'] as const)(
  'refuses a lost original %s before completion instead of reporting partial delivery',
  async (loss) => {
    const f = await fixture(),
      input = f.input();
    await beginProjectArtifactPush(f.handle, input, pushOptions);
    await acknowledge(f, input);
    corruptPushFixture(f.db, () => {
      if (loss === 'header') f.db.exec('DELETE FROM artifact_push_requests');
      if (loss === 'current') f.db.exec('DELETE FROM artifact_push_current');
      if (loss === 'member')
        f.db
          .prepare('DELETE FROM remote_requests WHERE request_id=?')
          .run(input.calls[0]!.requestId);
      if (loss === 'admission receipt')
        f.db.prepare('DELETE FROM operations WHERE operation_id=?').run(input.operationId);
    });
    const before = retained(f.handle);
    await expect(completeProjectArtifactPush(f.handle, terminal(input))).rejects.toMatchObject(
      integrity
    );
    expect(retained(f.handle)).toEqual(before);
  }
);
it.each([
  'terminal receipt',
  'admission receipt',
  'terminal row',
  'terminal call',
  'member request',
  'header',
  'current',
  'original bytes',
  'outcome',
  'result',
  'cloud acknowledgment',
  'session acknowledgment',
  'session result revision',
] as const)(
  'refuses a corrupted %s after completion for the reader and for terminal replay',
  async (corruption) => {
    const f = await fixture(),
      { input } = await sessionPush(f);
    await acknowledge(f, input, [0]);
    const second = input.calls[1]!,
      sent = await attempt(f.handle, second.requestId),
      unknown = await observeOutcome(f.handle, second.requestId, sent.attemptId, 'ack_unknown');
    await observeOutcome(f.handle, second.requestId, sent.attemptId, 'acknowledged');
    await completeProjectArtifactPush(f.handle, terminal(input));
    corruptPushFixture(f.db, () => {
      const run = (sql: string, ...parameters: unknown[]) => f.db.prepare(sql).run(...parameters);
      if (corruption === 'terminal receipt')
        run('DELETE FROM operations WHERE operation_id=?', input.terminalOperationId);
      if (corruption === 'admission receipt')
        run('DELETE FROM operations WHERE operation_id=?', input.operationId);
      if (corruption === 'terminal row')
        run('DELETE FROM artifact_push_terminals WHERE push_id=?', input.pushId);
      if (corruption === 'terminal call')
        run('DELETE FROM artifact_push_terminal_calls WHERE push_id=? AND ordinal=2', input.pushId);
      if (corruption === 'member request')
        run('DELETE FROM remote_requests WHERE request_id=?', second.requestId);
      if (corruption === 'header')
        run('DELETE FROM artifact_push_requests WHERE push_id=?', input.pushId);
      if (corruption === 'current') f.db.exec('DELETE FROM artifact_push_current');
      if (corruption === 'original bytes')
        run(
          'UPDATE remote_requests SET payload_bytes=? WHERE request_id=?',
          Buffer.from('{}'),
          input.calls[0]!.requestId
        );
      if (corruption === 'outcome')
        run(
          'UPDATE artifact_push_terminal_calls SET outcome_id=? WHERE push_id=? AND ordinal=2',
          unknown.outcomeId,
          input.pushId
        );
      if (corruption === 'result')
        run(
          "UPDATE operations SET result_json=json_set(result_json,'$.cloudApplied',json('false')) WHERE operation_id=?",
          input.terminalOperationId
        );
      if (corruption === 'cloud acknowledgment')
        run('DELETE FROM cloud_sync_records WHERE push_id=?', input.pushId);
      if (corruption === 'session acknowledgment')
        run('DELETE FROM session_branch_acknowledgements WHERE push_id=?', input.pushId);
      if (corruption === 'session result revision')
        run(
          'DELETE FROM session_branch_revisions WHERE revision_id=?',
          input.session!.resultRevisionId
        );
    });
    const before = retained(f.handle);
    expect(() => readProjectArtifactPush(f.handle, input.pushId)).toThrowError(
      expect.objectContaining(integrity)
    );
    await expect(completeProjectArtifactPush(f.handle, terminal(input))).rejects.toMatchObject(
      integrity
    );
    expect(retained(f.handle)).toEqual(before);
  }
);
it('settles a session whose selection changed after preflight without decoding its opaque state in the transaction', async () => {
  const f = await fixture(),
    { input, selection } = await sessionPush(f),
    other = await f.open();
  await acknowledge(f, input);
  const connections = new Set<Database.Database>();
  const exec = Database.prototype.exec;
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    connections.add(this);
    return exec.call(this, sql);
  });
  // The raw fixture connection only holds the admission lock; the probe is
  // about the handles' own connections.
  const inTransaction = () =>
    [...connections].some((database) => database !== f.db && database.inTransaction);
  const observations: boolean[] = [];
  const decodeSession = branchCodec.decodeRetainedSessionBranch;
  vi.spyOn(branchCodec, 'decodeRetainedSessionBranch').mockImplementation((value) => {
    observations.push(inTransaction());
    return decodeSession(value);
  });
  const decodeRequest = transportInput.decodeRetainedRemoteRequest;
  vi.spyOn(transportInput, 'decodeRetainedRemoteRequest').mockImplementation((...args) => {
    observations.push(inTransaction());
    return decodeRequest(...args);
  });
  let rename: ReturnType<typeof observeProjectSessionBranch> | null = null;
  f.db.exec('BEGIN IMMEDIATE');
  const settled = await completeProjectArtifactPush(f.handle, terminal(input), {
    onWait() {
      if (rename) return;
      f.db.exec('ROLLBACK');
      rename = observeProjectSessionBranch(other, renamed(selection), pushOptions);
    },
  });
  const later = await rename!;
  expect(later.replayed).toBe(false);
  expect(settled.counters.writeSequence).toBe(later.counters.writeSequence + 1);
  expect(settled.value).toMatchObject({ sessionApplied: false, cloudApplied: true });
  expect(observations.length).toBeGreaterThan(0);
  expect(observations.every((value) => !value)).toBe(true);
  expect(readProjectSessionBranch(f.handle, sessionKey)).toMatchObject({
    selection: later.value.selection,
    state: { current_branch: 'renamed' },
  });
  expect(retained(f.handle).value.sessionAcks[0]).toMatchObject({ applied: 0 });
});
it('refuses a current session whose receipt hash changed after preflight without writing', async () => {
  const f = await fixture(),
    { input, selection } = await sessionPush(f),
    other = await f.open(),
    rename = renamed(selection);
  await acknowledge(f, input);
  let before: ReturnType<typeof retained> | null = null;
  f.db.exec('BEGIN IMMEDIATE');
  await expect(
    completeProjectArtifactPush(f.handle, terminal(input), {
      onWait() {
        if (before) return;
        f.db.exec('ROLLBACK');
        void observeProjectSessionBranch(other, rename, pushOptions);
        corruptPushFixture(f.db, () =>
          f.db
            .prepare('UPDATE operations SET payload_hash=? WHERE operation_id=?')
            .run('0'.repeat(64), rename.operationId)
        );
        before = retained(other);
      },
    })
  ).rejects.toMatchObject(integrity);
  expect(before).not.toBeNull();
  expect(retained(f.handle)).toEqual(before);
  expect(retained(f.handle).value.terminals).toEqual([]);
});
it('refuses a current session owner relabeled onto a genuine acknowledgment after preflight without writing', async () => {
  const f = await fixture(),
    other = await f.open();
  const { input: first, selection } = await sessionPush(f);
  const renamedOnce = await observeProjectSessionBranch(f.handle, renamed(selection), pushOptions);
  await acknowledge(f, first);
  expect((await completeProjectArtifactPush(f.handle, terminal(first))).value.sessionApplied).toBe(
    false
  );
  const input = successor(f, first);
  input.session = {
    key: sessionKey,
    expectedSelection: renamedOnce.value.selection,
    acknowledgementId: uuidv7(),
    resultRevisionId: uuidv7(),
  };
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  await acknowledge(f, input);
  const second = await f.artifact(),
    borrowed = f.input();
  borrowed.artifactId = second.artifactId;
  borrowed.artifactRevision = second.revision;
  borrowed.calls.forEach((call, index) => {
    call.targetExternalId = second.artifactId;
    call.payloadBytes = Buffer.from(
      JSON.stringify(
        index === 0 ? { externalId: second.artifactId } : { artifact_id: second.artifactId }
      )
    );
  });
  borrowed.session = {
    key: sessionKey,
    expectedSelection: renamedOnce.value.selection,
    acknowledgementId: uuidv7(),
    resultRevisionId: uuidv7(),
  };
  await beginProjectArtifactPush(f.handle, borrowed, pushOptions);
  const renamedTwice = await observeProjectSessionBranch(
    f.handle,
    renamedAgain(renamedOnce.value.selection),
    pushOptions
  );
  await acknowledge(f, borrowed);
  expect(
    (await completeProjectArtifactPush(f.handle, terminal(borrowed))).value.sessionApplied
  ).toBe(false);
  let before: ReturnType<typeof retained> | null = null;
  f.db.exec('BEGIN IMMEDIATE');
  await expect(
    completeProjectArtifactPush(f.handle, terminal(input), {
      onWait() {
        if (before) return;
        f.db.exec('ROLLBACK');
        corruptPushFixture(f.db, () =>
          f.db
            .prepare(
              "UPDATE session_branch_revisions SET origin_kind='acknowledgement',acknowledgement_id=? WHERE revision_id=?"
            )
            .run(borrowed.session!.acknowledgementId, renamedTwice.value.selection.revisionId)
        );
        before = retained(other);
      },
    })
  ).rejects.toMatchObject(integrity);
  expect(before).not.toBeNull();
  expect(retained(f.handle)).toEqual(before);
  expect(
    retained(f.handle).value.sessionAcks.some(
      (row) => (row as { push_id: string }).push_id === input.pushId
    )
  ).toBe(false);
});
it('settles a cloud failure recorded after preflight as an unapplied acknowledgment', async () => {
  const f = await fixture(),
    input = f.input(),
    other = await f.open();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  await acknowledge(f, input);
  let failed: ReturnType<typeof recordProjectCloudSyncFailure> | null = null;
  f.db.exec('BEGIN IMMEDIATE');
  const settled = await completeProjectArtifactPush(f.handle, terminal(input), {
    onWait() {
      if (failed) return;
      f.db.exec('ROLLBACK');
      failed = recordProjectCloudSyncFailure(other, failure(f), pushOptions);
    },
  });
  const failure1 = await failed!;
  expect(settled.counters.writeSequence).toBe(failure1.counters.writeSequence + 1);
  expect(settled.value).toMatchObject({ cloudApplied: false, sessionApplied: null });
  expect(readProjectCloudSyncState(f.handle, f.artifactId, pushTarget)).toMatchObject({
    selection: failure1.value.selection,
    consecutiveFailures: 1,
    pending: true,
  });
  expect(readProjectArtifactPush(f.handle, input.pushId).value!.terminal!.result).toEqual(
    settled.value
  );
});
it('keeps the reserved session result and cloud acknowledgment identities after an unapplied settlement', async () => {
  const f = await fixture(),
    { input, selection } = await sessionPush(f);
  const later = await observeProjectSessionBranch(f.handle, renamed(selection), pushOptions);
  await acknowledge(f, input);
  await recordProjectCloudSyncFailure(f.handle, failure(f), pushOptions);
  const settled = await completeProjectArtifactPush(f.handle, terminal(input));
  expect(settled.value).toMatchObject({ sessionApplied: false, cloudApplied: false });
  const before = retained(f.handle);
  await expect(
    observeProjectSessionBranch(
      f.handle,
      { ...renamedAgain(later.value.selection), revisionId: input.session!.resultRevisionId },
      pushOptions
    )
  ).rejects.toMatchObject(conflict);
  await expect(
    recordProjectCloudSyncFailure(
      f.handle,
      { ...failure(f), revisionId: input.cloudAcknowledgementId },
      pushOptions
    )
  ).rejects.toMatchObject(conflict);
  expect(retained(f.handle)).toEqual(before);
});
