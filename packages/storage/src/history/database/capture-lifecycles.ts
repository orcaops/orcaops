import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { ArtifactLifecycleRowSchema } from '../capture-operation-records.js';
import {
  type CaptureAuthoredOptions,
  type CaptureOperationSelection,
  type LifecycleCompletionInput,
  type LifecycleCompletionPreparation,
  lifecycleCompletionPreparation,
  type PlanIdempotencyInput,
  type PlanIdempotencyPreparation,
  planIdempotencyPreparation,
  prepareAuthoredLifecycleCompletion,
  prepareAuthoredPlanIdempotency,
  type PreparedLifecycleCompletion,
  type PreparedPlanIdempotency,
} from './capture-operation-input.js';
import {
  assertCaptureArtifactRevision,
  assertCaptureOperation,
  captureArtifactId,
  captureArtifactRevision,
  captureIntegrity,
  captureKey,
  captureOperation,
  captureProvenanceColumns,
  captureReadColumns,
  captureReadJoins,
  captureRecordParameters,
  type CaptureRecordRow,
  decodeCaptureRecord,
  validateCaptureSelection,
} from './capture-records.js';
import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type ProjectOperationOptions,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';

interface LifecycleRow extends CaptureRecordRow {
  revisionId: string;
  version: number;
  firesAt: string;
  checkpointNumber: number;
  triggeredAt: string;
  executionContextHash: string | null;
}
function assertLifecycleSelections(view: ProjectReadView, artifactId: string): void {
  if (
    view.get(
      `SELECT o.operation_id FROM operations o
     WHERE o.operation_kind='lifecycle.publish' AND json_extract(o.target_json,'$.artifactId')=?
       AND NOT EXISTS (SELECT 1 FROM artifact_lifecycle_revisions r
         WHERE r.publication_operation_id=o.operation_id AND r.artifact_id=?) LIMIT 1`,
      artifactId,
      artifactId
    )
  )
    captureIntegrity('An original lifecycle publication receipt has no retained completion');
  if (
    view.get(
      `SELECT r.revision_id FROM artifact_lifecycle_revisions r
    LEFT JOIN artifact_lifecycle_current c ON c.artifact_id=r.artifact_id AND c.fires_at=r.fires_at AND c.cp_n=r.cp_n
    WHERE r.artifact_id=? AND c.revision_id IS NULL LIMIT 1`,
      artifactId
    )
  )
    captureIntegrity('A lifecycle selection is missing while retained observations remain');
}
function currentLifecycle(
  view: ProjectReadView,
  record: LifecycleCompletionPreparation
): CaptureOperationSelection | null {
  assertLifecycleSelections(view, record.artifactId);
  const selected = view.get<{
    revisionId: string;
    version: number;
    recordId: string | null;
    operationId: string | null;
  }>(
    `SELECT c.revision_id AS revisionId,c.version,r.revision_id AS recordId,o.operation_id AS operationId
    FROM artifact_lifecycle_current c
    LEFT JOIN artifact_lifecycle_revisions r ON r.artifact_id=c.artifact_id AND r.fires_at=c.fires_at AND r.cp_n=c.cp_n AND r.revision_id=c.revision_id
    LEFT JOIN operations o ON o.operation_id=r.publication_operation_id
    WHERE c.artifact_id=? AND c.fires_at=? AND c.cp_n=?`,
    record.artifactId,
    record.row.fires_at,
    record.row.cp_n
  );
  if (!selected) return null;
  validateCaptureSelection(selected);
  if (selected.recordId !== selected.revisionId || selected.operationId === null)
    captureIntegrity('Selected lifecycle history or publication is missing');
  return { revisionId: selected.revisionId, version: selected.version };
}
export function selectProjectLifecycleCompletions(view: ProjectReadView, id: string) {
  captureArtifactRevision(view, id);
  assertLifecycleSelections(view, id);
  return view.all<LifecycleRow>(
    `SELECT ${captureReadColumns}, c.revision_id AS revisionId,c.version,
      c.fires_at AS firesAt,c.cp_n AS checkpointNumber,r.triggered_at AS triggeredAt,r.execution_context_hash AS executionContextHash
      FROM artifact_lifecycle_current c
      LEFT JOIN artifact_lifecycle_revisions r ON r.artifact_id=c.artifact_id AND r.fires_at=c.fires_at AND r.cp_n=c.cp_n AND r.revision_id=c.revision_id
      ${captureReadJoins} WHERE c.artifact_id=? ORDER BY c.fires_at,c.cp_n`,
    id
  );
}

