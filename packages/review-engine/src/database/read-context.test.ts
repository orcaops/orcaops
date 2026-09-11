import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import * as scopes from '@orcaops/project-scope/history/database';
import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import * as store from '@orcaops/storage/history/database';

import { readDatabaseReviewContext } from './read-context.js';
import { createDatabaseReview } from './reviews.js';

vi.mock('@orcaops/project-scope/history/database', async (original) => ({
  ...(await original<typeof scopes>()),
}));
const Database = createRequire(new URL('../../../storage/package.json', import.meta.url))(
  'better-sqlite3'
) as new (file: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
};
const roots: string[] = [];
const handles: store.ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'review-context-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(store.projectDatabasePath(authority)), { recursive: true });
  const db = await store.initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(db);
  const request = {
    dataRoot: root.resolvedRoot,
    cwd: root.resolvedRoot,
    projectId: authority.projectId,
  };
  return { authority, db, request };
}
async function review(f: Awaited<ReturnType<typeof fixture>>, branch: string | null) {
  const reviewId = uuidv7(),
    operationId = uuidv7(),
    membershipRevisionId = uuidv7();
  const identity = {
    schema_version: 1,
    review_id: reviewId,
    project_id: f.authority.projectId,
    store_instance_id: f.authority.storeInstanceId,
    repository_instance_id: f.authority.repositoryInstanceId,
    created_by_operation: operationId,
    initial_context: { worktree_id: null, branch, base_sha: null, head_sha: null },
    artifact_ids: [],
    legacy_source_ids: [],
  };
  await createDatabaseReview({
    authority: f.authority,
    operationId,
    identityBytes: bytes(identity),
    membershipBytes: bytes({ revisionId: membershipRevisionId, members: [], source: null }),
    secretAllow: [],
  });
  return { reviewId, operationId, membershipRevisionId, identity };
}
function damage(f: Awaited<ReturnType<typeof fixture>>, reviewId: string, receiptOnly: boolean) {
  const raw = new Database(store.projectDatabasePath(f.authority));
  try {
    raw.exec('PRAGMA foreign_keys=OFF');
    const triggers = raw
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('reviews','review_membership_revisions')"
      )
      .all() as { name: string; sql: string }[];
    for (const t of triggers) raw.exec(`DROP TRIGGER "${t.name}"`);
    if (receiptOnly) {
      raw.prepare('DELETE FROM review_selections WHERE review_id=?').run(reviewId);
      raw.prepare('DELETE FROM review_membership_revisions WHERE review_id=?').run(reviewId);
    }
    raw.prepare('DELETE FROM reviews WHERE review_id=?').run(reviewId);
    for (const t of triggers) raw.exec(t.sql);
  } finally {
    raw.close();
  }
}
it('reads exact branchless identity with one consistent empty selected-state snapshot', async () => {
  const f = await fixture(),
    r = await review(f, null);
  const before = f.db.read(() => null).counters;
  const context = await readDatabaseReviewContext({ ...f.request, reviewId: r.reviewId });
  expect(context.identity).toEqual(r.identity);
  expect(context.projectId).toBe(f.authority.projectId);
  expect(context).toMatchObject({
    reviewId: r.reviewId,
    base: null,
    floor: null,
    story: null,
    run: null,
    storyMatchesSelectedFloor: null,
    counters: before,
  });
  expect(context.comments.comments).toEqual([]);
  expect(context.workflow.sequence).toBe(0);
  expect(f.db.read(() => null).counters).toEqual(before);
  await expect(
    readDatabaseReviewContext({ ...f.request, reviewId: r.reviewId, branch: 'other' })
  ).rejects.toMatchObject({ code: 'REVIEW_CONTEXT_MISMATCH' });
});
it('selects a unique branch and returns bounded qualified ambiguity without choosing newest', async () => {
  const f = await fixture(),
    first = await review(f, 'topic');
  expect((await readDatabaseReviewContext({ ...f.request, branch: 'topic' })).reviewId).toBe(
    first.reviewId
  );
  await review(f, 'topic');
  await review(f, 'topic');
  const failure = await readDatabaseReviewContext({ ...f.request, branch: 'topic' }).catch(
    (error) => error
  );
  expect(failure.code).toBe('REVIEW_SELECTION_REQUIRED');
  expect(failure.context.candidates).toHaveLength(2);
  expect(failure.context.truncated).toBe(true);
  for (const candidate of failure.context.candidates)
    expect(candidate.command).toBe(
      `orcaops review state health --project ${f.authority.projectId} --review ${candidate.review_id} --json`
    );
  expect(
    (await readDatabaseReviewContext({ ...f.request, reviewId: first.reviewId })).reviewId
  ).toBe(first.reviewId);
});
it.each([false, true])(
  'refuses branch and exact selection when retained history lost its identity with receipt-only %s',
  async (receiptOnly) => {
    const f = await fixture(),
      r = await review(f, 'topic');
    damage(f, r.reviewId, receiptOnly);
    for (const selector of [{ branch: 'topic' }, { reviewId: r.reviewId }])
      await expect(readDatabaseReviewContext({ ...f.request, ...selector })).rejects.toMatchObject({
        code: 'HISTORY_INTEGRITY_REQUIRED',
      });
  }
);
it('reports genuine absence and a missing database without creating history', async () => {
  const f = await fixture();
  await expect(
    readDatabaseReviewContext({ ...f.request, branch: 'missing' })
  ).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
  const missing = uuidv7();
  await expect(
    readDatabaseReviewContext({ ...f.request, projectId: missing, reviewId: uuidv7() })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(
    readFile(store.projectDatabasePath({ ...f.authority, projectId: missing }))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('copies original selectors and environment before asynchronous scope discovery', async () => {
  const f = await fixture(),
    r = await review(f, 'topic');
  const original = scopes.resolveDatabaseHistoryScope;
  let captured: Parameters<typeof original>[0];
  vi.spyOn(scopes, 'resolveDatabaseHistoryScope').mockImplementation(async (input) => {
    captured = input;
    await Promise.resolve();
    return original(input);
  });
  const input = {
    ...f.request,
    reviewId: r.reviewId,
    env: { ORCAOPS_DATA_DIR: f.authority.resolvedRoot },
  };
  const pending = readDatabaseReviewContext(input);
  input.reviewId = uuidv7();
  input.projectId = uuidv7();
  input.env.ORCAOPS_DATA_DIR = '/changed';
  expect((await pending).reviewId).toBe(r.reviewId);
  expect(captured?.env?.ORCAOPS_DATA_DIR).toBe(f.authority.resolvedRoot);
});
it('preserves selection errors when closing its genuine scope also fails', async () => {
  const f = await fixture();
  const original = scopes.resolveDatabaseHistoryScope;
  const closing = new Error('controlled close failure');
  let closed = false;
  vi.spyOn(scopes, 'resolveDatabaseHistoryScope').mockImplementation(async (input) => {
    const scope = await original(input);
    return {
      ...scope,
      close() {
        scope.close();
        closed = true;
        throw closing;
      },
    };
  });
  const failure = await readDatabaseReviewContext({ ...f.request, reviewId: uuidv7() }).catch(
    (error) => error
  );
  expect(failure.code).toBe('REVIEW_NOT_FOUND');
  expect(failure.context.cause.errors[1]).toBe(closing);
  expect(closed).toBe(true);
  expect(f.db.read(() => true).value).toBe(true);
});
it('rejects missing selectors and nonexact identifiers before scope discovery', async () => {
  const f = await fixture(),
    spy = vi.spyOn(scopes, 'resolveDatabaseHistoryScope');
  for (const selector of [{}, { reviewId: 'prefix' }, { branch: ' ' }])
    await expect(readDatabaseReviewContext({ ...f.request, ...selector })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  expect(spy).not.toHaveBeenCalled();
});
