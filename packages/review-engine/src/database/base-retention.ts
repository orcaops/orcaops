import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';

import {
  publishDatabaseGitRef,
  requireDatabaseExecutionContext,
  revalidateDatabaseExecutionContext,
} from '@orcaops/core/history/database-retention';
import { uuidv7 } from '@orcaops/storage';
import {
  gitRetentionPreparation,
  type GitRetentionTarget,
  prepareProjectGitRetention,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperation,
  type ProjectOperationOptions,
  runProjectOperation,
} from '@orcaops/storage/history/database';
import {
  insertReviewRetentionAdmission,
  type PendingReviewRetention,
  prepareReviewRetention,
  readProjectPendingReview,
  requireReviewRetentionSettlement,
} from '@orcaops/storage/history/database/review-retention';

import type { PreparedReviewJson } from './records.js';
import { cancelled, integrity, invalid, json, stale, withReviewDatabase } from './request.js';
import { prepareReviewGitObject } from './review-git-object.js';
import { type baseSchema, type ChangeDatabaseReviewBase, settleReviewBase } from './reviews.js';

type Base = PreparedReviewJson<z.infer<typeof baseSchema>>;
type ReviewTarget = Extract<GitRetentionTarget, { kind: 'review' }>;
type BaseResult = { reviewId: string; baseRevisionId: string; baseVersion: number };

function target(database: ProjectDatabase, input: ChangeDatabaseReviewBase): ReviewTarget {
  return database.read((view) => {
    const row = view.get<Omit<ReviewTarget, 'kind' | 'reviewId'>>(
      'SELECT s.membership_revision_id AS membershipRevisionId, s.base_revision_id AS baseRevisionId, s.floor_publication_id AS floorPublicationId, s.current_run_id AS runId, r.current_revision_id AS runRevisionId, s.membership_version AS membershipVersion, s.base_version AS baseVersion, s.floor_version AS floorVersion, s.run_selection_version AS runSelectionVersion FROM review_selections s LEFT JOIN review_runs r ON r.review_id = s.review_id AND r.run_id = s.current_run_id WHERE s.review_id = ?',
      input.reviewId
    );
    if (!row || row.baseVersion !== input.expectedVersion)
      stale(
        'The selected review base changed; prepare an explicitly new operation without retargeting'
      );
    if ((row.runId === null) !== (row.runRevisionId === null))
      integrity(
        'The selected review run revision is missing; preserve history for explicit repair'
      );
    return { kind: 'review' as const, reviewId: input.reviewId, ...row };
  }).value;
}
function hasReceipt(database: ProjectDatabase, operationId: string): boolean {
  return (
    database.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id = ?', operationId)
    ).value !== null
  );
}
function compareOriginal(
  pending: PendingReviewRetention,
  input: ChangeDatabaseReviewBase,
  base: Base
) {
  const original = pending.original;
  const target = pending.retention.input.target;
  if (
    original.kind !== 'base' ||
    original.base?.revisionId !== input.revisionId ||
    original.base.bytesHex !== base.bytes.toString('hex') ||
    original.base.sha256 !== base.sha256 ||
    target.kind !== 'review' ||
    target.reviewId !== input.reviewId ||
    target.baseVersion !== input.expectedVersion
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'This base operation differs from its retained original input; retry the original authored request without retargeting'
    );
  if (pending.retention.current.kind !== 'prepared')
    stale(
      'This base operation is no longer pending; preserve its publications and start an explicitly new operation'
    );
}
function replay(
  database: ProjectDatabase,
  operation: ProjectOperation,
  options: ProjectOperationOptions
) {
  return runProjectOperation<BaseResult>(
    database,
    operation,
    () => {
      integrity(
        'The original base receipt vanished; preserve retained history for explicit repair'
      );
    },
    options
  );
}

