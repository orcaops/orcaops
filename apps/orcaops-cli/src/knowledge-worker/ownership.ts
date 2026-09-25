import { randomBytes } from 'node:crypto';

/**
 * How ownership of the single worker lease is named and timed. A pid is not an
 * identity: the operating system reuses one, and a new process that happened to
 * take a dead worker's pid would read as that worker. The owner id therefore
 * carries the moment this process started and a random token as well, so two
 * owner ids are equal only when they are the same run of the same process.
 */

/**
 * These three are the protocol between one worker and the next, not settings of
 * the workload: a worktree that could shorten the lease term would decide how
 * long another worktree's worker may hold the project, and one that could
 * lengthen the call lifetime would decide how long everyone waits after a
 * crash. §6's configuration keys are enumerated and none of them is here.
 */
export const LEASE_HEARTBEAT_MS = 5_000;

/**
 * The term a lease is taken and renewed for: four heartbeats, so a worker that
 * misses one renewal still holds it, and a worker that stopped renewing has
 * expired before another may take it.
 */
export const LEASE_TERM_MS = LEASE_HEARTBEAT_MS * 4;

/**
 * The longest a provider call may still be alive after the owner that started
 * it was lost, and therefore how long recovery waits before settling it. It is
 * the largest `timeout_ms` configuration accepts plus room for termination,
 * because the lost attempt's own timeout cannot be read back and a shorter wait
 * on another worktree's longer deadline would start a second paid call while
 * the first was still running.
 */
export const CALL_LIFETIME_MS = 3_600_000 + 60_000;

export function mintWorkerOwnerId(now: number = Date.now()): string {
  const startedAt = Math.round(now - process.uptime() * 1000);
  return `pid-${process.pid}.start-${startedAt}.${randomBytes(8).toString('hex')}`;
}
