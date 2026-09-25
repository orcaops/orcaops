// Claiming, attempts, settlement and recovery. Every write here names the lease generation it acts
// under, so a superseded worker changes nothing. One job runs at a time per project database, and a
// job whose owner was lost stays unclaimable until the call's bounded lifetime has elapsed: a
// replacement paid call can never start while a lost one may still be running.
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  compareProcessingExecutionTerms,
  ProcessingAttemptPermissionSchema,
  readLatestProcessingModelConfirmation,
} from './processing-confirmations.js';
import { ProcessingDispatchContextSchema } from './processing-dispatch-context.js';
import {
  decodeProcessingJob,
  PROCESSING_JOB_COLUMNS,
  type ProcessingJob,
  type ProcessingJobRow,
} from './processing-jobs.js';
import { assertProcessingLeaseGeneration } from './processing-lease.js';
import {
  processingBound,
  processingGeneration,
  processingInstant,
  type ProcessingMaintenance,
  processingRecordId,
  processingText,
  runProcessingMaintenance,
} from './processing-maintenance.js';
import {
  approvedAttemptsSql,
  attemptsSinceReopeningSql,
  processingJobAllowance,
} from './processing-reopenings.js';
import {
  decideProcessingCall,
  holdProcessingCall,
  processingCallHold,
  type ProcessingCallLimits,
  type ProcessingUsageRecord,
  type ProcessingUsageWindows,
  settleReservation,
} from './processing-usage.js';
import type { ProjectOperationOptions } from './transactions.js';
import { type DatabaseJson, serializeDatabaseValue } from './values.js';

export type ProcessingAttemptOutcomeKind = 'succeeded' | 'failed' | 'unknown';

export interface ProcessingAttempt {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  ownerGeneration: number;
  configurationIdentity: string;
  configuration: DatabaseJson;
  /** The user-local workload consent grant this attempt runs under. */
  grantId: string;
  startedAt: string;
  outcome: ProcessingAttemptOutcomeKind | null;
  finishedAt: string | null;
  usage: DatabaseJson;
  detail: DatabaseJson;
  /** What was spawned for this call, recorded once after the spawn. */
  process: DatabaseJson;
  publishingOperationId: string | null;
}

export interface ProcessingAttemptRow {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  ownerGeneration: number;
  configurationSha256: string;
  configurationJson: string;
  grantId: string;
  startedAt: string;
  outcome: string | null;
  finishedAt: string | null;
  usageJson: string | null;
  detailJson: string | null;
  processJson: string | null;
  publishingOperationId: string | null;
}

export const PROCESSING_ATTEMPT_COLUMNS = `attempt_id AS attemptId, job_id AS jobId,
  attempt_number AS attemptNumber, owner_generation AS ownerGeneration,
  configuration_sha256 AS configurationSha256, configuration_json AS configurationJson,
  grant_id AS grantId, started_at AS startedAt, outcome, finished_at AS finishedAt,
  usage_json AS usageJson, detail_json AS detailJson, process_json AS processJson,
  publishing_operation_id AS publishingOperationId`;

export function decodeProcessingAttempt(row: ProcessingAttemptRow): ProcessingAttempt {
  if (row.outcome !== null && !['succeeded', 'failed', 'unknown'].includes(row.outcome))
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A retained processing attempt has an unknown outcome'
    );
  return {
    attemptId: row.attemptId,
    jobId: row.jobId,
    attemptNumber: row.attemptNumber,
    ownerGeneration: row.ownerGeneration,
    configurationIdentity: row.configurationSha256,
    configuration: JSON.parse(row.configurationJson) as DatabaseJson,
    grantId: row.grantId,
    startedAt: row.startedAt,
    outcome: row.outcome as ProcessingAttemptOutcomeKind | null,
    finishedAt: row.finishedAt,
    usage: row.usageJson === null ? null : (JSON.parse(row.usageJson) as DatabaseJson),
    detail: row.detailJson === null ? null : (JSON.parse(row.detailJson) as DatabaseJson),
    process: row.processJson === null ? null : (JSON.parse(row.processJson) as DatabaseJson),
    publishingOperationId: row.publishingOperationId,
  };
}

function readJob(transaction: ProcessingMaintenance, jobId: string): ProcessingJob {
  const row = transaction.get<ProcessingJobRow>(
    `SELECT ${PROCESSING_JOB_COLUMNS} FROM processing_jobs WHERE job_id=?`,
    jobId
  );
  if (!row)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The processing job is missing; preserve history for explicit repair'
    );
  return decodeProcessingJob(row);
}

export type ProcessingIdleReason =
  /** The project-wide pause is on, so nothing is claimable at all. */
  | 'paused'
  /** A job is already running here; one call at a time per project database. */
  | 'call_in_flight'
  /** Nothing is admitted that has not finished. */
  | 'queue_empty'
  /** Every open job keeps an invocation's no-model choice and has no recorded resume. */
  | 'awaiting_model_resume'
  /** Open jobs are waiting on a retry time or a recorded wait reason. */
  | 'waiting';

export type ProcessingClaim =
  | { outcome: 'claimed'; job: ProcessingJob }
  | {
      outcome: 'nothing_claimable';
      reason: ProcessingIdleReason;
      openJobs: number;
      nextRetryAt: string | null;
      nextRetry: { jobId: string; retryAt: string; waitReason: string | null } | null;
    };

export interface ClaimProcessingJob {
  generation: number;
  now: string;
}

interface OpenJobCounts {
  open: number;
  blockedWithoutModel: number;
  nextRetryAt: string | null;
}