export async function retainDatabaseReviewBase(
  input: ChangeDatabaseReviewBase,
  base: Base,
  operation: ProjectOperation,
  options: ProjectOperationOptions
) {
  cancelled(options.signal);
  const original = await withReviewDatabase(input.authority, 'reader', (database) => {
    if (hasReceipt(database, input.operationId)) return { receipt: true as const };
    const pending = readProjectPendingReview(database, input.operationId).value;
    if (pending?.terminal) return { receipt: true as const };
    if (pending) compareOriginal(pending, input, base);
    try {
      return { receipt: false as const, pending, target: pending ? null : target(database, input) };
    } catch (cause) {
      if (
        cause instanceof ProjectDatabaseError &&
        cause.code === 'STALE_CONTEXT' &&
        hasReceipt(database, input.operationId)
      )
        return { receipt: true as const };
      throw cause;
    }
  });
  if (original.receipt)
    return withReviewDatabase(
      input.authority,
      'writer',
      (database) => replay(database, operation, options),
      () => true
    );
  if (!input.gitRoot)
    invalid(
      'Provide the original registered checkout to publish or resume an explicit review base'
    );
  const context = await requireDatabaseExecutionContext(
    {
      cwd: input.gitRoot,
      root: input.authority.resolvedRoot,
      projectId: input.authority.projectId,
    },
    { signal: options.signal }
  );
  if (!isDeepStrictEqual(context.authority, input.authority))
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Use the original registered project for this review base'
    );
  if (base.value.kind !== 'explicit') invalid('Only an explicit base has a Git retention target');
  const object = await prepareReviewGitObject(
    context,
    {
      reviewId: input.reviewId,
      oid: base.value.oid,
      recordedAt: base.value.recordedAt,
      role: 'base',
      authoredPayloads: [json(base.value)],
      secretAllow: input.secretAllow,
    },
    options.signal
  );
  let pending = original.pending;
  let prepared = pending?.prepared;
  let retention = pending?.retention.input;
  if (!pending) {
    const git = prepareProjectGitRetention({
      operationId: input.operationId,
      admissionOperationId: uuidv7(),
      preparedTransitionId: uuidv7(),
      repositoryInstanceId: context.authority.repositoryInstanceId,
      objectFormat: object.objectFormat,
      createdAt: new Date().toISOString(),
      target: original.target!,
      publications: [
        {
          publicationId: uuidv7(),
          role: 'review-base',
          targetId: input.revisionId,
          checkpointNumber: null,
          checkpointPhase: null,
          objectOid: object.objectOid,
          treeOid: object.treeOid,
        },
      ],
      secretAllow: input.secretAllow,
    });
    retention = gitRetentionPreparation(git);
    prepared = prepareReviewRetention({
      retention: git,
      request: {
        kind: 'base',
        selectedTransitionId: uuidv7(),
        base: { revisionId: input.revisionId, bytes: Buffer.from(base.bytes) },
      },
      secretAllow: input.secretAllow,
    });
  }
  const originalPreparation = prepared!;
  const admission = retention!;
  await revalidateDatabaseExecutionContext(context, { signal: options.signal });
  return withReviewDatabase(
    input.authority,
    'writer',
    async (database) => {
      if (hasReceipt(database, input.operationId)) return replay(database, operation, options);
      pending = readProjectPendingReview(database, input.operationId).value;
      if (!pending) {
        try {
          await runProjectOperation(
            database,
            {
              operationId: admission.admissionOperationId,
              kind: 'review.base.admit',
              target: { reviewId: input.reviewId, originalOperationId: input.operationId },
              payload: { revisionId: input.revisionId, baseHash: base.sha256 },
              expectedState: json(admission.target),
              intentChange: false,
            },
            (tx) => {
              insertReviewRetentionAdmission(tx, originalPreparation);
              return { originalOperationId: input.operationId };
            },
            options
          );
        } catch (cause) {
          if (!(cause instanceof ProjectDatabaseError) || cause.code !== 'IDEMPOTENCY_CONFLICT')
            throw cause;
          if (hasReceipt(database, input.operationId)) return replay(database, operation, options);
          if (!readProjectPendingReview(database, input.operationId).value) throw cause;
        }
        pending = readProjectPendingReview(database, input.operationId).value;
      }
      if (hasReceipt(database, input.operationId)) return replay(database, operation, options);
      if (!pending)
        integrity(
          'The admitted original review base is missing; preserve history for explicit repair'
        );
      compareOriginal(pending, input, base);
      const retained = pending.retention.input;
      const publication = retained.publications[0];
      if (
        retained.repositoryInstanceId !== context.authority.repositoryInstanceId ||
        retained.objectFormat !== object.objectFormat ||
        retained.publications.length !== 1 ||
        publication?.role !== 'review-base' ||
        publication.targetId !== input.revisionId ||
        publication.objectOid !== object.objectOid ||
        publication.treeOid !== object.treeOid
      )
        integrity(
          'The retained base publication differs from its original Git object; preserve history for explicit repair'
        );
      await publishDatabaseGitRef(
        context,
        {
          fullRef: publication.fullRef,
          objectOid: publication.objectOid,
          treeOid: publication.treeOid,
          objectFormat: retained.objectFormat,
        },
        { signal: options.signal }
      );
      await revalidateDatabaseExecutionContext(context, { signal: options.signal });
      const admitted = pending;
      return runProjectOperation(
        database,
        operation,
        (tx) => {
          requireReviewRetentionSettlement(tx, admitted.prepared, retained.preparedTransitionId);
          return settleReviewBase(tx, input, base, {
            prepared: admitted.prepared,
            expectedTransitionId: retained.preparedTransitionId,
          });
        },
        options
      );
    },
    () => true
  );
}
