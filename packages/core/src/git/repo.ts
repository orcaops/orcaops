import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { stripHttpUserinfo } from './remote-url.js';
import { parseUnmergedPathsZ } from './snapshots.js';

export interface RepoInfo {
  branch: string;
  headSha: string;
}

export interface DetailedCommit {
  sha: string;
  parentShas: string[];
  authorEmail: string;
  committerDateIso: string;
  subject: string;
  body: string;
  files: string[];
}

export interface DetailedLogOptions {
  since?: string;
  maxCount?: number;
}

export interface GitRefUpdate {
  ref: string;
  sha: string;
}

export interface CommitDiffPair {
  headSha: string;
  parentSha: string;
}

export interface BoundedCommitDiff {
  diff: Buffer;
  truncated: boolean;
  byteCount: number;
}

export type GitReachability = 'reachable' | 'unreachable' | 'unknown';

export type GitRefResolution =
  | { status: 'resolved'; sha: string }
  | { status: 'absent' }
  | { status: 'unknown' };

export type GitBranchPresence = 'present' | 'absent' | 'unknown';

export type GitBranchTipEnumeration = { status: 'known'; tips: string[] } | { status: 'unknown' };

function runGitProbe(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.on('error', () => resolve({ code: null, stdout }));
    proc.on('close', (code) => resolve({ code, stdout }));
  });
}

/**
 * Run git and resolve its stdout, rejecting on a non-zero exit. This is the
 * throw-on-failure counterpart to {@link runGitProbe}, whose callers need the
 * exit code itself; the many `try { … } catch { return null }` readers below
 * rely on the rejection.
 *
 * Stdout is returned verbatim — `getFileAtRef` hands it back as file content,
 * so trailing newlines are the file's, not ours to strip. Callers that want a
 * single token trim at the call site.
 */
function runGitText(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

function runGitCommand(cwd: string, args: string[], stdin?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`git ${args[0] ?? 'command'} failed (${code ?? 'signal'}): ${stderr}`));
    });
    proc.stdin?.end(stdin);
  });
}

function splitDetailedRecord(record: string): Omit<DetailedCommit, 'files'> | null {
  const bodyEnd = record.indexOf('\x02');
  if (bodyEnd === -1) return null;
  const content = record.slice(0, bodyEnd).replace(/^\r?\n/u, '');
  const fields: string[] = [];
  let cursor = 0;
  for (let i = 0; i < 5; i++) {
    const separator = content.indexOf('\x1f', cursor);
    if (separator === -1) return null;
    fields.push(content.slice(cursor, separator));
    cursor = separator + 1;
  }
  fields.push(content.slice(cursor));
  const [sha, parents, authorEmail, committerDateIso, subject, body] = fields;
  if (
    !sha ||
    authorEmail === undefined ||
    committerDateIso === undefined ||
    subject === undefined
  ) {
    return null;
  }
  return {
    sha,
    parentShas: parents ? parents.split(' ').filter(Boolean) : [],
    authorEmail,
    committerDateIso,
    subject,
    body: body ?? '',
  };
}

async function filesByCommit(cwd: string, shas: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const sha of shas) result.set(sha, []);
  if (shas.length === 0) return result;
  const output = await runGitCommand(
    cwd,
    [
      '-c',
      'core.quotepath=false',
      'diff-tree',
      '--stdin',
      '--root',
      '-r',
      '--name-only',
      '-z',
      '-M',
    ],
    `${shas.join('\n')}\n`
  );
  const known = new Set(shas);
  let current: string | null = null;
  for (const token of output.toString('utf8').split('\0')) {
    if (known.has(token)) {
      current = token;
    } else if (current !== null && token.length > 0) {
      result.get(current)?.push(token);
    }
  }
  for (const files of result.values()) {
    files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return result;
}

