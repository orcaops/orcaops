// A job that gave up takes no further attempt until a person reopens it. The reopening is kept as
// recorded, and the allowance it approved bounds every attempt after it: configuration can lower
// that allowance but never raise it. Every place an allowance is judged reads it from here.
import type { ProjectDatabase, ProjectReadView } from './connection.js';
import type { ProcessingAttributionBasis } from './processing-jobs.js';
import { processingBound, processingRecordId } from './processing-maintenance.js';
import type { DatabaseJson } from './values.js';

export interface ProcessingJobReopening {
  reopeningId: string;
  jobId: string;
  reopeningSequence: number;
  /** The job's highest attempt number when it was reopened; only later attempts count. */
  attemptsBefore: number;
  attemptsAllowed: number;
  /** The result the job gave up with, cleared from the job by the reopening. */
  gaveUp: DatabaseJson;
  grantId: string;
  reopenedAt: string;
  reopenedBy: string | null;
  reopenedByBasis: ProcessingAttributionBasis;
}

export interface ProcessingJobReopeningRow {
  reopeningId: string;
  jobId: string;
  reopeningSequence: number;
  attemptsBefore: number;
  attemptsAllowed: number;
  gaveUpJson: string;
  grantId: string;
  reopenedAt: string;
  reopenedBy: string | null;
  reopenedByBasis: string;
}

export const PROCESSING_JOB_REOPENING_COLUMNS = `reopening_id AS reopeningId, job_id AS jobId,
  reopening_sequence AS reopeningSequence, attempts_before AS attemptsBefore,
  attempts_allowed AS attemptsAllowed, gave_up_json AS gaveUpJson, grant_id AS grantId,
  reopened_at AS reopenedAt, reopened_by AS reopenedBy, reopened_by_basis AS reopenedByBasis`;

export function decodeProcessingJobReopening(
  row: ProcessingJobReopeningRow
): ProcessingJobReopening {
  return {
    reopeningId: row.reopeningId,
    jobId: row.jobId,
    reopeningSequence: row.reopeningSequence,
    attemptsBefore: row.attemptsBefore,
    attemptsAllowed: row.attemptsAllowed,
    gaveUp: JSON.parse(row.gaveUpJson) as DatabaseJson,
    grantId: row.grantId,
    reopenedAt: row.reopenedAt,
    reopenedBy: row.reopenedBy,
    reopenedByBasis: row.reopenedByBasis as ProcessingAttributionBasis,
  };
}

export function readLatestProcessingJobReopening(
  view: ProjectReadView,
  jobId: string
): ProcessingJobReopening | null {
  const id = processingRecordId(jobId, 'processing job');
  const row = view.get<ProcessingJobReopeningRow>(
    `SELECT ${PROCESSING_JOB_REOPENING_COLUMNS} FROM processing_job_reopenings
      WHERE job_id=? ORDER BY reopening_sequence DESC LIMIT 1`,
    id
  );
  return row ? decodeProcessingJobReopening(row) : null;
}

export function readProcessingJobReopenings(
  view: ProjectReadView,
  jobId: string
): ProcessingJobReopening[] {
  const id = processingRecordId(jobId, 'processing job');
  return view
    .all<ProcessingJobReopeningRow>(
      `SELECT ${PROCESSING_JOB_REOPENING_COLUMNS} FROM processing_job_reopenings
        WHERE job_id=? ORDER BY reopening_sequence`,
      id
    )
    .map(decodeProcessingJobReopening);
}

export interface ProcessingJobAllowance {
  /** Attempts made since the job was last reopened, or ever when it never was. */
  attemptsMade: number;
  attemptsAllowed: number;
}

export function processingJobAllowance(
  view: ProjectReadView,
  jobId: string,
  configuredMaxAttempts: number
): ProcessingJobAllowance {
  const id = processingRecordId(jobId, 'processing job');
  const configured = processingBound(configuredMaxAttempts, 'the attempt allowance');
  const reopening = readLatestProcessingJobReopening(view, id);
  const attemptsMade =
    view.get<{ attempts: number }>(
      'SELECT count(*) AS attempts FROM processing_attempts WHERE job_id=? AND attempt_number>?',
      id,
      reopening?.attemptsBefore ?? 0
    )?.attempts ?? 0;
  return {
    attemptsMade,
    attemptsAllowed:
      reopening === null ? configured : Math.min(configured, reopening.attemptsAllowed),
  };
}

export function readProcessingJobAllowance(
  handle: ProjectDatabase,
  jobId: string,
  configuredMaxAttempts: number
): ProcessingJobAllowance {
  return handle.read((view) => processingJobAllowance(view, jobId, configuredMaxAttempts)).value;
}

/**
 * The claim query judges allowances in SQL. These are the same rule as
 * {@link processingJobAllowance}, reading the same row, the latest reopening by
 * sequence, for a job named by `job`.
 */
const latestReopeningSql = (job: string, column: 'attempts_before' | 'attempts_allowed') =>
  `(SELECT r.${column} FROM processing_job_reopenings r WHERE r.job_id=${job} ORDER BY r.reopening_sequence DESC LIMIT 1)`;

export const attemptsSinceReopeningSql = (job: string) =>
  `(SELECT count(*) FROM processing_attempts a WHERE a.job_id=${job} AND a.attempt_number > coalesce(${latestReopeningSql(job, 'attempts_before')}, 0))`;

export const approvedAttemptsSql = (job: string) => latestReopeningSql(job, 'attempts_allowed');
