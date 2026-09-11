import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import * as retention from '@orcaops/core/history/database-retention';
import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';
import { readProjectPendingReview } from '@orcaops/storage/history/database/review-retention';

import { prepareDatabaseReviewFloor } from './floor-preparation.js';
import { publishDatabaseReviewFloor } from './floors.js';
import { resumeDatabaseReviewPublication } from './publication-resume.js';
import { changeDatabaseReviewBase, createDatabaseReview } from './reviews.js';

vi.mock('@orcaops/core/history/database-retention', async (original) => {
  const actual = await original<typeof retention>();
  return {
    ...actual,
    publishDatabaseGitRef: vi.fn(actual.publishDatabaseGitRef),
    requireDatabaseExecutionContext: vi.fn(actual.requireDatabaseExecutionContext),
  };
});
vi.mock('@orcaops/storage/history/database', async (original) => {
  const actual = await original<typeof store>();
  return {
    ...actual,
    runProjectOperation: vi.fn(actual.runProjectOperation),
    openProjectDatabase: vi.fn(actual.openProjectDatabase),
    publishProjectEvidence: vi.fn(actual.publishProjectEvidence),
  };
});
const exec = promisify(execFile);
const roots: string[] = [];
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 3) + '\n');
async function git(cwd: string, args: string[]) {
  return (
    await exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    })
  ).stdout.trim();
}
async function fixture(policy: 'none' | 'auto' | 'explicit' = 'none') {
  const root = await mkdtemp(path.join(tmpdir(), 'retained-review-resume-'));
  roots.push(root);
  const gitRoot = path.join(root, 'repo');
  await mkdir(gitRoot);
  await git(gitRoot, ['init', '--quiet']);
  await writeFile(path.join(gitRoot, 'value.txt'), 'original\n');
  await git(gitRoot, ['add', 'value.txt']);
  await git(gitRoot, ['commit', '--quiet', '-m', 'Original floor base']);
  const baseOid = await git(gitRoot, ['rev-parse', 'HEAD']);
  const baseTree = await git(gitRoot, ['rev-parse', 'HEAD^{tree}']);
  await writeFile(path.join(gitRoot, 'value.txt'), 'changed\n');
  await git(gitRoot, ['add', 'value.txt']);
  const treeOid = await git(gitRoot, ['write-tree']);
  const authority = (
    await setupProjectDatabase({
      cwd: gitRoot,
      root: path.join(root, 'history'),
      authoredPayloads: [],
      secretAllow: [],
    })
  ).initialization.authority;
  const reviewId = uuidv7();
  const operationId = uuidv7();
  const membershipRevisionId = uuidv7();
  await createDatabaseReview({
    authority,
    operationId,
    secretAllow: [],
    identityBytes: bytes({
      schema_version: 1,
      review_id: reviewId,
      project_id: authority.projectId,
      store_instance_id: authority.storeInstanceId,
      repository_instance_id: authority.repositoryInstanceId,
      created_by_operation: operationId,
      initial_context: { worktree_id: null, branch: 'topic', base_sha: null, head_sha: null },
      artifact_ids: [],
      legacy_source_ids: [],
    }),
    membershipBytes: bytes({ revisionId: membershipRevisionId, members: [], source: null }),
  });
  const generatedAt = '2026-06-01T00:00:00.000Z';
  const base =
    policy === 'none'
      ? undefined
      : {
          revisionId: uuidv7(),
          bytes: bytes(
            policy === 'auto'
              ? { kind: 'auto', recordedAt: generatedAt, source: null }
              : {
                  kind: 'explicit',
                  ref: 'résumé-base',
                  oid: baseTree,
                  recordedAt: generatedAt,
                  source: null,
                }
          ),
        };
  const prepared = await prepareDatabaseReviewFloor({
    authority,
    reviewId,
    expected: {
      membershipRevisionId,
      membershipVersion: 1,
      baseRevisionId: null,
      baseVersion: 0,
      floorVersion: 0,
    },
    basis: {
      gitRoot,
      baseSha: policy === 'explicit' ? baseTree : baseOid,
      pinnedTreeSha: treeOid,
      worktreeHead: baseOid,
      defaultBranch: null,
      fingerprintMaxDiffBytes: 100000,
      reviewMaxDiffBytes: 100000,
      reviewIncludedUntracked: [],
    },
    generatedAt,
    secretAllow: [],
    ...(base ? { base } : {}),
  });
  const request = {
    authority,
    reviewId,
    operationId: uuidv7(),
    publicationId: uuidv7(),
    secretAllow: [],
    basis: prepared.basis,
    expected: prepared.expected,
    floorBytes: prepared.floorBytes,
    diffBytes: prepared.diffBytes,
    ...(prepared.base ? { base: prepared.base } : {}),
  };
  return {
    root,
    gitRoot,
    authority,
    reviewId,
    baseOid,
    baseTree,
    treeOid,
    generatedAt,
    request,
    sourceCounters: prepared.counters,
  };
}
function resumeInput(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    authority: f.authority,
    reviewId: f.reviewId,
    operationId: f.request.operationId,
    gitRoot: f.gitRoot,
    secretAllow: [],
  };
}
async function pending(f: Awaited<ReturnType<typeof fixture>>) {
  const database = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  try {
    return {
      pending: readProjectPendingReview(database, f.request.operationId),
      rows: database.read((view) => ({
        selection: view.get('SELECT * FROM review_selections'),
        receipts: view.all('SELECT * FROM operations ORDER BY operation_id'),
      })),
    };
  } finally {
    database.close();
  }
}
async function pauseFloor(f: Awaited<ReturnType<typeof fixture>>) {
  vi.mocked(retention.publishDatabaseGitRef).mockRejectedValueOnce(
    new store.ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Pause original publication')
  );
  await expect(publishDatabaseReviewFloor(f.request)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  vi.clearAllMocks();
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each(['none', 'explicit'] as const)(
  'resumes the exact original floor with %s policy and replays without external files',
  async (policy) => {
    const f = await fixture(policy);
    await pauseFloor(f);
    const original = (await pending(f)).pending.value!;
    const result = await resumeDatabaseReviewPublication(resumeInput(f));
    expect(result.kind).toBe('floor');
    expect(result.value).toMatchObject({ publicationId: f.request.publicationId, floorVersion: 1 });
    expect(result.replayed).toBe(false);
    expect((await pending(f)).pending.value!.original).toEqual(original.original);
    const observed = await pending(f);
    await rm(f.gitRoot, { recursive: true });
    await rm(path.join(path.dirname(store.projectDatabasePath(f.authority)), 'evidence'), {
      recursive: true,
    });
    vi.clearAllMocks();
    const { gitRoot: _gitRoot, ...request } = resumeInput(f);
    expect(await resumeDatabaseReviewPublication(request)).toEqual({ ...result, replayed: true });
    expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
    expect(store.publishProjectEvidence).not.toHaveBeenCalled();
    expect(
      vi.mocked(store.openProjectDatabase).mock.calls.every(([open]) => open.mode === 'reader')
    ).toBe(true);
    expect((await pending(f)).rows).toEqual(observed.rows);
  },
  15000
);
it('resumes original explicit base bytes and returns its receipt without a checkout', async () => {
  const f = await fixture();
  const original = {
    ...resumeInput(f),
    revisionId: uuidv7(),
    expectedVersion: 0,
    baseBytes: bytes({
      kind: 'explicit',
      ref: 'original-name',
      oid: f.baseOid,
      recordedAt: f.generatedAt,
      source: null,
    }),
  };
  vi.mocked(retention.publishDatabaseGitRef).mockRejectedValueOnce(
    new store.ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Pause original base')
  );
  await expect(changeDatabaseReviewBase(original)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  const admitted = (await pending(f)).pending.value!;
  const result = await resumeDatabaseReviewPublication(resumeInput(f));
  expect(result.kind).toBe('base');
  expect(result.value).toEqual({
    reviewId: f.reviewId,
    baseRevisionId: original.revisionId,
    baseVersion: 1,
  });
  expect((await pending(f)).pending.value!.original).toEqual(admitted.original);
  await rm(f.gitRoot, { recursive: true });
  vi.clearAllMocks();
  const { gitRoot: _gitRoot, ...request } = resumeInput(f);
  expect(await resumeDatabaseReviewPublication(request)).toEqual({ ...result, replayed: true });
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([open]) => open.mode === 'reader')
  ).toBe(true);
}, 15000);
it('refuses missing original admission without inventing pending input', async () => {
  const f = await fixture();
  const before = await pending(f);
  vi.clearAllMocks();
  await expect(resumeDatabaseReviewPublication(resumeInput(f))).rejects.toMatchObject({
    code: 'HISTORY_MISSING',
  });
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([open]) => open.mode === 'reader')
  ).toBe(true);
  expect((await pending(f)).rows).toEqual(before.rows);
});
it('refuses missing admitted floor evidence and a different review target without writes', async () => {
  const f = await fixture();
  await pauseFloor(f);
  const before = await pending(f);
  const member = before.pending.value!.original.floor!.members[0]!;
  await unlink(
    path.join(path.dirname(store.projectDatabasePath(f.authority)), member.relativePath)
  );
  vi.clearAllMocks();
  await expect(resumeDatabaseReviewPublication(resumeInput(f))).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  await expect(
    resumeDatabaseReviewPublication({ ...resumeInput(f), reviewId: uuidv7() })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([open]) => open.mode === 'reader')
  ).toBe(true);
  expect((await pending(f)).rows).toEqual(before.rows);
});
it('retains the original cancellation signal across its first asynchronous read', async () => {
  const f = await fixture();
  await pauseFloor(f);
  const before = await pending(f);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const work = resumeDatabaseReviewPublication(resumeInput(f), options);
  options.signal = new AbortController().signal;
  controller.abort();
  await expect(work).rejects.toMatchObject({ code: 'CANCELLED' });
  expect((await pending(f)).rows).toEqual(before.rows);
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
});
it('refuses secret contextual input before any connection', async () => {
  const f = await fixture();
  vi.clearAllMocks();
  await expect(
    resumeDatabaseReviewPublication({ ...resumeInput(f), gitRoot: 'sk-proj-' + 'x'.repeat(60) })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
});
it('does not retarget the original floor after a newer base selection', async () => {
  const f = await fixture();
  await pauseFloor(f);
  await changeDatabaseReviewBase({
    ...resumeInput(f),
    operationId: uuidv7(),
    revisionId: uuidv7(),
    expectedVersion: 0,
    baseBytes: bytes({ kind: 'auto', recordedAt: f.generatedAt, source: null }),
  });
  const before = await pending(f);
  vi.clearAllMocks();
  await expect(resumeDatabaseReviewPublication(resumeInput(f))).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect((await pending(f)).rows).toEqual(before.rows);
  expect(retention.publishDatabaseGitRef).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
}, 15000);
it('refuses a damaged terminal result instead of inventing a successful receipt', async () => {
  const f = await fixture();
  await publishDatabaseReviewFloor(f.request);
  const require = createRequire(import.meta.url);
  await exec(
    process.execPath,
    [
      '-e',
      `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2]);
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='operations'").all();
    db.exec('BEGIN IMMEDIATE');
    for (const trigger of triggers) db.exec('DROP TRIGGER "' + trigger.name.replaceAll('"', '""') + '"');
    db.prepare('UPDATE operations SET result_json = ? WHERE operation_id = ?').run('{"damaged":true}', process.argv[3]);
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec('COMMIT');
    db.close();
  `,
      createRequire(require.resolve('@orcaops/storage/history/database')).resolve('better-sqlite3'),
      store.projectDatabasePath(f.authority),
      f.request.operationId,
    ],
    { env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } }
  );
  vi.clearAllMocks();
  await expect(resumeDatabaseReviewPublication(resumeInput(f))).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect(
    vi.mocked(store.openProjectDatabase).mock.calls.every(([open]) => open.mode === 'reader')
  ).toBe(true);
}, 15000);
