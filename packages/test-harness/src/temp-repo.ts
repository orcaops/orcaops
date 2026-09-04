import { execFile } from 'node:child_process';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run git in `cwd`. Deliberately a raw spawn rather than simple-git: that
 * library sleeps a fixed 50ms after any command that writes nothing to stdout
 * or stderr, and repo setup is almost entirely such commands — which is what
 * made this fixture cost ~295ms against ~25ms for the same work.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/**
 * The local identity appended to a fresh fixture repo's `.git/config`.
 *
 * The leading newline is the point: `git init` terminates its last line today,
 * but if it ever did not, appending would splice `[user]` onto that line and git
 * would read a different key — `user.email` and `user.name` would vanish with no
 * error and every fixture commit would fail on unknown identity. A blank line is
 * always valid here. Exported so a test can assert that property on the value
 * this file actually appends, rather than on a copy of it.
 */
export const FIXTURE_IDENTITY_CONFIG = [
  '',
  '[user]',
  '\temail = test@orcaops.local',
  '\tname = orcaops test',
  '[commit]',
  '\tgpgsign = false',
  '',
].join('\n');

export interface TempRepo {
  /** Absolute path to the temporary git repository. */
  path: string;
  /** Remove the temporary directory. */
  cleanup: () => Promise<void>;
}

export interface CreateTempRepoOptions {
  /** Initial branch name; defaults to 'main'. */
  initialBranch?: string;
  /**
   * If true (default), creates an initial commit so the repo has a HEAD.
   * Some operations (rev-parse HEAD, etc.) require this.
   */
  initialCommit?: boolean;
}

export type HistoryOperation =
  | {
      type: 'commit';
      label: string;
      subject?: string;
      body?: string;
      files?: Record<string, string | null>;
      authorEmail?: string;
      authorDate?: string;
      committerDate?: string;
      empty?: boolean;
    }
  | { type: 'branch'; name: string; from?: string }
  | { type: 'checkout'; branch: string }
  | {
      type: 'merge';
      label: string;
      branch: string;
      subject?: string;
      body?: string;
      authorEmail?: string;
      authorDate?: string;
      committerDate?: string;
    }
  | { type: 'tag'; name: string; ref?: string };

export interface HistoryRepo extends TempRepo {
  shas: Record<string, string>;
}

export interface CreateHistoryRepoOptions extends CreateTempRepoOptions {
  startDate?: string;
  defaultAuthorEmail?: string;
}

/**
 * Create a fresh, isolated git repository in the OS temp dir for testing.
 * Returns the path and a cleanup function.
 */
