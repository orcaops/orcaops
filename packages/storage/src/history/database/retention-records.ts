import { z } from 'zod';

import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type GitRetentionPreparation,
  type GitRetentionPublicationInput,
  type GitRetentionTarget,
  restoreGitRetentionPreparation,
} from './retention-input.js';
import type { ProjectSettlement } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';

export interface GitRetentionTransition {
  transitionId: string;
  predecessorTransitionId: string | null;
  ordinal: number;
  kind: 'prepared' | 'selected' | 'retired';
  commandOperationId: string;
  retirementReason: string | null;
}
export interface GitRetentionRecords {
  input: GitRetentionPreparation;
  transitions: GitRetentionTransition[];
  current: GitRetentionTransition;
}
interface OperationRow {
  operationId: string;
  admissionOperationId: string;
  repositoryInstanceId: string;
  targetKind: 'capture' | 'review';
  objectFormat: 'sha1' | 'sha256';
  createdAt: string;
  fingerprint: string;
}
interface CaptureRow {
  artifactId: string;
  generation: number | null;
  orderedHash: string | null;
  eventCount: number | null;
  byteLength: number | null;
  tailEventId: string | null;
  expectedExecutionVersion: number | null;
  expectedBindingGeneration: number | null;
  expectedBaselinePublicationId: string | null;
}
export function retentionIntegrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Retained Git operation input or state is inconsistent; preserve history for explicit repair',
    { cause }
  );
}
export function retentionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isUuidV7(value))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select an exact original Git operation or transition UUID'
    );
}
export function readRetentionRecords(
  view: ProjectReadView,
  operationId: string
): GitRetentionRecords | null {
  const row = view.get<OperationRow>(
    'SELECT original_operation_id AS operationId, admission_operation_id AS admissionOperationId, repository_instance_id AS repositoryInstanceId, target_kind AS targetKind, object_format AS objectFormat, created_at AS createdAt, fingerprint FROM git_retention_operations WHERE original_operation_id = ?',
    operationId
  );
  if (!row) {
    if (
      view.get(
        'SELECT original_operation_id FROM git_retention_current WHERE original_operation_id = ? UNION ALL SELECT original_operation_id FROM git_retention_publications WHERE original_operation_id = ? LIMIT 1',
        operationId,
        operationId
      )
    )
      retentionIntegrity();
    return null;
  }
  let target: GitRetentionTarget;
  if (row.targetKind === 'capture') {
    const capture = view.get<CaptureRow>(
      'SELECT artifact_id AS artifactId, expected_generation AS generation, expected_ordered_hash AS orderedHash, expected_event_count AS eventCount, expected_byte_length AS byteLength, expected_tail_event_id AS tailEventId, expected_execution_version AS expectedExecutionVersion, expected_binding_generation AS expectedBindingGeneration, expected_baseline_publication_id AS expectedBaselinePublicationId FROM git_retention_capture_targets WHERE original_operation_id = ?',
      operationId
    );
    if (
      !capture ||
      (capture.generation === null &&
        [
          capture.orderedHash,
          capture.eventCount,
          capture.byteLength,
          capture.tailEventId,
          capture.expectedExecutionVersion,
          capture.expectedBindingGeneration,
        ].some((value) => value !== null))
    )
      retentionIntegrity();
    target = {
      kind: 'capture',
      artifactId: capture.artifactId,
      expectedRevision:
        capture.generation === null
          ? null
          : {
              generation: capture.generation,
              orderedHash: capture.orderedHash!,
              eventCount: capture.eventCount!,
              byteLength: capture.byteLength!,
              tailEventId: capture.tailEventId!,
            },
      expectedExecutionVersion: capture.expectedExecutionVersion,
      expectedBindingGeneration: capture.expectedBindingGeneration,
      expectedBaselinePublicationId: capture.expectedBaselinePublicationId,
    };
  } else if (row.targetKind === 'review') {
    const review = view.get<Omit<Extract<GitRetentionTarget, { kind: 'review' }>, 'kind'>>(
      'SELECT review_id AS reviewId, membership_revision_id AS membershipRevisionId, base_revision_id AS baseRevisionId, floor_publication_id AS floorPublicationId, run_id AS runId, run_revision_id AS runRevisionId, membership_version AS membershipVersion, base_version AS baseVersion, floor_version AS floorVersion, run_selection_version AS runSelectionVersion FROM git_retention_review_targets WHERE original_operation_id = ?',
      operationId
    );
    if (!review) retentionIntegrity();
    target = { kind: 'review', ...review };
  } else retentionIntegrity();
  const publications = view.all<GitRetentionPublicationInput & { fullRef: string }>(
    'SELECT publication_id AS publicationId, role, target_id AS targetId, checkpoint_number AS checkpointNumber, checkpoint_phase AS checkpointPhase, full_ref AS fullRef, object_oid AS objectOid, tree_oid AS treeOid FROM git_retention_publications WHERE original_operation_id = ? ORDER BY publication_id',
    operationId
  );
  const transitions = view.all<GitRetentionTransition>(
    'SELECT transition_id AS transitionId, predecessor_transition_id AS predecessorTransitionId, ordinal, kind, command_operation_id AS commandOperationId, retirement_reason AS retirementReason FROM git_retention_transitions WHERE original_operation_id = ? ORDER BY ordinal',
    operationId
  );
  const selected = view.get<{ transitionId: string }>(
    'SELECT transition_id AS transitionId FROM git_retention_current WHERE original_operation_id = ?',
    operationId
  );
  if (!selected || !transitions.length || transitions.length > 3) retentionIntegrity();
  for (const [index, transition] of transitions.entries()) {
    const previous = transitions[index - 1];
    if (
      !isUuidV7(transition.transitionId) ||
      transition.ordinal !== index ||
      transition.predecessorTransitionId !== (previous?.transitionId ?? null) ||
      (index === 0
        ? transition.kind !== 'prepared' ||
          transition.commandOperationId !== row.admissionOperationId
        : !previous ||
          previous.kind === 'retired' ||
          !['selected', 'retired'].includes(transition.kind) ||
          (index === 2 && transition.kind !== 'retired')) ||
      (transition.kind === 'selected' && transition.commandOperationId !== operationId) ||
      (transition.kind === 'retired' &&
        (transition.commandOperationId === operationId || !transition.retirementReason)) ||
      (transition.kind !== 'retired' && transition.retirementReason !== null) ||
      !view.get(
        'SELECT operation_id FROM operations WHERE operation_id = ?',
        transition.commandOperationId
      )
    )
      retentionIntegrity();
  }
  const current = transitions.at(-1)!;
  if (selected.transitionId !== current.transitionId) retentionIntegrity();
  const input = restoreGitRetentionPreparation({
    operationId: row.operationId,
    admissionOperationId: row.admissionOperationId,
    preparedTransitionId: transitions[0]!.transitionId,
    repositoryInstanceId: row.repositoryInstanceId,
    objectFormat: row.objectFormat,
    createdAt: row.createdAt,
    target,
    publications: publications.map(({ fullRef: _fullRef, ...publication }) => publication),
  });
  if (
    input.fingerprint !== row.fingerprint ||
    canonicalJson(input.publications) !== canonicalJson(publications)
  )
    retentionIntegrity();
  return { input, transitions, current };
}
export function readProjectGitRetention(handle: ProjectDatabase, originalOperationId: string) {
  retentionId(originalOperationId);
  return handle.read((view) => readRetentionRecords(view, originalOperationId));
}
export function insertRetentionRecords(
  tx: ProjectSettlement,
  input: GitRetentionPreparation
): void {
  const target = input.target;
  tx.run(
    'INSERT INTO git_retention_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    input.operationId,
    input.admissionOperationId,
    input.repositoryInstanceId,
    target.kind,
    target.kind === 'capture' ? input.operationId : null,
    target.kind === 'review' ? input.operationId : null,
    input.objectFormat,
    input.createdAt,
    input.fingerprint
  );
  if (target.kind === 'capture') {
    const revision = target.expectedRevision;
    tx.run(
      "INSERT INTO git_retention_capture_targets VALUES (?, 'capture', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.operationId,
      target.artifactId,
      revision?.generation ?? null,
      revision?.orderedHash ?? null,
      revision?.eventCount ?? null,
      revision?.byteLength ?? null,
      revision?.tailEventId ?? null,
      target.expectedExecutionVersion,
      target.expectedBindingGeneration,
      target.expectedBaselinePublicationId
    );
  } else {
    tx.run(
      "INSERT INTO git_retention_review_targets VALUES (?, 'review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.operationId,
      target.reviewId,
      target.membershipRevisionId,
      target.baseRevisionId,
      target.floorPublicationId,
      target.runId,
      target.runRevisionId,
      target.membershipVersion,
      target.baseVersion,
      target.floorVersion,
      target.runSelectionVersion
    );
  }
  for (const publication of input.publications)
    tx.run(
      'INSERT INTO git_retention_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      publication.publicationId,
      input.operationId,
      input.repositoryInstanceId,
      publication.role,
      publication.targetId,
      publication.checkpointNumber,
      publication.checkpointPhase,
      publication.fullRef,
      publication.objectOid,
      publication.treeOid
    );
  tx.run(
    "INSERT INTO git_retention_transitions VALUES (?, ?, NULL, 0, 'prepared', ?, NULL)",
    input.preparedTransitionId,
    input.operationId,
    input.admissionOperationId
  );
  tx.run(
    'INSERT INTO git_retention_current VALUES (?, ?)',
    input.operationId,
    input.preparedTransitionId
  );
}
export function advanceRetentionRecords(
  tx: ProjectSettlement,
  current: GitRetentionRecords,
  transition: Pick<
    GitRetentionTransition,
    'transitionId' | 'kind' | 'commandOperationId' | 'retirementReason'
  >
): void {
  tx.run(
    'INSERT INTO git_retention_transitions VALUES (?, ?, ?, ?, ?, ?, ?)',
    transition.transitionId,
    current.input.operationId,
    current.current.transitionId,
    current.current.ordinal + 1,
    transition.kind,
    transition.commandOperationId,
    transition.retirementReason
  );
  tx.run(
    'UPDATE git_retention_current SET transition_id = ? WHERE original_operation_id = ?',
    transition.transitionId,
    current.input.operationId
  );
}

const scopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('capture'), artifactId: z.string().refine(isUuidV7) }),
  z.strictObject({ kind: z.literal('review'), reviewId: z.string().refine(isUuidV7) }),
]);
export type ProjectGitRetentionScope = z.input<typeof scopeSchema>;
export function listProjectGitRetentions(
  handle: ProjectDatabase,
  scope: ProjectGitRetentionScope,
  limit = 50
) {
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select one exact artifact or review and a retention limit from one to one hundred'
    );
  const target = parsed.data;
  return handle.read((view) => {
    const ids =
      target.kind === 'capture'
        ? view.all<{ id: string }>(
            'SELECT original_operation_id AS id FROM git_retention_capture_targets WHERE artifact_id = ? ORDER BY original_operation_id DESC LIMIT ?',
            target.artifactId,
            limit
          )
        : view.all<{ id: string }>(
            'SELECT original_operation_id AS id FROM git_retention_review_targets WHERE review_id = ? ORDER BY original_operation_id DESC LIMIT ?',
            target.reviewId,
            limit
          );
    return ids.map((row) => readRetentionRecords(view, row.id) ?? retentionIntegrity());
  });
}
