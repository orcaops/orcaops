import {
  repositoryDisplayName,
  validateProjectDisplayName,
} from '@orcaops/storage/history/database';

import { refuseDatabaseAuthoredSecrets } from '../authored-input.js';
import { runDatabaseGit } from '../context/git-process.js';

export async function suggestRepositoryDisplayName(
  commonDirectory: string,
  signal?: AbortSignal
): Promise<string> {
  let name = repositoryDisplayName(commonDirectory);
  try {
    const remote = await runDatabaseGit(
      commonDirectory,
      ['config', '--get', 'remote.origin.url'],
      signal,
      [1]
    );
    const value = remote.stdout.trim();
    const remotePath = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? new URL(value).pathname : value;
    const candidate = remotePath
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .at(-1)
      ?.replace(/\.git$/, '');
    if (candidate) name = validateProjectDisplayName(candidate);
  } catch (cause) {
    if (signal?.aborted) throw cause;
  }
  name = validateProjectDisplayName(name);
  refuseDatabaseAuthoredSecrets({ displayName: name }, [], 'setup');
  return name;
}
