import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDatabaseGit } from './git-process.js';
import { inspectDatabaseSetup } from '../setup/inspection.js';

const execute = promisify(execFile);
const roots: string[] = [];
const pids = new Set<number>();
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* The observed child may already have exited. */
    }
  }
  pids.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'database-git-process-'));
  roots.push(root);
  const cwd = path.join(root, 'repository');
  await mkdir(cwd);
  await execute('git', ['-C', cwd, 'init', '-q']);
  return { root, cwd };
}
async function suspendGit(root: string) {
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const pidFile = path.join(root, 'git.pid');
  await writeFile(
    path.join(bin, 'git'),
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.kill(process.pid, 'SIGSTOP');\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 }
  );
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
  return async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const pid = Number(await readFile(pidFile, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          pids.add(pid);
          const observed = await execute('ps', ['-o', 'stat=', '-p', String(pid)]);
          if (observed.stdout.trim().startsWith('T')) return pid;
        }
      } catch {
        /* The disposable child has not published its PID yet. */
      }
      await delay(10);
    }
    throw new Error('Disposable Git child did not start');
  };
}
function expectExited(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow();
  pids.delete(pid);
}

describe('setup Git process lifetime', () => {
  it('reads a real repository and refuses pre-cancelled inspection before spawning', async () => {
    const f = await fixture();
    expect(
      (await runDatabaseGit(f.cwd, ['rev-parse', '--is-inside-work-tree'])).stdout.trim()
    ).toBe('true');
    await expect(
      runDatabaseGit(f.cwd, ['rev-parse', '--git-dir'], AbortSignal.abort())
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await readdir(f.root)).toEqual(['repository']);
  });
  it('cancels a suspended Git child through setup inspection and waits for its exit', async () => {
    const f = await fixture();
    const started = await suspendGit(f.root);
    const controller = new AbortController();
    const pending = inspectDatabaseSetup(
      { cwd: f.cwd, root: path.join(f.root, 'history') },
      { signal: controller.signal }
    ).catch((cause: unknown) => cause);
    const pid = await started();
    controller.abort();
    expect(await pending).toMatchObject({ code: 'CANCELLED' });
    expectExited(pid);
    expect(await readdir(f.root)).not.toContain('history');
  });
  it('times out a suspended Git child and retains an actionable passive failure', async () => {
    const f = await fixture();
    const started = await suspendGit(f.root);
    const pending = inspectDatabaseSetup({ cwd: f.cwd, root: path.join(f.root, 'history') }).catch(
      (cause: unknown) => cause
    );
    const pid = await started();
    expect(await pending).toMatchObject({
      code: 'HISTORY_INACCESSIBLE',
      message: expect.stringContaining('five-second'),
    });
    expectExited(pid);
    expect(await readdir(f.root)).not.toContain('history');
    vi.unstubAllEnvs();
    expect(
      (await runDatabaseGit(f.cwd, ['rev-parse', '--is-inside-work-tree'])).stdout.trim()
    ).toBe('true');
  }, 10000);
});

it('distinguishes an explicitly expected negative Git result from command failure', async () => {
  const f = await fixture();
  expect(
    await runDatabaseGit(
      f.cwd,
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      undefined,
      [1]
    )
  ).toEqual({ code: 1, stdout: '' });
  await expect(
    runDatabaseGit(f.cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
  await expect(
    runDatabaseGit(f.cwd, ['definitely-not-a-git-command'], undefined, [1])
  ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
});
