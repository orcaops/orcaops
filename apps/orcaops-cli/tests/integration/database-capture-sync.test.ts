import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CloudCapabilityError, NotConnectedError } from '@orcaops/core';
import { deriveUsageLedgerRecord, ForbiddenControlCharError, uuidv7 } from '@orcaops/storage';
import {
  appendProjectUsageEvents,
  readProjectArtifact,
  readProjectUsage,
} from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { captureSummary } from '../../src/commands/capture/summary.js';
import { finish } from '../../src/commands/finish.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { databaseCloudClient } from '../helpers/database-cloud-client.js';
import { fixture, git, inventory } from '../helpers/database-history.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Deps = Parameters<typeof finish>[2];

function env(f: Fixture) {
  return {
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_DISABLE_DRAIN: '0',
    CODEX_SESSION_ID: 'sync-session',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
    XDG_STATE_HOME: f.temporary + '/unused-state',
  };
}

const summaryBody = (id: string, extra: Record<string, unknown> = {}) => ({
  idempotency_key: `sync-${randomUUID()}`,
  artifact_id: id,
  outcome: 'the work shipped',
  tests_written: [],
  tests_run: [],
  open_items: [],
  deferred_decisions: [],
  ...extra,
});

function runSummary(
  f: Fixture,
  body: Record<string, unknown>,
  deps: Deps = {},
  signal = new AbortController().signal
) {
  return runInInvocationContext(
    { cwd: f.main, env: env(f), cloudBaseUrl: 'https://cloud.example' },
    () => captureSummary({ input: inputFile(JSON.stringify(body)) }, signal, deps)
  ) as Promise<Record<string, unknown>>;
}

function runFinish(f: Fixture, body: Record<string, unknown>, deps: Deps = {}) {
  return runInInvocationContext(
    { cwd: f.main, env: env(f), cloudBaseUrl: 'https://cloud.example' },
    () =>
      finish(
        { noLlm: true, input: inputFile(JSON.stringify(body)) },
        new AbortController().signal,
        deps
      )
  ) as Promise<Record<string, unknown>>;
}

const summaryOf = (f: Fixture, id: string) => readProjectArtifact(f.writer, id)!.thread.summary;

async function addRemote(f: Fixture) {
  await git(f.main, ['remote', 'add', 'origin', 'git@github.com:team/repo.git']);
}

