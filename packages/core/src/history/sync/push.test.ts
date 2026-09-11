import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';
import {
  CapturePlanInputSchema,
  deriveUsageLedgerRecord,
  sha256Hex,
  uuidv7,
} from '@orcaops/storage';
import {
  appendProjectArtifactEvents,
  appendProjectUsageEvents,
  openProjectDatabase,
  type ProjectDatabase,
  readProjectArtifact,
  readProjectCloudSyncState,
  readProjectUsage,
} from '@orcaops/storage/history/database';
import {
  beginProjectArtifactPush,
  readProjectArtifactPush,
  readProjectArtifactPushCurrent,
} from '@orcaops/storage/history/database/artifact-push';
import { recordChecksum } from '@orcaops/storage/history/primitives';

import {
  buildDatabaseArtifactPushInput,
  pushDatabaseArtifact,
  resyncDatabaseArtifacts,
} from './artifact-sync.js';
import { type ArtifactPushClient } from './dispatch.js';
import { captureDatabasePlan } from '../capture/plan.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import { setupProjectDatabase } from '../setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const target = { server_url: 'https://example.test', org_id: 'org', account_id: 'account' };
const repoUrl = 'ssh://example.test/repo';
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
/** Records every send instead of performing one; an optional hook mutates the database mid-send. */
function fakeClient(onSend?: (method: string) => Promise<void>) {
  const sent: string[] = [];
  const method = (name: string) => async () => {
    sent.push(name);
    if (onSend) await onSend(name);
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
async function fixture(sourcePlan: Parameters<typeof captureDatabasePlan>[2]['sourcePlan'] = null) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'db-push-')));
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
      task: 'Push the retained thread',
      label: 'Push fixture',
      plan_steps: [{ text: 'Push', label: 'Push' }],
    }),
    sourcePlan,
    agent: 'codex',
    snapshot: { enabled: false, excludePatterns: [] },
    secretAllow: [],
  });
  return { handle, artifactId: plan.artifactId };
}
async function appendUsage(handle: ProjectDatabase, artifactId: string) {
  const counters = {
    input_tokens: 9,
    output_tokens: 4,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const asOf = '2026-09-01T00:00:00Z';
  const payload = {
    snapshot_id: uuidv7(),
    idempotency_key: uuidv7(),
    agent: 'codex' as const,
    session_id: 'session-1',
    artifact_id: artifactId,
    source_plan_ref_id: null,
    lifecycle_event: 'checkpoint_close' as const,
    checkpoint_n: 1,
    cumulative_usage: counters,
    delta_usage: null,
    baseline_kind: 'first_observation' as const,
    model_breakdown: [{ model: 'a-model', cumulative: counters, delta: null }],
    record_count: 1,
    as_of: asOf,
  };
  const { record } = deriveUsageLedgerRecord({
    type: 'agent_usage_snapshot_recorded',
    ts: asOf,
    idempotency_key: payload.idempotency_key,
    payload,
  });
  await appendProjectUsageEvents(handle, {
    operationId: uuidv7(),
    expectedRevision: readProjectUsage(handle)?.revision ?? null,
    eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  });
}
function cloudAcknowledgement(handle: ProjectDatabase, pushId: string) {
  return handle.read((view) =>
    view.get<{ pushId: string; applied: number }>(
      'SELECT push_id AS pushId,applied FROM cloud_sync_records WHERE push_id=?',
      pushId
    )
  ).value;
}

it('pushes over the injected client with an honest applied outcome and no real send', async () => {
  const f = await fixture();
  const { client, sent } = fakeClient();
  const outcome = await pushDatabaseArtifact(f.handle, f.artifactId, { target, repoUrl, client });
  expect(sent).toEqual(['captureThread.start', 'captureThread.attachPlan']);
  expect(outcome).toMatchObject({ status: 'pushed', cloudApplied: true, sessionApplied: null });
  expect(
    readProjectArtifactPush(f.handle, outcome.status === 'pushed' ? outcome.pushId : '').value!
      .terminal
  ).not.toBeNull();
});
it('reports cloudApplied:false under the original ids when usage advances mid-dispatch', async () => {
  const f = await fixture();
  let advanced = false;
  const { client } = fakeClient(async () => {
    if (advanced) return;
    advanced = true;
    await appendUsage(f.handle, f.artifactId);
  });
  const outcome = await pushDatabaseArtifact(f.handle, f.artifactId, { target, repoUrl, client });
  expect(outcome).toMatchObject({ status: 'pushed', cloudApplied: false });
  if (outcome.status !== 'pushed') throw new Error('expected a push');
  // The cloud acknowledgement is retained under the push's own id with applied:0 — no retarget.
  expect(cloudAcknowledgement(f.handle, outcome.pushId)).toEqual({
    pushId: outcome.pushId,
    applied: 0,
  });
  // The push still completed under its original terminal identity.
  expect(readProjectArtifactPush(f.handle, outcome.pushId).value!.terminal).not.toBeNull();
});
it('skips a re-push of an unchanged artifact without sending', async () => {
  const f = await fixture();
  const first = await pushDatabaseArtifact(f.handle, f.artifactId, {
    target,
    repoUrl,
    client: fakeClient().client,
  });
  expect(first).toMatchObject({ status: 'pushed', cloudApplied: true });
  const second = fakeClient();
  const outcome = await pushDatabaseArtifact(f.handle, f.artifactId, {
    target,
    repoUrl,
    client: second.client,
  });
  expect(outcome.status).toBe('skipped');
  expect(second.sent).toEqual([]);
});
it('cancels before any send under an aborted signal', async () => {
  const f = await fixture();
  const { client, sent } = fakeClient();
  const stop = new AbortController();
  stop.abort();
  await expect(
    pushDatabaseArtifact(f.handle, f.artifactId, { target, repoUrl, client, signal: stop.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(sent).toEqual([]);
});

it('resumes an admitted push under its original identity without preparing a replacement', async () => {
  const f = await fixture();
  const input = await buildDatabaseArtifactPushInput(f.handle, f.artifactId, { target, repoUrl });
  await beginProjectArtifactPush(f.handle, input, { secretAllow: [] });
  const { client, sent } = fakeClient();
  const result = await pushDatabaseArtifact(f.handle, f.artifactId, { target, repoUrl, client });
  expect(result).toMatchObject({ status: 'pushed', pushId: input.pushId, cloudApplied: true });
  expect(sent).toEqual(['captureThread.start', 'captureThread.attachPlan']);
  const retained = readProjectArtifactPush(f.handle, input.pushId).value!;
  expect(retained.input).toEqual(input);
  expect(retained.terminal).not.toBeNull();
});
it('does not retry a send whose delivery is unknown', async () => {
  const f = await fixture();
  const failed = fakeClient(async () => {
    throw new Error('connection lost');
  });
  await expect(
    pushDatabaseArtifact(f.handle, f.artifactId, { target, repoUrl, client: failed.client })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  const original = readProjectArtifactPushCurrent(f.handle, f.artifactId, target).value!;
  const before = f.handle.read(() => null).counters;
  const retry = fakeClient();
  await expect(
    pushDatabaseArtifact(f.handle, f.artifactId, { target, repoUrl, client: retry.client })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(retry.sent).toEqual([]);
  expect(readProjectArtifactPushCurrent(f.handle, f.artifactId, target).value!.input.pushId).toBe(
    original.input.pushId
  );
  expect(f.handle.read(() => null).counters).toEqual(before);
});

function retainedPin() {
  const content = '# Retained pin';
  return {
    source_ref: { kind: 'local' as const, locator: 'plan.md' },
    content,
    hash: sha256Hex(content),
    baseline: null,
  };
}
function missingPinClient() {
  return {
    sourcePlan: {
      get: vi.fn(async () => {
        throw new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 });
      }),
    },
  };
}
it('skips an unchanged pinned artifact without requesting Source Plan preflight', async () => {
  const f = await fixture(retainedPin());
  await pushDatabaseArtifact(f.handle, f.artifactId, {
    target,
    repoUrl,
    client: fakeClient().client,
    sourcePlanClient: missingPinClient(),
  });
  const sourcePlanClient = missingPinClient();
  const next = fakeClient();
  const before = f.handle.read(() => null).counters;
  await expect(
    pushDatabaseArtifact(f.handle, f.artifactId, {
      target,
      repoUrl,
      client: next.client,
      sourcePlanClient,
    })
  ).resolves.toMatchObject({ status: 'skipped' });
  expect(sourcePlanClient.sourcePlan.get).not.toHaveBeenCalled();
  expect(next.sent).toEqual([]);
  expect(f.handle.read(() => null).counters).toEqual(before);
});
it('refuses stale usage after asynchronous preflight instead of reporting an unchanged skip', async () => {
  const f = await fixture(retainedPin());
  await pushDatabaseArtifact(f.handle, f.artifactId, {
    target,
    repoUrl,
    client: fakeClient().client,
    sourcePlanClient: missingPinClient(),
  });
  await appendUsage(f.handle, f.artifactId);
  const sourcePlanClient = missingPinClient();
  sourcePlanClient.sourcePlan.get.mockImplementation(async () => {
    await appendUsage(f.handle, f.artifactId);
    throw new TrpcRequestError('missing', { code: 'NOT_FOUND', httpStatus: 404 });
  });
  const next = fakeClient();
  await expect(
    pushDatabaseArtifact(f.handle, f.artifactId, {
      target,
      repoUrl,
      client: next.client,
      sourcePlanClient,
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(next.sent).toEqual([]);
  expect(readProjectCloudSyncState(f.handle, f.artifactId, target)!.pending).toBe(true);
});
it('resync recovers a forced admission even when unchanged sources are already synced', async () => {
  const f = await fixture();
  await pushDatabaseArtifact(f.handle, f.artifactId, {
    target,
    repoUrl,
    client: fakeClient().client,
  });
  const input = await buildDatabaseArtifactPushInput(f.handle, f.artifactId, { target, repoUrl });
  await beginProjectArtifactPush(f.handle, input, { secretAllow: [] });
  expect(readProjectCloudSyncState(f.handle, f.artifactId, target)!.pending).toBe(false);
  const retry = fakeClient();
  const result = await resyncDatabaseArtifacts(f.handle, { target, repoUrl, client: retry.client });
  expect(result.pending).toBe(1);
  expect(result.results[0]).toMatchObject({
    artifactId: f.artifactId,
    outcome: { status: 'pushed', pushId: input.pushId, cloudApplied: true },
  });
  expect(retry.sent).toEqual(['captureThread.start', 'captureThread.attachPlan']);
});
it('keeps imported history local even when an original push was admitted', async () => {
  const f = await fixture();
  const input = await buildDatabaseArtifactPushInput(f.handle, f.artifactId, { target, repoUrl });
  await pushDatabaseArtifact(f.handle, f.artifactId, {
    target,
    repoUrl,
    client: fakeClient().client,
  });
  const importedId = uuidv7();
  const payload = {
    ...readProjectArtifact(f.handle, f.artifactId)!.thread.plan!,
    artifact_id: importedId,
    origin: {
      kind: 'git-import',
      imported_at: '2026-09-01T00:00:00Z',
      tool_version: 'fixture',
      source_range: 'fixture',
      authors: ['Fixture'],
      enriched_at: null,
    },
  };
  const record = {
    event_id: uuidv7(),
    type: 'plan_captured' as const,
    ts: '2026-09-01T00:00:00Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload,
  };
  await appendProjectArtifactEvents(f.handle, {
    operationId: uuidv7(),
    artifactId: importedId,
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  });
  const imported = readProjectArtifact(f.handle, importedId)!;
  await beginProjectArtifactPush(
    f.handle,
    {
      ...input,
      artifactId: importedId,
      artifactRevision: imported.revision,
      calls: input.calls.map((call) => ({
        ...call,
        targetExternalId: importedId,
        payloadBytes: Buffer.from(
          JSON.stringify(
            call.method === 'captureThread.start'
              ? { ...JSON.parse(call.payloadBytes.toString()), externalId: importedId }
              : { ...JSON.parse(call.payloadBytes.toString()), artifact_id: importedId }
          )
        ),
      })),
    },
    { secretAllow: [] }
  );
  const next = fakeClient();
  const before = f.handle.read(() => null).counters;
  await expect(
    buildDatabaseArtifactPushInput(f.handle, importedId, { target, repoUrl })
  ).rejects.toMatchObject({ name: 'ImportedArtifactLocalOnlyError' });
  await expect(
    pushDatabaseArtifact(f.handle, importedId, { target, repoUrl, client: next.client })
  ).rejects.toMatchObject({ name: 'ImportedArtifactLocalOnlyError' });
  expect(await resyncDatabaseArtifacts(f.handle, { target, repoUrl, client: next.client })).toEqual(
    { pending: 0, results: [] }
  );
  expect(next.sent).toEqual([]);
  expect(f.handle.read(() => null).counters).toEqual(before);
});
