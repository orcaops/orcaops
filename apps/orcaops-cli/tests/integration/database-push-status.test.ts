import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { createTempRepo } from '@orcaops/test-harness';

import { recordProjectCloudSyncFailure } from '../../../../packages/storage/dist/history/database/cloud-sync.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

afterEach(() => vi.restoreAllMocks());

const target = { server_url: 'https://cloud.example', org_id: 'team', account_id: 'owner' };

function agent(f: Awaited<ReturnType<typeof fixture>>) {
  return makeAgent({
    cwd: f.main,
    env: { ORCAOPS_ROOT: f.main, ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
}

async function fail(
  f: Awaited<ReturnType<typeof fixture>>,
  artifactId: string,
  kind: 'network' | 'content-invalid' | 'upgrade-required',
  account = target,
  count = 1
) {
  const now = new Date().toISOString();
  for (let index = 0; index < count; index++)
    await recordProjectCloudSyncFailure(
      f.writer,
      {
        operationId: uuidv7(),
        revisionId: uuidv7(),
        artifactId,
        target: account,
        kind,
        message: 'Recorded upload failure',
        attemptedAt: now,
        attemptStartedAt: now,
      },
      { secretAllow: [] }
    );
}

it('shows account-scoped failures and backoff without changing captured history', async () => {
  const f = await fixture();
  const artifactId = await f.capture();
  await fail(f, artifactId, 'network', target, 3);
  await fail(f, artifactId, 'upgrade-required', { ...target, account_id: 'another-owner' });
  const before = await inventory(f.temporary);
  const result = await agent(f).runRaw(['push-status', '--json']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.pending).toHaveLength(2);
  expect(
    body.pending.find((row: { target: typeof target }) => row.target.account_id === 'owner')
  ).toMatchObject({
    artifact_id: artifactId,
    target,
    consecutive_failures: 3,
    last_push_error_kind: 'network',
  });
  const delay = body.pending.find(
    (row: { target: typeof target }) => row.target.account_id === 'owner'
  ).next_attempt_seconds_from_now;
  expect(delay).toBeGreaterThan(60);
  expect(delay).toBeLessThanOrEqual(120);
  expect(await inventory(f.temporary)).toEqual(before);

  const status = await agent(f).runRaw(['status', '--json']);
  expect(status.exitCode, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout).cloud_sync).toMatchObject({
    state: 'available',
    pending_count: 1,
    stuck_count: 1,
  });
});

it('keeps deterministic failure guidance and labels its recorded destination', async () => {
  const f = await fixture();
  const artifactId = await f.capture();
  await fail(f, artifactId, 'upgrade-required');
  const result = await agent(f).runRaw(['push-status']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).not.toContain('resync --force');
  expect(result.stdout).toContain('newer orcaops install');
  expect(result.stdout).toContain('https://cloud.example / team / owner');
});

it('preserves content-invalid history and directs diagnosis without an unsupported rewrite', async () => {
  const f = await fixture();
  const artifactId = await f.capture();
  await fail(f, artifactId, 'content-invalid');
  const result = await agent(f).runRaw(['push-status']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('orcaops doctor');
  expect(result.stdout).toContain('preserve the retained artifact');
  expect(result.stdout).toContain('rebuild` cannot recreate or change retained history');
  expect(result.stdout).not.toContain('scrub');
});

it('reports a never-uploaded artifact without assigning it an account', async () => {
  const f = await fixture();
  const artifactId = await f.capture();
  const result = await agent(f).runRaw(['push-status', '--json']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).pending).toMatchObject([
    { artifact_id: artifactId, target: null, consecutive_failures: 0, next_attempt_at: null },
  ]);
});

it('refuses unregistered history without initializing the repository', async () => {
  const repo = await createTempRepo({ initialBranch: 'main' });
  try {
    const before = await inventory(repo.path);
    const result = await makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DATA_DIR: `${repo.path}/history` },
    }).runRaw(['push-status', '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('PROJECT_IDENTITY_UNAVAILABLE');
    expect(await inventory(repo.path)).toEqual(before);
  } finally {
    await repo.cleanup();
  }
});

it('reports no pending uploads in an empty registered project', async () => {
  const f = await fixture();
  const before = await inventory(f.temporary);
  const result = await agent(f).runRaw(['push-status', '--json']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).pending).toEqual([]);
  expect(await inventory(f.temporary)).toEqual(before);
});
