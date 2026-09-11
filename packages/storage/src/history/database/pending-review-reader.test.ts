import Database from 'better-sqlite3';
import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

import { openProjectDatabase } from './connection.js';
import { insertReviewRetentionAdmission, readProjectPendingReview } from './pending-review.js';
import { prepareProjectGitRetention, type PrepareProjectGitRetention } from './retention-input.js';
import { prepareReviewRetention, reviewRetentionPreparation } from './review-retention-input.js';
import { runProjectOperation } from './transactions.js';
import {
  reviewRetentionFixture,
  reviewRetentionFixtureRoots,
  reviewRetentionSnapshot,
} from '../../../tests/review-retention-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    reviewRetentionFixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
it.each(['reader', 'writer'] as const)(
  'releases a genuine %s handle after repeated absent reads',
  async (mode) => {
    const { authority, file } = await reviewRetentionFixture();
    const before = reviewRetentionSnapshot(file);
    const handle = await openProjectDatabase({ authority, mode });
    try {
      for (let index = 0; index < 2; index++)
        expect(readProjectPendingReview(handle, uuidv7())).toEqual({
          value: null,
          counters: { writeSequence: 21, intentChangeCounter: 3 },
        });
      expect(handle.read(() => 'still available').value).toBe('still available');
    } finally {
      handle.close();
    }
    expect(reviewRetentionSnapshot(file)).toEqual(before);
  }
);
it('releases the snapshot before reporting missing original review input', async () => {
  const { authority, file, saved } = await reviewRetentionFixture();
  const before = reviewRetentionSnapshot(file);
  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  try {
    const capture = saved.rows.git_retention_operations[0]!.original_operation_id as string;
    expect(() => readProjectPendingReview(handle, capture)).toThrowError(
      expect.objectContaining({ code: 'HISTORY_MISSING' })
    );
    expect(readProjectPendingReview(handle, uuidv7()).value).toBeNull();
    expect(handle.read(() => 'still available').value).toBe('still available');
  } finally {
    handle.close();
  }
  expect(reviewRetentionSnapshot(file)).toEqual(before);
});
it('rolls back a failed query and releases the handle without replacing its failure', async () => {
  const { authority, file } = await reviewRetentionFixture();
  const before = reviewRetentionSnapshot(file);
  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  const primary = new Database.SqliteError('retained read failure', 'SQLITE_IOERR_READ');
  const prepare = Database.prototype.prepare;
  let failed = false;
  try {
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (this.name === file && sql.includes('FROM git_retention_operations') && !failed) {
        failed = true;
        throw primary;
      }
      return prepare.call(this, sql);
    });
    expect(() => readProjectPendingReview(handle, uuidv7())).toThrow(primary);
    expect(failed).toBe(true);
    expect(readProjectPendingReview(handle, uuidv7()).value).toBeNull();
    expect(handle.read(() => 'still available').value).toBe('still available');
  } finally {
    vi.restoreAllMocks();
    handle.close();
  }
  expect(reviewRetentionSnapshot(file)).toEqual(before);
});
it('refuses a nested read without releasing the original active snapshot', async () => {
  const { authority, file } = await reviewRetentionFixture();
  const before = reviewRetentionSnapshot(file);
  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  try {
    expect(
      handle.read((view) => {
        expect(() => readProjectPendingReview(handle, uuidv7())).toThrowError(
          expect.objectContaining({ code: 'INVALID_INPUT' })
        );
        expect(() => handle.close()).toThrowError(
          expect.objectContaining({ code: 'INVALID_INPUT' })
        );
        return view.get<{ value: number }>('SELECT 1 AS value');
      }).value
    ).toEqual({ value: 1 });
    expect(readProjectPendingReview(handle, uuidv7()).value).toBeNull();
  } finally {
    handle.close();
  }
  expect(reviewRetentionSnapshot(file)).toEqual(before);
});

it('restores exact admitted bytes and selected identity from a genuine reopened database', async () => {
  const { authority, file } = await reviewRetentionFixture();
  const writer = await openProjectDatabase({ authority, mode: 'writer' });
  const operationId = uuidv7(),
    admissionOperationId = uuidv7(),
    preparedTransitionId = uuidv7(),
    selectedTransitionId = uuidv7(),
    baseId = uuidv7();
  const bytes = Buffer.from(
    '{ "kind":"explicit", "ref":"résumé", "oid":"' +
      'a'.repeat(40) +
      '", "recordedAt":"2026-09-01T00:00:00.000Z", "source":null }\n'
  );
  let reviewId: string;
  try {
    const target = writer.read((view) =>
      view.get<Extract<PrepareProjectGitRetention['target'], { kind: 'review' }>>(
        `SELECT 'review' AS kind, s.review_id AS reviewId, membership_revision_id AS membershipRevisionId, base_revision_id AS baseRevisionId, floor_publication_id AS floorPublicationId, current_run_id AS runId, r.current_revision_id AS runRevisionId, membership_version AS membershipVersion, base_version AS baseVersion, floor_version AS floorVersion, run_selection_version AS runSelectionVersion FROM review_selections s LEFT JOIN review_runs r ON r.run_id=s.current_run_id LIMIT 1`
      )
    ).value!;
    reviewId = target.reviewId;
    const retention = prepareProjectGitRetention({
      operationId,
      admissionOperationId,
      preparedTransitionId,
      repositoryInstanceId: authority.repositoryInstanceId,
      objectFormat: 'sha1',
      createdAt: '2026-09-01T00:00:00.000Z',
      target,
      publications: [
        {
          publicationId: uuidv7(),
          role: 'review-base',
          targetId: baseId,
          checkpointNumber: null,
          checkpointPhase: null,
          objectOid: 'a'.repeat(40),
          treeOid: 'b'.repeat(40),
        },
      ],
      secretAllow: [],
    });
    const input = prepareReviewRetention({
      retention,
      request: { kind: 'base', selectedTransitionId, base: { revisionId: baseId, bytes } },
      secretAllow: [],
    });
    await runProjectOperation(
      writer,
      {
        operationId: admissionOperationId,
        kind: 'review.retention.fixture',
        target: { reviewId },
        payload: { originalOperationId: operationId },
        expectedState: null,
        intentChange: false,
      },
      (tx) => {
        insertReviewRetentionAdmission(tx, input);
        return { originalOperationId: operationId };
      }
    );
  } finally {
    writer.close();
  }
  const before = reviewRetentionSnapshot(file);
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  try {
    const restored = readProjectPendingReview(reader, operationId);
    expect(restored.counters).toEqual({ writeSequence: 22, intentChangeCounter: 3 });
    expect(restored.value!.original.selectedTransitionId).toBe(selectedTransitionId);
    expect(restored.value!.original.base!.revisionId).toBe(baseId);
    expect(Buffer.from(restored.value!.original.base!.bytesHex, 'hex')).toEqual(bytes);
    expect(restored.value!.retention.input.target).toMatchObject({ reviewId: reviewId! });
    expect(restored.value!.admission.operationId).toBe(admissionOperationId);
    expect(restored.value!.terminal).toBeNull();
    expect(() => Object.assign(restored.value!.original.base!, { bytesHex: '00' })).toThrow(
      TypeError
    );
    expect(
      Buffer.from(reviewRetentionPreparation(restored.value!.prepared).base!.bytesHex, 'hex')
    ).toEqual(bytes);
    expect(reader.read(() => 'still available').value).toBe('still available');
  } finally {
    reader.close();
  }
  expect(reviewRetentionSnapshot(file)).toEqual(before);
});
