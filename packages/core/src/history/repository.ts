import { Repo } from '../git/repo.js';

export function createHistoryRepo(cwd: string, source: NodeJS.ProcessEnv = process.env): Repo {
  const env = { ...source };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  return new Repo(cwd, { env });
}
