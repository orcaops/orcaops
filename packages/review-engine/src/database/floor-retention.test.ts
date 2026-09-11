import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
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
import {
  hydrateDatabaseReviewFloor,
  publishDatabaseReviewFloor,
  readDatabaseReviewFloor,
  snapshotDatabaseReviewFloor,
} from './floors.js';
import { createDatabaseReview } from './reviews.js';

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
  const root = await mkdtemp(path.join(tmpdir(), 'retained-review-floor-'));
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
async function inspect(f: Awaited<ReturnType<typeof fixture>>) {
  const database = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  try {
    return {
      pending: readProjectPendingReview(database, f.request.operationId).value,
      rows: database.read((view) => ({
        current: view.get(
          'SELECT base_revision_id, base_version, floor_publication_id, floor_version FROM review_selections'
        ),
        bases: view.all(
          'SELECT revision_id, lower(hex(record_bytes)) AS bytes FROM review_base_revisions'
        ),
        floors: view.all('SELECT publication_id FROM review_evidence_publications'),
        bindings: view.all<{ role: string; target_id: string }>(
          'SELECT role, target_id FROM review_retention_bindings'
        ),
        receipts: view.all('SELECT operation_id FROM operations'),
      })),
    };
  } finally {
    database.close();
  }
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('selects original floor and base refs with evidence without inventing a policy revision', async () => {
  const f = await fixture();
  const result = await publishDatabaseReviewFloor(f.request);
  const observed = await inspect(f);
  expect(result.value).toEqual({
    reviewId: f.reviewId,
    publicationId: f.request.publicationId,
    floorVersion: 1,
    floorInputHash: JSON.parse(f.request.floorBytes.toString()).input_hash,
  });
  expect(observed.rows.value.bases).toEqual([]);
  expect(observed.rows.value.bindings.map((row) => row.role).sort()).toEqual([
    'review-floor',
    'review-floor-base',
  ]);
  expect(observed.pending?.original.floor?.observedWriteSequence).toBe(
    f.sourceCounters.writeSequence
  );
  expect(observed.pending?.retention.current.kind).toBe('selected');
  expect(observed.rows.counters.writeSequence).toBe(f.sourceCounters.writeSequence + 2);
  const publications = observed.pending!.retention.input.publications;
  const floor = publications.find((value) => value.role === 'review-floor')!;
  const base = publications.find((value) => value.role === 'review-floor-base')!;
  expect(base.objectOid).toBe(f.baseOid);
  expect(base.treeOid).toBe(f.baseTree);
  expect(floor.treeOid).toBe(f.treeOid);
  expect(await git(f.gitRoot, ['cat-file', '-p', floor.objectOid])).toContain(
    `review-pin: ${f.reviewId} ${f.generatedAt}`
  );
  for (const publication of publications)
    expect(await git(f.gitRoot, ['rev-parse', publication.fullRef])).toBe(publication.objectOid);
  expect(
    (await readDatabaseReviewFloor({ authority: f.authority, reviewId: f.reviewId })).value
      ?.floorBytes
  ).toEqual(f.request.floorBytes);
});
it.each(['auto', 'explicit'] as const)(
  'selects the authored %s policy and floor in one terminal transaction',
  async (policy) => {
    const f = await fixture(policy);
    const before = await inspect(f);
    const original = Buffer.from(f.request.base!.bytes);
    const revisionId = f.request.base!.revisionId;
    const work = publishDatabaseReviewFloor(f.request);
    f.request.base!.bytes.fill(0);
    await work;
    const observed = await inspect(f);
    expect(observed.rows.value.bases).toEqual([
      { revision_id: revisionId, bytes: original.toString('hex') },
    ]);
    expect(observed.rows.value.current).toEqual({
      base_revision_id: revisionId,
      base_version: 1,
      floor_publication_id: f.request.publicationId,
      floor_version: 1,
    });
    expect(observed.rows.value.bindings).toHaveLength(policy === 'explicit' ? 3 : 2);
    expect(observed.rows.value.receipts).toHaveLength(before.rows.value.receipts.length + 2);
    expect(observed.pending?.original.base?.bytesHex).toBe(original.toString('hex'));
    expect(observed.pending?.original.floor?.observedWriteSequence).toBe(
      f.sourceCounters.writeSequence
    );
  },
  15000
);
it('replays committed floor selection without evidence files or a checkout', async () => {
  const f = await fixture();
  const first = await publishDatabaseReviewFloor(f.request);
  const before = await inspect(f);
  await rm(f.gitRoot, { recursive: true });
  await rm(path.join(path.dirname(store.projectDatabasePath(f.authority)), 'evidence'), {
    recursive: true,
  });
  vi.clearAllMocks();
  const replay = await publishDatabaseReviewFloor(f.request);
  expect(replay.value).toEqual(first.value);
  expect(replay.counters).toEqual(first.counters);
  expect((await inspect(f)).rows).toEqual(before.rows);
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  await expect(
    publishDatabaseReviewFloor({ ...f.request, publicationId: uuidv7() })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('resumes the original admitted floor and preserves its source-time evidence stamp', async () => {
  const f = await fixture('explicit');
  vi.mocked(retention.publishDatabaseGitRef).mockRejectedValueOnce(
    new store.ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Pause admitted floor')
  );
  await expect(publishDatabaseReviewFloor(f.request)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  const before = await inspect(f);
  expect(before.pending?.terminal).toBeNull();
  expect(before.rows.value.floors).toEqual([]);
  expect(before.rows.value.bases).toEqual([]);
  await publishDatabaseReviewFloor(f.request);
  const after = await inspect(f);
  expect(after.pending?.retention.input).toEqual(before.pending?.retention.input);
  expect(after.pending?.original).toEqual(before.pending?.original);
  expect(after.rows.value.bindings).toHaveLength(3);
  expect(after.rows.value.bases).toHaveLength(1);
  expect(after.rows.value.floors).toHaveLength(1);
}, 15000);
it('refuses a missing admitted evidence file without regenerating or selecting it', async () => {
  const f = await fixture();
  vi.mocked(retention.publishDatabaseGitRef).mockRejectedValueOnce(
    new store.ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Pause admitted floor')
  );
  await expect(publishDatabaseReviewFloor(f.request)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  const before = await inspect(f);
  const member = before.pending!.original.floor!.members[0]!;
  await unlink(
    path.join(path.dirname(store.projectDatabasePath(f.authority)), member.relativePath)
  );
  vi.clearAllMocks();
  await expect(publishDatabaseReviewFloor(f.request)).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  expect(store.publishProjectEvidence).not.toHaveBeenCalled();
  expect(retention.publishDatabaseGitRef).not.toHaveBeenCalled();
  expect((await inspect(f)).rows).toEqual(before.rows);
});
it('leaves the older floor refs unused when a newer floor wins before settlement', async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof retention>(
    '@orcaops/core/history/database-retention'
  );
  const winner = { ...f.request, operationId: uuidv7(), publicationId: uuidv7() };
  vi.mocked(retention.publishDatabaseGitRef).mockImplementationOnce(async (...args) => {
    const result = await actual.publishDatabaseGitRef(...args);
    await publishDatabaseReviewFloor(winner);
    return result;
  });
  await expect(publishDatabaseReviewFloor(f.request)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const observed = await inspect(f);
  expect(observed.pending?.terminal).toBeNull();
  expect(observed.rows.value.current).toMatchObject({
    floor_publication_id: winner.publicationId,
    floor_version: 1,
  });
  expect(observed.rows.value.bindings.every((row) => row.target_id === winner.publicationId)).toBe(
    true
  );
  for (const publication of observed.pending!.retention.input.publications)
    expect(await git(f.gitRoot, ['rev-parse', publication.fullRef])).toBe(publication.objectOid);
});
it('rolls back policy floor bindings and counters after a late real SQLite failure', async () => {
  const f = await fixture('explicit');
  const baseline = await inspect(f);
  const actual = await vi.importActual<typeof store>('@orcaops/storage/history/database');
  const core = await vi.importActual<typeof retention>('@orcaops/core/history/database-retention');
  let published = 0;
  vi.mocked(retention.publishDatabaseGitRef).mockImplementation(async (...args) => {
    const result = await core.publishDatabaseGitRef(...args);
    if (++published === 3)
      vi.mocked(store.runProjectOperation).mockImplementationOnce(
        (database, operation, settle, options) =>
          actual.runProjectOperation(
            database,
            operation,
            (tx, original) => {
              settle(tx, original);
              tx.run('INSERT INTO review_selections SELECT * FROM review_selections');
              throw new Error('Expected SQLite uniqueness failure');
            },
            options
          )
      );
    return result;
  });
  await expect(publishDatabaseReviewFloor(f.request)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'constraint',
  });
  const before = await inspect(f);
  expect(before.pending?.terminal).toBeNull();
  expect(before.pending?.retention.current.kind).toBe('prepared');
  expect(before.rows.value.bases).toEqual([]);
  expect(before.rows.value.floors).toEqual([]);
  expect(before.rows.value.bindings).toEqual([]);
  expect(before.rows.value.current).toEqual({
    base_revision_id: null,
    base_version: 0,
    floor_publication_id: null,
    floor_version: 0,
  });
  expect(before.rows.counters).toEqual({
    writeSequence: baseline.rows.counters.writeSequence + 1,
    intentChangeCounter: baseline.rows.counters.intentChangeCounter,
  });
  expect(before.rows.value.receipts).toHaveLength(baseline.rows.value.receipts.length + 1);
  await publishDatabaseReviewFloor(f.request);
  expect((await inspect(f)).pending?.retention.current.kind).toBe('selected');
}, 15000);
it('settles simultaneous original floor callers once', async () => {
  const f = await fixture();
  const before = await inspect(f);
  const results = await Promise.all([
    publishDatabaseReviewFloor(f.request),
    publishDatabaseReviewFloor(f.request),
  ]);
  expect(results[0]!.value).toEqual(results[1]!.value);
  const observed = await inspect(f);
  expect(observed.rows.value.floors).toHaveLength(1);
  expect(observed.rows.value.bindings).toHaveLength(2);
  expect(observed.rows.value.receipts).toHaveLength(before.rows.value.receipts.length + 2);
});
it('refuses proposed policy secrets before any connection or Git preparation', async () => {
  const f = await fixture();
  vi.clearAllMocks();
  await expect(
    publishDatabaseReviewFloor({
      ...f.request,
      base: {
        revisionId: uuidv7(),
        bytes: bytes({
          kind: 'explicit',
          ref: 'sk-proj-' + 'x'.repeat(60),
          oid: f.baseOid,
          recordedAt: f.generatedAt,
          source: null,
        }),
      },
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
  expect(retention.requireDatabaseExecutionContext).not.toHaveBeenCalled();
});

it('retains the original floor snapshot after a newer publication becomes current', async () => {
  const f = await fixture();
  await publishDatabaseReviewFloor(f.request);
  const database = await store.openProjectDatabase({ authority: f.authority, mode: 'reader' });
  const input = { authority: f.authority, reviewId: f.reviewId };
  try {
    const snapshot = database.read((view) => snapshotDatabaseReviewFloor(view, input));
    const next = {
      ...f.request,
      operationId: uuidv7(),
      publicationId: uuidv7(),
      expected: { ...f.request.expected, floorVersion: 1 },
    };
    await publishDatabaseReviewFloor(next);
    const original = await hydrateDatabaseReviewFloor(database, input, snapshot);
    expect(original.value?.publicationId).toBe(f.request.publicationId);
    expect(original.value?.floorBytes).toEqual(f.request.floorBytes);
    expect(original.value?.sourceWriteSequence).toBe(f.sourceCounters.writeSequence);
    expect(original.counters).toEqual(snapshot.counters);
    const current = await readDatabaseReviewFloor(input);
    expect(current.value?.publicationId).toBe(next.publicationId);
    expect(current.counters.writeSequence).toBeGreaterThan(snapshot.counters.writeSequence);
  } finally {
    database.close();
  }
});
