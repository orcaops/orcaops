import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';

import { completeProjectArtifactPush } from './artifact-push-terminal.js';
import { beginProjectArtifactPush } from './artifact-push.js';
import { readProjectArtifact } from './artifacts.js';
import { recordProjectCloudSyncFailure } from './cloud-sync.js';
import { appendProjectExecutionCapture } from './execution-capture.js';
import { reconstructCheckoutPin } from './execution-checkout-input.js';
import {
  prepareProjectExecutionCheckout,
  type ProjectExecutionCheckoutInput,
  publishProjectExecutionCheckout,
} from './execution-checkout.js';
import { readProjectExecution } from './execution-records.js';
import { readProjectRemoteRequest } from './remote-transport-reader.js';
import { retainProjectRemoteRequest } from './remote-transport.js';
import { observeProjectSessionBranch } from './session-branch.js';
import {
  artifactPushFixture,
  pushOptions,
  pushTarget,
} from '../../../tests/artifact-push-fixture.js';
import {
  acknowledgeCalls,
  type ArtifactPushFixture,
  observeMain,
  renamed,
  retainedPushRows,
  terminalInput,
} from '../../../tests/artifact-push-settlement.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest, recordChecksum } from '../event-integrity.js';

const fixtures: ArtifactPushFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.close()));
});
async function fixture() {
  const f = await artifactPushFixture();
  fixtures.push(f);
  return f;
}
const conflict = { code: 'IDEMPOTENCY_CONFLICT' };
async function boundArtifact(f: ArtifactPushFixture) {
  const prior = JSON.parse(
    await readFile(new URL('./fixtures/execution-history.json', import.meta.url), 'utf8')
  ) as { rows: { artifact_events: Array<{ record_bytes: { blobHex: string } }> } };
  const { checksum: _checksum, ...event } = JSON.parse(
    Buffer.from(prior.rows.artifact_events[0]!.record_bytes.blobHex, 'hex').toString()
  );
  const artifactId = uuidv7();
  event.event_id = uuidv7();
  event.idempotency_key = uuidv7();
  event.payload.artifact_id = artifactId;
  await appendProjectExecutionCapture(f.handle, {
    artifactId,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...event, checksum: recordChecksum(event) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
    execution: {
      kind: 'create',
      context: {
        repository_instance_id: f.authority.repositoryInstanceId,
        worktree_id: uuidv7(),
        git_context: { branch: 'original', head_sha: 'a'.repeat(40) },
      },
      ts: '2026-09-01T00:00:00.000Z',
    },
  });
  return artifactId;
}
function checkout(
  f: ArtifactPushFixture,
  artifactId: string,
  focusOperationId = uuidv7()
): ProjectExecutionCheckoutInput {
  const state = readProjectExecution(f.handle, artifactId)!;
  const worktreeId = uuidv7();
  const input: ProjectExecutionCheckoutInput = {
    artifactId,
    operationId: uuidv7(),
    secretAllow: [],
    expected: {
      revision: readProjectArtifact(f.handle, artifactId)!.revision,
      version: state.version,
      generation: state.state.binding_generation,
    },
    payload: {
      action: 'handoff',
      expectedBinding: state.state.current_binding,
      target: {
        repository_instance_id: f.authority.repositoryInstanceId,
        worktree_id: worktreeId,
        git_context: { branch: 'target', head_sha: 'b'.repeat(40) },
      },
      reason: null,
      ts: '2026-09-01T00:01:00.000Z',
      focus: {
        operationId: focusOperationId,
        scope: {
          rootKey: f.authority.rootKey,
          projectId: f.authority.projectId,
          storeInstanceId: f.authority.storeInstanceId,
          repositoryInstanceId: f.authority.repositoryInstanceId,
          worktreeId,
          shellKey: { kind: 'codex_session', value: 'original session' },
        },
        expectedSelection: null,
        pinnedAt: '2026-09-01T00:01:00.000Z',
        pinHash: '0'.repeat(64),
      },
    },
  };
  input.payload.focus.pinHash = digest(
    reconstructCheckoutPin(artifactId, input.payload, input.expected.generation + 1)
  );
  return input;
}
async function boundCheckout(f: ArtifactPushFixture, focusOperationId?: string) {
  const artifactId = await boundArtifact(f);
  const request = checkout(f, artifactId, focusOperationId);
  return { artifactId, request };
}
async function admittedPush(f: ArtifactPushFixture, terminalOperationId?: string) {
  const input = f.input();
  if (terminalOperationId) input.terminalOperationId = terminalOperationId;
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  return input;
}
function failure(f: ArtifactPushFixture, operationId: string) {
  return {
    operationId,
    revisionId: uuidv7(),
    artifactId: f.artifactId,
    target: pushTarget,
    kind: 'network' as const,
    message: 'original failure',
    attemptedAt: '2026-09-01T00:00:06Z',
    attemptStartedAt: '2026-09-01T00:00:05Z',
  };
}
it('refuses a push admission that reuses a retained checkout focus child identity', async () => {
  const f = await fixture(),
    { request } = await boundCheckout(f);
  await publishProjectExecutionCheckout(
    f.handle,
    prepareProjectExecutionCheckout(f.handle, request)
  );
  const focusId = request.payload.focus.operationId;
  const before = retainedPushRows(f.handle);
  const asAdmission = f.input();
  asAdmission.operationId = focusId;
  await expect(beginProjectArtifactPush(f.handle, asAdmission, pushOptions)).rejects.toMatchObject(
    conflict
  );
  const asTerminal = f.input();
  asTerminal.terminalOperationId = focusId;
  await expect(beginProjectArtifactPush(f.handle, asTerminal, pushOptions)).rejects.toMatchObject(
    conflict
  );
  expect(retainedPushRows(f.handle)).toEqual(before);
});
it('refuses a checkout focus child that reuses a reserved push terminal identity', async () => {
  const f = await fixture(),
    push = await admittedPush(f);
  const artifactId = await boundArtifact(f);
  const before = retainedPushRows(f.handle);
  expect(() =>
    prepareProjectExecutionCheckout(f.handle, checkout(f, artifactId, push.terminalOperationId))
  ).toThrowError(expect.objectContaining(conflict));
  expect(retainedPushRows(f.handle)).toEqual(before);
});
it('refuses a checkout focus child that reuses a settled push terminal identity', async () => {
  const f = await fixture(),
    push = await admittedPush(f);
  await acknowledgeCalls(f, push);
  await completeProjectArtifactPush(f.handle, terminalInput(push));
  const artifactId = await boundArtifact(f);
  const before = retainedPushRows(f.handle);
  expect(() =>
    prepareProjectExecutionCheckout(f.handle, checkout(f, artifactId, push.terminalOperationId))
  ).toThrowError(expect.objectContaining(conflict));
  expect(retainedPushRows(f.handle)).toEqual(before);
});
it('refuses publishing a prepared checkout whose focus child a push reserved after preparation', async () => {
  const f = await fixture(),
    { request } = await boundCheckout(f);
  const prepared = prepareProjectExecutionCheckout(f.handle, request);
  await admittedPush(f, request.payload.focus.operationId);
  const before = retainedPushRows(f.handle);
  await expect(publishProjectExecutionCheckout(f.handle, prepared)).rejects.toMatchObject(conflict);
  expect(retainedPushRows(f.handle)).toEqual(before);
});
it('refuses every other operation family that consumes a reserved terminal identity', async () => {
  const f = await fixture(),
    selection = await observeMain(f.handle),
    push = await admittedPush(f);
  // The shared runner's reservation guard runs after each domain settlement, so the slot
  // must be acknowledged for the remote writer to reach it.
  await acknowledgeCalls(f, push);
  const call = readProjectRemoteRequest(f.handle, push.calls[0]!.requestId).value!;
  const before = retainedPushRows(f.handle);
  await expect(
    observeProjectSessionBranch(
      f.handle,
      { ...renamed(selection), operationId: push.terminalOperationId },
      pushOptions
    )
  ).rejects.toMatchObject(conflict);
  await expect(
    recordProjectCloudSyncFailure(f.handle, failure(f, push.terminalOperationId), pushOptions)
  ).rejects.toMatchObject(conflict);
  await expect(
    retainProjectRemoteRequest(
      f.handle,
      {
        operationId: push.terminalOperationId,
        requestId: uuidv7(),
        scope: call.request.scope,
        expectedSelection: call.current,
        payloadBytes: Buffer.from(JSON.stringify({ externalId: f.artifactId, later: true })),
        preparedAt: '2026-09-01T00:00:06Z',
      },
      pushOptions
    )
  ).rejects.toMatchObject(conflict);
  expect(retainedPushRows(f.handle)).toEqual(before);
  expect((await completeProjectArtifactPush(f.handle, terminalInput(push))).value).toMatchObject({
    pushId: push.pushId,
    cloudApplied: true,
  });
});
it('selects retained checkout focus children through the partial expression index', async () => {
  const f = await fixture(),
    focus = `json_extract(payload_json,'$.focus.operationId')`,
    kind = `operation_kind='execution.checkout'`;
  const plan = (sql: string, ...parameters: string[]) =>
    JSON.stringify(f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters));
  expect(plan(`SELECT 1 FROM operations WHERE ${kind} AND ${focus}=? LIMIT 1`, uuidv7())).toContain(
    'operations_checkout_focus_lookup'
  );
  expect(
    plan(
      `SELECT 1 FROM operations WHERE ${kind} AND ${focus}=?
      UNION ALL SELECT 1 FROM operations WHERE ${kind} AND ${focus}=? LIMIT 1`,
      uuidv7(),
      uuidv7()
    )
  ).toContain('operations_checkout_focus_lookup');
  // Why the admission preflight spends two equality terms on one pair of identities.
  expect(
    plan(`SELECT 1 FROM operations WHERE ${kind} AND ${focus} IN (?,?) LIMIT 1`, uuidv7(), uuidv7())
  ).not.toContain('operations_checkout_focus_lookup');
});
