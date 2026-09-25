import {
  type ProcessingJob,
  type ProcessingRetry,
  readLatestProcessingModelConfirmation,
  readProcessingJob,
  readProcessingQueue,
  retryProcessingJob,
} from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { withProcessingWriter } from '../../lib/knowledge-processing-queue.js';
import {
  describeWakeUp,
  type ProcessingWakeUp,
  wakeProcessingWorkerForQueue,
} from '../../lib/knowledge-processing-wakeup.js';

export interface KnowledgeRetryOptions {
  job?: string;
  json?: boolean;
}

interface RetriedJob {
  job_id: string;
  /**
   * `held` is this command's own: the job keeps an invocation's no-model choice
   * that no resume has lifted, so nothing a retry does could make it claimable.
   */
  outcome: ProcessingRetry['outcome'] | 'held';
  /** The job's state, so a finished job that gave up can be told from one that completed. */
  state: ProcessingJob['state'];
  wait_reason: string | null;
  retry_at: string | null;
}

/**
 * `orcaops knowledge retry [<job>]` — make a parked job, or every parked job,
 * claimable now. It resets no attempt allowance and reopens no finished job:
 * a completed job or one that gave up is reported as finished and left alone,
 * and a job that gave up is pointed at `knowledge reopen`.
 */
export async function knowledgeRetryAction(opts: KnowledgeRetryOptions = {}): Promise<void> {
  const json = opts.json === true;
  try {
    const selected = (opts.job ?? '').trim();
    const written = await withProcessingWriter({}, async (handle) => {
      if (selected !== '' && readProcessingJob(handle, selected) === null)
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `No processing job with id "${selected}" is admitted in this project.`,
          'job'
        );
      const jobIds =
        selected === ''
          ? handle
              .read((view) =>
                view.all<{ jobId: string }>(
                  // Only an open job can be made due; a finished one is not reopened by a retry,
                  // one with a call in flight is freed by recovery, not by a retry, and
                  // one still held by an invocation's no-model choice is freed by the
                  // explicit resume alone.
                  `SELECT job_id AS jobId FROM processing_jobs
                    WHERE state IN ('pending','retryable_failure')
                      AND (wait_reason IS NOT NULL OR retry_at IS NOT NULL)
                      AND (without_model=0 OR EXISTS (
                        SELECT 1 FROM processing_model_confirmations c
                          WHERE c.job_id=processing_jobs.job_id
                      ))
                    ORDER BY admitted_at, job_id`
                )
              )
              .value.map((row) => row.jobId)
          : [selected];
      const retried: RetriedJob[] = [];
      for (const jobId of jobIds) {
        const job = readProcessingJob(handle, jobId);
        const confirmation =
          job === null
            ? null
            : handle.read((view) => readLatestProcessingModelConfirmation(view, job.jobId)).value;
        if (job !== null && job.withoutModel && confirmation === null) {
          retried.push({
            job_id: jobId,
            outcome: 'held',
            state: job.state,
            wait_reason: job.waitReason,
            retry_at: job.retryAt,
          });
          continue;
        }
        const result = await retryProcessingJob(handle, { jobId, now: new Date().toISOString() });
        retried.push({
          job_id: result.job.jobId,
          outcome: result.outcome,
          state: result.job.state,
          wait_reason: result.job.waitReason,
          retry_at: result.job.retryAt,
        });
      }
      return { retried, queue: readProcessingQueue(handle) };
    });
    if (!written.ok)
      throw new OrcaopsError(
        written.problem.code === 'no_history'
          ? ErrorCodes.INVALID_INPUT
          : ErrorCodes.RECOVERY_REQUIRED,
        `No processing job can be retried here: ${written.problem.message}`
      );
    const { retried, queue } = written.value;
    // Making a job due is exactly the moment a worker has something to do, and
    // the wake-up never throws, so nothing here can fail the retry.
    const woken =
      written.target === null || retried.every((job) => job.outcome !== 'due')
        ? null
        : wakeProcessingWorkerForQueue(written.target);
    if (json) {
      emitOk({ retried, queue, wake_up: woken });
      return;
    }
    writeTerminalSafeStdout(describe(retried, woken));
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function describe(retried: readonly RetriedJob[], woken: ProcessingWakeUp | null): string {
  if (retried.length === 0)
    return 'No admitted processing job is waiting on anything, so nothing was made due.\n';
  const due = retried.filter((job) => job.outcome === 'due');
  const lines = [
    due.length === 1
      ? '1 processing job is due now.'
      : `${due.length} processing job(s) are due now.`,
  ];
  for (const job of retried.filter((entry) => entry.outcome !== 'due')) {
    if (job.outcome === 'held') {
      lines.push(
        `  ${job.job_id}: captured with no model, and no retry lifts that. Run ` +
          `\`orcaops knowledge resume --model ${job.job_id}\` at a terminal to allow one.`
      );
      continue;
    }
    lines.push(
      job.outcome === 'running'
        ? `  ${job.job_id}: a call is in flight; recovery, not a retry, frees a lost one.`
        : job.state === 'terminal_failure'
          ? `  ${job.job_id}: gave up. A retry never resets an allowance; ` +
            `\`orcaops knowledge reopen ${job.job_id}\` can, at a terminal.`
          : `  ${job.job_id}: completed. A completed job is never run again.`
    );
  }
  lines.push('No attempt allowance was reset.', describeWakeUp(woken));
  return `${lines.join('\n')}\n`;
}
