import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const releaseFault = vi.hoisted(() => ({
  armed: false,
  lockPath: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (releaseFault.armed && String(args[0]) === releaseFault.lockPath) {
        releaseFault.armed = false;
        throw Object.assign(new Error('mocked release stat failure'), { code: 'EIO' });
      }
      return actual.stat(...args);
    },
  };
});

import {
  RefreshLockContendedError,
  RefreshLockObstructedError,
  withRefreshLock,
  withRefreshLockSync,
} from './refresh-lock.js';

describe('refresh lock release', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-refresh-release-'));
    releaseFault.armed = false;
    releaseFault.lockPath = path.join(dir, '.credentials.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the owner record when release cannot inspect the lock directory', async () => {
    const result = await withRefreshLock(
      dir,
      async () => {
        releaseFault.armed = true;
        return 'protected-result';
      },
      { acquireMs: 20, retryMs: 2, staleMs: 60_000 }
    );

    expect(result).toBe('protected-result');
    expect(await readdir(releaseFault.lockPath)).toEqual([]);

    let entered = false;
    await expect(
      withRefreshLock(
        dir,
        async () => {
          entered = true;
        },
        { acquireMs: 20, retryMs: 2, staleMs: 60_000 }
      )
    ).rejects.toBeInstanceOf(RefreshLockContendedError);
    expect(entered).toBe(false);

    const staleTime = new Date(Date.now() - 120_000);
    await utimes(releaseFault.lockPath, staleTime, staleTime);
    await expect(
      withRefreshLock(dir, async () => 'recovered', {
        acquireMs: 40,
        retryMs: 2,
        staleMs: 60_000,
      })
    ).resolves.toBe('recovered');
  });

  it('identifies unexpected entries that obstruct asynchronous stale-lock recovery', async () => {
    await mkdir(releaseFault.lockPath);
    await writeFile(path.join(releaseFault.lockPath, 'unexpected-entry'), 'occupied');
    const staleTime = new Date(Date.now() - 120_000);
    await utimes(releaseFault.lockPath, staleTime, staleTime);
    let entered = false;

    const error = await withRefreshLock(
      dir,
      async () => {
        entered = true;
      },
      { acquireMs: 20, retryMs: 2, staleMs: 60_000 }
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RefreshLockObstructedError);
    expect((error as Error).message).toContain(releaseFault.lockPath);
    expect((error as Error).message).toContain('After confirming no Orcaops process');
    expect(entered).toBe(false);

    await rm(releaseFault.lockPath, { recursive: true });
    await expect(
      withRefreshLock(dir, async () => 'recovered', {
        acquireMs: 40,
        retryMs: 2,
        staleMs: 60_000,
      })
    ).resolves.toBe('recovered');
  });

  it('removes the owner record when synchronous lock removal fails', async () => {
    const blocker = path.join(releaseFault.lockPath, 'cleanup-blocker');
    const result = withRefreshLockSync(
      dir,
      () => {
        writeFileSync(blocker, 'occupied');
        return 'protected-result';
      },
      { acquireMs: 20, retryMs: 2, staleMs: 60_000 }
    );

    expect(result).toBe('protected-result');
    expect(await readdir(releaseFault.lockPath)).toEqual(['cleanup-blocker']);

    let entered = false;
    expect(() =>
      withRefreshLockSync(
        dir,
        () => {
          entered = true;
        },
        { acquireMs: 20, retryMs: 2, staleMs: 60_000 }
      )
    ).toThrow(RefreshLockContendedError);
    expect(entered).toBe(false);

    const staleTime = new Date(Date.now() - 120_000);
    await utimes(releaseFault.lockPath, staleTime, staleTime);
    expect(() =>
      withRefreshLockSync(dir, () => 'must-not-enter', {
        acquireMs: 20,
        retryMs: 2,
        staleMs: 60_000,
      })
    ).toThrow(RefreshLockObstructedError);

    await rm(releaseFault.lockPath, { recursive: true });
    expect(
      withRefreshLockSync(dir, () => 'recovered', {
        acquireMs: 40,
        retryMs: 2,
        staleMs: 60_000,
      })
    ).toBe('recovered');
  });
});
