// A processing job and the admission that creates it. Admission runs inside the transaction that
// publishes its source, so the job and the source commit together or neither is reported saved.
import { ProjectDatabaseError } from './errors.js';
import { processingInstant, processingRecordId } from './processing-maintenance.js';
import type { ProjectSettlement } from './transactions.js';
import { type DatabaseJson, serializeDatabaseValue } from './values.js';
import { type EventType, EventTypeSchema } from '../../events/event-log.js';
import {
  admitsProcessingJob,
  type ProcessingJobIdentity,
  ProcessingJobIdentitySchema,
  type SourcePublicationPath,
} from '../../schema/knowledge-contract.js';

export type ProcessingJobState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'retryable_failure'
  | 'terminal_failure';

export type ProcessingAttributionBasis =
  | 'authenticated'
  | 'source_attributed'
  | 'agent_reported_user_instruction'
  | 'other_assertion'
  | 'unknown';

export interface ProcessingModelResume {
  /** Compatibility audit marker for the first confirmation; not scheduling authority. */
  resumedAt: string;
  resumedBy: string | null;
  resumedByBasis: ProcessingAttributionBasis;
  grantId: string;
}

export interface ProcessingJob {
  jobId: string;
  source: ProcessingJobIdentity['source'];
  processorContract: string;
  admittingOperationId: string;
  admission: DatabaseJson;
  withoutModel: boolean;
  admittedAt: string;
  state: ProcessingJobState;
  waitReason: string | null;
  retryAt: string | null;
  claimedGeneration: number | null;
  result: DatabaseJson;
  modelResume: ProcessingModelResume | null;
  updatedAt: string;
}

export interface ProcessingJobRow {
  jobId: string;
  sourceKind: string;
  sourceId: string;
  processorContract: string;
  admittingOperationId: string;
  admissionJson: string;
  withoutModel: number;
  admittedAt: string;
  state: string;
  waitReason: string | null;
  retryAt: string | null;
  claimedGeneration: number | null;
  resultJson: string | null;
  modelResumedAt: string | null;
  modelResumedBy: string | null;
  modelResumedByBasis: string | null;
  modelResumeGrantId: string | null;
  updatedAt: string;
}

export const PROCESSING_JOB_COLUMNS = `job_id AS jobId, source_kind AS sourceKind, source_id AS sourceId,
  processor_contract AS processorContract, admitting_operation_id AS admittingOperationId,
  admission_json AS admissionJson, without_model AS withoutModel, admitted_at AS admittedAt,
  state, wait_reason AS waitReason, retry_at AS retryAt, claimed_generation AS claimedGeneration,
  result_json AS resultJson, model_resumed_at AS modelResumedAt, model_resumed_by AS modelResumedBy,
  model_resumed_by_basis AS modelResumedByBasis, model_resume_grant_id AS modelResumeGrantId,
  updated_at AS updatedAt`;

const JOB_STATES: readonly string[] = [
  'pending',
  'running',
  'completed',
  'retryable_failure',
  'terminal_failure',
];

function integrity(message: string): never {
  throw new ProjectDatabaseError('HISTORY_INTEGRITY_REQUIRED', message);
}

export function decodeProcessingJob(row: ProcessingJobRow): ProcessingJob {
  if (!JOB_STATES.includes(row.state)) integrity('A retained processing job has an unknown state');
  if (row.sourceKind !== 'capture_event' && row.sourceKind !== 'knowledge_source')
    integrity('A retained processing job has an unknown source kind');
  let modelResume: ProcessingModelResume | null = null;
  if (row.modelResumedAt !== null) {
    if (row.modelResumedByBasis === null || row.modelResumeGrantId === null)
      integrity('A retained model resume is missing its attribution or consent grant');
    modelResume = {
      resumedAt: row.modelResumedAt,
      resumedBy: row.modelResumedBy,
      resumedByBasis: row.modelResumedByBasis as ProcessingAttributionBasis,
      grantId: row.modelResumeGrantId,
    };
  }
  return {
    jobId: row.jobId,
    source:
      row.sourceKind === 'capture_event'
        ? { kind: 'capture_event', event_id: row.sourceId }
        : { kind: 'knowledge_source', source_id: row.sourceId },
    processorContract: row.processorContract,
    admittingOperationId: row.admittingOperationId,
    admission: JSON.parse(row.admissionJson) as DatabaseJson,
    withoutModel: row.withoutModel === 1,
    admittedAt: row.admittedAt,
    state: row.state as ProcessingJobState,
    waitReason: row.waitReason,
    retryAt: row.retryAt,
    claimedGeneration: row.claimedGeneration,
    result: row.resultJson === null ? null : (JSON.parse(row.resultJson) as DatabaseJson),
    modelResume,
    updatedAt: row.updatedAt,
  };
}

