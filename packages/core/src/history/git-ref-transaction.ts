import { spawn } from 'node:child_process';

import { GitOidSchema, ManagedGitRefSchema } from '@orcaops/storage/history/git-ref-schema';
import { HistoryPersistenceError } from '@orcaops/storage/history/primitives';

import { runHistoryGit } from './git-context.js';

interface PreparedGitRefTransaction {
  cwd: string;
  signal?: AbortSignal;
  validatePrepared: () => Promise<void>;
}
interface PreparedGitRefResult {
  commit: 'committed';
  cleanupError?: unknown;
}
export function runPreparedGitRefDeletion(
  input: PreparedGitRefTransaction & { fullRef: string; expectedOid: string | null }
): Promise<PreparedGitRefResult> {
  return runPreparedGitRefTransaction({
    ...input,
    resources: [{ fullRef: input.fullRef, expectedOid: input.expectedOid, newOid: null }],
  });
}
export function runPreparedGitRefUpdates(
  input: PreparedGitRefTransaction & {
    resources: readonly { fullRef: string; expectedOid: string | null; newOid: string }[];
  }
): Promise<PreparedGitRefResult> {
  return runPreparedGitRefTransaction(input);
}
async function runPreparedGitRefTransaction(
  input: PreparedGitRefTransaction & {
    resources: readonly { fullRef: string; expectedOid: string | null; newOid: string | null }[];
  }
): Promise<PreparedGitRefResult> {
  const { cwd, signal, validatePrepared } = input;
  const resources = input.resources.map((resource) => ({
    fullRef: ManagedGitRefSchema.parse(resource.fullRef),
    expectedOid: resource.expectedOid === null ? null : GitOidSchema.parse(resource.expectedOid),
    newOid: resource.newOid === null ? null : GitOidSchema.parse(resource.newOid),
  }));
  if (
    !resources.length ||
    new Set(resources.map((resource) => resource.fullRef)).size !== resources.length
  )
    throw new HistoryPersistenceError(
      'INVALID_INPUT',
      'Git transaction requires distinct ref targets'
    );
  signal?.throwIfAborted();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const child = spawn(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'core.fsync=reference',
      '-c',
      'core.fsyncMethod=fsync',
      'update-ref',
      '--no-deref',
      '--stdin',
    ],
    {
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
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
  const lines: string[] = [];
  const fail = (cause: unknown) => {
    failure ??= cause;
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
    }, 15_000);
  };
  const aborted = () => {
    fail(signal?.reason ?? new Error('Git transaction aborted'));
    terminate('SIGTERM');
  };
  signal?.addEventListener('abort', aborted, { once: true });
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
        throw new HistoryPersistenceError(
          'GIT_REF_TRANSACTION_FAILED',
          `Git transaction did not acknowledge ${expected}: ${stderr.trim()}`
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
      resources
        .map(({ fullRef, expectedOid, newOid }) =>
          newOid !== null
            ? `update ${fullRef} ${newOid} ${expectedOid ?? '0'.repeat(newOid.length)}\n`
            : expectedOid === null
              ? `verify ${fullRef}\n`
              : `delete ${fullRef} ${expectedOid}\n`
        )
        .join('') + 'prepare\n'
    );
    await acknowledge('prepare: ok');
    for (const { fullRef, expectedOid } of resources) {
      if ((await runHistoryGit(cwd, ['symbolic-ref', '--quiet', fullRef], [1], env)).code === 0)
        throw new HistoryPersistenceError(
          'GIT_RESOURCE_PROTECTED',
          'Prepared managed ref is symbolic'
        );
      const actual = await runHistoryGit(
        cwd,
        ['rev-parse', '--verify', '--quiet', fullRef],
        [1],
        env
      );
      if ((actual.code === 0 ? actual.stdout.trim() : null) !== expectedOid)
        throw new HistoryPersistenceError(
          'GIT_RESOURCE_PROTECTED',
          'Prepared managed ref differs from its expected object ID'
        );
    }
    await validatePrepared();
    signal?.throwIfAborted();
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
        new HistoryPersistenceError(
          'GIT_REF_TRANSACTION_FAILED',
          `Git transaction ended without a clean commit acknowledgment: ${stderr.trim()}`
        )
      );
  } catch (cause) {
    operationError = cause;
  } finally {
    clearTimeout(timeout);
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
  throw (
    operationError ??
    new HistoryPersistenceError(
      'GIT_REF_TRANSACTION_FAILED',
      'Git commit acknowledgment is unavailable'
    )
  );
}
