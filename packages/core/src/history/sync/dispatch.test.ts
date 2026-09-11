import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

import { CapturePlanInputSchema, uuidv7 } from '@orcaops/storage';
import {
  openProjectDatabase,
  type ProjectDatabase,
  readProjectArtifact,
} from '@orcaops/storage/history/database';
import {
  admitProjectRemoteAttempt,
  beginProjectArtifactPush,
  type ProjectArtifactPushInput,
  readProjectArtifactPush,
  recordProjectRemoteOutcome,
} from '@orcaops/storage/history/database/artifact-push';

import { type ArtifactPushClient, dispatchProjectArtifactPush } from './dispatch.js';
import { captureDatabasePlan } from '../capture/plan.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  await execute('git', ['-c', 'gc.auto=0', '-C', cwd, ...args], {
    env: {
      ...env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_OPTIONAL_LOCKS: '0',
    },
    timeout: 10_000,
  });
}
const target = { server_url: 'https://example.test', org_id: 'org', account_id: 'account' };
/** Records every send instead of performing one; no method reaches a network. */
function fakeClient(fail?: { method: string; error: Error }) {
  const sent: Array<{ method: string; payload: string }> = [];
  const method = (name: string) => async (payloadBytes: Buffer) => {
    sent.push({ method: name, payload: payloadBytes.toString() });
    if (fail?.method === name) throw fail.error;
    return Buffer.from(JSON.stringify({ accepted: name }));
  };
  const client: ArtifactPushClient = {
    captureThread: {
      start: method('captureThread.start'),
      attachPlan: method('captureThread.attachPlan'),
      attachPlanRevision: method('captureThread.attachPlanRevision'),
      attachCheckpointOpened: method('captureThread.attachCheckpointOpened'),
      attachCheckpoint: method('captureThread.attachCheckpoint'),
      attachSummary: method('captureThread.attachSummary'),
      attachEvaluators: method('captureThread.attachEvaluators'),
      attachCodingSessionsUsage: method('captureThread.attachCodingSessionsUsage'),
    },
    sourcePlan: { attachPin: method('sourcePlan.attachPin') },
  };
  return { client, sent };
}
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-dispatch-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Original fixture');
  const root = path.join(directory, 'history');
  await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: ['Disposable checkout'],
    secretAllow: [],
  });
  const context = await requireDatabaseExecutionContext({ cwd, root });
  const handle = await openProjectDatabase({ authority: context.authority, mode: 'writer' });
  handles.push(handle);
  const plan = await captureDatabasePlan(handle, context, {
    authored: CapturePlanInputSchema.parse({
      idempotency_key: uuidv7(),
      task: 'Preserve exact grouped push identity',
      label: 'Dispatch fixture',
      plan_steps: [{ text: 'Keep original calls', label: 'Keep calls' }],
    }),
    sourcePlan: null,
    agent: 'codex',
    snapshot: { enabled: false, excludePatterns: [] },
    secretAllow: [],
  });
  const artifactId = plan.artifactId;
  const input: ProjectArtifactPushInput = {
    pushId: uuidv7(),
    operationId: uuidv7(),
    terminalOperationId: uuidv7(),
    artifactId,
    target: structuredClone(target),
    artifactRevision: readProjectArtifact(handle, artifactId)!.revision,
    usageRevision: null,
    artifactPayloadHash: 'a'.repeat(64),
    expectedPushSelection: null,
    expectedCloudSelection: null,
    session: null,
    cloudAcknowledgementId: uuidv7(),
    preparedAt: '2026-09-01T00:00:01Z',
    result: { checkpoints: 0, summary: false, evaluators: 0, sourcePlanPinned: null },
    calls: [
      {
        requestId: uuidv7(),
        method: 'captureThread.start',
        targetExternalId: artifactId,
        payloadBytes: Buffer.from(JSON.stringify({ externalId: artifactId })),
      },
      {
        requestId: uuidv7(),
        method: 'captureThread.attachPlan',
        targetExternalId: artifactId,
        payloadBytes: Buffer.from(JSON.stringify({ artifact_id: artifactId })),
      },
    ],
  };
  await beginProjectArtifactPush(handle, input, { secretAllow: [] });
  return {
    handle,
    input,
    push: () => readProjectArtifactPush(handle, input.pushId).value!,
  };
}
const unknownDelivery = {
  code: 'STALE_CONTEXT',
  message: expect.stringMatching(
    /unknown delivery outcome retained against its original attempt.*will not be resent.*orcaops push-status.*cannot prove remote absence/i
  ),
};
const unobservedAttempt = {
  code: 'STALE_CONTEXT',
  message: expect.stringContaining('admitted attempt with no retained outcome'),
};
const interrupted = {
  code: 'STALE_CONTEXT',
  message: expect.stringContaining('interrupted before its delivery was observed'),
};
it('sends every retained call once and completes under the original terminal identity', async () => {
  const f = await fixture(),
    { client, sent } = fakeClient();
  const settled = await dispatchProjectArtifactPush(f.handle, client, f.input.pushId);
  expect(sent.map((call) => call.method)).toEqual([
    'captureThread.start',
    'captureThread.attachPlan',
  ]);
  expect(sent[0]!.payload).toBe(f.input.calls[0]!.payloadBytes.toString());
  expect(settled.value).toMatchObject({
    pushId: f.input.pushId,
    cloudApplied: true,
    sessionApplied: null,
  });
  const push = f.push();
  expect(push.terminal!.operationId).toBe(f.input.terminalOperationId);
  expect(push.calls.every((call) => call.outcomes.at(-1)!.kind === 'acknowledged')).toBe(true);
});
it('retains unknown delivery for an interrupted call and refuses to send it again', async () => {
  const f = await fixture();
  const first = fakeClient({
    method: 'captureThread.attachPlan',
    error: new Error('transport interrupted'),
  });
  await expect(
    dispatchProjectArtifactPush(f.handle, first.client, f.input.pushId)
  ).rejects.toMatchObject(interrupted);
  expect(first.sent).toHaveLength(2);
  const stopped = f.push();
  expect(stopped.terminal).toBeNull();
  expect(stopped.calls[0]!.outcomes.at(-1)!.kind).toBe('acknowledged');
  expect(stopped.calls[1]!.outcomes.at(-1)).toMatchObject({
    kind: 'ack_unknown',
    failure: { kind: 'unknown', message: 'transport interrupted' },
  });
  const second = fakeClient();
  await expect(
    dispatchProjectArtifactPush(f.handle, second.client, f.input.pushId)
  ).rejects.toMatchObject(unknownDelivery);
  expect(second.sent).toEqual([]);
  expect(f.push().terminal).toBeNull();
});
it('resumes from retained progress without sending an acknowledged call again', async () => {
  const f = await fixture();
  const first = f.push().calls[0]!;
  const attempt = {
    operationId: uuidv7(),
    attemptId: uuidv7(),
    requestId: first.request.requestId,
    scope: first.request.scope,
    expectedSelection: first.current,
    attemptedAt: '2026-09-01T00:00:02Z',
  };
  await admitProjectRemoteAttempt(f.handle, attempt, { secretAllow: [] });
  const admitted = f.push().calls[0]!;
  await recordProjectRemoteOutcome(
    f.handle,
    {
      operationId: uuidv7(),
      outcomeId: uuidv7(),
      requestId: first.request.requestId,
      attemptId: attempt.attemptId,
      scope: first.request.scope,
      expectedSelection: admitted.current,
      observedAt: '2026-09-01T00:00:03Z',
      kind: 'acknowledged',
      responseBytes: Buffer.from('{"accepted":true}'),
      failure: null,
    },
    { secretAllow: [] }
  );
  const { client, sent } = fakeClient();
  const settled = await dispatchProjectArtifactPush(f.handle, client, f.input.pushId);
  expect(sent.map((call) => call.method)).toEqual(['captureThread.attachPlan']);
  expect(settled.value).toMatchObject({ pushId: f.input.pushId, cloudApplied: true });
  expect(f.push().calls[0]!.attempt!.attemptId).toBe(attempt.attemptId);
});
it('cancels before the next call and leaves the push unsettled', async () => {
  const f = await fixture(),
    { client, sent } = fakeClient();
  const stop = new AbortController();
  stop.abort();
  await expect(
    dispatchProjectArtifactPush(f.handle, client, f.input.pushId, { signal: stop.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(sent).toEqual([]);
  const push = f.push();
  expect(push.terminal).toBeNull();
  expect(push.calls.every((call) => call.attempt === null)).toBe(true);
});
it('replays the original terminal result without sending anything', async () => {
  const f = await fixture(),
    first = fakeClient();
  const settled = await dispatchProjectArtifactPush(f.handle, first.client, f.input.pushId);
  const second = fakeClient();
  const replay = await dispatchProjectArtifactPush(f.handle, second.client, f.input.pushId);
  expect(second.sent).toEqual([]);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(settled.value);
});
it('refuses a call whose admitted attempt has no retained outcome', async () => {
  const f = await fixture(),
    call = f.push().calls[0]!;
  await admitProjectRemoteAttempt(
    f.handle,
    {
      operationId: uuidv7(),
      attemptId: uuidv7(),
      requestId: call.request.requestId,
      scope: call.request.scope,
      expectedSelection: call.current,
      attemptedAt: '2026-09-01T00:00:02Z',
    },
    { secretAllow: [] }
  );
  const { client, sent } = fakeClient();
  await expect(dispatchProjectArtifactPush(f.handle, client, f.input.pushId)).rejects.toMatchObject(
    unobservedAttempt
  );
  expect(sent).toEqual([]);
  expect(f.push().terminal).toBeNull();
});
