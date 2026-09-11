import { type ChildProcess, execFile, fork } from 'node:child_process';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import type { DatabaseSetupResult, DatabaseSetupWait } from './setup.js';
import { setupProjectDatabase } from './setup.js';

type Message = {
  type: string;
  result?: DatabaseSetupResult;
  wait?: DatabaseSetupWait;
  code?: string;
  message?: string;
};
const exec = promisify(execFile);
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    })
  );
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function start(input: object, pauseEmpty: boolean, pauseWaitAttempts: number[] = []) {
  const controlDirectory = mkdtempSync(path.join(tmpdir(), 'setup-control-'));
  roots.push(controlDirectory);
  const child = fork(
    fileURLToPath(new URL('./fixtures/setup-child.mjs', import.meta.url)),
    [
      JSON.stringify({
        input,
        pauseEmpty,
        pauseWaitAttempts,
        controlDirectory,
        module: new URL('../../../dist/history/setup/setup.js', import.meta.url).href,
      }),
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  children.push(child);
  const messages: Message[] = [];
  const listeners = new Set<() => void>();
  let diagnostics = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  child.on('message', (message) => {
    messages.push(message as Message);
    for (const listener of listeners) listener();
  });
  child.on('exit', () => {
    for (const listener of listeners) listener();
  });
  async function wait(type: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(
            new Error(`Timed out waiting for ${type}: ${JSON.stringify(messages)} ${diagnostics}`)
          ),
        8000
      );
      function finish(error?: Error, message?: Message) {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error);
        else resolve(message!);
      }
      function check() {
        const message = messages.find((value) => value.type === type);
        if (message) finish(undefined, message);
        else if (
          messages.some((value) => value.type === 'error') ||
          child.exitCode !== null ||
          child.signalCode !== null
        )
          finish(
            new Error(`Child ended before ${type}: ${JSON.stringify(messages)} ${diagnostics}`)
          );
      }
      listeners.add(check);
      check();
    });
  }
  function resume(type: string) {
    writeFileSync(path.join(controlDirectory, type), '', { flag: 'wx' });
  }
  return { child, wait, resume };
}
async function contenders() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-setup-process-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repository');
  await mkdir(cwd);
  await exec('git', ['-C', cwd, 'init', '-q']);
  const input = {
    cwd,
    root: path.join(directory, 'history'),
    projectId: uuidv7(),
    authoredPayloads: [],
    secretAllow: [],
  };
  const winner = start(input, true);
  await winner.wait('before-project-directory');
  const contender = start(input, false);
  await contender.wait('before-project-directory');
  winner.resume('before-project-directory');
  await winner.wait('empty-created');
  const file = path.join(input.root, 'projects', input.projectId, 'history.sqlite3');
  const identity = await stat(file, { bigint: true });
  expect(identity.size).toBe(0n);
  contender.resume('before-project-directory');
  const wait = (await contender.wait('wait')).wait;
  expect(wait).toMatchObject({ operation: 'initialize project history', attempt: 1 });
  return { winner, contender, input, file, identity };
}

async function repository(directory: string, name: string) {
  const cwd = path.join(directory, name);
  await mkdir(cwd);
  await exec('git', ['-C', cwd, 'init', '-q']);
  return cwd;
}