async function readDetailedCommits(
  cwd: string,
  ref: string,
  opts: DetailedLogOptions = {},
  firstParent = false
): Promise<DetailedCommit[]> {
  if (opts.maxCount !== undefined && (!Number.isSafeInteger(opts.maxCount) || opts.maxCount <= 0)) {
    throw new RangeError('maxCount must be a positive safe integer');
  }
  const args = [
    '-c',
    'core.quotepath=false',
    'log',
    '--no-show-signature',
    '--no-patch',
    '--format=%x1e%H%x1f%P%x1f%ae%x1f%cI%x1f%s%x1f%b%x02',
    ...(firstParent ? ['--first-parent'] : []),
    ...(opts.since ? [`--since=${opts.since}`] : []),
    ...(opts.maxCount ? [`--max-count=${opts.maxCount}`] : []),
    ref,
  ];
  const metadata = await runGitCommand(cwd, args);
  const commits = metadata
    .toString('utf8')
    .split('\x1e')
    .map(splitDetailedRecord)
    .filter((commit): commit is Omit<DetailedCommit, 'files'> => commit !== null);
  const files = await filesByCommit(
    cwd,
    commits.map((commit) => commit.sha)
  );
  return commits.map((commit) => ({ ...commit, files: files.get(commit.sha) ?? [] }));
}

/** What a session-start hook needs to know about the checkout it runs in. */
export interface WorktreeProbe {
  /** Canonical worktree root (`--show-toplevel`). */
  worktreeRoot: string;
  /** Canonical git common dir — shared by every worktree of the repository. */
  commonDir: string;
  /** `--abbrev-ref HEAD`; `HEAD` when detached; null in a repository with no commits. */
  branch: string | null;
}

/**
 * Worktree root, git common dir, and branch from ONE git process — the
 * session-start hook runs at every agent session and must not pay three.
 *
 * `--git-common-dir` prints a cwd-RELATIVE path from the main worktree
 * (`.git`, or `../.git` from a subdirectory) and an absolute one from a
 * linked worktree, so the value is resolved against the exact directory the
 * process ran in rather than against the toplevel. `--path-format=absolute`
 * would do that in git, but only from 2.31 — an unstated floor this avoids.
 * Returns null wherever git cannot answer: outside a repository, or in one
 * too broken to resolve — a personal install cannot be found safely there
 * and nothing may guess a common path.
 */
