import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import * as store from '@orcaops/storage/history/database';

import {
  changeDatabaseReviewMembership,
  createDatabaseReview,
  hydrateDatabaseReview,
  readDatabaseReview,
  snapshotDatabaseReview,
} from './reviews.js';

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
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'review-identity-read-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(store.projectDatabasePath(authority)), { recursive: true });
  const database = await store.initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(database);
  const operationId = uuidv7(),
    reviewId = uuidv7();
  const identity = {
    schema_version: 1,
    review_id: reviewId,
    project_id: authority.projectId,
    store_instance_id: authority.storeInstanceId,
    repository_instance_id: authority.repositoryInstanceId,
    created_by_operation: operationId,
    initial_context: { worktree_id: null, branch: null, base_sha: null, head_sha: null },
    artifact_ids: [],
    legacy_source_ids: ['original:source'],
  };
  const membership = { revisionId: uuidv7(), members: [], source: null };
  await createDatabaseReview({
    authority,
    operationId,
    identityBytes: bytes(identity),
    membershipBytes: bytes(membership),
    secretAllow: [],
  });
  return { authority, database, operationId, reviewId, identity, membership };
}
function damage(
  f: Awaited<ReturnType<typeof fixture>>,
  statements: readonly [string, unknown[]][]
) {
  const raw = new Database(store.projectDatabasePath(f.authority));
  try {
    raw.exec('PRAGMA foreign_keys=OFF');
    const triggers = raw
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('reviews','review_membership_revisions','operations')"
      )
      .all() as { name: string; sql: string }[];
    for (const trigger of triggers) raw.exec(`DROP TRIGGER "${trigger.name}"`);
    for (const [sql, params] of statements) raw.prepare(sql).run(...params);
    for (const trigger of triggers) raw.exec(trigger.sql);
  } finally {
    raw.close();
  }
}
it('retains exact bytes and nullable identity while a truly unknown review is absent', async () => {
  const f = await fixture();
  const before = f.database.read(() => null).counters;
  const read = await readDatabaseReview({ authority: f.authority, reviewId: f.reviewId });
  expect(read.value?.identityBytes).toEqual(bytes(f.identity));
  expect(read.value?.membershipBytes).toEqual(bytes(f.membership));
  expect(read.value?.identity.initial_context.branch).toBeNull();
  expect(read.counters).toEqual(before);
  expect(
    (await readDatabaseReview({ authority: f.authority, reviewId: uuidv7() })).value
  ).toBeNull();
});
it('refuses a missing identity header when retained children remain', async () => {
  const f = await fixture();
  damage(f, [['DELETE FROM reviews WHERE review_id=?', [f.reviewId]]]);
  await expect(
    readDatabaseReview({ authority: f.authority, reviewId: f.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(f.database.read(() => true).value).toBe(true);
});
it('refuses receipt-backed identity absence even when all identity children have disappeared', async () => {
  const f = await fixture();
  damage(f, [
    ['DELETE FROM review_selections WHERE review_id=?', [f.reviewId]],
    ['DELETE FROM review_membership_revisions WHERE review_id=?', [f.reviewId]],
    ['DELETE FROM reviews WHERE review_id=?', [f.reviewId]],
  ]);
  await expect(
    readDatabaseReview({ authority: f.authority, reviewId: f.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
});
it('rejects a missing original receipt and mismatched copied identity columns', async () => {
  const f = await fixture();
  damage(f, [['UPDATE reviews SET branch=? WHERE review_id=?', ['foreign', f.reviewId]]]);
  await expect(
    readDatabaseReview({ authority: f.authority, reviewId: f.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  damage(f, [
    ['UPDATE reviews SET branch=NULL WHERE review_id=?', [f.reviewId]],
    ['DELETE FROM operations WHERE operation_id=?', [f.operationId]],
  ]);
  await expect(
    readDatabaseReview({ authority: f.authority, reviewId: f.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
});
it('rejects a selected membership associated with another review', async () => {
  const f = await fixture();
  damage(f, [
    [
      'UPDATE review_membership_revisions SET review_id=? WHERE revision_id=?',
      [uuidv7(), f.membership.revisionId],
    ],
  ]);
  await expect(
    readDatabaseReview({ authority: f.authority, reviewId: f.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
});
it('retains an exact selected snapshot while later membership commits before decoding', async () => {
  const f = await fixture();
  const snapshot = f.database.read((view) => snapshotDatabaseReview(view, f.reviewId));
  const next = { ...f.membership, revisionId: uuidv7() };
  await changeDatabaseReviewMembership({
    authority: f.authority,
    reviewId: f.reviewId,
    operationId: uuidv7(),
    secretAllow: [],
    membershipBytes: bytes(next),
    expected: { revisionId: f.membership.revisionId, version: 1 },
  });
  const old = hydrateDatabaseReview(f.authority, snapshot.value);
  expect(old?.membership).toEqual(f.membership);
  expect(old?.selection.membership_version).toBe(1);
  const current = await readDatabaseReview({ authority: f.authority, reviewId: f.reviewId });
  expect(current.value?.membership).toEqual(next);
  expect(current.value?.selection.membership_version).toBe(2);
  expect(current.counters.writeSequence).toBe(snapshot.counters.writeSequence + 1);
});
it('does not hydrate a different review narrative while checking exact identity', async () => {
  const f = await fixture();
  const otherId = uuidv7();
  const op = uuidv7();
  const identity = { ...f.identity, review_id: otherId, created_by_operation: op };
  await createDatabaseReview({
    authority: f.authority,
    operationId: op,
    identityBytes: bytes(identity),
    membershipBytes: bytes({ ...f.membership, revisionId: uuidv7() }),
    secretAllow: [],
  });
  damage(f, [
    [
      'UPDATE reviews SET identity_bytes=?,identity_hash=? WHERE review_id=?',
      [
        Buffer.from('invalid narrative'),
        createHash('sha256').update('invalid narrative').digest('hex'),
        otherId,
      ],
    ],
  ]);
  expect(
    (await readDatabaseReview({ authority: f.authority, reviewId: f.reviewId })).value?.identity
  ).toEqual(f.identity);
});

it('rejects a creation receipt whose retained payload bytes disagree', async () => {
  const f = await fixture();
  const changed = JSON.stringify({
    identityBytes: bytes({ ...f.identity, legacy_source_ids: ['changed'] }).toString('base64'),
    membershipBytes: bytes(f.membership).toString('base64'),
  });
  damage(f, [
    [
      'UPDATE operations SET payload_json=?,payload_hash=? WHERE operation_id=?',
      [changed, createHash('sha256').update(changed).digest('hex'), f.operationId],
    ],
  ]);
  await expect(
    readDatabaseReview({ authority: f.authority, reviewId: f.reviewId })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
});
