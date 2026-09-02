import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type Checkpoint, selectExcludedPaths, uuidv7 } from '@orcaops/storage';

import type { Repo } from './repo.js';

/**
 * Captures non-destructive Git tree snapshots of the working tree under
 * `refs/orcaops/snap/<artifact>/<n>/<phase>` and exposes byte-bounded
 * tree diffing plus list/prune helpers. Local-only by design — the ref
 * namespace is separate from `refs/heads`, `refs/tags`, and `refs/remotes`,
 * so `git push` without explicit refspecs never carries it.
 */

// ── Public types ────────────────────────────────────────────────────

export type SnapshotPhase = 'open' | 'close' | 'abandon';

/**
 * NOT a locally-extensible union. These five values are persisted verbatim as
 * `CheckpointSnapshotBoundary.snapshot_error_reason`, whose enum
 * (`SnapshotFailureReasonSchema`) lives in the VENDORED prebuilt
 * `@orcaops/protocol` 0.0.24 tarball — reached via `@orcaops/diff-fingerprint`
 * 0.0.4, see `packages/storage/package.json`. Adding a member here without an
 * upstream protocol release plus a re-vendor makes the boundary unwritable
 * (the CLI's `toBoundary` assigns straight into the protocol-typed field, so
 * it fails to compile; a value that slipped through would fail the strict
 * schema at parse time).
 *
 * Which is why `error_message` below matters: `'unknown'` names nothing, and
 * the boundary schema is `.strict()` with four nullable fields, none of which
 * can carry free text — so the raw stderr cannot be stored alongside the
 * reason. The CLI surfaces it instead at the moment of failure, as a
 * `snapshot-capture-failed` entry in the command response's `warnings[]`
 * (`apps/orcaops-cli/src/commands/capture/checkpoint.ts`). Discard it there and
 * a failed boundary carries nothing on record but
 * `snapshot_error_reason: "unknown"`, which names nothing.
 */
export type SnapshotFailureReason =
  | 'merge_conflict'
  | 'index_locked'
  | 'no_space'
  | 'unborn_repo'
  | 'unknown';

export type SnapshotResult =
  | {
      ok: true;
      phase: SnapshotPhase;
      ref: string;
      tree_sha: string;
      commit_sha: string;
      /**
       * Paths unmerged (stage 1/2/3) in the REAL index at capture time,
       * unique and sorted. An unmerged index no longer aborts capture —
       * the temp index is seeded from HEAD (stage-0 only), so the tree
       * carries the conflicted paths' worktree bytes (markers included).
       * Callers treat these paths as attribution-degraded; `merge_conflict`
       * as a failure reason now arrives only via `classifySnapshotFailure`
       * stderr patterns.
       */
      unmerged_paths: readonly string[];
      /**
       * Set when the `ls-files -u` probe itself failed: `unmerged_paths`
       * is then empty-by-default, NOT verified-clean. Callers that
       * disclose degradation should warn rather than read it as clean.
       */
      unmerged_probe_failed?: boolean;
      /**
       * Set when the exclude probe (`git ls-files --others`) failed. The
       * capture is then taken with NO exclusion at all — neither the add-time
       * pathspecs nor the index scrub have anything to act on — and it is
       * fail-open by contract, so nothing blocks. Callers must disclose it:
       * silence here reads as "there was nothing to exclude".
       */
      exclusion_probe_failed?: boolean;
    }
  | {
      ok: false;
      phase: SnapshotPhase;
      error_reason: SnapshotFailureReason;
      error_message?: string;
    };

export type DiffSnapshotResult =
  | { ok: true; diff: Uint8Array; truncated: boolean; byte_count: number }
  | { ok: false; reason: 'git_diff_failed' | 'unknown' };

export interface ReviewWorktreeTreeResult {
  tree_sha: string;
  /** Paths unmerged in the real index at capture time; see `SnapshotResult`. */
  unmerged_paths: string[];
  unmerged_probe_failed?: boolean;
  /** Explicitly opted-in, non-ignored untracked files included in the tree. */
  included_untracked: string[];
  /** Non-ignored untracked files omitted by the default tracked-only policy. */
  excluded_untracked: string[];
  /** Configured opt-ins Git classifies as ignored/generated. */
  ignored_opt_ins: string[];
  /** Configured opt-ins that matched neither an untracked file nor an ignored path. */
  unmatched_opt_ins: string[];
  /**
   * Opted-in untracked files the capture exclude set held out of the tree
   * anyway, VERIFIED absent from `tree_sha` rather than inferred from the
   * classification that asked for them to be held out.
   */
  sensitive_opt_ins: string[];
  /**
   * Opted-in files the exclude set matched that `tree_sha` contains regardless
   * — git tracks them in the index the tree was built from, and exclusion
   * covers untracked files only. Disjoint from `sensitive_opt_ins`: nothing
   * here was withheld, so nothing here may be disclosed as withheld.
   */
  retained_sensitive_opt_ins: string[];
  /** Byte/row classification for every non-ignored untracked file. */
  untracked_details: ReviewUntrackedEvidenceDetail[];
}

export interface ReviewUntrackedEvidenceDetail {
  path: string;
  bytes: number | null;
  /** Null for binary/unreadable files. */
  rows: number | null;
}

export interface SnapshotRefEntry {
  artifact_id: string;
  n: number;
  phase: SnapshotPhase;
  ref: string;
  commit_sha: string;
}

/** Exact ref value used by destructive compare-and-delete callers. */
export interface RefIdentity {
  ref: string;
  object_id: string;
}

// ── Constants ──────────────────────────────────────────────────────

/** Local-only ref namespace. Never pushed by `git push` without explicit refspec. */
export const SNAPSHOT_REF_PREFIX = 'refs/orcaops/snap';

/**
 * Local-only ref namespace for the per-artifact plan-time baseline.
 * One ref per artifact (NO `/n/phase` tail): `refs/orcaops/baseline/<artifact>`.
 */
export const BASELINE_REF_PREFIX = 'refs/orcaops/baseline';

/**
 * Local-only ref namespace for `review data`'s floor-tree pins. Two refs per
 * branch slug: `refs/orcaops/review/<slug>` (the pinned floor tree, wrapped in a
 * deterministic commit) and `refs/orcaops/review/<slug>-base`. They exist solely
 * to keep a review dir's pinned trees readable past `git gc`, so they are pruned
 * when gc collects that dir (`pruneReviewRefs`).
 */
export const REVIEW_REF_PREFIX = 'refs/orcaops/review';

/**
 * Most excluded paths a real repository has fit in one argv. Past this the
 * pathspec list is dropped and step 12 alone does the work — a bounded
 * command beats an E2BIG that would fail capture outright.
 */
const EXCLUDE_PATHSPEC_CAP = 256;

/**
 * Exclude orcaops' own VOLATILE write surfaces from snapshot trees —
 * capture data must not fingerprint itself. Live sessions append
 * usage-ledger lines between snapshot boundaries, so a truly-empty fence
 * could otherwise recover a 1-hunk `.orcaops/usage/` manifest; artifacts/
 * and cache/ are belt-and-suspenders for `artifacts.gitignore: false`
 * configs. Deliberately NOT a blanket `.orcaops/**`: committed files
 * there (`install.json`, `evaluators.yaml`) are legitimate user work and
 * must keep fingerprinting. Applied via `rm -r --cached` on the temp
 * index (step 11), NOT add-time exclude pathspecs — `git add` fails hard
 * on an exclude pathspec whose whole subtree is gitignored, which
 * artifacts/ and cache/ are by default. Forward-only — stored snapshot
 * tree SHAs are authoritative and never rewritten.
 *
 * `.agent-trace`: the agent-trace reference-impl convention
 * appends provenance records to an in-repo `.agent-trace/traces.jsonl`.
 * `orcaops export agent-trace` defaults to stdout for exactly this
 * reason, but a user following the upstream convention via `--out` must
 * not have trace files poison the next checkpoint's manifest — the same
 * self-fingerprinting class the volatile-dir exclusions above prevent.
 */
export const SNAPSHOT_ORCAOPS_EXCLUDE_DIRS: readonly string[] = [
  '.orcaops/tmp',
  '.orcaops/usage',
  '.orcaops/artifacts',
  '.orcaops/cache',
  '.orcaops/reviews',
  '.agent-trace',
];

/**
 * Nested `.orcaops` stores are NEVER legitimate — stores live at the repo
 * root by design, so any `<subdir>/.orcaops/` is litter from a wrong-root
 * invocation. Left in a snapshot tree it self-fingerprints at MB scale and
 * can push a review diff past `max_diff_bytes`, so step 11 scrubs it
 * alongside the volatile dirs.
 *
 * Root-safety: these are default (non-magic) pathspecs, whose wildcards are
 * fnmatch WITHOUT FNM_PATHNAME — `*` crosses `/`, so `*\/.orcaops/*` matches
 * index entries under a `.orcaops` at ANY nested depth. Each pattern requires
 * at least one leading path component before `/.orcaops`, so the ROOT
 * `.orcaops/` (committed config like install.json is user work) can never
 * match. The `*\/.orcaops` twin covers a nested path *named* `.orcaops` that
 * is a file rather than a directory.
 */
export const SNAPSHOT_NESTED_ORCAOPS_EXCLUDE_PATHSPECS: readonly string[] = [
  '*/.orcaops',
  '*/.orcaops/*',
];

/** Allowed phase values, used by `parseSnapshotRefName`. */
const SNAPSHOT_PHASES: readonly SnapshotPhase[] = ['open', 'close', 'abandon'];

// Both `commit-tree` call sites use the fixed
// `orcaops-snapshot <orcaops@local>` author/committer identity.

// ── Internal: runGit (promisified spawn with byte-bounded stdout) ──

export interface RunGitOptions {
  /**
   * Env vars for the spawned process. Callers MUST merge `process.env`
   * FIRST and then their overrides — `{ ...process.env, ...overrides }`
   * — so an ambient `GIT_INDEX_FILE`, `GIT_AUTHOR_NAME`, etc. cannot
   * shadow the values the snapshot pipeline relies on. Defaults to
   * `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * When set, the child is sent `SIGTERM` once accumulated stdout
   * exceeds `maxStdoutBytes`. `truncated` and `killedByCap` are set
   * on the result; `stdout` is sliced to exactly `maxStdoutBytes`.
   */
  maxStdoutBytes?: number;
  /** UTF-8 text written to the child's stdin, then stdin is closed. */
  stdin?: string;
}

export interface RunGitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  /** True when the child was killed because stdout exceeded `maxStdoutBytes`. */
  truncated: boolean;
  /**
   * Same as `truncated`; surfaced as a distinct field for callers that
   * need to disambiguate "we killed it on purpose" from "git was
   * externally signalled".
   */
  killedByCap: boolean;
}

export async function runGit(
  cwd: string,
  args: string[],
  opts: RunGitOptions = {}
): Promise<RunGitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    if (childStdout === null || childStderr === null || childStdin === null) {
      reject(new Error('runGit: spawned child is missing one or more stdio pipes'));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrStr = '';
    let truncated = false;
    let killedByCap = false;

    childStdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      if (opts.maxStdoutBytes !== undefined && stdoutBytes > opts.maxStdoutBytes && !killedByCap) {
        truncated = true;
        killedByCap = true;
        child.kill('SIGTERM');
      }
    });

    childStderr.on('data', (chunk: Buffer) => {
      stderrStr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code, signal) => {
      let stdout = Buffer.concat(stdoutChunks);
      if (killedByCap && opts.maxStdoutBytes !== undefined) {
        stdout = stdout.subarray(0, opts.maxStdoutBytes);
      }
      resolve({
        code,
        signal,
        stdout,
        stderr: stderrStr,
        truncated,
        killedByCap,
      });
    });

    if (opts.stdin !== undefined) {
      childStdin.end(opts.stdin, 'utf8');
    } else {
      childStdin.end();
    }
  });
}

