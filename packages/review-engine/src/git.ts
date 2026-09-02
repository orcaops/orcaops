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

/**
 * The blob sha of `file` as it exists in `commit`'s tree, or null if the path is
 * absent there. The blame cache keys on this side-specific blob: the tip blob for
 * an added path (it exists at the tip), the base blob for a deleted/renamed old
 * path (it exists only at the base). A path missing on the queried side → null,
 * and the caller falls back to an uncached blame.
 */
export async function revParseBlob(
  cwd: string,
  commit: string,
  file: string
): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${commit}:${file}`]);
  if (r.code !== 0) return null;
  const sha = r.stdout.toString('utf8').trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/**
 * A blame result. `ok` distinguishes a genuine "no lines" answer from a git
 * failure: both leave `map` empty, but the blame cache MUST NOT persist a
 * failure as an empty result (a transient glitch would otherwise poison the
 * entry). Callers that don't care about caching can ignore `ok` and read `map`.
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

/** One `--name-status` row. `status` is the letter (A/M/D/R/C/T/…); `score` is
 * the rename/copy similarity (e.g. 100 for `R100`) or null; `oldPath` is the
 * source path for a rename/copy, else null; `path` is the new/primary path. */
export interface NameStatusEntry {
  status: string;
  score: number | null;
  path: string;
  oldPath: string | null;
}

export interface NameStatusResult {
  ok: boolean;
  entries: NameStatusEntry[];
}

// Git can exit 0 while WARNING (to stderr) that inexact rename detection was
// skipped because too many files blew `diff.renameLimit` — an incomplete
// rename/copy classification we must not trust (it could misclassify a
// rename-involved path as stable and cache a wrong owner). Treat as ok:false.
const RENAME_SKIPPED_RE = /rename detection was skipped|diff\.renameLimit/i;

/**
 * Hermetic per-segment `--name-status` between two trees. Forces explicit
 * rename+copy detection (`-c diff.renames=true --find-renames --find-copies`)
 * so results never inherit the user's `diff.*` config, and reads NUL-delimited
 * raw paths (`-z`) so a path containing a tab/newline/quote is parsed verbatim,
 * never as a Git-quoted display string. Any failure — non-zero exit, the
 * rename-limit warning, or a truncated stream — returns `ok:false` with no
 * entries, so a caller degrades to full blame rather than trusting a partial
 * "this segment touched nothing" answer.
 */
/**
 * Parse a `git diff --name-status -z` raw string into entries. Pure (no git), so
 * it is directly unit-testable. `-z` frames each field with a trailing NUL:
 * `<status>\0<path>\0` for A/M/D/T, `R<score>\0<old>\0<new>\0` (and C) for
 * rename/copy — so non-empty output ALWAYS ends in a NUL. Output that doesn't (a
 * truncated stream) or that ends mid-record returns `ok:false`, so a caller never
 * trusts a possibly-cut final path (which could misclassify a rename-involved
 * path as stable). The split drops the trailing empty token after the final NUL.
 */
export function parseNameStatusZ(raw: string): NameStatusResult {
  if (raw.length > 0 && !raw.endsWith('\0')) return { ok: false, entries: [] };
  const tokens = raw.split('\0');
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const field = tokens[i];
    if (field === undefined || field.length === 0) {
      i += 1;
      continue; // the trailing empty token
    }
    const letter = field[0];
    const score = field.length > 1 ? Number.parseInt(field.slice(1), 10) : NaN;
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      // Empty path tokens mean the record was truncated after a field's NUL (a
      // path is never empty) — reject rather than emit a bogus rename.
      if (!oldPath || !newPath) return { ok: false, entries: [] };
      entries.push({
        status: letter,
        score: Number.isFinite(score) ? score : null,
        path: newPath,
        oldPath,
      });
      i += 3;
    } else {
      const p = tokens[i + 1];
      if (!p) return { ok: false, entries: [] };
      entries.push({ status: letter, score: null, path: p, oldPath: null });
      i += 2;
    }
  }
  return { ok: true, entries };
}

export async function nameStatus(
  cwd: string,
  openTree: string,
  closeTree: string
): Promise<NameStatusResult> {
  const r = await runGit(cwd, [
    '-c',
    'diff.renames=true',
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    '--find-copies',
    '--no-color',
    openTree,
    closeTree,
  ]);
  if (r.code !== 0 || RENAME_SKIPPED_RE.test(r.stderr)) return { ok: false, entries: [] };
  return parseNameStatusZ(r.stdout.toString('utf8'));
}