describe('registered database capture sync', { timeout: 120_000 }, () => {
  it('syncs a completed summary through the default authenticated composition', async () => {
    const f = await fixture();
    await addRemote(f);
    const id = await f.capture();
    const cloud = databaseCloudClient();

    const result = await runSummary(f, summaryBody(id), { cloud: cloud.dependencies });

    expect(result.cloud_sync).toMatchObject({ status: 'ok' });
    expect(cloud.calls.map((call) => call.method)).toEqual([
      'captureThread.start',
      'captureThread.attachPlan',
      'captureThread.attachSummary',
    ]);
  });

  it('syncs a completed finish through the default authenticated composition', async () => {
    const f = await fixture();
    await addRemote(f);
    const id = await f.capture();
    const cloud = databaseCloudClient();

    const result = await runFinish(f, summaryBody(id), { cloud: cloud.dependencies });

    expect(result).toMatchObject({
      idempotency_status: 'created',
      cloud_sync: { status: 'ok' },
    });
    expect(cloud.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining([
        'captureThread.start',
        'captureThread.attachPlan',
        'captureThread.attachSummary',
      ])
    );
    expect(summaryOf(f, id)?.outcome).toBe('the work shipped');
  });

  it('reports connection failure without undoing a committed summary or finish', async () => {
    const f = await fixture();
    await addRemote(f);
    const summaryId = await f.capture();
    const offline = databaseCloudClient({ connectionError: new NotConnectedError() });

    const summary = await runSummary(f, summaryBody(summaryId), { cloud: offline.dependencies });
    expect(summary).toMatchObject({
      capture_status: 'committed',
      cloud_sync: { status: 'paused', reason: 'not_authenticated', code: 'NOT_CONNECTED' },
    });
    expect(summaryOf(f, summaryId)?.outcome).toBe('the work shipped');

    const finishId = await f.capture();
    const finished = await runFinish(f, summaryBody(finishId), { cloud: offline.dependencies });
    expect(finished).toMatchObject({
      capture_status: 'committed',
      cloud_sync: { status: 'paused', reason: 'not_authenticated', code: 'NOT_CONNECTED' },
    });
    expect(summaryOf(f, finishId)?.outcome).toBe('the work shipped');
  });

  it('reports a missing remote after commit instead of treating sync as successful', async () => {
    const f = await fixture();
    const id = await f.capture();

    const result = await runSummary(f, summaryBody(id));

    expect(result).toMatchObject({
      capture_status: 'committed',
      cloud_sync: { status: 'skipped', reason: 'missing_remote' },
    });
    expect(summaryOf(f, id)?.outcome).toBe('the work shipped');
  });

  it('propagates cancellation after retaining the committed summary', async () => {
    const f = await fixture();
    await addRemote(f);
    const id = await f.capture();
    const stop = new AbortController();
    const cloud = databaseCloudClient();
    const dependencies = {
      ...cloud.dependencies,
      resolveCredentials: () => {
        stop.abort();
        return cloud.credentialStore;
      },
    };

    await expect(
      runSummary(f, summaryBody(id), { cloud: dependencies }, stop.signal)
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(summaryOf(f, id)?.outcome).toBe('the work shipped');
    expect(cloud.createCanonicalClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new ForbiddenControlCharError('outcome'),
      reason: 'content_invalid',
      action: 'orcaops doctor',
    },
    {
      error: new CloudCapabilityError('upgrade-required', 'capture', 'Unsupported client'),
      reason: 'upgrade_required',
      action: 'Upgrade your Orcaops install',
    },
  ])(
    'preserves the capture and gives specific recovery for $reason',
    async ({ error, reason, action }) => {
      const f = await fixture();
      await addRemote(f);
      const id = await f.capture();
      const cloud = databaseCloudClient({ connectionError: error });
      const result = await runSummary(f, summaryBody(id), { cloud: cloud.dependencies });
      expect(result.cloud_sync).toMatchObject({
        status: 'paused',
        reason,
        action: expect.stringContaining(action),
      });
      expect((result.cloud_sync as { action: string }).action).not.toContain('resync --force');
      expect(summaryOf(f, id)).not.toBeNull();
      expect(cloud.calls).toEqual([]);
    }
  );

  it('does not call the cloud when automatic sync is disabled', async () => {
    const f = await fixture();
    await addRemote(f);
    const id = await f.capture();
    const cloud = databaseCloudClient();
    const result = await runInInvocationContext(
      {
        cwd: f.main,
        env: { ...env(f), ORCAOPS_DISABLE_DRAIN: '1' },
        cloudBaseUrl: 'https://cloud.example',
      },
      () =>
        captureSummary(
          { input: inputFile(JSON.stringify(summaryBody(id))) },
          new AbortController().signal,
          { cloud: cloud.dependencies }
        )
    );
    expect(result.cloud_sync).toEqual({ status: 'skipped', reason: 'drain_disabled' });
    expect(cloud.createCanonicalClient).not.toHaveBeenCalled();
    expect(cloud.calls).toEqual([]);
  });

  it('leaves a local-only capture quiet when no cloud credentials are configured', async () => {
    const f = await fixture();
    await addRemote(f);
    const id = await f.capture();
    const cloud = databaseCloudClient();
    cloud.credentialStore.read = async () => null;
    const result = await runSummary(f, summaryBody(id), { cloud: cloud.dependencies });
    expect(result.cloud_sync).toEqual({ status: 'skipped', reason: 'no_cloud_configured' });
    expect(cloud.createCanonicalClient).not.toHaveBeenCalled();
    expect(summaryOf(f, id)).not.toBeNull();
  });

  it('reports pending sync when usage advances while the original push is sent', async () => {
    const f = await fixture();
    await addRemote(f);
    const id = await f.capture();
    const cloud = databaseCloudClient();
    const original = cloud.client.captureThread.attachSummary;
    cloud.client.captureThread.attachSummary = async (input) => {
      const counters = {
        input_tokens: 9,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      const asOf = '2026-09-09T00:00:00Z';
      const payload = {
        snapshot_id: uuidv7(),
        idempotency_key: uuidv7(),
        agent: 'codex' as const,
        session_id: 'concurrent-session',
        artifact_id: id,
        source_plan_ref_id: null,
        lifecycle_event: 'checkpoint_close' as const,
        checkpoint_n: 1,
        cumulative_usage: counters,
        delta_usage: null,
        baseline_kind: 'first_observation' as const,
        model_breakdown: [{ model: 'test-model', cumulative: counters, delta: null }],
        record_count: 1,
        as_of: asOf,
      };
      const { record } = deriveUsageLedgerRecord({
        type: 'agent_usage_snapshot_recorded',
        ts: asOf,
        idempotency_key: payload.idempotency_key,
        payload,
      });
      await appendProjectUsageEvents(f.writer, {
        operationId: uuidv7(),
        expectedRevision: readProjectUsage(f.writer)?.revision ?? null,
        eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
        sidecarPayloads: [],
        secretAllow: [],
      });
      return original(input);
    };
    const result = await runSummary(f, summaryBody(id), { cloud: cloud.dependencies });
    expect(result.cloud_sync).toMatchObject({
      status: 'paused',
      reason: 'push_failed',
      code: 'STALE_CONTEXT',
      pending: 1,
    });
    expect(summaryOf(f, id)).not.toBeNull();
    expect(
      cloud.calls.filter((call) => call.method === 'captureThread.attachSummary')
    ).toHaveLength(1);
  });

  it('keeps replay free of cloud calls and database writes', async () => {
    const f = await fixture();
    await addRemote(f);
    const id = await f.capture();
    const body = summaryBody(id);
    const initial = databaseCloudClient();
    const first = await runFinish(f, body, { cloud: initial.dependencies });
    expect(first.cloud_sync).toMatchObject({ status: 'ok' });
    const before = await inventory(f.root);
    const replayCloud = databaseCloudClient({
      connectionError: new Error('replay must not connect'),
    });

    const replay = await runFinish(f, body, { cloud: replayCloud.dependencies });

    expect(replay).toMatchObject({
      idempotency_status: 'replay',
      cloud_sync: { status: 'skipped', reason: 'replay' },
    });
    expect(replayCloud.createCanonicalClient).not.toHaveBeenCalled();
    expect(replayCloud.calls).toEqual([]);
    expect(await inventory(f.root)).toEqual(before);
  });
});