/**
 * Take the next eligible job: pending with nothing parking it, or a retryable
 * failure whose retry time has come. A running job, the project pause, an
 * unlifted no-model choice and a recorded wait each hold work back, and the
 * caller is told which one did.
 */
export async function claimProcessingJob(
  handle: ProjectDatabase,
  input: ClaimProcessingJob,
  options: ProjectOperationOptions = {}
): Promise<ProcessingClaim> {
  const generation = processingGeneration(input.generation, 'the lease generation');
  const now = processingInstant(input.now, 'the current time');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.job.claim',
    (transaction) => {
      assertProcessingLeaseGeneration(transaction, generation);
      const counts = transaction.get<OpenJobCounts>(
        `SELECT
          count(*) AS open,
          coalesce(sum(CASE WHEN without_model=1 AND NOT EXISTS (
            SELECT 1 FROM processing_model_confirmations c WHERE c.job_id=processing_jobs.job_id
          ) THEN 1 ELSE 0 END),0) AS blockedWithoutModel,
          min(CASE WHEN state='retryable_failure' AND retry_at IS NOT NULL THEN retry_at END) AS nextRetryAt
          FROM processing_jobs WHERE state IN ('pending','running','retryable_failure')`
      ) ?? { open: 0, blockedWithoutModel: 0, nextRetryAt: null };
      const idle = (reason: ProcessingIdleReason) => {
        const nextRetry = transaction.get<{
          jobId: string;
          retryAt: string;
          waitReason: string | null;
        }>(
          `SELECT job_id AS jobId, retry_at AS retryAt, wait_reason AS waitReason
            FROM processing_jobs
            WHERE state='retryable_failure' AND retry_at IS NOT NULL
              AND (without_model=0 OR EXISTS (
                SELECT 1 FROM processing_model_confirmations c WHERE c.job_id=processing_jobs.job_id
              ))
              AND ${attemptsSinceReopeningSql('processing_jobs.job_id')}
                < min(
                  coalesce((
                    SELECT json_extract(a.configuration_json, '$.permission.execution_terms.max_attempts')
                    FROM processing_attempts a WHERE a.job_id=processing_jobs.job_id
                    ORDER BY a.attempt_number DESC LIMIT 1
                  ), 1),
                  coalesce(${approvedAttemptsSql('processing_jobs.job_id')}, 9007199254740991)
                )
            ORDER BY retry_at, admitted_at, job_id LIMIT 1`
        );
        return {
          outcome: 'nothing_claimable' as const,
          reason,
          openJobs: counts.open,
          nextRetryAt: counts.nextRetryAt,
          nextRetry: nextRetry ?? null,
        };
      };
      const paused = transaction.get<{ paused: number }>(
        'SELECT paused FROM processing_control WHERE singleton=1'
      );
      if (paused?.paused === 1) return idle('paused');
      if (transaction.get("SELECT job_id FROM processing_jobs WHERE state='running' LIMIT 1"))
        return idle('call_in_flight');
      if (counts.open === 0) return idle('queue_empty');
      const next = transaction.get<ProcessingJobRow>(
        `SELECT ${PROCESSING_JOB_COLUMNS} FROM processing_jobs
          WHERE (without_model=0 OR EXISTS (
            SELECT 1 FROM processing_model_confirmations c WHERE c.job_id=processing_jobs.job_id
          ))
            AND ((state='pending' AND wait_reason IS NULL)
              OR (state='retryable_failure' AND retry_at IS NOT NULL AND retry_at<=?))
          ORDER BY admitted_at, job_id LIMIT 1`,
        now
      );
      if (!next)
        return idle(
          counts.blockedWithoutModel === counts.open ? 'awaiting_model_resume' : 'waiting'
        );
      const changes = transaction.run(
        `UPDATE processing_jobs SET state='running', claimed_generation=?, wait_reason=NULL, retry_at=NULL, updated_at=?
          WHERE job_id=? AND state=?`,
        generation,
        now,
        next.jobId,
        next.state
      ).changes;
      if (changes !== 1)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing job changed while it was being claimed; claim again'
        );
      return { outcome: 'claimed' as const, job: readJob(transaction, next.jobId) };
    },
    options
  );
}

export interface ParkProcessingJob {
  generation: number;
  jobId: string;
  /**
   * Why it is held back, in the worker's own vocabulary; null returns the job
   * to the queue with nothing holding it. A wait reason with no retry time
   * parks a job until something else moves it, which is what a refusal that no
   * clock can resolve needs.
   */
  waitReason: string | null;
  now: string;
}

/**
 * Give a claimed job back without attempting it. A dispatch this owner refused
 * before constructing a provider is not a failed attempt: it writes no attempt
 * row, spends none of the job's allowance and holds no reservation, so the job
 * keeps everything it had and the worker can go on to the next one instead of
 * the whole queue stopping behind it.
 *
 * Refused when the job is not running under this generation, or when it has an
 * unsettled attempt: a job whose paid call may still be in flight is freed by
 * recovery, never by parking.
 */
