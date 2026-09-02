import { AsyncLocalStorage } from 'node:async_hooks';
import type { Stats } from 'node:fs';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Refresh-lock timing. A refresh (discovery + token POST) is normally <3s; the
// acquire budget covers a slow peer, after which we fail closed. The stale
// threshold must exceed the acquire budget by a wide margin: it is the point at
// which a competing acquirer decides the holder is DEAD, and reaping a merely
// slow holder is what produces two writers.
export const REFRESH_LOCK_ACQUIRE_MS = 15_000;
export const REFRESH_LOCK_RETRY_MS = 50;
export const REFRESH_LOCK_STALE_MS = 120_000;

export interface RefreshLockTiming {
  acquireMs?: number;
  retryMs?: number;
  staleMs?: number;
}

/** Acquire-time identity of a lockdir, for owner-safe release. */
interface LockIdentity {
  ino: number;
  birthtimeMs: number;
}

interface LockOwnerRecord extends LockIdentity {
  v: 1;
  pid: number;
}

/**
 * Thrown when the lock can't be acquired within the budget (a holder hung past
 * the timeout). The SDK's proactive path swallows it (the live request
 * retries); the reactive path surfaces it as a refresh failure. Failing here is
 * deliberate — running unlocked could double-rotate the refresh token and trip
 * OAuth 2.1 reuse detection (family invalidation), or lose a concurrent
 * write to the shared credentials file.
 */
export class RefreshLockContendedError extends Error {
  readonly name = 'RefreshLockContendedError';
  constructor(lockDir: string, waitedMs: number) {
    super(
      `Could not acquire the credential store lock in ${lockDir} within ${waitedMs}ms; another process is mutating credentials.`
    );
  }
}

export class RefreshLockObstructedError extends Error {
  readonly name = 'RefreshLockObstructedError';
  constructor(lockPath: string) {
    super(
      `The stale credential lock at ${lockPath} contains unexpected entries and cannot be removed. ` +
        'After confirming no Orcaops process is mutating credentials, remove that stale lock directory and retry.'
    );
  }
}

/**
 * In-process re-entrancy, scoped to the async call stack that holds the lock.
 * The SDK takes this lock for a refresh and then calls `store.write` inside it
 * (index.js: withRefreshLock → refreshAndPersist → write), so a non-re-entrant
 * acquire would deadlock against itself until the budget expired.
 *
 * Async-context scoping is what makes that safe: a genuinely NESTED call sees
 * the held lock and passes through, while an INDEPENDENT concurrent acquire in
 * the same process does not and must wait or fail closed like any other
 * contender. A process-global held-set would wrongly wave the second one
 * through.
 */
interface HeldToken {
  readonly lockPath: string;
  /** Cleared on release, so an inherited context stops counting as held. */
  live: boolean;
}

const heldLocks = new AsyncLocalStorage<ReadonlySet<HeldToken>>();
const operationAbortSignals = new AsyncLocalStorage<AbortSignal>();

/** Bind an operation deadline to refresh-lock acquisition without changing the SDK's store API. */
export function runWithRefreshLockAbortSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  return operationAbortSignals.run(signal, operation);
}

/**
 * Is this lock held on THIS async stack, right now? The `live` check matters:
 * an async task spawned inside the callback inherits the context and can run
 * AFTER release, at which point another process may own the lock. Without
 * invalidation such a straggler's write would skip locking entirely.
 */
function holdsLock(lockPath: string): boolean {
  const store = heldLocks.getStore();
  if (store === undefined) return false;
  for (const token of store) {
    if (token.lockPath === lockPath && token.live) return true;
  }
  return false;
}

/** Run `fn` with `lockPath` marked held for this async context and below. */
function runHolding<T>(token: HeldToken, fn: () => T): T {
  const next = new Set(heldLocks.getStore() ?? []);
  next.add(token);
  return heldLocks.run(next, fn);
}