// ── Internal: repo top-level resolution ────────────────────────────

/**
 * Resolves the absolute path of the repo's top-level (worktree root)
 * via `git rev-parse --show-toplevel`. This is necessary because
 * `Repo.cwd` may be any subdirectory of the actual repo — anchoring the
 * `git add -A` cwd at the toplevel ensures the walk covers the whole
 * worktree. (The temp index itself lives OUTSIDE the worktree; see
 * `allocateTempIndex`.)
 *
 * Throws when `cwd` is not inside a git repo.
 */
export async function resolveRepoTopLevel(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (result.code !== 0) {
    throw new Error(
      `resolveRepoTopLevel: '${cwd}' is not inside a git work tree (` +
        `git rev-parse exited ${result.code}: ${result.stderr.trim()})`
    );
  }
  return result.stdout.toString('utf8').trim();
}

// ── Internal: unmerged-path parsing ────────────────────────────────

/**
 * Parse `git ls-files -u -z` output (`<mode> <sha> <stage>\t<path>` records,
 * NUL-terminated) into a unique sorted path list. `-z` is load-bearing:
 * without it paths are C-quoted per `core.quotePath` (unicode/quotes/
 * backslashes mangle a newline-split parser). The same path appears up to
 * three times (once per stage), and rename/rename conflicts list DIFFERENT
 * paths at different stages — so dedupe by path, keeping every distinct one.
 *
 * Exported for `Repo.listUnmergedPaths` and colocated tests; NOT part of
 * the `git/index.ts` barrel surface.
 */
export function parseUnmergedPathsZ(stdout: string): string[] {
  const paths = new Set<string>();
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const p = record.slice(tab + 1);
    if (p.length > 0) paths.add(p);
  }
  return [...paths].sort();
}

// ── Internal: temp-index path ──────────────────────────────────────

/**
 * Allocate a PRIVATE temp directory for one snapshot capture and return both
 * the directory (for teardown) and the index path inside it.
 *
 * The index deliberately lives OUTSIDE the worktree. An index at
 * `<repoTopLevel>/.orcaops/tmp/snap-<uuid>.index` makes capture
 * self-referential: `git add -A` walks the very index it is writing, which
 * forces step 8 to carry an `:(exclude).orcaops/tmp/**` pathspec. In a repo
 * that gitignores `.orcaops/tmp/`, git refuses that pathspec outright — an
 * exclude naming a fully-ignored subtree fails `git add` with "paths are
 * ignored by one of your .gitignore files" — so every capture in that repo
 * fails. Keeping the index out of the worktree removes the self-reference
 * rather than working around it: there is nothing to exclude, nothing to
 * race, and behaviour does not depend on user gitignore state.
 *
 * `mkdtemp` (not a predictable path) gives safe permissions and isolation
 * between the parallel captures the pipeline runs.
 */
export async function allocateTempIndex(): Promise<{ directory: string; indexPath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-snap-'));
  return { directory, indexPath: path.join(directory, `snap-${uuidv7()}.index`) };
}

// ── Internal: snapshot ref name builder + validator ────────────────

/**
 * Build (and minimally validate) the ref name for a snapshot.
 *
 * The output components are all controlled by us (artifact_id is a
 * UUIDv7 from storage, n is a positive integer, phase is one of three
 * known strings), so the ref is always well-formed under Git's rules.
 * The validation here is defensive against future callers passing
 * surprising artifact_ids — it catches the common foot-guns (control
 * chars, special chars, `..`, leading/trailing dot) without forking a
 * `git check-ref-format` invocation per call.
 *
 * Callers that need to validate UNTRUSTED ref strings (e.g. prune)
 * should additionally pass through `git check-ref-format` to catch
 * the long-tail rules.
 */
export function snapshotRefName(artifactId: string, n: number, phase: SnapshotPhase): string {
  // The regex intentionally matches ASCII control characters (\x00-\x1F
  // and DEL \x7F) along with Git's forbidden ref-name characters
  // (~ ^ : ? * [ \\ space). Suppressing eslint's no-control-regex here
  // because matching control chars is the explicit purpose.
  // eslint-disable-next-line no-control-regex
  if (!artifactId || /[\x00-\x1F\x7F~^:?*[\\ ]/.test(artifactId) || artifactId.includes('..')) {
    throw new Error(`snapshotRefName: invalid artifactId "${artifactId}"`);
  }
  if (artifactId.startsWith('.') || artifactId.endsWith('.') || artifactId.endsWith('.lock')) {
    throw new Error(
      `snapshotRefName: artifactId has reserved leading/trailing form: "${artifactId}"`
    );
  }
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`snapshotRefName: n must be a positive integer, got ${n}`);
  }
  if (!SNAPSHOT_PHASES.includes(phase)) {
    throw new Error(`snapshotRefName: invalid phase "${phase}"`);
  }
  return `${SNAPSHOT_REF_PREFIX}/${artifactId}/${n}/${phase}`;
}

/**
 * Parse a `refs/orcaops/snap/<artifact>/<n>/<phase>` ref back into its
 * components, or return null if the string doesn't match the namespace.
 * Used by `listSnapshotRefs` to filter `git for-each-ref` output —
 * malformed entries (which shouldn't exist, but defensive) are skipped
 * rather than crashing the listing.
 */
