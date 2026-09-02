import { mkdir, rmdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

import { assertResolvedWithin, assertSafePathSegment } from './paths/containment.js';

/**
 * Per-artifact filesystem lock primitive.
 *
 * Contract:
 *   - Atomic `mkdir` under `<locksDir>/<artifact-id>.lock`.
 *   - 10s acquire timeout, 10ms retry interval, 120s stale-removal threshold.
 *   - Wraps writes, never long-running work.
 *   - Single-arg over the work unit (no `op_class`).
 *
 * Atomicity comes from `mkdir(2)` itself: POSIX guarantees the directory
 * either gets created (caller acquires) or fails with `EEXIST` (caller
 * retries). No `flock`/`fcntl` lock-file handle to leak, no race window
 * between "check if exists" and "create."
 *
 * Stale cleanup: if the existing lockdir is older than `staleThresholdMs`
 * (default 120s — calibrated for the write critical section, not for
 * long-running work like LLM evaluator runs, which the architecture
 * explicitly forbids holding the lock across), the holder is presumed
 * dead and the lockdir is reaped before retrying.
 *
 * Release is owner-safe: acquire records the created lockdir's identity
 * (inode + birthtime) and release removes the dir only when that identity
 * still matches, so a reaped-then-overstaying holder cannot delete the lock
 * a successor re-created at the same path. NOTHING here removes a lockdir
 * without an identity match: a failed identity stat surfaces the error and
 * leaves the path alone (a stranded fresh dir self-heals via stale-reap),
 * and an acquire suspended past the stale threshold between mkdir and stat
 * fails rather than trust an identity a reaper may have replaced. The
 * lockdir deliberately stays an EMPTY directory — release compatibility with
 * any process still running the plain-rmdir release depends on it (rmdir
 * fails ENOTEMPTY otherwise).
 *
 * Known limits, threshold-gated and narrowed rather than eliminated: on
 * filesystems that do not track directory birthtime the identity degrades to
 * inode-only, and immediate inode reuse could in principle make a
 * successor's dir compare equal; release's stat→rmdir pair and the
 * stale-reap's recheck→rmdir pair are each non-atomic, and the gap between
 * the two calls is unbounded under adverse scheduling (a suspended process
 * can carry a stale observation across a release + fresh re-creation and
 * delete the fresh dir on resume, after which the new acquirer records a
 * later dir's identity). Reaching any of these requires a full staleness
 * threshold to have elapsed first; closing them entirely needs a different
 * locking design than mkdir(2).
 */

/** Acquire-time identity of the lockdir we created; consumed by release. */
interface LockIdentity {
  ino: number;
  birthtimeMs: number;
}

export const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRY_INTERVAL_MS = 10;
export const DEFAULT_STALE_THRESHOLD_MS = 120_000;

export interface ArtifactLockOptions {
  /**
   * Directory holding `<artifact-id>.lock` mkdir-locks. Conventionally
   * `<repoRoot>/.orcaops/tmp/locks`. Created lazily on first acquire.
   */
  locksDir: string;
  /** Root that must contain repository-local lock operations. */
  containmentRoot?: string;
  /** Max time spent retrying mkdir before giving up. Default 10s. */
  acquireTimeoutMs?: number;
  /** Backoff between retries while acquiring. Default 10ms. */
  retryIntervalMs?: number;
  /** Age past which an existing lockdir is treated as orphaned. Default 120s. */
  staleThresholdMs?: number;
  /**
   * Refresh the owned lockdir's mtime at this interval while the callback is
   * running. Long read-side critical sections opt in so a live holder cannot
   * be mistaken for an orphan. Disabled by default.
   */
  heartbeatIntervalMs?: number;
}

export interface ResolvedArtifactLockOptions {
  locksDir: string;
  acquireTimeoutMs: number;
  retryIntervalMs: number;
  staleThresholdMs: number;
  heartbeatIntervalMs: number | null;
}

export class ArtifactLockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT';
  constructor(
    public readonly artifactId: string,
    public readonly waitedMs: number,
    public readonly staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS
  ) {
    super(
      `Could not acquire artifact lock for "${artifactId}" within ${waitedMs}ms; ` +
        `another writer holds it or the stale-removal threshold has not yet elapsed. ` +
        `An abandoned lock is reaped once it is ${staleThresholdMs}ms old, so a crashed ` +
        `holder clears on its own — retry after ${Math.ceil(staleThresholdMs / 1000)}s.`
    );
    this.name = 'ArtifactLockTimeoutError';
  }
}

