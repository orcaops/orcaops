// What `knowledge status`, doctor and the enable flow ask the project database. Every reader here
// opens read-only, writes nothing, and starts no worker and no model call.
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { readInterpretationProgressFromView } from './knowledge-interpretation.js';
import {
  type ProcessingExtractionSummary,
  summarizeProcessingExtraction,
} from './processing-extraction.js';
import {
  decodeProcessingJob,
  PROCESSING_JOB_COLUMNS,
  type ProcessingJob,
  type ProcessingJobRow,
  type ProcessingJobState,
} from './processing-jobs.js';
import { processingBound, processingRecordId } from './processing-maintenance.js';
import {
  decodeProcessingAttempt,
  PROCESSING_ATTEMPT_COLUMNS,
  type ProcessingAttempt,
  type ProcessingAttemptRow,
} from './processing-schedule.js';
import type { DatabaseJson } from './values.js';
import { PROCESSING_ELIGIBLE_EVENT_TYPES } from '../../schema/knowledge-contract.js';

export interface ProcessingWaitGroup {
  waitReason: string;
  jobs: number;
  /** The earliest retry time in this group, or null when none is due to come. */
  nextRetryAt: string | null;
}

export interface ProcessingQueue {
  /** Current states of jobs whose admission was selected through the requested boundary. */
  jobs: Record<ProcessingJobState, number>;
  waiting: ProcessingWaitGroup[];
  /** Admitted jobs still open whose no-model choice has not been lifted. */
  awaitingModelResume: number;
  openAttempts: number;
  /**
   * The write sequence of the newest admitting operation, which is what a grant
   * covering new captures only is measured against. Null when nothing has been
   * admitted here.
   */
  latestAdmittedSequence: number | null;
  /** Live captured sources that should have a processing job. */
  eligibleSources: number;
  /** Eligible sources whose atomic capture settlement retained no job. */
  missingEligibleSources: number;
  /** The newest live source operation, excluding derived and unrelated writes. */
  latestEligibleSequence: number | null;
  /** Current verified extraction for a bounded sample of the selected source cohort. */
  extraction?: ProcessingExtractionSummary;
}

/**
 * The enable flow's view: how much is admitted and waiting, and the sequence a
 * from-now-on grant starts after. Shaped exactly as the flow's reader
 * interface, which is why these two fields keep its names.
 */
export interface ProcessingBacklog {
  paused_jobs: number;
  latest_admitted_sequence: number | null;
}

const OPEN_STATES = "('pending','running','retryable_failure')";
const INTERPRETATION_PROCESSOR_CONTRACT = 'knowledge-interpretation@2';

interface StateCountRow {
  state: string;
  jobs: number;
}

interface WaitRow {
  waitReason: string;
  jobs: number;
  nextRetryAt: string | null;
}

// The admitted sequence is the publishing operation's committed write sequence: admission moves no
// counter of its own, so the job carries the operation and the sequence is read back through it.
const BOUNDED_JOBS = `SELECT j.*, o.committed_write_sequence AS admitted_sequence FROM processing_jobs j
  JOIN operations o ON o.operation_id=j.admitting_operation_id
  WHERE o.committed_write_sequence<=?
    AND j.processor_contract='${INTERPRETATION_PROCESSOR_CONTRACT}'`;

const LATEST_SEQUENCE = `SELECT max(o.committed_write_sequence) AS sequence
  FROM processing_jobs j JOIN operations o ON o.operation_id=j.admitting_operation_id
  WHERE o.committed_write_sequence<=?
    AND j.processor_contract='${INTERPRETATION_PROCESSOR_CONTRACT}'`;

const eligibleTypes = PROCESSING_ELIGIBLE_EVENT_TYPES.map(() => '?').join(',');
const ELIGIBLE_SOURCES = `WITH eligible AS (
  SELECT e.event_id AS eventId, min(o.committed_write_sequence) AS sequence
  FROM artifact_events e
  JOIN execution_initializations x ON x.artifact_id=e.artifact_id AND x.origin_kind='captured'
  JOIN artifact_revisions r ON r.artifact_id=e.artifact_id AND r.event_count>=e.ordinal
  JOIN operations o ON o.operation_id=r.operation_id
  WHERE e.event_type IN (${eligibleTypes})
    AND o.operation_kind IN ('capture.append','plan.capture.append')
  GROUP BY e.event_id
)
SELECT count(*) AS sources,
  coalesce(sum(CASE WHEN jo.operation_id IS NULL THEN 1 ELSE 0 END),0) AS missing,
  max(eligible.sequence) AS latestSequence
FROM eligible
LEFT JOIN processing_jobs j ON j.source_kind='capture_event' AND j.source_id=eligible.eventId
  AND j.processor_contract='${INTERPRETATION_PROCESSOR_CONTRACT}'
LEFT JOIN operations jo ON jo.operation_id=j.admitting_operation_id
  AND jo.committed_write_sequence<=?
WHERE eligible.sequence<=?`;

