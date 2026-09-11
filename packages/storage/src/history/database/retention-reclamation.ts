import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { readRetentionRecords, retentionId, retentionIntegrity } from './retention-records.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';
import { serializeDatabaseValue } from './values.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';

const id = z.string().refine(isUuidV7);
const targetSchema = z.strictObject({
  publicationId: id,
  originalOperationId: id,
  repositoryInstanceId: id,
  retiredTransitionId: id,
  fullRef: z.string().startsWith('refs/orcaops/'),
  objectOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  objectFormat: z.enum(['sha1', 'sha256']),
});
export type GitReclamationTarget = z.infer<typeof targetSchema>;
const admissionSchema = z.strictObject({
  admissionOperationId: id,
  terminalOperationId: id,
  target: targetSchema,
});
export type GitReclamationAdmission = z.infer<typeof admissionSchema>;
export type GitReclamationPreview =
  | { status: 'eligible'; target: GitReclamationTarget }
  | {
      status: 'protected';
      publicationId: string;
      reason: 'unknown' | 'pending' | 'selected' | 'referenced';
    };
const resultSchema = z.strictObject({
  terminalOperationId: id,
  publicationId: id,
  outcome: z.enum(['removed', 'absent']),
});

function preview(view: ProjectReadView, publicationId: string): GitReclamationPreview {
  const owner = view.get<{ operationId: string }>(
    'SELECT original_operation_id AS operationId FROM git_retention_publications WHERE publication_id = ?',
    publicationId
  );
  if (!owner) return { status: 'protected', publicationId, reason: 'unknown' };
  const retained = readRetentionRecords(view, owner.operationId);
  if (!retained) retentionIntegrity();
  const publication = retained.input.publications.find(
    (entry) => entry.publicationId === publicationId
  );
  if (!publication) retentionIntegrity();
  if (retained.transitions.some((transition) => transition.kind === 'selected'))
    return { status: 'protected', publicationId, reason: 'selected' };
  if (retained.current.kind !== 'retired')
    return { status: 'protected', publicationId, reason: 'pending' };
  if (
    view.get(
      'SELECT publication_id FROM artifact_retention_selections WHERE publication_id = ? UNION ALL SELECT publication_id FROM review_retention_bindings WHERE publication_id = ? LIMIT 1',
      publicationId,
      publicationId
    )
  )
    return { status: 'protected', publicationId, reason: 'referenced' };
  return {
    status: 'eligible',
    target: {
      publicationId,
      originalOperationId: owner.operationId,
      repositoryInstanceId: retained.input.repositoryInstanceId,
      retiredTransitionId: retained.current.transitionId,
      fullRef: publication.fullRef,
      objectOid: publication.objectOid,
      objectFormat: retained.input.objectFormat,
    },
  };
}
export function readProjectGitReclamation(handle: ProjectDatabase, publicationId: string) {
  retentionId(publicationId);
  return handle.read((view) => preview(view, publicationId));
}
function assertTarget(view: ProjectReadView, target: GitReclamationTarget) {
  const current = preview(view, target.publicationId);
  if (current.status !== 'eligible' || canonicalJson(current.target) !== canonicalJson(target))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'This exact publication is not positively retired and dependency-free; preserve it and preview a new explicit cleanup request'
    );
}
function beginOperation(input: GitReclamationAdmission) {
  return {
    operationId: input.admissionOperationId,
    kind: 'git.retention.cleanup.begin',
    intentChange: false,
    target: { publicationId: input.target.publicationId },
    payload: input,
    expectedState: { retiredTransitionId: input.target.retiredTransitionId },
  };
}
function terminalOperation(input: GitReclamationAdmission, outcome: 'removed' | 'absent') {
  return {
    operationId: input.terminalOperationId,
    kind: 'git.retention.cleanup.settle',
    intentChange: false,
    target: { publicationId: input.target.publicationId },
    payload: { admissionOperationId: input.admissionOperationId, target: input.target, outcome },
    expectedState: { retiredTransitionId: input.target.retiredTransitionId },
  };
}
interface Receipt {
  operation_kind: string;
  intent_change: number;
  target_json: string;
  payload_json: string;
  payload_hash: string;
  expected_state_json: string;
  result_json: string;
  committed_write_sequence: number;
  committed_intent_counter: number;
}
function validateReceipt(
  row: Receipt,
  operation: ReturnType<typeof beginOperation> | ReturnType<typeof terminalOperation>
) {
  const payload = serializeDatabaseValue(operation.payload);
  if (
    row.operation_kind !== operation.kind ||
    row.intent_change !== 0 ||
    row.target_json !== serializeDatabaseValue(operation.target) ||
    row.payload_json !== payload ||
    row.payload_hash !== createHash('sha256').update(payload).digest('hex') ||
    row.expected_state_json !== serializeDatabaseValue(operation.expectedState) ||
    !Number.isSafeInteger(row.committed_write_sequence) ||
    row.committed_write_sequence < 1 ||
    !Number.isSafeInteger(row.committed_intent_counter) ||
    row.committed_intent_counter < 0
  )
    retentionIntegrity();
}
function readAdmission(view: ProjectReadView, admissionOperationId: string) {
  const row = view.get<Receipt>(
    'SELECT * FROM operations WHERE operation_id = ?',
    admissionOperationId
  );
  if (!row) return null;
  if (row.operation_kind !== 'git.retention.cleanup.begin')
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select the original cleanup admission operation, not another retained operation kind'
    );
  try {
    const input = admissionSchema.parse(JSON.parse(row.payload_json));
    if (
      input.admissionOperationId !== admissionOperationId ||
      input.admissionOperationId === input.terminalOperationId
    )
      retentionIntegrity();
    validateReceipt(row, beginOperation(input));
    const expected = {
      terminalOperationId: input.terminalOperationId,
      publicationId: input.target.publicationId,
      state: 'admitted',
    };
    if (canonicalJson(JSON.parse(row.result_json)) !== canonicalJson(expected))
      retentionIntegrity();
    const terminal = view.get<Receipt>(
      'SELECT * FROM operations WHERE operation_id = ?',
      input.terminalOperationId
    );
    if (!terminal) return { input, terminal: null };
    const value = resultSchema.parse(JSON.parse(terminal.result_json));
    if (
      value.terminalOperationId !== input.terminalOperationId ||
      value.publicationId !== input.target.publicationId
    )
      retentionIntegrity();
    validateReceipt(terminal, terminalOperation(input, value.outcome));
    const reclamation = view.get<{
      publicationId: string;
      operationId: string;
      transitionId: string;
      oid: string;
      outcome: string;
    }>(
      'SELECT publication_id AS publicationId, original_operation_id AS operationId, retired_transition_id AS transitionId, expected_oid AS oid, outcome FROM git_retention_reclamations WHERE cleanup_operation_id = ?',
      input.terminalOperationId
    );
    if (
      !reclamation ||
      reclamation.publicationId !== input.target.publicationId ||
      reclamation.operationId !== input.target.originalOperationId ||
      reclamation.transitionId !== input.target.retiredTransitionId ||
      reclamation.oid !== input.target.objectOid ||
      reclamation.outcome !== value.outcome
    )
      retentionIntegrity();
    return {
      input,
      terminal: {
        value,
        replayed: true as const,
        counters: {
          writeSequence: terminal.committed_write_sequence,
          intentChangeCounter: terminal.committed_intent_counter,
        },
      },
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    retentionIntegrity(cause);
  }
}
export function readProjectGitReclamationAdmission(
  handle: ProjectDatabase,
  admissionOperationId: string
) {
  retentionId(admissionOperationId);
  return handle.read((view) => readAdmission(view, admissionOperationId));
}
export function readProjectGitReclamationInventory(handle: ProjectDatabase) {
  return handle.read((view) => {
    const retentions = view
      .all<{
        operationId: string;
      }>(
        'SELECT original_operation_id AS operationId FROM git_retention_operations ORDER BY original_operation_id'
      )
      .map(({ operationId }) => readRetentionRecords(view, operationId) ?? retentionIntegrity());
    const publications = retentions.flatMap((retention) => {
      if (retention.input.repositoryInstanceId !== handle.authority.repositoryInstanceId)
        retentionIntegrity();
      return retention.input.publications.map((publication) => ({
        publicationId: publication.publicationId,
        originalOperationId: retention.input.operationId,
        repositoryInstanceId: retention.input.repositoryInstanceId,
        role: publication.role,
        ownerId:
          retention.input.target.kind === 'capture'
            ? retention.input.target.artifactId
            : retention.input.target.reviewId,
        targetId: publication.targetId,
        checkpointNumber: publication.checkpointNumber,
        checkpointPhase: publication.checkpointPhase,
        fullRef: publication.fullRef,
        objectOid: publication.objectOid,
        objectFormat: retention.input.objectFormat,
        retentionState: retention.current.kind,
        preview: preview(view, publication.publicationId),
      }));
    });
    const admissions = view
      .all<{
        operationId: string;
      }>(
        "SELECT operation_id AS operationId FROM operations WHERE operation_kind = 'git.retention.cleanup.begin' ORDER BY operation_id"
      )
      .map(({ operationId }) => readAdmission(view, operationId) ?? retentionIntegrity());
    return { publications, admissions };
  });
}
export async function beginProjectGitReclamation(
  handle: ProjectDatabase,
  raw: GitReclamationAdmission,
  options: ProjectOperationOptions = {}
) {
  const parsed = admissionSchema.safeParse(raw);
  if (!parsed.success || parsed.data.admissionOperationId === parsed.data.terminalOperationId)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact prior preview and distinct original cleanup admission and terminal IDs'
    );
  const input = parsed.data;
  if (input.target.repositoryInstanceId !== handle.authority.repositoryInstanceId)
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Use the cleanup publication original repository database'
    );
  return runProjectOperation(
    handle,
    beginOperation(input),
    (tx) => {
      assertTarget(tx, input.target);
      if (
        tx.get(
          'SELECT operation_id FROM operations WHERE operation_id = ?',
          input.terminalOperationId
        )
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'Cleanup terminal identity is already occupied; preserve the original operation'
        );
      const reserved = tx.get<{ operationId: string }>(
        "SELECT operation_id AS operationId FROM operations WHERE operation_kind = 'git.retention.cleanup.begin' AND json_extract(payload_json, '$.terminalOperationId') IN (?, ?) LIMIT 1",
        input.terminalOperationId,
        input.admissionOperationId
      );
      if (reserved) {
        readAdmission(tx, reserved.operationId);
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'This terminal cleanup identity is retained by another original admission; resume that admission or use an explicitly new cleanup identity'
        );
      }
      return {
        terminalOperationId: input.terminalOperationId,
        publicationId: input.target.publicationId,
        state: 'admitted',
      };
    },
    options
  );
}
export async function settleProjectGitReclamation(
  handle: ProjectDatabase,
  raw: { admissionOperationId: string; outcome: 'removed' | 'absent' },
  options: ProjectOperationOptions = {}
) {
  const input = z
    .strictObject({ admissionOperationId: id, outcome: z.enum(['removed', 'absent']) })
    .safeParse(raw);
  if (!input.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact original cleanup admission and observed removed or absent outcome'
    );
  const admitted = readProjectGitReclamationAdmission(
    handle,
    input.data.admissionOperationId
  ).value;
  if (!admitted)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'Original cleanup input is missing; preserve refs and use explicit repair'
    );
  if (admitted.terminal) {
    if (admitted.terminal.value.outcome !== input.data.outcome)
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'The original cleanup already records a different observed outcome; replay its exact original result'
      );
    return admitted.terminal;
  }
  const target = admitted.input.target,
    outcome = input.data.outcome;
  return runProjectOperation(
    handle,
    terminalOperation(admitted.input, outcome),
    (tx) => {
      assertTarget(tx, target);
      tx.run(
        'INSERT INTO git_retention_reclamations VALUES (?, ?, ?, ?, ?, ?)',
        admitted.input.terminalOperationId,
        target.publicationId,
        target.originalOperationId,
        target.retiredTransitionId,
        target.objectOid,
        outcome
      );
      return {
        terminalOperationId: admitted.input.terminalOperationId,
        publicationId: target.publicationId,
        outcome,
      };
    },
    options
  );
}
