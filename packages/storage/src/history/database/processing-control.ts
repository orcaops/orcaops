// What a person decides: the project-wide pause, the explicit resume that lifts an invocation's
// no-model choice on one job, and the reopening of a job that gave up. Each outlives any worker, so
// a person's act names no lease generation and pausing touches no job row at all. The worker pauses too, when a safety property did not hold
// or the same local condition ends attempt after attempt, and its pause names its generation so a
// superseded owner cannot make one.
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeProcessingJob,
  PROCESSING_JOB_COLUMNS,
  type ProcessingAttributionBasis,
  type ProcessingJob,
  type ProcessingJobRow,
} from './processing-jobs.js';
import { assertProcessingLeaseGeneration } from './processing-lease.js';
import {
  processingBound,
  processingInstant,
  processingRecordId,
  processingText,
  runProcessingMaintenance,
} from './processing-maintenance.js';
import {
  type ProcessingJobReopening,
  readLatestProcessingJobReopening,
} from './processing-reopenings.js';
import type { ProjectOperationOptions } from './transactions.js';
import { serializeDatabaseValue } from './values.js';

export interface ProcessingControl {
  paused: boolean;
  changedAt: string;
  changedBy: string | null;
  changedByBasis: ProcessingAttributionBasis;
  reason: string | null;
}

const ATTRIBUTION_BASES: readonly ProcessingAttributionBasis[] = [
  'authenticated',
  'source_attributed',
  'agent_reported_user_instruction',
  'other_assertion',
  'unknown',
];

const CONTROL_COLUMNS = `paused, changed_at AS changedAt, changed_by AS changedBy,
  changed_by_basis AS changedByBasis, reason`;

interface ControlRow {
  paused: number;
  changedAt: string;
  changedBy: string | null;
  changedByBasis: string;
  reason: string | null;
}

function decodeControl(row: ControlRow): ProcessingControl {
  if (!(ATTRIBUTION_BASES as readonly string[]).includes(row.changedByBasis))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The retained processing pause has an unknown attribution basis'
    );
  return {
    paused: row.paused === 1,
    changedAt: row.changedAt,
    changedBy: row.changedBy,
    changedByBasis: row.changedByBasis as ProcessingAttributionBasis,
    reason: row.reason,
  };
}

/** How processing stands project-wide. Null means it was never paused here. */
export function readProcessingControl(handle: ProjectDatabase): ProcessingControl | null {
  assertProjectDatabasePath(handle);
  return handle.read((view) => {
    const row = view.get<ControlRow>(
      `SELECT ${CONTROL_COLUMNS} FROM processing_control WHERE singleton=1`
    );
    return row ? decodeControl(row) : null;
  }).value;
}

export interface SetProcessingPause {
  changedAt: string;
  changedBy: string | null;
  changedByBasis: ProcessingAttributionBasis;
  reason?: string | null;
  /**
   * The lease generation, when a worker is the one pausing. A person's pause
   * outlives every worker and names none; a worker's is a write like its
   * others, and a superseded owner must not make it.
   */
  generation?: number;
}

function actor(input: SetProcessingPause): { changedBy: string | null; basis: string } {
  const basis = input.changedByBasis;
  if (!(ATTRIBUTION_BASES as readonly string[]).includes(basis))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Say how the person who changed the pause is known'
    );
  const changedBy =
    input.changedBy === null || input.changedBy === undefined
      ? null
      : processingText(input.changedBy, 'who changed the pause');
  if ((changedBy === null) !== (basis === 'unknown'))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Only an unknown actor has no name, and a named actor says how the name is known'
    );
  return { changedBy, basis };
}

