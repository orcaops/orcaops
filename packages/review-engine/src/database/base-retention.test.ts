import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import * as retention from '@orcaops/core/history/database-retention';
import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';
import { readProjectPendingReview } from '@orcaops/storage/history/database/review-retention';

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
    openProjectDatabase: vi.fn(actual.openProjectDatabase),
    runProjectOperation: vi.fn(actual.runProjectOperation),
  };
});
const exec = promisify(execFile);
const roots: string[] = [];
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
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
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'retained-review-base-'));
  roots.push(root);
  const gitRoot = path.join(root, 'repo');
  await mkdir(gitRoot);
  await git(gitRoot, ['init', '--quiet']);
  await writeFile(path.join(gitRoot, 'value.txt'), 'one\n');
  await git(gitRoot, ['add', 'value.txt']);
  await git(gitRoot, ['commit', '--quiet', '-m', 'Original ancestor']);
  const parentOid = await git(gitRoot, ['rev-parse', 'HEAD']);
  await writeFile(path.join(gitRoot, 'value.txt'), 'two\n');
  await git(gitRoot, ['add', 'value.txt']);
  await git(gitRoot, ['commit', '--quiet', '-m', 'Exact base']);
  const oid = await git(gitRoot, ['rev-parse', 'HEAD']);
  const treeOid = await git(gitRoot, ['rev-parse', 'HEAD^{tree}']);
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
    membershipBytes: bytes({ revisionId: uuidv7(), members: [], source: null }),
  });
  const policy = {
    kind: 'explicit' as const,
    ref: 'original-ref',
    oid,
    recordedAt: '2026-01-01T00:00:00.000Z',
    source: null,
  };
  const request = {
    authority,
    gitRoot,
    reviewId,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    expectedVersion: 0,
    baseBytes: bytes(policy),
    secretAllow: [],
  };
  return { root, gitRoot, authority, oid, parentOid, treeOid, request, policy };
}
async function inspect(f: Awaited<ReturnType<typeof fixture>>) {
  const db = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  try {
    return {
      pending: readProjectPendingReview(db, f.request.operationId).value,
      rows: db.read((view) => ({
        bases: view.all(
          'SELECT revision_id, lower(hex(record_bytes)) AS bytes FROM review_base_revisions'
        ),
        bindings: view.all('SELECT * FROM review_retention_bindings'),
        receipts: view.all('SELECT operation_id FROM operations'),
        current: view.get('SELECT base_revision_id, base_version FROM review_selections'),
      })),
    };
  } finally {
    db.close();
  }
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('retains an exact commit and its ancestry with one atomic base selection', async () => {
  const f = await fixture();
  const result = await changeDatabaseReviewBase(f.request);
  const observed = await inspect(f);
  expect(result.value).toEqual({
    reviewId: f.request.reviewId,
    baseRevisionId: f.request.revisionId,
    baseVersion: 1,
  });
  expect(observed.pending?.terminal?.operationId).toBe(f.request.operationId);
  expect(observed.pending?.retention.current.kind).toBe('selected');
  expect(observed.rows.value.bases).toEqual([
    { revision_id: f.request.revisionId, bytes: f.request.baseBytes.toString('hex') },
  ]);
  expect(observed.rows.value.bindings).toHaveLength(1);
  const publication = observed.pending!.retention.input.publications[0]!;
  expect(publication.objectOid).toBe(f.oid);
  expect(publication.treeOid).toBe(f.treeOid);
  expect(await git(f.gitRoot, ['rev-parse', publication.fullRef])).toBe(f.oid);
  expect(await git(f.gitRoot, ['rev-list', publication.fullRef])).toBe(`${f.oid}\n${f.parentOid}`);
});
it('wraps an exact tree with the retained review identity and recorded time', async () => {
  const f = await fixture();
  f.request.baseBytes = bytes({ ...f.policy, oid: f.treeOid });
  await changeDatabaseReviewBase(f.request);
  const publication = (await inspect(f)).pending!.retention.input.publications[0]!;
  const commit = await git(f.gitRoot, ['cat-file', '-p', publication.objectOid]);
  expect(commit).toContain(`tree ${f.treeOid}\n`);
  expect(commit).not.toContain('\nparent ');
  expect(commit).toContain(`review-pin: ${f.request.reviewId}-base ${f.policy.recordedAt}`);
  expect(publication.objectOid).not.toBe(f.treeOid);
});
it('replays the committed receipt without a checkout or another publication', async () => {
  const f = await fixture();
  const first = await changeDatabaseReviewBase(f.request);
  const before = await inspect(f);
  await rm(f.gitRoot, { recursive: true });
  vi.clearAllMocks();
  const { gitRoot: _gitRoot, ...request } = f.request;
  const replay = await changeDatabaseReviewBase(request);
  expect(replay.value).toEqual(first.value);
  expect(replay.counters).toEqual(first.counters);
  expect((await inspect(f)).rows).toEqual(before.rows);
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
  expect(retention.publishDatabaseGitRef).not.toHaveBeenCalled();
  await expect(
    changeDatabaseReviewBase({ ...request, revisionId: uuidv7() })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('resumes original admission and refuses an auto retarget after interrupted publication', async () => {
  const f = await fixture();
  vi.mocked(retention.publishDatabaseGitRef).mockRejectedValueOnce(
    new store.ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Injected unavailable publication')
  );
  await expect(changeDatabaseReviewBase(f.request)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  const before = await inspect(f);
  expect(before.pending?.retention.current.kind).toBe('prepared');
  expect(before.pending?.terminal).toBeNull();
  expect(before.rows.value.bases).toEqual([]);
  await expect(
    changeDatabaseReviewBase({
      ...f.request,
      baseBytes: bytes({ kind: 'auto', recordedAt: f.policy.recordedAt, source: null }),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await inspect(f)).rows).toEqual(before.rows);
  await changeDatabaseReviewBase(f.request);
  const after = await inspect(f);
  expect(after.pending?.retention.input).toEqual(before.pending?.retention.input);
  expect(after.pending?.original.selectedTransitionId).toBe(
    before.pending?.original.selectedTransitionId
  );
  expect(after.rows.value.bases).toHaveLength(1);
  expect(after.rows.value.bindings).toHaveLength(1);
});
it('leaves an unused ref when a later base wins before settlement', async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof retention>(
    '@orcaops/core/history/database-retention'
  );
  const otherRevision = uuidv7();
  vi.mocked(retention.publishDatabaseGitRef).mockImplementationOnce(async (...args) => {
    const result = await actual.publishDatabaseGitRef(...args);
    await changeDatabaseReviewBase({
      ...f.request,
      operationId: uuidv7(),
      revisionId: otherRevision,
      baseBytes: bytes({ kind: 'auto', recordedAt: f.policy.recordedAt, source: null }),
    });
    return result;
  });
  await expect(changeDatabaseReviewBase(f.request)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const observed = await inspect(f);
  expect(observed.pending?.terminal).toBeNull();
  expect(observed.rows.value.bindings).toEqual([]);
  expect(observed.rows.value.current).toEqual({ base_revision_id: otherRevision, base_version: 1 });
  expect(
    await git(f.gitRoot, ['rev-parse', observed.pending!.retention.input.publications[0]!.fullRef])
  ).toBe(f.oid);
});
it('settles simultaneous callers under the same original operation once', async () => {
  const f = await fixture();
  const before = await inspect(f);
  const results = await Promise.all([
    changeDatabaseReviewBase(f.request),
    changeDatabaseReviewBase(f.request),
  ]);
  expect(results[0]!.value).toEqual(results[1]!.value);
  const observed = await inspect(f);
  expect(observed.rows.value.bases).toHaveLength(1);
  expect(observed.rows.value.bindings).toHaveLength(1);
  expect(observed.rows.value.receipts).toHaveLength(before.rows.value.receipts.length + 2);
});
it('refuses secrets before opening storage or preparing Git', async () => {
  const f = await fixture();
  vi.clearAllMocks();
  await expect(
    changeDatabaseReviewBase({
      ...f.request,
      baseBytes: bytes({ ...f.policy, ref: 'sk-proj-' + 'x'.repeat(60) }),
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
});
it('retains original cancellation before the first asynchronous read', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const work = changeDatabaseReviewBase(f.request, options);
  options.signal = new AbortController().signal;
  controller.abort();
  await expect(work).rejects.toMatchObject({ code: 'CANCELLED' });
  expect((await inspect(f)).pending).toBeNull();
});

it('rolls back a late SQL failure and retries the original admitted publication once', async () => {
  const f = await fixture();
  const baseline = await inspect(f);
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  const publish = await vi.importActual<typeof retention>(
    '@orcaops/core/history/database-retention'
  );
  vi.mocked(retention.publishDatabaseGitRef).mockImplementationOnce(async (...args) => {
    const result = await publish.publishDatabaseGitRef(...args);
    vi.mocked(store.runProjectOperation).mockImplementationOnce(
      (database, operation, settle, options) =>
        actual.runProjectOperation(
          database,
          operation,
          (tx, prepared) => {
            settle(tx, prepared);
            tx.run('INSERT INTO review_selections SELECT * FROM review_selections');
            throw new Error('The duplicate selection must fail in SQLite');
          },
          options
        )
    );
    return result;
  });
  await expect(changeDatabaseReviewBase(f.request)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'constraint',
  });
  const before = await inspect(f);
  expect(before.pending?.terminal).toBeNull();
  expect(before.pending?.retention.current.kind).toBe('prepared');
  expect(before.rows.value.bases).toEqual([]);
  expect(before.rows.value.bindings).toEqual([]);
  expect(before.rows.value.current).toEqual({ base_revision_id: null, base_version: 0 });
  expect(before.rows.counters).toEqual({
    writeSequence: baseline.rows.counters.writeSequence + 1,
    intentChangeCounter: baseline.rows.counters.intentChangeCounter,
  });
  expect(before.rows.value.receipts).toHaveLength(baseline.rows.value.receipts.length + 1);
  const publication = before.pending!.retention.input.publications[0]!;
  expect(await git(f.gitRoot, ['rev-parse', publication.fullRef])).toBe(f.oid);
  await changeDatabaseReviewBase(f.request);
  const after = await inspect(f);
  expect(after.pending?.retention.input).toEqual(before.pending?.retention.input);
  expect(after.rows.value.bases).toHaveLength(1);
  expect(after.rows.value.bindings).toHaveLength(1);
});
it('rejects a blob as an explicit base without admitting or publishing it', async () => {
  const f = await fixture();
  const blob = await git(f.gitRoot, ['rev-parse', 'HEAD:value.txt']);
  await expect(
    changeDatabaseReviewBase({ ...f.request, baseBytes: bytes({ ...f.policy, oid: blob }) })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect((await inspect(f)).pending).toBeNull();
  expect(
    await git(f.gitRoot, ['for-each-ref', '--format=%(refname)', 'refs/orcaops/review/'])
  ).toBe('');
});

it('refuses auto settlement when the original identity is admitted after its read', async () => {
  const f = await fixture();
  const before = await inspect(f);
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  let admitAtWriterOpen = true;
  vi.mocked(store.openProjectDatabase).mockImplementation(async (input) => {
    if (input.mode === 'writer' && admitAtWriterOpen) {
      admitAtWriterOpen = false;
      vi.mocked(retention.publishDatabaseGitRef).mockRejectedValueOnce(
        new store.ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Pause after genuine admission')
      );
      await expect(changeDatabaseReviewBase(f.request)).rejects.toMatchObject({
        code: 'HISTORY_INACCESSIBLE',
      });
    }
    return actual.openProjectDatabase(input);
  });
  await expect(
    changeDatabaseReviewBase({
      ...f.request,
      baseBytes: bytes({ kind: 'auto', recordedAt: f.policy.recordedAt, source: null }),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const observed = await inspect(f);
  expect(observed.pending?.retention.current.kind).toBe('prepared');
  expect(observed.pending?.terminal).toBeNull();
  expect(observed.rows.value.bases).toEqual([]);
  expect(observed.rows.value.bindings).toEqual([]);
  expect(observed.rows.value.current).toEqual({ base_revision_id: null, base_version: 0 });
  expect(observed.rows.counters).toEqual({
    writeSequence: before.rows.counters.writeSequence + 1,
    intentChangeCounter: before.rows.counters.intentChangeCounter,
  });
  expect(observed.rows.value.receipts).toHaveLength(before.rows.value.receipts.length + 1);
  await changeDatabaseReviewBase(f.request);
  expect((await inspect(f)).pending?.retention.current.kind).toBe('selected');
});