/**
 * Lock paths an ASYNC acquire in this process is currently attempting or
 * holding. The synchronous acquire consults it to fail fast instead of
 * blocking: `Atomics.wait` freezes the event loop, so an async holder
 * awaiting a timer, a socket, or the filesystem can never reach its release
 * and the sync waiter would burn its whole budget before throwing anyway.
 *
 * Registered BEFORE the acquire begins and cleared only AFTER the physical
 * lock is released, so it brackets the entire window in which the async side
 * owns or is claiming the lock — a narrower marker would leave gaps around
 * `mkdir`, around the identifying `stat`, and around release, and a sync
 * acquirer landing in one of those gaps would freeze the loop exactly as
 * before.
 */
const asyncPending = new Map<string, number>();

function markAsyncPending(lockPath: string): void {
  asyncPending.set(lockPath, (asyncPending.get(lockPath) ?? 0) + 1);
}

/**
 * Refcounted, not a flag: two async operations can contend for the same path,
 * and with a Set the first to finish (or to fail its acquire) would erase the
 * marker while the other still holds or is claiming the lock — putting a
 * later sync mutation right back into the event-loop freeze.
 */
function unmarkAsyncPending(lockPath: string): void {
  const n = (asyncPending.get(lockPath) ?? 1) - 1;
  if (n <= 0) asyncPending.delete(lockPath);
  else asyncPending.set(lockPath, n);
}

/**
 * The lock file name. ONE lock per credential store, not one per base URL:
 * the protected resource is the whole `credentials.json`, which every base
 * URL's entry shares. Keying by base URL let two clouds' refreshes
 * read-modify-write the same file concurrently and lose one another's tokens.
 */
const LOCK_NAME = '.credentials.lock';
const OWNER_FILE_PREFIX = 'owner.';

function sameIdentity(
  observed: Pick<Stats, 'ino' | 'birthtimeMs'>,
  expected: LockIdentity
): boolean {
  return observed.ino === expected.ino && observed.birthtimeMs === expected.birthtimeMs;
}

function ownerRecordPath(lockPath: string, identity: LockIdentity): string {
  return path.join(lockPath, `${OWNER_FILE_PREFIX}${identity.ino}.${identity.birthtimeMs}.json`);
}

function readOwnerRecord(lockPath: string, identity: LockIdentity): LockOwnerRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(ownerRecordPath(lockPath, identity), 'utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== 1 ||
      !Number.isInteger((parsed as { pid?: unknown }).pid) ||
      ((parsed as { pid: number }).pid ?? 0) <= 0 ||
      !Number.isFinite((parsed as { ino?: unknown }).ino) ||
      !Number.isFinite((parsed as { birthtimeMs?: unknown }).birthtimeMs)
    ) {
      return null;
    }
    return parsed as LockOwnerRecord;
  } catch {
    return null;
  }
}

function readMatchingOwner(lockPath: string, identity: LockIdentity): LockOwnerRecord | null {
  const owner = readOwnerRecord(lockPath, identity);
  return owner !== null && sameIdentity(owner, identity) ? owner : null;
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM and unfamiliar platform errors do not prove the process is dead.
    return true;
  }
}

function hasLiveOwner(lockPath: string, identity: LockIdentity): boolean {
  const owner = readMatchingOwner(lockPath, identity);
  return owner !== null && processIsLive(owner.pid);
}

function writeOwnerRecord(lockPath: string, identity: LockIdentity): void {
  const record: LockOwnerRecord = { v: 1, pid: process.pid, ...identity };
  const file = ownerRecordPath(lockPath, identity);
  writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(file, 0o600);
}