export async function parkProcessingJob(
  handle: ProjectDatabase,
  input: ParkProcessingJob,
  options: ProjectOperationOptions = {}
): Promise<ProcessingJob> {
  const generation = processingGeneration(input.generation, 'the lease generation');
  const jobId = processingRecordId(input.jobId, 'processing job');
  const now = processingInstant(input.now, 'the current time');
  const waitReason =
    input.waitReason === null || input.waitReason === undefined
      ? null
      : processingText(input.waitReason, 'the wait reason');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.job.park',
    (transaction) => {
      assertProcessingLeaseGeneration(transaction, generation);
      const job = readJob(transaction, jobId);
      if (job.state !== 'running' || job.claimedGeneration !== generation)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'This owner does not hold the processing job; claim it before parking it'
        );
      if (
        transaction.get(
          'SELECT attempt_id FROM processing_attempts WHERE job_id=? AND outcome IS NULL',
          jobId
        )
      )
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing job has an unsettled attempt; recovery frees a lost call, not parking'
        );
      const changes = transaction.run(
        `UPDATE processing_jobs SET state='pending', wait_reason=?, retry_at=NULL,
          claimed_generation=NULL, updated_at=? WHERE job_id=? AND state='running'`,
        waitReason,
        now,
        jobId
      ).changes;
      if (changes !== 1)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing job changed while it was being parked'
        );
      return readJob(transaction, jobId);
    },
    options
  );
}

export interface UnparkProcessingJobs {
  generation: number;
  /** Only jobs parked with one of these reasons are made claimable again. */
  waitReasons: readonly string[];
  now: string;
}

/**
 * Free every pending job parked with one of these reasons. The worker uses it
 * once per run for the refusals that a change outside the job can resolve — a
 * worktree re-enabled, a grant recorded — so work resumes on the next wake-up
 * without an operator's retry. A reason no change outside the job can resolve
 * is never passed here; only `retryProcessingJob` frees one of those.
 *
 * `retry_at` is left as it is: a pending job is held by its reason alone.
 */
export async function unparkProcessingJobs(
  handle: ProjectDatabase,
  input: UnparkProcessingJobs,
  options: ProjectOperationOptions = {}
): Promise<ProcessingJob[]> {
  const generation = processingGeneration(input.generation, 'the lease generation');
  const now = processingInstant(input.now, 'the current time');
  if (!Array.isArray(input.waitReasons))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Name the wait reasons to free, as an array');
  const reasons = input.waitReasons.map((reason) => processingText(reason, 'the wait reason'));
  assertProjectDatabasePath(handle);
  if (reasons.length === 0) return [];
  return runProcessingMaintenance(
    handle,
    'processing.job.unpark',
    (transaction) => {
      assertProcessingLeaseGeneration(transaction, generation);
      const placeholders = reasons.map(() => '?').join(',');
      const parked = transaction.all<{ jobId: string }>(
        `SELECT job_id AS jobId FROM processing_jobs
          WHERE state='pending' AND wait_reason IN (${placeholders})
          ORDER BY admitted_at, job_id`,
        ...reasons
      );
      const freed: ProcessingJob[] = [];
      for (const { jobId } of parked) {
        transaction.run(
          `UPDATE processing_jobs SET wait_reason=NULL, updated_at=?
            WHERE job_id=? AND state='pending'`,
          now,
          jobId
        );
        freed.push(readJob(transaction, jobId));
      }
      return freed;
    },
    options
  );
}

interface ProcessingAttemptRecord {
  generation: number;
  jobId: string;
  attemptId: string;
  startedAt: string;
  /** From configuration; a retry never resets what earlier attempts have used. */
  maxAttempts: number;
  /** The SHA-256 the effective configuration resolves to, carrying no credentials. */
  configurationIdentity: string;
  configuration: DatabaseJson;
  /** Latest confirmation for an original no-model job; null for other jobs. */
  confirmationId: string | null;
  /** The user-local workload consent grant this attempt runs under. */
  grantId: string;
}

export interface StartProcessingCallAttempt extends ProcessingAttemptRecord, ProcessingCallLimits {
  /** The hold this attempt's call takes against both windows. */
  usageId: string;
}

/**
 * An attempt whose work is decided without asking the provider anything. It
 * takes no hold, because the windows count calls: a job that will make none
 * must not take an hour's slot from a job that will. Limits are optional here
 * and nothing is held against them, but a caller that names them is judged on
 * them exactly as a reserving attempt is: a configuration that can never admit
 * a call pauses the workload, and which attempt found that does not change it.
 */
export interface StartProcessingAttemptWithoutCall
  extends ProcessingAttemptRecord, Partial<ProcessingCallLimits> {
  usageId: null;
}

export type StartProcessingAttempt = StartProcessingCallAttempt | StartProcessingAttemptWithoutCall;

export type ProcessingAttemptStart =
  | {
      outcome: 'started';
      attempt: ProcessingAttempt;
      usage: ProcessingUsageRecord;
      windows: ProcessingUsageWindows;
    }
  /** Started with no reservation: this attempt makes no call and spends nothing. */
  | { outcome: 'started_without_call'; attempt: ProcessingAttempt }
  /** The job is finished in the same transaction: an exhausted job never runs again. */
  | {
      outcome: 'attempts_exhausted';
      attempts: number;
      maxAttempts: number;
      job: ProcessingJob;
    }
  /** Nothing was attempted and no allowance was spent; the job waits for the window. */
  | {
      outcome: 'refused';
      limit: 'calls_per_hour' | 'cost_per_day';
      windows: ProcessingUsageWindows;
      freesUpAt: string;
      job: ProcessingJob;
    };

// The allowance can only be judged once the job is claimed, so spending it has to finish the job
// here: leaving it running would hold the whole queue with nothing left that could attempt it.
function settleExhaustedJob(
  transaction: ProcessingMaintenance,
  jobId: string,
  at: string,
  attempts: number,
  maxAttempts: number
): ProcessingJob {
  const changes = transaction.run(
    `UPDATE processing_jobs SET state='terminal_failure', wait_reason=NULL, retry_at=NULL,
      claimed_generation=NULL, result_json=?, updated_at=? WHERE job_id=? AND state='running'`,
    serializeDatabaseValue({
      outcome: 'attempts_exhausted',
      attempts,
      max_attempts: maxAttempts,
    }),
    at,
    jobId
  ).changes;
  if (changes !== 1)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The processing job changed while its spent allowance was being recorded'
    );
  return readJob(transaction, jobId);
}

