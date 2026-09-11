import { afterEach, expect, it, vi } from 'vitest';

import { readProjectArtifactPush, readProjectArtifactPushCurrent } from './artifact-push-reader.js';
import { beginProjectArtifactPush } from './artifact-push.js';
import { readProjectCloudSyncStatus } from './cloud-sync-status.js';
import { recordProjectCloudSyncFailure } from './cloud-sync.js';
import type { ProjectDatabase } from './connection.js';
import { readProjectRemoteRequest } from './remote-transport-reader.js';
import { admitProjectRemoteAttempt, recordProjectRemoteOutcome } from './remote-transport.js';
import { observeProjectSessionBranch } from './session-branch.js';
import { runProjectOperation } from './transactions.js';
import {
  artifactPushFixture,
  artifactPushRows,
  corruptPushFixture,
  pushOptions,
  pushTarget,
} from '../../../tests/artifact-push-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const fixtures: Awaited<ReturnType<typeof artifactPushFixture>>[] = [];
async function fixture() {
  const value = await artifactPushFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((value) => value.close()));
});
const integrity = { code: 'HISTORY_INTEGRITY_REQUIRED' };
it('reports a retained unfinished push without changing its pending state', async () => {
  const f = await fixture();
  await beginProjectArtifactPush(f.handle, f.input(), pushOptions);
  const before = artifactPushRows(f.handle);
  expect(readProjectCloudSyncStatus(f.handle).rows).toMatchObject([
    { artifactId: f.artifactId, target: pushTarget, pending: true, recoveryPending: true },
  ]);
  expect(artifactPushRows(f.handle)).toEqual(before);
});

it('refuses upload status when retained remote calls have lost their push owner', async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  corruptPushFixture(f.db, () => {
    f.db.exec('DELETE FROM artifact_push_current; DELETE FROM artifact_push_requests');
    f.db.prepare('DELETE FROM operations WHERE operation_id=?').run(input.operationId);
  });
  const before = artifactPushRows(f.handle);
  expect(() => readProjectCloudSyncStatus(f.handle)).toThrow(expect.objectContaining(integrity));
  expect(artifactPushRows(f.handle)).toEqual(before);
});

