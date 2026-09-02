// Owner-safety regression for Watch's Bun-safe canonical review lock wrapper.
//
// The dangerous interleave: a predecessor overstays the stale threshold, a
// successor reaps the stale lockdir and re-creates it (successor now owns the
// path), then the predecessor's release runs. The release must not remove the
// successor's live lock — an unconditional rmdir here breaks mutual exclusion
// for every later acquirer. Staleness is simulated by backdating the lockdir
// mtime (utimes); the wrapper's thresholds are fixed constants, so a real
// overstay would need 120s of wall clock.

import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reviewFloorLockKey, reviewLocksDir, withReviewLock } from './reviewLock.js';

const KEY = reviewFloorLockKey('branch-slug');

const waitFor = async (cond: () => Promise<boolean> | boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe('withReviewLock', () => {
  let tmpRoot: string;
  let locksDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-review-lock-'));
    locksDir = reviewLocksDir(tmpRoot);
    lockPath = path.join(locksDir, `${KEY}.lock`);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const exists = async (p: string): Promise<boolean> => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  };

  it('serializes two holders and releases the lockdir after each', async () => {
    const order: string[] = [];
    await withReviewLock(locksDir, KEY, async () => {
      order.push('first');
    });
    expect(await exists(lockPath)).toBe(false);
    await withReviewLock(locksDir, KEY, async () => {
      order.push('second');
    });
    expect(order).toEqual(['first', 'second']);
    expect(await exists(lockPath)).toBe(false);
  });

  it("predecessor release does not delete a successor's live lock", async () => {
    // Predecessor acquires and parks inside its critical section. Wait for
    // the callback to ENTER (not merely for the lockdir to exist): the dir
    // becomes visible between the predecessor's mkdir and its identity stat,
    // and backdating inside that gap would let the successor reap before the
    // predecessor has recorded what it owns.
    let predecessorHolds = false;
    let releasePredecessor!: () => void;
    const predecessorGate = new Promise<void>((r) => (releasePredecessor = r));
    const predecessor = withReviewLock(locksDir, KEY, async () => {
      predecessorHolds = true;
      await predecessorGate;
    });
    await waitFor(() => predecessorHolds);

    // Overstay simulated: backdate the lockdir past STALE_THRESHOLD_MS.
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, past, past);

    // Successor reaps the stale dir and acquires; it now owns the path.
    let successorHolds = false;
    let releaseSuccessor!: () => void;
    const successorGate = new Promise<void>((r) => (releaseSuccessor = r));
    const successor = withReviewLock(locksDir, KEY, async () => {
      successorHolds = true;
      await successorGate;
    });
    await waitFor(() => successorHolds);

    // Predecessor finishes late; its release must not touch the successor's
    // lock.
    releasePredecessor();
    await predecessor;

    const stats = await stat(lockPath);
    expect(stats.isDirectory()).toBe(true);

    // FS-level exclusion probe (the mirror's 10s acquire timeout is a fixed
    // constant, so a full third acquire would stall the suite): the surviving
    // lockdir must still refuse an atomic mkdir claim.
    await expect(mkdir(lockPath, { recursive: false })).rejects.toMatchObject({ code: 'EEXIST' });

    // The successor's own release still works.
    releaseSuccessor();
    await successor;
    expect(await exists(lockPath)).toBe(false);
  });

  it('release is a no-op when the lockdir was already removed', async () => {
    let holderHolds = false;
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => (releaseHolder = r));
    const holder = withReviewLock(locksDir, KEY, async () => {
      holderHolds = true;
      await holderGate;
    });
    // Callback entry, not lockdir existence — see the interleave note above.
    await waitFor(() => holderHolds);
    await rm(lockPath, { recursive: true, force: true });
    releaseHolder();
    await expect(holder).resolves.toBeUndefined();
  });

  it('refuses a redirected repository lock directory', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-review-lock-outside-'));
    try {
      await mkdir(path.dirname(locksDir), { recursive: true });
      await symlink(outside, locksDir);

      await expect(withReviewLock(locksDir, KEY, async () => {}, tmpRoot)).rejects.toThrow(
        /must not contain symlinks/
      );
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
