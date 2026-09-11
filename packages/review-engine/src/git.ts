// Minimal git exec for the review sidecar. The core `runGit` is intentionally
// not barrel-exported and no synthesized-lineage-blame helper exists, so the
// review-specific git plumbing (commit-tree chaining + line-porcelain blame)
// lives here. Runs under Node (the sidecar target), so child_process is fine.

import { spawn } from 'node:child_process';

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export function isolatedReviewGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  return env;
}

export function runGit(
  cwd: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; stdin?: string } = {}
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args as string[], {
      cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

// Deterministic identity for the synthesized lineage commits — content is fixed
// by the trees, so the commits are reproducible run to run.
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'orcaops-review',
  GIT_AUTHOR_EMAIL: 'orcaops@local',
  GIT_COMMITTER_NAME: 'orcaops-review',
  GIT_COMMITTER_EMAIL: 'orcaops@local',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

/** Create a commit for `treeSha` with an optional parent; returns its sha. */
export async function commitTree(
  cwd: string,
  treeSha: string,
  parent: string | null,
  message: string
): Promise<string> {
  const args = ['commit-tree', treeSha];
  if (parent) args.push('-p', parent);
  args.push('-m', message);
  const r = await runGit(cwd, args, { env: { ...process.env, ...COMMIT_ENV } });
  if (r.code !== 0) throw new Error(`git commit-tree failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout.toString('utf8').trim();
}

/** Peel a ref/sha to its tree sha, or null if it doesn't resolve. */
export async function revParseTree(cwd: string, ref: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`]);
  if (r.code !== 0) return null;
  const sha = r.stdout.toString('utf8').trim();
  return sha.length > 0 ? sha : null;
}

const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/**
 * A blame result. `ok` distinguishes a genuine "no lines" answer from a git
 * failure: both leave `map` empty, while callers must surface the latter as
 * degraded attribution.
 */
export interface BlameResult {
  ok: boolean;
  map: Map<number, string>;
}

/**
 * Blame a file at a commit; returns final-line-number → owning-commit-sha.
 * Uses `--line-porcelain` (per-line headers) and `--root` (root commits get
 * their sha, not a boundary marker) — matching the existing blame contract.
 * A non-zero git exit degrades to `{ ok: false, map: <empty> }`.
 */
export async function blameFile(cwd: string, commit: string, file: string): Promise<BlameResult> {
  const map = new Map<number, string>();
  const r = await runGit(cwd, ['blame', '--line-porcelain', '--root', commit, '--', file]);
  if (r.code !== 0) return { ok: false, map };
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const m = BLAME_HEADER.exec(line);
    if (m) map.set(Number(m[2]), m[1]);
  }
  return { ok: true, map };
}

/**
 * Reverse-blame over `base..tip`: base-file line number → sha of the LAST
 * commit in the range that still contained the line. Under `--reverse` the
 * file is annotated as it exists at the range START, so the porcelain header's
 * third field (`final lineno` — BLAME_HEADER's second capture) is the
 * base-file line number, and renames are followed forward automatically. A
 * line that survives to the tip reports the TIP sha — callers detect deletion
 * by mapping to the reported commit's CHILD in the (linear) range.
 * Non-zero exit → `{ ok: false, map: <empty> }`, same silent-degrade as blameFile.
 */
export async function blameFileReverse(
  cwd: string,
  baseCommit: string,
  tipCommit: string,
  file: string
): Promise<BlameResult> {
  const map = new Map<number, string>();
  const r = await runGit(cwd, [
    'blame',
    '--line-porcelain',
    '--reverse',
    `${baseCommit}..${tipCommit}`,
    '--',
    file,
  ]);
  if (r.code !== 0) return { ok: false, map };
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const m = BLAME_HEADER.exec(line);
    if (m) map.set(Number(m[2]), m[1]);
  }
  return { ok: true, map };
}
