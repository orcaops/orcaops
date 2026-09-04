import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArtifactLock,
  ArtifactLockLeaseLostError,
  ArtifactLockTimeoutError,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_STALE_THRESHOLD_MS,
} from './locks.js';
import { PathContainmentError } from './paths/containment.js';

describe('ArtifactLock', () => {
  let tmpRoot: string;
  let locksDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-locks-'));
    locksDir = path.join(tmpRoot, 'tmp', 'locks');
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('options resolution', () => {
    it('fills defaults when only locksDir is provided', () => {
      const lock = new ArtifactLock({ locksDir });
      expect(lock.options).toEqual({
        locksDir,
        acquireTimeoutMs: DEFAULT_ACQUIRE_TIMEOUT_MS,
        retryIntervalMs: DEFAULT_RETRY_INTERVAL_MS,
        staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
        heartbeatIntervalMs: null,
      });
    });

    it('honours caller overrides for timing knobs', () => {
      const lock = new ArtifactLock({
        locksDir,
        acquireTimeoutMs: 500,
        retryIntervalMs: 5,
        staleThresholdMs: 60_000,
        heartbeatIntervalMs: 10_000,
      });
      expect(lock.options.acquireTimeoutMs).toBe(500);
      expect(lock.options.retryIntervalMs).toBe(5);
      expect(lock.options.staleThresholdMs).toBe(60_000);
      expect(lock.options.heartbeatIntervalMs).toBe(10_000);
    });
  });

  describe('withLock — happy paths', () => {
    it('returns the value resolved by fn', async () => {
      const lock = new ArtifactLock({ locksDir });
      const result = await lock.withLock('artifact-1', async () => 42);
      expect(result).toBe(42);
    });

    it('awaits an async fn before resolving', async () => {
      const lock = new ArtifactLock({ locksDir });
      const order: string[] = [];
      await lock.withLock('artifact-1', async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('inside');
      });
      order.push('after');
      expect(order).toEqual(['inside', 'after']);
    });

    it('runs concurrent calls for different artifact IDs in parallel', async () => {
      const lock = new ArtifactLock({ locksDir });
      const startedAt: Record<string, number> = {};
      const finishedAt: Record<string, number> = {};
      // performance.now(): Date.now()'s millisecond resolution lets a start
      // and a finish land on the same tick under load, defeating the strict
      // ordering assertions below.
      const op = (id: string) =>
        lock.withLock(id, async () => {
          startedAt[id] = performance.now();
          await new Promise((r) => setTimeout(r, 30));
          finishedAt[id] = performance.now();
        });
      await Promise.all([op('a'), op('b')]);
      // Each starts before the other finishes — proves no cross-artifact serialization.
      expect(startedAt.a).toBeLessThan(finishedAt.b);
      expect(startedAt.b).toBeLessThan(finishedAt.a);
    });

    it('serializes concurrent same-artifact callers', async () => {
      const lock = new ArtifactLock({ locksDir, retryIntervalMs: 5 });
      const order: string[] = [];
      const op = (id: string) =>
        lock.withLock('artifact-1', async () => {
          order.push(`start:${id}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`end:${id}`);
        });
      await Promise.all([op('first'), op('second')]);
      // One must fully complete before the other starts. Either ordering is
      // acceptable (lock fairness is not part of the contract); both are
      // strict start/end pairs without interleaving.
      const validOrders = [
        ['start:first', 'end:first', 'start:second', 'end:second'],
        ['start:second', 'end:second', 'start:first', 'end:first'],
      ];
      expect(validOrders).toContainEqual(order);
    });

    it('releases the lock after fn resolves so the next caller can acquire', async () => {
      const lock = new ArtifactLock({ locksDir });
      await lock.withLock('artifact-1', async () => 'first');
      const second = await lock.withLock('artifact-1', async () => 'second');
      expect(second).toBe('second');
      // Lock dir is gone after the second release.
      await expect(stat(lock.lockPathFor('artifact-1'))).rejects.toThrow();
    });

    it('creates the locksDir lazily on first acquire', async () => {
      const lock = new ArtifactLock({ locksDir });
      await expect(stat(locksDir)).rejects.toThrow();
      await lock.withLock('artifact-1', async () => undefined);
      const stats = await stat(locksDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe('resolved containment', () => {
    it('refuses a lock-directory redirect introduced after construction', async () => {
      const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-locks-outside-'));
      const lock = new ArtifactLock({ locksDir, containmentRoot: tmpRoot });
      await mkdir(path.dirname(locksDir), { recursive: true });
      await symlink(outside, locksDir);
      try {
        await expect(lock.withLock('artifact-1', async () => undefined)).rejects.toThrow(
          PathContainmentError
        );
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('withLock — error propagation', () => {
    it('propagates a thrown synchronous error from fn and still releases the lock', async () => {
      const lock = new ArtifactLock({ locksDir });
      await expect(
        lock.withLock('artifact-1', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow(/boom/);
      // Lock released — the next acquire should succeed immediately.
      await expect(stat(lock.lockPathFor('artifact-1'))).rejects.toThrow();
      await lock.withLock('artifact-1', async () => undefined);
    });

    it('propagates a rejected promise from fn and still releases the lock', async () => {
      const lock = new ArtifactLock({ locksDir });
      await expect(
        lock.withLock('artifact-1', () => Promise.reject(new Error('rejected')))
      ).rejects.toThrow(/rejected/);
      await expect(stat(lock.lockPathFor('artifact-1'))).rejects.toThrow();
    });

    it('does not swallow the error type', async () => {
      const lock = new ArtifactLock({ locksDir });
      class CustomErr extends Error {
        readonly tag = 'custom';
      }
      await expect(
        lock.withLock('artifact-1', async () => {
          throw new CustomErr('typed');
        })
      ).rejects.toBeInstanceOf(CustomErr);
    });

    it('preserves a rejection whose reason is undefined', async () => {
      let rejected = false;
      try {
        await new ArtifactLock({ locksDir }).withLock('artifact-1', () =>
          Promise.reject(undefined)
        );
      } catch (error) {
        rejected = true;
        expect(error).toBeUndefined();
      }
      expect(rejected).toBe(true);
    });
  });

  describe('acquire timeout', () => {
    /**
     * Hold the lock for `holdMs`, signalling acquisition via a deferred
     * promise so the test can deterministically wait until the holder
     * actually owns the lock before racing a second caller. Without
     * the deferred, both withLock calls race for the initial mkdir and
     * the test ordering becomes nondeterministic.
     */
    function holdLock(
      lock: ArtifactLock,
      artifactId: string,
      holdMs: number
    ): { acquired: Promise<void>; released: Promise<void> } {
      let onAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => {
        onAcquired = resolve;
      });
      const released = lock.withLock(artifactId, async () => {
        onAcquired();
        await new Promise((r) => setTimeout(r, holdMs));
      });
      return { acquired, released };
    }

    it('throws ArtifactLockTimeoutError when the lock cannot be acquired in time', async () => {
      const lock = new ArtifactLock({
        locksDir,
        acquireTimeoutMs: 80,
        retryIntervalMs: 10,
        // Long stale threshold so the holder's lockdir doesn't get reaped mid-test.
        staleThresholdMs: 60_000,
      });
      const { acquired, released } = holdLock(lock, 'artifact-1', 200);
      await acquired;
      await expect(lock.withLock('artifact-1', async () => 'too late')).rejects.toBeInstanceOf(
        ArtifactLockTimeoutError
      );
      await released;
    });

    it('error carries the artifact id and the configured timeout for diagnostics', async () => {
      const lock = new ArtifactLock({
        locksDir,
        acquireTimeoutMs: 60,
        retryIntervalMs: 10,
        staleThresholdMs: 60_000,
      });
      const { acquired, released } = holdLock(lock, 'artifact-xyz', 150);
      await acquired;
      try {
        await lock.withLock('artifact-xyz', async () => undefined);
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ArtifactLockTimeoutError);
        const e = err as ArtifactLockTimeoutError;
        expect(e.artifactId).toBe('artifact-xyz');
        expect(e.waitedMs).toBe(60);
        expect(e.code).toBe('LOCK_TIMEOUT');
        // A wedged caller needs the reap threshold, not just the wait: without
        // it there is no way to tell "retry in a minute" from "stuck forever".
        expect(e.staleThresholdMs).toBe(60_000);
        expect(e.message).toContain('60000ms old');
        expect(e.message).toContain('retry after 60s');
      }
      await released;
    });
  });

  describe('lease identity stability', () => {
    it('acquire normalizes the lockdir stamps so a same-millisecond renewal keeps the lease', async () => {
      // macOS derives st_birthtime as min(birthtime, mtime): a renewal's
      // whole-millisecond utimes could drag a sub-millisecond birthtime DOWN
      // and mutate the identity the lease compares. Acquire normalizes first;
      // this pins the postcondition that leaves birthtime unmovable, and that
      // an immediate flurry of renewals — the same-millisecond window that
      // used to lose the lease — keeps ownership.
      const lock = new ArtifactLock({ locksDir, containmentRoot: tmpRoot });
      await lock.withLock('stability', async (lease) => {
        const lockPath = path.join(locksDir, 'stability.lock');
        const before = await stat(lockPath);
        if (process.platform === 'darwin') {
          // The postcondition is a floor: birthtime at or below mtime, which
          // is what stops a later renewal lowering it. It is NOT necessarily
          // a whole millisecond — utimes round-trips a millisecond Date
          // through a nanosecond timespec, so a normalized stamp can read
          // back as x.999 and land exactly equal to mtime. (Linux birthtime
          // is immutable, so the hazard never existed there.)
          expect(before.birthtimeMs).toBeLessThanOrEqual(before.mtimeMs);
        }
        for (let i = 0; i < 25; i++) {
          await lease.assert();
        }
        const after = await stat(lockPath);
        expect(after.birthtimeMs).toBe(before.birthtimeMs);
        expect(after.ino).toBe(before.ino);
      });
    });
  });

  describe('stale-lock reaping', () => {
    it('reaps an orphaned lockdir whose mtime is older than staleThresholdMs and proceeds', async () => {
      const lock = new ArtifactLock({
        locksDir,
        acquireTimeoutMs: 1000,
        retryIntervalMs: 5,
        staleThresholdMs: 50,
      });
      // Plant a stale lockdir without going through withLock — simulates a
      // crashed prior holder that never released.
      await mkdir(locksDir, { recursive: true });
      await mkdir(lock.lockPathFor('artifact-1'));
      // Wait past the stale threshold so the dir's mtime is "old" by the
      // time we try to acquire.
      await new Promise((r) => setTimeout(r, 80));

      // Should reap + acquire without throwing or hitting the timeout.
      const result = await lock.withLock('artifact-1', async () => 'ok');
      expect(result).toBe('ok');
    });

    it('does not reap a live holder that renews its lease past the stale threshold', async () => {
      const holder = new ArtifactLock({
        locksDir,
        heartbeatIntervalMs: 10,
        retryIntervalMs: 5,
        staleThresholdMs: 40,
      });
      const contender = new ArtifactLock({
        locksDir,
        acquireTimeoutMs: 70,
        retryIntervalMs: 5,
        staleThresholdMs: 40,
      });
      let releaseHolder!: () => void;
      let holderEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        holderEntered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const held = holder.withLock('artifact-1', async () => {
        holderEntered();
        await gate;
      });
      await entered;
      await new Promise((resolve) => setTimeout(resolve, 60));

      await expect(contender.withLock('artifact-1', async () => undefined)).rejects.toBeInstanceOf(
        ArtifactLockTimeoutError
      );
      releaseHolder();
      await held;
      await expect(contender.withLock('artifact-1', async () => 'acquired')).resolves.toBe(
        'acquired'
      );
    });

    it('rejects the operation when a heartbeat observes a replacement lockdir', async () => {
      const lock = new ArtifactLock({
        locksDir,
        heartbeatIntervalMs: 50,
        staleThresholdMs: 500,
      });
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const operation = lock.withLock('artifact-1', async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await enteredPromise;
      const lockPath = lock.lockPathFor('artifact-1');
      await rm(lockPath, { recursive: true });
      await mkdir(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 80));
      release();

      await expect(operation).rejects.toBeInstanceOf(ArtifactLockLeaseLostError);
      await rm(lockPath, { recursive: true });
    });

    it('keeps the operation error primary and carries a same-window lease loss as its cause', async () => {
      const lock = new ArtifactLock({
        locksDir,
        heartbeatIntervalMs: 50,
        staleThresholdMs: 500,
      });
      class OperationError extends Error {
        readonly code = 'OPERATION_FAILED';
      }
      let failOperation!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const operation = lock.withLock('artifact-1', async () => {
        entered();
        await new Promise<void>((resolve) => {
          failOperation = resolve;
        });
        throw new OperationError('the write itself failed');
      });
      await enteredPromise;
      const lockPath = lock.lockPathFor('artifact-1');
      await rm(lockPath, { recursive: true });
      await mkdir(lockPath);
      // Let the heartbeat observe the replacement BEFORE the operation fails,
      // so both failures are live in the same window.
      await new Promise((resolve) => setTimeout(resolve, 80));
      failOperation();

      // The caller still sees what it was doing — class and code intact, so
      // every `instanceof` and envelope mapping keeps working.
      const err = await operation.then(
        () => null,
        (thrown: unknown) => thrown
      );
      expect(err).toBeInstanceOf(OperationError);
      expect((err as OperationError).code).toBe('OPERATION_FAILED');
      expect((err as OperationError).message).toBe('the write itself failed');
      // ...and the concurrency violation is disclosed rather than discarded.
      expect((err as OperationError).cause).toBeInstanceOf(ArtifactLockLeaseLostError);
      // Non-enumerable, exactly as `new Error(msg, { cause })` defines it: a
      // downstream spread or JSON.stringify must not start sweeping the
      // lease-loss detail into payloads that never carried it.
      expect(Object.propertyIsEnumerable.call(err, 'cause')).toBe(false);
      expect(Object.keys(err as object)).not.toContain('cause');
      await rm(lockPath, { recursive: true });
    });

    it('leaves a frozen operation error exactly as thrown', async () => {
      const lock = new ArtifactLock({
        locksDir,
        heartbeatIntervalMs: 50,
        staleThresholdMs: 500,
      });
      const frozen = Object.freeze(new Error('the write itself failed'));
      let failOperation!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const operation = lock.withLock('artifact-1', async () => {
        entered();
        await new Promise<void>((resolve) => {
          failOperation = resolve;
        });
        throw frozen;
      });
      await enteredPromise;
      const lockPath = lock.lockPathFor('artifact-1');
      await rm(lockPath, { recursive: true });
      await mkdir(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 80));
      failOperation();

      // Disclosure is best-effort; precedence is not. Attaching by assignment
      // would raise a TypeError out of the lock and replace this error.
      const err = await operation.then(
        () => null,
        (thrown: unknown) => thrown
      );
      expect(err).toBe(frozen);
      expect((err as Error).cause).toBeUndefined();
      await rm(lockPath, { recursive: true });
    });

    it('never overwrites an operation error that already names its own cause', async () => {
      const lock = new ArtifactLock({
        locksDir,
        heartbeatIntervalMs: 50,
        staleThresholdMs: 500,
      });
      const closerCause = new Error('the closer failure');
      let failOperation!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const operation = lock.withLock('artifact-1', async () => {
        entered();
        await new Promise<void>((resolve) => {
          failOperation = resolve;
        });
        throw new Error('the write itself failed', { cause: closerCause });
      });
      await enteredPromise;
      const lockPath = lock.lockPathFor('artifact-1');
      await rm(lockPath, { recursive: true });
      await mkdir(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 80));
      failOperation();

      const err = await operation.then(
        () => null,
        (thrown: unknown) => thrown
      );
      expect((err as Error).cause).toBe(closerCause);
      await rm(lockPath, { recursive: true });
    });

    it('the lease handle passes while held and throws once the lockdir is replaced', async () => {
      const lock = new ArtifactLock({ locksDir });
      const lockPath = lock.lockPathFor('artifact-1');
      await lock.withLock('artifact-1', async (lease) => {
        await expect(lease.assert()).resolves.toBeUndefined();
        await rm(lockPath, { recursive: true });
        await mkdir(lockPath);
        await expect(lease.assert()).rejects.toBeInstanceOf(ArtifactLockLeaseLostError);
      });
      await rm(lockPath, { recursive: true });
    });

    it('does NOT reap a fresh lockdir that is younger than staleThresholdMs', async () => {
      const lock = new ArtifactLock({
        locksDir,
        acquireTimeoutMs: 60,
        retryIntervalMs: 10,
        // Long stale threshold so the planted dir is never considered stale
        // within the acquire window.
        staleThresholdMs: 60_000,
      });
      await mkdir(locksDir, { recursive: true });
      await mkdir(lock.lockPathFor('artifact-1'));

      await expect(lock.withLock('artifact-1', async () => undefined)).rejects.toBeInstanceOf(
        ArtifactLockTimeoutError
      );
      // Lockdir is still there — proves we did not silently reap a fresh one.
      const entries = await readdir(locksDir);
      expect(entries).toContain('artifact-1.lock');
    });
  });

  describe('withLock — owner-safe release under stale reap', () => {
    const waitFor = async (cond: () => Promise<boolean> | boolean): Promise<void> => {
      const deadline = Date.now() + 2_000;
      while (!(await cond())) {
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await new Promise((r) => setTimeout(r, 2));
      }
    };

    it("predecessor release does not delete a successor's live lock", async () => {
      const lock = new ArtifactLock({ locksDir, retryIntervalMs: 5, staleThresholdMs: 60_000 });
      const lockPath = lock.lockPathFor('artifact-1');

      // Predecessor acquires and parks inside its critical section. Wait for
      // the callback to ENTER (not merely for the lockdir to exist): the dir
      // becomes visible between the predecessor's mkdir and its identity
      // stat, and backdating inside that gap would let the successor reap
      // before the predecessor has recorded what it owns.
      let predecessorHolds = false;
      let releasePredecessor!: () => void;
      const predecessorGate = new Promise<void>((r) => (releasePredecessor = r));
      const predecessor = lock.withLock('artifact-1', async () => {
        predecessorHolds = true;
        await predecessorGate;
      });
      await waitFor(() => predecessorHolds);

      // The predecessor overstays: backdate the lockdir past the stale
      // threshold instead of waiting wall-clock time.
      const past = new Date(Date.now() - 10 * 60_000);
      await utimes(lockPath, past, past);

      // Successor reaps the stale dir and acquires; it now owns the path.
      let successorHolds = false;
      let releaseSuccessor!: () => void;
      const successorGate = new Promise<void>((r) => (releaseSuccessor = r));
      const successor = lock.withLock('artifact-1', async () => {
        successorHolds = true;
        await successorGate;
      });
      await waitFor(() => successorHolds);

      // Predecessor finishes late. Its release must not touch the
      // successor's lock.
      releasePredecessor();
      await predecessor;

      const stats = await stat(lockPath);
      expect(stats.isDirectory()).toBe(true);

      // The surviving lock still excludes a third acquirer.
      const third = new ArtifactLock({
        locksDir,
        acquireTimeoutMs: 100,
        retryIntervalMs: 5,
        staleThresholdMs: 60_000,
      });
      await expect(third.withLock('artifact-1', async () => undefined)).rejects.toBeInstanceOf(
        ArtifactLockTimeoutError
      );

      // The successor's own release still works.
      releaseSuccessor();
      await successor;
      await expect(stat(lockPath)).rejects.toThrow();
    });

    it('release is a no-op when the lockdir was already removed', async () => {
      const lock = new ArtifactLock({ locksDir, retryIntervalMs: 5 });
      const lockPath = lock.lockPathFor('artifact-1');
      let holderHolds = false;
      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((r) => (releaseHolder = r));
      const holder = lock.withLock('artifact-1', async () => {
        holderHolds = true;
        await holderGate;
      });
      // Callback entry, not lockdir existence — see the interleave note above.
      await waitFor(() => holderHolds);
      await rm(lockPath, { recursive: true, force: true });
      releaseHolder();
      await expect(holder).resolves.toBeUndefined();
    });
  });
});