export interface SettleExhaustedProcessingJob {
  generation: number;
  jobId: string;
  maxAttempts: number;
  at: string;
}

export async function settleExhaustedProcessingJob(
  handle: ProjectDatabase,
  input: SettleExhaustedProcessingJob,
  options: ProjectOperationOptions = {}
): Promise<Extract<ProcessingAttemptStart, { outcome: 'attempts_exhausted' }>> {
  const generation = processingGeneration(input.generation, 'the lease generation');
  const jobId = processingRecordId(input.jobId, 'processing job');
  const maxAttempts = processingBound(input.maxAttempts, 'the attempt allowance');
  const at = processingInstant(input.at, 'the settlement time');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.job.exhaust',
    (transaction) => {
      assertProcessingLeaseGeneration(transaction, generation);
      const job = readJob(transaction, jobId);
      if (job.state !== 'running' || job.claimedGeneration !== generation)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'This owner does not hold the processing job; claim it before finishing it'
        );
      if (
        transaction.get(
          'SELECT attempt_id FROM processing_attempts WHERE job_id=? AND outcome IS NULL',
          jobId
        )
      )
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing job has an unsettled attempt; recovery decides it first'
        );
      const allowance = processingJobAllowance(transaction, jobId, maxAttempts);
      if (allowance.attemptsMade < allowance.attemptsAllowed)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          `The processing job has ${allowance.attemptsMade} of ${allowance.attemptsAllowed} attempt(s); its allowance is not spent`
        );
      return {
        outcome: 'attempts_exhausted' as const,
        attempts: allowance.attemptsMade,
        maxAttempts: allowance.attemptsAllowed,
        job: settleExhaustedJob(
          transaction,
          jobId,
          at,
          allowance.attemptsMade,
          allowance.attemptsAllowed
        ),
      };
    },
    options
  );
}

// A job the windows refuse must not keep the one running slot while it waits, so the refusal
// parks it with the window it is waiting on and the moment that window changes.
function parkRefusedJob(
  transaction: ProcessingMaintenance,
  jobId: string,
  at: string,
  limit: 'calls_per_hour' | 'cost_per_day',
  freesUpAt: string
): ProcessingJob {
  const changes = transaction.run(
    `UPDATE processing_jobs SET state='retryable_failure', wait_reason=?, retry_at=?,
      claimed_generation=NULL, updated_at=? WHERE job_id=? AND state='running'`,
    limit,
    freesUpAt,
    at,
    jobId
  ).changes;
  if (changes !== 1)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The processing job changed while its refused call was being recorded'
    );
  return readJob(transaction, jobId);
}

/**
 * Begin an attempt on a job this owner is running and hold its call against
 * both windows, in one transaction: an attempt exists before any paid call is
 * spawned, and a window that refuses writes no attempt at all, so a refusal
 * never spends one of the job's attempts. The attempt numbers itself from the
 * attempts already retained, so a repeat can never be mistaken for a later one.
 * The allowance counts every attempt since the job was last reopened, and a
 * reopening's approved allowance caps the configured one.
 *
 * An attempt started with no reservation makes no call: it spends an attempt of
 * the job's allowance, which is what bounds it, and nothing of the windows,
 * which count calls.
 */
