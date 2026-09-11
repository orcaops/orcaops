import { afterEach, expect, it, vi } from 'vitest';

import { sha256Hex, uuidv7 } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';
import {
  admitProjectRemoteAttempt,
  beginProjectArtifactPush,
  type ProjectArtifactPushInput,
  readProjectArtifactPush,
  recordProjectRemoteOutcome,
} from '@orcaops/storage/history/database/artifact-push';

import { pushAction } from '../../src/commands/push.js';
import { resyncAction } from '../../src/commands/resync.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { databaseCloudClient } from '../helpers/database-cloud-client.js';
import { fixture, git } from '../helpers/database-history.js';

afterEach(() => vi.restoreAllMocks());

function invocation(f: Awaited<ReturnType<typeof fixture>>, action: () => Promise<void>) {
  return runInInvocationContext(
    {
      cwd: f.main,
      env: {
        ORCAOPS_ROOT: f.main,
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
        CODEX_SESSION_ID: 'database-resync',
      },
      cloudBaseUrl: 'https://cloud.example',
    },
    action
  );
}

async function run(action: () => Promise<void>) {
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  try {
    await action();
  } catch {
    // emitError writes before requesting a non-zero process exit.
  } finally {
    stdout.mockRestore();
  }
  return JSON.parse(writes.join('')) as { ok: boolean } & Record<string, unknown>;
}

function cloudPin(content: string) {
  return {
    source_ref: {
      kind: 'cloud' as const,
      locator: 'approved-plan',
      version: '3',
      base_url: 'https://cloud.example',
      org_id: 'authenticated-org',
    },
    content,
    hash: sha256Hex(content),
    baseline: null,
  };
}

function localPin(content: string) {
  return {
    source_ref: { kind: 'local' as const, locator: 'plan.md' },
    content,
    hash: sha256Hex(content),
    baseline: null,
  };
}

async function retainPinnedPush(
  f: Awaited<ReturnType<typeof fixture>>,
  artifactId: string,
  target: { server_url: string; org_id: string; account_id: string },
  sourcePlanPinned: 'A' | 'B',
  acknowledgedCalls: number
) {
  const artifact = readProjectArtifact(f.writer, artifactId)!;
  const push: ProjectArtifactPushInput = {
    pushId: uuidv7(),
    operationId: uuidv7(),
    terminalOperationId: uuidv7(),
    artifactId,
    target,
    artifactRevision: artifact.revision,
    usageRevision: null,
    artifactPayloadHash: 'a'.repeat(64),
    expectedPushSelection: null,
    expectedCloudSelection: null,
    session: null,
    cloudAcknowledgementId: uuidv7(),
    preparedAt: '2026-09-05T00:00:01.000Z',
    result: { checkpoints: 0, summary: false, evaluators: 0, sourcePlanPinned },
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
      {
        requestId: uuidv7(),
        method: 'sourcePlan.attachPin',
        targetExternalId: artifactId,
        payloadBytes: Buffer.from(JSON.stringify({ artifact_id: artifactId })),
      },
    ],
  };
  await beginProjectArtifactPush(f.writer, push, { secretAllow: [] });
  for (const original of push.calls.slice(0, acknowledgedCalls)) {
    const call = readProjectArtifactPush(f.writer, push.pushId).value!.calls.find(
      (candidate) => candidate.request.requestId === original.requestId
    )!;
    const attempt = {
      operationId: uuidv7(),
      attemptId: uuidv7(),
      requestId: call.request.requestId,
      scope: call.request.scope,
      expectedSelection: call.current,
      attemptedAt: '2026-09-05T00:00:02.000Z',
    };
    await admitProjectRemoteAttempt(f.writer, attempt, { secretAllow: [] });
    const admitted = readProjectArtifactPush(f.writer, push.pushId).value!.calls.find(
      (candidate) => candidate.request.requestId === original.requestId
    )!;
    await recordProjectRemoteOutcome(
      f.writer,
      {
        operationId: uuidv7(),
        outcomeId: uuidv7(),
        requestId: call.request.requestId,
        attemptId: attempt.attemptId,
        scope: call.request.scope,
        expectedSelection: admitted.current,
        observedAt: '2026-09-05T00:00:03.000Z',
        kind: 'acknowledged',
        responseBytes: Buffer.from('{}'),
        failure: null,
      },
      { secretAllow: [] }
    );
  }
  return push.pushId;
}

