import { afterEach, expect, it } from 'vitest';

import { readProjectCloudSyncState, recordProjectCloudSyncFailure } from './cloud-sync.js';
import {
  observeProjectSessionBranch,
  readProjectSessionBranch,
  readProjectSessionObservation,
} from './session-branch.js';
import {
  artifactPushFixture,
  corruptPushFixture,
  pushOptions,
  pushTarget,
} from '../../../tests/artifact-push-fixture.js';
import {
  type ArtifactPushFixture,
  completedPush,
  observeMain,
  renamed,
  retainedPushRows,
  sessionKey,
} from '../../../tests/artifact-push-settlement.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const fixtures: ArtifactPushFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.close()));
});
async function fixture() {
  const f = await artifactPushFixture();
  fixtures.push(f);
  return f;
}
const integrity = { code: 'HISTORY_INTEGRITY_REQUIRED' };
const conflict = { code: 'IDEMPOTENCY_CONFLICT' };
function failure(f: ArtifactPushFixture) {
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    artifactId: f.artifactId,
    target: pushTarget,
    kind: 'network' as const,
    message: 'original failure',
    attemptedAt: '2026-09-01T00:00:06Z',
    attemptStartedAt: '2026-09-01T00:00:05Z',
  };
}
function cloudState(f: ArtifactPushFixture) {
  return readProjectCloudSyncState(f.handle, f.artifactId, pushTarget);
}
function relabel(f: ArtifactPushFixture, operationId: string) {
  corruptPushFixture(f.db, () =>
    f.db
      .prepare('UPDATE operations SET operation_kind=? WHERE operation_id=?')
      .run('artifact.push.begin', operationId)
  );
}
it('reads a settled push without session state through both readers', async () => {
  const f = await fixture(),
    { input, result } = await completedPush(f);
  expect(result.value).toMatchObject({ sessionApplied: null, cloudApplied: true });
  expect(cloudState(f)).toMatchObject({
    selection: { revisionId: input.cloudAcknowledgementId, version: 1 },
    consecutiveFailures: 0,
    pending: false,
    lastError: null,
    publicState: {
      syncedAt: result.value.acknowledgedAt,
      externalId: f.artifactId,
      orgId: pushTarget.org_id,
    },
  });
  expect(readProjectSessionBranch(f.handle, sessionKey)).toBeNull();
});
it('reads a settled session push through both readers', async () => {
  const f = await fixture(),
    { input, result } = await completedPush(f, true);
  expect(result.value).toMatchObject({ sessionApplied: true, cloudApplied: true });
  expect(cloudState(f)).toMatchObject({
    selection: { revisionId: input.cloudAcknowledgementId, version: 1 },
    pending: false,
    publicState: { syncedAt: result.value.acknowledgedAt },
  });
  expect(readProjectSessionBranch(f.handle, sessionKey)).toMatchObject({
    selection: { revisionId: input.session!.resultRevisionId, version: 2 },
    state: {
      current_branch: 'main',
      branch_history: [],
      last_acked_at: result.value.acknowledgedAt,
    },
  });
});
it('refuses a session observation that reuses the terminal ID of a settled session push', async () => {
  const f = await fixture(),
    { input } = await completedPush(f, true);
  const current = readProjectSessionBranch(f.handle, sessionKey)!;
  const before = retainedPushRows(f.handle);
  await expect(
    observeProjectSessionBranch(
      f.handle,
      {
        ...renamed(current.selection, current.state.last_acked_at),
        operationId: input.terminalOperationId,
      },
      pushOptions
    )
  ).rejects.toMatchObject(conflict);
  expect(retainedPushRows(f.handle)).toEqual(before);
});
it('refuses a session observation that reuses the terminal ID of a push without session state', async () => {
  const f = await fixture(),
    selection = await observeMain(f.handle);
  const { input } = await completedPush(f);
  const before = retainedPushRows(f.handle);
  await expect(
    observeProjectSessionBranch(
      f.handle,
      { ...renamed(selection), operationId: input.terminalOperationId },
      pushOptions
    )
  ).rejects.toMatchObject(conflict);
  expect(retainedPushRows(f.handle)).toEqual(before);
});
it('refuses a cloud failure that reuses the terminal ID of a settled session push', async () => {
  const f = await fixture(),
    { input } = await completedPush(f, true);
  const before = retainedPushRows(f.handle);
  await expect(
    recordProjectCloudSyncFailure(
      f.handle,
      { ...failure(f), operationId: input.terminalOperationId },
      pushOptions
    )
  ).rejects.toMatchObject(conflict);
  expect(retainedPushRows(f.handle)).toEqual(before);
});
it('refuses a cloud failure that reuses the terminal ID of a push without session state', async () => {
  const f = await fixture(),
    { input } = await completedPush(f);
  const before = retainedPushRows(f.handle);
  await expect(
    recordProjectCloudSyncFailure(
      f.handle,
      { ...failure(f), operationId: input.terminalOperationId },
      pushOptions
    )
  ).rejects.toMatchObject(conflict);
  expect(retainedPushRows(f.handle)).toEqual(before);
});
it('refuses a reused operation ID whose receipt kind cannot own the retained session revision', async () => {
  const f = await fixture(),
    { input } = await completedPush(f, true);
  const current = readProjectSessionBranch(f.handle, sessionKey)!;
  relabel(f, input.terminalOperationId);
  await expect(
    observeProjectSessionBranch(
      f.handle,
      {
        ...renamed(current.selection, current.state.last_acked_at),
        operationId: input.terminalOperationId,
      },
      pushOptions
    )
  ).rejects.toMatchObject(integrity);
});
it('refuses a reused operation ID whose receipt kind cannot own the retained cloud record', async () => {
  const f = await fixture(),
    { input } = await completedPush(f);
  relabel(f, input.terminalOperationId);
  await expect(
    recordProjectCloudSyncFailure(
      f.handle,
      { ...failure(f), operationId: input.terminalOperationId },
      pushOptions
    )
  ).rejects.toMatchObject(integrity);
});
it('refuses a cloud read when the terminal reports a session outcome the push never reserved', async () => {
  const f = await fixture(),
    { input } = await completedPush(f);
  corruptPushFixture(f.db, () => {
    f.db
      .prepare('UPDATE artifact_push_terminals SET session_applied=0 WHERE push_id=?')
      .run(input.pushId);
    f.db
      .prepare(
        `UPDATE operations SET result_json=json_set(result_json,'$.sessionApplied',json('false')) WHERE operation_id=?`
      )
      .run(input.terminalOperationId);
  });
  expect(() => cloudState(f)).toThrowError(expect.objectContaining(integrity));
});
it('refuses a session read when the cloud acknowledgment of the terminal operation is missing', async () => {
  const f = await fixture(),
    { input } = await completedPush(f, true);
  corruptPushFixture(f.db, () =>
    f.db
      .prepare('DELETE FROM cloud_sync_records WHERE revision_id=?')
      .run(input.cloudAcknowledgementId)
  );
  expect(() => readProjectSessionBranch(f.handle, sessionKey)).toThrowError(
    expect.objectContaining(integrity)
  );
});
it('refuses a session read when the retained cloud acknowledgment disagrees with the terminal', async () => {
  const f = await fixture(),
    { input } = await completedPush(f, true);
  corruptPushFixture(f.db, () =>
    f.db
      .prepare('UPDATE cloud_sync_records SET applied=0 WHERE revision_id=?')
      .run(input.cloudAcknowledgementId)
  );
  expect(() => readProjectSessionBranch(f.handle, sessionKey)).toThrowError(
    expect.objectContaining(integrity)
  );
});
it('refuses a session read when the reserved acknowledgment identity moved', async () => {
  const f = await fixture(),
    { input } = await completedPush(f, true);
  corruptPushFixture(f.db, () =>
    f.db
      .prepare('UPDATE artifact_push_requests SET session_acknowledgement_id=? WHERE push_id=?')
      .run(uuidv7(), input.pushId)
  );
  expect(() => readProjectSessionBranch(f.handle, sessionKey)).toThrowError(
    expect.objectContaining(integrity)
  );
});
it('refuses a cloud read when the retained terminal calls disagree with the call count', async () => {
  const f = await fixture(),
    { input } = await completedPush(f);
  corruptPushFixture(f.db, () =>
    f.db
      .prepare('DELETE FROM artifact_push_terminal_calls WHERE push_id=? AND ordinal=2')
      .run(input.pushId)
  );
  expect(() => cloudState(f)).toThrowError(expect.objectContaining(integrity));
});
it('restores the original observation input for replay and refuses a foreign operation ID', async () => {
  const f = await fixture(),
    selection = await observeMain(f.handle),
    request = renamed(selection);
  const published = await observeProjectSessionBranch(f.handle, request, pushOptions);
  expect(readProjectSessionObservation(f.handle, uuidv7())).toBeNull();
  const retained = readProjectSessionObservation(f.handle, request.operationId)!;
  expect(retained).toEqual({ ...request, stateBytes: new Uint8Array(request.stateBytes) });
  const before = retainedPushRows(f.handle);
  const replay = await observeProjectSessionBranch(f.handle, retained, pushOptions);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(published.value);
  expect(retainedPushRows(f.handle)).toEqual(before);
});
it('refuses restoring an observation from an operation ID a settled push owns', async () => {
  const f = await fixture(),
    { input } = await completedPush(f, true);
  expect(() => readProjectSessionObservation(f.handle, input.terminalOperationId)).toThrowError(
    expect.objectContaining(conflict)
  );
  expect(readProjectSessionObservation(f.handle, uuidv7())).toBeNull();
});
