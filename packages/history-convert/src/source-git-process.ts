import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { HistoryConversionError } from './errors.js';

const execute = promisify(execFile);
export async function runLegacyGit(
  cwd: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    allowedExitCodes?: readonly number[];
  } = {}
): Promise<{ stdout: string; code: number }> {
  const { signal } = options;
  signal?.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: '0' };
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
    signal?.throwIfAborted();
    return { stdout: result.stdout, code: 0 };
  } catch (cause) {
    await closed;
    signal?.throwIfAborted();
    const failure = cause as { code?: unknown; stdout?: unknown; killed?: boolean };
    if (
      !failure.killed &&
      typeof failure.code === 'number' &&
      options.allowedExitCodes?.includes(failure.code)
    )
      return {
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        code: failure.code,
      };
    throw new HistoryConversionError(
      'SOURCE_UNAVAILABLE',
      'Git source inspection failed or exceeded its five-second process limit; verify Git and repository access before retrying',
      cwd
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
