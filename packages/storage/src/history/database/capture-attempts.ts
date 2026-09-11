import { isDeepStrictEqual } from 'node:util';

import { ArtifactAttemptRowSchema } from '../capture-operation-records.js';
import {
  type ArtifactAttemptInput,
  type ArtifactAttemptPreparation,
  artifactAttemptPreparation,
  type CaptureAuthoredOptions,
  type CaptureOperationSelection,
  prepareAuthoredArtifactAttempt,
  type PreparedArtifactAttempt,
} from './capture-operation-input.js';
import {
  assertCaptureArtifactRevision,
  assertCaptureOperation,
  captureArtifactId,
  captureArtifactRevision,
  captureIntegrity,
  captureOperation,
  captureProvenanceColumns,
  captureReadColumns,
  captureReadJoins,
  captureRecordParameters,
  type CaptureRecordRow,
  decodeCaptureProvenance,
  decodeCaptureRecord,
  validateCaptureSelection,
} from './capture-records.js';
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type ProjectOperationOptions,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';

interface AttemptRow extends CaptureRecordRow {
  revisionId: string;
  version: number | null;
  eventType: string;
  idempotencyKey: string;
  action: 'set' | 'clear';
  outcome: 'soft_blocked' | 'hard_rejected' | null;
  payloadHash: string | null;
  evaluatorFingerprint: string | null;
  envelope: string | null;
  recordedAt: string | null;
}
function assertAttemptSelections(view: ProjectReadView, artifactId: string): void {
  if (
    view.get(
      `SELECT r.revision_id FROM artifact_attempt_revisions r
    LEFT JOIN artifact_attempt_current c ON c.artifact_id=r.artifact_id AND c.event_type=r.event_type AND c.idempotency_key=r.idempotency_key
    WHERE r.artifact_id=? AND c.revision_id IS NULL LIMIT 1`,
      artifactId
    )
  )
    captureIntegrity('An attempt selection is missing while retained history remains');
}
function currentAttempt(
  view: ProjectReadView,
  record: ArtifactAttemptPreparation
): CaptureOperationSelection | null {
  assertAttemptSelections(view, record.artifactId);
  const selected = view.get<{
    revisionId: string;
    version: number;
    recordId: string | null;
    operationId: string | null;
  }>(
    `SELECT c.revision_id AS revisionId,c.version,r.revision_id AS recordId,o.operation_id AS operationId
    FROM artifact_attempt_current c
    LEFT JOIN artifact_attempt_revisions r ON r.artifact_id=c.artifact_id AND r.event_type=c.event_type AND r.idempotency_key=c.idempotency_key AND r.revision_id=c.revision_id
    LEFT JOIN operations o ON o.operation_id=r.publication_operation_id
    WHERE c.artifact_id=? AND c.event_type=? AND c.idempotency_key=?`,
    record.artifactId,
    record.eventType,
    record.idempotencyKey
  );
  if (!selected) return null;
  validateCaptureSelection(selected);
  if (selected.recordId !== selected.revisionId || selected.operationId === null)
    captureIntegrity('Selected attempt record or publication is missing');
  return { revisionId: selected.revisionId, version: selected.version };
}
export function readProjectArtifactAttempts(handle: ProjectDatabase, artifactId: string) {
  const id = captureArtifactId(artifactId);
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => {
    captureArtifactRevision(view, id);
    assertAttemptSelections(view, id);
    return view.all<AttemptRow>(
      `SELECT ${captureReadColumns},c.revision_id AS revisionId,c.version,
      c.event_type AS eventType,c.idempotency_key AS idempotencyKey,r.action,r.outcome,r.payload_hash AS payloadHash,
      r.evaluator_fingerprint AS evaluatorFingerprint,r.envelope,r.recorded_at AS recordedAt
      FROM artifact_attempt_current c
      LEFT JOIN artifact_attempt_revisions r ON r.artifact_id=c.artifact_id AND r.event_type=c.event_type AND r.idempotency_key=c.idempotency_key AND r.revision_id=c.revision_id
      ${captureReadJoins} WHERE c.artifact_id=? ORDER BY c.event_type,c.idempotency_key`,
      id
    );
  });
  return { records: snapshot.value.map(decodeAttempt), counters: snapshot.counters };
}
function decodeAttempt(row: AttemptRow) {
  if (row.version !== null)
    validateCaptureSelection({ revisionId: row.revisionId, version: row.version });
  const source = decodeCaptureProvenance(row);
  const common = {
    revisionId: row.revisionId,
    selection: row.version === null ? null : { revisionId: row.revisionId, version: row.version },
    operationId: row.operationId,
    artifactId: row.artifactId,
    artifactGeneration: row.artifactGeneration,
    sourceKind: row.sourceKind,
    sourceProfile: row.sourceProfile,
    source,
    eventType: row.eventType,
    idempotencyKey: row.idempotencyKey,
  };
  if (row.action === 'clear') {
    if (
      [
        row.bytesHex,
        row.recordHash,
        row.sourceSha256,
        row.outcome,
        row.payloadHash,
        row.evaluatorFingerprint,
        row.envelope,
        row.recordedAt,
      ].some((value) => value !== null)
    )
      captureIntegrity('Explicit attempt clear contains inconsistent retained set fields');
    return { ...common, action: 'clear' as const, record: null, bytes: null };
  }
  if (row.action !== 'set') captureIntegrity('Attempt action is invalid');
  const decoded = decodeCaptureRecord(row, ArtifactAttemptRowSchema);
  if (
    !isDeepStrictEqual(decoded.record, {
      artifact_id: row.artifactId,
      event_type: row.eventType,
      idempotency_key: row.idempotencyKey,
      outcome: row.outcome,
      payload_hash: row.payloadHash,
      evaluator_fingerprint: row.evaluatorFingerprint,
      envelope: row.envelope,
      recorded_at: row.recordedAt,
    })
  )
    captureIntegrity('Attempt lookup fields differ from the original record bytes');
  return { ...common, action: 'set' as const, record: decoded.record, bytes: decoded.bytes };
}

