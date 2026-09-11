import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

const execute = promisify(execFile);
export async function runDatabaseGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  allowedExitCodes: readonly number[] = []
): Promise<{ stdout: string; code: number }> {
  if (signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'Git setup inspection cancelled before starting');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  const pending = execute('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  const closed = new Promise<void>((resolve) => pending.child.once('close', () => resolve()));
  const cancel = () => {
    pending.child.kill('SIGKILL');
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const result = await pending;
    return { stdout: result.stdout, code: 0 };
  } catch (cause) {
    await closed;
    if (signal?.aborted)
      throw new ProjectDatabaseError(
        'CANCELLED',
        'Git setup inspection cancelled; its child has exited, and setup can be retried explicitly',
        { cause }
      );
    const failure = cause as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (
      typeof failure.code === 'number' &&
      allowedExitCodes.includes(failure.code) &&
      typeof failure.stdout === 'string' &&
      failure.stderr === ''
    )
      return { code: failure.code, stdout: failure.stdout };
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Git setup inspection failed or exceeded its five-second process limit; verify Git and repository access before retrying',
      { cause }
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