export interface ArtifactLockLease {
  /**
   * Re-verify ownership of the lockdir. Resolves (and refreshes the lease
   * mtime) while this holder still owns it; throws
   * `ArtifactLockLeaseLostError` once it has been reaped or replaced.
   */
  assert(): Promise<void>;
  /**
   * Ownership check WITHOUT the mtime refresh. Acquire normalizes the
   * lockdir to whole-millisecond stamps before recording the identity
   * (macOS lowers st_birthtime to an earlier ms-truncated mtime), so both
   * verify() and assert() are safe in the acquisition millisecond; verify
   * remains the cheaper choice when no staleness refresh is needed.
   */
  verify(): Promise<void>;
}

export class ArtifactLockLeaseLostError extends Error {
  readonly code = 'LOCK_LEASE_LOST';
  constructor(public readonly artifactId: string) {
    super(`Artifact lock lease for "${artifactId}" was lost while the operation was running.`);
    this.name = 'ArtifactLockLeaseLostError';
  }
}

/**
 * Record a confirmed lease loss on the error a caller will actually see.
 *
 * Precedence is deliberate and unchanged: the operation error remains the
 * thrown value, with its class, `code`, and message intact, so every
 * `instanceof` and envelope mapping keeps working. This only stops the
 * lease loss from being dropped on the floor when both fail together.
 * An existing `cause` is never overwritten — the closer failure wins.
 */
export function attachLeaseLossCause(primary: unknown, leaseLoss: unknown): void {
  if (!(leaseLoss instanceof ArtifactLockLeaseLostError)) return;
  if (!(primary instanceof Error)) return;
  if (primary.cause !== undefined) return;
  // Disclosure is best-effort; precedence is not. A frozen or sealed error
  // must be left exactly as thrown — a plain assignment would raise a
  // TypeError out of the lock and REPLACE the operation error the caller is
  // entitled to, which is the one outcome this whole change promises cannot
  // happen.
  if (!Object.isExtensible(primary)) return;
  try {
    Object.defineProperty(primary, 'cause', {
      value: leaseLoss,
      writable: true,
      configurable: true,
      // Matches what `new Error(msg, { cause })` defines. Plain assignment
      // would create an ENUMERABLE property, so any future `{ ...err }` or
      // `JSON.stringify(err)` downstream would sweep the lease-loss detail
      // into a serialized payload that never carried it before.
      enumerable: false,
    });
  } catch {
    // A non-configurable or accessor-only `cause` — keep the thrown error intact.
  }
}

export class ArtifactLock {
  readonly options: ResolvedArtifactLockOptions;
  private readonly containmentRoot?: string;

  constructor(opts: ArtifactLockOptions) {
    this.containmentRoot = opts.containmentRoot;
    this.options = {
      locksDir: this.resolvePath(opts.locksDir, 'artifact locks directory'),
      acquireTimeoutMs: opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
      retryIntervalMs: opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
      staleThresholdMs: opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? null,
    };
    if (
      this.options.heartbeatIntervalMs !== null &&
      (!Number.isFinite(this.options.heartbeatIntervalMs) ||
        this.options.heartbeatIntervalMs <= 0 ||
        this.options.heartbeatIntervalMs >= this.options.staleThresholdMs)
    ) {
      throw new RangeError('heartbeatIntervalMs must be positive and less than staleThresholdMs');
    }
  }