export async function startProcessingAttempt(
  handle: ProjectDatabase,
  input: StartProcessingAttempt,
  options: ProjectOperationOptions = {}
): Promise<ProcessingAttemptStart> {
  const generation = processingGeneration(input.generation, 'the lease generation');
  const jobId = processingRecordId(input.jobId, 'processing job');
  const attemptId = processingRecordId(input.attemptId, 'processing attempt');
  const usageId =
    input.usageId === null ? null : processingRecordId(input.usageId, 'processing reservation');
  const startedAt = processingInstant(input.startedAt, 'the attempt start time');
  const maxAttempts = processingBound(input.maxAttempts, 'the attempt allowance');
  // A no-call attempt holds nothing, but limits it names are judged all the same: a limit that can
  // never admit a call is a configuration §6 pauses the workload over, whatever this attempt does.
  if (input.usageId === null && input.maxCallsPerHour !== undefined)
    processingCallHold({ ...input, maxCallsPerHour: input.maxCallsPerHour });
  const hold = input.usageId === null ? null : processingCallHold(input);
  const configurationIdentity = input.configurationIdentity;
  if (typeof configurationIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(configurationIdentity))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the effective configuration identity as its SHA-256'
    );
  const configurationJson = serializeDatabaseValue(input.configuration ?? null);
  const grantId = processingText(input.grantId, 'the consent grant');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.attempt.start',
    (transaction) => {
      assertProcessingLeaseGeneration(transaction, generation);
      const job = readJob(transaction, jobId);
      if (job.state !== 'running' || job.claimedGeneration !== generation)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'This owner does not hold the processing job; claim it before starting an attempt'
        );
      if (
        transaction.get(
          'SELECT attempt_id FROM processing_attempts WHERE job_id=? AND outcome IS NULL',
          jobId
        )
      )
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'An unsettled attempt is settled before its processing job is attempted again'
        );
      const configuration =
        input.configuration !== null &&
        typeof input.configuration === 'object' &&
        !Array.isArray(input.configuration)
          ? input.configuration
          : null;
      const permission = ProcessingAttemptPermissionSchema.safeParse(configuration?.permission);
      if (!permission.success || permission.data.attempt_grant_id !== grantId)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'The attempt must retain one valid permission snapshot naming its exact grant'
        );
      if (permission.data.execution_terms.job_id !== jobId)
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'The attempt permission snapshot belongs to another job'
        );
      const execution = permission.data.execution_terms;
      const admission =
        job.admission !== null && typeof job.admission === 'object' && !Array.isArray(job.admission)
          ? (job.admission as Record<string, unknown>)
          : null;
      const context = ProcessingDispatchContextSchema.safeParse(admission?.context);
      if (!context.success)
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The processing job has no valid retained dispatch origin'
        );
      const sourceMatches =
        execution.source.kind === job.source.kind &&
        (execution.source.kind === 'capture_event'
          ? execution.source.event_id ===
            (job.source.kind === 'capture_event' ? job.source.event_id : null)
          : execution.source.source_id ===
            (job.source.kind === 'knowledge_source' ? job.source.source_id : null));
      if (
        execution.project_id !== handle.authority.projectId ||
        execution.origin.worktree_root !== context.data.origin.worktree_root ||
        !sourceMatches ||
        execution.processor_contract !== job.processorContract
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'The attempt permission snapshot does not bind this project, origin, source and processor contract'
        );
      if (execution.max_attempts !== maxAttempts)
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'The attempt allowance differs from the immutable execution terms'
        );
      if (input.usageId !== null) {
        const daily = execution.limits.max_cost_usd_per_day;
        const perCall = execution.limits.max_cost_usd_per_call;
        const inputDaily = input.maxCostUsdPerDay ?? null;
        const inputReservation = input.reservationUsd ?? null;
        const termsDaily = daily === 'none' ? null : daily;
        const termsReservation = daily === 'none' || perCall === 'none' ? null : perCall.usd;
        if (
          input.maxCallsPerHour !== execution.limits.max_calls_per_hour ||
          inputDaily !== termsDaily ||
          inputReservation !== termsReservation
        )
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            'The reserved call limits differ from the immutable execution terms'
          );
      }
      if (job.withoutModel) {
        if (input.confirmationId === null)
          throw new ProjectDatabaseError(
            'STALE_CONTEXT',
            'This job was admitted without a model and needs its latest confirmation'
          );
        const confirmationId = processingRecordId(
          input.confirmationId,
          'processing model confirmation'
        );
        const latest = readLatestProcessingModelConfirmation(transaction, jobId);
        if (
          latest === null ||
          latest.confirmationId !== confirmationId ||
          permission.data.confirmation_id !== confirmationId ||
          serializeDatabaseValue(permission.data.confirmed_terms) !==
            serializeDatabaseValue(latest.terms)
        )
          throw new ProjectDatabaseError(
            'STALE_CONTEXT',
            'The attempt does not carry the latest confirmation shown for this job'
          );
        const fit = compareProcessingExecutionTerms({
          frozen: latest.terms,
          current: execution,
          phase: 'dispatch',
        });
        if (!fit.ok)
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            `The attempt execution terms exceed its confirmation: ${fit.changed.join(', ')}`
          );
      } else if (
        input.confirmationId !== null ||
        permission.data.confirmation_id !== null ||
        permission.data.confirmed_terms !== null
      ) {
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'A job originally admitted with a model does not use a model-resume confirmation'
        );
      }
      if (
        transaction.get('SELECT attempt_id FROM processing_attempts WHERE attempt_id=?', attemptId)
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'The processing attempt identity already belongs to retained history'
        );
      const highest =
        transaction.get<{ highest: number }>(
          'SELECT coalesce(max(attempt_number),0) AS highest FROM processing_attempts WHERE job_id=?',
          jobId
        )?.highest ?? 0;
      const allowance = processingJobAllowance(transaction, jobId, maxAttempts);
      if (allowance.attemptsMade >= allowance.attemptsAllowed)
        return {
          outcome: 'attempts_exhausted' as const,
          attempts: allowance.attemptsMade,
          maxAttempts: allowance.attemptsAllowed,
          job: settleExhaustedJob(
            transaction,
            jobId,
            startedAt,
            allowance.attemptsMade,
            allowance.attemptsAllowed
          ),
        };
      const decision = hold === null ? null : decideProcessingCall(transaction, hold, startedAt);
      if (decision?.outcome === 'refused')
        return {
          outcome: 'refused' as const,
          limit: decision.limit,
          windows: decision.windows,
          freesUpAt: decision.freesUpAt,
          job: parkRefusedJob(transaction, jobId, startedAt, decision.limit, decision.freesUpAt),
        };
      const attemptNumber = highest + 1;
      transaction.run(
        `INSERT INTO processing_attempts (attempt_id,job_id,attempt_number,owner_generation,
          configuration_sha256,configuration_json,grant_id,started_at,outcome,finished_at,
          usage_json,detail_json,process_json,publishing_operation_id)
          VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL)`,
        attemptId,
        jobId,
        attemptNumber,
        generation,
        configurationIdentity,
        configurationJson,
        grantId,
        startedAt
      );
      transaction.run('UPDATE processing_jobs SET updated_at=? WHERE job_id=?', startedAt, jobId);
      const attempt = decodeProcessingAttempt({
        attemptId,
        jobId,
        attemptNumber,
        ownerGeneration: generation,
        configurationSha256: configurationIdentity,
        configurationJson,
        grantId,
        startedAt,
        outcome: null,
        finishedAt: null,
        usageJson: null,
        detailJson: null,
        processJson: null,
        publishingOperationId: null,
      });
      if (hold === null || usageId === null)
        return { outcome: 'started_without_call' as const, attempt };
      const held = holdProcessingCall(transaction, hold, {
        usageId,
        attemptId,
        reservedAt: startedAt,
      });
      return {
        outcome: 'started' as const,
        usage: held.usage,
        windows: held.windows,
        attempt,
      };
    },
    options
  );
}