export async function createTempRepo(opts: CreateTempRepoOptions = {}): Promise<TempRepo> {
  const { initialBranch = 'main', initialCommit = true } = opts;

  const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-test-'));
  await git(dir, ['init', '--initial-branch', initialBranch]);

  // Local-only identity so commits work without inheriting global config.
  // Appended to `.git/config` directly rather than shelled out three times:
  // `git config` prints nothing, so each call would cost a process spawn.
  // Tests corrupt and rewrite this file, so it must stay a real per-repo file.
  await appendFile(path.join(dir, '.git', 'config'), FIXTURE_IDENTITY_CONFIG, 'utf8');

  if (initialCommit) {
    const readme = path.join(dir, 'README.md');
    await writeFile(readme, '# test repo\n', 'utf8');
    await git(dir, ['add', 'README.md']);
    await git(dir, ['commit', '--allow-empty', '-m', 'initial commit']);
  }

  return {
    path: dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function createHistoryRepo(
  operations: readonly HistoryOperation[],
  opts: CreateHistoryRepoOptions = {}
): Promise<HistoryRepo> {
  const repo = await createTempRepo({
    ...(opts.initialBranch ? { initialBranch: opts.initialBranch } : {}),
    initialCommit: opts.initialCommit ?? false,
  });
  const shas: Record<string, string> = {};
  let nextDateMs = Date.parse(opts.startDate ?? '2025-01-01T00:00:00.000Z');
  if (Number.isNaN(nextDateMs)) throw new TypeError('startDate must be an ISO timestamp');

  /** Identity and dates ride as env so each commit is byte-reproducible. */
  const datedGit = async (
    op: { authorEmail?: string; authorDate?: string; committerDate?: string },
    args: string[]
  ): Promise<void> => {
    const fallbackDate = new Date(nextDateMs).toISOString();
    nextDateMs += 60 * 60 * 1000;
    const authorEmail = op.authorEmail ?? opts.defaultAuthorEmail ?? 'test@orcaops.local';
    await execFileAsync('git', args, {
      cwd: repo.path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'orcaops test',
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_COMMITTER_NAME: 'orcaops test',
        GIT_COMMITTER_EMAIL: authorEmail,
        GIT_AUTHOR_DATE: op.authorDate ?? op.committerDate ?? fallbackDate,
        GIT_COMMITTER_DATE: op.committerDate ?? fallbackDate,
      },
    });
  };

  for (const operation of operations) {
    if (operation.type === 'branch') {
      const from = operation.from ? (shas[operation.from] ?? operation.from) : 'HEAD';
      await git(repo.path, ['branch', operation.name, from]);
      continue;
    }
    if (operation.type === 'checkout') {
      await git(repo.path, ['checkout', operation.branch]);
      continue;
    }
    if (operation.type === 'tag') {
      const ref = operation.ref ? (shas[operation.ref] ?? operation.ref) : 'HEAD';
      await git(repo.path, ['tag', operation.name, ref]);
      continue;
    }
    if (operation.type === 'commit') {
      for (const [file, content] of Object.entries(operation.files ?? {})) {
        const target = path.join(repo.path, file);
        if (content === null) {
          await rm(target, { force: true });
        } else {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content, 'utf8');
        }
      }
      await git(repo.path, ['add', '-A']);
      const args = ['commit', '-m', operation.subject ?? operation.label];
      if (operation.body) args.push('-m', operation.body);
      if (operation.empty) args.push('--allow-empty');
      await datedGit(operation, args);
      shas[operation.label] = (await git(repo.path, ['rev-parse', 'HEAD'])).trim();
      continue;
    }
    const args = [
      'merge',
      '--no-ff',
      operation.branch,
      '-m',
      operation.subject ?? `Merge ${operation.branch}`,
    ];
    if (operation.body) args.push('-m', operation.body);
    await datedGit(operation, args);
    shas[operation.label] = (await git(repo.path, ['rev-parse', 'HEAD'])).trim();
  }

  return { ...repo, shas };
}

export interface CreateLinkedWorktreeOptions {
  /** Branch to create for the worktree; defaults to a unique `wt-<n>` name. */
  branch?: string;
}

let worktreeCounter = 0;

/**
 * Add a linked worktree (`git worktree add -b <branch>`) to an existing repo,
 * in its own temp dir. Linked worktrees are the layout where `<root>/.git` is
 * a FILE (`gitdir: …`) and shared state lives in the main repo's common dir —
 * the shape that breaks hand-joined `.git/<rel>` paths. The main repo must
 * have at least one commit. Cleanup removes the worktree dir and prunes the
 * registration from the main repo (best-effort — cleaning up the main repo
 * first is fine).
 */
export async function createLinkedWorktree(
  mainRepoPath: string,
  opts: CreateLinkedWorktreeOptions = {}
): Promise<TempRepo> {
  const branch = opts.branch ?? `wt-${++worktreeCounter}`;
  const parent = await mkdtemp(path.join(tmpdir(), 'orcaops-test-wt-'));
  const dir = path.join(parent, branch);
  await git(mainRepoPath, ['worktree', 'add', '-b', branch, dir]);

  return {
    path: dir,
    cleanup: async () => {
      await rm(parent, { recursive: true, force: true });
      try {
        await git(mainRepoPath, ['worktree', 'prune']);
      } catch {
        // main repo may already be gone; the dir removal above is what matters
      }
    },
  };
}

export interface RepoTemplate {
  /** A fresh, independent copy of the built repo. */
  checkout: () => Promise<TempRepo>;
  /** Remove the template and every copy handed out. */
  destroy: () => Promise<void>;
}

