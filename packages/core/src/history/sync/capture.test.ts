import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

import { CapturePlanInputSchema, sha256Hex, uuidv7 } from '@orcaops/storage';
import {
  openProjectDatabase,
  type ProjectDatabase,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { syncCompletedCapture } from './artifact-sync.js';
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
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'db-capture-sync-')));
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
        task: 'Record the completed capture sync',
        label: 'Capture sync fixture',
        plan_steps: [{ text: 'Sync', label: 'Sync' }],
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

it('records a completed capture as synced over the fake client', async () => {
  const f = await fixture();
  const artifactId = await f.capture();
  const { client, sent } = fakeClient();
  const report = await syncCompletedCapture(f.handle, artifactId, { target, repoUrl, client });
  expect(report).toEqual({ status: 'synced', cloudApplied: true, hash: expect.any(String) });
  expect(sent).toEqual(['captureThread.start', 'captureThread.attachPlan']);
});
it('reports skipped when the completed capture is already synced', async () => {
  const f = await fixture();
  const artifactId = await f.capture();
  await syncCompletedCapture(f.handle, artifactId, {
    target,
    repoUrl,
    client: fakeClient().client,
  });
  const second = fakeClient();
  const report = await syncCompletedCapture(f.handle, artifactId, {
    target,
    repoUrl,
    client: second.client,
  });
  expect(report.status).toBe('skipped');
  expect(second.sent).toEqual([]);
});
it('reports a refusal without failing the capture', async () => {
  const f = await fixture();
  const pinned = await f.capture(localPin('# Pinned\n\nbody'));
  const report = await syncCompletedCapture(f.handle, pinned, {
    target,
    repoUrl,
    client: fakeClient().client,
  });
  expect(report).toMatchObject({ status: 'refused', code: 'CLOUD_PUSH_UNAVAILABLE' });
  // The committed capture is untouched by the refused sync — its plan is still retained intact.
  expect(readProjectArtifact(f.handle, pinned)!.thread.plan).not.toBeNull();
});