export interface RecordProcessingAttemptProcess {
  generation: number;
  attemptId: string;
  /** What was spawned: at least enough to terminate it, such as its process group. */
  process: DatabaseJson;
}

/**
 * Record what this attempt spawned, once, while the attempt is still open. The
 * attempt row exists before the call is spawned so no paid call is ever
 * unrecorded, and the process is only known afterwards, which is why this is
 * its own write rather than a fact fixed at insert. A recovering owner reads it
 * back with the lost attempt and terminates the process before any replacement
 * call.
 */
export async function recordProcessingAttemptProcess(
  handle: ProjectDatabase,
  input: RecordProcessingAttemptProcess,
  options: ProjectOperationOptions = {}
): Promise<ProcessingAttempt> {
  const generation = processingGeneration(input.generation, 'the lease generation');
  const attemptId = processingRecordId(input.attemptId, 'processing attempt');
  if (input.process === null || input.process === undefined)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Record what the call spawned; an absent process record is not a recorded one'
    );
  const processJson = serializeDatabaseValue(input.process);
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.attempt.process',
    (transaction) => {
      assertProcessingLeaseGeneration(transaction, generation);
      const row = transaction.get<ProcessingAttemptRow>(
        `SELECT ${PROCESSING_ATTEMPT_COLUMNS} FROM processing_attempts WHERE attempt_id=?`,
        attemptId
      );
      if (!row)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'The processing attempt is missing; preserve history for explicit repair'
        );
      if (row.ownerGeneration !== generation)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing attempt belongs to an earlier owner; only its own owner records what it spawned'
        );
      if (row.outcome !== null)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing attempt has already settled; a settled attempt is retained as it ended'
        );
      if (row.processJson !== null)
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'This processing attempt already records what it spawned'
        );
      const changes = transaction.run(
        'UPDATE processing_attempts SET process_json=? WHERE attempt_id=? AND process_json IS NULL AND outcome IS NULL',
        processJson,
        attemptId
      ).changes;
      if (changes !== 1)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing attempt changed while its provider process was being recorded'
        );
      return decodeProcessingAttempt({ ...row, processJson });
    },
    options
  );
}

export type ProcessingOutcome =
  | {
      kind: 'succeeded';
      /** The operation that published what the attempt derived, when one did. */
      publishingOperationId: string | null;
      result: DatabaseJson;
      detail?: DatabaseJson;
    }
  /** A retry time is required: a job parked with none is a job nothing can move. */
  | { kind: 'retryable_failure'; waitReason: string; retryAt: string; detail?: DatabaseJson }
  | { kind: 'terminal_failure'; result: DatabaseJson; detail?: DatabaseJson }
  | { kind: 'unknown'; waitReason: string; retryAt: string; detail?: DatabaseJson };

export interface SettleProcessingAttempt {
  generation: number;
  jobId: string;
  attemptId: string;
  finishedAt: string;
  /** What the provider reported, or null when it reported nothing. Never zero. */
  usage: DatabaseJson;
  outcome: ProcessingOutcome;
}

export interface ProcessingSettlement {
  job: ProcessingJob;
  attempt: ProcessingAttempt;
}

interface SettlementWrite {
  attemptOutcome: ProcessingAttemptOutcomeKind;
  jobState: 'completed' | 'retryable_failure' | 'terminal_failure';
  waitReason: string | null;
  retryAt: string | null;
  resultJson: string | null;
  publishingOperationId: string | null;
}

function plannedSettlement(outcome: ProcessingOutcome): SettlementWrite {
  if (outcome.kind === 'succeeded')
    return {
      attemptOutcome: 'succeeded',
      jobState: 'completed',
      waitReason: null,
      retryAt: null,
      resultJson: serializeDatabaseValue(outcome.result ?? null),
      publishingOperationId:
        outcome.publishingOperationId === null || outcome.publishingOperationId === undefined
          ? null
          : processingRecordId(outcome.publishingOperationId, 'publishing operation'),
    };
  if (outcome.kind === 'terminal_failure')
    return {
      attemptOutcome: 'failed',
      jobState: 'terminal_failure',
      waitReason: null,
      retryAt: null,
      resultJson: serializeDatabaseValue(outcome.result ?? null),
      publishingOperationId: null,
    };
  if (outcome.kind === 'retryable_failure' || outcome.kind === 'unknown')
    return {
      attemptOutcome: outcome.kind === 'unknown' ? 'unknown' : 'failed',
      jobState: 'retryable_failure',
      waitReason: processingText(outcome.waitReason, 'the wait reason'),
      retryAt: processingInstant(outcome.retryAt, 'the retry time'),
      resultJson: null,
      publishingOperationId: null,
    };
  throw new ProjectDatabaseError(
    'INVALID_INPUT',
    'Settle a processing attempt as succeeded, a retryable failure, a terminal failure or unknown'
  );
}

