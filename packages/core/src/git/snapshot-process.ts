import { spawn } from 'node:child_process';

import type { RunGitOptions, RunGitResult } from './snapshots.js';

export async function runBoundedSnapshotGit(
  cwd: string,
  args: string[],
  options: RunGitOptions
): Promise<RunGitResult> {
  const timeoutMs = options.commandTimeoutMs ?? 120_000;
  const maxBytes = options.maxStdoutBytes ?? 64 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 64 * 1024 * 1024
  )
    throw new Error('Provide a bounded snapshot command lifetime and output limit');
  const signal = options.signal;
  const cancelled = () =>
    Object.assign(new Error('Snapshot Git preparation cancelled'), { code: 'ABORT_ERR' });
  if (signal?.aborted) throw cancelled();
  const child = spawn('git', [...args], {
    cwd,
    env: { ...(options.env ?? process.env) },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const chunks: Buffer[] = [];
  let stdoutBytes = 0,
    stderr = '',
    truncated = false,
    failure: unknown,
    closed = false;
  const kill = () => {
    if (closed) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= cause;
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (truncated) return;
    if (stdoutBytes + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, Math.max(0, maxBytes - stdoutBytes)));
      stdoutBytes = maxBytes;
      truncated = true;
      failure ??= Object.assign(
        new Error('Snapshot Git output exceeded its bounded identity buffer'),
        { code: 'EFBIG' }
      );
      kill();
    } else {
      chunks.push(chunk);
      stdoutBytes += chunk.length;
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 1024 * 1024) {
      failure ??= new Error('Snapshot Git diagnostic output exceeded one MiB');
      kill();
    } else stderr += chunk;
  });
  child.stdin.on('error', (cause) => {
    failure ??= cause;
    kill();
  });
  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('error', (cause) => {
        failure ??= cause;
      });
      child.once('close', (code, childSignal) => {
        closed = true;
        resolve({ code, signal: childSignal });
      });
    }
  );
  const timer = setTimeout(() => {
    failure ??= Object.assign(
      new Error(
        `Snapshot Git command exceeded its ${timeoutMs} ms lifetime; retry explicitly after checking repository size and access`
      ),
      { code: 'ETIMEDOUT' }
    );
    kill();
  }, timeoutMs);
  signal?.addEventListener('abort', kill, { once: true });
  if (signal?.aborted) kill();
  child.stdin.end(options.stdin, 'utf8');
  const result = await finished;
  clearTimeout(timer);
  signal?.removeEventListener('abort', kill);
  if (signal?.aborted) throw cancelled();
  if (failure) throw failure;
  if (truncated)
    throw Object.assign(new Error('Snapshot Git output exceeded its bounded identity buffer'), {
      code: 'EFBIG',
    });
  return { ...result, stdout: Buffer.concat(chunks), stderr, truncated, killedByCap: truncated };
}