function removeOwnerRecordIfMatches(lockPath: string, identity: LockIdentity): boolean {
  if (readMatchingOwner(lockPath, identity) === null) return false;
  try {
    unlinkSync(ownerRecordPath(lockPath, identity));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

function removeStaleOwnerRecord(lockPath: string, identity: LockIdentity): void {
  try {
    unlinkSync(ownerRecordPath(lockPath, identity));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function ensureLockDirectory(lockDir: string): void {
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const observed = statSync(lockDir);
  const getuid = process.getuid;
  if (typeof getuid === 'function' && observed.uid !== getuid()) {
    throw new Error(
      `Credential lock directory ${lockDir} is owned by uid ${observed.uid}, not the current uid ${getuid()}; refusing.`
    );
  }
  if ((observed.mode & 0o077) !== 0) {
    chmodSync(lockDir, 0o700);
    const repaired = statSync(lockDir);
    if (typeof getuid === 'function' && repaired.uid !== getuid()) {
      throw new Error(
        `Credential lock directory ${lockDir} changed ownership while being tightened; refusing.`
      );
    }
    if ((repaired.mode & 0o077) !== 0) {
      throw new Error(`Credential lock directory ${lockDir} could not be tightened to mode 700.`);
    }
  }
}

/**
 * Cross-process critical section for every mutation of one credential store,
 * shared by the stores that can span processes (file, keyring). An atomic
 * `mkdir` lock in `lockDir`. **Fails closed**: on acquire timeout it throws
 * rather than running `fn` unlocked. Stale dirs from a dead holder are reaped
 * so a crash cannot wedge it forever, and release is owner-safe so reaping
 * cannot cascade into deleting a live successor's lock.
 *
 * The lock directory contains one owner record binding its inode/birthtime to
 * the holder PID. A predecessor therefore cannot overwrite or unlink a
 * successor's record, and an aged lock is reaped only after its owner is no
 * longer live. The remaining `stat → unlink → rmdir` observation window is not
 * atomic; closing that narrower race needs an advisory `flock`/`fcntl`
 * primitive rather than mkdir(2).
 */
export async function withRefreshLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  timing: RefreshLockTiming = {}
): Promise<T> {
  const lockPath = path.join(lockDir, LOCK_NAME);
  // Already ours on THIS async stack; nesting is expected (see heldLocks).
  if (holdsLock(lockPath)) return fn();

  markAsyncPending(lockPath);
  let owner: LockIdentity;
  try {
    owner = await acquire(lockDir, lockPath, timing);
  } catch (err) {
    unmarkAsyncPending(lockPath);
    throw err;
  }
  const token: HeldToken = { lockPath, live: true };
  try {
    operationAbortSignals.getStore()?.throwIfAborted();
    return await runHolding(token, fn);
  } finally {
    token.live = false;
    try {
      // Cleanup cannot replace the protected callback's result or error. A
      // cleanup residue keeps later callers fail-closed until stale recovery
      // or operator cleanup.
      try {
        await release(lockPath, owner);
      } catch {
        /* nothing safe to do from a finally */
      }
    } finally {
      // Cleared LAST: until the physical lock is gone, a sync acquirer that
      // blocked here would still be waiting on this holder.
      unmarkAsyncPending(lockPath);
    }
  }
}

/**
 * Owner-safe release. The lockdir at this path may no longer be OURS: a holder
 * can die after a competing acquirer observes it stale, and that acquirer can
 * then re-create the lockdir before this process reaches cleanup. An
 * unconditional rmdir would delete that successor's live lock and break
 * mutual exclusion. Removal is therefore gated on the acquire-time identity
 * (inode + birthtime). Every exit attempts to remove only this owner's
 * owner record, including a failed inspection or removal.
 */
async function release(lockPath: string, owner: LockIdentity): Promise<void> {
  try {
    let current;
    try {
      current = await stat(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (!sameIdentity(current, owner)) {
      return;
    }
    if (!removeOwnerRecordIfMatches(lockPath, owner)) return;
    try {
      await rmdir(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  } finally {
    removeOwnerRecordIfMatches(lockPath, owner);
  }
}

async function acquire(
  lockDir: string,
  lockPath: string,
  timing: RefreshLockTiming
): Promise<LockIdentity> {
  const acquireMs = timing.acquireMs ?? REFRESH_LOCK_ACQUIRE_MS;
  const retryMs = timing.retryMs ?? REFRESH_LOCK_RETRY_MS;
  const staleMs = timing.staleMs ?? REFRESH_LOCK_STALE_MS;
  ensureLockDirectory(lockDir);
  const start = Date.now();
  for (;;) {
    operationAbortSignals.getStore()?.throwIfAborted();
    const preMkdirMs = Date.now();
    try {
      await mkdir(lockPath); // atomic: succeeds for exactly one racer
      // Record identity for the owner-safe release. A failed stat is surfaced
      // WITHOUT removing the path: identity-free removal is the defect class
      // this lock exists to prevent, and an orphaned fresh dir self-heals via
      // the stale reap.
      const created = await stat(lockPath);
      // Guard the acquirer-suspension case: reap eligibility requires the dir
      // to age past the stale threshold, so if this process was suspended
      // that long between mkdir and stat, `created` may describe a
      // successor's lock. Fail rather than proceed on untrustworthy identity.
      if (Date.now() - preMkdirMs > staleMs) {
        throw new Error(
          `Credential store lock acquire was suspended past the ${staleMs}ms stale threshold between creating and identifying the lockdir; ownership cannot be established.`
        );
      }
      const owner = { ino: created.ino, birthtimeMs: created.birthtimeMs };
      try {
        writeOwnerRecord(lockPath, owner);
        const published = await stat(lockPath);
        if (!sameIdentity(published, owner)) {
          throw new RefreshLockContendedError(lockDir, Date.now() - start);
        }
      } catch (error) {
        const acquireError =
          (error as NodeJS.ErrnoException).code === 'EEXIST'
            ? new RefreshLockContendedError(lockDir, Date.now() - start)
            : error;
        try {
          removeOwnerRecordIfMatches(lockPath, owner);
        } catch {
          // Preserve the acquire failure; stale recovery owns cleanup.
        }
        try {
          if (sameIdentity(await stat(lockPath), owner)) {
            await rmdir(lockPath).catch(() => undefined);
          }
        } catch {
          // Preserve the owner-write failure; the stale sweep owns recovery.
        }
        throw acquireError;
      }
      return owner;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        // Re-observe immediately before removal: if the stale dir was released
        // and a fresh lock created at this path since the observation above,
        // reaping would delete a live lock. Only remove what is STILL the same
        // directory AND still stale. This narrows, but cannot close, the
        // observation→rmdir window — closing it needs a different design than
        // mkdir(2).
        const recheck = await stat(lockPath).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
          return null;
        });
        if (
          recheck !== null &&
          sameIdentity(recheck, st) &&
          Date.now() - recheck.mtimeMs > staleMs
        ) {
          if (!hasLiveOwner(lockPath, recheck)) {
            try {
              removeStaleOwnerRecord(lockPath, recheck);
              await rmdir(lockPath);
            } catch (e) {
              const code = (e as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT') {
                if (code === 'ENOTEMPTY' || code === 'EEXIST') {
                  throw new RefreshLockObstructedError(lockPath);
                }
                throw e;
              }
            }
            continue;
          }
        }
        if (recheck === null) continue;
      }
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') continue; // holder released
      throw statErr;
    }
    if (Date.now() - start >= acquireMs) {
      throw new RefreshLockContendedError(lockDir, acquireMs);
    }
    await waitForRetry(retryMs);
  }
}

async function waitForRetry(ms: number): Promise<void> {
  const signal = operationAbortSignals.getStore();
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Synchronous sleep, so the sync lock waits without burning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The synchronous twin of {@link withRefreshLock}, over the SAME lock path so
 * the two interoperate: a sync `write` cannot interleave with an async
 * refresh. It exists because the credential stores' mutators are sync
 * (`write`/`clear`/`clearAll`), and making them async would ripple into
 * callers that invoke them un-awaited — where a dropped promise means a
 * silently lost credential write, which is worse than a brief blocking wait
 * on a small file.
 *
 * Same fail-closed, owner-safe, stale-reaping semantics as the async path,
 * including the in-process re-entrancy that lets a sync mutation run inside
 * an async refresh already holding the lock.
 */
export function withRefreshLockSync<T>(
  lockDir: string,
  fn: () => T,
  timing: RefreshLockTiming = {}
): T {
  const lockPath = path.join(lockDir, LOCK_NAME);
  if (holdsLock(lockPath)) return fn();
  if (asyncPending.has(lockPath)) {
    // An async acquire in this process owns (or is claiming) THIS lock, and
    // the re-entrancy check above already established it is not our caller.
    // Blocking would freeze the event loop that holder needs to finish, so
    // the wait cannot succeed — fail immediately rather than wedge the
    // process for the whole acquire budget. Holding some OTHER lock is
    // irrelevant and deliberately not consulted.
    throw new RefreshLockContendedError(lockDir, 0);
  }

  const acquireMs = timing.acquireMs ?? REFRESH_LOCK_ACQUIRE_MS;
  const retryMs = timing.retryMs ?? REFRESH_LOCK_RETRY_MS;
  const staleMs = timing.staleMs ?? REFRESH_LOCK_STALE_MS;
  ensureLockDirectory(lockDir);
  const start = Date.now();
  let owner: LockIdentity | null = null;
  for (;;) {
    const preMkdirMs = Date.now();
    try {
      mkdirSync(lockPath);
      const created = statSync(lockPath);
      if (Date.now() - preMkdirMs > staleMs) {
        throw new Error(
          `Credential store lock acquire was suspended past the ${staleMs}ms stale threshold between creating and identifying the lockdir; ownership cannot be established.`
        );
      }
      owner = { ino: created.ino, birthtimeMs: created.birthtimeMs };
      try {
        writeOwnerRecord(lockPath, owner);
        if (!sameIdentity(statSync(lockPath), owner)) {
          throw new RefreshLockContendedError(lockDir, Date.now() - start);
        }
      } catch (error) {
        const acquireError =
          (error as NodeJS.ErrnoException).code === 'EEXIST'
            ? new RefreshLockContendedError(lockDir, Date.now() - start)
            : error;
        try {
          removeOwnerRecordIfMatches(lockPath, owner);
        } catch {
          // Preserve the acquire failure; stale recovery owns cleanup.
        }
        try {
          if (sameIdentity(statSync(lockPath), owner)) {
            rmdirSync(lockPath);
          }
        } catch {
          // Preserve the owner-write failure; the stale sweep owns recovery.
        }
        throw acquireError;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        let recheck: ReturnType<typeof statSync> | null = null;
        try {
          recheck = statSync(lockPath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (
          recheck !== null &&
          sameIdentity(recheck, st) &&
          Date.now() - recheck.mtimeMs > staleMs
        ) {
          if (!hasLiveOwner(lockPath, recheck)) {
            try {
              removeStaleOwnerRecord(lockPath, recheck);
              rmdirSync(lockPath);
            } catch (e) {
              const code = (e as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT') {
                if (code === 'ENOTEMPTY' || code === 'EEXIST') {
                  throw new RefreshLockObstructedError(lockPath);
                }
                throw e;
              }
            }
            continue;
          }
        }
        if (recheck === null) continue;
      }
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw statErr;
    }
    if (Date.now() - start >= acquireMs) {
      throw new RefreshLockContendedError(lockDir, acquireMs);
    }
    sleepSync(retryMs);
  }

  const token: HeldToken = { lockPath, live: true };
  try {
    return runHolding(token, fn);
  } finally {
    token.live = false;
    // Owner-safe release, same identity gate as the async path. Errors are
    // swallowed rather than rethrown: this runs in a `finally`, so throwing
    // here would replace whatever `fn` was reporting with a lock-cleanup
    // detail. A lock we fail to remove is reclaimed by the stale sweep.
    try {
      let current: ReturnType<typeof statSync> | null = null;
      try {
        current = statSync(lockPath);
      } catch {
        // A missing or mismatched owner record is not ours to remove.
      }
      if (current !== null && sameIdentity(current, owner)) {
        if (removeOwnerRecordIfMatches(lockPath, owner)) rmdirSync(lockPath);
      }
    } catch {
      /* preserve the protected callback's result or error */
    } finally {
      try {
        removeOwnerRecordIfMatches(lockPath, owner);
      } catch {
        /* nothing safe to do from a finally */
      }
    }
  }
}
