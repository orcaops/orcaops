import type { ProcessingJob, ProjectDatabaseAuthority } from '@orcaops/storage/history/database';

import { startProcessingWorker } from '../knowledge-worker/start.js';

/**
 * The one place a committed change reaches the worker. It starts one, detached,
 * and does not wait for it: provider discovery, model invocation and worker
 * startup are never on the capture success path.
 *
 * Everything here runs after its caller has committed, so it can never fail
 * one: every answer is a returned value, including an answer it could not
 * compute, and nothing throws or awaits.
 *
 * Two starts against one project are safe by themselves: the second loses the
 * lease race and exits saying so.
 */
export type ProcessingWakeUp =
  | { signalled: false; reason: 'nothing_admitted' }
  /** The capture's own checkout has the workload switched off, so nothing runs. */
  | { signalled: false; reason: 'processing_off' }
  /** `jobs` is what this act admitted, or null when it freed work instead. */
  | { signalled: true; jobs: number | null; pid: number | null; log_path: string | null }
  /** The starter declined; `detail` is its own word for why. */
  | { signalled: false; reason: 'not_started'; jobs: number | null; detail: string }
  | { signalled: false; reason: 'wake_up_failed'; message: string };

export interface ProcessingWakeUpTarget {
  /** The checkout the capture was made in. */
  repoRoot: string;
  /** The project database the admitted jobs belong to. */
  authority: ProjectDatabaseAuthority;
}

export interface CaptureWakeUpTarget extends ProcessingWakeUpTarget {
  /**
   * `knowledge_processing.enabled` in the configuration that governs the
   * checkout this capture was made in. Admission is unconditional, so nothing
   * is lost while the workload is off; starting a worker for it would be a
   * process that can only exit again.
   */
  enabled: boolean;
}

/** After a capture: start a worker only when that capture admitted something. */
export function wakeProcessingWorker(
  admitted: readonly Pick<ProcessingJob, 'jobId'>[],
  target: CaptureWakeUpTarget
): ProcessingWakeUp {
  let jobs: number;
  try {
    jobs = admitted.length;
  } catch (cause) {
    return failed(cause);
  }
  if (jobs === 0) return { signalled: false, reason: 'nothing_admitted' };
  if (!target.enabled) return { signalled: false, reason: 'processing_off' };
  return start(target, jobs);
}

/**
 * After an operator freed work — a resume, a retry, an enablement — where there
 * is a queue to look at but nothing newly admitted.
 */
export function wakeProcessingWorkerForQueue(target: ProcessingWakeUpTarget): ProcessingWakeUp {
  return start(target, null);
}

function start(target: ProcessingWakeUpTarget, jobs: number | null): ProcessingWakeUp {
  try {
    const started = startProcessingWorker({
      repoRoot: target.repoRoot,
      authority: target.authority,
    });
    return started.started
      ? { signalled: true, jobs, pid: started.pid, log_path: started.logPath }
      : { signalled: false, reason: 'not_started', jobs, detail: started.detail };
  } catch (cause) {
    return failed(cause);
  }
}

function failed(cause: unknown): ProcessingWakeUp {
  return {
    signalled: false,
    reason: 'wake_up_failed',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

/** One sentence about what a wake-up did, for a command that reports it. */
export function describeWakeUp(woken: ProcessingWakeUp | null): string {
  if (woken === null) return 'No background worker was started.';
  if (woken.signalled) return 'A background worker was started; it processes what is due.';
  if (woken.reason === 'nothing_admitted') return 'Nothing was admitted, so no worker was started.';
  if (woken.reason === 'processing_off')
    return (
      'Knowledge processing is off here, so no worker was started; what was admitted waits ' +
      'until it is turned on.'
    );
  if (woken.reason === 'not_started') return woken.detail;
  return `No background worker was started: ${woken.message}`;
}