/**
 * Re-point symlinks that resolve into `from` so they resolve into `to`.
 *
 * Node's `cp` REWRITES a relative symlink into an absolute one pointing at the
 * source unless `verbatimSymlinks` is set — that, not the link `orcaops init`
 * writes, is what originally made copies reach back into the template
 * (`init --agents-md` writes CLAUDE.md relative on posix, absolute only on
 * win32). The copy sets `verbatimSymlinks`, so this handles what remains: a
 * link that was absolute to begin with. Left pointing at the template it reads
 * as a foreign symlink, and `orcaops update` refuses outright.
 */
async function rerootSymlinks(dir: string, from: string, to: string): Promise<void> {
  // A target may be written against either form of the root: macOS resolves
  // `/tmp` to `/private/tmp` and `/var/folders/…` to `/private/var/folders/…`,
  // and that realpath form is what orcaops' own path canonicalization emits.
  const roots = [from, await realpath(from).catch(() => from)];

  /** The target's path relative to the template, or null if it is outside. */
  const insideTemplate = (target: string): string | null => {
    for (const root of roots) {
      const rel = path.relative(root, target);
      // `..` alone is the parent; `../x` escapes. A leading `..` on a longer
      // segment (`..weird/x`) does NOT escape and must not be rejected.
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
      return rel;
    }
    return null;
  };

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    // A symlink to a directory reports isSymbolicLink, not isDirectory, so this
    // never follows one and cannot recurse into a cycle.
    if (entry.isDirectory()) {
      await rerootSymlinks(abs, from, to);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const target = await readlink(abs);
    if (!path.isAbsolute(target)) continue;
    const rel = insideTemplate(target);
    if (rel === null) continue; // points outside the template; leave it
    await unlink(abs);
    await symlink(path.join(to, rel), abs);
  }
}

export function createRepoTemplate(
  build: (repoPath: string) => Promise<void>,
  opts: CreateTempRepoOptions = {}
): RepoTemplate {
  let template: Promise<TempRepo> | undefined;
  const issued: TempRepo[] = [];
  /** Template repos ever created, including one whose build threw. */
  const sources: TempRepo[] = [];

  return {
    async checkout() {
      if (!template) {
        template = (async () => {
          const repo = await createTempRepo(opts);
          // Registered before `build` runs so a build that throws still leaves
          // its directory for `destroy` to remove.
          sources.push(repo);
          await build(repo.path);
          return repo;
        })();
        // Never serve a cached rejection: a build that fails would otherwise
        // fail every later checkout in the file with the first error. Clearing
        // the memo lets the next checkout retry. The awaited promise below
        // still rejects for the caller that raced this build.
        template.catch(() => {
          template = undefined;
        });
      }
      const source = await template;

      const parent = await mkdtemp(path.join(tmpdir(), 'orcaops-test-'));
      const dir = path.join(parent, 'repo');
      await cp(source.path, dir, { recursive: true, verbatimSymlinks: true });
      await rerootSymlinks(dir, source.path, dir);
      // `orcaops init` mints a project id into `.git/config`, and the copy
      // inherits it — which would give every test in the file ONE identity, the
      // seam the pin store and global-install refs are keyed on. Drop it so each
      // checkout mints its own, as a freshly built repo would.
      await execFileAsync('git', ['config', '--local', '--unset', 'orcaops.projectid'], {
        cwd: dir,
      }).catch(() => undefined); // exit 5 when the key was never set
      const copy: TempRepo = {
        path: dir,
        cleanup: async () => {
          await rm(parent, { recursive: true, force: true });
        },
      };
      issued.push(copy);
      return copy;
    },
    /** Best-effort and never throws: teardown must not mask a test's own failure. */
    async destroy() {
      template = undefined;
      const all = [...issued, ...sources];
      issued.length = 0;
      sources.length = 0;
      await Promise.all(all.map((r) => r.cleanup().catch(() => undefined)));
    },
  };
}

/**
 * Make a checkout GOVERNED by a project-scope config. Orcaops treats a
 * worktree as initialized only when a config governs it — its own, or the
 * shared personal one — never because a `.orcaops/` directory exists, so a
 * fixture that only creates artifact or cache files reads as uninitialized.
 */
export async function writeProjectConfig(
  repoPath: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const configPath = path.join(repoPath, '.orcaops', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      { schema_version: 6, install: { agents: [], scope: 'project' }, ...extra },
      null,
      2
    )}\n`,
    'utf8'
  );
  return configPath;
}