async function setPause(
  handle: ProjectDatabase,
  paused: boolean,
  input: SetProcessingPause,
  options: ProjectOperationOptions
): Promise<ProcessingControl> {
  const changedAt = processingInstant(input.changedAt, 'the time the pause changed');
  const { changedBy, basis } = actor(input);
  const reason =
    input.reason === null || input.reason === undefined
      ? null
      : processingText(input.reason, 'the reason', 4096);
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    paused ? 'processing.control.pause' : 'processing.control.resume',
    (transaction) => {
      if (input.generation !== undefined)
        assertProcessingLeaseGeneration(transaction, input.generation);
      const present = transaction.get('SELECT singleton FROM processing_control WHERE singleton=1');
      const changes = present
        ? transaction.run(
            'UPDATE processing_control SET paused=?, changed_at=?, changed_by=?, changed_by_basis=?, reason=? WHERE singleton=1',
            Number(paused),
            changedAt,
            changedBy,
            basis,
            reason
          ).changes
        : transaction.run(
            'INSERT INTO processing_control (singleton,paused,changed_at,changed_by,changed_by_basis,reason) VALUES (1,?,?,?,?,?)',
            Number(paused),
            changedAt,
            changedBy,
            basis,
            reason
          ).changes;
      if (changes !== 1)
        throw new ProjectDatabaseError(
          'TRANSACTION_FAILED',
          'The processing pause did not change; inspect storage before retrying'
        );
      return decodeControl({
        paused: Number(paused),
        changedAt,
        changedBy,
        changedByBasis: basis,
        reason,
      });
    },
    options
  );
}

/** Stop claiming project-wide, recording who paused it and why. No job changes. */
export function pauseProcessing(
  handle: ProjectDatabase,
  input: SetProcessingPause,
  options: ProjectOperationOptions = {}
): Promise<ProcessingControl> {
  return setPause(handle, true, input, options);
}

/** Let claiming resume project-wide. No job changes. */
export function resumeProcessing(
  handle: ProjectDatabase,
  input: SetProcessingPause,
  options: ProjectOperationOptions = {}
): Promise<ProcessingControl> {
  return setPause(handle, false, input, options);
}

export interface RetryProcessingJob {
  jobId: string;
  now: string;
}

export type ProcessingRetry =
  /** The job is claimable from now on. */
  | { outcome: 'due'; job: ProcessingJob }
  /** A call is in flight for it; recovery, not a retry, is what frees a lost one. */
  | { outcome: 'running'; job: ProcessingJob }
  /** Completed or gave up. Retry revives neither; only a person's reopening revives one that gave up. */
  | { outcome: 'finished'; job: ProcessingJob };

/**
 * The operator's retry: make a job that is parked or waiting due now. It resets
 * no attempt allowance and reopens no finished job, and like the pause it is a
 * person's act, so it names no lease generation.
 */
export async function retryProcessingJob(
  handle: ProjectDatabase,
  input: RetryProcessingJob,
  options: ProjectOperationOptions = {}
): Promise<ProcessingRetry> {
  const jobId = processingRecordId(input.jobId, 'processing job');
  const now = processingInstant(input.now, 'the current time');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.job.retry',
    (transaction) => {
      const row = transaction.get<ProcessingJobRow>(
        `SELECT ${PROCESSING_JOB_COLUMNS} FROM processing_jobs WHERE job_id=?`,
        jobId
      );
      if (!row)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'The processing job is missing; preserve history for explicit repair'
        );
      const job = decodeProcessingJob(row);
      if (job.state === 'completed' || job.state === 'terminal_failure')
        return { outcome: 'finished' as const, job };
      if (job.state === 'running') return { outcome: 'running' as const, job };
      // A pending job is parked by its wait reason and a failed one by its retry time, so each is
      // freed by clearing what holds it. The failure's own reason is kept: it still explains why.
      const waitReason = job.state === 'pending' ? null : job.waitReason;
      const retryAt = job.state === 'pending' ? null : now;
      const changes = transaction.run(
        'UPDATE processing_jobs SET wait_reason=?, retry_at=?, updated_at=? WHERE job_id=? AND state=?',
        waitReason,
        retryAt,
        now,
        jobId,
        job.state
      ).changes;
      if (changes !== 1)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing job changed while the retry was being recorded'
        );
      return {
        outcome: 'due' as const,
        job: decodeProcessingJob({ ...row, waitReason, retryAt, updatedAt: now }),
      };
    },
    options
  );
}

