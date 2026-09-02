import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactLock, ArtifactLockTimeoutError } from '@orcaops/storage';

import { withRepositoryInstallLock } from './repository-install-lock.js';

describe('repository installation lock', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('serializes installation writers for one Git common directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orcaops-install-lock-'));
    roots.push(root);
    let releaseFirst!: () => void;
    const firstCanExit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const entered: string[] = [];

    const first = withRepositoryInstallLock(root, async (lease) => {
      entered.push('first');
      await lease.verify();
      await firstCanExit;
    });
    await expect.poll(() => entered).toEqual(['first']);

    const second = withRepositoryInstallLock(root, async (lease) => {
      entered.push('second');
      await lease.verify();
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(entered).toEqual(['first']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(entered).toEqual(['first', 'second']);
  });

  it('maps lock contention to the public CLI error contract', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orcaops-install-lock-'));
    roots.push(root);
    vi.spyOn(ArtifactLock.prototype, 'withLock').mockRejectedValueOnce(
      new ArtifactLockTimeoutError('install-state', 10_000)
    );

    await expect(withRepositoryInstallLock(root, async () => {})).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
      message: expect.stringContaining('repository installation lock'),
    });
  });

  it('does not relabel a nested lock timeout as repository contention', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orcaops-install-lock-'));
    roots.push(root);
    const nested = new ArtifactLockTimeoutError('global-install', 10_000);

    await expect(
      withRepositoryInstallLock(root, async () => {
        throw nested;
      })
    ).rejects.toBe(nested);
  });
});