function emptyStates(): Record<ProcessingJobState, number> {
  return { pending: 0, running: 0, completed: 0, retryable_failure: 0, terminal_failure: 0 };
}

function sequenceBoundary(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the processing queue boundary as a non-negative whole number'
    );
  return value as number;
}

export function readProcessingQueueAtBoundary(
  view: ProjectReadView,
  requestedBoundary: number
): ProcessingQueue {
  const boundary = sequenceBoundary(requestedBoundary);
  const jobs = emptyStates();
  for (const row of view.all<StateCountRow>(
    `SELECT state, count(*) AS jobs FROM (${BOUNDED_JOBS}) GROUP BY state`,
    boundary
  )) {
    if (!Object.hasOwn(jobs, row.state))
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A retained processing job has an unknown state'
      );
    jobs[row.state as ProcessingJobState] = row.jobs;
  }
  const waiting = view.all<WaitRow>(
    `SELECT wait_reason AS waitReason, count(*) AS jobs, min(retry_at) AS nextRetryAt
      FROM (${BOUNDED_JOBS}) WHERE wait_reason IS NOT NULL AND state IN ${OPEN_STATES}
      GROUP BY wait_reason ORDER BY wait_reason`,
    boundary
  );
  const blocked = view.get<{ jobs: number }>(
    `SELECT count(*) AS jobs FROM (${BOUNDED_JOBS}) AS bounded
      WHERE without_model=1 AND NOT EXISTS (
        SELECT 1 FROM processing_model_confirmations c WHERE c.job_id=bounded.job_id
      ) AND state IN ${OPEN_STATES}`,
    boundary
  );
  const openAttempts = view.get<{ attempts: number }>(
    `SELECT count(*) AS attempts FROM processing_attempts a
      JOIN (${BOUNDED_JOBS}) j ON j.job_id=a.job_id WHERE a.outcome IS NULL`,
    boundary
  );
  const latest = view.get<{ sequence: number | null }>(LATEST_SEQUENCE, boundary);
  const eligible = view.get<{
    sources: number;
    missing: number;
    latestSequence: number | null;
  }>(ELIGIBLE_SOURCES, ...PROCESSING_ELIGIBLE_EVENT_TYPES, boundary, boundary) ?? {
    sources: 0,
    missing: 0,
    latestSequence: null,
  };
  const sampled = view.all<{ jobId: string }>(
    `SELECT job_id AS jobId FROM (${BOUNDED_JOBS})
      ORDER BY admitted_sequence DESC, job_id LIMIT 25`,
    boundary
  );
  const extraction = summarizeProcessingExtraction(
    sampled.map(({ jobId }) => {
      try {
        return {
          jobId,
          progress: readInterpretationProgressFromView(view, jobId),
          unreadable: false,
        };
      } catch (error) {
        if (!(error instanceof ProjectDatabaseError)) throw error;
        return { jobId, progress: null, unreadable: true };
      }
    }),
    Object.values(jobs).reduce((sum, count) => sum + count, 0) - sampled.length
  );
  return {
    jobs,
    waiting: waiting.map((row) => ({ ...row })),
    awaitingModelResume: blocked?.jobs ?? 0,
    openAttempts: openAttempts?.attempts ?? 0,
    latestAdmittedSequence: latest?.sequence ?? null,
    eligibleSources: eligible.sources,
    missingEligibleSources: eligible.missing,
    latestEligibleSequence: eligible.latestSequence,
    extraction,
  };
}

export function readProcessingQueue(handle: ProjectDatabase): ProcessingQueue {
  assertProjectDatabasePath(handle);
  return handle.read((view) => readProcessingQueueAtBoundary(view, Number.MAX_SAFE_INTEGER)).value;
}

/**
 * Jobs admitted here that have not finished: what is held back while processing
 * is off, unconsented or paused. Storage cannot see consent, so it reports the
 * queue and the enable flow says why it is waiting.
 */