function writeSettlement(
  transaction: ProcessingMaintenance,
  jobId: string,
  attemptId: string,
  finishedAt: string,
  usageJson: string | null,
  detailJson: string | null,
  planned: SettlementWrite,
  pendingPublishingOperationId: string | null = null
): ProcessingSettlement {
  if (
    planned.publishingOperationId !== null &&
    planned.publishingOperationId !== pendingPublishingOperationId
  ) {
    // A settlement writes no receipt of its own, so the operation it names must already stand.
    if (
      !transaction.get(
        'SELECT o.operation_id FROM operations o WHERE o.operation_id=?',
        planned.publishingOperationId
      )
    )
      throw new ProjectDatabaseError(
        'HISTORY_MISSING',
        'The operation that published this result is missing; preserve history for explicit repair'
      );
  }
  const attemptChanges = transaction.run(
    `UPDATE processing_attempts SET outcome=?, finished_at=?, usage_json=?, detail_json=?, publishing_operation_id=?
      WHERE attempt_id=? AND outcome IS NULL`,
    planned.attemptOutcome,
    finishedAt,
    usageJson,
    detailJson,
    planned.publishingOperationId,
    attemptId
  ).changes;
  if (attemptChanges !== 1)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The processing attempt settled while this settlement was being written'
    );
  const jobChanges =
    planned.resultJson === null
      ? transaction.run(
          `UPDATE processing_jobs SET state=?, wait_reason=?, retry_at=?, claimed_generation=NULL, updated_at=?
            WHERE job_id=?`,
          planned.jobState,
          planned.waitReason,
          planned.retryAt,
          finishedAt,
          jobId
        ).changes
      : transaction.run(
          `UPDATE processing_jobs SET state=?, wait_reason=?, retry_at=?, claimed_generation=NULL, result_json=?, updated_at=?
            WHERE job_id=?`,
          planned.jobState,
          planned.waitReason,
          planned.retryAt,
          planned.resultJson,
          finishedAt,
          jobId
        ).changes;
  if (jobChanges !== 1)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The processing job changed while its attempt was being settled'
    );
  const attempt = transaction.get<ProcessingAttemptRow>(
    `SELECT ${PROCESSING_ATTEMPT_COLUMNS} FROM processing_attempts WHERE attempt_id=?`,
    attemptId
  );
  if (!attempt)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The settled processing attempt disappeared; preserve history for explicit repair'
    );
  return { job: readJob(transaction, jobId), attempt: decodeProcessingAttempt(attempt) };
}

export function settleProcessingAttemptInTransaction(
  transaction: ProcessingMaintenance,
  input: SettleProcessingAttempt,
  pendingPublishingOperationId: string | null = null
): ProcessingSettlement {
  const generation = processingGeneration(input.generation, 'the lease generation');
  const jobId = processingRecordId(input.jobId, 'processing job');
  const attemptId = processingRecordId(input.attemptId, 'processing attempt');
  const finishedAt = processingInstant(input.finishedAt, 'the settlement time');
  const planned = {
    ...plannedSettlement(input.outcome),
    ...(pendingPublishingOperationId === null
      ? {}
      : {
          publishingOperationId: processingRecordId(
            pendingPublishingOperationId,
            'publishing operation'
          ),
        }),
  };
  const usageJson = input.usage === null ? null : serializeDatabaseValue(input.usage);
  const detail = input.outcome.detail;
  const detailJson =
    detail === undefined || detail === null ? null : serializeDatabaseValue(detail);
  assertProcessingLeaseGeneration(transaction, generation);
  const attempt = transaction.get<ProcessingAttemptRow>(
    `SELECT ${PROCESSING_ATTEMPT_COLUMNS} FROM processing_attempts WHERE attempt_id=?`,
    attemptId
  );
  if (!attempt)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The processing attempt is missing; preserve history for explicit repair'
    );
  if (attempt.jobId !== jobId)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The processing attempt belongs to a different job'
    );
  if (attempt.outcome !== null)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The processing attempt has already settled; a settled attempt is retained as it ended'
    );
  if (attempt.ownerGeneration !== generation)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The processing attempt was started by an earlier owner; recovery settles what a lost owner left'
    );
  const job = readJob(transaction, jobId);
  if (job.state !== 'running' || job.claimedGeneration !== generation)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'This owner does not hold the processing job; recovery settles what a lost owner left'
    );
  const reserved = transaction.get<{ usageId: string }>(
    `SELECT usage_id AS usageId FROM processing_usage
      WHERE attempt_id=? AND state='reserved' ORDER BY usage_id LIMIT 1`,
    attemptId
  );
  if (reserved)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      `The call this attempt reserved is still held as reservation ${reserved.usageId}; settle the call before the attempt`
    );
  return writeSettlement(
    transaction,
    jobId,
    attemptId,
    finishedAt,
    usageJson,
    detailJson,
    planned,
    pendingPublishingOperationId
  );
}

/** Settle an attempt and its job together, under the generation that started it. */
export async function settleProcessingAttempt(
  handle: ProjectDatabase,
  input: SettleProcessingAttempt,
  options: ProjectOperationOptions = {}
): Promise<ProcessingSettlement> {
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.attempt.settle',
    (transaction) => settleProcessingAttemptInTransaction(transaction, input),
    options
  );
}

export interface RecoverProcessingAttempts {
  generation: number;
  now: string;
  /** How long a provider call may still be alive after it started. */
  callLifetimeMs: number;
  waitReason: string;
  /** Required: a recovered job parked with no retry time is one nothing can move. */
  retryAt: string;
  /**
   * Attempts whose provider process this owner has OBSERVED to be gone. The
   * lifetime is a bound on when a call may still be running; an observation
   * that it is not beats the bound, so these settle now instead of holding the
   * project's single running slot for the rest of it. Only the owner that
   * confirmed the termination may name one.
   */
  confirmedGone?: readonly string[];
}

