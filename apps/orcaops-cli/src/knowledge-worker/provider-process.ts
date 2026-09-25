import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import type { PreparedInputProcess } from '@orcaops/llm';

/**
 * What an attempt retains about the provider it spawned, and how a recovering
 * owner stops it. The process group is recorded because the deadline the call
 * enforces holds only while the worker that made the call is alive: a worker
 * killed mid-call leaves a provider running and spending, and the owner that
 * takes the lease next must be able to end it before any replacement call.
 */

export const RetainedProviderProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    /** Null on a platform with no process groups; only the child is signalled there. */
    process_group_id: z.number().int().positive().nullable(),
    provider: z.string().min(1),
    spawned_at: z.iso.datetime(),
  })
  .strict();
export type RetainedProviderProcess = z.infer<typeof RetainedProviderProcessSchema>;

export function retainedProviderProcess(input: {
  process: PreparedInputProcess;
  provider: string;
  spawnedAt: string;
}): RetainedProviderProcess {
  return {
    pid: input.process.pid,
    process_group_id: input.process.processGroupId,
    provider: input.provider,
    spawned_at: input.spawnedAt,
  };
}

export type ProviderTerminationOutcome =
  /** Nothing was recorded, or what was recorded is not a process record. */
  | { outcome: 'nothing_recorded' }
  /**
   * Confirmed gone: the group no longer exists, or the pid now belongs to a
   * process that started after the attempt recorded it, which is the same
   * evidence — the provider that held the number has ended.
   */
  | { outcome: 'gone'; pid: number; signalled: boolean }
  /**
   * Still listed after the signals, or not ours to signal. The caller must keep
   * treating the call as possibly alive.
   */
  | { outcome: 'not_confirmed'; pid: number; detail: string };

const TERMINATION_POLL_MS = 25;

/** Only ESRCH proves a group is gone; EPERM means it exists and is not ours. */
function groupIsGone(target: number): boolean | 'not_ours' {
  try {
    process.kill(target, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    return 'not_ours';
  }
}

function signal(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the process now holding this pid predate the moment the attempt recorded
 * it? A pid is reused, and `kill(2)` carries no identity, so the only thing
 * that distinguishes the provider from whatever took its number afterwards is
 * when it started. `ps` is asked because there is no portable syscall for it;
 * it is best effort, and a reading that cannot be had is not evidence of
 * anything, so the caller must leave the process alone.
 *
 * `lstart` has one-second resolution, so a second of slack is allowed: a
 * process that started within a second of the record is taken to be the one
 * recorded, and one that started clearly later is not.
 */
function startedBefore(pid: number, spawnedAt: string): boolean | 'unknown' {
  let lstart: string;
  try {
    lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
  const started = Date.parse(lstart);
  if (lstart.length === 0 || Number.isNaN(started)) return 'unknown';
  return started <= Date.parse(spawnedAt) + 1_000;
}

/**
 * Terminate what a lost attempt recorded, and say whether it is provably gone.
 *
 * The exposure this guards against is pid reuse: a group id is only pinned
 * while its group is non-empty, so by the time a recovering owner reads one the
 * number may belong to something else entirely. Only ever terminating a group
 * that an unsettled attempt of THIS project recorded bounds WHEN a signal is
 * sent; it says nothing about WHOM it reaches. The recorded spawn time is what
 * narrows that: a process that started after the attempt recorded the pid is
 * not the provider, is left alone, and proves the provider is gone. When its
 * start time cannot be read while it is still running the check abstains and no
 * signal is sent. A process can still exit and have its pid reused between this
 * check and the signal.
 */
export async function terminateRetainedProviderProcess(
  retained: unknown,
  options: {
    graceMs?: number;
    confirmMs?: number;
    startedBefore?: (pid: number, spawnedAt: string) => boolean | 'unknown';
  } = {}
): Promise<ProviderTerminationOutcome> {
  const parsed = RetainedProviderProcessSchema.safeParse(retained);
  if (!parsed.success) return { outcome: 'nothing_recorded' };
  const { pid, process_group_id: group, spawned_at: spawnedAt } = parsed.data;
  // A negative pid signals the whole group; without one only the child can be
  // reached, and its descendants may survive.
  const target = group === null ? pid : -group;
  const initial = groupIsGone(target);
  if (initial === true) return { outcome: 'gone', pid, signalled: false };
  // A pid that now belongs to a process which started after this attempt
  // recorded it is not the provider: the provider released the number, so it
  // ended. That is positive evidence the call is over, and it is better than
  // the call lifetime the recovering owner would otherwise wait out — so it
  // reports the call gone, and signals nothing.
  const identity = (options.startedBefore ?? startedBefore)(pid, spawnedAt);
  if (identity === false) return { outcome: 'gone', pid, signalled: false };
  // A group outlives its leader, and survivors are what the group signal exists
  // to reach. Once the leader is gone its start time cannot be read, but its pid
  // cannot be handed out again while the group it led is still non-empty, so a
  // live group whose leader is gone is still the provider's. The residual is a
  // group that fully emptied and was re-formed by a new process on the same
  // pid which then exited too, leaving descendants.
  const leaderGone = group !== null && groupIsGone(pid) === true;
  if (identity === 'unknown' && leaderGone && groupIsGone(target) === true) {
    return { outcome: 'gone', pid, signalled: false };
  }
  if (identity === 'unknown' && !leaderGone) {
    return {
      outcome: 'not_confirmed',
      pid,
      detail: `The start time of provider process ${pid} could not be confirmed; no signal was sent.`,
    };
  }
  const graceMs = options.graceMs ?? 1_000;
  const confirmMs = options.confirmMs ?? 500;

  const signalled = signal(target, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  for (;;) {
    const state = groupIsGone(target);
    if (state === true) return { outcome: 'gone', pid, signalled };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_POLL_MS));
  }

  const killed = signal(target, 'SIGKILL');
  const confirmDeadline = Date.now() + confirmMs;
  for (;;) {
    const state = groupIsGone(target);
    if (state === true) return { outcome: 'gone', pid, signalled: signalled || killed };
    if (Date.now() >= confirmDeadline) {
      return {
        outcome: 'not_confirmed',
        pid,
        detail:
          state === 'not_ours'
            ? `The provider process group ${pid} exists and is not this user's to signal.`
            : `The provider process group ${pid} was still listed after SIGTERM and SIGKILL.`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_POLL_MS));
  }
}