export interface ReopenProcessingJob {
  reopeningId: string;
  jobId: string;
  /** The job as it was shown, so a job that changed since is refused rather than reopened. */
  expectedUpdatedAt: string;
  expectedPreviousSequence: number | null;
  /** The allowance the person approved. */
  attemptsAllowed: number;
  reopenedAt: string;
  reopenedBy: string | null;
  reopenedByBasis: ProcessingAttributionBasis;
  /** The workload consent grant the reopening rests on. */
  grantId: string;
}

export type ProcessingReopen =
  | { outcome: 'reopened'; job: ProcessingJob; reopening: ProcessingJobReopening }
  /** A completed job is never run again. */
  | { outcome: 'finished'; job: ProcessingJob }
  /** The job has not given up; retry, not a reopening, frees it. */
  | { outcome: 'open'; job: ProcessingJob };

/**
 * A person's reopening of a job that gave up. The job is pending again with
 * the allowance the person approved, counted from its next attempt; the
 * result it gave up with moves onto the reopening, and every earlier attempt
 * stays as it ended. It records no model confirmation: a job admitted without
 * a model still needs one that fits its current terms before it runs.
 */
export async function reopenProcessingJob(
  handle: ProjectDatabase,
  input: ReopenProcessingJob,
  options: ProjectOperationOptions = {}
): Promise<ProcessingReopen> {
  const reopeningId = processingRecordId(input.reopeningId, 'processing job reopening');
  const jobId = processingRecordId(input.jobId, 'processing job');
  const reopenedAt = processingInstant(input.reopenedAt, 'the reopening time');
  const expectedUpdatedAt = processingText(input.expectedUpdatedAt, 'the job as it was shown');
  const attemptsAllowed = processingBound(input.attemptsAllowed, 'the approved attempt allowance');
  if (!ATTRIBUTION_BASES.includes(input.reopenedByBasis))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Say how the person who reopened the job is known'
    );
  const reopenedBy =
    input.reopenedBy === null ? null : processingText(input.reopenedBy, 'who reopened the job');
  if ((reopenedBy === null) !== (input.reopenedByBasis === 'unknown'))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Only an unknown actor has no name, and a named actor says how the name is known'
    );
  const grantId = processingText(input.grantId, 'the reopening grant');
  if (
    input.expectedPreviousSequence !== null &&
    (!Number.isSafeInteger(input.expectedPreviousSequence) || input.expectedPreviousSequence < 1)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The expected previous reopening sequence must be null or a positive whole number'
    );
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.job.reopen',
    (transaction) => {
      const row = transaction.get<ProcessingJobRow>(
        `SELECT ${PROCESSING_JOB_COLUMNS} FROM processing_jobs WHERE job_id=?`,
        jobId
      );
      if (!row)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'The processing job is missing; preserve history for explicit repair'
        );
      const job = decodeProcessingJob(row);
      if (job.state === 'completed') return { outcome: 'finished' as const, job };
      if (job.state !== 'terminal_failure') return { outcome: 'open' as const, job };
      const latest = readLatestProcessingJobReopening(transaction, jobId);
      if (
        job.updatedAt !== expectedUpdatedAt ||
        (latest?.reopeningSequence ?? null) !== input.expectedPreviousSequence
      )
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing job changed after it was shown; show it and reopen it again'
        );
      if (
        transaction.get(
          'SELECT reopening_id FROM processing_job_reopenings WHERE reopening_id=?',
          reopeningId
        )
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'The processing job reopening identity already belongs to retained history'
        );
      const attemptsBefore =
        transaction.get<{ highest: number }>(
          'SELECT coalesce(max(attempt_number),0) AS highest FROM processing_attempts WHERE job_id=?',
          jobId
        )?.highest ?? 0;
      const reopening: ProcessingJobReopening = {
        reopeningId,
        jobId,
        reopeningSequence: (latest?.reopeningSequence ?? 0) + 1,
        attemptsBefore,
        attemptsAllowed,
        gaveUp: job.result,
        grantId,
        reopenedAt,
        reopenedBy,
        reopenedByBasis: input.reopenedByBasis,
      };
      transaction.run(
        `INSERT INTO processing_job_reopenings (reopening_id,job_id,reopening_sequence,
          attempts_before,attempts_allowed,gave_up_json,grant_id,reopened_at,reopened_by,
          reopened_by_basis) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        reopening.reopeningId,
        reopening.jobId,
        reopening.reopeningSequence,
        reopening.attemptsBefore,
        reopening.attemptsAllowed,
        serializeDatabaseValue(reopening.gaveUp),
        reopening.grantId,
        reopening.reopenedAt,
        reopening.reopenedBy,
        reopening.reopenedByBasis
      );
      const changes = transaction.run(
        `UPDATE processing_jobs SET state='pending', wait_reason=NULL, retry_at=NULL,
          result_json=NULL, updated_at=? WHERE job_id=? AND state='terminal_failure'`,
        reopenedAt,
        jobId
      ).changes;
      if (changes !== 1)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing job changed while its reopening was being recorded'
        );
      return {
        outcome: 'reopened' as const,
        job: decodeProcessingJob({
          ...row,
          state: 'pending',
          waitReason: null,
          retryAt: null,
          resultJson: null,
          updatedAt: reopenedAt,
        }),
        reopening,
      };
    },
    options
  );
}

export interface RecordProcessingModelResume {
  jobId: string;
  resumedAt: string;
  resumedBy: string | null;
  resumedByBasis: ProcessingAttributionBasis;
  /** The workload consent grant the resume rests on. */
  grantId: string;
}

/**
 * Lift one job's no-model choice, without erasing that it was made. It is
 * recorded once: a second resume would leave no trace of the first, which the
 * schema refuses too.
 */
export async function recordProcessingModelResume(
  handle: ProjectDatabase,
  input: RecordProcessingModelResume,
  options: ProjectOperationOptions = {}
): Promise<ProcessingJob> {
  const jobId = processingRecordId(input.jobId, 'processing job');
  const resumedAt = processingInstant(input.resumedAt, 'the time the resume was recorded');
  const basis = input.resumedByBasis;
  if (!(ATTRIBUTION_BASES as readonly string[]).includes(basis))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Say how the person who authorized the resume is known'
    );
  const resumedBy =
    input.resumedBy === null || input.resumedBy === undefined
      ? null
      : processingText(input.resumedBy, 'who authorized the resume');
  if ((resumedBy === null) !== (basis === 'unknown'))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Only an unknown actor has no name, and a named actor says how the name is known'
    );
  const grantId = processingText(input.grantId, 'the consent grant');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.job.model-resume',
    (transaction) => {
      const row = transaction.get<ProcessingJobRow>(
        `SELECT ${PROCESSING_JOB_COLUMNS} FROM processing_jobs WHERE job_id=?`,
        jobId
      );
      if (!row)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'The processing job is missing; preserve history for explicit repair'
        );
      const job = decodeProcessingJob(row);
      if (!job.withoutModel)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'This processing job was admitted with a model; there is no no-model choice to lift'
        );
      if (job.modelResume)
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'A consented model resume is recorded once and is already retained for this job'
        );
      const changes = transaction.run(
        `UPDATE processing_jobs SET model_resumed_at=?, model_resumed_by=?, model_resumed_by_basis=?,
          model_resume_grant_id=?, updated_at=? WHERE job_id=? AND model_resumed_at IS NULL`,
        resumedAt,
        resumedBy,
        basis,
        grantId,
        resumedAt,
        jobId
      ).changes;
      if (changes !== 1)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing job changed while the model resume was being recorded'
        );
      return decodeProcessingJob({
        ...row,
        modelResumedAt: resumedAt,
        modelResumedBy: resumedBy,
        modelResumedByBasis: basis,
        modelResumeGrantId: grantId,
        updatedAt: resumedAt,
      });
    },
    options
  );
}