export interface ProcessingAdmissionInput {
  /** The job identity this admission would mint. */
  jobId: string;
  identity: ProcessingJobIdentity;
  /** How the source reached this store; only a live path admits anything. */
  path: SourcePublicationPath;
  originKind: 'captured' | 'git-import' | null;
  settledEventTypes: readonly EventType[];
  derivedByProcessing: boolean;
  /** The invocation's no-model choice, retained with the job. */
  withoutModel: boolean;
  admittedAt: string;
  /** Anything else dispatch must re-read before constructing a provider. */
  context?: DatabaseJson;
}

export type ProcessingAdmission =
  | { outcome: 'admitted'; job: ProcessingJob }
  | { outcome: 'already_admitted'; job: ProcessingJob }
  | { outcome: 'not_eligible' };

/**
 * Admit a job for a source the caller is publishing in this very transaction,
 * using the settlement's own statement handle so the job rolls back with its
 * source. It moves no counter of its own: the receipt and the write sequence
 * this job is measured by are the publishing operation's, which is why the
 * admitting operation is recorded on the row and the admitted sequence is read
 * back through it.
 */
export function admitProcessingJob(
  transaction: ProjectSettlement,
  input: ProcessingAdmissionInput,
  operationId: string
): ProcessingAdmission {
  const jobId = processingRecordId(input.jobId, 'processing job');
  const admittingOperationId = processingRecordId(operationId, 'admitting operation');
  const admittedAt = processingInstant(input.admittedAt, 'the admission time');
  const identity = ProcessingJobIdentitySchema.safeParse(input.identity);
  if (!identity.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact processing source identity and processor contract',
      { cause: identity.error }
    );
  const settled = EventTypeSchema.array().safeParse(input.settledEventTypes);
  if (!settled.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the event types this operation settles as retained event types',
      { cause: settled.error }
    );
  if (
    input.originKind !== null &&
    input.originKind !== 'captured' &&
    input.originKind !== 'git-import'
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the retained artifact origin, or null when the source belongs to no artifact'
    );
  if (typeof input.derivedByProcessing !== 'boolean' || typeof input.withoutModel !== 'boolean')
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'State explicitly whether this source was derived by processing and whether the invocation chose no model'
    );
  if (
    !admitsProcessingJob({
      path: input.path,
      origin_kind: input.originKind,
      settled_event_types: settled.data,
      derived_by_processing: input.derivedByProcessing,
    })
  )
    return { outcome: 'not_eligible' };

  const source = identity.data.source;
  const sourceKind = source.kind;
  const sourceId = source.kind === 'capture_event' ? source.event_id : source.source_id;
  const contract = identity.data.processor_contract;
  const existing = transaction.get<ProcessingJobRow>(
    `SELECT ${PROCESSING_JOB_COLUMNS} FROM processing_jobs
      WHERE source_kind=? AND source_id=? AND processor_contract=?`,
    sourceKind,
    sourceId,
    contract
  );
  if (existing) return { outcome: 'already_admitted', job: decodeProcessingJob(existing) };
  if (transaction.get('SELECT job_id FROM processing_jobs WHERE job_id=?', jobId))
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The processing job identity already belongs to retained history'
    );

  const admissionJson = serializeDatabaseValue({
    path: input.path,
    origin_kind: input.originKind,
    settled_event_types: settled.data,
    derived_by_processing: input.derivedByProcessing,
    context: input.context ?? null,
  });
  transaction.run(
    `INSERT INTO processing_jobs (job_id,source_kind,source_id,processor_contract,
      admitting_operation_id,admission_json,without_model,admitted_at,state,wait_reason,retry_at,
      claimed_generation,result_json,model_resumed_at,model_resumed_by,model_resumed_by_basis,
      model_resume_grant_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)`,
    jobId,
    sourceKind,
    sourceId,
    contract,
    admittingOperationId,
    admissionJson,
    Number(input.withoutModel),
    admittedAt,
    admittedAt
  );
  return {
    outcome: 'admitted',
    job: decodeProcessingJob({
      jobId,
      sourceKind,
      sourceId,
      processorContract: contract,
      admittingOperationId,
      admissionJson,
      withoutModel: Number(input.withoutModel),
      admittedAt,
      state: 'pending',
      waitReason: null,
      retryAt: null,
      claimedGeneration: null,
      resultJson: null,
      modelResumedAt: null,
      modelResumedBy: null,
      modelResumedByBasis: null,
      modelResumeGrantId: null,
      updatedAt: admittedAt,
    }),
  };
}
