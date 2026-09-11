import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { registerCleanup } from './cleanup.js';

const execute = promisify(execFile);

export type DisposableRoot = {
  /** Everything this scenario owns lives under here and is deleted in afterEach. */
  base: string;
  /** The isolated git worktree the packaged CLI runs in. */
  repo: string;
  /** ORCAOPS_DATA_DIR — where projects/<id>/history.sqlite3 lives. */
  dataDir: string;
  configHome: string;
  globalRoot: string;
  stateHome: string;
  cacheHome: string;
  home: string;
  shellKey: string;
  /** Pinned environment for every child: nothing inherited that could reach an owner store. */
  env: NodeJS.ProcessEnv;
  /** Add a second worktree on the same repository. */
  worktree(name: string): Promise<string>;
  remove(): Promise<void>;
};

const disposed = new Set<() => Promise<void>>();

registerCleanup('roots', async () => {
  for (const remove of [...disposed]) await remove();
});

/**
 * Every variable that could point a child at the developer's real history, cache,
 * credentials or session. They are deleted rather than overwritten so a new one
 * added upstream fails loudly as an unknown root rather than silently leaking.
 */
const strippedPrefixes = ['ORCAOPS_', 'XDG_', 'GIT_', 'CLAUDE_', 'CODEX_'];
const strippedNames = ['TMUX_PANE', 'STY', 'WINDOW', 'TTY', 'HOME', 'TMPDIR'];

function pinnedEnvironment(root: Omit<DisposableRoot, 'env' | 'worktree' | 'remove'>) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !strippedPrefixes.some((prefix) => key.startsWith(prefix)) && !strippedNames.includes(key)
    )
  );
  return {
    ...inherited,
    HOME: root.home,
    TMPDIR: path.join(root.base, 'tmp'),
    ORCAOPS_ROOT: root.repo,
    ORCAOPS_DATA_DIR: root.dataDir,
    ORCAOPS_CONFIG_HOME: root.configHome,
    ORCAOPS_GLOBAL_ROOT: root.globalRoot,
    ORCAOPS_TMP: path.join(root.base, 'tmp'),
    ORCAOPS_CREDENTIAL_STORE: 'file',
    ORCAOPS_DISABLE_DRAIN: '1',
    NODE_DISABLE_COMPILE_CACHE: '1',
    XDG_DATA_HOME: path.join(root.base, 'xdg-data'),
    XDG_CACHE_HOME: root.cacheHome,
    XDG_STATE_HOME: root.stateHome,
    XDG_CONFIG_HOME: root.configHome,
    CLAUDE_SESSION_ID: root.shellKey,
    GIT_AUTHOR_NAME: 'Packaged Gate',
    GIT_AUTHOR_EMAIL: 'packaged-gate@example.test',
    GIT_COMMITTER_NAME: 'Packaged Gate',
    GIT_COMMITTER_EMAIL: 'packaged-gate@example.test',
    GIT_OPTIONAL_LOCKS: '0',
  } satisfies NodeJS.ProcessEnv;
}

export async function disposableRoot(name: string): Promise<DisposableRoot> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), `packaged-${name}-`)));
  const repo = path.join(base, 'repo');
  const partial = {
    base,
    repo,
    dataDir: path.join(base, 'data'),
    configHome: path.join(base, 'config'),
    globalRoot: path.join(base, 'global'),
    stateHome: path.join(base, 'state'),
    cacheHome: path.join(base, 'cache'),
    home: path.join(base, 'home'),
    shellKey: `packaged-${path.basename(base)}`,
  };
  for (const directory of [
    repo,
    partial.dataDir,
    partial.configHome,
    partial.globalRoot,
    partial.stateHome,
    partial.cacheHome,
    partial.home,
    path.join(base, 'tmp'),
  ])
    await mkdir(directory, { recursive: true });
  const env = pinnedEnvironment(partial);
  const git = (cwd: string, args: string[]) => execute('git', ['-C', cwd, ...args], { env });
  await git(repo, ['init', '-qb', 'main']);
  await git(repo, ['commit', '--allow-empty', '-qm', 'Initial']);

  const remove = async () => {
    disposed.delete(remove);
    await rm(base, { recursive: true, force: true });
  };
  disposed.add(remove);
  return {
    ...partial,
    env,
    async worktree(worktreeName: string) {
      const directory = path.join(base, worktreeName);
      await git(repo, ['worktree', 'add', '-qb', worktreeName, directory]);
      return directory;
    },
    remove,
  };
}

export function projectDatabaseFile(root: DisposableRoot, projectId: string) {
  return path.join(root.dataDir, 'projects', projectId, 'history.sqlite3');
}
