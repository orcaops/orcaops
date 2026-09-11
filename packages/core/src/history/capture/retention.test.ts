import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  beginProjectCaptureRetention,
  gitRetentionPreparation,
  openProjectDatabase,
  type PendingCaptureInput,
  prepareProjectGitRetention,
  type ProjectDatabase,
  readProjectArtifact,
  readProjectGitRetention,
  retireProjectGitRetention,
  settleProjectCaptureRetention,
} from '@orcaops/storage/history/database';

import { publishDatabaseCaptureRetention, resumeDatabaseCaptureRetention } from './retention.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
import * as gitPublication from '../retention/publication.js';
import { setupProjectDatabase } from '../setup/setup.js';

const execute = promisify(execFile);
const roots: string[] = [],
  handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((h) => h.close());
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]) {
  return (
    await execute('git', ['-C', cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    })
  ).stdout.trim();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'capture-publication-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await git(cwd, 'init', '-q', '-b', 'topic');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Retained baseline');
  const root = path.join(directory, 'history');
  await setupProjectDatabase({
    cwd,
    root,
    authoredPayloads: ['Disposable setup'],
    secretAllow: [],
  });
  const context = await requireDatabaseExecutionContext({ cwd, root });
  const handle = await openProjectDatabase({ authority: context.authority, mode: 'writer' });
  handles.push(handle);
  const prior = JSON.parse(
    await readFile(
      new URL(
        '../../../../storage/src/history/database/fixtures/retention-inputs.json',
        import.meta.url
      ),
      'utf8'
    )
  );
  const original = JSON.parse(
    Buffer.from(prior.rows.artifact_events[0].record_bytes.blobHex, 'hex').toString()
  );
  const { checksum: _checksum, ...record } = original;
  const treeOid = await git(cwd, 'rev-parse', 'HEAD^{tree}'),
    objectOid = await git(cwd, 'rev-parse', 'HEAD');
  record.payload.baseline_seed_tree_sha = treeOid;
  const checksum = createHash('sha256').update(canonical(record)).digest('hex');
  const capture: PendingCaptureInput = {
    artifactId: prior.rows.artifact_events[0].artifact_id,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...record, checksum }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
    execution: { kind: 'create', context: context.binding!, ts: '2026-09-01T00:00:00.000Z' },
  };
  const retention = prepareProjectGitRetention({
    operationId: capture.operationId,
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: context.authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:00:00.000Z',
    target: {
      kind: 'capture',
      artifactId: capture.artifactId,
      expectedRevision: null,
      expectedExecutionVersion: null,
      expectedBindingGeneration: null,
      expectedBaselinePublicationId: null,
    },
    publications: [
      {
        publicationId: uuidv7(),
        role: 'baseline',
        targetId: record.event_id,
        checkpointNumber: null,
        checkpointPhase: null,
        objectOid,
        treeOid,
      },
    ],
    secretAllow: [],
  });
  return { cwd, root, handle, context, capture, retention };
}
it('publishes admitted exact input and atomically selects its artifact and retained ref', async () => {
  const f = await fixture();
  const result = await publishDatabaseCaptureRetention(f.handle, f.context, f);
  expect(result.value.state).toBe('selected');
  expect(readProjectArtifact(f.handle, f.capture.artifactId)).not.toBeNull();
  const publication = gitRetentionPreparation(f.retention).publications[0]!;
  expect(await git(f.cwd, 'rev-parse', publication.fullRef)).toBe(publication.objectOid);
  expect(readProjectGitRetention(f.handle, f.capture.operationId).value!.current.kind).toBe(
    'selected'
  );
});
it('recovers a committed result with its retained transition after retirement and branch change', async () => {
  const f = await fixture();
  const prepared = gitRetentionPreparation(f.retention);
  await beginProjectCaptureRetention(f.handle, f);
  const selected = await settleProjectCaptureRetention(f.handle, {
    originalOperationId: f.capture.operationId,
    expectedTransitionId: prepared.preparedTransitionId,
    selectedTransitionId: uuidv7(),
  });
  await retireProjectGitRetention(f.handle, {
    originalOperationId: f.capture.operationId,
    expectedTransitionId: selected.value.transitionId,
    transitionId: uuidv7(),
    operationId: uuidv7(),
    secretAllow: [],
    reason: 'Retain selected history',
  });
  await git(f.cwd, 'checkout', '-qb', 'later-topic');
  const publication = vi.spyOn(gitPublication, 'publishDatabaseGitRef');
  const replay = await resumeDatabaseCaptureRetention(f.handle, f.context, f.capture.operationId);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(selected.value);
  expect(publication).not.toHaveBeenCalled();
});
it('keeps admitted input pending after context change and refuses passive retargeting', async () => {
  const f = await fixture();
  await beginProjectCaptureRetention(f.handle, f);
  await git(f.cwd, 'checkout', '-qb', 'later-topic');
  await expect(
    resumeDatabaseCaptureRetention(f.handle, f.context, f.capture.operationId)
  ).rejects.toMatchObject({ code: 'EXECUTION_CONTEXT_CHANGED' });
  expect(readProjectGitRetention(f.handle, f.capture.operationId).value!.current.kind).toBe(
    'prepared'
  );
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/orcaops/baseline/')).toBe(
    ''
  );
});
it('rejects an unknown original operation without creating domain history', async () => {
  const f = await fixture();
  const before = f.handle.read((view) => view.all('SELECT * FROM operations'));
  await expect(resumeDatabaseCaptureRetention(f.handle, f.context, uuidv7())).rejects.toMatchObject(
    { code: 'HISTORY_MISSING' }
  );
  expect(f.handle.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
});
it('leaves only an unused immutable ref when the original operation is retired before settlement', async () => {
  const f = await fixture();
  const prepared = gitRetentionPreparation(f.retention);
  await beginProjectCaptureRetention(f.handle, f);
  const publish = gitPublication.publishDatabaseGitRef;
  vi.spyOn(gitPublication, 'publishDatabaseGitRef').mockImplementationOnce(async (...args) => {
    const result = await publish(...args);
    await retireProjectGitRetention(f.handle, {
      operationId: uuidv7(),
      originalOperationId: f.capture.operationId,
      expectedTransitionId: prepared.preparedTransitionId,
      transitionId: uuidv7(),
      reason: 'Original capture cancelled',
      secretAllow: [],
    });
    return result;
  });
  await expect(
    resumeDatabaseCaptureRetention(f.handle, f.context, f.capture.operationId)
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProjectArtifact(f.handle, f.capture.artifactId)).toBeNull();
  expect(readProjectGitRetention(f.handle, f.capture.operationId).value!.current.kind).toBe(
    'retired'
  );
  expect(await git(f.cwd, 'rev-parse', prepared.publications[0]!.fullRef)).toBe(
    prepared.publications[0]!.objectOid
  );
  expect(
    f.handle.read((view) => view.all('SELECT * FROM artifact_baseline_current')).value
  ).toEqual([]);
});
it('refuses authored context mismatch before retaining a pending request', async () => {
  const f = await fixture();
  const original = f.capture.execution.context.git_context.branch;
  f.capture.execution.context.git_context.branch = 'different-topic';
  await expect(publishDatabaseCaptureRetention(f.handle, f.context, f)).rejects.toMatchObject({
    code: 'EXECUTION_CONTEXT_CHANGED',
  });
  expect(readProjectGitRetention(f.handle, f.capture.operationId).value).toBeNull();
  f.capture.execution.context.git_context.branch = original;
  expect((await publishDatabaseCaptureRetention(f.handle, f.context, f)).value.state).toBe(
    'selected'
  );
});
