import * as childProcess from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { Repo } from './repo.js';
import { captureWorktreeTree, runGit } from './snapshots.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

const repositories: TempRepo[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});
async function fixture() {
  const repo = await createTempRepo({ initialBranch: 'main' });
  repositories.push(repo);
  return repo;
}
async function processId(file: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const pid = Number((await readFile(file, 'utf8')).trim());
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    await delay(10);
  }
  throw new Error('Owned fixture child did not report its process identity');
}
async function expectExited(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (cause) {
      expect(cause).toMatchObject({ code: 'ESRCH' });
      return;
    }
    await delay(10);
  }
  throw new Error('Owned fixture child survived bounded command completion');
}
const suspended = ['-c', 'alias.pause=!sh -c \'echo $$ > "$PROBE_PID"; kill -STOP $$\'', 'pause'];
it('runs ordinary bounded Git commands and refuses invalid limits before spawning', async () => {
  const f = await fixture();
  const result = await runGit(f.path, ['rev-parse', 'HEAD'], { commandTimeoutMs: 120_000 });
  expect(result).toMatchObject({ code: 0, truncated: false });
  expect(result.stdout.toString().trim()).toMatch(/^[a-f0-9]{40}$/);
  const spawn = vi.spyOn(childProcess, 'spawn');
  await expect(runGit(f.path, ['status'], { commandTimeoutMs: 0 })).rejects.toThrow('bounded');
  await expect(runGit(f.path, ['status'], { signal: AbortSignal.abort() })).rejects.toMatchObject({
    code: 'ABORT_ERR',
  });
  expect(spawn).not.toHaveBeenCalled();
});
it('times out and reaps its suspended Git child group', async () => {
  const f = await fixture();
  const file = path.join(f.path, '.git', 'owned-process');
  const promise = runGit(f.path, suspended, {
    commandTimeoutMs: 1000,
    env: { ...process.env, PROBE_PID: file },
  });
  const rejected = expect(promise).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  const pid = await processId(file);
  await rejected;
  await expectExited(pid);
});
it('cancels and reaps its suspended Git child group without waiting for the deadline', async () => {
  const f = await fixture();
  const file = path.join(f.path, '.git', 'owned-process');
  const controller = new AbortController();
  const promise = runGit(f.path, suspended, {
    commandTimeoutMs: 120_000,
    signal: controller.signal,
    env: { ...process.env, PROBE_PID: file },
  });
  const rejected = expect(promise).rejects.toMatchObject({ code: 'ABORT_ERR' });
  const pid = await processId(file);
  controller.abort();
  await rejected;
  await expectExited(pid);
});
it('refuses truncated object output instead of returning a successful partial result', async () => {
  const f = await fixture();
  await expect(
    runGit(f.path, ['rev-parse', 'HEAD'], {
      commandTimeoutMs: 120_000,
      maxStdoutBytes: 4,
    })
  ).rejects.toMatchObject({ code: 'EFBIG' });
});
it('cancels an actual snapshot filter before cleaning its owned index and leaves the real index intact', async () => {
  const f = await fixture();
  const pidFile = path.join(f.path, '.git', 'filter-process');
  const script = path.join(f.path, '.git', 'filter.sh');
  await writeFile(
    script,
    '#!/bin/sh\necho $$ > "$(dirname "$0")/filter-process"\nkill -STOP $$\ncat\n',
    { mode: 0o700 }
  );
  childProcess.execFileSync('git', ['-C', f.path, 'config', 'filter.paused.clean', `"${script}"`]);
  await writeFile(path.join(f.path, '.gitattributes'), 'README.md filter=paused\n');
  await writeFile(path.join(f.path, 'README.md'), 'Changed snapshot bytes\n');
  const index = await readFile(path.join(f.path, '.git', 'index'));
  const spawn = vi.spyOn(childProcess, 'spawn');
  const controller = new AbortController();
  const promise = captureWorktreeTree(new Repo(f.path), 'bounded snapshot', {
    durableObjects: true,
    commandTimeoutMs: 120_000,
    signal: controller.signal,
  });
  const pid = await processId(pidFile);
  controller.abort();
  const result = await promise;
  expect(result).toMatchObject({ ok: false, error_reason: 'unknown' });
  await expectExited(pid);
  expect(await readFile(path.join(f.path, '.git', 'index'))).toEqual(index);
  const owned = spawn.mock.calls
    .map((call) => (call[2] as childProcess.SpawnOptions)?.env?.GIT_INDEX_FILE)
    .filter((value): value is string => typeof value === 'string');
  expect(owned.length).toBeGreaterThan(0);
  for (const file of new Set(owned)) {
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(file + '.lock')).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
