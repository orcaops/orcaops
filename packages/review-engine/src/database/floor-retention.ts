import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  publishDatabaseGitRef,
  requireDatabaseExecutionContext,
  revalidateDatabaseExecutionContext,
} from '@orcaops/core/history/database-retention';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import {
  gitRetentionPreparation,
  type GitRetentionPublicationInput,
  prepareProjectGitRetention,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectEvidenceFile,
  type ProjectOperationOptions,
  publishProjectEvidence,
  readProjectEvidence,
  runProjectOperation,
} from '@orcaops/storage/history/database';
import {
  insertReviewRetentionAdmission,
  type PendingReviewRetention,
  prepareReviewRetention,
  readProjectPendingReview,
  requireReviewRetentionSettlement,
  selectReviewRetentionRows,
} from '@orcaops/storage/history/database/review-retention';

import { prepareFloorWithDatabase, requirePreparedFloor } from './floor-preparation.js';
import { validateFloorReferences } from './floor-references.js';
import { type FloorPublicationPreparation, insertFloorPublicationRows } from './floors.js';
import { cancelled, integrity, json, stale, withReviewDatabase } from './request.js';
import { prepareReviewGitObject } from './review-git-object.js';
import { settleReviewBase } from './reviews.js';

type FloorResult = {
  reviewId: string;
  publicationId: string;
  floorVersion: number;
  floorInputHash: string;
};
function hasReceipt(database: ProjectDatabase, operationId: string) {
  return (
    database.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id = ?', operationId)
    ).value !== null
  );
}
function replay(
  database: ProjectDatabase,
  prepared: FloorPublicationPreparation,
  options: ProjectOperationOptions
) {
  return runProjectOperation<FloorResult>(
    database,
    prepared.operation,
    () => {
      integrity('The original floor receipt vanished; preserve history for explicit repair');
    },
    options
  );
}
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'This floor request differs from its retained original admission; retry the original authored input without retargeting'
  );
}
function compareOriginal(pending: PendingReviewRetention, prepared: FloorPublicationPreparation) {
  const { input, floor, diff, base, retainedBasis } = prepared;
  const original = pending.original;
  const target = pending.retention.input.target;
  if (
    original.kind !== 'floor' ||
    !original.floor ||
    original.floor.publicationId !== input.publicationId ||
    target.kind !== 'review' ||
    target.reviewId !== input.reviewId ||
    target.membershipRevisionId !== input.expected.membershipRevisionId ||
    target.membershipVersion !== input.expected.membershipVersion ||
    target.baseRevisionId !== input.expected.baseRevisionId ||
    target.baseVersion !== input.expected.baseVersion ||
    target.floorVersion !== input.expected.floorVersion ||
    canonicalJson(original.floor.basis) !== canonicalJson(retainedBasis) ||
    (original.base === null) !== (base === null) ||
    original.base?.revisionId !== base?.revisionId ||
    original.base?.bytesHex !== base?.record.bytes.toString('hex') ||
    original.base?.sha256 !== base?.record.sha256
  )
    conflict();
  for (const member of original.floor.members) {
    const bytes = member.name === 'floor.json' ? floor.bytes : diff;
    if (
      member.byteLength !== bytes.length ||
      member.sha256 !== createHash('sha256').update(bytes).digest('hex')
    )
      conflict();
  }
  if (pending.retention.current.kind !== 'prepared')
    stale(
      'This original floor operation is no longer pending; preserve its publications and start an explicitly new operation'
    );
}
async function readAdmittedEvidence(
  database: ProjectDatabase,
  pending: PendingReviewRetention,
  prepared: FloorPublicationPreparation,
  signal?: AbortSignal
) {
  compareOriginal(pending, prepared);
  const descriptors: ProjectEvidenceFile[] = [];
  for (const member of pending.original.floor!.members) {
    if (
      member.name === 'floor.json' &&
      member.schemaVersion !== prepared.floor.value.schema_version
    )
      integrity(
        'Original floor member schema differs from its retained bytes; preserve history for explicit repair'
      );
    cancelled(signal);
    const bytes = await readProjectEvidence(database, member);
    if (!bytes.equals(member.name === 'floor.json' ? prepared.floor.bytes : prepared.diff))
      integrity(
        'Original floor evidence differs from its admitted input; preserve files for explicit repair'
      );
    descriptors.push({
      relativePath: member.relativePath,
      sha256: member.sha256,
      byteLength: member.byteLength,
    });
  }
  return descriptors;
}
export async function retainDatabaseReviewFloor(
  prepared: FloorPublicationPreparation,
  options: ProjectOperationOptions
) {
  const { input, floor, diff, base, operation } = prepared;
  cancelled(options.signal);
  const observed = await withReviewDatabase(input.authority, 'reader', async (database) => {
    if (hasReceipt(database, input.operationId)) return { receipt: true as const };
    const pending = readProjectPendingReview(database, input.operationId).value;
    if (pending?.terminal) return { receipt: true as const };
    if (pending) await readAdmittedEvidence(database, pending, prepared, options.signal);
    return { receipt: false as const, pending };
  });
  if (observed.receipt)
    return withReviewDatabase(
      input.authority,
      'writer',
      (database) => replay(database, prepared, options),
      () => true
    );
  const context = await requireDatabaseExecutionContext(
    {
      cwd: input.basis.gitRoot,
      root: input.authority.resolvedRoot,
      projectId: input.authority.projectId,
    },
    { signal: options.signal }
  );
  if (!isDeepStrictEqual(context.authority, input.authority))
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Use the original registered project for this floor publication'
    );
  const source = await withReviewDatabase(input.authority, 'reader', async (database) => {
    if (hasReceipt(database, input.operationId)) return null;
    validateFloorReferences(
      database,
      input.reviewId,
      input.expected.membershipRevisionId,
      floor.value
    );
    const source = await prepareFloorWithDatabase(
      database,
      {
        authority: input.authority,
        reviewId: input.reviewId,
        expected: input.expected,
        basis: input.basis,
        // Reassemble under the same scope disclosures so the re-verified floor
        // matches the admitted bytes rather than dropping their caveats.
        ...(input.disclosures ? { disclosures: input.disclosures } : {}),
        generatedAt: floor.value.generated_at,
        secretAllow: input.secretAllow,
        ...(base
          ? { base: { revisionId: base.revisionId, bytes: Buffer.from(base.record.bytes) } }
          : {}),
      },
      { signal: options.signal }
    );
    requirePreparedFloor({ floorBytes: floor.bytes, diffBytes: diff }, source);
    if (
      observed.pending &&
      canonicalJson(source.retentionTarget) !==
        canonicalJson(observed.pending.retention.input.target)
    )
      stale(
        'The original floor retention target changed; prepare an explicitly new operation without retargeting'
      );
    return source;
  });
  if (source === null)
    return withReviewDatabase(
      input.authority,
      'writer',
      (database) => replay(database, prepared, options),
      () => true
    );
  const targetObject = await prepareReviewGitObject(
    context,
    {
      reviewId: input.reviewId,
      oid: input.basis.pinnedTreeSha,
      recordedAt: floor.value.generated_at,
      role: 'floor',
      authoredPayloads: [json(floor.value)],
      secretAllow: input.secretAllow,
    },
    options.signal
  );
  const baseObject = await prepareReviewGitObject(
    context,
    {
      reviewId: input.reviewId,
      oid: input.basis.baseSha,
      recordedAt: floor.value.generated_at,
      role: 'base',
      authoredPayloads: [json(floor.value)],
      secretAllow: input.secretAllow,
    },
    options.signal
  );
  const policyObject =
    base?.record.value.kind === 'explicit'
      ? await prepareReviewGitObject(
          context,
          {
            reviewId: input.reviewId,
            oid: base.record.value.oid,
            recordedAt: base.record.value.recordedAt,
            role: 'base',
            authoredPayloads: [json(base.record.value)],
            secretAllow: input.secretAllow,
          },
          options.signal
        )
      : null;
  const expectedObjects = [
    { role: 'review-floor' as const, targetId: input.publicationId, ...targetObject },
    { role: 'review-floor-base' as const, targetId: input.publicationId, ...baseObject },
    ...(policyObject
      ? [{ role: 'review-base' as const, targetId: base!.revisionId, ...policyObject }]
      : []),
  ];
  if (expectedObjects.some((object) => object.objectFormat !== targetObject.objectFormat))
    integrity(
      'Original floor objects disagree about repository format; preserve history for explicit repair'
    );
  await revalidateDatabaseExecutionContext(context, { signal: options.signal });
  return withReviewDatabase(
    input.authority,
    'writer',
    async (database) => {
      if (hasReceipt(database, input.operationId)) return replay(database, prepared, options);
      let pending = readProjectPendingReview(database, input.operationId).value;
      let descriptors: ProjectEvidenceFile[];
      if (!pending) {
        descriptors = await publishProjectEvidence(
          database,
          {
            publicationId: input.publicationId,
            members: [
              { name: 'floor.json', bytes: floor.bytes },
              { name: 'diff.patch', bytes: diff },
            ],
            secretAllow: input.secretAllow,
          },
          { signal: options.signal }
        );
        const publications: GitRetentionPublicationInput[] = expectedObjects.map((object) => ({
          publicationId: uuidv7(),
          role: object.role,
          targetId: object.targetId,
          checkpointNumber: null,
          checkpointPhase: null,
          objectOid: object.objectOid,
          treeOid: object.treeOid,
        }));
        const git = prepareProjectGitRetention({
          operationId: input.operationId,
          admissionOperationId: uuidv7(),
          preparedTransitionId: uuidv7(),
          repositoryInstanceId: context.authority.repositoryInstanceId,
          objectFormat: targetObject.objectFormat,
          createdAt: new Date().toISOString(),
          target: source.retentionTarget,
          publications,
          secretAllow: input.secretAllow,
        });
        const retention = gitRetentionPreparation(git);
        const pendingInput = prepareReviewRetention({
          retention: git,
          secretAllow: input.secretAllow,
          request: {
            kind: 'floor',
            selectedTransitionId: uuidv7(),
            base: base
              ? { revisionId: base.revisionId, bytes: Buffer.from(base.record.bytes) }
              : null,
            floor: {
              publicationId: input.publicationId,
              observedWriteSequence: source.counters.writeSequence,
              basis: prepared.retainedBasis,
              members: descriptors.map((descriptor) => {
                const isFloor = descriptor.relativePath.endsWith('/floor.json');
                return {
                  name: isFloor ? ('floor.json' as const) : ('diff.patch' as const),
                  kind: isFloor ? ('floor' as const) : ('diff' as const),
                  schemaVersion: isFloor ? floor.value.schema_version : null,
                  ...descriptor,
                };
              }),
            },
          },
        });
        try {
          await runProjectOperation(
            database,
            {
              operationId: retention.admissionOperationId,
              kind: 'review.floor.admit',
              target: { reviewId: input.reviewId, originalOperationId: input.operationId },
              payload: {
                publicationId: input.publicationId,
                floorHash: floor.sha256,
                diffHash: createHash('sha256').update(diff).digest('hex'),
                ...(base
                  ? { base: { revisionId: base.revisionId, sha256: base.record.sha256 } }
                  : {}),
              },
              expectedState: json(source.retentionTarget),
              intentChange: false,
            },
            (tx) => {
              insertReviewRetentionAdmission(tx, pendingInput);
              return { originalOperationId: input.operationId };
            },
            options
          );
        } catch (cause) {
          if (!(cause instanceof ProjectDatabaseError) || cause.code !== 'IDEMPOTENCY_CONFLICT')
            throw cause;
          if (hasReceipt(database, input.operationId)) return replay(database, prepared, options);
          if (!readProjectPendingReview(database, input.operationId).value) throw cause;
        }
        pending = readProjectPendingReview(database, input.operationId).value;
      }
      if (hasReceipt(database, input.operationId)) return replay(database, prepared, options);
      if (!pending)
        integrity(
          'The admitted original floor input is missing; preserve its publications for explicit repair'
        );
      descriptors = await readAdmittedEvidence(database, pending, prepared, options.signal);
      const retained = pending.retention.input;
      if (
        retained.repositoryInstanceId !== context.authority.repositoryInstanceId ||
        retained.objectFormat !== targetObject.objectFormat ||
        retained.publications.length !== expectedObjects.length ||
        expectedObjects.some(
          (object) =>
            !retained.publications.some(
              (publication) =>
                publication.role === object.role &&
                publication.targetId === object.targetId &&
                publication.objectOid === object.objectOid &&
                publication.treeOid === object.treeOid
            )
        )
      )
        integrity(
          'Admitted floor publications differ from the original evidence objects; preserve history for explicit repair'
        );
      for (const publication of retained.publications)
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
          const current = insertFloorPublicationRows(tx, prepared, descriptors);
          if (base)
            settleReviewBase(
              tx,
              {
                authority: input.authority,
                reviewId: input.reviewId,
                operationId: input.operationId,
                secretAllow: input.secretAllow,
                revisionId: base.revisionId,
                baseBytes: Buffer.from(base.record.bytes),
                expectedVersion: input.expected.baseVersion,
              },
              base.record,
              { prepared: admitted.prepared, expectedTransitionId: retained.preparedTransitionId }
            );
          else selectReviewRetentionRows(tx, admitted.prepared, retained.preparedTransitionId);
          tx.run(
            'UPDATE review_selections SET floor_publication_id = ?, floor_version = floor_version + 1 WHERE review_id = ?',
            input.publicationId,
            input.reviewId
          );
          return {
            reviewId: input.reviewId,
            publicationId: input.publicationId,
            floorVersion: current.floor_version + 1,
            floorInputHash: floor.value.input_hash,
          };
        },
        options
      );
    },
    () => true
  );
}