export function readProcessingBacklog(handle: ProjectDatabase): ProcessingBacklog {
  assertProjectDatabasePath(handle);
  return handle.read((view) => {
    const open = view.get<{ jobs: number }>(
      `SELECT count(*) AS jobs FROM processing_jobs WHERE state IN ${OPEN_STATES}`
    );
    const latest = view.get<{ sequence: number | null }>(LATEST_SEQUENCE, Number.MAX_SAFE_INTEGER);
    return {
      paused_jobs: open?.jobs ?? 0,
      latest_admitted_sequence: latest?.sequence ?? null,
    };
  }).value;
}

export function readProcessingJob(handle: ProjectDatabase, jobId: string): ProcessingJob | null {
  assertProjectDatabasePath(handle);
  return handle.read((view) => readProcessingJobFromView(view, jobId)).value;
}

export function readProcessingJobFromView(
  view: ProjectReadView,
  jobId: string
): ProcessingJob | null {
  const id = processingRecordId(jobId, 'processing job');
  const row = view.get<ProcessingJobRow>(
    `SELECT ${PROCESSING_JOB_COLUMNS} FROM processing_jobs WHERE job_id=?`,
    id
  );
  return row ? decodeProcessingJob(row) : null;
}

export interface GaveUpProcessingJob {
  job: ProcessingJob;
  /** What the job's last attempt settled with; a spent allowance names no reason of its own. */
  lastAttemptDetail: DatabaseJson;
}

export interface GaveUpProcessingJobs {
  total: number;
  /** The jobs that gave up most recently, newest first. */
  jobs: GaveUpProcessingJob[];
}

export function readGaveUpProcessingJobs(handle: ProjectDatabase, limit = 5): GaveUpProcessingJobs {
  const bound = processingBound(limit, 'the number of jobs that gave up to read');
  assertProjectDatabasePath(handle);
  return handle.read((view) => {
    const total =
      view.get<{ jobs: number }>(
        "SELECT count(*) AS jobs FROM processing_jobs WHERE state='terminal_failure'"
      )?.jobs ?? 0;
    const jobs = view
      .all<ProcessingJobRow>(
        `SELECT ${PROCESSING_JOB_COLUMNS} FROM processing_jobs WHERE state='terminal_failure'
          ORDER BY updated_at DESC, job_id DESC LIMIT ?`,
        bound
      )
      .map(decodeProcessingJob)
      .map((job) => {
        const last = view.get<{ detailJson: string | null }>(
          `SELECT detail_json AS detailJson FROM processing_attempts
            WHERE job_id=? ORDER BY attempt_number DESC LIMIT 1`,
          job.jobId
        );
        return {
          job,
          lastAttemptDetail:
            last?.detailJson == null ? null : (JSON.parse(last.detailJson) as DatabaseJson),
        };
      });
    return { total, jobs };
  }).value;
}

/** The newest attempts of one job, newest first. */
export function readProcessingJobAttempts(
  handle: ProjectDatabase,
  jobId: string,
  limit = 5
): ProcessingAttempt[] {
  const id = processingRecordId(jobId, 'processing job');
  const bound = processingBound(limit, 'the number of attempts to read');
  assertProjectDatabasePath(handle);
  return handle.read((view) =>
    view
      .all<ProcessingAttemptRow>(
        `SELECT ${PROCESSING_ATTEMPT_COLUMNS} FROM processing_attempts
          WHERE job_id=? ORDER BY attempt_number DESC LIMIT ?`,
        id,
        bound
      )
      .map(decodeProcessingAttempt)
  ).value;
}

export function readAllProcessingJobAttempts(
  handle: ProjectDatabase,
  jobId: string
): ProcessingAttempt[] {
  const id = processingRecordId(jobId, 'processing job');
  assertProjectDatabasePath(handle);
  return handle.read((view) =>
    view
      .all<ProcessingAttemptRow>(
        `SELECT ${PROCESSING_ATTEMPT_COLUMNS} FROM processing_attempts
          WHERE job_id=? ORDER BY attempt_number DESC`,
        id
      )
      .map(decodeProcessingAttempt)
  ).value;
}

export function readProcessingAttempt(
  handle: ProjectDatabase,
  attemptId: string
): ProcessingAttempt | null {
  assertProjectDatabasePath(handle);
  return handle.read((view) => readProcessingAttemptFromView(view, attemptId)).value;
}

export function readProcessingAttemptFromView(
  view: ProjectReadView,
  attemptId: string
): ProcessingAttempt | null {
  const id = processingRecordId(attemptId, 'processing attempt');
  const row = view.get<ProcessingAttemptRow>(
    `SELECT ${PROCESSING_ATTEMPT_COLUMNS} FROM processing_attempts WHERE attempt_id=?`,
    id
  );
  return row ? decodeProcessingAttempt(row) : null;
}
