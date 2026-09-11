import { ProjectDatabaseError } from './errors.js';
import { requirePendingReviewRows } from './pending-review.js';
import { advanceRetentionRecords, readRetentionRecords, retentionId } from './retention-records.js';
import { assertRetentionTarget, staleRetention } from './retention-targets.js';
import {
  type PreparedReviewRetention,
  type ReviewRetentionPreparation,
  reviewRetentionPreparation,
} from './review-retention-input.js';
import type { ProjectSettlement } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';

export {
  insertReviewRetentionAdmission,
  readProjectPendingReview,
  type PendingReviewRetention,
} from './pending-review.js';
export {
  prepareReviewRetention,
  type PrepareReviewRetention,
  type PreparedReviewRetention,
} from './review-retention-input.js';

function admitted(
  tx: ProjectSettlement,
  input: ReviewRetentionPreparation,
  expectedTransitionId: string
) {
  retentionId(expectedTransitionId);
  const retained = readRetentionRecords(tx, input.retention.operationId);
  if (!retained)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The original review admission is missing; preserve any publications and restore its history before settlement'
    );
  if (retained.input.fingerprint !== input.retention.fingerprint)
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'Review retention differs from the original admitted operation; replay its original authored input without retargeting'
    );
  requirePendingReviewRows(tx, input);
  if (
    retained.current.kind !== 'prepared' ||
    retained.current.transitionId !== expectedTransitionId
  )
    staleRetention();
  if (
    tx.get(
      'SELECT operation_id FROM operations WHERE operation_id = ?',
      input.retention.operationId
    )
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The original review operation already has a receipt; replay it before fresh publication or settlement'
    );
  assertRetentionTarget(tx, input.retention);
  return retained;
}
export function requireReviewRetentionSettlement(
  tx: ProjectSettlement,
  prepared: PreparedReviewRetention,
  expectedTransitionId: string
): void {
  admitted(tx, reviewRetentionPreparation(prepared), expectedTransitionId);
}
function requireDomainRows(tx: ProjectSettlement, input: ReviewRetentionPreparation): void {
  const target = input.retention.target;
  if (target.kind !== 'review')
    throw new ProjectDatabaseError('INVALID_INPUT', 'Retain the original review owner');
  if (input.base) {
    const base = tx.get<{
      previous: string | null;
      operationId: string;
      bytesHex: string;
      sha256: string;
    }>(
      'SELECT previous_revision_id AS previous, operation_id AS operationId, lower(hex(record_bytes)) AS bytesHex, record_hash AS sha256 FROM review_base_revisions WHERE review_id = ? AND revision_id = ?',
      target.reviewId,
      input.base.revisionId
    );
    if (
      !base ||
      base.previous !== target.baseRevisionId ||
      base.operationId !== input.retention.operationId ||
      base.bytesHex !== input.base.bytesHex ||
      base.sha256 !== input.base.sha256
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Insert the exact original base revision bytes, predecessor and publishing operation in this review settlement'
      );
  }
  if (input.floor) {
    const publication = tx.get<{ operationId: string; membershipRevisionId: string }>(
      'SELECT operation_id AS operationId, membership_revision_id AS membershipRevisionId FROM review_evidence_publications WHERE publication_id = ? AND review_id = ? AND kind = ?',
      input.floor.publicationId,
      target.reviewId,
      'floor'
    );
    const members = tx.all(
      'SELECT name, kind, schema_version AS schemaVersion, relative_path AS relativePath, sha256, byte_length AS byteLength FROM review_evidence_members WHERE publication_id = ? ORDER BY name',
      input.floor.publicationId
    );
    if (
      !publication ||
      publication.operationId !== input.retention.operationId ||
      publication.membershipRevisionId !== target.membershipRevisionId ||
      canonicalJson(members) !== canonicalJson(input.floor.members)
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Insert the exact original floor publication, member descriptors and publishing operation in this review settlement'
      );
  }
}
export function selectReviewRetentionRows(
  tx: ProjectSettlement,
  prepared: PreparedReviewRetention,
  expectedTransitionId: string
): void {
  const input = reviewRetentionPreparation(prepared);
  const retained = admitted(tx, input, expectedTransitionId);
  requireDomainRows(tx, input);
  advanceRetentionRecords(tx, retained, {
    transitionId: input.selectedTransitionId,
    kind: 'selected',
    commandOperationId: input.retention.operationId,
    retirementReason: null,
  });
  const target = input.retention.target;
  if (target.kind !== 'review')
    throw new ProjectDatabaseError('INVALID_INPUT', 'Retain the original review owner');
  for (const publication of input.retention.publications)
    tx.run(
      'INSERT INTO review_retention_bindings VALUES (?, ?, ?, ?, ?, ?, ?)',
      publication.publicationId,
      input.retention.operationId,
      target.reviewId,
      publication.role,
      publication.targetId,
      publication.role === 'review-base' ? null : publication.targetId,
      publication.role === 'review-base' ? publication.targetId : null
    );
}
