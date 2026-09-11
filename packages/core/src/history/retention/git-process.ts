import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

export function retentionGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE: '0',
    GIT_TRACE2: '0',
    GIT_TRACE2_PERF: '0',
    GIT_TRACE2_EVENT: '0',
  };
}
export function retentionCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Git retention cancelled; preserve any publication and retry only its original authorized operation'
    );
}
export function retentionGitUnavailable(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INACCESSIBLE',
    'Git retention could not establish its exact durable publication; preserve unused refs and retry the original authorized operation after checking Git and storage access',
    { cause }
  );
}
export async function runRetentionGit(
  cwd: string,
  args: readonly string[],
  options: {
    signal?: AbortSignal;
    input?: Uint8Array;
    traceFlush?: boolean;
    allowedExitCodes?: readonly number[];
  } = {}
): Promise<{ stdout: string; code: number; hardwareFlushes: number }> {
  const { signal, traceFlush } = options;
  const input = options.input === undefined ? undefined : Buffer.from(options.input);
  const allowed = [...(options.allowedExitCodes ?? [])];
  retentionCancelled(signal);
  const child = spawn('git', ['-C', cwd, ...args], {
    env: { ...retentionGitEnvironment(), GIT_TRACE2_EVENT: traceFlush ? '3' : '0' },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let output = '',
    stderr = '',
    trace = '';
  let bytes = 0;
  let failure: unknown;
  let closed = false;
  const kill = () => {
    if (closed) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= cause;
    }
  };
  const accept = (field: 'stdout' | 'stderr' | 'trace', chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024 * 1024) {
      failure ??= new Error('Git retention exceeded its bounded output');
      kill();
      return;
    }
    if (field === 'stdout') output += chunk;
    else if (field === 'stderr') stderr += chunk;
    else trace += chunk;
  };
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => accept('stdout', chunk));
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => accept('stderr', chunk));
  (child.stdio[3] as Readable)
    .setEncoding('utf8')
    .on('data', (chunk: string) => accept('trace', chunk));
  child.stdin!.on('error', (cause) => {
    failure ??= cause;
    kill();
  });
  const done = new Promise<number | null>((resolve) => {
    child.once('error', (cause) => {
      failure ??= cause;
    });
    child.once('close', (code) => {
      closed = true;
      resolve(code);
    });
  });
  const timeout = setTimeout(() => {
    failure ??= new Error('Git retention exceeded its five-second process limit');
    kill();
  }, 5000);
  signal?.addEventListener('abort', kill, { once: true });
  if (signal?.aborted) kill();
  child.stdin!.end(input);
  const code = await done;
  clearTimeout(timeout);
  signal?.removeEventListener('abort', kill);
  retentionCancelled(signal);
  if (failure || code === null || (code !== 0 && (!allowed.includes(code) || stderr !== '')))
    retentionGitUnavailable(failure ?? new Error(`Git exited ${code}: ${stderr.trim()}`));
  let hardwareFlushes = 0;
  if (traceFlush) {
    try {
      for (const line of trace.split('\n').filter(Boolean)) {
        const event = JSON.parse(line) as {
          event?: string;
          category?: string;
          key?: string;
          value?: string;
          name?: string;
          count?: number;
        };
        const counter = event.event === 'counter' && event.name === 'hardware-flush';
        if (event.category === 'fsync' && (counter || event.key === 'fsync/hardware-flush')) {
          const count = Number(counter ? event.count : event.value);
          if (!Number.isSafeInteger(count) || count < 0)
            throw new Error('Invalid Git flush counter');
          hardwareFlushes += count;
        }
      }
    } catch (cause) {
      retentionGitUnavailable(cause);
    }
  }
  return { stdout: output, code, hardwareFlushes };
}