export function readProjectArtifactAttemptRevision(
  handle: ProjectDatabase,
  artifactId: string,
  revisionId: string
) {
  const id = captureArtifactId(artifactId);
  const revision = captureArtifactId(revisionId);
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) =>
    view.get<AttemptRow>(
      `SELECT ${captureReadColumns},r.revision_id AS revisionId,NULL AS version,
    r.event_type AS eventType,r.idempotency_key AS idempotencyKey,r.action,r.outcome,r.payload_hash AS payloadHash,
    r.evaluator_fingerprint AS evaluatorFingerprint,r.envelope,r.recorded_at AS recordedAt
    FROM artifact_attempt_revisions r ${captureReadJoins} WHERE r.artifact_id=? AND r.revision_id=?`,
      id,
      revision
    )
  );
  if (!snapshot.value)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The requested original attempt revision is missing; preserve history for explicit repair'
    );
  return { ...decodeAttempt(snapshot.value), counters: snapshot.counters };
}
export interface PreparedAttemptSettlement {
  readonly kind: 'prepared-attempt-settlement';
}
const attempts = new WeakMap<
  PreparedAttemptSettlement,
  { record: ArtifactAttemptPreparation; parameters: unknown[] }
>();
export function prepareArtifactAttemptSettlement(
  input: PreparedArtifactAttempt
): PreparedAttemptSettlement {
  const record = artifactAttemptPreparation(input);
  const value = Object.freeze({ kind: 'prepared-attempt-settlement' as const });
  attempts.set(value, { record, parameters: captureRecordParameters(record) });
  return value;
}
export function settleProjectArtifactAttemptChanges(
  transaction: ProjectSettlement,
  input: PreparedAttemptSettlement,
  operationId: string
) {
  const value = attempts.get(input);
  if (!value)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Use genuine prepared attempt settlement');
  const { record, parameters } = value;
  assertCaptureOperation(record, operationId);
  assertCaptureArtifactRevision(transaction, record.artifactId, record.artifactRevision);
  const previous = currentAttempt(transaction, record);
  if (!isDeepStrictEqual(previous, record.expectedSelection))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Attempt selection changed; prepare a new result against the intended slot'
    );
  if (
    transaction.get(
      'SELECT revision_id FROM artifact_attempt_revisions WHERE revision_id=?',
      record.revisionId
    )
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The attempt revision identity already belongs to retained history'
    );
  const version = (previous?.version ?? 0) + 1;
  if (!Number.isSafeInteger(version))
    captureIntegrity('Attempt selection version capacity is exhausted');
  transaction.run(
    `INSERT INTO artifact_attempt_revisions (revision_id,${captureProvenanceColumns},event_type,idempotency_key,action,outcome,payload_hash,evaluator_fingerprint,envelope,recorded_at) VALUES (${Array(22).fill('?').join(',')})`,
    record.revisionId,
    ...parameters,
    record.eventType,
    record.idempotencyKey,
    record.action,
    record.row?.outcome ?? null,
    record.row?.payload_hash ?? null,
    record.row?.evaluator_fingerprint ?? null,
    record.row?.envelope ?? null,
    record.row?.recorded_at ?? null
  );
  if (previous)
    transaction.run(
      'UPDATE artifact_attempt_current SET revision_id=?,version=? WHERE artifact_id=? AND event_type=? AND idempotency_key=? AND revision_id=? AND version=?',
      record.revisionId,
      version,
      record.artifactId,
      record.eventType,
      record.idempotencyKey,
      previous.revisionId,
      previous.version
    );
  else
    transaction.run(
      'INSERT INTO artifact_attempt_current VALUES (?,?,?,?,?)',
      record.artifactId,
      record.eventType,
      record.idempotencyKey,
      record.revisionId,
      version
    );
  return {
    artifactId: record.artifactId,
    action: record.action,
    selection: { revisionId: record.revisionId, version },
  };
}
export async function publishProjectArtifactAttempt(
  handle: ProjectDatabase,
  input: ArtifactAttemptInput,
  refusal: CaptureAuthoredOptions,
  options: ProjectOperationOptions = {}
) {
  const prepared = prepareAuthoredArtifactAttempt(input, refusal);
  const record = artifactAttemptPreparation(prepared);
  const settlement = prepareArtifactAttemptSettlement(prepared);
  assertProjectDatabasePath(handle);
  return runProjectOperation(
    handle,
    captureOperation(record, 'attempt.publish', {
      artifactRevision: { ...record.artifactRevision },
      selection: record.expectedSelection === null ? null : { ...record.expectedSelection },
    }),
    (transaction) =>
      settleProjectArtifactAttemptChanges(transaction, settlement, record.operationId),
    options
  );
}