export async function probeWorktree(cwd: string): Promise<WorktreeProbe | null> {
  let out: string;
  let branch: string | null = null;
  try {
    out = await runGitText(cwd, [
      'rev-parse',
      '--show-toplevel',
      '--git-common-dir',
      '--abbrev-ref',
      'HEAD',
    ]);
    branch = out.split(/\r?\n/)[2] ?? null;
  } catch {
    // A repository with no commits has no HEAD to abbreviate, which fails the
    // whole call; the root and common dir are still answerable, and that is
    // enough to find the config (the hook then falls back to its static text).
    try {
      out = await runGitText(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir']);
    } catch {
      return null;
    }
  }
  const [toplevel, commonDirRaw] = out.split(/\r?\n/);
  if (!toplevel || !commonDirRaw) return null;
  const canonical = async (target: string): Promise<string> => {
    try {
      return await realpath(target);
    } catch {
      return target;
    }
  };
  return {
    worktreeRoot: await canonical(toplevel),
    commonDir: await canonical(
      path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(cwd, commonDirRaw)
    ),
    branch,
  };
}

export class Repo {
  /** Memoized HEAD sha — resolved once per Repo lifetime; see getHeadSha. */
  private headShaPromise?: Promise<string>;
  /** Memoized current branch — same lifetime doctrine; see getCurrentBranch. */
  private branchPromise?: Promise<string>;
  /** Memoized git-common-dir — same lifetime doctrine; see getCommonDirAbsolute. */
  private commonDirPromise?: Promise<string>;
  /** Memoized git-dir — same lifetime doctrine; see getGitDirAbsolute. */
  private gitDirPromise?: Promise<string>;

  constructor(public readonly cwd: string) {}

  private runGit(args: string[]): Promise<string> {
    return runGitText(this.cwd, args);
  }

  /**
   * `git rev-parse --abbrev-ref HEAD`, memoized for this Repo's lifetime —
   * same doctrine as getHeadSha below: a CLI command never switches
   * branches mid-run and buildContext builds a fresh Repo per invocation.
   * One pinned `capture plan` otherwise spawns this resolve up to three
   * times (repo-guard, command body, baseline freeze).
   */
  async getCurrentBranch(): Promise<string> {
    this.branchPromise ??= this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.trim());
    return this.branchPromise;
  }

  /**
   * `git rev-parse HEAD`, memoized for this Repo's lifetime. A CLI command
   * never commits mid-run, so HEAD is constant for the invocation; memoizing
   * collapses the resolves one command otherwise makes — the command body, the
   * evaluator-context build (evaluator-bridge), and the next_actions snapshot
   * each call this — into a single git subprocess. buildContext builds a
   * fresh Repo per invocation, so a long-lived process never serves a stale
   * HEAD; caching the promise also dedups concurrent callers (e.g. info()).
   */
  async getHeadSha(): Promise<string> {
    this.headShaPromise ??= this.runGit(['rev-parse', 'HEAD']).then((r) => r.trim());
    return this.headShaPromise;
  }

  /**
   * The subset of `relPaths` git tracks in THIS worktree, as the same
   * worktree-relative strings that were passed in. One `ls-files` for the
   * whole batch: a mutation plan asks about every path it would touch, and a
   * probe per path would cost a subprocess per file.
   *
   * Each path goes through as `:(literal)` — a leading `:` is pathspec magic
   * even after `--`, so an unescaped path could quietly match something else.
   */
  async listTrackedPaths(relPaths: readonly string[]): Promise<Set<string>> {
    // A bare `ls-files` with no pathspec lists the WHOLE index; an empty batch
    // has to short-circuit rather than answer "everything is tracked".
    if (relPaths.length === 0) return new Set();
    const posix = new Map<string, string>();
    for (const rel of relPaths) posix.set(rel.replaceAll('\\', '/'), rel);
    const out = await this.runGit([
      'ls-files',
      '-z',
      '--',
      ...[...posix.keys()].map((rel) => `:(literal)${rel}`),
    ]);
    const tracked = new Set<string>();
    for (const entry of out.split('\0')) {
      const original = posix.get(entry);
      if (original !== undefined) tracked.add(original);
    }
    return tracked;
  }

  /** Whether git tracks `relPath` in this worktree. */
  async isTracked(relPath: string): Promise<boolean> {
    return (await this.listTrackedPaths([relPath])).has(relPath);
  }

  /** Tree SHA represented by the real Git index, without reading worktree bytes. */
  async getIndexTreeSha(): Promise<string> {
    return (await this.runGit(['write-tree'])).trim();
  }

  /**
   * The configured URL for `remote` (default `origin`), with any http(s)
   * credential removed, or null when the remote is not configured.
   *
   * Every caller uses this for identity — the SQLite key, the cloud wire URL
   * shipped by `repo.upsertByRemote`, the project registry — and none
   * authenticates with it, so the credential is stripped here rather than at
   * each consumer.
   */
  async getRemoteUrl(remote = 'origin'): Promise<string | null> {
    try {
      const out = await this.runGit(['config', '--get', `remote.${remote}.url`]);
      const url = stripHttpUserinfo(out.trim());
      return url.length > 0 ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether a local branch by this name exists in the working tree. Canonical
   * signal for distinguishing a rename (`git branch -m old new` removes the
   * old ref) from a branch-off (`git checkout -b new old` leaves the old ref
   * intact) — `git rev-parse --verify refs/heads/<name>` exits non-zero when
   * the ref is missing, zero when it resolves.
   *
   * Returns false on any rev-parse failure, including malformed names — the
   * helper is intended for a "does this branch still exist?" probe, not for
   * surfacing git-config errors. Callers that need to distinguish the cases
   * should run `getCurrentBranch` first.
   */
  async branchExists(name: string): Promise<boolean> {
    try {
      await this.runGit(['rev-parse', '--verify', `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Paths unmerged (stage 1/2/3) in the real index, unique and sorted, or
   * `null` when the probe cannot run — callers (status/doctor nudges) must
   * treat `null` as "unknown, stay quiet", never as clean. Deliberately not
   * memoized: conflict state changes mid-session and the consumers want
   * live truth.
   */
  async listUnmergedPaths(): Promise<string[] | null> {
    // Strip ambient GIT_INDEX_FILE — the probe must read the REAL index.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GIT_INDEX_FILE;
    const result = await runGitProbe(this.cwd, ['ls-files', '-u', '-z'], env);
    if (result.code !== 0) return null;
    return parseUnmergedPathsZ(result.stdout);
  }

  /**
   * Strict local-branch probe for destructive callers. Git's documented
   * missing-ref status is distinct from an operational/spawn failure.
   */
  async branchPresence(name: string): Promise<GitBranchPresence> {
    const result = await runGitProbe(this.cwd, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${name}`,
    ]);
    if (result.code === 0) return 'present';
    if (result.code === 1) return 'absent';
    return 'unknown';
  }

  async getMergeBase(refA: string, refB: string): Promise<string | null> {
    try {
      const result = await this.runGit(['merge-base', refA, refB]);
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  async resolveMergeBase(refA: string, refB: string): Promise<GitRefResolution> {
    const result = await runGitProbe(this.cwd, ['merge-base', refA, refB]);
    if (result.code === 0) {
      const sha = result.stdout.trim();
      return sha.length > 0 ? { status: 'resolved', sha } : { status: 'unknown' };
    }
    if (result.code === 1) return { status: 'absent' };
    return { status: 'unknown' };
  }

  /**
   * Resolve an arbitrary user-supplied ref (branch, tag, sha, `HEAD~2`, …)
   * to a full commit sha, or null when it doesn't name a commit. The
   * `^{commit}` peel rejects refs resolving to non-commit objects
   * (a tree or blob sha).
   */
  async resolveCommit(ref: string): Promise<string | null> {
    try {
      const out = await this.runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      const sha = out.trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  async resolveTree(ref: string): Promise<string | null> {
    try {
      const out = await runGitText(this.cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`]);
      const sha = out.trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  async updateRefsBatch(updates: readonly GitRefUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const commands = [
      'start',
      ...updates.map((update) => `update ${update.ref} ${update.sha}`),
      'prepare',
      'commit',
      '',
    ].join('\n');
    await runGitCommand(this.cwd, ['update-ref', '--stdin'], commands);
  }

  async resolveTreesBatch(refs: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(refs)];
    if (unique.length === 0) return new Map();
    const output = await runGitCommand(
      this.cwd,
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      `${unique.map((ref) => `${ref}^{tree}`).join('\n')}\n`
    );
    const result = new Map<string, string>();
    const lines = output.toString('utf8').trimEnd().split('\n');
    for (let index = 0; index < unique.length; index++) {
      const match = /^([0-9a-f]{40}) tree$/u.exec(lines[index] ?? '');
      if (match) result.set(unique[index]!, match[1]!);
    }
    return result;
  }

  diffCommitPairs(
    pairs: readonly CommitDiffPair[],
    maxDiffBytes: number
  ): Promise<Map<string, BoundedCommitDiff>> {
    if (!Number.isSafeInteger(maxDiffBytes) || maxDiffBytes <= 0) {
      throw new RangeError('maxDiffBytes must be a positive safe integer');
    }
    if (pairs.length === 0) return Promise.resolve(new Map());
    return new Promise((resolve, reject) => {
      const proc = spawn(
        'git',
        [
          'diff-tree',
          '--stdin',
          '-r',
          '-p',
          '-M',
          '--no-color',
          '--no-ext-diff',
          '--format=%x00%H%x00',
        ],
        { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const result = new Map<string, BoundedCommitDiff>();
      let pairIndex = 0;
      let started = false;
      let tail: Buffer = Buffer.alloc(0);
      let kept: Buffer[] = [];
      let byteCount = 0;
      let stderr = '';

      const marker = (): Buffer | null => {
        const pair = pairs[pairIndex + (started ? 1 : 0)];
        return pair ? Buffer.from(`\0${pair.headSha}\0`, 'utf8') : null;
      };
      const append = (bytes: Buffer): void => {
        byteCount += bytes.length;
        const remaining = Math.max(0, maxDiffBytes - kept.reduce((n, part) => n + part.length, 0));
        if (remaining > 0) kept.push(bytes.subarray(0, remaining));
      };
      const finish = (): void => {
        const pair = pairs[pairIndex];
        if (!pair || !started) return;
        result.set(pair.headSha, {
          diff: Buffer.concat(kept),
          truncated: byteCount > maxDiffBytes,
          byteCount,
        });
        pairIndex += 1;
        started = false;
        kept = [];
        byteCount = 0;
      };
      const consume = (chunk: Buffer): void => {
        let input = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
        tail = Buffer.alloc(0);
        while (input.length > 0) {
          const nextMarker = marker();
          if (!nextMarker) {
            if (started) append(input);
            return;
          }
          const markerAt = input.indexOf(nextMarker);
          if (markerAt >= 0) {
            if (started) {
              append(input.subarray(0, markerAt));
              finish();
            }
            started = true;
            input = input.subarray(markerAt + nextMarker.length);
            continue;
          }
          const retained = Math.min(nextMarker.length - 1, input.length);
          const emitEnd = input.length - retained;
          if (started && emitEnd > 0) append(input.subarray(0, emitEnd));
          tail = input.subarray(emitEnd);
          return;
        }
      };

      proc.stdout.on('data', (chunk: Buffer) => consume(chunk));
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (started && tail.length > 0) append(tail);
        finish();
        if (code !== 0) {
          reject(new Error(`git diff-tree failed (${code ?? 'signal'}): ${stderr}`));
          return;
        }
        resolve(result);
      });
      proc.stdin.end(`${pairs.map((pair) => `${pair.headSha} ${pair.parentSha}`).join('\n')}\n`);
    });
  }

  /** Strict ref resolution for destructive callers. */
  async resolveCommitState(ref: string): Promise<GitRefResolution> {
    const result = await runGitProbe(this.cwd, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]);
    if (result.code === 0) {
      const sha = result.stdout.trim();
      return sha.length > 0 ? { status: 'resolved', sha } : { status: 'unknown' };
    }
    if (result.code === 1) return { status: 'absent' };
    return { status: 'unknown' };
  }

  /**
   * Commit shas in `base..head` (reachable from head, not from base) —
   * shas only, no file lists. Callers resolve both refs via
   * {@link resolveCommit} first; a failure here (e.g. unrelated shallow
   * history) surfaces as a git error, not a silent empty set.
   */
  async listCommitShasBetween(base: string, head: string): Promise<string[]> {
    const out = await this.runGit(['rev-list', `${base}..${head}`]);
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async info(): Promise<RepoInfo> {
    const [branch, headSha] = await Promise.all([this.getCurrentBranch(), this.getHeadSha()]);
    return { branch, headSha };
  }

  /**
   * Absolute paths of every worktree registered on this repository
   * (`git worktree list --porcelain`), main worktree included. Registrations
   * survive an `rm -rf` of the worktree directory until `git worktree prune`
   * runs — doctor's scratch-checkout check scopes these against the checkouts
   * cache root to find exactly those. Returns [] on any git failure
   * (fail-open callers).
   */
  async listWorktreePaths(): Promise<string[]> {
    try {
      const out = await this.runGit(['worktree', 'list', '--porcelain']);
      return out
        .split(/\r?\n/)
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Every registered worktree paired with the branch it has checked out
   * (`git worktree list --porcelain`), main worktree included. Porcelain
   * groups each worktree as a `worktree <path>` line followed by an optional
   * `branch refs/heads/<name>` line (a blank line ends the group); a detached
   * worktree emits `detached` and no branch line, so its `branch` is `null`.
   * Reads the branch straight from porcelain rather than an extra
   * `symbolic-ref` per worktree. Returns [] on any git failure (fail-open,
   * matching {@link listWorktreePaths}).
   */
  async listWorktrees(): Promise<Array<{ path: string; branch: string | null }>> {
    try {
      const out = await this.runGit(['worktree', 'list', '--porcelain']);
      const worktrees: Array<{ path: string; branch: string | null }> = [];
      let current: { path: string; branch: string | null } | null = null;
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
          const p = line.slice('worktree '.length).trim();
          if (p.length === 0) continue;
          current = { path: p, branch: null };
          worktrees.push(current);
        } else if (current !== null && line.startsWith('branch refs/heads/')) {
          current.branch = line.slice('branch refs/heads/'.length).trim() || null;
        }
      }
      return worktrees;
    } catch {
      return [];
    }
  }

  /**
   * Return the file paths changed between two refs (`base..head`).
   * Includes adds, modifies, deletes, and renames (the new path for renames).
   */
  async getChangedFiles(base: string, head = 'HEAD'): Promise<string[]> {
    const out = await this.runGit(['diff', '--name-only', `${base}..${head}`]);
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Read the contents of a file at a specific ref (e.g., the merge-base).
   * Returns null when the file doesn't exist at that ref.
   */
  async getFileAtRef(ref: string, filePath: string): Promise<string | null> {
    try {
      return await this.runGit(['show', `${ref}:${filePath}`]);
    } catch {
      return null;
    }
  }

  /**
   * Run `git blame -L <line>,<line>` on a file and return the commit SHA
   * for the line. Returns null if the file/line is unblamable (file
   * outside the repo, line uncommitted, etc.).
   */
  async blameLine(filePath: string, line: number): Promise<string | null> {
    try {
      const out = await this.runGit([
        'blame',
        '-L',
        `${line},${line}`,
        '--porcelain',
        '--root',
        '--',
        filePath,
      ]);
      // First line of porcelain output: "<sha> <orig> <final> <count>"
      const first = out.split(/\r?\n/)[0]?.trim();
      if (!first) return null;
      const sha = first.split(/\s+/)[0];
      // git blame returns all-zeros for an uncommitted line.
      if (!/^[0-9a-f]{40}$/i.test(sha) || /^0+$/.test(sha)) return null;
      return sha;
    } catch {
      return null;
    }
  }

  /**
   * True if `ancestor` is an ancestor of `descendant` (i.e., reachable via
   * parent chain). Equal SHAs return true. Unknown SHAs or non-ancestor
   * relationships return false.
   *
   * Goes through the exit-code probe rather than the text runner because
   * `git merge-base --is-ancestor` uses exit codes as its return channel
   * (0 = yes, 1 = no, 128 = error), and the text runner collapses every
   * non-zero exit into one rejection.
   */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.checkReachability(ancestor, descendant)) === 'reachable';
  }

  /**
   * Tri-state ancestry for destructive callers. `merge-base --is-ancestor`
   * uses 0/1 as yes/no; every other exit is operational uncertainty.
   */
  async checkReachability(ancestor: string, descendant: string): Promise<GitReachability> {
    if (ancestor === descendant) return 'reachable';
    const result = await runGitProbe(this.cwd, [
      'merge-base',
      '--is-ancestor',
      ancestor,
      descendant,
    ]);
    if (result.code === 0) return 'reachable';
    if (result.code === 1) return 'unreachable';
    return 'unknown';
  }

  /**
   * Canonical absolute path to the repo's git-common-dir. Common-dir
   * is shared across worktrees of the same repo, so two worktrees
   * yield the same value — the property the pin store relies on for
   * its repo-id.
   *
   * Canonicalizes via `realpath`: macOS exposes `/tmp` as a symlink
   * to `/private/tmp` (and similarly `/var` → `/private/var`), so
   * different cwd-based vs git-resolved paths can otherwise produce
   * different `repo-id`s for the same repo. Pins would land in one
   * dir, the picker would search another. Realpath collapses both
   * forms onto the same on-disk inode.
   */
  async getCommonDirAbsolute(): Promise<string> {
    this.commonDirPromise ??= this.runGit(['rev-parse', '--git-common-dir']).then((out) =>
      this.toCanonicalAbsolute(out.trim())
    );
    return this.commonDirPromise;
  }

  /**
   * Canonicalize a possibly-relative git-emitted path: resolve against this
   * repo's cwd (rev-parse emits cwd-relative forms in the main worktree) and
   * collapse symlinks via `realpath` (see getCommonDirAbsolute). Falls back
   * to the resolved-but-unrealpathed form when the path doesn't exist on
   * disk yet.
   */
  private async toCanonicalAbsolute(raw: string): Promise<string> {
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(this.cwd, raw);
    try {
      return await realpath(resolved);
    } catch {
      return resolved;
    }
  }

  /**
   * Canonical absolute path to this worktree's git-dir. In a linked worktree
   * this is `<common>/worktrees/<name>` — per-worktree state — distinct from
   * the shared common dir.
   */
  async getGitDirAbsolute(): Promise<string> {
    this.gitDirPromise ??= this.runGit(['rev-parse', '--git-dir']).then((out) =>
      this.toCanonicalAbsolute(out.trim())
    );
    return this.gitDirPromise;
  }

  /**
   * Canonical absolute form of `git rev-parse --git-path <rel>`. Git owns the
   * layout policy: common-dir indirection for shared paths (`info/exclude`,
   * `hooks`, …), per-worktree paths where applicable, and `core.hooksPath`
   * for `hooks`. Prefer this over joining `.git/<rel>` by hand — the hand
   * join is wrong in linked worktrees (`.git` is a file) and under
   * `core.hooksPath`.
   */
  async getGitPathAbsolute(rel: string): Promise<string> {
    const out = await this.runGit(['rev-parse', '--git-path', rel]);
    return this.toCanonicalAbsolute(out.trim());
  }

  /**
   * The directory git actually runs hooks from, plus whether that location
   * comes from a `core.hooksPath` override (husky/lefthook et al.) or git's
   * default layout. Installers branch on `source` to refuse writing into
   * tool-owned hook dirs.
   */
  async getHooksDir(): Promise<{ dir: string; source: 'git' | 'core.hooksPath' }> {
    const dir = await this.getGitPathAbsolute('hooks');
    let source: 'git' | 'core.hooksPath' = 'git';
    try {
      const out = await this.runGit(['config', '--get', 'core.hooksPath']);
      if (out.trim().length > 0) source = 'core.hooksPath';
    } catch {
      // unset key → git's default layout
    }
    return { dir, source };
  }

  /**
   * Read a `git config --local` value, or null when unset. A configured empty
   * value remains an empty string so callers can distinguish malformed state
   * from a missing key. Git's documented absent-key status remains null even
   * when diagnostics are enabled; other operational failures reject. Local
   * config lives in the git COMMON dir, so a value written from one worktree is
   * visible from every worktree of the repo and travels on repo moves — the
   * property the archive's project identity relies on.
   */
  async getLocalConfig(key: string): Promise<string | null> {
    const result = await this.runLocalConfig(['--get', key]);
    if (result.code === 0) return result.stdout.trim();
    if (result.code === 1 && result.signal === null) {
      const readable = await this.runLocalConfig(['--list']);
      if (readable.code === 0) return null;
    }
    throw new Error('git config --local --get failed');
  }

  private runLocalConfig(
    args: string[]
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', ['config', '--local', ...args], {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      proc.on('error', reject);
      proc.on('close', (code, signal) => {
        resolve({ code, signal, stdout });
      });
    });
  }

  /** Write a `git config --local` value (see getLocalConfig for scope semantics). */
  async setLocalConfig(key: string, value: string): Promise<void> {
    await this.runGit(['config', '--local', key, value]);
  }

  /**
   * Attach (or replace, `-f`) a git note on `commitSha` under `notesRef`
   * (e.g. `refs/orcaops/agent-trace`). Notes are LOCAL: git never
   * pushes a notes ref without an explicit refspec, and this method never
   * pushes — distribution is the user's deliberate
   * `git push origin <notesRef>`. Throws on git failure (caller maps).
   */
  async addNote(notesRef: string, commitSha: string, message: string): Promise<void> {
    await this.runGit(['notes', `--ref=${notesRef}`, 'add', '-f', '-m', message, commitSha]);
  }

  /**
   * Root (parentless) commit sha(s) reachable from HEAD. Plural on purpose —
   * merged unrelated histories yield several. Used ONLY as archive-registry
   * re-association hints (never identity): shallow clones return [] here,
   * which is fine for a hint.
   */
  async getRootCommitShas(): Promise<string[]> {
    try {
      const out = await this.runGit(['rev-list', '--max-parents=0', 'HEAD']);
      return out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Return the tip SHA of every local branch. Drives the doctor
   * `lineage-orphan` check: an artifact whose latest lineage SHA is
   * unreachable from every tip is flagged.
   */
  async listLocalBranchTips(): Promise<string[]> {
    const out = await this.runGit(['for-each-ref', '--format=%(objectname)', 'refs/heads']);
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /** Strict local-tip enumeration for destructive callers. */
  async listLocalBranchTipsState(): Promise<GitBranchTipEnumeration> {
    const result = await runGitProbe(this.cwd, [
      'for-each-ref',
      '--format=%(objectname)',
      'refs/heads',
    ]);
    if (result.code !== 0) return { status: 'unknown' };
    return {
      status: 'known',
      tips: result.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    };
  }

  /**
   * Raw `git status --porcelain` output. Empty string when the working
   * tree is clean. Tracked + untracked changes both surface; ignored
   * files do not.
   */
  async getWorkingTreeStatus(): Promise<string> {
    const out = await this.runGit(['status', '--porcelain']);
    return out.trimEnd();
  }

  async logFirstParentDetailed(
    ref: string,
    opts: DetailedLogOptions = {}
  ): Promise<DetailedCommit[]> {
    return readDetailedCommits(this.cwd, ref, opts, true);
  }

  async logDetailed(ref: string, opts: DetailedLogOptions = {}): Promise<DetailedCommit[]> {
    return readDetailedCommits(this.cwd, ref, opts);
  }

  /**
   * Commits in the range `base..head` (excludes base, includes head),
   * each with the file paths it touched. Used by the resume/show
   * `repo_state` block to surface "what's happened since the artifact
   * last saw the world."
   *
   * `--name-only` gives one file per line under each commit's header.
   * Format: `\x01<sha>\x01<subject>\n<file>\n<file>\n...` with `\x01`
   * as a sentinel so subjects containing newlines or other delimiter
   * characters parse cleanly.
   */
  async getCommitsBetween(
    base: string,
    head = 'HEAD'
  ): Promise<Array<{ sha: string; subject: string; files: string[] }>> {
    try {
      return await this.getCommitsBetweenStrict(base, head);
    } catch {
      return [];
    }
  }

  /**
   * Strict variant of {@link getCommitsBetween}: a git failure (an
   * unresolvable ref, unrelated shallow history, …) THROWS instead of
   * returning `[]`. Audit callers (`orcaops diff --reconcile`) must be
   * able to distinguish empty-because-clean from empty-because-error —
   * a swallowed failure there would read as "no uncovered commits".
   * Resolve both refs via {@link resolveCommit} first for a targeted
   * error message; this throw is the backstop for everything else.
   */
  async getCommitsBetweenStrict(
    base: string,
    head = 'HEAD'
  ): Promise<Array<{ sha: string; subject: string; files: string[] }>> {
    if (base === head) return [];
    const out = await this.runGit([
      'log',
      '--name-only',
      '--pretty=format:\x01%H\x01%s',
      `${base}..${head}`,
    ]);
    if (out.trim().length === 0) return [];

    const commits: Array<{ sha: string; subject: string; files: string[] }> = [];
    const lines = out.split(/\r?\n/);
    let current: { sha: string; subject: string; files: string[] } | null = null;
    for (const raw of lines) {
      if (raw.startsWith('\x01')) {
        // New commit header.
        if (current) commits.push(current);
        const rest = raw.slice(1);
        const sep = rest.indexOf('\x01');
        if (sep === -1) {
          current = { sha: rest, subject: '', files: [] };
        } else {
          current = { sha: rest.slice(0, sep), subject: rest.slice(sep + 1), files: [] };
        }
        continue;
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      if (current) current.files.push(trimmed);
    }
    if (current) commits.push(current);
    return commits;
  }
}
