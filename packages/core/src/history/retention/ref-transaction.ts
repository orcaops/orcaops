import { spawn } from 'node:child_process';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { retentionCancelled, retentionGitEnvironment, runRetentionGit } from './git-process.js';
import {
  type RegisteredDatabaseContext,
  revalidateDatabaseExecutionContext,
} from '../context/execution.js';

async function retentionRefTransaction(
  context: RegisteredDatabaseContext,
  resource: { fullRef: string; objectOid: string },
  action: 'create' | 'remove',
  signal?: AbortSignal
): Promise<{ commit: 'committed'; cleanupError?: unknown }> {
  const cwd = context.git.worktreeRoot;
  if (
    /\s/.test(resource.fullRef) ||
    !resource.fullRef.startsWith('refs/orcaops/') ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(resource.objectOid)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide an exact immutable retention ref and object ID'
    );
  retentionCancelled(signal);
  const child = spawn(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'core.fsync=reference',
      '-c',
      'core.fsyncMethod=fsync',
      '-c',
      'core.filesRefLockTimeout=2000',
      'update-ref',
      '--no-deref',
      '--stdin',
    ],
    {
      env: retentionGitEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }
  );
  let closed = false;
  let commitSent = false;
  let commitAcknowledged = false;
  let operationError: unknown;
  let code: number | null = null;
  let failure: unknown;
  let output = '';
  let stderr = '';
  let received = 0;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let notify: (() => void) | undefined;
  let rejectLifetime: (cause: unknown) => void = () => {};
  const lifetime = new Promise<never>((_resolve, reject) => {
    rejectLifetime = reject;
  });
  void lifetime.catch(() => {});
  const lines: string[] = [];
  const fail = (cause: unknown) => {
    failure ??= cause;
    rejectLifetime(failure);
    notify?.();
  };
  const terminate = (signal: NodeJS.Signals) => {
    if (closed) return;
    if (signal === 'SIGTERM' && !escalation)
      escalation = setTimeout(() => terminate('SIGKILL'), 1000);
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') fail(cause);
    }
  };
  const done = new Promise<void>((resolve) => {
    child.on('error', fail);
    child.once('close', (exitCode) => {
      closed = true;
      code = exitCode;
      rejectLifetime(failure ?? new Error('Git transaction exited during validation'));
      notify?.();
      resolve();
    });
  });
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    received += Buffer.byteLength(chunk);
    if (received > 4096) {
      fail(new Error('Git transaction acknowledgment exceeds its bounded protocol'));
      terminate('SIGTERM');
      return;
    }
    output += chunk;
    let end: number;
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end).replace(/\r$/, '');
      if (commitSent && line === 'commit: ok') commitAcknowledged = true;
      lines.push(line);
      output = output.slice(end + 1);
    }
    notify?.();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(0, 65536);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const armProtocolTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      fail(new Error('Git ref transaction protocol did not respond'));
      terminate('SIGTERM');
    }, 5000);
  };
  const aborted = () => {
    fail(signal?.reason ?? new Error('Git transaction aborted'));
    terminate('SIGTERM');
  };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  const lifetimeLimit = setTimeout(() => {
    fail(new Error('Git ref transaction exceeded its fifteen-second lifetime'));
    terminate('SIGKILL');
  }, 15_000);
  const acknowledge = async (expected: string) => {
    armProtocolTimeout();
    try {
      while (!failure && !closed && lines.length === 0)
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      notify = undefined;
      if (failure) throw failure;
      const actual = lines.shift();
      if (actual !== expected)
        throw new ProjectDatabaseError(
          'HISTORY_INACCESSIBLE',
          `Git transaction did not acknowledge ${expected}: ${stderr.trim()}. Preserve existing Git lock files; inspect their ownership and use explicit Git repair before retrying the original operation`
        );
    } finally {
      clearTimeout(timeout);
    }
  };
  const send = (text: string) => {
    if (failure) throw failure;
    if (closed || !child.stdin.writable) throw new Error('Git transaction closed before command');
    child.stdin.write(text);
  };
  try {
    send('start\n');
    await acknowledge('start: ok');
    send(
      action === 'create'
        ? `update ${resource.fullRef} ${resource.objectOid} ${'0'.repeat(resource.objectOid.length)}\nprepare\n`
        : `delete ${resource.fullRef} ${resource.objectOid}\nprepare\n`
    );
    await acknowledge('prepare: ok');
    const symbolic = await Promise.race([
      runRetentionGit(cwd, ['symbolic-ref', '--quiet', resource.fullRef], {
        signal,
        allowedExitCodes: [1],
      }),
      lifetime,
    ]);
    if (symbolic.code === 0)
      throw new ProjectDatabaseError(
        'HISTORY_UNEXPECTED_OWNER',
        'The prepared immutable ref is symbolic; preserve it and inspect its original ownership'
      );
    const actual = await Promise.race([
      runRetentionGit(cwd, ['rev-parse', '--verify', '--quiet', resource.fullRef], {
        signal,
        allowedExitCodes: [1],
      }),
      lifetime,
    ]);
    if (
      (actual.code === 0 ? actual.stdout.trim() : null) !==
      (action === 'create' ? null : resource.objectOid)
    )
      throw new ProjectDatabaseError(
        'HISTORY_UNEXPECTED_OWNER',
        'The prepared immutable ref differs from its exact expected state; preserve it and inspect the original operation'
      );
    await Promise.race([revalidateDatabaseExecutionContext(context, { signal }), lifetime]);
    retentionCancelled(signal);
    if (failure || closed)
      throw failure ?? new Error('Prepared Git transaction ended before commit');
    commitSent = true;
    send('commit\n');
    await acknowledge('commit: ok');
    child.stdin.end();
    armProtocolTimeout();
    await done;
    if (failure || code !== 0 || output || lines.length)
      throw (
        failure ??
        new ProjectDatabaseError(
          'HISTORY_INACCESSIBLE',
          `Git transaction ended without a clean commit acknowledgment: ${stderr.trim()}`
        )
      );
  } catch (cause) {
    operationError = cause;
  } finally {
    clearTimeout(timeout);
    clearTimeout(lifetimeLimit);
    signal?.removeEventListener('abort', aborted);
    if (!closed && child.stdin.writable) child.stdin.end('abort\n');
    const gentle = setTimeout(() => terminate('SIGTERM'), 500);
    const forced = setTimeout(() => terminate('SIGKILL'), 1000);
    await done;
    clearTimeout(gentle);
    clearTimeout(forced);
    clearTimeout(escalation);
  }
  if (commitAcknowledged)
    return {
      commit: 'committed',
      ...((operationError ?? failure) === undefined
        ? {}
        : { cleanupError: operationError ?? failure }),
    };
  retentionCancelled(signal);
  throw (
    operationError ??
    new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Git commit acknowledgment is unavailable')
  );
}

export function createRetentionRef(
  context: RegisteredDatabaseContext,
  resource: { fullRef: string; objectOid: string },
  signal?: AbortSignal
) {
  return retentionRefTransaction(context, resource, 'create', signal);
}
export function removeRetentionRef(
  context: RegisteredDatabaseContext,
  resource: { fullRef: string; objectOid: string },
  signal?: AbortSignal
) {
  return retentionRefTransaction(context, resource, 'remove', signal);
}
