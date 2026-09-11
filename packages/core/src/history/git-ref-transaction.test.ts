import * as childProcess from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHistoryGit } from './git-context.js';
import { runPreparedGitRefDeletion, runPreparedGitRefUpdates } from './git-ref-transaction.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orcaops-ref-transaction-')));
  roots.push(cwd);
  await runHistoryGit(cwd, ['init', '-q']);
  await runHistoryGit(cwd, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'Initial',
  ]);
  const oid = (await runHistoryGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await runHistoryGit(cwd, ['symbolic-ref', 'HEAD'])).stdout.trim();
  const fullRef = 'refs/orcaops/test';
  await runHistoryGit(cwd, ['update-ref', fullRef, oid]);
  const run = (validatePrepared: () => Promise<void>, signal?: AbortSignal) =>
    runPreparedGitRefDeletion({ cwd, fullRef, expectedOid: oid, validatePrepared, signal });
  return { cwd, oid, branch, fullRef, run };
}

describe('prepared Git ref deletion', { timeout: 15_000 }, () => {
  it('rejects a same-OID symbolic substitution before prepare and preserves its referent', async () => {
    const f = await fixture();
    await runHistoryGit(f.cwd, ['symbolic-ref', f.fullRef, f.branch]);
    const validate = vi.fn(async () => {});
    await expect(f.run(validate)).rejects.toMatchObject({ code: 'GIT_RESOURCE_PROTECTED' });
    expect(validate).not.toHaveBeenCalled();
    expect((await runHistoryGit(f.cwd, ['symbolic-ref', f.fullRef])).stdout.trim()).toBe(f.branch);
    expect((await runHistoryGit(f.cwd, ['rev-parse', f.branch])).stdout.trim()).toBe(f.oid);
    await runHistoryGit(f.cwd, ['update-ref', '--no-deref', f.fullRef, f.oid]);
  });

  it('holds Git ref exclusion during validation against an external symbolic writer', async () => {
    const f = await fixture();
    const result = await f.run(async () => {
      const attempt = await runHistoryGit(
        f.cwd,
        ['-c', 'core.filesRefLockTimeout=0', 'symbolic-ref', f.fullRef, f.branch],
        [1, 128]
      );
      expect(attempt.code).not.toBe(0);
      expect((await runHistoryGit(f.cwd, ['symbolic-ref', '--quiet', f.fullRef], [1])).code).toBe(
        1
      );
    });
    expect(result).toEqual({ commit: 'committed' });
    expect(
      (await runHistoryGit(f.cwd, ['rev-parse', '--verify', '--quiet', f.fullRef], [1])).code
    ).toBe(1);
    expect((await runHistoryGit(f.cwd, ['rev-parse', f.branch])).stdout.trim()).toBe(f.oid);
  });

  it('aborts cancellation while prepared and releases Git exclusion before returning', async () => {
    const f = await fixture();
    const controller = new AbortController();
    await expect(
      f.run(async () => {
        controller.abort();
      }, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect((await runHistoryGit(f.cwd, ['rev-parse', f.fullRef])).stdout.trim()).toBe(f.oid);
    await runHistoryGit(f.cwd, [
      '-c',
      'core.filesRefLockTimeout=0',
      'symbolic-ref',
      f.fullRef,
      f.branch,
    ]);
  });

  it('verifies missing-ref recovery under Git exclusion without recreating a ref', async () => {
    const f = await fixture();
    await runHistoryGit(f.cwd, ['update-ref', '-d', f.fullRef]);
    const result = await runPreparedGitRefDeletion({
      cwd: f.cwd,
      fullRef: f.fullRef,
      expectedOid: null,
      validatePrepared: async () => {
        const attempt = await runHistoryGit(
          f.cwd,
          ['-c', 'core.filesRefLockTimeout=0', 'update-ref', f.fullRef, f.oid],
          [1, 128]
        );
        expect(attempt.code).not.toBe(0);
      },
    });
    expect(result).toEqual({ commit: 'committed' });
    expect(
      (await runHistoryGit(f.cwd, ['rev-parse', '--verify', '--quiet', f.fullRef], [1])).code
    ).toBe(1);
  });

  it('uses one frozen sanitized environment for the transaction and prepared probes', async () => {
    const f = await fixture();
    const foreign = await fixture();
    vi.stubEnv('GIT_DIR', path.join(foreign.cwd, '.git'));
    vi.stubEnv('GIT_NAMESPACE', 'foreign');
    expect(await f.run(async () => {})).toEqual({ commit: 'committed' });
    vi.unstubAllEnvs();
    expect(
      (await runHistoryGit(f.cwd, ['rev-parse', '--verify', '--quiet', f.fullRef], [1])).code
    ).toBe(1);
    expect((await runHistoryGit(foreign.cwd, ['rev-parse', foreign.fullRef])).stdout.trim()).toBe(
      foreign.oid
    );
  });

  it('does not apply the Git protocol timeout to state-only validation', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = await f.run(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
        const attempt = await runHistoryGit(
          f.cwd,
          ['-c', 'core.filesRefLockTimeout=0', 'symbolic-ref', f.fullRef, f.branch],
          [1, 128]
        );
        expect(attempt.code).not.toBe(0);
      });
      expect(result).toEqual({ commit: 'committed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains received commit acknowledgment when cancellation interrupts child cleanup', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const { spawn } =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      child.stdout?.on('data', (bytes: Buffer) => {
        if (bytes.toString().includes('commit: ok')) controller.abort();
      });
      return child;
    }) as typeof spawn);
    const result = await f.run(async () => {}, controller.signal);
    expect(result).toMatchObject({ commit: 'committed', cleanupError: { name: 'AbortError' } });
    expect(
      (await runHistoryGit(f.cwd, ['rev-parse', '--verify', '--quiet', f.fullRef], [1])).code
    ).toBe(1);
    await runHistoryGit(f.cwd, [
      '-c',
      'core.filesRefLockTimeout=0',
      'update-ref',
      f.fullRef,
      f.oid,
    ]);
  });
});