export function parseSnapshotRefName(
  ref: string
): { artifact_id: string; n: number; phase: SnapshotPhase } | null {
  const prefix = `${SNAPSHOT_REF_PREFIX}/`;
  if (!ref.startsWith(prefix)) return null;
  const rest = ref.slice(prefix.length);
  // `<artifact>/<n>/<phase>` — split into exactly 3 segments.
  const parts = rest.split('/');
  if (parts.length !== 3) return null;
  const [artifactId, nStr, phaseStr] = parts;
  if (!artifactId || !/^\d+$/.test(nStr)) return null;
  if (!SNAPSHOT_PHASES.includes(phaseStr as SnapshotPhase)) return null;
  const n = Number.parseInt(nStr, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return { artifact_id: artifactId, n, phase: phaseStr as SnapshotPhase };
}

// ── Internal: baseline ref name builder + validator ────────

/**
 * Build (and minimally validate) the per-artifact baseline ref name.
 *
 * Mirrors `snapshotRefName`'s artifactId validation exactly (control
 * chars / Git-forbidden chars / `..` / reserved leading-trailing form),
 * but the baseline namespace has NO `<n>/<phase>` tail — there is exactly
 * one baseline ref per artifact: `refs/orcaops/baseline/<artifact>`.
 */
export function baselineRefName(artifactId: string): string {
  // eslint-disable-next-line no-control-regex
  if (!artifactId || /[\x00-\x1F\x7F~^:?*[\\ ]/.test(artifactId) || artifactId.includes('..')) {
    throw new Error(`baselineRefName: invalid artifactId "${artifactId}"`);
  }
  if (artifactId.startsWith('.') || artifactId.endsWith('.') || artifactId.endsWith('.lock')) {
    throw new Error(
      `baselineRefName: artifactId has reserved leading/trailing form: "${artifactId}"`
    );
  }
  return `${BASELINE_REF_PREFIX}/${artifactId}`;
}

/**
 * Parse a `refs/orcaops/baseline/<artifact>` ref back into its artifact
 * id, or return null if the string doesn't match the namespace. The
 * baseline ref has NO tail, so any remainder containing a `/` (a
 * malformed-after-id ref) is rejected.
 */
export function parseBaselineRefName(ref: string): { artifact_id: string } | null {
  const prefix = `${BASELINE_REF_PREFIX}/`;
  if (!ref.startsWith(prefix)) return null;
  const rest = ref.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  return { artifact_id: rest };
}

// ── Internal: failure classification ───────────────────────────────

/**
 * Maps `runGit` failure output to a `SnapshotFailureReason`.
 *
 * Note: `unborn_repo` is intentionally NOT produced here — that state
 * is short-circuited in `captureCheckpointSnapshot` BEFORE any git
 * invocation that could surface it. Keeping the classifier focused on
 * post-`getHeadSha` failures keeps the patterns disjoint.
 *
 * Pattern set is intentionally conservative: stderr substrings that
 * are stable across Git versions (and the well-known `ENOSPC` errno
 * code). Anything that doesn't match cleanly is `'unknown'`, which
 * surfaces in the projection as a generic skip and prompts the user
 * to look at `error_message` for the raw stderr.
 */
export function classifySnapshotFailure(stderr: string, errno?: string): SnapshotFailureReason {
  if (errno === 'ENOSPC') return 'no_space';
  const s = stderr.toLowerCase();
  if (s.includes('no space left on device')) return 'no_space';
  if (
    s.includes('cannot lock ref') ||
    (s.includes('unable to create') && s.includes('.lock')) ||
    s.includes('index.lock') ||
    s.includes('cannot lock')
  ) {
    return 'index_locked';
  }
  if (
    s.includes('unmerged paths') ||
    s.includes('needs merge') ||
    s.includes('unable to write new_index') ||
    s.includes('error building trees') ||
    s.includes('cannot do a partial commit because of unmerged files')
  ) {
    return 'merge_conflict';
  }
  return 'unknown';
}

// ── Public functions ─────────────────────────────────────────────────

/**
 * Capture-only core of the snapshot pipeline: build the worktree tree and
 * a commit object for it, WITHOUT pinning any ref. Shared by
 * `captureCheckpointSnapshot` (checkpoint boundaries) and
 * `captureBaselineSnapshot` (the plan-time baseline) so the temp-index
 * sequence lives in exactly one place. Sequence (steps 2-14):
 *
 *   2. Resolve repo top-level (Repo.cwd may be a subdirectory).
 *   3. Unborn-repo gate: if `getHeadSha()` throws, return 'unborn_repo'
 *      without invoking any further git command.
 *   4. Allocate a PRIVATE temp directory OUTSIDE the worktree
 *      (`allocateTempIndex`) and take the index path inside it.
 *   5. try/finally: best-effort removal of that whole directory.
 *   6. `git read-tree HEAD` with `GIT_INDEX_FILE=tempIndex`.
 *   7. Resolve `excludePatterns` to a CONCRETE set of untracked paths via
 *      `git ls-files --others --exclude-standard`. Empty when the caller
 *      passed no patterns, and empty when that probe fails.
 *   8. `git add -A -- .` with the temp index, carrying step 7's paths as
 *      `:(exclude,literal)` pathspecs so their blobs are never written at
 *      all. `add -u` and NO pathspecs under `trackedOnly`; the pathspecs are
 *      also dropped past `EXCLUDE_PATHSPEC_CAP`, and a failure carrying them
 *      retries without them. Step 12, not this one, is what makes the tree
 *      clean.
 *   9. Unmerged-path collection via `git ls-files -u -z` against the REAL
 *      index. An unmerged index does NOT abort capture — the temp index is
 *      stage-0 only, so the pipeline is mechanically safe; the collected
 *      set is returned so callers can degrade attribution for those paths.
 *      Fail-open: a failed probe yields an empty set plus
 *      `unmerged_probe_failed`. Runs adjacent to the `add` walk to
 *      minimize the window in which a concurrent resolve skews the set.
 *  10. `git add` for `includeUntracked` — the review path's opt-in untracked
 *      evidence, staged literally.
 *  11. `git rm -r --cached` for orcaops' own volatile dirs and any NESTED
 *      `.orcaops` store: the one scrub immune to gitignore state.
 *  12. `git rm -r --cached` for step 7's paths, literally. Authoritative —
 *      an excluded path is absent from the tree because of this step, not
 *      because of step 8's pathspecs.
 *  13. `git write-tree` → `tree_sha`.
 *  14. `git commit-tree` with fixed `orcaops-snapshot <orcaops@local>`
 *      identity (env spread order: process.env first, our overrides
 *      LAST, so ambient `GIT_AUTHOR_*` cannot shadow ours). Skipped under
 *      `skipCommit`, which returns `commit_sha: null` instead.
 *
 * Ref pinning (step 15) is the caller's job via `pinRef`. `label` is the
 * trailing component of the commit message `orcaops snapshot ${label}`;
 * callers pass `${artifactId}/${n}/${phase}` (checkpoint) or
 * `baseline/${artifactId}` (the plan-time baseline).
 *
 * Fail-open: any failure returns `{ ok: false, error_reason }`
 * (NO `phase` field — that is the caller's lifecycle concern); the
 * pipeline never throws. The outer try/catch is the backstop for runGit
 * spawn-channel rejections (missing git binary, EACCES, ENOMEM, …).
 */
export async function captureWorktreeTree(
  repo: Repo,
  label: string,
  opts?: { excludePatterns?: readonly string[] }
): Promise<
  | {
      ok: true;
      tree_sha: string;
      commit_sha: string;
      repoTopLevel: string;
      unmerged_paths: readonly string[];
      unmerged_probe_failed?: boolean;
      /**
       * Set when the exclude probe (`git ls-files --others`) failed. The
       * capture is then taken with NO exclusion at all — neither the add-time
       * pathspecs nor the index scrub have anything to act on — and it is
       * fail-open by contract, so nothing blocks. Callers must disclose it:
       * silence here reads as "there was nothing to exclude".
       */
      exclusion_probe_failed?: boolean;
    }
  | { ok: false; error_reason: SnapshotFailureReason; error_message?: string }
>;
export async function captureWorktreeTree(
  repo: Repo,
  label: string,
  opts: {
    skipCommit: true;
    trackedOnly?: boolean;
    /**
     * Globs whose matching UNTRACKED files must not enter the tree. Resolved
     * against `git ls-files --others --exclude-standard`, so the concrete set
     * is definitionally non-ignored — which is what makes it safe to pass as
     * an add-time pathspec (see step 7).
     */
    excludePatterns?: readonly string[];
    includeUntracked?: readonly string[];
  }
): Promise<
  | {
      ok: true;
      tree_sha: string;
      commit_sha: null;
      repoTopLevel: string;
      unmerged_paths: readonly string[];
      unmerged_probe_failed?: boolean;
      /**
       * Set when the exclude probe (`git ls-files --others`) failed. The
       * capture is then taken with NO exclusion at all — neither the add-time
       * pathspecs nor the index scrub have anything to act on — and it is
       * fail-open by contract, so nothing blocks. Callers must disclose it:
       * silence here reads as "there was nothing to exclude".
       */
      exclusion_probe_failed?: boolean;
    }
  | { ok: false; error_reason: SnapshotFailureReason; error_message?: string }
>;
export async function captureWorktreeTree(
  repo: Repo,
  label: string,
  opts: {
    skipCommit?: boolean;
    /** Review-only mode: update tracked paths without ingesting every untracked file. */
    trackedOnly?: boolean;
    /** Literal untracked paths to add after the tracked-only update. */
    includeUntracked?: readonly string[];
    /**
     * Globs whose matching UNTRACKED files must not enter the tree. Resolved
     * against `git ls-files --others --exclude-standard`, so the concrete set
     * is definitionally non-ignored — which is what makes it safe to pass as
     * an add-time pathspec.
     */
    excludePatterns?: readonly string[];
  } = {}
): Promise<
  | {
      ok: true;
      tree_sha: string;
      commit_sha: string | null;
      repoTopLevel: string;
      unmerged_paths: readonly string[];
      unmerged_probe_failed?: boolean;
      /**
       * Set when the exclude probe (`git ls-files --others`) failed. The
       * capture is then taken with NO exclusion at all — neither the add-time
       * pathspecs nor the index scrub have anything to act on — and it is
       * fail-open by contract, so nothing blocks. Callers must disclose it:
       * silence here reads as "there was nothing to exclude".
       */
      exclusion_probe_failed?: boolean;
    }
  | { ok: false; error_reason: SnapshotFailureReason; error_message?: string }
> {
  try {
    // Step 2: resolve repo top-level. `Repo.cwd` may be a subdirectory.
    let repoTopLevel: string;
    try {
      repoTopLevel = await resolveRepoTopLevel(repo.cwd);
    } catch (err) {
      return {
        ok: false,
        error_reason: 'unknown',
        error_message: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 3: unborn-repo gate. Deterministic v1 behavior — if HEAD is
    // missing, return 'unborn_repo' immediately without pinning a ref.
    try {
      await repo.getHeadSha();
    } catch {
      return { ok: false, error_reason: 'unborn_repo' };
    }

    // Step 4: allocate a PRIVATE temp directory (outside the worktree) and
    // the index path inside it. mkdtemp creates the directory eagerly, so
    // this both allocates and ensures existence — and its failure is the one
    // this handler exists for (ENOSPC, EACCES on the OS temp dir).
    let tempDir: string;
    let tempIndex: string;
    try {
      ({ directory: tempDir, indexPath: tempIndex } = await allocateTempIndex());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errno = (err as NodeJS.ErrnoException).code;
      return {
        ok: false,
        error_reason: classifySnapshotFailure(message, errno),
        error_message: message,
      };
    }

    // Step 5: try/finally cleanup of temp index AND lock sibling.
    try {
      // Env for index-bound git commands. Spread order is load-bearing:
      // process.env first, override LAST, so any ambient GIT_INDEX_FILE
      // in the caller's environment cannot shadow our temp-index path.
      const indexEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndex,
      };
      // Steps 8 and 11 rely on DEFAULT pathspec semantics (fnmatch wildcards);
      // ambient pathspec-mode toggles would silently change what is excluded
      // from the snapshot tree.
      delete indexEnv.GIT_LITERAL_PATHSPECS;
      delete indexEnv.GIT_GLOB_PATHSPECS;
      delete indexEnv.GIT_NOGLOB_PATHSPECS;
      delete indexEnv.GIT_ICASE_PATHSPECS;

      // Step 6: read-tree HEAD into the temp index.
      const readTree = await runGit(repoTopLevel, ['read-tree', 'HEAD'], { env: indexEnv });
      if (readTree.code !== 0) {
        return {
          ok: false,
          error_reason: classifySnapshotFailure(readTree.stderr),
          error_message: readTree.stderr.trim(),
        };
      }

      // Step 7: resolve the exclude set to CONCRETE untracked paths.
      //
      // `ls-files --others --exclude-standard` lists only non-ignored files,
      // which is what makes step 8 safe: an exclude pathspec naming an ignored
      // path makes `git add` fail outright, and a user glob could easily name
      // one. Matching first means the pathspec can only ever carry paths git
      // will accept.
      //
      // Tracked files are deliberately out of scope. One is already in git
      // history, so capture amplifies nothing by including it, and dropping it
      // from the tree would forge a permanent phantom deletion in every
      // checkpoint manifest that follows.
      //
      // Resolved for tracked-only captures too. `add -u` cannot stage an
      // untracked file, but the opt-in `git add` below can — and does, on the
      // review path — so an exclude set that stopped at the tracked-only gate
      // would leave the one door it exists to close wide open.
      let excludedPaths: readonly string[] = [];
      let exclusionProbeFailed = false;
      if ((opts.excludePatterns?.length ?? 0) > 0) {
        const untracked = await runGit(
          repoTopLevel,
          ['ls-files', '--others', '--exclude-standard', '-z'],
          { env: indexEnv }
        );
        if (untracked.code === 0) {
          excludedPaths = selectExcludedPaths(
            untracked.stdout.toString('utf8').split('\0').filter(Boolean),
            opts.excludePatterns ?? []
          );
        } else {
          exclusionProbeFailed = true;
        }
        // A failed probe leaves the set empty, and this capture is then taken
        // WITHOUT exclusion — neither the step 8 pathspecs nor the step 12
        // scrub has anything to act on. Fail-open by contract: capture never
        // blocks a checkpoint. It is reported rather than silent, though: the
        // checkout disclosure re-runs the patterns against the recorded tree,
        // which is too late for anyone deciding whether this capture is safe.
      }

      // Step 8: `git add -A`, anchored at the repo top-level so the walk covers
      // the whole worktree.
      //
      // Excluded paths are passed as `:(exclude,literal)` pathspecs so the blob
      // is never written to the object store at all. That is only safe because
      // step 7 resolved them from non-ignored files — an exclude pathspec
      // naming a fully-gitignored subtree makes `git add` fail outright with
      // "paths are ignored by one of your .gitignore files", which
      // advice.addIgnoredFile=false does not silence. Volatile `.orcaops` dirs
      // still go through step 11 instead, because they ARE frequently ignored.
      //
      // Empty under `trackedOnly`, which is load-bearing beyond the unused
      // argument: the fail-open retry below drops the pathspecs by switching to
      // `add -A`, so a tracked-only capture that built them could answer a
      // failed `add -u` by staging every untracked file in the worktree.
      const excludePathspecs =
        opts.trackedOnly !== true &&
        excludedPaths.length > 0 &&
        excludedPaths.length <= EXCLUDE_PATHSPEC_CAP
          ? excludedPaths.map((path) => `:(exclude,literal)${path}`)
          : [];
      const addArgs =
        opts.trackedOnly === true
          ? ['add', '-u', '--', '.']
          : ['add', '-A', '--', '.', ...excludePathspecs];
      let addAll = await runGit(repoTopLevel, addArgs, { env: indexEnv });
      if (addAll.code !== 0 && excludePathspecs.length > 0) {
        // Fail open on a git-version quirk in the pathspec: step 12 is the
        // authoritative scrub, so retrying without them still yields a clean
        // tree — it just also writes the blobs first.
        addAll = await runGit(repoTopLevel, ['add', '-A', '--', '.'], { env: indexEnv });
      }
      if (addAll.code !== 0) {
        return {
          ok: false,
          error_reason: classifySnapshotFailure(addAll.stderr),
          error_message: addAll.stderr.trim(),
        };
      }

      // Step 9. The probe env strips GIT_INDEX_FILE — an ambient value (or
      // a copy-paste of indexEnv) would silently probe the stage-0-only temp
      // index and always read clean.
      const probeEnv: NodeJS.ProcessEnv = { ...process.env };
      delete probeEnv.GIT_INDEX_FILE;
      const lsUnmerged = await runGit(repoTopLevel, ['ls-files', '-u', '-z'], { env: probeEnv });
      const probeFailed = lsUnmerged.code !== 0;
      const unmergedPaths: readonly string[] = probeFailed
        ? []
        : parseUnmergedPathsZ(lsUnmerged.stdout.toString('utf8'));

      // Step 10: stage the review path's opt-in untracked evidence.
      if ((opts.includeUntracked?.length ?? 0) > 0) {
        const addOptIns = await runGit(
          repoTopLevel,
          ['add', '--', ...(opts.includeUntracked ?? [])],
          {
            env: { ...indexEnv, GIT_LITERAL_PATHSPECS: '1' },
          }
        );
        if (addOptIns.code !== 0) {
          return {
            ok: false,
            error_reason: classifySnapshotFailure(addOptIns.stderr),
            error_message: addOptIns.stderr.trim(),
          };
        }
      }

      // Step 11: scrub every orcaops VOLATILE dir from the temp index
      // (capture data must not fingerprint itself).
      //
      // Two sources land such paths in the index: read-tree HEAD (step 6)
      // seeds tracked-but-volatile paths (e.g. a committed usage ledger),
      // and step 8's `add -A` stages non-gitignored volatile files (a
      // usage-ledger line appended between fences would otherwise recover
      // a 1-hunk `.orcaops/usage/` manifest). `rm -r --cached` here is the
      // one mechanism immune to gitignore state — an add-time exclude
      // pathspec over a fully-gitignored subtree fails `git add` outright.
      // `--cached` leaves the working tree alone; `--ignore-unmatch` makes
      // the no-match case a no-op. Committed non-volatile `.orcaops/`
      // files (install.json, evaluators.yaml) are user work and stay.
      // NESTED `.orcaops` dirs (any depth) are scrubbed wholesale — they
      // are never legitimate and self-fingerprint at MB scale.
      const rmVolatile = await runGit(
        repoTopLevel,
        [
          'rm',
          '-r',
          '--cached',
          '--ignore-unmatch',
          '--',
          ...SNAPSHOT_ORCAOPS_EXCLUDE_DIRS,
          ...SNAPSHOT_NESTED_ORCAOPS_EXCLUDE_PATHSPECS,
        ],
        { env: indexEnv }
      );
      if (rmVolatile.code !== 0) {
        return {
          ok: false,
          error_reason: classifySnapshotFailure(rmVolatile.stderr),
          error_message: rmVolatile.stderr.trim(),
        };
      }

      // Step 12: scrub the excluded paths from the index, authoritatively.
      //
      // Separate `git rm` from the volatile-dir scrub above on purpose: that
      // one relies on DEFAULT pathspec magic so `*/.orcaops/*` matches at any
      // depth, while these are resolved literal paths and must not be
      // reinterpreted as globs.
      if (excludedPaths.length > 0) {
        const rmExcluded = await runGit(
          repoTopLevel,
          ['rm', '-r', '--cached', '--ignore-unmatch', '--', ...excludedPaths],
          { env: { ...indexEnv, GIT_LITERAL_PATHSPECS: '1' } }
        );
        if (rmExcluded.code !== 0) {
          return {
            ok: false,
            error_reason: classifySnapshotFailure(rmExcluded.stderr),
            error_message: rmExcluded.stderr.trim(),
          };
        }
      }

      // Step 13: write-tree.
      const writeTree = await runGit(repoTopLevel, ['write-tree'], { env: indexEnv });
      if (writeTree.code !== 0) {
        return {
          ok: false,
          error_reason: classifySnapshotFailure(writeTree.stderr),
          error_message: writeTree.stderr.trim(),
        };
      }
      const tree_sha = writeTree.stdout.toString('utf8').trim();

      // Tree-only capture. `orcaops diff --attribution` runs
      // this pipeline on every invocation — skipping commit-tree avoids
      // accreting unreachable loose COMMIT objects per run. (The tree
      // object is still written; content-addressed, deduped across
      // identical worktree states.)
      if (opts.skipCommit === true) {
        return {
          ok: true,
          tree_sha,
          commit_sha: null,
          repoTopLevel,
          unmerged_paths: unmergedPaths,
          ...(probeFailed ? { unmerged_probe_failed: true } : {}),
          ...(exclusionProbeFailed ? { exclusion_probe_failed: true } : {}),
        };
      }

      // Step 14: commit-tree with fixed orcaops-snapshot identity. Dates
      // are intentionally NOT pinned — dynamic dates avoid SHA collisions
      // across re-snapshots of an unchanged tree. Env spread: process.env
      // first, overrides LAST.
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'orcaops-snapshot',
        GIT_AUTHOR_EMAIL: 'orcaops@local',
        GIT_COMMITTER_NAME: 'orcaops-snapshot',
        GIT_COMMITTER_EMAIL: 'orcaops@local',
      };
      const commitMsg = `orcaops snapshot ${label}`;
      const commitTree = await runGit(repoTopLevel, ['commit-tree', tree_sha, '-m', commitMsg], {
        env: commitEnv,
      });
      if (commitTree.code !== 0) {
        return {
          ok: false,
          error_reason: classifySnapshotFailure(commitTree.stderr),
          error_message: commitTree.stderr.trim(),
        };
      }
      const commit_sha = commitTree.stdout.toString('utf8').trim();

      return {
        ok: true,
        tree_sha,
        commit_sha,
        repoTopLevel,
        unmerged_paths: unmergedPaths,
        ...(probeFailed ? { unmerged_probe_failed: true } : {}),
        ...(exclusionProbeFailed ? { exclusion_probe_failed: true } : {}),
      };
    } finally {
      // Best-effort cleanup of the WHOLE private directory, not just the
      // index: git also writes `<index>.lock` there during write-tree-style
      // operations, and an interrupted command can leave it behind. The
      // directory is outside the worktree, so nothing repo-scoped would ever
      // reclaim it — this `finally` is the only thing that does.
      //
      // Completed snapshot data does NOT live here: the tree and commit
      // objects are written into the repo's own object store and pinned by a
      // ref, so losing this directory (or the machine restarting) cannot
      // remove a snapshot that already returned.
      await Promise.allSettled([rm(tempDir, { recursive: true, force: true })]);
    }
  } catch (err) {
    // Fail-open backstop. Any thrown error that escaped the typed handlers
    // above — most notably a runGit Promise rejection from a spawn-channel
    // failure (missing git binary, EACCES, ENOMEM, etc.) — becomes a
    // fail-open 'unknown' result so the pipeline never breaks.
    return {
      ok: false,
      error_reason: 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Tree-only live worktree capture: the exact snapshot
 * pipeline — temp index, `add -A` (untracked included), volatile-dir
 * scrub — WITHOUT the commit object. This is the like-for-like live side
 * for attribution matching: a diff built from this tree normalizes
 * identically to the capture-time manifests. Fail-open like the rest of
 * the pipeline; never throws.
 */
export async function captureWorktreeTreeSha(
  repo: Repo,
  opts: { excludePatterns?: readonly string[] } = {}
): Promise<
  | {
      ok: true;
      tree_sha: string;
      unmerged_paths: readonly string[];
      unmerged_probe_failed?: boolean;
      /**
       * Set when the exclude probe (`git ls-files --others`) failed. The
       * capture is then taken with NO exclusion at all — neither the add-time
       * pathspecs nor the index scrub have anything to act on — and it is
       * fail-open by contract, so nothing blocks. Callers must disclose it:
       * silence here reads as "there was nothing to exclude".
       */
      exclusion_probe_failed?: boolean;
    }
  | { ok: false; error_reason: SnapshotFailureReason; error_message?: string }
> {
  // The same excludes as a checkpoint tree. Without them the live tree would
  // still contain a file every post-exclude snapshot omits, and `diff
  // --attribution` would read it as a deletion against each one.
  const result = await captureWorktreeTree(repo, 'live-attribution', {
    skipCommit: true,
    ...(opts.excludePatterns ? { excludePatterns: opts.excludePatterns } : {}),
  });
  if (!result.ok) return result;
  return {
    ok: true,
    tree_sha: result.tree_sha,
    unmerged_paths: result.unmerged_paths,
    ...(result.unmerged_probe_failed === true ? { unmerged_probe_failed: true } : {}),
  };
}

function normalizeReviewOptIn(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (
    normalized.length === 0 ||
    path.isAbsolute(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    return null;
  }
  return normalized;
}

async function inspectUntrackedFile(
  repoTopLevel: string,
  filePath: string
): Promise<ReviewUntrackedEvidenceDetail> {
  try {
    const info = await lstat(path.join(repoTopLevel, filePath));
    if (!info.isFile()) return { path: filePath, bytes: info.size, rows: null };
    let newlineCount = 0;
    let binary = false;
    let lastByte: number | null = null;
    for await (const chunk of createReadStream(path.join(repoTopLevel, filePath))) {
      const bytes = chunk as Buffer;
      for (const byte of bytes) {
        if (byte === 0) binary = true;
        if (byte === 10) newlineCount += 1;
        lastByte = byte;
      }
    }
    const rows = binary ? null : info.size === 0 ? 0 : newlineCount + (lastByte === 10 ? 0 : 1);
    return { path: filePath, bytes: info.size, rows };
  } catch {
    return { path: filePath, bytes: null, rows: null };
  }
}

/**
 * Which of `paths` the written tree actually contains.
 *
 * Chunked because the caller's set is unbounded and each path costs one argv
 * entry; literal pathspecs because these are resolved paths, and a `*` or `[`
 * in a filename must not be reinterpreted as a glob here.
 */
async function selectPathsPresentInTree(
  repoTopLevel: string,
  treeSha: string,
  paths: readonly string[]
): Promise<
  | { ok: true; present: ReadonlySet<string> }
  | { ok: false; error_reason: SnapshotFailureReason; error_message?: string }
> {
  const present = new Set<string>();
  for (let start = 0; start < paths.length; start += EXCLUDE_PATHSPEC_CAP) {
    const chunk = paths.slice(start, start + EXCLUDE_PATHSPEC_CAP);
    const listed = await runGit(
      repoTopLevel,
      ['ls-tree', '-r', '--name-only', '-z', treeSha, '--', ...chunk],
      { env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } }
    );
    if (listed.code !== 0) {
      return {
        ok: false,
        error_reason: classifySnapshotFailure(listed.stderr),
        error_message: listed.stderr.trim(),
      };
    }
    for (const entry of listed.stdout.toString('utf8').split('\0')) {
      if (entry.length > 0) present.add(entry);
    }
  }
  return { ok: true, present };
}

/**
 * Review-specific live tree capture. Unlike checkpoint attribution snapshots,
 * the review floor is tracked-only by default; non-ignored untracked evidence
 * must be explicitly opted in. The classification is returned alongside the
 * tree so exclusions can never disappear behind a plausible-looking diff.
 *
 * `excludePatterns` outranks the opt-ins: this tree is pinned to a durable ref
 * reachable from no branch, so a credential-shaped file an author swept in by
 * opting in its whole directory must not reach it.
 */
export async function captureReviewWorktreeTreeSha(
  repo: Repo,
  requestedOptIns: readonly string[] = [],
  opts: { excludePatterns?: readonly string[] } = {}
): Promise<
  | ({ ok: true } & ReviewWorktreeTreeResult)
  | { ok: false; error_reason: SnapshotFailureReason; error_message?: string }
> {
  try {
    const repoTopLevel = await resolveRepoTopLevel(repo.cwd);
    const normalizedOptIns: string[] = [];
    for (const raw of requestedOptIns) {
      const normalized = normalizeReviewOptIn(raw);
      if (normalized === null) {
        return {
          ok: false,
          error_reason: 'unknown',
          error_message: `invalid review.include_untracked path: ${JSON.stringify(raw)}`,
        };
      }
      normalizedOptIns.push(normalized);
    }
    const uniqueOptIns = [...new Set(normalizedOptIns)].sort();

    const untrackedResult = await runGit(repoTopLevel, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    if (untrackedResult.code !== 0) {
      return {
        ok: false,
        error_reason: classifySnapshotFailure(untrackedResult.stderr),
        error_message: untrackedResult.stderr.trim(),
      };
    }
    const untracked = untrackedResult.stdout
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry.length > 0)
      .sort();
    const requestedByFile = (file: string): boolean =>
      uniqueOptIns.some((candidate) => file === candidate || file.startsWith(`${candidate}/`));
    const requested = untracked.filter(requestedByFile);
    // Held out BEFORE the opt-in `git add`, so the blob is never written at
    // all. The index scrub inside captureWorktreeTree is the backstop, not the
    // mechanism — it removes the entry after the object already exists.
    const sensitiveOptIns = selectExcludedPaths(requested, opts.excludePatterns ?? []);
    const sensitiveSet = new Set(sensitiveOptIns);
    const includedUntracked = requested.filter((file) => !sensitiveSet.has(file));
    const excludedUntracked = untracked.filter((file) => !requestedByFile(file));

    const unmatchedCandidates = uniqueOptIns.filter(
      (candidate) =>
        !untracked.some((file) => file === candidate || file.startsWith(`${candidate}/`))
    );
    let ignoredOptIns: string[] = [];
    if (unmatchedCandidates.length > 0) {
      const ignored = await runGit(repoTopLevel, ['check-ignore', '--no-index', '-z', '--stdin'], {
        stdin: `${unmatchedCandidates.join('\0')}\0`,
      });
      // check-ignore exits 1 when none match; both 0 and 1 are normal.
      if (ignored.code !== 0 && ignored.code !== 1) {
        return {
          ok: false,
          error_reason: classifySnapshotFailure(ignored.stderr),
          error_message: ignored.stderr.trim(),
        };
      }
      ignoredOptIns = ignored.stdout
        .toString('utf8')
        .split('\0')
        .filter((entry) => entry.length > 0)
        .sort();
    }
    const ignoredSet = new Set(ignoredOptIns);
    const unmatchedOptIns = unmatchedCandidates.filter((candidate) => !ignoredSet.has(candidate));
    const untrackedDetails: ReviewUntrackedEvidenceDetail[] = [];
    for (const filePath of untracked) {
      // Sequential by design: a repo with thousands of untracked files must not
      // turn a disclosure pass into an EMFILE burst.
      untrackedDetails.push(await inspectUntrackedFile(repoTopLevel, filePath));
    }

    const result = await captureWorktreeTree(repo, 'live-review', {
      skipCommit: true,
      trackedOnly: true,
      includeUntracked: includedUntracked,
      ...(opts.excludePatterns ? { excludePatterns: opts.excludePatterns } : {}),
    });
    if (!result.ok) return result;

    // The withheld claim is a POST-CONDITION of the tree, never an inference
    // about it. This classification resolves `sensitiveOptIns` against the live
    // index, while the tree builder resolves its own exclude set against a temp
    // index seeded from HEAD — so a path staged for removal but not yet
    // committed (`git rm --cached`) reads untracked here and tracked there, and
    // lands in the tree with its worktree bytes after being classified
    // sensitive. Reading presence back off the tree is what keeps the two sides
    // from diverging again: whatever the classifications disagree about, the
    // tree is the thing the reviewer actually gets.
    let withheldOptIns = sensitiveOptIns;
    let retainedOptIns: string[] = [];
    if (sensitiveOptIns.length > 0) {
      const inTree = await selectPathsPresentInTree(repoTopLevel, result.tree_sha, sensitiveOptIns);
      // Fail closed, like the classification probes above: an unverifiable
      // claim about a credential-bearing path is not one to publish.
      if (!inTree.ok) return inTree;
      withheldOptIns = sensitiveOptIns.filter((file) => !inTree.present.has(file));
      retainedOptIns = sensitiveOptIns.filter((file) => inTree.present.has(file));
    }

    return {
      ok: true,
      tree_sha: result.tree_sha,
      unmerged_paths: [...result.unmerged_paths],
      ...(result.unmerged_probe_failed === true ? { unmerged_probe_failed: true } : {}),
      included_untracked: includedUntracked,
      excluded_untracked: excludedUntracked,
      ignored_opt_ins: ignoredOptIns,
      unmatched_opt_ins: unmatchedOptIns,
      sensitive_opt_ins: withheldOptIns,
      retained_sensitive_opt_ins: retainedOptIns,
      untracked_details: untrackedDetails,
    };
  } catch (err) {
    return {
      ok: false,
      error_reason: 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pin `commit_sha` to `refName` via `git update-ref` (step 15). Idempotent
 * — re-pinning the same commit returns 0. Lock contention →
 * 'index_locked'. A runGit rejection (spawn-channel failure) → 'unknown'.
 */
async function pinRef(
  repoTopLevel: string,
  refName: string,
  commit_sha: string
): Promise<
  { ok: true } | { ok: false; error_reason: SnapshotFailureReason; error_message?: string }
> {
  try {
    const updateRef = await runGit(repoTopLevel, ['update-ref', refName, commit_sha]);
    if (updateRef.code !== 0) {
      return {
        ok: false,
        error_reason: classifySnapshotFailure(updateRef.stderr),
        error_message: updateRef.stderr.trim(),
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error_reason: 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Atomic capture-and-pin of the worktree at a checkpoint lifecycle
 * boundary. Thin wrapper over `captureWorktreeTree` (the shared temp-index
 * core) + `pinRef`: validate the snapshot ref name (step 1), capture the
 * tree (steps 2-14), pin the commit ref (step 15).
 *
 * Fail-open: any failure returns `{ ok: false, phase,
 * error_reason }`; the lifecycle never throws.
 */
export async function captureCheckpointSnapshot(opts: {
  repo: Repo;
  artifactId: string;
  checkpointN: number;
  phase: SnapshotPhase;
  /** Globs whose matching untracked files must not enter the tree. */
  excludePatterns?: readonly string[];
}): Promise<SnapshotResult> {
  const { repo, artifactId, checkpointN, phase } = opts;

  // Step 1: build + validate ref name.
  let refName: string;
  try {
    refName = snapshotRefName(artifactId, checkpointN, phase);
  } catch (err) {
    return {
      ok: false,
      phase,
      error_reason: 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
    };
  }

  // Steps 2-14: capture the worktree tree + commit object.
  const tree = await captureWorktreeTree(repo, `${artifactId}/${checkpointN}/${phase}`, {
    ...(opts.excludePatterns ? { excludePatterns: opts.excludePatterns } : {}),
  });
  if (!tree.ok) {
    return {
      ok: false,
      phase,
      error_reason: tree.error_reason,
      error_message: tree.error_message,
    };
  }

  // Step 15: pin via update-ref.
  const pin = await pinRef(tree.repoTopLevel, refName, tree.commit_sha);
  if (!pin.ok) {
    return {
      ok: false,
      phase,
      error_reason: pin.error_reason,
      error_message: pin.error_message,
    };
  }

  return {
    ok: true,
    phase,
    ref: refName,
    tree_sha: tree.tree_sha,
    commit_sha: tree.commit_sha,
    unmerged_paths: tree.unmerged_paths,
    ...(tree.unmerged_probe_failed === true ? { unmerged_probe_failed: true } : {}),
    ...(tree.exclusion_probe_failed === true ? { exclusion_probe_failed: true } : {}),
  };
}

/**
 * Result of `captureBaselineSnapshot`. Mirrors `SnapshotResult` minus the
 * `phase` discriminator — a baseline is per-artifact, not per-lifecycle-
 * boundary.
 */
export type BaselineSnapshotResult =
  | {
      ok: true;
      ref: string;
      tree_sha: string;
      commit_sha: string;
      /**
       * Present only on LIVE captures (`captureBaselineSnapshot`);
       * `pinBaselineTree` pins an existing tree and has no index state to
       * report, so the field stays absent there — absent means "not
       * probed", never "verified clean".
       */
      unmerged_paths?: readonly string[];
      unmerged_probe_failed?: boolean;
      /** See {@link SnapshotResult.exclusion_probe_failed}. */
      exclusion_probe_failed?: boolean;
    }
  | { ok: false; error_reason: SnapshotFailureReason; error_message?: string };

/**
 * Capture-and-pin the plan-time baseline for one artifact: the
 * worktree tree at `capture plan` time, pinned to
 * `refs/orcaops/baseline/<artifact>`. Empty-fence recovery diffs from this
 * tree for the FIRST checkpoint when there is no prior finalized cp.
 *
 * Pins a COMMIT ref (parity with the snapshot refs — so prune /
 * for-each-ref treat both namespaces identically). Fail-open: any failure
 * returns `{ ok: false, error_reason }`; never throws — a failed baseline
 * leaves the artifact's `baseline_seed_tree_sha` null.
 */
export async function captureBaselineSnapshot(
  repo: Repo,
  artifactId: string,
  opts: { excludePatterns?: readonly string[] } = {}
): Promise<BaselineSnapshotResult> {
  // Step 1: build + validate baseline ref name.
  let refName: string;
  try {
    refName = baselineRefName(artifactId);
  } catch (err) {
    return {
      ok: false,
      error_reason: 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
    };
  }

  // Steps 2-14: capture the worktree tree + commit object.
  // The excludes have to reach here too. This is the FIRST capture of every
  // task and it pins its tree to a durable ref, so a miss writes the excluded
  // files into an object reachable from no branch and disclosed nowhere — the
  // checkout disclosure is checkpoint-scoped and never sees a baseline.
  const tree = await captureWorktreeTree(repo, `baseline/${artifactId}`, {
    ...(opts.excludePatterns ? { excludePatterns: opts.excludePatterns } : {}),
  });
  if (!tree.ok) {
    return { ok: false, error_reason: tree.error_reason, error_message: tree.error_message };
  }

  // Step 15: pin the COMMIT ref.
  const pin = await pinRef(tree.repoTopLevel, refName, tree.commit_sha);
  if (!pin.ok) {
    return { ok: false, error_reason: pin.error_reason, error_message: pin.error_message };
  }

  return {
    ok: true,
    ref: refName,
    tree_sha: tree.tree_sha,
    commit_sha: tree.commit_sha,
    unmerged_paths: tree.unmerged_paths,
    ...(tree.unmerged_probe_failed === true ? { unmerged_probe_failed: true } : {}),
    ...(tree.exclusion_probe_failed === true ? { exclusion_probe_failed: true } : {}),
  };
}

/**
 * Repin the artifact's baseline ref (`refs/orcaops/baseline/<artifact>`) to an
 * ARBITRARY existing tree sha (supersession override). Unlike
 * `captureBaselineSnapshot` (which snapshots the live worktree), this pins a tree
 * the caller already resolved: `commit-tree` it with the snapshot identity (a
 * parentless commit wrapping the tree, keeping the tree object reachable via this
 * ref), then `update-ref`. Used to repin the seed to a SUPERSEDED artifact's
 * pre-work tree so it survives that artifact's (prunable) snap refs being removed.
 * Fail-open — never throws.
 */
export async function pinBaselineTree(
  repo: Repo,
  artifactId: string,
  treeSha: string
): Promise<BaselineSnapshotResult> {
  let refName: string;
  try {
    refName = baselineRefName(artifactId);
  } catch (err) {
    return {
      ok: false,
      error_reason: 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const repoTopLevel = await resolveRepoTopLevel(repo.cwd);
    const commitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'orcaops-snapshot',
      GIT_AUTHOR_EMAIL: 'orcaops@local',
      GIT_COMMITTER_NAME: 'orcaops-snapshot',
      GIT_COMMITTER_EMAIL: 'orcaops@local',
    };
    const commitTree = await runGit(
      repoTopLevel,
      ['commit-tree', treeSha, '-m', `orcaops baseline/${artifactId}`],
      { env: commitEnv }
    );
    if (commitTree.code !== 0) {
      return {
        ok: false,
        error_reason: classifySnapshotFailure(commitTree.stderr),
        error_message: commitTree.stderr.trim(),
      };
    }
    const commit_sha = commitTree.stdout.toString('utf8').trim();
    const pin = await pinRef(repoTopLevel, refName, commit_sha);
    if (!pin.ok) {
      return { ok: false, error_reason: pin.error_reason, error_message: pin.error_message };
    }
    return { ok: true, ref: refName, tree_sha: treeSha, commit_sha };
  } catch (err) {
    return {
      ok: false,
      error_reason: 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Snapshot materialization ───────────────────────────

export type SnapshotCheckoutResult =
  | { ok: true; dir: string }
  | {
      ok: false;
      error_reason: 'commit_unreachable' | 'target_not_empty' | 'worktree_add_failed' | 'unknown';
      error_message?: string;
    };

/**
 * Paths in a snapshot tree that an exclude set would keep out.
 *
 * Read-only `ls-tree` against the recorded tree, so a caller can disclose what
 * a checkout is about to write without touching it. Refs pinned before the
 * exclude set existed still carry whatever they captured — this is how that
 * becomes visible before someone runs an install in a materialized tree.
 *
 * Fail-open: a probe failure discloses nothing rather than blocking a
 * checkout, matching how the rest of this pipeline treats git trouble.
 */
export async function listSensitiveTreePaths(
  repo: Repo,
  treeSha: string,
  patterns: readonly string[]
): Promise<string[]> {
  if (patterns.length === 0) return [];
  try {
    const repoTopLevel = await resolveRepoTopLevel(repo.cwd);
    const listed = await runGit(repoTopLevel, ['ls-tree', '-r', '--name-only', '-z', treeSha]);
    if (listed.code !== 0) return [];
    return selectExcludedPaths(
      listed.stdout.toString('utf8').split('\0').filter(Boolean),
      patterns
    );
  } catch {
    return [];
  }
}

/**
 * Materialize a pinned snapshot COMMIT into a detached scratch worktree:
 * `git -c core.hooksPath=/dev/null worktree add --detach <dir> <commit>`.
 *
 * Why a worktree (and not `git archive | tar`): it shares the object
 * store, the scratch dir is a real repo (bisect test runs that shell out
 * to git work), the worktree's HEAD gc-protects the snapshot commit for
 * the checkout's lifetime, and a deleted dir self-heals via
 * `git worktree prune`. `core.hooksPath=/dev/null` suppresses repo
 * `post-checkout` hooks (husky/lefthook) — they must not run in scratch
 * dirs.
 *
 * NEVER touches the live worktree or index. The only mutation outside
 * `dir` is git's own worktree registration under the common dir.
 * Cleanup is the caller's story: `git worktree remove --force <dir>`
 * (or `rm -rf <dir>` + a later `git worktree prune`).
 *
 * Known materialization caveats (disclose to users, do not "fix" here):
 * a sparse-checkout main worktree still materializes the FULL tree;
 * submodule gitlinks come up as empty dirs; LFS pointers smudge only if
 * the local LFS objects exist.
 *
 * Result mapping (fail-open, never throws):
 *   - commit not present / not a commit → 'commit_unreachable' (the
 *     snapshot refs pinning it were likely pruned).
 *   - `dir` exists and is non-empty → 'target_not_empty'.
 *   - `git worktree add` non-zero → 'worktree_add_failed' with stderr.
 *   - anything thrown (spawn failure, fs error) → 'unknown'.
 */
export async function materializeSnapshotTree(
  repo: Repo,
  commitSha: string,
  dir: string
): Promise<SnapshotCheckoutResult> {
  try {
    const repoTopLevel = await resolveRepoTopLevel(repo.cwd);

    if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) {
      return {
        ok: false,
        error_reason: 'commit_unreachable',
        error_message: `not a commit sha: "${commitSha}"`,
      };
    }
    const catFile = await runGit(repoTopLevel, ['cat-file', '-e', `${commitSha}^{commit}`]);
    if (catFile.code !== 0) {
      return {
        ok: false,
        error_reason: 'commit_unreachable',
        error_message: catFile.stderr.trim(),
      };
    }

    // Refuse a non-empty target BEFORE git does, with a typed reason —
    // `worktree add` would also refuse, but its message is git-versioned.
    try {
      const entries = await readdir(dir);
      if (entries.length > 0) {
        return {
          ok: false,
          error_reason: 'target_not_empty',
          error_message: `target directory ${dir} exists and is not empty`,
        };
      }
    } catch {
      // ENOENT — worktree add creates it. Other fs errors surface below.
    }

    const add = await runGit(repoTopLevel, [
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '--detach',
      dir,
      commitSha,
    ]);
    if (add.code !== 0) {
      return {
        ok: false,
        error_reason: 'worktree_add_failed',
        error_message: add.stderr.trim(),
      };
    }

    return { ok: true, dir };
  } catch (err) {
    return {
      ok: false,
      error_reason: 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Byte-bounded `git diff` between two tree SHAs. Returns the raw diff
 * bytes (the snapshot diff parser consumes them).
 *
 * Result-mapping rules (order matters):
 *
 *   1. `killedByCap === true` → `{ ok: true, truncated: true, diff,
 *      byte_count: maxDiffBytes }`. We killed the child intentionally
 *      when stdout exceeded the cap; `code` will be null (or 143 on
 *      some platforms) and `signal` will be 'SIGTERM', but those
 *      reflect our cap action, NOT a git failure. **This branch
 *      precedes the exit-code check.**
 *   2. `code === 0 || code === 1` → success. Git exits 1 when the
 *      diff is non-empty (expected).
 *   3. `code === null && !killedByCap` → spawn error or external kill
 *      → `{ ok: false, reason: 'git_diff_failed' }`.
 *   4. `code >= 2` → real git failure → `{ ok: false, reason: 'git_diff_failed' }`.
 *   5. Thrown exception escapes runGit → `{ ok: false, reason: 'unknown' }`.
 *
 * The cap-truncation path is load-bearing for the storage flow:
 * a misclassification of cap-triggered SIGTERM as 'git_diff_failed'
 * would surface in the projection as `status: 'skipped'`, losing the
 * partial-capture data that the manifest builder is designed to
 * consume.
 */
export async function diffSnapshotTrees(opts: {
  repo: Repo;
  openTreeSha: string;
  closeTreeSha: string;
  maxDiffBytes: number;
  /**
   * Optional pathspec scope. When present, the diff is restricted to
   * these paths via a trailing `-- <pathspecs>` — used by empty-fence recovery
   * to scope a HWM→close diff to the cp's declared `files_changed` (scoping
   * collapses unrelated gap-churn to empty). Omitted ⇒ the normal full-tree
   * diff, byte-for-byte unchanged.
   *
   * Accepted degradation: a NEW-PATH-ONLY pathspec breaks `--find-renames`.
   * `git diff --find-renames A B -- new.txt` for an old→new rename filters out
   * the old-path deletion, so the pair can't be detected and the rename renders
   * as an add. Best-effort recovery accepts this; the unscoped fence path
   * detects renames correctly.
   */
  pathspecs?: string[];
}): Promise<DiffSnapshotResult> {
  const { repo, openTreeSha, closeTreeSha, maxDiffBytes, pathspecs } = opts;

  let result: RunGitResult;
  try {
    result = await runGit(
      repo.cwd,
      [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--unified=3',
        '--find-renames',
        openTreeSha,
        closeTreeSha,
        // Pathspec scope goes AFTER the two tree SHAs, behind a `--` separator
        // so paths are never misread as revisions. Empty/absent ⇒ no narrowing.
        ...(pathspecs && pathspecs.length > 0 ? ['--', ...pathspecs] : []),
      ],
      {
        maxStdoutBytes: maxDiffBytes,
        // `pathspecs` is untrusted agent input (files_changed). Force
        // LITERAL pathspecs so a glob-looking name (`*.ts`, `:(exclude)…`, a magic
        // prefix) can't widen or erase the scoped recovery diff. Only set when
        // pathspecs are present — the unscoped full diff is byte-for-byte unchanged.
        ...(pathspecs && pathspecs.length > 0
          ? { env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } }
          : {}),
      }
    );
  } catch {
    return { ok: false, reason: 'unknown' };
  }

  // Rule 1: cap-kill is success, not failure. Must precede exit-code rules.
  if (result.killedByCap) {
    return {
      ok: true,
      diff: result.stdout,
      truncated: true,
      byte_count: result.stdout.length,
    };
  }

  // Rule 2: git exits 0 (empty diff) or 1 (non-empty diff). Both success.
  if (result.code === 0 || result.code === 1) {
    return {
      ok: true,
      diff: result.stdout,
      truncated: false,
      byte_count: result.stdout.length,
    };
  }

  // Rules 3-4: any other exit / null code with no cap-kill is a failure.
  return { ok: false, reason: 'git_diff_failed' };
}

/** One `git diff --numstat` row; `added`/`deleted` are null for binary files. */
export interface DiffStatEntry {
  path: string;
  added: number | null;
  deleted: number | null;
}

export type DiffSnapshotStatsResult = { ok: true; entries: DiffStatEntry[] } | { ok: false };

/**
 * Per-file change stats between two snapshot trees via `git diff --numstat`.
 * Companion to `diffSnapshotTrees` for its truncated path: when the patch
 * blows past the byte cap the true size is unknowable (the child is killed
 * at the cap), but numstat is one line per changed file — tiny — so it can
 * name WHAT made the diff huge. `--no-renames` keeps one row per path.
 */
export async function diffSnapshotStats(opts: {
  repo: Repo;
  openTreeSha: string;
  closeTreeSha: string;
}): Promise<DiffSnapshotStatsResult> {
  const { repo, openTreeSha, closeTreeSha } = opts;
  let result: RunGitResult;
  try {
    result = await runGit(
      repo.cwd,
      [
        'diff',
        '--numstat',
        '--no-renames',
        '--no-color',
        '--no-ext-diff',
        openTreeSha,
        closeTreeSha,
      ],
      // One row per changed file makes 10MB absurdly generous headroom; the
      // cap only guards against a pathological object streaming unbounded.
      { maxStdoutBytes: 10 * 1024 * 1024 }
    );
  } catch {
    return { ok: false };
  }
  if (result.killedByCap || (result.code !== 0 && result.code !== 1)) return { ok: false };

  const entries: DiffStatEntry[] = [];
  for (const line of result.stdout.toString('utf8').split('\n')) {
    if (line.length === 0) continue;
    // `<added>\t<deleted>\t<path>` — binary rows are `-\t-\t<path>`.
    const [added, deleted, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    if (added === undefined || deleted === undefined || filePath.length === 0) continue;
    entries.push({
      path: filePath,
      added: added === '-' ? null : Number.parseInt(added, 10),
      deleted: deleted === '-' ? null : Number.parseInt(deleted, 10),
    });
  }
  return { ok: true, entries };
}

/**
 * Enumerate every `refs/orcaops/snap/*` ref in the local repo, with
 * its parsed components. Malformed refs (anything that doesn't match
 * `refs/orcaops/snap/<artifact>/<n>/<phase>`) are silently skipped —
 * doctor's `stale-snapshot-refs` check is the right place to
 * surface malformed names; a read API shouldn't crash the listing on
 * a single bad entry.
 *
 * Results are sorted by (artifact_id, n, phase) for deterministic
 * ordering across calls.
 */
export async function listSnapshotRefs(
  repo: Repo,
  filter?: { artifactId?: string }
): Promise<SnapshotRefEntry[]> {
  // `--format=%(refname)%00%(objectname)` uses NUL as a field separator
  // so we don't have to worry about whitespace in the values (object
  // names are hex SHAs and ref names match a tight regex, but NUL is
  // the safest framing).
  const r = await runGit(repo.cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)',
    `${SNAPSHOT_REF_PREFIX}/`,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `listSnapshotRefs: git for-each-ref failed (exit ${r.code}): ${r.stderr.trim()}`
    );
  }

  const out: SnapshotRefEntry[] = [];
  for (const line of r.stdout.toString('utf8').split('\n')) {
    if (line.length === 0) continue;
    const nulIdx = line.indexOf('\x00');
    if (nulIdx < 0) continue; // malformed — skip defensively
    const ref = line.slice(0, nulIdx);
    const commitSha = line.slice(nulIdx + 1).trim();
    const parsed = parseSnapshotRefName(ref);
    if (parsed === null) continue;
    if (filter?.artifactId !== undefined && parsed.artifact_id !== filter.artifactId) {
      continue;
    }
    out.push({
      artifact_id: parsed.artifact_id,
      n: parsed.n,
      phase: parsed.phase,
      ref,
      commit_sha: commitSha,
    });
  }

  // Deterministic order: by (artifact_id, n, phase).
  const phaseOrder: Record<SnapshotPhase, number> = { open: 0, close: 1, abandon: 2 };
  out.sort((a, b) => {
    if (a.artifact_id !== b.artifact_id) return a.artifact_id < b.artifact_id ? -1 : 1;
    if (a.n !== b.n) return a.n - b.n;
    return phaseOrder[a.phase] - phaseOrder[b.phase];
  });

  return out;
}

/**
 * Delete the listed snapshot refs.
 *
 * Validation policy (typed throw on failure, BEFORE any deletion):
 *
 *   1. Every ref MUST begin with `refs/orcaops/snap/`. A ref outside
 *      that namespace would be a caller bug capable of wiping
 *      `refs/heads/main`; refuse loudly rather than silently.
 *   2. Every ref MUST pass `git check-ref-format` for the long-tail
 *      rules (no `..`, no leading dot, no trailing `.lock`, no shell
 *      metacharacters, etc.). This catches refs that LOOK like ours
 *      but aren't well-formed.
 *
 * Deletion strategy:
 *
 *   - Empty `refs[]` → no-op, return `{ deleted: 0, refs: [] }`.
 *   - Filter to refs that ACTUALLY exist (so a list containing a
 *     no-longer-existing ref doesn't fail the whole batch).
 *   - 1 ref → direct `git update-ref -d <ref>`.
 *   - >1 refs → `git update-ref --stdin` with `delete <ref>\n` lines.
 *     The default stdin mode is not transactional: commands apply
 *     independently. That matches prune's best-effort contract, and the
 *     result reports only refs that were actually removed.
 *
 * Returns the refs that were actually removed (`refs` field), which
 * may be a strict subset of the input on partial failure.
 */
async function pruneRefsInNamespace(
  repo: Repo,
  refs: string[],
  prefix: string
): Promise<{ deleted: number; refs: string[] }> {
  // Validation: namespace + check-ref-format. Throw before any
  // deletion so a caller bug never produces partial damage.
  for (const ref of refs) {
    if (!ref.startsWith(`${prefix}/`)) {
      throw new Error(`pruneRefsInNamespace: refusing to delete ref outside ${prefix}/: "${ref}"`);
    }
    const validate = await runGit(repo.cwd, ['check-ref-format', ref]);
    if (validate.code !== 0) {
      throw new Error(
        `pruneRefsInNamespace: invalid ref name "${ref}" (git check-ref-format exited ${validate.code}): ${validate.stderr.trim()}`
      );
    }
  }

  if (refs.length === 0) {
    return { deleted: 0, refs: [] };
  }

  // Filter to refs that actually exist. Trying to delete a
  // no-longer-existing ref would fail update-ref; pre-filtering keeps
  // the batch resilient against stale input.
  const existing = await runGit(repo.cwd, ['for-each-ref', '--format=%(refname)', `${prefix}/`]);
  if (existing.code !== 0) {
    throw new Error(
      `pruneRefsInNamespace: git for-each-ref failed (exit ${existing.code}): ${existing.stderr.trim()}`
    );
  }
  const live = new Set<string>(
    existing.stdout
      .toString('utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
  const toDelete = refs.filter((r) => live.has(r));
  if (toDelete.length === 0) {
    return { deleted: 0, refs: [] };
  }

  if (toDelete.length === 1) {
    const r = await runGit(repo.cwd, ['update-ref', '-d', toDelete[0]]);
    if (r.code !== 0) {
      throw new Error(
        `pruneRefsInNamespace: git update-ref -d failed for "${toDelete[0]}" (exit ${r.code}): ${r.stderr.trim()}`
      );
    }
  } else {
    // NOTE: NOT a transaction. The default --stdin mode applies each
    // command independently and may produce partial deletion on
    // failure. Future atomic variant: wrap with `start`/`commit`.
    const stdin = toDelete.map((r) => `delete ${r}\n`).join('');
    const r = await runGit(repo.cwd, ['update-ref', '--stdin'], { stdin });
    if (r.code !== 0) {
      throw new Error(
        `pruneRefsInNamespace: git update-ref --stdin batch failed (exit ${r.code}): ${r.stderr.trim()}`
      );
    }
  }

  return { deleted: toDelete.length, refs: toDelete };
}

/**
 * Atomically delete an exact set of refs only while every ref still has the
 * object id observed by the caller. A missing or changed ref aborts the whole
 * transaction, so concurrent Git writers never lose their update and callers
 * never receive a partially-pruned candidate.
 */
async function pruneRefsInNamespaceIfUnchanged(
  repo: Repo,
  refs: RefIdentity[],
  prefix: string
): Promise<{ deleted: number; refs: string[] }> {
  const names = new Set<string>();
  for (const entry of refs) {
    if (!entry.ref.startsWith(`${prefix}/`)) {
      throw new Error(
        `pruneRefsInNamespaceIfUnchanged: refusing to delete ref outside ${prefix}/: "${entry.ref}"`
      );
    }
    if (names.has(entry.ref)) {
      throw new Error(`pruneRefsInNamespaceIfUnchanged: duplicate ref "${entry.ref}"`);
    }
    names.add(entry.ref);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(entry.object_id)) {
      throw new Error(`pruneRefsInNamespaceIfUnchanged: invalid object id for "${entry.ref}"`);
    }
    const validate = await runGit(repo.cwd, ['check-ref-format', entry.ref]);
    if (validate.code !== 0) {
      throw new Error(
        `pruneRefsInNamespaceIfUnchanged: invalid ref name "${entry.ref}" ` +
          `(git check-ref-format exited ${validate.code}): ${validate.stderr.trim()}`
      );
    }
  }
  if (refs.length === 0) return { deleted: 0, refs: [] };

  const stdin = [
    'start',
    ...refs.map((entry) => `delete ${entry.ref} ${entry.object_id}`),
    'prepare',
    'commit',
    '',
  ].join('\n');
  const result = await runGit(repo.cwd, ['update-ref', '--stdin'], { stdin });
  if (result.code !== 0) {
    throw new Error(
      `pruneRefsInNamespaceIfUnchanged: Git compare-and-delete failed ` +
        `(exit ${result.code}): ${result.stderr.trim()}`
    );
  }
  return { deleted: refs.length, refs: refs.map((entry) => entry.ref) };
}

export async function pruneSnapshotRefs(
  repo: Repo,
  refs: string[]
): Promise<{ deleted: number; refs: string[] }> {
  return pruneRefsInNamespace(repo, refs, SNAPSHOT_REF_PREFIX);
}

/**
 * Delete the listed baseline refs. Same validation + best-effort
 * deletion strategy as `pruneSnapshotRefs`, scoped to the
 * `refs/orcaops/baseline/*` namespace. Used by gc-on-delete and the
 * sync-layer auto-prune (a finalized-and-accounted artifact no longer
 * needs its plan-time baseline).
 */
export async function pruneBaselineRefs(
  repo: Repo,
  refs: string[]
): Promise<{ deleted: number; refs: string[] }> {
  return pruneRefsInNamespace(repo, refs, BASELINE_REF_PREFIX);
}

/**
 * Delete the listed review pin refs (`refs/orcaops/review/<slug>[-base]`). Same
 * validation + best-effort deletion strategy as `pruneSnapshotRefs`, scoped to
 * the `refs/orcaops/review/*` namespace. Used by gc-on-prune of a stale review
 * dir: the pins keep only that dir's floor trees readable, so they die with it.
 */
export async function pruneReviewRefs(
  repo: Repo,
  refs: string[]
): Promise<{ deleted: number; refs: string[] }> {
  return pruneRefsInNamespace(repo, refs, REVIEW_REF_PREFIX);
}

export async function pruneSnapshotRefsIfUnchanged(
  repo: Repo,
  refs: RefIdentity[]
): Promise<{ deleted: number; refs: string[] }> {
  return pruneRefsInNamespaceIfUnchanged(repo, refs, SNAPSHOT_REF_PREFIX);
}

export async function pruneBaselineRefsIfUnchanged(
  repo: Repo,
  refs: RefIdentity[]
): Promise<{ deleted: number; refs: string[] }> {
  return pruneRefsInNamespaceIfUnchanged(repo, refs, BASELINE_REF_PREFIX);
}

export async function pruneReviewRefsIfUnchanged(
  repo: Repo,
  refs: RefIdentity[]
): Promise<{ deleted: number; refs: string[] }> {
  return pruneRefsInNamespaceIfUnchanged(repo, refs, REVIEW_REF_PREFIX);
}

async function listRawRefIdentities(repo: Repo, prefix: string): Promise<RefIdentity[]> {
  const result = await runGit(repo.cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)',
    `${prefix}/`,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `listRawRefIdentities: git for-each-ref failed (exit ${result.code}): ${result.stderr.trim()}`
    );
  }
  const entries = result.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line): RefIdentity => {
      const separator = line.indexOf('\0');
      if (separator <= 0 || separator === line.length - 1) {
        throw new Error('listRawRefIdentities: Git returned a malformed ref identity');
      }
      return { ref: line.slice(0, separator), object_id: line.slice(separator + 1) };
    });
  entries.sort((left, right) => left.ref.localeCompare(right.ref));
  return entries;
}

export async function listRawSnapshotRefIdentities(
  repo: Repo,
  filter?: { artifactId?: string }
): Promise<RefIdentity[]> {
  const entries = await listRawRefIdentities(repo, SNAPSHOT_REF_PREFIX);
  return filter?.artifactId === undefined
    ? entries
    : entries.filter((entry) =>
        entry.ref.startsWith(`${SNAPSHOT_REF_PREFIX}/${filter.artifactId}/`)
      );
}

export async function listRawBaselineRefIdentities(
  repo: Repo,
  filter?: { artifactId?: string }
): Promise<RefIdentity[]> {
  const entries = await listRawRefIdentities(repo, BASELINE_REF_PREFIX);
  return filter?.artifactId === undefined
    ? entries
    : entries.filter((entry) => entry.ref === `${BASELINE_REF_PREFIX}/${filter.artifactId}`);
}

export async function listRawReviewRefIdentities(
  repo: Repo,
  filter?: { slug?: string }
): Promise<RefIdentity[]> {
  const entries = await listRawRefIdentities(repo, REVIEW_REF_PREFIX);
  return filter?.slug === undefined
    ? entries
    : entries.filter(
        (entry) =>
          entry.ref === `${REVIEW_REF_PREFIX}/${filter.slug}` ||
          entry.ref === `${REVIEW_REF_PREFIX}/${filter.slug}-base`
      );
}

/**
 * Enumerate every `refs/orcaops/snap/*` ref name as a RAW string, with
 * NO parsing and NO malformed-entry dropping.
 *
 * This is the single shared raw-namespace source for:
 *
 *   - doctor's `stale-snapshot-refs` computes malformed = raw − parsed
 *     (`listSnapshotRefs` silently drops malformed entries, so it can't
 *     surface them on its own);
 *   - `orcaops snapshots prune --orphans|--all` operates over the raw
 *     set so a malformed-but-valid-git ref (which has no owning
 *     artifact by definition) is still a prune candidate — otherwise
 *     doctor's `prune --orphans` remediation would be a dead end;
 *   - `gc --apply` and `snapshots prune --artifact <id>` total-wipe via
 *     the `{ artifactId }` filter so a malformed-after-id ref
 *     (`refs/orcaops/snap/<id>/garbage`) doesn't outlive its artifact.
 *
 * With `{ artifactId }`, the filter is a raw string prefix match on
 * `refs/orcaops/snap/<artifactId>/` — it deliberately does NOT require
 * the `<n>/<phase>` tail to parse, so malformed refs under a known
 * artifact are still caught. `pruneSnapshotRefs` accepts any ref that
 * is namespace-prefixed and passes `git check-ref-format` (it does not
 * require parseable structure), so these delete cleanly.
 *
 * Sorted lexicographically for deterministic output.
 */
export async function listRawSnapshotRefNames(
  repo: Repo,
  filter?: { artifactId?: string }
): Promise<string[]> {
  const r = await runGit(repo.cwd, [
    'for-each-ref',
    '--format=%(refname)',
    `${SNAPSHOT_REF_PREFIX}/`,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `listRawSnapshotRefNames: git for-each-ref failed (exit ${r.code}): ${r.stderr.trim()}`
    );
  }
  const all = r.stdout
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out =
    filter?.artifactId !== undefined
      ? all.filter((ref) => ref.startsWith(`${SNAPSHOT_REF_PREFIX}/${filter.artifactId}/`))
      : all;
  out.sort();
  return out;
}

/**
 * Enumerate every `refs/orcaops/baseline/*` ref name as a RAW string (the
 * baseline analogue of `listRawSnapshotRefNames`). Used by gc-on-delete,
 * the sync-layer auto-prune, and doctor's `stale-baseline-refs` check.
 *
 * Unlike the snapshot namespace, the baseline ref has NO `<n>/<phase>`
 * tail — there is exactly one ref per artifact. So with `{ artifactId }`,
 * the filter is an EXACT match on `refs/orcaops/baseline/<artifactId>`
 * (NOT a `…/` prefix match) — a `refs/orcaops/baseline/<id>/garbage`
 * malformed entry is NOT this artifact's baseline and is left to the
 * unfiltered orphan path (`parseBaselineRefName` rejects it → doctor
 * flags it as malformed). Sorted lexicographically for determinism.
 */
export async function listRawBaselineRefNames(
  repo: Repo,
  filter?: { artifactId?: string }
): Promise<string[]> {
  const r = await runGit(repo.cwd, [
    'for-each-ref',
    '--format=%(refname)',
    `${BASELINE_REF_PREFIX}/`,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `listRawBaselineRefNames: git for-each-ref failed (exit ${r.code}): ${r.stderr.trim()}`
    );
  }
  const all = r.stdout
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out =
    filter?.artifactId !== undefined
      ? all.filter((ref) => ref === `${BASELINE_REF_PREFIX}/${filter.artifactId}`)
      : all;
  out.sort();
  return out;
}

/**
 * Enumerate every `refs/orcaops/review/*` ref name as a RAW string (the
 * review-pin analogue of `listRawBaselineRefNames`). Used by gc-on-prune of a
 * stale review dir to find the dir's pins.
 *
 * With `{ slug }`, the filter is an EXACT match on the slug's two refs —
 * `refs/orcaops/review/<slug>` and `refs/orcaops/review/<slug>-base` — mirroring
 * `pinReviewRefs`'s two-ref-per-slug scheme. The `-base` suffix means a slug
 * whose name is another slug + "-base" shares a ref name; that ambiguity is
 * inherent to the pin scheme and out of scope here. Sorted lexicographically.
 */
export async function listRawReviewRefNames(
  repo: Repo,
  filter?: { slug?: string }
): Promise<string[]> {
  const r = await runGit(repo.cwd, [
    'for-each-ref',
    '--format=%(refname)',
    `${REVIEW_REF_PREFIX}/`,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `listRawReviewRefNames: git for-each-ref failed (exit ${r.code}): ${r.stderr.trim()}`
    );
  }
  const all = r.stdout
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out =
    filter?.slug !== undefined
      ? all.filter(
          (ref) =>
            ref === `${REVIEW_REF_PREFIX}/${filter.slug}` ||
            ref === `${REVIEW_REF_PREFIX}/${filter.slug}-base`
        )
      : all;
  out.sort();
  return out;
}

/**
 * The SELECTIVE auto-prune set for one artifact: only the refs that are
 * safe to delete because the fingerprint-bearing state they anchor has
 * already been committed (and, at the call site in `cloud/sync.ts`,
 * synced). This is deliberately NOT a total wipe — manual
 * `snapshots prune --artifact` and gc-on-delete are the total-wipe
 * paths; auto-prune must preserve re-derivability for anything whose
 * manifest didn't land.
 *
 * For each ref of `artifactId` (parsed via `listSnapshotRefs`, so malformed
 * refs are out of scope here — those are doctor / `prune --orphans`
 * territory):
 *
 *   - CLOSED cp whose `diff_fingerprint_summary.manifest_hash !== null`
 *     (⇔ status captured/empty/truncated — the manifest landed): prune
 *     its `open` AND `close` refs. The `manifest_hash !== null` gate is
 *     the exact predicate `readSnapshot` uses in `cloud/sync.ts`, so a
 *     corrupt `status:captured`-but-`manifest_hash:null` row is treated
 *     as "did NOT land" and its refs are kept (recovery material).
 *   - CLOSED cp with `status: 'skipped'` (`manifest_hash === null`):
 *     keep ALL its refs — the manifest may be re-derivable later.
 *   - ABANDONED cp: keep BOTH refs. The abandon ref alone is a tree
 *     without a baseline — salvage diffs open→abandon, and v1 cloud
 *     doesn't model abandoned cps (no "landed" signal), so auto-prune
 *     deleting the open ref would leave salvage nothing to diff
 *     against. Total-wipe paths (manual
 *     `snapshots prune --artifact/--all`, gc-on-delete) still remove
 *     both.
 *   - OPEN (in-flight) cp: keep its `open` ref (manifest not yet
 *     computable).
 *   - A ref whose `n` is absent from `snapshot.checkpoints`: keep
 *     (defensive — never auto-delete an unmodeled ref; doctor's
 *     `stale-snapshot-refs` owns those).
 *
 * Typed structurally on `{ checkpoints }` rather than importing
 * `ArtifactSnapshot` from `cloud/hash.ts` — `git/` sits below `cloud/`
 * in the layering and must not depend upward.
 *
 * Returned refs are sorted for deterministic pruning.
 */
export async function collectPrunableRefsForArtifact(
  repo: Repo,
  artifactId: string,
  snapshot: { checkpoints: Checkpoint[] }
): Promise<string[]> {
  const entries = await listSnapshotRefs(repo, { artifactId });
  if (entries.length === 0) return [];

  const cpByN = new Map<number, Checkpoint>();
  for (const cp of snapshot.checkpoints) {
    cpByN.set(cp.n, cp);
  }

  const prunable: string[] = [];
  for (const entry of entries) {
    const cp = cpByN.get(entry.n);
    // Unmodeled ref (no checkpoint for this `n` — e.g. a
    // pin-before-append crash orphan): AUTO-prune stays conservative
    // and never deletes it (a transiently-unreadable projection must
    // not cause data loss). Surfacing + cleaning these is the job of
    // doctor's `stale-snapshot-refs` (unmodeled class) and the
    // user-invoked `snapshots prune --orphans` — NOT this selector.
    if (cp === undefined) continue;

    if (cp.status === 'closed') {
      // Parity with `cloud/sync.ts` readSnapshot: manifest landed iff
      // manifest_hash is non-null. A corrupt captured-but-null row is
      // (correctly) treated as not-landed and its refs are kept.
      const manifestLanded = cp.diff_fingerprint_summary.manifest_hash !== null;
      if (manifestLanded && (entry.phase === 'open' || entry.phase === 'close')) {
        prunable.push(entry.ref);
      }
      // skipped closed cp → keep all refs (re-derivability)
    }
    // abandoned cp → keep BOTH refs (salvage diffs
    // open→abandon; deleting the open ref strands the abandon tree)
    // open (in-flight) cp → keep its open ref
  }

  prunable.sort();
  return prunable;
}

/**
 * The auto-prune decision for one artifact's plan-time BASELINE ref.
 * Same SHAPE as `collectPrunableRefsForArtifact` (return [] to
 * KEEP, or the ref to PRUNE) but a DIFFERENT predicate — the baseline
 * anchors empty-fence recovery for the FIRST checkpoint, so it stays live
 * until that first checkpoint is finalized AND its landed fingerprint is
 * accounted-for (or it abandoned).
 *
 * Logic, keyed on the FIRST FINALIZED checkpoint (lowest-`n` cp whose
 * status is not 'open'):
 *
 *   - NO finalized cp yet (all open, or none) → KEEP. Empty-fence
 *     recovery for the first checkpoint may still need the seed.
 *   - First finalized cp is CLOSED, claimed work (`files_changed` non-
 *     empty), but its fingerprint did NOT land (`diff_fingerprint_summary
 *     .status` is 'empty' or 'skipped') → KEEP. The fingerprint is still
 *     re-derivable from the baseline.
 *   - Otherwise → PRUNE. Covers: first finalized cp ABANDONED (an
 *     `AbandonedCheckpoint` has NO `diff_fingerprint_summary`, so the
 *     `status === 'closed'` short-circuit guards that field access); OR
 *     closed-and-accounted (`status` captured/truncated — a real
 *     fingerprint landed); OR a closed cp that claimed NOTHING
 *     (`files_changed.length === 0`).
 *
 * The predicate keys on `diff_fingerprint_summary.status`, NOT
 * `manifest_hash` — a fallback empty manifest can carry a non-null hash,
 * so `manifest_hash !== null` would wrongly read as "landed" for an
 * empty/skipped close. TypeScript narrows the `Checkpoint` union after
 * `cp.status === 'closed' &&`, so `cp.files_changed` /
 * `cp.diff_fingerprint_summary` are accessible inside that branch.
 *
 * Typed structurally on `{ checkpoints }` (like
 * `collectPrunableRefsForArtifact`) so `git/` does not depend upward on
 * `cloud/`.
 */
export async function collectBaselineRefsForArtifact(
  repo: Repo,
  artifactId: string,
  snapshot: { checkpoints: Checkpoint[] }
): Promise<string[]> {
  const raw = await listRawBaselineRefNames(repo, { artifactId });
  if (raw.length === 0) return [];

  // First finalized checkpoint = lowest-`n` cp that is not 'open'.
  const firstFinalized = snapshot.checkpoints
    .filter((cp) => cp.status !== 'open')
    .sort((a, b) => a.n - b.n)[0];

  // No finalized cp yet → KEEP (baseline may still be needed for the
  // first checkpoint's empty-fence recovery).
  if (firstFinalized === undefined) return [];

  // Closed-but-unaccounted (claimed work, no landed fingerprint) → KEEP.
  // The `status === 'closed'` short-circuit guards the
  // `diff_fingerprint_summary` access on the abandoned variant.
  if (
    firstFinalized.status === 'closed' &&
    firstFinalized.files_changed.length > 0 &&
    (firstFinalized.diff_fingerprint_summary.status === 'empty' ||
      firstFinalized.diff_fingerprint_summary.status === 'skipped')
  ) {
    return [];
  }

  // Otherwise → PRUNE.
  return [baselineRefName(artifactId)];
}