export interface ProcessingRecovery {
  settled: ProcessingSettlement[];
  /**
   * Attempts whose call may still be running; their jobs stay unclaimable. The
   * process record comes with each one, so a recovering owner can terminate
   * what a lost one spawned instead of waiting the lifetime out blind.
   */
  waiting: {
    attemptId: string;
    jobId: string;
    eligibleAt: string;
    process: DatabaseJson;
  }[];
  /** Jobs a lost owner claimed and never attempted, returned to the queue. */
  reclaimed: ProcessingJob[];
}

/**
 * Settle what a lost owner left behind, as unknown, once the call's bounded
 * lifetime has elapsed since it started — or as soon as the recovering owner
 * has watched its provider process go, which is better evidence than the bound
 * and releases the project's single running slot without waiting the rest of it
 * out. Its reservations are kept in full,
 * because an unknown result is not a free one. A job a lost owner claimed and
 * never attempted is returned to the queue instead: it holds the one running
 * slot, so leaving it would stop the whole project's queue and no paid call was
 * ever made for it.
 */
export async function recoverProcessingAttempts(
  handle: ProjectDatabase,
  input: RecoverProcessingAttempts,
  options: ProjectOperationOptions = {}
): Promise<ProcessingRecovery> {
  const generation = processingGeneration(input.generation, 'the lease generation');
  const now = processingInstant(input.now, 'the current time');
  const callLifetimeMs = processingBound(input.callLifetimeMs, "the call's bounded lifetime");
  const waitReason = processingText(input.waitReason, 'the wait reason');
  const retryAt = processingInstant(input.retryAt, 'the retry time');
  const confirmedGone = new Set(
    (input.confirmedGone ?? []).map((attemptId) =>
      processingRecordId(attemptId, 'a confirmed-gone processing attempt')
    )
  );
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.attempt.recover',
    (transaction) => {
      const lease = assertProcessingLeaseGeneration(transaction, generation);
      const open = transaction.all<ProcessingAttemptRow>(
        `SELECT ${PROCESSING_ATTEMPT_COLUMNS} FROM processing_attempts
          WHERE outcome IS NULL AND owner_generation<>? ORDER BY started_at, attempt_id`,
        generation
      );
      // A lost owner's clock may have run either way, and a recorded start alone would believe both.
      // The lease this owner took is a moment it observed itself, and the call cannot have started
      // after it, so a start later than the lease is read as the lease. A start earlier than one
      // whole lifetime before the lease is no credible reading either: it would make a call that
      // may have begun moments ago eligible at once, and buy a replacement paid call for it. Such a
      // start is read as the lease too, so the wait is the full lifetime from the moment this owner
      // observed.
      const taken = Date.parse(lease.acquiredAt!);
      const credible = (startedAt: string) => {
        const started = Date.parse(startedAt);
        return started > taken || started < taken - callLifetimeMs ? taken : started;
      };
      const recovery: ProcessingRecovery = { settled: [], waiting: [], reclaimed: [] };
      for (const attempt of open) {
        const eligibleAt = new Date(credible(attempt.startedAt) + callLifetimeMs).toISOString();
        if (Date.parse(now) < Date.parse(eligibleAt) && !confirmedGone.has(attempt.attemptId)) {
          recovery.waiting.push({
            attemptId: attempt.attemptId,
            jobId: attempt.jobId,
            eligibleAt,
            process:
              attempt.processJson === null
                ? null
                : (JSON.parse(attempt.processJson) as DatabaseJson),
          });
          continue;
        }
        for (const reservation of transaction.all<{ usageId: string }>(
          "SELECT usage_id AS usageId FROM processing_usage WHERE attempt_id=? AND state='reserved'",
          attempt.attemptId
        ))
          settleReservation(transaction, reservation.usageId, now, { kind: 'unknown' });
        recovery.settled.push(
          writeSettlement(
            transaction,
            attempt.jobId,
            attempt.attemptId,
            now,
            null,
            serializeDatabaseValue({
              recovered_from_generation: attempt.ownerGeneration,
              recovered_under_generation: generation,
              call_lifetime_ms: callLifetimeMs,
            }),
            {
              attemptOutcome: 'unknown',
              jobState: 'retryable_failure',
              waitReason,
              retryAt,
              resultJson: null,
              publishingOperationId: null,
            }
          )
        );
      }
      // An attempt still inside its call's lifetime keeps its job running, so the NOT EXISTS here
      // is what stops a lost call being replaced while it may still be spending.
      for (const abandoned of transaction.all<{ jobId: string }>(
        `SELECT job_id AS jobId FROM processing_jobs j
          WHERE j.state='running' AND j.claimed_generation<>?
            AND NOT EXISTS (SELECT 1 FROM processing_attempts a WHERE a.job_id=j.job_id AND a.outcome IS NULL)
          ORDER BY j.admitted_at, j.job_id`,
        generation
      )) {
        const changes = transaction.run(
          `UPDATE processing_jobs SET state='pending', claimed_generation=NULL, wait_reason=NULL,
            retry_at=NULL, updated_at=? WHERE job_id=? AND state='running'`,
          now,
          abandoned.jobId
        ).changes;
        if (changes !== 1)
          throw new ProjectDatabaseError(
            'STALE_CONTEXT',
            'The abandoned processing claim changed while it was being returned to the queue'
          );
        recovery.reclaimed.push(readJob(transaction, abandoned.jobId));
      }
      return recovery;
    },
    options
  );
}
