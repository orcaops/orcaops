import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withNonDerivableWriteLease } from './write-lease.js';
import { locksDir } from '../artifacts/paths.js';
import { ArtifactLock, ArtifactLockLeaseLostError } from '../locks.js';

describe('withNonDerivableWriteLease', () => {
  let repoRoot: string;
  let leasePath: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-write-lease-'));
    leasePath = new ArtifactLock({ locksDir: locksDir(repoRoot) }).lockPathFor('cache-rebuild');
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('keeps the write error primary and carries a same-window lease loss as its cause', async () => {
    class WriteError extends Error {
      readonly code = 'WRITE_FAILED';
    }
    const failed = await withNonDerivableWriteLease(repoRoot, async () => {
      // The lease is destroyed and the write fails in the same window —
      // pre-fix, the post-write verify never ran and the loss was discarded.
      await rm(leasePath, { recursive: true });
      throw new WriteError('the row write failed');
    }).then(
      () => null,
      (err: unknown) => err
    );

    expect(failed).toBeInstanceOf(WriteError);
    expect((failed as WriteError).code).toBe('WRITE_FAILED');
    expect((failed as WriteError).cause).toBeInstanceOf(ArtifactLockLeaseLostError);
  });

  it('attaches no cause when the write fails with its lease intact', async () => {
    const failed = await withNonDerivableWriteLease(repoRoot, () => {
      throw new Error('the row write failed');
    }).then(
      () => null,
      (err: unknown) => err
    );

    expect((failed as Error).message).toBe('the row write failed');
    expect((failed as Error).cause).toBeUndefined();
  });

  it('still retries a bare lease loss on a write that completed', async () => {
    let writes = 0;
    const result = await withNonDerivableWriteLease(
      repoRoot,
      async () => {
        writes += 1;
        // Drop the lockdir on the first pass only: the write COMPLETES, so
        // the post-write verify is what fails and the retry path owns it.
        if (writes === 1) await rm(leasePath, { recursive: true });
        return 'committed';
      },
      { retryOnLeaseLoss: true }
    );

    expect(result).toBe('committed');
    expect(writes).toBe(2);
  });

  it('retries a callback-thrown lease loss too — the retry keys on class, not phase', async () => {
    // Pins the real contract behind `retryOnLeaseLoss`: it does NOT
    // distinguish a failed callback from a failed post-write verify. Safe for
    // the opt-in callers, whose writes are idempotent by contract.
    let writes = 0;
    const result = await withNonDerivableWriteLease(
      repoRoot,
      async () => {
        writes += 1;
        if (writes === 1) {
          await rm(leasePath, { recursive: true });
          throw new ArtifactLockLeaseLostError('cache-rebuild');
        }
        return 'committed';
      },
      { retryOnLeaseLoss: true }
    );

    expect(result).toBe('committed');
    expect(writes).toBe(2);
  });

  it('propagates a bare lease loss untouched when retry is not requested', async () => {
    const failed = await withNonDerivableWriteLease(repoRoot, async () => {
      await rm(leasePath, { recursive: true });
      return 'committed';
    }).then(
      () => null,
      (err: unknown) => err
    );

    expect(failed).toBeInstanceOf(ArtifactLockLeaseLostError);
    expect((failed as Error).cause).toBeUndefined();
  });
});
