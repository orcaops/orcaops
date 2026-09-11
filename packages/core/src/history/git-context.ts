import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { promisify } from 'node:util';

import { HistoryError } from '@orcaops/storage/history/authority';

const exec = promisify(execFile);

export async function runHistoryGit(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [],
  environment: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; code: number }> {
  const env: NodeJS.ProcessEnv = { ...environment, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  try {
    const result = await exec('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: result.stdout, code: 0 };
  } catch (cause) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code === 'number' && allowedExitCodes.includes(failure.code))
      return { stdout: failure.stdout ?? '', code: failure.code };
    throw new HistoryError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Cannot resolve current Git administration',
      { cwd, args, cause }
    );
  }
}

export async function readGitAdministrativeText(file: string): Promise<string> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024)
    throw new HistoryError(
      'IDENTITY_RECOVERY_REQUIRED',
      'Git administrative pointer is not a bounded regular file',
      { path: file }
    );
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new HistoryError(
        'IDENTITY_RECOVERY_REQUIRED',
        'Git administrative pointer changed while opening',
        { path: file }
      );
    const value = await handle.readFile('utf8');
    const after = await lstat(file);
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new HistoryError(
        'IDENTITY_RECOVERY_REQUIRED',
        'Git administrative pointer changed while reading',
        { path: file }
      );
    return value;
  } finally {
    await handle.close();
  }
}