describe('prepared Git ref updates', { timeout: 15_000 }, () => {
  it('holds every update target while validating and preserves the frozen replacement objects', async () => {
    const f = await fixture();
    await runHistoryGit(f.cwd, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'Next',
    ]);
    const next = (await runHistoryGit(f.cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    const second = 'refs/orcaops/next';
    const resources = [
      { fullRef: f.fullRef, expectedOid: f.oid, newOid: next },
      { fullRef: second, expectedOid: null, newOid: next },
    ];
    const result = await runPreparedGitRefUpdates({
      cwd: f.cwd,
      resources,
      validatePrepared: async () => {
        for (const resource of resources) {
          const attempt = await runHistoryGit(
            f.cwd,
            ['-c', 'core.filesRefLockTimeout=0', 'update-ref', resource.fullRef, f.oid],
            [1, 128]
          );
          expect(attempt.code).not.toBe(0);
          resource.newOid = f.oid;
        }
      },
    });
    expect(result).toEqual({ commit: 'committed' });
    for (const fullRef of [f.fullRef, second])
      expect((await runHistoryGit(f.cwd, ['rev-parse', fullRef])).stdout.trim()).toBe(next);
  });

  it('aborts the whole update when one target is a same-OID symbolic ref', async () => {
    const f = await fixture();
    const second = 'refs/orcaops/next';
    await runHistoryGit(f.cwd, ['symbolic-ref', f.fullRef, f.branch]);
    await expect(
      runPreparedGitRefUpdates({
        cwd: f.cwd,
        resources: [
          { fullRef: f.fullRef, expectedOid: f.oid, newOid: f.oid },
          { fullRef: second, expectedOid: null, newOid: f.oid },
        ],
        validatePrepared: async () => {},
      })
    ).rejects.toMatchObject({ code: 'GIT_RESOURCE_PROTECTED' });
    expect((await runHistoryGit(f.cwd, ['symbolic-ref', f.fullRef])).stdout.trim()).toBe(f.branch);
    expect(
      (await runHistoryGit(f.cwd, ['rev-parse', '--verify', '--quiet', second], [1])).code
    ).toBe(1);
  });

  it('preserves all refs when publication state validation rejects after preparation', async () => {
    const f = await fixture();
    const second = 'refs/orcaops/next';
    await expect(
      runPreparedGitRefUpdates({
        cwd: f.cwd,
        resources: [
          { fullRef: f.fullRef, expectedOid: f.oid, newOid: f.oid },
          { fullRef: second, expectedOid: null, newOid: f.oid },
        ],
        validatePrepared: async () => {
          throw new Error('Original publication changed');
        },
      })
    ).rejects.toThrow('Original publication changed');
    expect((await runHistoryGit(f.cwd, ['rev-parse', f.fullRef])).stdout.trim()).toBe(f.oid);
    expect(
      (await runHistoryGit(f.cwd, ['rev-parse', '--verify', '--quiet', second], [1])).code
    ).toBe(1);
    await runHistoryGit(f.cwd, ['-c', 'core.filesRefLockTimeout=0', 'update-ref', second, f.oid]);
  });
});
