import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import {
  captureDatabasePlan,
  requireDatabaseExecutionContext,
  setupProjectDatabase,
} from '@orcaops/core/history/database-capture';
import { CapturePlanInputSchema, sha256Hex, type SourcePlanPin, uuidv7 } from '@orcaops/storage';
import { openProjectDatabase, ProjectDatabaseError } from '@orcaops/storage/history/database';

import { pushAction } from '../../src/commands/push.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { databaseCloudClient } from '../helpers/database-cloud-client.js';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]) {
  await execute('git', ['-c', 'gc.auto=0', '-C', cwd, ...args], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_OPTIONAL_LOCKS: '0',
    },
    timeout: 10_000,
  });
}

async function repository() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'cli-push-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Original fixture');
  await git(cwd, 'remote', 'add', 'origin', 'git@github.com:team/repo.git');
  return { directory, cwd, root: path.join(directory, 'history') };
}

async function fixture(sourcePlan: SourcePlanPin | null = null) {
  const repo = await repository();
  await setupProjectDatabase({
    cwd: repo.cwd,
    root: repo.root,
    authoredPayloads: ['Disposable checkout'],
    secretAllow: [],
  });
  const context = await requireDatabaseExecutionContext({ cwd: repo.cwd, root: repo.root });
  const handle = await openProjectDatabase({ authority: context.authority, mode: 'writer' });
  try {
    const plan = await captureDatabasePlan(handle, context, {
      authored: CapturePlanInputSchema.parse({
        idempotency_key: uuidv7(),
        task: 'Push it',
        label: 'Push fixture',
        plan_steps: [{ text: 'Push', label: 'Push' }],
      }),
      sourcePlan,
      agent: 'codex',
      snapshot: { enabled: false, excludePatterns: [] },
      secretAllow: [],
    });
    return { ...repo, artifactId: plan.artifactId };
  } finally {
    handle.close();
  }
}

function invocation(f: { cwd: string; root: string }, action: () => Promise<void>) {
  return runInInvocationContext(
    {
      cwd: f.cwd,
      env: {
        ORCAOPS_ROOT: f.cwd,
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
        CODEX_SESSION_ID: 'database-push',
      },
      cloudBaseUrl: 'https://cloud.example',
    },
    action
  );
}

async function run(action: () => Promise<void>) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  try {
    await action();
  } catch {
    // emitError writes before requesting a non-zero process exit.
  }
  return JSON.parse(writes.join('')) as { ok: boolean } & Record<string, unknown>;
}

it('pushes a registered artifact through the default authenticated composition', async () => {
  const f = await fixture();
  const cloud = databaseCloudClient();
  const body = await run(() =>
    invocation(f, () => pushAction(f.artifactId, {}, { cloud: cloud.dependencies }))
  );

  expect(body).toMatchObject({
    ok: true,
    status: 'pushed',
    cloudApplied: true,
    artifactId: f.artifactId,
  });
  expect(cloud.calls.map((call) => call.method)).toEqual([
    'captureThread.start',
    'captureThread.attachPlan',
  ]);
  expect(cloud.qualifiedRequirements).toEqual([[]]);
});

it('preflights and attaches a retained cloud Source Plan through the default client', async () => {
  const content = '# Approved plan';
  const f = await fixture({
    source_ref: {
      kind: 'cloud',
      locator: 'approved-plan',
      version: '3',
      base_url: 'https://cloud.example',
      org_id: 'authenticated-org',
    },
    content,
    hash: sha256Hex(content),
    baseline: null,
  });
  const cloud = databaseCloudClient();
  const body = await run(() =>
    invocation(f, () => pushAction(f.artifactId, {}, { cloud: cloud.dependencies }))
  );

  expect(body.ok).toBe(true);
  expect(cloud.qualifiedRequirements).toEqual([['source-plan-owner-ref/v1']]);
  expect(cloud.calls.map((call) => call.method)).toEqual([
    'sourcePlan.get',
    'captureThread.start',
    'captureThread.attachPlan',
    'sourcePlan.attachPin',
  ]);
});

it('refuses a missing registered database without initializing or qualifying cloud', async () => {
  const f = await repository();
  const cloud = databaseCloudClient();
  const body = await run(() =>
    invocation(f, () => pushAction(uuidv7(), {}, { cloud: cloud.dependencies }))
  );

  expect(body).toMatchObject({ ok: false, error: { code: 'HISTORY_MISSING' } });
  expect(cloud.createCanonicalClient).not.toHaveBeenCalled();
});

it('preserves authenticated target-change failures', async () => {
  const f = await fixture();
  const cloud = databaseCloudClient({
    connectionError: Object.assign(new Error('Authenticated target changed'), {
      code: 'CLOUD_TARGET_CHANGED',
    }),
  });
  const body = await run(() =>
    invocation(f, () => pushAction(f.artifactId, {}, { cloud: cloud.dependencies }))
  );

  expect(body).toMatchObject({ ok: false, error: { code: 'CLOUD_TARGET_CHANGED' } });
});

it('passes a cancellable signal and named wait callback to the session boundary', async () => {
  const wait = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const body = await run(() =>
    pushAction(
      uuidv7(),
      {},
      {
        openSession: async ({ signal, onWait }) => {
          expect(signal.aborted).toBe(false);
          onWait({ operation: 'artifact.push', reason: 'admission', attempt: 1 });
          onWait({ operation: 'artifact.push', reason: 'transaction-retry', attempt: 2 });
          throw new ProjectDatabaseError('CANCELLED', 'Push cancelled');
        },
      }
    )
  );

  expect(body).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  expect(wait).toHaveBeenCalledOnce();
  expect(String(wait.mock.calls[0]?.[0])).toContain('Waiting for push');
});
