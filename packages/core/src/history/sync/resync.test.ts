import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

import { CapturePlanInputSchema, sha256Hex, uuidv7 } from '@orcaops/storage';
import { openProjectDatabase, type ProjectDatabase } from '@orcaops/storage/history/database';

import { pushDatabaseArtifact, resyncDatabaseArtifacts } from './artifact-sync.js';
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
function fakeClient() {
  const sent: string[] = [];
  const method = (name: string) => async () => {
    sent.push(name);
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
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'db-resync-')));
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
  async function capture(
    sourcePlan: Parameters<typeof captureDatabasePlan>[2]['sourcePlan'] = null
  ) {
    const plan = await captureDatabasePlan(handle, context, {
      authored: CapturePlanInputSchema.parse({
        idempotency_key: uuidv7(),
        task: 'Drain the retained thread',
        label: 'Resync fixture',
        plan_steps: [
          {
            text: 'Drain',
            label: 'Drain',
            acceptance_criteria: [{ text: 'The pending queue drains to empty' }],
          },
        ],
      }),
      sourcePlan,
      agent: 'codex',
      snapshot: { enabled: false, excludePatterns: [] },
      secretAllow: [],
    });
    return plan.artifactId;
  }
  return { handle, capture };
}
const localPin = (content: string) => ({
  source_ref: { kind: 'local' as const, locator: 'plan.md' },
  content,
  hash: sha256Hex(content),
  baseline: null,
});
const cloudPin = (content: string) => ({
  source_ref: {
    kind: 'cloud' as const,
    locator: 'approved-plan',
    version: '3',
    base_url: target.server_url,
    org_id: target.org_id,
  },
  content,
  hash: sha256Hex(content),
  baseline: null,
});

it('flushes every pending artifact through the dispatch over the fake client', async () => {
  const f = await fixture();
  await f.capture();
  await f.capture();
  const { client, sent } = fakeClient();
  const result = await resyncDatabaseArtifacts(f.handle, { target, repoUrl, client });
  expect(result.pending).toBe(2);
  expect(result.results.every((r) => 'outcome' in r && r.outcome.status === 'pushed')).toBe(true);
  // Two calls (start + attachPlan) per artifact, both flushed over the same fake client.
  expect(sent).toHaveLength(4);
});
it('leaves an already-synced artifact out of the pending scan', async () => {
  const f = await fixture();
  const synced = await f.capture();
  const stillPending = await f.capture();
  await pushDatabaseArtifact(f.handle, synced, { target, repoUrl, client: fakeClient().client });
  const { client } = fakeClient();
  const result = await resyncDatabaseArtifacts(f.handle, { target, repoUrl, client });
  expect(result.pending).toBe(1);
  expect(result.results.map((r) => r.artifactId)).toEqual([stillPending]);
});
it('records a per-artifact refusal and keeps flushing the rest', async () => {
  const f = await fixture();
  const pinned = await f.capture(localPin('# Pinned\n\nbody'));
  const plain = await f.capture();
  const { client } = fakeClient();
  const result = await resyncDatabaseArtifacts(f.handle, { target, repoUrl, client });
  expect(result.pending).toBe(2);
  const refused = result.results.find((r) => r.artifactId === pinned);
  expect(refused && 'error' in refused ? refused.error.code : null).toBe('CLOUD_PUSH_UNAVAILABLE');
  const ok = result.results.find((r) => r.artifactId === plain);
  expect(ok && 'outcome' in ok ? ok.outcome.status : null).toBe('pushed');
});
it('aborts the whole flush under a cancelled signal without sending', async () => {
  const f = await fixture();
  await f.capture();
  await f.capture();
  const { client, sent } = fakeClient();
  const stop = new AbortController();
  stop.abort();
  await expect(
    resyncDatabaseArtifacts(f.handle, { target, repoUrl, client, signal: stop.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(sent).toEqual([]);
});

it('honors cancellation when there are no artifacts to drain', async () => {
  const f = await fixture();
  const stop = new AbortController();
  stop.abort();
  const { client, sent } = fakeClient();
  await expect(
    resyncDatabaseArtifacts(f.handle, { target, repoUrl, client, signal: stop.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(sent).toEqual([]);
});

it('refuses a selected artifact whose owner-ref requirement changed before dispatch', async () => {
  const f = await fixture();
  const artifactId = await f.capture(cloudPin('# Pinned after qualification'));
  const { client, sent } = fakeClient();

  const result = await resyncDatabaseArtifacts(f.handle, {
    target,
    repoUrl,
    client,
    selection: [{ artifactId, requiresSourcePlanOwnerRef: false }],
  });

  expect(result).toEqual({
    pending: 1,
    results: [
      {
        artifactId,
        error: {
          code: 'STALE_CONTEXT',
          message: `Artifact ${artifactId} changed its cloud capability requirement after resync qualification; rerun resync to qualify the current work`,
        },
      },
    ],
  });
  expect(sent).toEqual([]);
});