it('admits one genuine group receipt and original ordered remote byte owners', async () => {
  const f = await fixture(),
    input = f.input(),
    before = artifactPushRows(f.handle).counters;
  const admitted = await beginProjectArtifactPush(f.handle, input, pushOptions);
  expect(admitted).toMatchObject({
    replayed: false,
    value: {
      pushId: input.pushId,
      terminalOperationId: input.terminalOperationId,
      selection: { pushId: input.pushId, version: 1 },
      requestIds: input.calls.map((call) => call.requestId),
    },
    counters: {
      writeSequence: before.writeSequence + 1,
      intentChangeCounter: before.intentChangeCounter,
    },
  });
  const read = readProjectArtifactPush(f.handle, input.pushId).value!;
  expect(read.input).toEqual(input);
  expect(read.terminal).toBeNull();
  expect(read.calls).toHaveLength(2);
  read.calls.forEach((call, index) => {
    expect(call.request.operationId).toBe(input.operationId);
    expect(call.request.payloadBytes).toEqual(input.calls[index]!.payloadBytes);
    expect(call.current.version).toBe(1);
  });
  expect(artifactPushRows(f.handle).value.receipts).toHaveLength(2);
  expect(readProjectArtifactPushCurrent(f.handle, f.artifactId, pushTarget).value!.input).toEqual(
    input
  );
});
it('permits actual grouped send admission and acknowledged outcomes without child request receipts', async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  const original = readProjectRemoteRequest(f.handle, input.calls[0]!.requestId).value!;
  const attempt = {
    operationId: uuidv7(),
    attemptId: uuidv7(),
    requestId: original.request.requestId,
    scope: original.request.scope,
    expectedSelection: original.current,
    attemptedAt: '2026-09-01T00:00:02Z',
  };
  const sent = await admitProjectRemoteAttempt(f.handle, attempt, pushOptions);
  expect(sent.sendAllowed).toBe(true);
  const afterAttempt = readProjectRemoteRequest(f.handle, attempt.requestId).value!;
  await recordProjectRemoteOutcome(
    f.handle,
    {
      operationId: uuidv7(),
      outcomeId: uuidv7(),
      requestId: attempt.requestId,
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      expectedSelection: afterAttempt.current,
      observedAt: '2026-09-01T00:00:03Z',
      kind: 'acknowledged',
      responseBytes: Buffer.from('{"accepted":true}'),
      failure: null,
    },
    pushOptions
  );
  const group = readProjectArtifactPush(f.handle, input.pushId).value!;
  expect(group.calls[0]!.outcomes[0]!.kind).toBe('acknowledged');
  expect(group.calls[1]!.attempt).toBeNull();
  expect(group.terminal).toBeNull();
  expect(artifactPushRows(f.handle).value.receipts).toHaveLength(4);
});
it('replays the original admission and refuses changed original bytes', async () => {
  const f = await fixture(),
    input = f.input();
  const first = await beginProjectArtifactPush(f.handle, input, pushOptions),
    before = artifactPushRows(f.handle);
  const replay = await beginProjectArtifactPush(f.handle, input, pushOptions);
  expect(replay.value).toEqual(first.value);
  expect(replay.replayed).toBe(true);
  expect(artifactPushRows(f.handle)).toEqual(before);
  const changed = structuredClone(input);
  changed.calls[0]!.payloadBytes = Buffer.from(
    JSON.stringify({ externalId: input.artifactId, changed: true })
  );
  await expect(beginProjectArtifactPush(f.handle, changed, pushOptions)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(artifactPushRows(f.handle)).toEqual(before);
});
it('guards counterfeit handles before any supplied method', async () => {
  const read = vi.fn(),
    fake = { read } as unknown as ProjectDatabase;
  expect(() => readProjectArtifactPush(fake, uuidv7())).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  const f = await fixture();
  await expect(beginProjectArtifactPush(fake, f.input(), pushOptions)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(read).not.toHaveBeenCalled();
});
it('uses actual readonly claims to read a pending group', async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  const reader = await f.open('reader');
  expect(readProjectArtifactPush(reader, input.pushId)).toEqual(
    readProjectArtifactPush(f.handle, input.pushId)
  );
  expect(readProjectArtifactPushCurrent(reader, f.artifactId, pushTarget).value!.input.pushId).toBe(
    input.pushId
  );
});
it('serializes equal original admission across two writers', async () => {
  const f = await fixture(),
    input = f.input(),
    other = await f.open(),
    waiting = new Set<string>();
  f.db.exec('BEGIN IMMEDIATE');
  const wait = (name: string) => {
    waiting.add(name);
    if (waiting.size === 2 && f.db.inTransaction) f.db.exec('ROLLBACK');
  };
  const results = await Promise.all([
    beginProjectArtifactPush(f.handle, input, {
      ...pushOptions,
      onWait() {
        wait('first');
      },
    }),
    beginProjectArtifactPush(other, input, {
      ...pushOptions,
      onWait() {
        wait('second');
      },
    }),
  ]);
  expect(results.map((value) => value.replayed).sort()).toEqual([false, true]);
  expect(results[0]!.value).toEqual(results[1]!.value);
  expect(artifactPushRows(f.handle).value.headers).toHaveLength(1);
});
it('cancels a real admission wait and retries original copied wire bytes', async () => {
  const f = await fixture(),
    input = f.input(),
    saved = structuredClone(input),
    before = artifactPushRows(f.handle),
    controller = new AbortController();
  f.db.exec('BEGIN IMMEDIATE');
  await expect(
    beginProjectArtifactPush(f.handle, input, {
      ...pushOptions,
      signal: controller.signal,
      onWait() {
        input.calls[0]!.payloadBytes.fill(0);
        controller.abort();
      },
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  f.db.exec('ROLLBACK');
  expect(artifactPushRows(f.handle)).toEqual(before);
  await beginProjectArtifactPush(f.handle, saved, pushOptions);
  expect(
    readProjectArtifactPush(f.handle, saved.pushId).value!.input.calls[0]!.payloadBytes
  ).toEqual(Buffer.from(saved.calls[0]!.payloadBytes));
});
it('refuses source changes and an already pending original group', async () => {
  const f = await fixture(),
    input = f.input();
  await f.usage();
  const before = artifactPushRows(f.handle);
  await expect(beginProjectArtifactPush(f.handle, input, pushOptions)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(artifactPushRows(f.handle)).toEqual(before);
  input.usageRevision = f.handle.read((view) =>
    view.get(
      'SELECT generation,ordered_hash AS orderedHash,event_count AS eventCount,byte_length AS byteLength,tail_event_id AS tailEventId FROM usage_revisions WHERE generation=1'
    )
  ).value as typeof input.usageRevision;
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  const other = {
    ...f.input(),
    usageRevision: input.usageRevision,
    expectedPushSelection: { pushId: input.pushId, version: 1 },
  };
  await expect(beginProjectArtifactPush(f.handle, other, pushOptions)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(artifactPushRows(f.handle).value.headers).toHaveLength(1);
});
it.each(['header', 'call', 'current', 'receipt', 'remote selection'] as const)(
  'refuses lost original %s without duplicate admission',
  async (loss) => {
    const f = await fixture(),
      input = f.input();
    await beginProjectArtifactPush(f.handle, input, pushOptions);
    corruptPushFixture(f.db, () => {
      if (loss === 'header') f.db.exec('DELETE FROM artifact_push_requests');
      if (loss === 'call')
        f.db
          .prepare('DELETE FROM remote_requests WHERE request_id=?')
          .run(input.calls[0]!.requestId);
      if (loss === 'current') f.db.exec('DELETE FROM artifact_push_current');
      if (loss === 'receipt')
        f.db.prepare('DELETE FROM operations WHERE operation_id=?').run(input.operationId);
      if (loss === 'remote selection') f.db.exec('DELETE FROM remote_current');
    });
    const before = artifactPushRows(f.handle);
    expect(() => readProjectArtifactPush(f.handle, input.pushId)).toThrowError(
      expect.objectContaining(integrity)
    );
    await expect(beginProjectArtifactPush(f.handle, input, pushOptions)).rejects.toMatchObject(
      integrity
    );
    expect(artifactPushRows(f.handle)).toEqual(before);
  }
);

it('retains copied wire bytes across a successful writer wait', async () => {
  const f = await fixture(),
    input = f.input(),
    saved = structuredClone(input);
  f.db.exec('BEGIN IMMEDIATE');
  await beginProjectArtifactPush(f.handle, input, {
    ...pushOptions,
    onWait() {
      input.calls[0]!.payloadBytes.fill(0);
      f.db.exec('ROLLBACK');
    },
  });
  expect(
    readProjectArtifactPush(f.handle, saved.pushId).value!.input.calls[0]!.payloadBytes
  ).toEqual(Buffer.from(saved.calls[0]!.payloadBytes));
});
it('refuses newly authored secrets before admission and replays already allowed original bytes', async () => {
  const f = await fixture(),
    input = f.input(),
    token = 'ghp_' + 'A'.repeat(36);
  input.calls[0]!.payloadBytes = Buffer.from(
    JSON.stringify({ externalId: f.artifactId, message: token })
  );
  const before = artifactPushRows(f.handle);
  await expect(beginProjectArtifactPush(f.handle, input, pushOptions)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(artifactPushRows(f.handle)).toEqual(before);
  await beginProjectArtifactPush(f.handle, input, { secretAllow: [token] });
  const retained = artifactPushRows(f.handle);
  expect((await beginProjectArtifactPush(f.handle, input, pushOptions)).replayed).toBe(true);
  expect(artifactPushRows(f.handle)).toEqual(retained);
});
it('rolls back the entire group when a later original call identity is occupied', async () => {
  const f = await fixture(),
    original = f.input();
  await beginProjectArtifactPush(f.handle, original, pushOptions);
  const otherArtifact = await f.artifact(),
    next = f.input();
  next.artifactId = otherArtifact.artifactId;
  next.artifactRevision = otherArtifact.revision;
  next.calls.forEach((call, index) => {
    call.targetExternalId = next.artifactId;
    call.payloadBytes = Buffer.from(
      JSON.stringify(
        index === 0 ? { externalId: next.artifactId } : { artifact_id: next.artifactId }
      )
    );
  });
  next.calls[1]!.requestId = original.calls[1]!.requestId;
  const before = artifactPushRows(f.handle);
  await expect(beginProjectArtifactPush(f.handle, next, pushOptions)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(artifactPushRows(f.handle)).toEqual(before);
});
it.each(['admission', 'terminal'] as const)(
  'refuses a new %s identity reserved by another pending group',
  async (kind) => {
    const f = await fixture(),
      original = f.input();
    await beginProjectArtifactPush(f.handle, original, pushOptions);
    const next = f.input();
    next.target.account_id = 'other account';
    next[kind === 'admission' ? 'operationId' : 'terminalOperationId'] =
      original.terminalOperationId;
    const before = artifactPushRows(f.handle);
    await expect(beginProjectArtifactPush(f.handle, next, pushOptions)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(artifactPushRows(f.handle)).toEqual(before);
  }
);
it('protects the pending terminal from a different real operation family', async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  const before = artifactPushRows(f.handle);
  await expect(
    runProjectOperation(
      f.handle,
      {
        operationId: input.terminalOperationId,
        kind: 'test.unrelated',
        intentChange: false,
        target: {},
        payload: {},
        expectedState: {},
      },
      () => ({ accepted: true })
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(artifactPushRows(f.handle)).toEqual(before);
});
it('retains genuine session selection and reserves its original acknowledgment result', async () => {
  const f = await fixture(),
    input = f.input();
  const key = {
    target: pushTarget,
    repoUrl: 'ssh://example.test/original',
    workingDir: '/original checkout',
  };
  const observation = {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    key,
    expectedSelection: null,
    stateBytes: Buffer.from(
      JSON.stringify({
        schema_version: 1,
        target: key.target,
        repo_url: key.repoUrl,
        working_dir: key.workingDir,
        current_branch: 'main',
        branch_history: [],
        base_commit_sha: 'a'.repeat(40),
        last_acked_at: null,
      })
    ),
    observation: { headOid: 'a'.repeat(40), priorBranchExists: null },
  };
  const initial = await observeProjectSessionBranch(f.handle, observation, pushOptions);
  input.session = {
    key,
    expectedSelection: initial.value.selection,
    acknowledgementId: uuidv7(),
    resultRevisionId: uuidv7(),
  };
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  expect(readProjectArtifactPush(f.handle, input.pushId).value!.input.session).toEqual(
    input.session
  );
  const state = JSON.parse(observation.stateBytes.toString());
  const before = artifactPushRows(f.handle);
  await expect(
    observeProjectSessionBranch(
      f.handle,
      {
        ...observation,
        operationId: uuidv7(),
        revisionId: input.session.resultRevisionId,
        expectedSelection: initial.value.selection,
        stateBytes: Buffer.from(JSON.stringify({ ...state, current_branch: 'other' })),
        observation: { headOid: 'a'.repeat(40), priorBranchExists: true },
      },
      pushOptions
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    recordProjectCloudSyncFailure(
      f.handle,
      {
        operationId: uuidv7(),
        revisionId: input.cloudAcknowledgementId,
        artifactId: f.artifactId,
        target: pushTarget,
        kind: 'network',
        message: 'original failure',
        attemptedAt: '2026-09-01T00:00:03Z',
        attemptStartedAt: '2026-09-01T00:00:02Z',
      },
      pushOptions
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(artifactPushRows(f.handle)).toEqual(before);
  await observeProjectSessionBranch(
    f.handle,
    {
      ...observation,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      expectedSelection: initial.value.selection,
      stateBytes: Buffer.from(JSON.stringify({ ...state, current_branch: 'other' })),
      observation: { headOid: 'a'.repeat(40), priorBranchExists: true },
    },
    pushOptions
  );
  expect(readProjectArtifactPush(f.handle, input.pushId).value!.input.session).toEqual(
    input.session
  );
  expect((await beginProjectArtifactPush(f.handle, input, pushOptions)).replayed).toBe(true);
});
it('does not interpret receipt-only history as a fresh group or target', async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  corruptPushFixture(f.db, () => {
    f.db.exec(
      'DELETE FROM remote_current; DELETE FROM remote_requests; DELETE FROM artifact_push_current; DELETE FROM artifact_push_requests'
    );
  });
  const before = artifactPushRows(f.handle);
  expect(() => readProjectArtifactPush(f.handle, input.pushId)).toThrowError(
    expect.objectContaining(integrity)
  );
  expect(() => readProjectArtifactPushCurrent(f.handle, f.artifactId, pushTarget)).toThrowError(
    expect.objectContaining(integrity)
  );
  await expect(beginProjectArtifactPush(f.handle, f.input(), pushOptions)).rejects.toMatchObject(
    integrity
  );
  expect(artifactPushRows(f.handle)).toEqual(before);
});
it.each(['result', 'body', 'hash', 'ordinal'] as const)(
  'refuses inconsistent original %s membership',
  async (corruption) => {
    const f = await fixture(),
      input = f.input();
    await beginProjectArtifactPush(f.handle, input, pushOptions);
    corruptPushFixture(f.db, () => {
      if (corruption === 'result')
        f.db
          .prepare(
            "UPDATE operations SET result_json=json_set(result_json,'$.terminalOperationId',?) WHERE operation_id=?"
          )
          .run(uuidv7(), input.operationId);
      if (corruption === 'body')
        f.db
          .prepare('UPDATE remote_requests SET payload_bytes=? WHERE request_id=?')
          .run(Buffer.from('{}'), input.calls[0]!.requestId);
      if (corruption === 'hash')
        f.db
          .prepare('UPDATE artifact_push_requests SET request_sha256=? WHERE push_id=?')
          .run('0'.repeat(64), input.pushId);
      if (corruption === 'ordinal')
        f.db
          .prepare('UPDATE remote_requests SET call_ordinal=3 WHERE request_id=?')
          .run(input.calls[1]!.requestId);
    });
    const before = artifactPushRows(f.handle);
    expect(() => readProjectArtifactPush(f.handle, input.pushId)).toThrowError(
      expect.objectContaining(integrity)
    );
    expect(() => readProjectRemoteRequest(f.handle, input.calls[0]!.requestId)).toThrowError(
      expect.objectContaining(integrity)
    );
    await expect(beginProjectArtifactPush(f.handle, input, pushOptions)).rejects.toMatchObject(
      integrity
    );
    expect(artifactPushRows(f.handle)).toEqual(before);
  }
);

it('refuses missing original session input behind an otherwise intact pending group', async () => {
  const f = await fixture(),
    input = f.input();
  const key = {
    target: pushTarget,
    repoUrl: 'ssh://example.test/original',
    workingDir: '/original checkout',
  };
  const original = {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    key,
    expectedSelection: null,
    stateBytes: Buffer.from(
      JSON.stringify({
        schema_version: 1,
        target: key.target,
        repo_url: key.repoUrl,
        working_dir: key.workingDir,
        current_branch: 'main',
        branch_history: [],
        base_commit_sha: 'a'.repeat(40),
        last_acked_at: null,
      })
    ),
    observation: { headOid: 'a'.repeat(40), priorBranchExists: null },
  };
  const observed = await observeProjectSessionBranch(f.handle, original, pushOptions);
  input.session = {
    key,
    expectedSelection: observed.value.selection,
    acknowledgementId: uuidv7(),
    resultRevisionId: uuidv7(),
  };
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  corruptPushFixture(f.db, () =>
    f.db
      .prepare('DELETE FROM session_branch_revisions WHERE revision_id=?')
      .run(original.revisionId)
  );
  const before = artifactPushRows(f.handle);
  expect(() => readProjectArtifactPush(f.handle, input.pushId)).toThrowError(
    expect.objectContaining(integrity)
  );
  await expect(beginProjectArtifactPush(f.handle, input, pushOptions)).rejects.toMatchObject(
    integrity
  );
  expect(artifactPushRows(f.handle)).toEqual(before);
});
it('refuses orphaned grouped call rows instead of reporting an absent target', async () => {
  const f = await fixture(),
    input = f.input();
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  corruptPushFixture(f.db, () => {
    f.db.exec('DELETE FROM artifact_push_current; DELETE FROM artifact_push_requests');
    f.db
      .prepare(
        "DELETE FROM operations WHERE operation_kind='artifact.push.begin' AND operation_id=?"
      )
      .run(input.operationId);
  });
  const before = artifactPushRows(f.handle);
  expect(
    before.value.calls.some((call) => (call as { push_id: string | null }).push_id === input.pushId)
  ).toBe(true);
  expect(() => readProjectArtifactPushCurrent(f.handle, f.artifactId, pushTarget)).toThrowError(
    expect.objectContaining(integrity)
  );
  await expect(beginProjectArtifactPush(f.handle, f.input(), pushOptions)).rejects.toMatchObject(
    integrity
  );
  expect(artifactPushRows(f.handle)).toEqual(before);
});
