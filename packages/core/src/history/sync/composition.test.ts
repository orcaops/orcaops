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
  type ProjectArtifactPushInput,
  readProjectArtifactPush,
} from '@orcaops/storage/history/database/artifact-push';

import { type ArtifactPushClient, composeProjectArtifactPush } from './dispatch.js';
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
function fakeClient() {
  const sent: Array<{ method: string; payload: string }> = [];
  const method = (name: string) => async (payloadBytes: Buffer) => {
    sent.push({ method: name, payload: payloadBytes.toString() });
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
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'compose-push-')));
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
      label: 'Composition fixture',
      plan_steps: [
        {
          text: 'Keep original calls',
          label: 'Keep calls',
          acceptance_criteria: [{ text: 'Composition preserves the original calls' }],
        },
      ],
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
  return {
    handle,
    input,
    push: () => readProjectArtifactPush(handle, input.pushId).value,
    cloudAcknowledgement: () =>
      handle.read((view) =>
        view.get<{ revisionId: string; pushId: string; applied: number }>(
          'SELECT revision_id AS revisionId,push_id AS pushId,applied FROM cloud_sync_records WHERE push_id=?',
          input.pushId
        )
      ).value,
  };
}
it('admits then settles over the client, completing under the original terminal identity', async () => {
  const f = await fixture(),
    { client, sent } = fakeClient();
  const settled = await composeProjectArtifactPush(f.handle, client, f.input, { secretAllow: [] });
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
  const push = f.push()!;
  expect(push.terminal!.operationId).toBe(f.input.terminalOperationId);
  expect(push.calls.every((call) => call.outcomes.at(-1)!.kind === 'acknowledged')).toBe(true);
  // The cloud acknowledgement is retained under the push's own original identities: the
  // composition never retargets the outcome onto a fresh acknowledgement or push id.
  expect(f.cloudAcknowledgement()).toEqual({
    revisionId: f.input.cloudAcknowledgementId,
    pushId: f.input.pushId,
    applied: 1,
  });
});
it('replays the settled push without re-admitting or re-sending', async () => {
  const f = await fixture();
  const first = fakeClient();
  const settled = await composeProjectArtifactPush(f.handle, first.client, f.input, {
    secretAllow: [],
  });
  const second = fakeClient();
  const replay = await composeProjectArtifactPush(f.handle, second.client, f.input, {
    secretAllow: [],
  });
  expect(second.sent).toEqual([]);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(settled.value);
  expect(f.push()!.terminal!.operationId).toBe(f.input.terminalOperationId);
});
it('cancels before any send and admits no push', async () => {
  const f = await fixture(),
    { client, sent } = fakeClient();
  const stop = new AbortController();
  stop.abort();
  await expect(
    composeProjectArtifactPush(f.handle, client, f.input, { secretAllow: [], signal: stop.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(sent).toEqual([]);
  expect(f.push()).toBeNull();
});
