import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  beginProjectCaptureRetention,
  beginProjectGitReclamation,
  gitRetentionPreparation,
  openProjectDatabase,
  type PendingCaptureInput,
  prepareProjectGitRetention,
  type ProjectDatabase,
  readProjectArtifact,
  readProjectGitReclamationAdmission,
  readProjectGitRetention,
  retireProjectGitRetention,
  settleProjectGitReclamation,
} from '@orcaops/storage/history/database';

import { inspectDatabaseMaintenance } from './maintenance.js';
import * as gitPublication from './publication.js';
import {
  applyDatabaseGitReclamation,
  previewDatabaseGitReclamation,
  resumeDatabaseGitReclamation,
} from './reclamation.js';
import { resumeDatabaseCaptureRetention } from '../capture/retention.js';
import { requireDatabaseExecutionContext } from '../context/execution.js';
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
async function retired() {
  const f = await fixture();
  const prepared = gitRetentionPreparation(f.retention);
  const publication = prepared.publications[0]!;
  await beginProjectCaptureRetention(f.handle, f);
  await gitPublication.publishDatabaseGitRef(f.context, {
    fullRef: publication.fullRef,
    objectOid: publication.objectOid,
    treeOid: publication.treeOid,
    objectFormat: prepared.objectFormat,
  });
  await retireProjectGitRetention(f.handle, {
    operationId: uuidv7(),
    originalOperationId: prepared.operationId,
    expectedTransitionId: prepared.preparedTransitionId,
    transitionId: uuidv7(),
    reason: 'Explicitly cancelled original capture',
    secretAllow: [],
  });
  const preview = previewDatabaseGitReclamation(f.handle, publication.publicationId).value;
  if (preview.status !== 'eligible') throw new Error('Fixture must be eligible');
  return {
    ...f,
    publication,
    admission: {
      admissionOperationId: uuidv7(),
      terminalOperationId: uuidv7(),
      target: preview.target,
    },
  };
}
it('previews without mutation and records explicit removal after durable admission', async () => {
  const f = await retired();
  const before = f.handle.read((v) => v.all('SELECT * FROM operations'));
  expect(previewDatabaseGitReclamation(f.handle, f.publication.publicationId).value.status).toBe(
    'eligible'
  );
  expect(f.handle.read((v) => v.all('SELECT * FROM operations'))).toEqual(before);
  const remove = gitPublication.removeDatabaseGitRef;
  vi.spyOn(gitPublication, 'removeDatabaseGitRef').mockImplementationOnce(async (...args) => {
    expect(
      readProjectGitReclamationAdmission(f.handle, f.admission.admissionOperationId).value
    ).toMatchObject({ input: f.admission, terminal: null });
    return remove(...args);
  });
  const result = await applyDatabaseGitReclamation(f.handle, f.context, f.admission);
  expect(result.value.outcome).toBe('removed');
  expect(await git(f.cwd, 'for-each-ref', '--format=%(refname)', f.publication.fullRef)).toBe('');
  expect(readProjectArtifact(f.handle, f.capture.artifactId)).toBeNull();
});
it('inspects database reclamation state and protects every unowned raw ref shape', async () => {
  const f = await retired();
  const unknown = `refs/orcaops/review/${uuidv7()}-${uuidv7()}`;
  const symbolic = `refs/orcaops/review/${uuidv7()}-${uuidv7()}-base`;
  const dangling = path.join(f.context.git.commonDir, 'refs/orcaops/dangling');
  const malformed = path.join(f.context.git.commonDir, 'refs/orcaops/malformed');
  await git(f.cwd, 'update-ref', unknown, f.publication.objectOid);
  await git(f.cwd, 'symbolic-ref', symbolic, 'refs/heads/topic');
  await mkdir(path.dirname(dangling), { recursive: true });
  await writeFile(dangling, 'ref: refs/heads/missing\n');
  await writeFile(malformed, 'not-an-object\n');
  const before = f.handle.read((view) => view.all('SELECT * FROM operations'));

  const inspection = await inspectDatabaseMaintenance(f.handle, f.context);

  expect(inspection.completeness).toEqual({ complete: true, issues: [] });
  expect(inspection.resources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        publicationId: f.publication.publicationId,
        fullRef: f.publication.fullRef,
        state: 'eligible',
        reason: 'retired',
      }),
      expect.objectContaining({ fullRef: unknown, state: 'protected', reason: 'unknown' }),
      expect.objectContaining({ fullRef: symbolic, state: 'protected', reason: 'symbolic' }),
      expect.objectContaining({
        fullRef: 'refs/orcaops/dangling',
        state: 'protected',
        reason: expect.stringMatching(/dangling|symbolic/),
      }),
      expect.objectContaining({
        fullRef: 'refs/orcaops/malformed',
        state: 'protected',
        reason: 'dangling',
      }),
    ])
  );
  expect(f.handle.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
});
it('replays completed cleanup before inspecting changed context or a recreated ref', async () => {
  const f = await retired();
  const result = await applyDatabaseGitReclamation(f.handle, f.context, f.admission);
  await git(f.cwd, 'update-ref', f.publication.fullRef, f.publication.objectOid);
  await git(f.cwd, 'checkout', '-qb', 'later');
  const remove = vi.spyOn(gitPublication, 'removeDatabaseGitRef');
  const replay = await resumeDatabaseGitReclamation(
    f.handle,
    f.context,
    f.admission.admissionOperationId
  );
  expect(replay).toEqual({ ...result, replayed: true });
  expect(remove).not.toHaveBeenCalled();
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
  expect(await applyDatabaseGitReclamation(f.handle, f.context, f.admission)).toEqual(replay);
});
it('recovers interrupted deletion as observed absence without inventing removal proof', async () => {
  const f = await retired();
  const remove = gitPublication.removeDatabaseGitRef;
  vi.spyOn(gitPublication, 'removeDatabaseGitRef').mockImplementationOnce(async (...args) => {
    await remove(...args);
    throw new Error('Simulated process boundary after deletion before settlement');
  });
  await expect(applyDatabaseGitReclamation(f.handle, f.context, f.admission)).rejects.toThrow(
    'Simulated process boundary'
  );
  expect(
    readProjectGitReclamationAdmission(f.handle, f.admission.admissionOperationId).value!.terminal
  ).toBeNull();
  vi.restoreAllMocks();
  const result = await resumeDatabaseGitReclamation(
    f.handle,
    f.context,
    f.admission.admissionOperationId
  );
  expect(result.value.outcome).toBe('absent');
});
it('protects unknown admissions and altered authored targets without Git effects', async () => {
  const f = await retired();
  const remove = vi.spyOn(gitPublication, 'removeDatabaseGitRef');
  const before = f.handle.read((v) => v.all('SELECT * FROM operations'));
  await expect(resumeDatabaseGitReclamation(f.handle, f.context, uuidv7())).rejects.toMatchObject({
    code: 'HISTORY_MISSING',
  });
  await expect(
    applyDatabaseGitReclamation(f.handle, f.context, {
      ...f.admission,
      target: { ...f.admission.target, objectOid: 'c'.repeat(40) },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(remove).not.toHaveBeenCalled();
  expect(f.handle.read((v) => v.all('SELECT * FROM operations'))).toEqual(before);
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
});
it('protects symbolic refs and retains cancellation for an original pending cleanup', async () => {
  const f = await retired();
  await beginProjectGitReclamation(f.handle, f.admission);
  await expect(
    resumeDatabaseGitReclamation(f.handle, f.context, f.admission.admissionOperationId, {
      signal: AbortSignal.abort(),
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
  await git(f.cwd, 'update-ref', '-d', f.publication.fullRef);
  await git(f.cwd, 'symbolic-ref', f.publication.fullRef, 'refs/heads/topic');
  await expect(
    resumeDatabaseGitReclamation(f.handle, f.context, f.admission.admissionOperationId)
  ).rejects.toMatchObject({ code: 'HISTORY_UNEXPECTED_OWNER' });
  expect(await git(f.cwd, 'symbolic-ref', f.publication.fullRef)).toBe('refs/heads/topic');
  expect(
    readProjectGitReclamationAdmission(f.handle, f.admission.admissionOperationId).value!.terminal
  ).toBeNull();
});
it('returns a known terminal result after a concurrent settlement and cancellation', async () => {
  const f = await retired();
  const controller = new AbortController();
  const remove = gitPublication.removeDatabaseGitRef;
  vi.spyOn(gitPublication, 'removeDatabaseGitRef').mockImplementationOnce(async (...args) => {
    const outcome = await remove(...args);
    await settleProjectGitReclamation(f.handle, {
      admissionOperationId: f.admission.admissionOperationId,
      outcome: outcome.outcome,
    });
    controller.abort();
    throw new Error('Child cleanup failed after known concurrent settlement');
  });
  const result = await applyDatabaseGitReclamation(f.handle, f.context, f.admission, {
    signal: controller.signal,
  });
  expect(result).toMatchObject({ replayed: true, value: { outcome: 'removed' } });
});
it('keeps a late stale publisher unused after explicit cleanup', async () => {
  const f = await retired();
  await applyDatabaseGitReclamation(f.handle, f.context, f.admission);
  await gitPublication.publishDatabaseGitRef(f.context, {
    fullRef: f.publication.fullRef,
    objectOid: f.publication.objectOid,
    treeOid: f.publication.treeOid,
    objectFormat: 'sha1',
  });
  await expect(
    resumeDatabaseCaptureRetention(f.handle, f.context, f.capture.operationId)
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProjectArtifact(f.handle, f.capture.artifactId)).toBeNull();
  expect(f.handle.read((v) => v.all('SELECT * FROM artifact_baseline_current')).value).toEqual([]);
  expect(readProjectGitRetention(f.handle, f.capture.operationId).value!.current.kind).toBe(
    'retired'
  );
  expect(await git(f.cwd, 'rev-parse', f.publication.fullRef)).toBe(f.publication.objectOid);
}, 15_000);