  /**
   * Run `fn` under the per-artifact lock. Throws `ArtifactLockTimeoutError`
   * if the lock cannot be acquired within `acquireTimeoutMs`. Errors from
   * `fn` propagate; the lock is still released first.
   *
   * `fn` receives a lease handle whose `assert()` re-verifies ownership on
   * demand (throwing `ArtifactLockLeaseLostError` if the lockdir was reaped
   * and re-created). Long operations call it before a destructive step the
   * heartbeat alone cannot protect: the heartbeat detects a lost lease but
   * does NOT interrupt the running callback.
   */
  async withLock<T>(artifactId: string, fn: (lease: ArtifactLockLease) => Promise<T>): Promise<T> {
    const owner = await this.acquire(artifactId);
    const lease: ArtifactLockLease = {
      assert: () => this.renewLease(artifactId, owner),
      verify: () => this.verifyLease(artifactId, owner),
    };
    const heartbeat = this.startHeartbeat(artifactId, owner);
    let result: T | undefined;
    let operationError: unknown;
    let operationFailed = false;
    try {
      result = await fn(lease);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    const heartbeatResult = await heartbeat.stop();
    let releaseError: unknown;
    let releaseFailed = false;
    try {
      await this.release(artifactId, owner);
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (operationFailed) {
      // The operation error stays primary: it names what the caller was
      // actually doing, and a lease loss does not repair it. But a
      // CONFIRMED lease loss in the same window is a concurrency
      // violation the caller cannot otherwise learn about, so it rides
      // along as the cause rather than being discarded.
      if (heartbeatResult.failed) attachLeaseLossCause(operationError, heartbeatResult.error);
      throw operationError;
    }
    if (heartbeatResult.failed) throw heartbeatResult.error;
    if (releaseFailed) throw releaseError;
    return result as T;
  }

  /** Path to the lockdir for a given artifact. Exposed for tests + diagnostics. */
  lockPathFor(artifactId: string): string {
    assertSafePathSegment(artifactId, 'artifact lock id');
    return this.resolvePath(
      path.join(this.options.locksDir, `${artifactId}.lock`),
      'artifact lock path'
    );
  }

  private resolvePath(target: string, label: string): string {
    return this.containmentRoot === undefined
      ? target
      : assertResolvedWithin(target, this.containmentRoot, label, { rejectSymlinks: true });
  }

  /**
   * Owner-safe release. The lockdir at this path may no longer be OURS: a
   * holder that overstayed `staleThresholdMs` can be reaped by a competing
   * acquirer, which then re-creates the lockdir and rightfully owns it. An
   * unconditional rmdir here would delete that successor's live lock and
   * break mutual exclusion for every later acquirer — so removal is gated on
   * the acquire-time directory identity (inode + birthtime; a re-created
   * directory virtually always differs, though see the class docs for the
   * inode-reuse / missing-birthtime caveat). A mismatch or ENOENT is a no-op: the lock
   * is no longer ours to remove, and an orphan in the mismatch direction is
   * reclaimed by the normal stale-sweep. The stat→rmdir pair is not atomic —
   * the gap is unbounded under adverse scheduling, and reaching it requires a
   * full staleness threshold to have already elapsed (see the class docs);
   * closing it entirely needs a different locking design than mkdir(2).
   */
  private async release(artifactId: string, owner: LockIdentity): Promise<void> {
    let lockPath = this.lockPathFor(artifactId);
    let current;
    try {
      current = await stat(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (current.ino !== owner.ino || current.birthtimeMs !== owner.birthtimeMs) return;
    lockPath = this.lockPathFor(artifactId);
    await rmdir(lockPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  private startHeartbeat(
    artifactId: string,
    owner: LockIdentity
  ): { stop(): Promise<{ failed: boolean; error?: unknown }> } {
    const intervalMs = this.options.heartbeatIntervalMs;
    if (intervalMs === null) return { stop: async () => ({ failed: false }) };

    let inFlight: Promise<void> | undefined;
    let failure: unknown;
    let failed = false;
    let stopped = false;
    const beat = (): void => {
      if (inFlight !== undefined || failed) return;
      inFlight = this.renewLease(artifactId, owner)
        .catch((error: unknown) => {
          failed = true;
          failure = error;
          clearInterval(timer);
        })
        .finally(() => {
          inFlight = undefined;
        });
    };
    const timer = setInterval(beat, intervalMs);
    timer.unref();

    return {
      stop: async () => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
          if (inFlight !== undefined) await inFlight;
        }
        return failed ? { failed: true, error: failure } : { failed: false };
      },
    };
  }

  private async verifyLease(artifactId: string, owner: LockIdentity): Promise<void> {
    const lockPath = this.lockPathFor(artifactId);
    const current = await stat(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      current === null ||
      current.ino !== owner.ino ||
      current.birthtimeMs !== owner.birthtimeMs
    ) {
      throw new ArtifactLockLeaseLostError(artifactId);
    }
  }

  private async renewLease(artifactId: string, owner: LockIdentity): Promise<void> {
    const lockPath = this.lockPathFor(artifactId);
    const current = await stat(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      current === null ||
      current.ino !== owner.ino ||
      current.birthtimeMs !== owner.birthtimeMs
    ) {
      throw new ArtifactLockLeaseLostError(artifactId);
    }
    const now = new Date();
    await utimes(lockPath, now, now);
  }

  private async acquire(artifactId: string): Promise<LockIdentity> {
    // Lazily ensure the parent locks directory exists. mkdir-recursive is
    // idempotent, so this is safe to repeat.
    await mkdir(this.resolvePath(this.options.locksDir, 'artifact locks directory'), {
      recursive: true,
    });

    const startTime = Date.now();
    for (;;) {
      let lockPath = this.lockPathFor(artifactId);
      const preMkdirMs = Date.now();
      try {
        // The atomic acquire: mkdir succeeds at most once across all racers.
        await mkdir(lockPath, { recursive: false });
        // Record the identity for the owner-safe release. A failed stat is
        // surfaced WITHOUT removing the path: identity-free removal is the
        // defect class this lock exists to prevent (the dir may already be a
        // successor's re-creation), and an orphaned fresh dir self-heals via
        // the stale-reap.
        lockPath = this.lockPathFor(artifactId);
        // APFS keeps birthtime as min(birthtime, mtime): the heartbeat's
        // whole-millisecond utimes can drag a sub-millisecond birthtime DOWN
        // and break the identity compare (lease "lost" on a renewal that
        // lands in the creation millisecond). Normalize to whole-ms stamps
        // BEFORE capturing the identity, so every later renewal is >= the
        // recorded birth and can never move it.
        {
          const bornAt = new Date();
          await utimes(lockPath, bornAt, bornAt);
        }
        const created = await stat(lockPath);
        // Guard the acquirer-suspension case: fresh-observation reap
        // eligibility requires the dir to age past the stale threshold, so
        // if this process was suspended that long between mkdir and stat,
        // `created` may describe a successor's lock — fail without touching
        // the path rather than proceed on untrustworthy identity. (A reaper
        // suspended mid-reap can defeat this bound; see the class docs.)
        if (Date.now() - preMkdirMs > this.options.staleThresholdMs) {
          throw new Error(
            `Artifact lock "${artifactId}" acquire was suspended past the ${this.options.staleThresholdMs}ms stale threshold between creating and identifying the lockdir; ownership cannot be established.`
          );
        }
        return { ino: created.ino, birthtimeMs: created.birthtimeMs };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }

      // Existing lockdir — check whether it's stale enough to reap.
      try {
        lockPath = this.lockPathFor(artifactId);
        const stats = await stat(lockPath);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs > this.options.staleThresholdMs) {
          // Re-observe immediately before removal: if the stale dir was
          // released and a fresh lock re-created at this path since the
          // observation above, reaping would delete a live lock. Only remove
          // what is STILL the same directory AND still stale. The recheck
          // narrows, but cannot close, the observation→rmdir window (see
          // class docs).
          lockPath = this.lockPathFor(artifactId);
          const recheck = await stat(lockPath).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'ENOENT') throw e;
            return null;
          });
          if (
            recheck !== null &&
            recheck.ino === stats.ino &&
            recheck.birthtimeMs === stats.birthtimeMs &&
            Date.now() - recheck.mtimeMs > this.options.staleThresholdMs
          ) {
            lockPath = this.lockPathFor(artifactId);
            await rmdir(lockPath).catch((err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') throw err;
            });
          }
          // Retry immediately without consuming the backoff.
          continue;
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') {
          // The dir disappeared between EEXIST and stat (another holder
          // released). Retry immediately.
          continue;
        }
        throw statErr;
      }

      const waitedMs = Date.now() - startTime;
      if (waitedMs >= this.options.acquireTimeoutMs) {
        throw new ArtifactLockTimeoutError(
          artifactId,
          this.options.acquireTimeoutMs,
          this.options.staleThresholdMs
        );
      }
      await new Promise((r) => setTimeout(r, this.options.retryIntervalMs));
    }
  }
}