export function hydrateProjectLifecycleCompletions(snapshot: {
  value: ReturnType<typeof selectProjectLifecycleCompletions>;
  counters: ProjectCounters;
}) {
  return {
    records: snapshot.value.map((row) => {
      validateCaptureSelection(row);
      const decoded = decodeCaptureRecord(row, ArtifactLifecycleRowSchema);
      if (
        decoded.record.fires_at !== row.firesAt ||
        decoded.record.cp_n !== row.checkpointNumber ||
        decoded.record.triggered_at !== row.triggeredAt ||
        (decoded.record.execution_context_hash ?? null) !== row.executionContextHash
      )
        captureIntegrity('Lifecycle lookup columns differ from original retained bytes');
      return {
        selection: { revisionId: row.revisionId, version: row.version },
        operationId: row.operationId,
        artifactId: row.artifactId,
        artifactGeneration: row.artifactGeneration,
        sourceKind: row.sourceKind,
        sourceProfile: row.sourceProfile,
        ...decoded,
      };
    }),
    counters: snapshot.counters,
  };
}

export function readProjectLifecycleCompletions(handle: ProjectDatabase, artifactId: string) {
  const id = captureArtifactId(artifactId);
  assertProjectDatabasePath(handle);
  return hydrateProjectLifecycleCompletions(
    handle.read((view) => selectProjectLifecycleCompletions(view, id))
  );
}

export interface PreparedLifecycleSettlement {
  readonly kind: 'prepared-lifecycle-settlement';
}
const lifecycleSettlements = new WeakMap<
  PreparedLifecycleSettlement,
  { record: LifecycleCompletionPreparation; parameters: unknown[] }
>();
export function prepareLifecycleCompletionSettlement(
  input: PreparedLifecycleCompletion
): PreparedLifecycleSettlement {
  const record = lifecycleCompletionPreparation(input);
  const value = Object.freeze({ kind: 'prepared-lifecycle-settlement' as const });
  lifecycleSettlements.set(value, { record, parameters: captureRecordParameters(record) });
  return value;
}
export function settleProjectLifecycleCompletion(
  transaction: ProjectSettlement,
  input: PreparedLifecycleSettlement,
  operationId: string
) {
  const value = lifecycleSettlements.get(input);
  if (!value)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Use genuine prepared lifecycle settlement');
  const { record, parameters } = value;
  assertCaptureOperation(record, operationId);
  assertCaptureArtifactRevision(transaction, record.artifactId, record.artifactRevision);
  const previous = currentLifecycle(transaction, record);
  if (!isDeepStrictEqual(previous, record.expectedSelection))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Lifecycle selection changed; prepare a new completion against the intended slot'
    );
  if (
    transaction.get(
      'SELECT revision_id FROM artifact_lifecycle_revisions WHERE revision_id=?',
      record.revisionId
    )
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The lifecycle revision identity already belongs to retained history'
    );
  const version = (previous?.version ?? 0) + 1;
  if (!Number.isSafeInteger(version))
    captureIntegrity('Lifecycle selection version capacity is exhausted');
  transaction.run(
    `INSERT INTO artifact_lifecycle_revisions (revision_id,${captureProvenanceColumns},fires_at,cp_n,triggered_at,execution_context_hash) VALUES (${Array(18).fill('?').join(',')})`,
    record.revisionId,
    ...parameters,
    record.row.fires_at,
    record.row.cp_n,
    record.row.triggered_at,
    record.row.execution_context_hash ?? null
  );
  if (previous)
    transaction.run(
      'UPDATE artifact_lifecycle_current SET revision_id=?,version=? WHERE artifact_id=? AND fires_at=? AND cp_n=? AND revision_id=? AND version=?',
      record.revisionId,
      version,
      record.artifactId,
      record.row.fires_at,
      record.row.cp_n,
      previous.revisionId,
      previous.version
    );
  else
    transaction.run(
      'INSERT INTO artifact_lifecycle_current VALUES (?,?,?,?,?)',
      record.artifactId,
      record.row.fires_at,
      record.row.cp_n,
      record.revisionId,
      version
    );
  return { artifactId: record.artifactId, selection: { revisionId: record.revisionId, version } };
}
export async function publishProjectLifecycleCompletion(
  handle: ProjectDatabase,
  input: LifecycleCompletionInput,
  refusal: CaptureAuthoredOptions,
  options: ProjectOperationOptions = {}
) {
  const prepared = prepareAuthoredLifecycleCompletion(input, refusal);
  const record = lifecycleCompletionPreparation(prepared);
  const settlement = prepareLifecycleCompletionSettlement(prepared);
  assertProjectDatabasePath(handle);
  handle.read((view) => {
    assertLifecycleSelections(view, record.artifactId);
    return null;
  });
  return runProjectOperation(
    handle,
    captureOperation(record, 'lifecycle.publish', {
      artifactRevision: { ...record.artifactRevision },
      selection: record.expectedSelection === null ? null : { ...record.expectedSelection },
    }),
    (transaction) => settleProjectLifecycleCompletion(transaction, settlement, record.operationId),
    options
  );
}

