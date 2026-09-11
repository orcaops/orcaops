import { expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  readProjectCloudSyncState,
  recordProjectCloudSyncFailure,
} from '@orcaops/storage/history/database';

import { drainDatabaseAfterLogin } from './database-login-drain.js';
import { runInInvocationContext } from './invocation-context.js';
import { databaseCloudClient } from '../../tests/helpers/database-cloud-client.js';
import { fixture, git, inventory } from '../../tests/helpers/database-history.js';

async function prepared() {
  const f = await fixture();
  await git(f.main, ['remote', 'add', 'origin', 'https://github.com/team/repo.git']);
  const cloud = databaseCloudClient();
  const input = {
    baseUrl: cloud.target.server_url,
    orgId: cloud.target.org_id,
    accountId: cloud.target.account_id,
    credentialStore: cloud.credentialStore,
  };
  const invocation = {
    cwd: f.main,
    env: { ORCAOPS_ROOT: f.main, ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '0' },
  };
  return { f, cloud, input, invocation };
}

it('leaves a disabled drain and an empty project untouched', async () => {
  const { f, cloud, input, invocation } = await prepared();
  const before = await inventory(f.temporary);
  expect(
    await runInInvocationContext(
      { ...invocation, env: { ...invocation.env, ORCAOPS_DISABLE_DRAIN: '1' } },
      () => drainDatabaseAfterLogin(input, { cloud: cloud.dependencies })
    )
  ).toBeNull();
  expect(
    await runInInvocationContext(invocation, () =>
      drainDatabaseAfterLogin(input, { cloud: cloud.dependencies })
    )
  ).toEqual({ attempted: 0, timedOut: false, skippedForeignOrg: 0 });
  expect(cloud.createCanonicalClient).not.toHaveBeenCalled();
  expect(await inventory(f.temporary)).toEqual(before);
});

it('uploads only eligible local history to the just-authenticated account', async () => {
  const { f, cloud, input, invocation } = await prepared();
  const fresh = await f.capture();
  const foreign = await f.capture();
  const backoff = await f.capture();
  for (const [artifactId, target, attemptedAt] of [
    [foreign, { ...cloud.target, account_id: 'other-account' }, '2020-01-01T00:00:00Z'],
    [backoff, cloud.target, new Date().toISOString()],
  ] as const) {
    await recordProjectCloudSyncFailure(
      f.writer,
      {
        operationId: uuidv7(),
        revisionId: uuidv7(),
        artifactId,
        target,
        attemptedAt,
        attemptStartedAt: attemptedAt,
        kind: 'network',
        message: 'Original failure',
      },
      { secretAllow: [] }
    );
  }
  const result = await runInInvocationContext(invocation, () =>
    drainDatabaseAfterLogin(input, { cloud: cloud.dependencies, totalBudgetMs: 10000 })
  );
  expect(result).toEqual({ attempted: 1, timedOut: false, skippedForeignOrg: 1 });
  expect(cloud.createCanonicalClient).toHaveBeenCalledWith(
    expect.objectContaining({ target: cloud.target, store: cloud.credentialStore })
  );
  expect(cloud.calls.filter((call) => call.method === 'captureThread.start')).toHaveLength(1);
  expect(cloud.calls.find((call) => call.method === 'captureThread.start')?.input).toMatchObject({
    externalId: fresh,
  });
  expect(readProjectCloudSyncState(f.writer, foreign, cloud.target)?.publicState).toBeNull();
  expect(readProjectCloudSyncState(f.writer, backoff, cloud.target)?.consecutiveFailures).toBe(1);
});

it('retains a failed upload observation and honors its backoff on the next login', async () => {
  const { f, input, invocation } = await prepared();
  const artifactId = await f.capture();
  const cloud = databaseCloudClient({ fail: new Set(['captureThread.start']) });
  const options = { ...input, credentialStore: cloud.credentialStore };
  expect(
    await runInInvocationContext(invocation, () =>
      drainDatabaseAfterLogin(options, { cloud: cloud.dependencies })
    )
  ).toEqual({ attempted: 1, timedOut: false, skippedForeignOrg: 0 });
  expect(readProjectCloudSyncState(f.writer, artifactId, cloud.target)).toMatchObject({
    consecutiveFailures: 1,
    lastError: { kind: 'unknown' },
  });
  const calls = cloud.calls.length;
  expect(
    await runInInvocationContext(invocation, () =>
      drainDatabaseAfterLogin(options, { cloud: cloud.dependencies })
    )
  ).toEqual({ attempted: 0, timedOut: false, skippedForeignOrg: 0 });
  expect(cloud.calls).toHaveLength(calls);
});

it('cancels cloud qualification at the drain deadline before opening a writer', async () => {
  const { f, input, invocation, cloud } = await prepared();
  await f.capture();
  const before = await inventory(f.temporary);
  const openWriter = vi.fn();
  let observed: AbortSignal | undefined;
  const createCanonicalClient = vi.fn(async (request: { signal?: AbortSignal }) => {
    observed = request.signal;
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) resolve();
      else request.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    throw request.signal?.reason;
  });
  const result = await runInInvocationContext(invocation, () =>
    drainDatabaseAfterLogin(input, {
      totalBudgetMs: 5000,
      perPushTimeoutMs: 2000,
      cloud: { ...cloud.dependencies, openWriter, connection: { createCanonicalClient } },
    })
  );
  expect(result).toEqual({ attempted: 1, timedOut: true, skippedForeignOrg: 0 });
  expect(observed?.aborted).toBe(true);
  expect(openWriter).not.toHaveBeenCalled();
  expect(await inventory(f.temporary)).toEqual(before);
});