describe('setup process collisions', () => {
  it('retains an early release for its named pause without releasing another boundary', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-setup-process-')));
    roots.push(directory);
    const input = {
      cwd: await repository(directory, 'repository'),
      root: path.join(directory, 'history'),
      projectId: uuidv7(),
      authoredPayloads: [],
      secretAllow: [],
    };
    const initializer = start(input, true);
    initializer.resume('empty-created');
    await initializer.wait('before-project-directory');
    await expect(stat(path.join(input.root, 'projects', input.projectId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    initializer.resume('before-project-directory');
    expect((await initializer.wait('result')).result?.status).toBe('complete');
  }, 15000);
  it('waits visibly for a suspended initializer and adopts its committed original identity', async () => {
    const f = await contenders();
    f.winner.resume('empty-created');
    const winner = (await f.winner.wait('result')).result;
    const contender = (await f.contender.wait('result')).result;
    expect(winner?.status).toBe('complete');
    expect(contender).toEqual(winner);
    expect(await setupProjectDatabase(f.input)).toEqual(winner);
  }, 15000);
  it('cancels a waiting contender without replacing the suspended initialization', async () => {
    const f = await contenders();
    f.contender.child.send('cancel');
    expect(await f.contender.wait('error')).toMatchObject({ code: 'CANCELLED' });
    const pending = await stat(f.file, { bigint: true });
    expect([pending.dev, pending.ino, pending.size]).toEqual([f.identity.dev, f.identity.ino, 0n]);
    f.winner.resume('empty-created');
    const winner = (await f.winner.wait('result')).result;
    expect(winner?.status).toBe('complete');
    expect(await setupProjectDatabase(f.input)).toEqual(winner);
  }, 15000);
  it('returns pending after a bounded wait and lets the original initializer finish', async () => {
    const f = await contenders();
    expect(await f.contender.wait('error')).toMatchObject({ code: 'ACTIVATION_PENDING' });
    const pending = await stat(f.file, { bigint: true });
    expect([pending.dev, pending.ino, pending.size]).toEqual([f.identity.dev, f.identity.ino, 0n]);
    f.winner.resume('empty-created');
    const winner = (await f.winner.wait('result')).result;
    expect(winner?.status).toBe('complete');
    expect(await setupProjectDatabase(f.input)).toEqual(winner);
  }, 15000);
  it('continues after an observed initializer settles for another repository', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-setup-process-')));
    roots.push(directory);
    const root = path.join(directory, 'history');
    const foreign = start(
      {
        cwd: await repository(directory, 'foreign'),
        root,
        projectId: uuidv7(),
        authoredPayloads: [],
        secretAllow: [],
      },
      true
    );
    await foreign.wait('before-project-directory');
    foreign.resume('before-project-directory');
    await foreign.wait('empty-created');

    let resumed = false;
    const local = setupProjectDatabase(
      {
        cwd: await repository(directory, 'local'),
        root,
        authoredPayloads: [],
        secretAllow: [],
      },
      {
        onWait() {
          if (resumed) return;
          resumed = true;
          foreign.resume('empty-created');
        },
      }
    );
    expect((await foreign.wait('result')).result?.status).toBe('complete');
    expect((await local).status).toBe('complete');
  }, 15000);
  it('refuses to replace an observed initializer that disappears', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-setup-process-')));
    roots.push(directory);
    const root = path.join(directory, 'history');
    const projectId = uuidv7();
    const foreign = start(
      {
        cwd: await repository(directory, 'foreign'),
        root,
        projectId,
        authoredPayloads: [],
        secretAllow: [],
      },
      true
    );
    await foreign.wait('before-project-directory');
    foreign.resume('before-project-directory');
    await foreign.wait('empty-created');

    let removed = false;
    const local = setupProjectDatabase(
      {
        cwd: await repository(directory, 'local'),
        root,
        authoredPayloads: [],
        secretAllow: [],
      },
      {
        onWait() {
          if (removed) return;
          removed = true;
          rmSync(path.join(root, 'projects', projectId), { recursive: true });
          foreign.child.kill('SIGKILL');
        },
      }
    );
    await expect(local).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  }, 15000);
  it('refuses a replacement initializer that reuses an observed project identity', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-setup-process-')));
    roots.push(directory);
    const root = path.join(directory, 'history');
    const foreignProjectId = uuidv7();
    const localProjectId = uuidv7();
    const foreignInput = {
      cwd: await repository(directory, 'foreign'),
      root,
      projectId: foreignProjectId,
      authoredPayloads: [],
      secretAllow: [],
    };
    const first = start(foreignInput, true);
    await first.wait('before-project-directory');
    first.resume('before-project-directory');
    await first.wait('empty-created');
    const file = path.join(root, 'projects', foreignProjectId, 'history.sqlite3');
    const firstIdentity = await stat(file, { bigint: true });

    const local = start(
      {
        cwd: await repository(directory, 'local'),
        root,
        projectId: localProjectId,
        authoredPayloads: [],
        secretAllow: [],
      },
      false,
      [1]
    );
    await local.wait('wait-1');
    rmSync(path.join(root, 'projects', foreignProjectId), { recursive: true });
    first.child.kill('SIGKILL');

    const replacement = start(foreignInput, true);
    await replacement.wait('before-project-directory');
    replacement.resume('before-project-directory');
    await replacement.wait('empty-created');
    const replacementIdentity = await stat(file, { bigint: true });
    expect([replacementIdentity.dev, replacementIdentity.ino]).not.toEqual([
      firstIdentity.dev,
      firstIdentity.ino,
    ]);

    local.resume('wait-1');
    expect(await local.wait('error')).toMatchObject({ code: 'HISTORY_MISSING' });
    await expect(
      stat(path.join(root, 'projects', localProjectId), { bigint: true })
    ).rejects.toMatchObject({ code: 'ENOENT' });
    replacement.resume('empty-created');
    expect((await replacement.wait('result')).result?.status).toBe('complete');
  }, 20000);
  it('retains a database that appears after its project directory is observed', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'database-setup-process-')));
    roots.push(directory);
    const root = path.join(directory, 'history');
    const foreignProjectId = uuidv7();
    const foreign = await setupProjectDatabase({
      cwd: await repository(directory, 'foreign'),
      root,
      projectId: foreignProjectId,
      authoredPayloads: [],
      secretAllow: [],
    });
    expect(foreign.status).toBe('complete');
    const file = path.join(root, 'projects', foreignProjectId, 'history.sqlite3');
    const retained = path.join(directory, 'retained-history.sqlite3');
    await rename(file, retained);

    const lstat = fs.promises.lstat;
    let injected = false;
    const interceptLstat = async (
      candidate: Parameters<typeof lstat>[0],
      options?: Parameters<typeof lstat>[1]
    ) => {
      try {
        return await lstat(candidate, options);
      } catch (cause) {
        if (
          !injected &&
          path.resolve(candidate.toString()) === file &&
          (cause as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          injected = true;
          await writeFile(file, Buffer.alloc(0));
        }
        throw cause;
      }
    };
    fs.promises.lstat = interceptLstat as typeof fs.promises.lstat;
    syncBuiltinESMExports();
    const localProjectId = uuidv7();
    try {
      let replaced = false;
      const local = setupProjectDatabase(
        {
          cwd: await repository(directory, 'local'),
          root,
          projectId: localProjectId,
          authoredPayloads: [],
          secretAllow: [],
        },
        {
          onWait() {
            if (replaced) return;
            replaced = true;
            rmSync(file);
            fs.renameSync(retained, file);
          },
        }
      );
      await expect(local).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
      expect(injected).toBe(true);
      await expect(
        stat(path.join(root, 'projects', localProjectId), { bigint: true })
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fs.promises.lstat = lstat;
      syncBuiltinESMExports();
    }
  }, 15000);
});