const PlanRowSchema = z.strictObject({
  idempotency_key: z.string().min(1),
  artifact_id: z.string().uuid(),
  created_at: z.string().min(1),
});
interface PlanRow extends CaptureRecordRow {
  idempotencyKey: string;
  createdAt: string;
}
export function selectPlanIdempotencyRecord(view: ProjectReadView, key: string): PlanRow | null {
  return (
    view.get<PlanRow>(
      `SELECT ${captureReadColumns},r.idempotency_key AS idempotencyKey,r.created_at AS createdAt
    FROM plan_idempotency_records r ${captureReadJoins} WHERE r.idempotency_key=?`,
      key
    ) ?? null
  );
}
export function readProjectPlanIdempotency(handle: ProjectDatabase, key: string) {
  const selected = captureKey(key);
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => selectPlanIdempotencyRecord(view, selected));
  return hydratePlanIdempotencyRecord(snapshot);
}
export function hydratePlanIdempotencyRecord(snapshot: {
  value: PlanRow | null;
  counters: ProjectCounters;
}) {
  if (!snapshot.value) return null;
  const row = snapshot.value;
  const decoded = decodeCaptureRecord(row, PlanRowSchema);
  if (
    decoded.record.artifact_id !== row.artifactId ||
    decoded.record.idempotency_key !== row.idempotencyKey ||
    decoded.record.created_at !== row.createdAt
  )
    captureIntegrity('Plan-key lookup columns differ from original retained bytes');
  return {
    operationId: row.operationId,
    artifactGeneration: row.artifactGeneration,
    sourceKind: row.sourceKind,
    sourceProfile: row.sourceProfile,
    ...decoded,
    counters: snapshot.counters,
  };
}
export interface PreparedPlanIdempotencySettlement {
  readonly kind: 'prepared-plan-idempotency-settlement';
}
const planSettlements = new WeakMap<
  PreparedPlanIdempotencySettlement,
  {
    record: PlanIdempotencyPreparation;
    parameters: unknown[];
    expected: Omit<
      PlanRow,
      'operationId' | 'retainedOperationId' | 'artifactGeneration' | 'retainedGeneration'
    >;
  }
>();
export function preparePlanIdempotencySettlement(
  input: PreparedPlanIdempotency
): PreparedPlanIdempotencySettlement {
  const record = planIdempotencyPreparation(input);
  const parameters = captureRecordParameters(record);
  const expected = {
    artifactId: record.artifactId,
    sourceKind: record.sourceKind,
    sourceIdentity: record.source.identity,
    sourceLocator: record.source.locator,
    sourceProfile: record.sourceProfile,
    sourceRevisionId: record.source.revisionId,
    sourceEventId: record.source.eventId,
    sourceOperationId: record.source.operationId,
    sourceSha256: record.source.sha256,
    bytesHex: Buffer.from(record.bytesBase64!, 'base64').toString('hex').toUpperCase(),
    recordHash: record.recordHash,
    idempotencyKey: record.row.idempotency_key,
    createdAt: record.row.created_at,
  };
  const value = Object.freeze({ kind: 'prepared-plan-idempotency-settlement' as const });
  planSettlements.set(value, { record, parameters, expected });
  return value;
}
export function settleProjectPlanIdempotency(
  transaction: ProjectSettlement,
  input: PreparedPlanIdempotencySettlement,
  operationId: string
) {
  const value = planSettlements.get(input);
  if (!value)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Use genuine prepared plan-key settlement');
  const { record, parameters, expected } = value;
  assertCaptureOperation(record, operationId);
  assertCaptureArtifactRevision(transaction, record.artifactId, record.artifactRevision);
  const prior = selectPlanIdempotencyRecord(transaction, record.row.idempotency_key);
  if (prior) {
    if (
      prior.retainedOperationId !== prior.operationId ||
      prior.retainedGeneration !== prior.artifactGeneration
    )
      captureIntegrity('Original plan-key publication or artifact revision is missing');
    const {
      operationId: _operation,
      retainedOperationId: _receipt,
      artifactGeneration: _generation,
      retainedGeneration: _retained,
      ...content
    } = prior;
    if (!isDeepStrictEqual(content, expected))
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'The original plan key identifies different content or provenance; preserve its original mapping'
      );
    return {
      artifactId: prior.artifactId,
      idempotencyKey: prior.idempotencyKey,
      publicationOperationId: prior.operationId,
    };
  }
  transaction.run(
    `INSERT INTO plan_idempotency_records (idempotency_key,${captureProvenanceColumns},created_at) VALUES (${Array(15).fill('?').join(',')})`,
    record.row.idempotency_key,
    ...parameters,
    record.row.created_at
  );
  return {
    artifactId: record.artifactId,
    idempotencyKey: record.row.idempotency_key,
    publicationOperationId: record.operationId,
  };
}
export async function publishProjectPlanIdempotency(
  handle: ProjectDatabase,
  input: PlanIdempotencyInput,
  refusal: CaptureAuthoredOptions,
  options: ProjectOperationOptions = {}
) {
  const prepared = prepareAuthoredPlanIdempotency(input, refusal);
  const record = planIdempotencyPreparation(prepared);
  const settlement = preparePlanIdempotencySettlement(prepared);
  assertProjectDatabasePath(handle);
  return runProjectOperation(
    handle,
    captureOperation(record, 'plan-key.publish', {
      artifactRevision: { ...record.artifactRevision },
    }),
    (transaction) => settleProjectPlanIdempotency(transaction, settlement, record.operationId),
    options
  );
}
