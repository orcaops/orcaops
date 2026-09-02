import { locksDir } from '../artifacts/paths.js';
import { ArtifactLock, ArtifactLockLeaseLostError, attachLeaseLossCause } from '../locks.js';

/**
 * Serialize a non-derivable SQLite write against `rebuildCache`.
 *
 * The write takes the rebuild's `cache-rebuild` lock: a writer arriving
 * mid-rebuild blocks until replay finalizes and then commits onto the current
 * cache; a rebuild arriving mid-write waits before resetting. Writers
 * serialize against each other too — every family
 * is a rare single-row upsert, so exclusive access costs nothing a shared
 * lease would buy back.
 *
 * Lock order: where a caller already holds an artifact lock, this lease is
 * acquired INSIDE it (artifact lock first). No cycle exists — rebuildCache
 * holds only `cache-rebuild` and takes no artifact locks.
 *
 * The post-write `verify()` is load-bearing: release() treats a replaced
 * lockdir as success, so without it a writer reaped mid-suspend could
 * resume during a successor rebuild, commit into its reset window, and return
 * "ok" while the row is erased. A lost lease FAILS LOUDLY by default — a
 * blind rerun is unsafe for non-idempotent writes (a failure counter would
 * double-increment; a committed plan reservation would re-resolve as
 * pending). Callers whose write is PROVEN idempotent (absolute-value
 * upserts with every field precomputed, conditional deletes) opt into one
 * reacquire-and-rerun retry via `retryOnLeaseLoss`; a second loss
 * propagates loudly.
 *
 * Timeout diagnostics carry the lock key and waited duration only — the
 * lock keeps no owner metadata, so no holder identity can be named.
 */
export async function withNonDerivableWriteLease<T>(
  repoRoot: string,
  write: () => T | Promise<T>,
  opts: { acquireTimeoutMs?: number; retryOnLeaseLoss?: boolean } = {}
): Promise<T> {
  const lock = new ArtifactLock({
    locksDir: locksDir(repoRoot),
    containmentRoot: repoRoot,
    // Strictly outlast a wedged rebuild: the reap boundary is ageMs > the
    // 120s stale threshold, so an equal timeout could expire one tick
    // before the lock becomes reapable. 150s clears the boundary.
    acquireTimeoutMs: opts.acquireTimeoutMs ?? 150_000,
  });
  const attempt = (): Promise<T> =>
    lock.withLock('cache-rebuild', async (lease) => {
      let result: T;
      try {
        result = await write();
      } catch (err) {
        // A failed write does NOT prove the lease survived. Verify anyway so
        // a lease lost in the same window is disclosed as the cause instead
        // of discarded; the write error stays primary and stays the thrown
        // value. NOTE the retry below keys on error CLASS, not on which
        // phase failed: a callback that itself throws
        // `ArtifactLockLeaseLostError` (e.g. from its own `lease.assert()`)
        // is retried too. That predates this change and is safe for the
        // opt-in callers, whose writes are idempotent by contract.
        await lease.verify().catch((leaseErr: unknown) => {
          attachLeaseLossCause(err, leaseErr);
        });
        throw err;
      }
      await lease.verify();
      return result;
    });
  try {
    return await attempt();
  } catch (err) {
    if (opts.retryOnLeaseLoss === true && err instanceof ArtifactLockLeaseLostError) {
      return attempt();
    }
    throw err;
  }
}