it('continues after one failed artifact and excludes imported history', async () => {
  const f = await fixture();
  await git(f.main, ['remote', 'add', 'origin', 'git@github.com:team/repo.git']);
  await f.capture();
  await f.capture();
  await f.capture(undefined, { reason: 'imported' });
  const cloud = databaseCloudClient({ failOnce: new Set(['captureThread.start']) });

  const body = await run(() =>
    invocation(f, () => resyncAction({}, { cloud: cloud.dependencies }))
  );

  expect(body).toMatchObject({ ok: true, pending: 2 });
  const results = body.results as { error?: { code: string }; outcome?: { status: string } }[];
  expect(results).toHaveLength(2);
  expect(results.filter((result) => result.error)).toHaveLength(1);
  expect(results.filter((result) => result.outcome?.status === 'pushed')).toHaveLength(1);
  expect(cloud.calls.filter((call) => call.method === 'captureThread.start')).toHaveLength(2);
});

it('requires owner-ref only when the authenticated target has pending pinned work', async () => {
  const f = await fixture();
  await git(f.main, ['remote', 'add', 'origin', 'https://github.com/team/repo.git']);
  await f.capture(undefined, { sourcePlan: cloudPin('# Pinned') });
  const initial = databaseCloudClient();

  const first = await run(() =>
    invocation(f, () => resyncAction({}, { cloud: initial.dependencies }))
  );
  expect(first).toMatchObject({ ok: true, pending: 1 });
  expect(initial.qualifiedRequirements).toEqual([['source-plan-owner-ref/v1']]);

  await f.capture();
  const next = databaseCloudClient();
  const second = await run(() =>
    invocation(f, () => resyncAction({}, { cloud: next.dependencies }))
  );
  expect(second).toMatchObject({ ok: true, pending: 1 });
  expect(next.qualifiedRequirements).toEqual([[]]);
  expect(next.calls.map((call) => call.method)).toEqual([
    'captureThread.start',
    'captureThread.attachPlan',
  ]);
});

it.each(['push', 'resync'] as const)(
  '%s settles an acknowledged pin without owner-ref qualification or another send',
  async (command) => {
    const f = await fixture();
    await git(f.main, ['remote', 'add', 'origin', 'https://github.com/team/repo.git']);
    const artifactId = await f.capture(undefined, { sourcePlan: cloudPin('# Pinned') });
    const cloud = databaseCloudClient();
    const pushId = await retainPinnedPush(f, artifactId, cloud.target, 'A', 3);

    const result = await run(() =>
      invocation(f, () =>
        command === 'push'
          ? pushAction(artifactId, {}, { cloud: cloud.dependencies })
          : resyncAction({}, { cloud: cloud.dependencies })
      )
    );

    expect(result).toMatchObject({ ok: true });
    expect(cloud.qualifiedRequirements).toEqual([[]]);
    expect(cloud.calls).toEqual([]);
    expect(readProjectArtifactPush(f.writer, pushId).value!.terminal).not.toBeNull();
  }
);

it('does not require owner-ref to dispatch a pending file pin', async () => {
  const f = await fixture();
  await git(f.main, ['remote', 'add', 'origin', 'https://github.com/team/repo.git']);
  const artifactId = await f.capture(undefined, { sourcePlan: localPin('# File pinned') });
  const cloud = databaseCloudClient();
  const pushId = await retainPinnedPush(f, artifactId, cloud.target, 'B', 2);

  const result = await run(() =>
    invocation(f, () => resyncAction({}, { cloud: cloud.dependencies }))
  );

  expect(result).toMatchObject({ ok: true, pending: 1 });
  expect(cloud.qualifiedRequirements).toEqual([[]]);
  expect(cloud.calls.map((call) => call.method)).toEqual(['sourcePlan.attachPin']);
  expect(readProjectArtifactPush(f.writer, pushId).value!.terminal).not.toBeNull();
});

it('leaves work added after target qualification for the next resync', async () => {
  const f = await fixture();
  await git(f.main, ['remote', 'add', 'origin', 'https://github.com/team/repo.git']);
  await f.capture();
  let laterArtifactId: string | null = null;
  const cloud = databaseCloudClient({
    afterQualification: async () => {
      laterArtifactId = await f.capture(undefined, { sourcePlan: cloudPin('# Later pinned') });
    },
  });

  const result = await run(() =>
    invocation(f, () => resyncAction({}, { cloud: cloud.dependencies }))
  );

  expect(result).toMatchObject({ ok: true, pending: 1 });
  expect(laterArtifactId).not.toBeNull();
  expect(cloud.qualifiedRequirements).toEqual([[]]);
  expect(cloud.calls.map((call) => call.method)).toEqual([
    'captureThread.start',
    'captureThread.attachPlan',
  ]);
});
