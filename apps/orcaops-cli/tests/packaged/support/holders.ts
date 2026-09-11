import { type ChildProcess, execFile, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

import { registerCleanup } from './cleanup.js';
import { children as childScripts } from './paths.js';
import type { DisposableRoot } from './roots.js';

const execute = promisify(execFile);
const held = new Set<ChildProcess>();

registerCleanup('children', async () => {
  await Promise.all(
    [...held].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGCONT');
      child.kill('SIGKILL');
      await exited;
    })
  );
  held.clear();
});

export type SuspendableHolder = {
  pid: number;
  suspend(): void;
  resume(): void;
  /** Ask the holder to roll back and exit; resolves with its exit code and signal. */
  release(): Promise<[number | null, NodeJS.Signals | null]>;
  kill(signal: NodeJS.Signals): void;
  exited: Promise<[number | null, NodeJS.Signals | null]>;
};

/** A second OS process holding BEGIN IMMEDIATE on the project database. */
export async function holdWriteLock(
  root: DisposableRoot,
  databaseFile: string
): Promise<SuspendableHolder> {
  const child = fork(childScripts.sqliteHolder, [databaseFile], {
    cwd: root.repo,
    env: root.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  held.add(child);
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  void exited.then(() => held.delete(child));
  const [message] = (await Promise.race([
    once(child, 'message'),
    exited.then(([code, signal]) => {
      throw new Error(`Holder exited before taking the lock: ${code} ${signal}`);
    }),
  ])) as [{ kind: string; pid: number }];
  if (message.kind !== 'holding') throw new Error(`Unexpected holder message ${message.kind}`);
  return {
    pid: message.pid,
    suspend: () => void child.kill('SIGSTOP'),
    resume: () => void child.kill('SIGCONT'),
    kill: (signal) => void child.kill(signal),
    async release() {
      child.send('release');
      return exited;
    },
    exited,
  };
}

export type RefTransactionHolder = {
  pid: number;
  ref: string;
  /** Commit the prepared transaction and let the ref land. */
  commit(): Promise<[number | null, NodeJS.Signals | null]>;
  /** Abort by closing stdin without committing. */
  abort(): Promise<[number | null, NodeJS.Signals | null]>;
  exited: Promise<[number | null, NodeJS.Signals | null]>;
};

/**
 * A real `git update-ref --stdin` process parked at `prepare: ok`, which holds the
 * reference-transaction lock until it is told to commit — the same lever the core
 * retention controls use, driven here against a disposable repository.
 */
export async function holdRefTransaction(
  root: DisposableRoot,
  cwd: string,
  ref: string
): Promise<RefTransactionHolder> {
  const { stdout } = await execute('git', ['-C', cwd, 'rev-parse', 'HEAD'], { env: root.env });
  const oid = stdout.trim();
  const child = spawn('git', ['-C', cwd, 'update-ref', '--stdin'], {
    env: root.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  held.add(child);
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  void exited.then(() => held.delete(child));
  let output = '';
  let diagnostics = '';
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    diagnostics += chunk;
  });
  const prepared = new Promise<void>((resolve, reject) => {
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('prepare: ok\n')) resolve();
    });
    void exited.then(([code, signal]) =>
      reject(new Error(`Ref holder exited ${code} ${signal}: ${diagnostics}`))
    );
  });
  child.stdin!.on('error', () => {});
  child.stdin!.write(`start\nupdate ${ref} ${oid} ${'0'.repeat(40)}\nprepare\n`);
  await prepared;
  return {
    pid: child.pid!,
    ref,
    async commit() {
      child.stdin!.write('commit\n');
      child.stdin!.end();
      return exited;
    },
    async abort() {
      child.stdin!.end();
      return exited;
    },
    exited,
  };
}
