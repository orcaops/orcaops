import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  advanceProjectReviewFeedbackWatchCursor,
  readProjectReviewFeedbackWatchCursor,
} from './review-feedback-cursor.js';

const handles: ProjectDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'review-feedback-cursor-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-09T00:00:00.000Z',
    authorize() {},
  });
  handles.push(handle);
  const second = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(second);
  return { handle, second };
}

const target = {
  server_url: 'https://cloud.example.test/',
  org_id: 'organization',
  account_id: 'account-a',
};

function input(cursor: string, changes: Record<string, unknown> = {}) {
  return {
    operationId: uuidv7(),
    target,
    pullRequestId: 'pull-request-one',
    cursor,
    advancedAt: '2026-09-09T00:10:00.000Z',
    ...changes,
  };
}

it('advances an account-qualified cursor without changing the intent counter', async () => {
  const { handle } = await fixture();
  const before = handle.read(() => null).counters;
  const first = input('2026-09-09T00:01:00.000Z');

  await advanceProjectReviewFeedbackWatchCursor(handle, first);
  const selected = readProjectReviewFeedbackWatchCursor(handle, {
    target,
    pullRequestId: first.pullRequestId,
  });

  expect(selected.value).toMatchObject({
    target: { ...target, server_url: 'https://cloud.example.test' },
    pullRequestId: first.pullRequestId,
    cursor: first.cursor,
    version: 1,
    operationId: first.operationId,
  });
  expect(selected.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  expect(
    readProjectReviewFeedbackWatchCursor(handle, {
      target: { ...target, account_id: 'account-b' },
      pullRequestId: first.pullRequestId,
    }).value
  ).toBeNull();
});

it('records equal and older observations without regressing the retained maximum', async () => {
  const { handle } = await fixture();
  const latest = input('2026-09-09T00:05:00.000Z');
  await advanceProjectReviewFeedbackWatchCursor(handle, latest);
  const before = handle.read(() => null).counters;

  const equalInput = input('2026-09-09T00:05:00.000Z');
  const equal = await advanceProjectReviewFeedbackWatchCursor(handle, equalInput);
  const olderInput = input('2026-09-09T00:04:00.000Z');
  const older = await advanceProjectReviewFeedbackWatchCursor(handle, olderInput);

  expect(equal.value?.operationId).toBe(latest.operationId);
  expect(older.value?.operationId).toBe(latest.operationId);
  expect(older.value?.version).toBe(1);
  expect(handle.read(() => null).counters).toEqual({
    writeSequence: before.writeSequence + 2,
    intentChangeCounter: before.intentChangeCounter,
  });
  await expect(
    advanceProjectReviewFeedbackWatchCursor(handle, {
      ...olderInput,
      cursor: '2026-09-09T00:06:00.000Z',
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

it('refuses changed input under an existing cursor operation identity', async () => {
  const { handle } = await fixture();
  const original = input('2026-09-09T00:05:00.000Z');
  await advanceProjectReviewFeedbackWatchCursor(handle, original);

  await expect(
    advanceProjectReviewFeedbackWatchCursor(handle, {
      ...original,
      cursor: '2026-09-09T00:06:00.000Z',
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(
    readProjectReviewFeedbackWatchCursor(handle, {
      target,
      pullRequestId: original.pullRequestId,
    }).value?.cursor
  ).toBe(original.cursor);
});

it('converges two out-of-order watchers on the later activity', async () => {
  const { handle, second } = await fixture();
  const later = input('2026-09-09T00:08:00.000Z');
  const earlier = input('2026-09-09T00:07:00.000Z');

  await Promise.all([
    advanceProjectReviewFeedbackWatchCursor(handle, later),
    advanceProjectReviewFeedbackWatchCursor(second, earlier),
  ]);

  const selected = readProjectReviewFeedbackWatchCursor(handle, {
    target,
    pullRequestId: later.pullRequestId,
  });
  expect(selected.value).toMatchObject({
    cursor: later.cursor,
    operationId: later.operationId,
  });
  expect([1, 2]).toContain(selected.value?.version);
});

it('rejects an invalid activity timestamp before opening an operation', async () => {
  const { handle } = await fixture();
  const before = handle.read(() => null).counters;
  await expect(
    advanceProjectReviewFeedbackWatchCursor(handle, input('not-a-timestamp'))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(handle.read(() => null).counters).toEqual(before);
});
