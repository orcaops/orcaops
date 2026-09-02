import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Checkpoint } from '@orcaops/storage';
import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { Repo } from './repo.js';
import {
  allocateTempIndex,
  BASELINE_REF_PREFIX,
  baselineRefName,
  captureBaselineSnapshot,
  captureCheckpointSnapshot,
  captureReviewWorktreeTreeSha,
  captureWorktreeTree,
  captureWorktreeTreeSha,
  classifySnapshotFailure,
  collectBaselineRefsForArtifact,
  collectPrunableRefsForArtifact,
  diffSnapshotStats,
  diffSnapshotTrees,
  listRawSnapshotRefIdentities,
  listRawSnapshotRefNames,
  listSensitiveTreePaths,
  listSnapshotRefs,
  materializeSnapshotTree,
  parseBaselineRefName,
  parseSnapshotRefName,
  parseUnmergedPathsZ,
  pinBaselineTree,
  pruneBaselineRefs,
  pruneSnapshotRefs,
  pruneSnapshotRefsIfUnchanged,
  resolveRepoTopLevel,
  runGit,
  SNAPSHOT_NESTED_ORCAOPS_EXCLUDE_PATHSPECS,
  SNAPSHOT_ORCAOPS_EXCLUDE_DIRS,
  SNAPSHOT_REF_PREFIX,
  type SnapshotPhase,
  snapshotRefName,
} from './snapshots.js';

// ── classifySnapshotFailure ─────────────────────────────────────────

describe('classifySnapshotFailure', () => {
  it('maps ENOSPC errno to no_space', () => {
    expect(classifySnapshotFailure('', 'ENOSPC')).toBe('no_space');
  });

  it('maps "No space left on device" stderr to no_space', () => {
    expect(classifySnapshotFailure('error: write_loose_object: No space left on device')).toBe(
      'no_space'
    );
  });

  it('maps cannot-lock-ref stderr to index_locked', () => {
    expect(
      classifySnapshotFailure(
        "fatal: cannot lock ref 'refs/orcaops/snap/abc/1/open': Unable to create lock"
      )
    ).toBe('index_locked');
  });

  it('maps index.lock contention stderr to index_locked', () => {
    expect(
      classifySnapshotFailure("fatal: Unable to create '/repo/.git/index.lock': File exists.")
    ).toBe('index_locked');
  });

  it('maps "unable to create ... .lock" stderr to index_locked', () => {
    expect(
      classifySnapshotFailure(
        "fatal: Unable to create '/repo/.git/refs/orcaops/snap/x/1/open.lock': File exists."
      )
    ).toBe('index_locked');
  });

  it('maps "needs merge" stderr to merge_conflict', () => {
    expect(classifySnapshotFailure('error: src/foo.ts: needs merge')).toBe('merge_conflict');
  });

  it('maps "unmerged paths" stderr to merge_conflict', () => {
    expect(
      classifySnapshotFailure(
        'fatal: Updating an unborn branch with changes added to the index due to unmerged paths'
      )
    ).toBe('merge_conflict');
  });

  it('maps "error building trees" stderr to merge_conflict', () => {
    expect(classifySnapshotFailure('fatal: git-write-tree: error building trees')).toBe(
      'merge_conflict'
    );
  });

  it('returns unknown for unrecognized stderr', () => {
    expect(classifySnapshotFailure('mysterious failure with no known marker')).toBe('unknown');
  });

  it('returns unknown for empty stderr without errno', () => {
    expect(classifySnapshotFailure('')).toBe('unknown');
  });

  it('is case-insensitive on stderr text', () => {
    expect(classifySnapshotFailure('FATAL: CANNOT LOCK REF refs/orcaops/snap/x')).toBe(
      'index_locked'
    );
  });

  it('does not produce unborn_repo (short-circuited upstream)', () => {
    // Even if stderr happens to mention "ambiguous argument 'HEAD'" or
    // similar unborn-style messages, the classifier never returns
    // 'unborn_repo'. That state is handled by the caller's pre-flight
    // HEAD probe before any git invocation reaches the classifier.
    expect(classifySnapshotFailure("fatal: ambiguous argument 'HEAD': unknown revision")).toBe(
      'unknown'
    );
  });
});

// ── parseSnapshotRefName ────────────────────────────────────────────

describe('parseSnapshotRefName', () => {
  const ART = '019e293d-1111-7000-8000-000000000001';

  it('parses a well-formed open ref', () => {
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/1/open`)).toEqual({
      artifact_id: ART,
      n: 1,
      phase: 'open',
    });
  });

  it('parses close phase', () => {
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/2/close`)).toEqual({
      artifact_id: ART,
      n: 2,
      phase: 'close',
    });
  });

  it('parses abandon phase', () => {
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/7/abandon`)).toEqual({
      artifact_id: ART,
      n: 7,
      phase: 'abandon',
    });
  });

  it('rejects refs outside the snap namespace', () => {
    expect(parseSnapshotRefName('refs/heads/main')).toBeNull();
    expect(parseSnapshotRefName('refs/orcaops/other/x/1/open')).toBeNull();
  });

  it('rejects refs with the wrong number of segments after the prefix', () => {
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/open`)).toBeNull();
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/1`)).toBeNull();
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/1/open/extra`)).toBeNull();
  });

  it('rejects non-numeric n', () => {
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/abc/open`)).toBeNull();
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/-1/open`)).toBeNull();
  });

  it('rejects zero or negative n', () => {
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/0/open`)).toBeNull();
  });

  it('rejects unknown phase', () => {
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/1/bogus`)).toBeNull();
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/1/OPEN`)).toBeNull();
  });

  it('rejects empty artifact_id segment', () => {
    expect(parseSnapshotRefName(`${SNAPSHOT_REF_PREFIX}//1/open`)).toBeNull();
  });
});

// ── snapshotRefName ────────────────────────────────────────────────

describe('snapshotRefName', () => {
  it('builds a well-formed ref name', () => {
    expect(snapshotRefName('artifact-123', 1, 'open')).toBe(
      `${SNAPSHOT_REF_PREFIX}/artifact-123/1/open`
    );
  });

  it('round-trips through parseSnapshotRefName', () => {
    const ref = snapshotRefName('019e293d-1111-7000', 5, 'close');
    expect(parseSnapshotRefName(ref)).toEqual({
      artifact_id: '019e293d-1111-7000',
      n: 5,
      phase: 'close',
    });
  });

  it('throws on empty artifact_id', () => {
    expect(() => snapshotRefName('', 1, 'open')).toThrow(/invalid artifactId/);
  });

  it('throws on artifact_id with control chars', () => {
    expect(() => snapshotRefName('bad\x01id', 1, 'open')).toThrow(/invalid artifactId/);
  });

  it('throws on artifact_id with shell metacharacters', () => {
    expect(() => snapshotRefName('a*b', 1, 'open')).toThrow(/invalid artifactId/);
    expect(() => snapshotRefName('a:b', 1, 'open')).toThrow(/invalid artifactId/);
    expect(() => snapshotRefName('a~b', 1, 'open')).toThrow(/invalid artifactId/);
    expect(() => snapshotRefName('a b', 1, 'open')).toThrow(/invalid artifactId/);
  });

  it('throws on artifact_id containing ".."', () => {
    expect(() => snapshotRefName('a..b', 1, 'open')).toThrow(/invalid artifactId/);
  });

  it('throws on artifact_id ending in .lock', () => {
    expect(() => snapshotRefName('abc.lock', 1, 'open')).toThrow(/reserved/);
  });

  it('throws on artifact_id starting with .', () => {
    expect(() => snapshotRefName('.hidden', 1, 'open')).toThrow(/reserved/);
  });

  it('throws on non-positive n', () => {
    expect(() => snapshotRefName('abc', 0, 'open')).toThrow(/positive integer/);
    expect(() => snapshotRefName('abc', -1, 'open')).toThrow(/positive integer/);
  });

  it('throws on non-integer n', () => {
    expect(() => snapshotRefName('abc', 1.5, 'open')).toThrow(/positive integer/);
  });

  it('throws on invalid phase', () => {
    // Cast through unknown to bypass the type system — guards against
    // runtime callers that ignore TypeScript.
    expect(() => snapshotRefName('abc', 1, 'bogus' as unknown as SnapshotPhase)).toThrow(
      /invalid phase/
    );
  });
});

// ── baselineRefName / parseBaselineRefName ─────────────────

describe('baselineRefName', () => {
  it('builds a well-formed baseline ref name (NO n/phase tail)', () => {
    expect(baselineRefName('artifact-123')).toBe(`${BASELINE_REF_PREFIX}/artifact-123`);
  });

  it('round-trips through parseBaselineRefName', () => {
    const ref = baselineRefName('019e293d-1111-7000');
    expect(parseBaselineRefName(ref)).toEqual({ artifact_id: '019e293d-1111-7000' });
  });

  it('mirrors snapshotRefName artifactId validation (empty / control / metachar / .. / reserved)', () => {
    expect(() => baselineRefName('')).toThrow(/invalid artifactId/);
    expect(() => baselineRefName('bad\x01id')).toThrow(/invalid artifactId/);
    expect(() => baselineRefName('a*b')).toThrow(/invalid artifactId/);
    expect(() => baselineRefName('a b')).toThrow(/invalid artifactId/);
    expect(() => baselineRefName('a..b')).toThrow(/invalid artifactId/);
    expect(() => baselineRefName('abc.lock')).toThrow(/reserved/);
    expect(() => baselineRefName('.hidden')).toThrow(/reserved/);
  });
});

describe('parseBaselineRefName', () => {
  const ART = '019e293d-1111-7000-8000-000000000001';

  it('parses a well-formed baseline ref', () => {
    expect(parseBaselineRefName(`${BASELINE_REF_PREFIX}/${ART}`)).toEqual({ artifact_id: ART });
  });

  it('rejects refs outside the baseline namespace', () => {
    expect(parseBaselineRefName('refs/heads/main')).toBeNull();
    expect(parseBaselineRefName(`${SNAPSHOT_REF_PREFIX}/${ART}/1/open`)).toBeNull();
  });

  it('rejects the empty remainder (bare prefix)', () => {
    expect(parseBaselineRefName(`${BASELINE_REF_PREFIX}/`)).toBeNull();
  });

  it('rejects a malformed-after-id ref (the namespace has no tail)', () => {
    // `refs/orcaops/baseline/<id>/garbage` is NOT a baseline ref — any `/`
    // in the remainder is rejected (it has no owning artifact by definition).
    expect(parseBaselineRefName(`${BASELINE_REF_PREFIX}/${ART}/garbage`)).toBeNull();
    expect(parseBaselineRefName(`${BASELINE_REF_PREFIX}/${ART}/1/open`)).toBeNull();
  });
});

// ── allocateTempIndex ──────────────────────────────────────────────

describe('allocateTempIndex', () => {
  it('allocates OUTSIDE the worktree, so capture is never self-referential', async () => {
    const { directory, indexPath } = await allocateTempIndex();
    try {
      // The whole point: no repo path can contain it, so `git add -A` in ANY
      // repo cannot see the index, and no exclude pathspec is needed.
      expect(directory.startsWith(tmpdir())).toBe(true);
      expect(indexPath.startsWith(directory)).toBe(true);
      expect(indexPath.includes('.orcaops')).toBe(false);
      expect(path.basename(indexPath)).toMatch(/^snap-[0-9a-f-]+\.index$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates the directory eagerly with owner-only permissions', async () => {
    const { directory } = await allocateTempIndex();
    try {
      const st = await stat(directory);
      expect(st.isDirectory()).toBe(true);
      // mkdtemp semantics: 0o700. Guards against a predictable-path rewrite
      // reintroducing a world-readable index.
      expect(st.mode & 0o777).toBe(0o700);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('isolates concurrent captures in distinct directories', async () => {
    const allocs = await Promise.all(Array.from({ length: 8 }, () => allocateTempIndex()));
    try {
      expect(new Set(allocs.map((a) => a.directory)).size).toBe(allocs.length);
      expect(new Set(allocs.map((a) => a.indexPath)).size).toBe(allocs.length);
    } finally {
      await Promise.all(allocs.map((a) => rm(a.directory, { recursive: true, force: true })));
    }
  });
});

describe('SNAPSHOT_NESTED_ORCAOPS_EXCLUDE_PATHSPECS', () => {
  it('pins the root-safe fnmatch pair — each pattern requires a leading component, so the ROOT .orcaops can never match', () => {
    expect(SNAPSHOT_NESTED_ORCAOPS_EXCLUDE_PATHSPECS).toEqual(['*/.orcaops', '*/.orcaops/*']);
  });
});

describe('SNAPSHOT_ORCAOPS_EXCLUDE_DIRS', () => {
  it('pins the volatile-dir set (tmp/usage/artifacts/cache/reviews/.agent-trace) — never blanket .orcaops/**', () => {
    expect(SNAPSHOT_ORCAOPS_EXCLUDE_DIRS).toEqual([
      '.orcaops/tmp',
      '.orcaops/usage',
      '.orcaops/artifacts',
      '.orcaops/cache',
      '.orcaops/reviews',
      '.agent-trace',
    ]);
  });

  it('a live usage-ledger write cannot enter a snapshot tree, but committed .orcaops files still do', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      // The leak surface: a usage-ledger line appended between
      // snapshot boundaries (plus the other volatile dirs), alongside a
      // COMMITTED .orcaops file (legitimate user work) and a source file.
      await mkdir(path.join(repo.path, '.orcaops', 'usage'), { recursive: true });
      await writeFile(
        path.join(repo.path, '.orcaops', 'usage', 'ledger.ndjson'),
        '{"x":1}\n',
        'utf8'
      );
      await mkdir(path.join(repo.path, '.orcaops', 'artifacts', 'a1'), { recursive: true });
      await writeFile(
        path.join(repo.path, '.orcaops', 'artifacts', 'a1', 'events.ndjson'),
        '{}\n',
        'utf8'
      );
      await mkdir(path.join(repo.path, '.orcaops', 'cache'), { recursive: true });
      await writeFile(path.join(repo.path, '.orcaops', 'cache', 'orcaops.db'), 'db', 'utf8');
      await writeFile(path.join(repo.path, '.orcaops', 'install.json'), '{"v":1}\n', 'utf8');
      await writeFile(path.join(repo.path, 'src.ts'), 'export {};\n', 'utf8');

      const r = await captureCheckpointSnapshot({
        repo: new Repo(repo.path),
        artifactId: '019e293d-1111-7000-8000-000000000001',
        checkpointN: 1,
        phase: 'open',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const paths = await lsTreePaths(repo.path, r.tree_sha);
      expect(paths).toContain('src.ts');
      expect(paths).toContain('.orcaops/install.json'); // user work keeps fingerprinting
      expect(paths.some((p) => p.startsWith('.orcaops/usage/'))).toBe(false);
      expect(paths.some((p) => p.startsWith('.orcaops/artifacts/'))).toBe(false);
      expect(paths.some((p) => p.startsWith('.orcaops/cache/'))).toBe(false);
      expect(paths.some((p) => p.startsWith('.orcaops/tmp/'))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

// ── runGit (smoke + cap behavior) ──────────────────────────────────

describe('runGit', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns code 0 and stdout for a simple successful command', async () => {
    const r = await runGit(repo.path, ['rev-parse', '--show-toplevel']);
    expect(r.code).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stdout.toString('utf8').trim().length).toBeGreaterThan(0);
    expect(r.stderr).toBe('');
    expect(r.truncated).toBe(false);
    expect(r.killedByCap).toBe(false);
  });

  it('returns non-zero code with stderr for a failed command', async () => {
    const r = await runGit(repo.path, ['rev-parse', 'this-ref-does-not-exist']);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.killedByCap).toBe(false);
  });

  it('honors maxStdoutBytes by killing the child and flagging truncated', async () => {
    // `git config --list` typically emits a few hundred bytes on a fresh
    // temp repo (user.name/user.email at minimum). Cap at 4 bytes — well
    // below that — to force a kill. `killedByCap` is the canonical
    // observable signal to callers; the underlying exit code/signal is
    // intentionally not asserted because git may handle SIGTERM
    // gracefully and surface as code 143 (= 128 + SIGTERM) rather than
    // signal: 'SIGTERM'.
    const r = await runGit(repo.path, ['config', '--list'], {
      maxStdoutBytes: 4,
    });
    expect(r.truncated).toBe(true);
    expect(r.killedByCap).toBe(true);
    expect(r.stdout.length).toBe(4);
  });

  it('passes env overrides through to the child without losing process.env', async () => {
    // GIT_CONFIG_COUNT + GIT_CONFIG_KEY_<n> + GIT_CONFIG_VALUE_<n>
    // (Git 2.31+) lets us inject a config value purely via env. The
    // resulting `git config --get` echoes our injected value back,
    // proving the env was passed to the child (and that the override
    // beats the temp-repo's file-based config, which createTempRepo
    // may have populated). This pattern also exercises the
    // {...process.env, ...overrides} spread order callers must use.
    const r = await runGit(repo.path, ['config', '--get', 'user.name'], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'orcaops-via-env',
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.toString('utf8').trim()).toBe('orcaops-via-env');
  });
});

// ── resolveRepoTopLevel ────────────────────────────────────────────

describe('resolveRepoTopLevel', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns the absolute repo root when called from the root', async () => {
    const top = await resolveRepoTopLevel(repo.path);
    // realpath may differ from `repo.path` on macOS (`/tmp` → `/private/tmp`);
    // assert that resolveRepoTopLevel's result is a non-empty absolute path
    // pointing at a real .git-bearing directory.
    expect(top.length).toBeGreaterThan(0);
    expect(top.startsWith('/')).toBe(true);
  });

  it('returns the same root when called from a subdirectory', async () => {
    const { mkdir } = await import('node:fs/promises');
    const path = await import('node:path');
    const sub = path.join(repo.path, 'subdir');
    await mkdir(sub, { recursive: true });
    const topFromRoot = await resolveRepoTopLevel(repo.path);
    const topFromSub = await resolveRepoTopLevel(sub);
    expect(topFromSub).toBe(topFromRoot);
  });

  it('throws when cwd is not inside a git work tree', async () => {
    await expect(resolveRepoTopLevel('/tmp')).rejects.toThrow(/not inside a git work tree/);
  });
});

// ── captureCheckpointSnapshot ──────────────────────────────────────

const ART = '019e293d-1111-7000-8000-000000000001';

/** List every path under a tree SHA (recursive, names only). */
async function lsTreePaths(repoPath: string, treeSha: string): Promise<string[]> {
  const r = await runGit(repoPath, ['ls-tree', '-r', '--name-only', treeSha]);
  expect(r.code).toBe(0);
  return r.stdout
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read the content of a path at a tree SHA. */
async function showAtTree(repoPath: string, treeSha: string, filePath: string): Promise<string> {
  const r = await runGit(repoPath, ['show', `${treeSha}:${filePath}`]);
  expect(r.code).toBe(0);
  return r.stdout.toString('utf8');
}

/** Read the commit object header (raw) for inspecting the author line. */
async function catFileCommit(repoPath: string, commitSha: string): Promise<string> {
  const r = await runGit(repoPath, ['cat-file', '-p', commitSha]);
  expect(r.code).toBe(0);
  return r.stdout.toString('utf8');
}

describe('materializeSnapshotTree', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('materializes a snapshot commit into a detached scratch worktree without touching the live one', async () => {
    await writeFile(path.join(repo.path, 'work.ts'), 'export const w = 1;\n', 'utf8');
    const snap = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: 'art-mat-1',
      checkpointN: 1,
      phase: 'close',
    });
    if (!snap.ok) throw new Error('fixture snapshot failed');

    const dir = path.join(repo.path, '..', `scratch-${Date.now()}`);
    const result = await materializeSnapshotTree(new Repo(repo.path), snap.commit_sha, dir);
    expect(result).toEqual({ ok: true, dir });

    // Scratch dir has the snapshotted (untracked) file and is a linked
    // worktree; the live worktree registry lists it.
    const scratch = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo.path,
    }).toString();
    expect(scratch).toContain(dir);

    // Cleanup so temp-repo teardown is clean.
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: repo.path });
  });

  it('returns commit_unreachable for an absent commit', async () => {
    const dir = path.join(repo.path, '..', `scratch-unreachable-${Date.now()}`);
    const result = await materializeSnapshotTree(
      new Repo(repo.path),
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      dir
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_reason).toBe('commit_unreachable');
  });

  it('returns commit_unreachable for a malformed sha (no git invocation on garbage)', async () => {
    const result = await materializeSnapshotTree(
      new Repo(repo.path),
      'not-a-sha; rm -rf /',
      path.join(repo.path, '..', 'never-created')
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_reason).toBe('commit_unreachable');
  });

  it('returns target_not_empty for an occupied target dir', async () => {
    const snap = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: 'art-mat-2',
      checkpointN: 1,
      phase: 'close',
    });
    if (!snap.ok) throw new Error('fixture snapshot failed');
    const dir = path.join(repo.path, '..', `scratch-occupied-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'occupied.txt'), 'x', 'utf8');
    const result = await materializeSnapshotTree(new Repo(repo.path), snap.commit_sha, dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_reason).toBe('target_not_empty');
  });
});

describe('captureCheckpointSnapshot — happy path', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('captures tracked modifications, deletions, and non-ignored untracked files', async () => {
    // Setup: README.md exists (from createTempRepo); modify it, add a new
    // untracked file, write a .gitignore that excludes "secret.txt", and
    // add an ignored file.
    await writeFile(path.join(repo.path, 'README.md'), '# modified\n', 'utf8');
    await writeFile(path.join(repo.path, 'new.ts'), 'export const x = 1;\n', 'utf8');
    await writeFile(path.join(repo.path, '.gitignore'), 'secret.txt\n', 'utf8');
    await writeFile(path.join(repo.path, 'secret.txt'), 'shh\n', 'utf8');
    // Also commit a deletable file, then delete it on disk.
    await writeFile(path.join(repo.path, 'todelete.txt'), 'gone\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('todelete.txt');
    await git.commit('add todelete');
    await rm(path.join(repo.path, 'todelete.txt'));

    const r = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return; // narrow the union for TypeScript
    expect(r.phase).toBe('open');
    expect(r.ref).toBe(`${SNAPSHOT_REF_PREFIX}/${ART}/1/open`);
    expect(r.tree_sha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(r.commit_sha).toMatch(/^[0-9a-f]{40,64}$/);

    const paths = await lsTreePaths(repo.path, r.tree_sha);
    expect(paths).toContain('README.md');
    expect(paths).toContain('new.ts');
    expect(paths).toContain('.gitignore');
    expect(paths).not.toContain('secret.txt'); // gitignored
    expect(paths).not.toContain('todelete.txt'); // deleted
    // README.md should reflect the modified content, not the initial commit.
    const readmeAtTree = await showAtTree(repo.path, r.tree_sha, 'README.md');
    expect(readmeAtTree).toBe('# modified\n');
  });

  it('leaves git status --porcelain byte-identical pre/post capture', async () => {
    // Make some changes so git status has something to show — but it
    // shouldn't change across the snapshot capture.
    await writeFile(path.join(repo.path, 'a.ts'), 'one\n', 'utf8');
    await writeFile(path.join(repo.path, 'README.md'), '# changed\n', 'utf8');

    const r = new Repo(repo.path);
    const before = await r.getWorkingTreeStatus();

    const result = await captureCheckpointSnapshot({
      repo: r,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(result.ok).toBe(true);

    const after = await r.getWorkingTreeStatus();
    expect(after).toBe(before);
  });

  it('runs 10 parallel captures with distinct (n, phase) tuples without collision', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'parallel-test\n', 'utf8');

    const repoObj = new Repo(repo.path);
    const tuples: Array<{ n: number; phase: SnapshotPhase }> = [];
    for (let n = 1; n <= 5; n++) {
      tuples.push({ n, phase: 'open' });
      tuples.push({ n, phase: 'close' });
    }
    const results = await Promise.all(
      tuples.map((t) =>
        captureCheckpointSnapshot({
          repo: repoObj,
          artifactId: ART,
          checkpointN: t.n,
          phase: t.phase,
        })
      )
    );

    const refs = new Set<string>();
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      refs.add(r.ref);
    }
    expect(refs.size).toBe(tuples.length); // every ref distinct

    // And every ref must actually exist in the repo.
    const fer = await runGit(repo.path, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/orcaops/snap/',
    ]);
    expect(fer.code).toBe(0);
    const live = new Set(
      fer.stdout
        .toString('utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    for (const ref of refs) {
      expect(live.has(ref)).toBe(true);
    }
  });
});

describe('captureReviewWorktreeTreeSha — classified untracked evidence', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('keeps tracked edits, excludes untracked by default, and includes exact opt-ins', async () => {
    await writeFile(path.join(repo.path, 'README.md'), '# tracked edit\n', 'utf8');
    await mkdir(path.join(repo.path, 'src'), { recursive: true });
    await writeFile(path.join(repo.path, 'src', 'intentional.ts'), 'export const x = 1;\n');
    await writeFile(path.join(repo.path, 'local-report.md'), 'not review evidence\n');

    const result = await captureReviewWorktreeTreeSha(new Repo(repo.path), ['src/intentional.ts']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.included_untracked).toEqual(['src/intentional.ts']);
    expect(result.excluded_untracked).toEqual(['local-report.md']);
    expect(result.ignored_opt_ins).toEqual([]);
    expect(result.unmatched_opt_ins).toEqual([]);
    expect(result.untracked_details).toEqual([
      { path: 'local-report.md', bytes: 20, rows: 1 },
      { path: 'src/intentional.ts', bytes: 20, rows: 1 },
    ]);
    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).toContain('README.md');
    expect(paths).toContain('src/intentional.ts');
    expect(paths).not.toContain('local-report.md');
    expect(await showAtTree(repo.path, result.tree_sha, 'README.md')).toBe('# tracked edit\n');
  });

  it('rejects ignored/generated and absent opt-ins without adding them', async () => {
    await writeFile(path.join(repo.path, '.gitignore'), 'generated/\n', 'utf8');
    await mkdir(path.join(repo.path, 'generated'), { recursive: true });
    await writeFile(path.join(repo.path, 'generated', 'bundle.txt'), 'generated\n', 'utf8');
    const result = await captureReviewWorktreeTreeSha(new Repo(repo.path), [
      'generated/bundle.txt',
      'missing.ts',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.included_untracked).toEqual([]);
    expect(result.ignored_opt_ins).toEqual(['generated/bundle.txt']);
    expect(result.unmatched_opt_ins).toEqual(['missing.ts']);
    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).not.toContain('generated/bundle.txt');
  });

  it('withholds an excluded file inside an opted-in directory, keeping its neighbours', async () => {
    // The review tree is pinned to a durable ref reachable from no branch, so
    // opting a directory into review must not be a way to blob the credentials
    // that happen to sit in it.
    await mkdir(path.join(repo.path, 'evidence'), { recursive: true });
    await writeFile(path.join(repo.path, 'evidence', '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');
    await writeFile(path.join(repo.path, 'evidence', 'server.key'), 'EXAMPLE0\n', 'utf8');
    await writeFile(path.join(repo.path, 'evidence', 'run.log'), 'started\n', 'utf8');

    const result = await captureReviewWorktreeTreeSha(new Repo(repo.path), ['evidence'], {
      excludePatterns: ['**/.env', '**/*.key'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sensitive_opt_ins).toEqual(['evidence/.env', 'evidence/server.key']);
    expect(result.retained_sensitive_opt_ins).toEqual([]);
    expect(result.included_untracked).toEqual(['evidence/run.log']);
    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).not.toContain('evidence/.env');
    expect(paths).not.toContain('evidence/server.key');
    expect(paths).toContain('evidence/run.log');
  });

  it('never writes the withheld blob, so the pin cannot resurrect it', async () => {
    // Scrubbing the index entry would leave the object in the store; the point
    // of filtering the opt-in list first is that `git add` never sees the path.
    await mkdir(path.join(repo.path, 'evidence'), { recursive: true });
    await writeFile(path.join(repo.path, 'evidence', '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');

    const result = await captureReviewWorktreeTreeSha(new Repo(repo.path), ['evidence'], {
      excludePatterns: ['**/.env'],
    });
    expect(result.ok).toBe(true);
    const blob = execFileSync('git', ['hash-object', 'evidence/.env'], { cwd: repo.path })
      .toString('utf8')
      .trim();
    expect(() =>
      execFileSync('git', ['cat-file', '-e', blob], { cwd: repo.path, stdio: 'ignore' })
    ).toThrow();
  });

  it('reports a staged-but-uncommitted untracking as retained, never as withheld', async () => {
    // `git rm --cached` with no commit behind it: the path reads untracked
    // against the live index this classification uses, and tracked against the
    // temp index seeded from HEAD that the tree is built from. Exclusion never
    // removes it, so the reviewer is looking at its bytes — and must not be
    // told they were held back.
    await mkdir(path.join(repo.path, 'evidence'), { recursive: true });
    await writeFile(path.join(repo.path, 'evidence', '.env'), 'OLD=harmless\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('evidence/.env');
    await git.commit('seed evidence');
    await writeFile(path.join(repo.path, 'evidence', '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');
    execFileSync('git', ['rm', '--cached', '--quiet', 'evidence/.env'], { cwd: repo.path });

    const result = await captureReviewWorktreeTreeSha(new Repo(repo.path), ['evidence'], {
      excludePatterns: ['**/.env'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sensitive_opt_ins).toEqual([]);
    expect(result.retained_sensitive_opt_ins).toEqual(['evidence/.env']);
    expect(await lsTreePaths(repo.path, result.tree_sha)).toContain('evidence/.env');
  });

  it('captures the opted-in file when no exclude set is supplied', async () => {
    await mkdir(path.join(repo.path, 'evidence'), { recursive: true });
    await writeFile(path.join(repo.path, 'evidence', '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');

    const result = await captureReviewWorktreeTreeSha(new Repo(repo.path), ['evidence']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sensitive_opt_ins).toEqual([]);
    expect(await lsTreePaths(repo.path, result.tree_sha)).toContain('evidence/.env');
  });
});

describe('capture.exclude reaches the lifecycle callers', () => {
  // `captureWorktreeTree` honours an exclude set; nothing proved its callers
  // forward one. Dropping the forward from either caller left every direct
  // test green while the excluded file went into a durable pinned tree.
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');
    await writeFile(path.join(repo.path, 'notes.md'), 'untracked but harmless\n', 'utf8');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('holds an excluded file out of a checkpoint snapshot', async () => {
    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
      excludePatterns: ['**/.env'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).not.toContain('.env');
    // Scoped, not a blanket drop of everything untracked.
    expect(paths).toContain('notes.md');
  });

  it('holds an excluded file out of the baseline snapshot', async () => {
    // The baseline is the FIRST capture of every task and pins its tree to a
    // durable ref, so a miss here writes the file into an object reachable
    // from no branch — the checkout disclosure is checkpoint-scoped and never
    // sees a baseline.
    const result = await captureBaselineSnapshot(new Repo(repo.path), ART, {
      excludePatterns: ['**/.env'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).not.toContain('.env');
    expect(paths).toContain('notes.md');
  });

  it('never writes the excluded blob on either lifecycle path', async () => {
    // The pathspec, not the index scrub, is what this asserts: scrubbing the
    // entry leaves the object behind, and both refs are durable.
    const blob = execFileSync('git', ['hash-object', '.env'], { cwd: repo.path })
      .toString('utf8')
      .trim();
    await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 2,
      phase: 'open',
      excludePatterns: ['**/.env'],
    });
    await captureBaselineSnapshot(new Repo(repo.path), ART, { excludePatterns: ['**/.env'] });
    expect(() =>
      execFileSync('git', ['cat-file', '-e', blob], { cwd: repo.path, stdio: 'ignore' })
    ).toThrow();
  });
});

describe('captureWorktreeTree — the exclude probe', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  // A failed probe leaves the exclude set empty and the capture is taken with
  // NO exclusion — fail-open by contract. `exclusion_probe_failed` is what
  // stops that reading as "there was nothing to withhold" at the boundary.
  //
  // Only the healthy direction is exercised here. Every way of making
  // `ls-files --others --exclude-standard` fail that is reachable through this
  // API — a broken `core.excludesFile` being the obvious one — fails an
  // earlier git step too, so the capture returns `ok: false` and is already
  // loud. The silent case needs the probe to fail alone, which nothing in the
  // public surface can arrange.
  it('does not report a failure on a healthy capture', async () => {
    const result = await captureWorktreeTree(new Repo(repo.path), 'probe-ok', {
      skipCommit: true,
      excludePatterns: ['**/.env'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exclusion_probe_failed).toBeUndefined();
    expect(await lsTreePaths(repo.path, result.tree_sha)).not.toContain('.env');
  });

  it('does not report a failure when no exclude set was configured', async () => {
    // The probe only runs for a non-empty set, so a capture with none has
    // nothing to report either way.
    const result = await captureWorktreeTree(new Repo(repo.path), 'probe-absent', {
      skipCommit: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exclusion_probe_failed).toBeUndefined();
  });
});

describe('captureWorktreeTree — capture.exclude under trackedOnly', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeFile(path.join(repo.path, 'src.ts'), 'export const a = 1;\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('src.ts');
    await git.commit('root');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('scrubs an excluded path that an opt-in staged', async () => {
    // Under trackedOnly the opt-in `git add` is the only route an untracked
    // file has into the tree, so the exclusion has to be resolved there too.
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');

    const result = await captureWorktreeTree(new Repo(repo.path), 'tracked-excl', {
      skipCommit: true,
      trackedOnly: true,
      includeUntracked: ['.env'],
      excludePatterns: ['**/.env'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await lsTreePaths(repo.path, result.tree_sha)).not.toContain('.env');
  });

  it('leaves the tracked-only floor intact — an exclude set adds no untracked files', async () => {
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');
    await writeFile(path.join(repo.path, 'notes.md'), 'untracked but harmless\n', 'utf8');

    const result = await captureWorktreeTree(new Repo(repo.path), 'tracked-floor', {
      skipCommit: true,
      trackedOnly: true,
      excludePatterns: ['**/.env'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('notes.md');
    expect(paths).toContain('src.ts');
  });
});

describe('captureCheckpointSnapshot — fail-open backstop', () => {
  let repo: TempRepo;
  let originalPath: string | undefined;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    originalPath = process.env.PATH;
  });

  afterEach(async () => {
    // PATH restoration MUST run regardless of test outcome to avoid
    // poisoning other tests in the same worker.
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await repo.cleanup();
  });

  it('returns ok:false unknown when a runGit invocation rejects mid-capture (does not throw)', async () => {
    // The real fail-open gap is downstream of resolveRepoTopLevel and
    // getHeadSha — those two have already succeeded by the time the
    // mutation lands. We need runGit to reject AFTER step 3 (getHeadSha)
    // so the spawn-channel failure exercises the actual untyped-error
    // path that the outer try/catch is designed to backstop.
    //
    // Trick: subclass Repo so getHeadSha() returns normally, then mutates
    // PATH to a no-git directory before returning. The next runGit spawn
    // (step 6, read-tree) ENOENTs and runGit's 'error' handler rejects. The
    // outer try/catch must convert that into
    // { ok: false, error_reason: 'unknown' }.
    class HeadSpyRepo extends Repo {
      override async getHeadSha(): Promise<string> {
        const real = await super.getHeadSha();
        // After Repo's own spawn has already resolved + returned the SHA,
        // poison PATH so the next runGit invocation cannot find git.
        process.env.PATH = '/var/empty';
        return real;
      }
    }

    const result = await captureCheckpointSnapshot({
      repo: new HeadSpyRepo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_reason).toBe('unknown');
    expect(typeof result.error_message).toBe('string');
    expect((result.error_message ?? '').length).toBeGreaterThan(0);
  });
});

describe('captureCheckpointSnapshot — tracked .orcaops/tmp/* scrub', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('does NOT include .orcaops/tmp/* paths that were tracked in HEAD', async () => {
    // `read-tree HEAD` stages committed `.orcaops/tmp/*` content before the
    // worktree overlay. The explicit cached-index scrub between `add -A` and
    // `write-tree` must remove those tracked entries.
    const tmpDir = path.join(repo.path, '.orcaops', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'tracked.index'), 'oops should not snapshot\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('.orcaops/tmp/tracked.index');
    await git.commit(
      'commit a tracked tmp file (regression fixture: must never appear in snapshots)'
    );

    // Sanity-check the setup: HEAD really does contain the tracked tmp file.
    const lsHead = await runGit(repo.path, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(lsHead.code).toBe(0);
    expect(lsHead.stdout.toString('utf8')).toContain('.orcaops/tmp/tracked.index');

    // Add a sanity-check non-tmp file too so we can confirm the scrub
    // is scoped (doesn't accidentally drop everything from the index).
    await writeFile(path.join(repo.path, 'kept.txt'), 'kept\n', 'utf8');

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snap = await lsTreePaths(repo.path, result.tree_sha);
    // Critical regression assertion: NO .orcaops/tmp/* path in the snapshot.
    expect(snap.some((p) => p.startsWith('.orcaops/tmp/'))).toBe(false);
    expect(snap).not.toContain('.orcaops/tmp/tracked.index');
    // Scope sanity: the scrub didn't accidentally drop other content.
    expect(snap).toContain('kept.txt');
    expect(snap).toContain('README.md');
  });
});

describe('captureCheckpointSnapshot — nested .orcaops scrub', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('scrubs a nested .orcaops at any depth while ROOT .orcaops committed files survive', async () => {
    // A nested store (wrong-root litter) INGESTED into snapshot trees blows
    // the live review diff past max_diff_bytes. Committed here so both index
    // sources (read-tree HEAD
    // and add -A) would carry it without the scrub.
    const nestedDir = path.join(repo.path, 'apps', 'demo', '.orcaops', 'reviews');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(nestedDir, 'floor.json'), '{"poison":true}\n', 'utf8');
    const rootStore = path.join(repo.path, '.orcaops');
    await mkdir(rootStore, { recursive: true });
    await writeFile(path.join(rootStore, 'evaluators.yaml'), 'packs: []\n', 'utf8');
    await writeFile(path.join(repo.path, 'kept.txt'), 'kept\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add([
      'apps/demo/.orcaops/reviews/floor.json',
      '.orcaops/evaluators.yaml',
      'kept.txt',
    ]);
    await git.commit('fixture: nested .orcaops litter + legitimate root config');

    // An untracked nested store too — the add -A ingestion path.
    const nestedDeep = path.join(repo.path, 'a', 'b', 'c', '.orcaops', 'cache');
    await mkdir(nestedDeep, { recursive: true });
    await writeFile(path.join(nestedDeep, 'orcaops.db'), 'db\n', 'utf8');

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snap = await lsTreePaths(repo.path, result.tree_sha);
    // Nested stores are scrubbed at every depth, tracked and untracked alike.
    expect(snap.some((p) => p.includes('/.orcaops/'))).toBe(false);
    expect(snap).not.toContain('apps/demo/.orcaops/reviews/floor.json');
    expect(snap).not.toContain('a/b/c/.orcaops/cache/orcaops.db');
    // Root-safety: the ROOT store's committed user work SURVIVES.
    expect(snap).toContain('.orcaops/evaluators.yaml');
    expect(snap).toContain('kept.txt');
    expect(snap).toContain('README.md');
  });
});

describe('diffSnapshotStats', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns per-file added/deleted rows between two trees (binary → nulls)', async () => {
    const git = gitClient(repo.path);
    const treeA = await runGit(repo.path, ['rev-parse', 'HEAD^{tree}']);
    expect(treeA.code).toBe(0);

    await writeFile(path.join(repo.path, 'grew.txt'), 'one\ntwo\nthree\n', 'utf8');
    await writeFile(path.join(repo.path, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0, 7]));
    await git.add(['grew.txt', 'bin.dat']);
    await git.commit('grow');
    const treeB = await runGit(repo.path, ['rev-parse', 'HEAD^{tree}']);
    expect(treeB.code).toBe(0);

    const stats = await diffSnapshotStats({
      repo: new Repo(repo.path),
      openTreeSha: treeA.stdout.toString('utf8').trim(),
      closeTreeSha: treeB.stdout.toString('utf8').trim(),
    });
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;
    const byPath = new Map(stats.entries.map((e) => [e.path, e]));
    expect(byPath.get('grew.txt')).toEqual({ path: 'grew.txt', added: 3, deleted: 0 });
    expect(byPath.get('bin.dat')).toEqual({ path: 'bin.dat', added: null, deleted: null });
  });

  it('fails soft on an unresolvable tree', async () => {
    const stats = await diffSnapshotStats({
      repo: new Repo(repo.path),
      openTreeSha: '0000000000000000000000000000000000000000',
      closeTreeSha: '1111111111111111111111111111111111111111',
    });
    expect(stats.ok).toBe(false);
  });
});

/**
 * Synthesize an unmerged index entry for `filePath` without running a real
 * merge: `update-index --index-info` reads `<mode> <sha> <stage>\t<path>`
 * lines from stdin and is the documented way to write multi-stage entries
 * directly. Leaves NO worktree file — tests that need conflict-marker bytes
 * in the snapshot tree write the file themselves.
 */
async function forgeUnmergedEntry(
  repoPath: string,
  filePath: string,
  stages: readonly (1 | 2 | 3)[] = [1, 2, 3]
): Promise<void> {
  const stageContent: Record<1 | 2 | 3, string> = {
    1: `base content of ${filePath}\n`,
    2: `ours content of ${filePath}\n`,
    3: `theirs content of ${filePath}\n`,
  };
  const lines: string[] = [];
  for (const stage of stages) {
    const hashed = await runGit(repoPath, ['hash-object', '-w', '--stdin'], {
      stdin: stageContent[stage],
    });
    if (hashed.code !== 0) throw new Error(`hash-object failed: ${hashed.stderr}`);
    lines.push(`100644 ${hashed.stdout.toString('utf8').trim()} ${stage}\t${filePath}`);
  }
  const ui = await runGit(repoPath, ['update-index', '--index-info'], {
    stdin: `${lines.join('\n')}\n`,
  });
  if (ui.code !== 0) throw new Error(`update-index --index-info failed: ${ui.stderr}`);
}

describe('captureCheckpointSnapshot — failure classifications', () => {
  let repo: TempRepo;

  afterEach(async () => {
    if (repo) await repo.cleanup();
  });

  it('returns unborn_repo deterministically and pins no ref', async () => {
    repo = await createTempRepo({ initialCommit: false });

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_reason).toBe('unborn_repo');

    // Critical: no ref should have been created.
    const fer = await runGit(repo.path, ['for-each-ref', 'refs/orcaops/snap/']);
    expect(fer.code).toBe(0);
    expect(fer.stdout.toString('utf8').trim()).toBe('');
  });

  it('captures through an unmerged index, reporting the conflicted path', async () => {
    repo = await createTempRepo({ initialBranch: 'main' });

    await forgeUnmergedEntry(repo.path, 'conflict.txt');
    const markerContent = '<<<<<<< HEAD\nours content\n=======\ntheirs content\n>>>>>>> theirs\n';
    await writeFile(path.join(repo.path, 'conflict.txt'), markerContent, 'utf8');

    // Sanity: confirm the unmerged probe sees the staged entries.
    const before = await runGit(repo.path, ['ls-files', '-u']);
    expect(before.code).toBe(0);
    expect(before.stdout.length).toBeGreaterThan(0);

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unmerged_paths).toEqual(['conflict.txt']);
    expect(result.unmerged_probe_failed).toBeUndefined();

    // The snapshot ref was pinned and the tree holds the worktree bytes
    // (markers included) for the conflicted path.
    const ref = await runGit(repo.path, ['rev-parse', result.ref]);
    expect(ref.code).toBe(0);
    const blob = await runGit(repo.path, ['show', `${result.tree_sha}:conflict.txt`]);
    expect(blob.code).toBe(0);
    expect(blob.stdout.toString('utf8')).toBe(markerContent);

    // The REAL index is byte-for-byte untouched: same stage entries.
    const after = await runGit(repo.path, ['ls-files', '-u']);
    expect(after.code).toBe(0);
    expect(after.stdout.toString('utf8')).toBe(before.stdout.toString('utf8'));
  });

  it('returns index_locked when the ref lock file pre-exists', async () => {
    repo = await createTempRepo({ initialBranch: 'main' });

    // Pre-create the .lock file at the exact path update-ref will try to
    // acquire. This simulates a concurrent ref-lock holder.
    const lockDir = path.join(repo.path, '.git', 'refs', 'orcaops', 'snap', ART, '1');
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, 'open.lock'), '', 'utf8');

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_reason).toBe('index_locked');
  });
});

describe('parseUnmergedPathsZ', () => {
  it('dedupes the per-stage entries of one path', () => {
    const out =
      `100644 ${'a'.repeat(40)} 1\tconflict.txt\0` +
      `100644 ${'b'.repeat(40)} 2\tconflict.txt\0` +
      `100644 ${'c'.repeat(40)} 3\tconflict.txt\0`;
    expect(parseUnmergedPathsZ(out)).toEqual(['conflict.txt']);
  });

  it('keeps distinct paths from rename/rename conflicts, sorted', () => {
    const out =
      `100644 ${'a'.repeat(40)} 2\tzeta.txt\0` + `100644 ${'b'.repeat(40)} 3\talpha.txt\0`;
    expect(parseUnmergedPathsZ(out)).toEqual(['alpha.txt', 'zeta.txt']);
  });

  it('returns [] for empty output and skips malformed records', () => {
    expect(parseUnmergedPathsZ('')).toEqual([]);
    expect(parseUnmergedPathsZ('garbage-without-tab\0')).toEqual([]);
  });
});

describe('captureWorktreeTree — unmerged-index collection', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports an empty set on a clean index', async () => {
    const result = await captureWorktreeTree(new Repo(repo.path), `${ART}/1/open`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unmerged_paths).toEqual([]);
    expect(result.unmerged_probe_failed).toBeUndefined();
  });

  it('does not treat committed conflict-marker text as an unmerged state', async () => {
    const markers = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
    await writeFile(path.join(repo.path, 'doc-with-markers.md'), markers, 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'commit literal marker text'], { cwd: repo.path });

    const result = await captureWorktreeTree(new Repo(repo.path), `${ART}/1/open`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unmerged_paths).toEqual([]);
  });

  it('parses paths with spaces and unicode via -z', async () => {
    const weird = 'süb dir/naïve file.txt';
    await mkdir(path.join(repo.path, 'süb dir'), { recursive: true });
    await forgeUnmergedEntry(repo.path, weird);

    const result = await captureWorktreeTree(new Repo(repo.path), `${ART}/1/open`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unmerged_paths).toEqual([weird]);
  });

  it('collects every distinct path, including partial-stage entries, sorted', async () => {
    await forgeUnmergedEntry(repo.path, 'b-conflict.txt');
    await forgeUnmergedEntry(repo.path, 'a-conflict.txt');
    // deleted-by-us shape: stages 1 and 3 only, no worktree file.
    await forgeUnmergedEntry(repo.path, 'c-deleted.txt', [1, 3]);

    const result = await captureWorktreeTree(new Repo(repo.path), `${ART}/1/open`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unmerged_paths).toEqual(['a-conflict.txt', 'b-conflict.txt', 'c-deleted.txt']);
  });

  it('fails open with unmerged_probe_failed when the real index is unreadable', async () => {
    // The pipeline itself never reads the real index (temp GIT_INDEX_FILE),
    // so corrupting it breaks EXACTLY the probe.
    await writeFile(path.join(repo.path, '.git', 'index'), 'not an index\n', 'utf8');

    const result = await captureWorktreeTree(new Repo(repo.path), `${ART}/1/open`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unmerged_paths).toEqual([]);
    expect(result.unmerged_probe_failed).toBe(true);
  });

  it('propagates through captureWorktreeTreeSha, baseline, and review captures', async () => {
    await forgeUnmergedEntry(repo.path, 'conflict.txt');
    await writeFile(path.join(repo.path, 'conflict.txt'), 'markers\n', 'utf8');

    const live = await captureWorktreeTreeSha(new Repo(repo.path));
    expect(live.ok).toBe(true);
    if (live.ok) expect(live.unmerged_paths).toEqual(['conflict.txt']);

    const baseline = await captureBaselineSnapshot(new Repo(repo.path), ART);
    expect(baseline.ok).toBe(true);
    if (baseline.ok) expect(baseline.unmerged_paths).toEqual(['conflict.txt']);

    const review = await captureReviewWorktreeTreeSha(new Repo(repo.path));
    expect(review.ok).toBe(true);
    if (review.ok) expect(review.unmerged_paths).toEqual(['conflict.txt']);
  });
});

describe('captureCheckpointSnapshot — subdirectory caller', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('captures the FULL worktree even when Repo points at a subdirectory', async () => {
    // Files at both the root and inside a subdirectory.
    await writeFile(path.join(repo.path, 'root-file.ts'), 'root\n', 'utf8');
    const subDir = path.join(repo.path, 'subdir');
    await mkdir(subDir, { recursive: true });
    await writeFile(path.join(subDir, 'sub-file.ts'), 'sub\n', 'utf8');

    // Construct Repo at the SUBDIRECTORY — this is the case the
    // resolveRepoTopLevel anchoring is meant to handle.
    const result = await captureCheckpointSnapshot({
      repo: new Repo(subDir),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).toContain('root-file.ts');
    expect(paths).toContain('subdir/sub-file.ts');
  });
});

describe('captureCheckpointSnapshot — env override resistance', () => {
  let repo: TempRepo;
  let originalAuthorName: string | undefined;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    originalAuthorName = process.env.GIT_AUTHOR_NAME;
  });

  afterEach(async () => {
    if (originalAuthorName === undefined) {
      delete process.env.GIT_AUTHOR_NAME;
    } else {
      process.env.GIT_AUTHOR_NAME = originalAuthorName;
    }
    await repo.cleanup();
  });

  it('stamps the fixed orcaops-snapshot identity even when GIT_AUTHOR_NAME is exported', async () => {
    // Simulate a developer with a wonky ambient env. Our env-spread order
    // (process.env first, overrides LAST) must beat this.
    process.env.GIT_AUTHOR_NAME = 'attacker';

    await writeFile(path.join(repo.path, 'work.txt'), 'env-test\n', 'utf8');

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const commitText = await catFileCommit(repo.path, result.commit_sha);
    // The author line should carry our fixed identity, not the ambient one.
    expect(commitText).toMatch(/^author orcaops-snapshot <orcaops@local>/m);
    expect(commitText).toMatch(/^committer orcaops-snapshot <orcaops@local>/m);
    expect(commitText).not.toMatch(/attacker/);
  });
});

describe('captureCheckpointSnapshot — idempotent ref pinning', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('a second capture against an unchanged tree pins the same tree_sha', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'stable\n', 'utf8');
    const repoObj = new Repo(repo.path);

    const first = await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.tree_sha).toBe(first.tree_sha);
    // commit_sha MAY differ (dates aren't pinned) but the ref MUST point at
    // the latest commit, and the latest commit's tree MUST match.
    const refRead = await runGit(repo.path, ['rev-parse', second.ref]);
    expect(refRead.code).toBe(0);
    expect(refRead.stdout.toString('utf8').trim()).toBe(second.commit_sha);

    const commitTree = await runGit(repo.path, ['rev-parse', `${second.commit_sha}^{tree}`]);
    expect(commitTree.code).toBe(0);
    expect(commitTree.stdout.toString('utf8').trim()).toBe(second.tree_sha);
  });
});

describe('captureCheckpointSnapshot — volatile-path scrub (regression guard)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    // Crucially, no .gitignore excludes .orcaops/tmp/. The cached-index scrub
    // must keep the volatile subtree out of the snapshot tree by itself.
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('does not capture .orcaops/tmp/snap-<uuid>.index or its .lock sibling', async () => {
    // Pre-existing decoy files under .orcaops/tmp/. The scrub excludes the
    // whole subtree, so these must not appear even though they are not ignored.
    const tmpDir = path.join(repo.path, '.orcaops', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'decoy.index'), '', 'utf8');
    await writeFile(path.join(tmpDir, 'decoy.index.lock'), '', 'utf8');
    await mkdir(path.join(tmpDir, 'locks'), { recursive: true });
    await writeFile(path.join(tmpDir, 'locks', 'art.lock'), '', 'utf8');

    // Sanity-check scope: legitimate committed-class orcaops files MUST
    // still be captured. The exclusion covers the volatile dirs
    // (tmp/usage/artifacts/cache), so the in-scope witness is
    // .orcaops/install.json — the committed user-work class — confirming
    // the exclusion is not a blanket .orcaops/**.
    await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
    await writeFile(path.join(repo.path, '.orcaops', 'install.json'), '{}\n', 'utf8');

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = await lsTreePaths(repo.path, result.tree_sha);

    // No .orcaops/tmp/* paths whatsoever.
    const tmpPaths = paths.filter((p) => p.startsWith('.orcaops/tmp/'));
    expect(tmpPaths).toEqual([]);

    // Specifically the .index and .index.lock forms (also the snap-<uuid>
    // forms that captureCheckpointSnapshot's own temp index creates
    // transiently).
    expect(paths.some((p) => p.endsWith('.index'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.index.lock'))).toBe(false);

    // Scope sanity: committed-class .orcaops content IS in the tree.
    expect(paths).toContain('.orcaops/install.json');
  });

  it('writes NO temp-index debris into the worktree — it never allocates there at all', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'cleanup-test\n', 'utf8');

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(result.ok).toBe(true);

    // The claim: capture never creates `<repo>/.orcaops/tmp/` at all,
    // because the index lives outside the worktree entirely. Written to FAIL rather than
    // pass vacuously: readdir's ENOENT is asserted as the expected outcome
    // instead of being swallowed into an empty list.
    const tmpDir = path.join(repo.path, '.orcaops', 'tmp');
    const { readdir } = await import('node:fs/promises');
    let entries: string[] | null = null;
    let missing = false;
    try {
      entries = await readdir(tmpDir);
    } catch (err) {
      missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
    // Either the directory is absent (the normal case), or it exists for some
    // unrelated reason and holds no snapshot debris. It must never hold ours.
    expect(missing || entries !== null).toBe(true);
    const snapDebris = (entries ?? []).filter(
      (e) => e.startsWith('snap-') && (e.endsWith('.index') || e.endsWith('.index.lock'))
    );
    expect(snapDebris).toEqual([]);
  });
});

// ── gitignored .orcaops/tmp/ ───────

/**
 * `.gitignore` body for the one configuration that breaks an in-worktree
 * temp index, and the one configuration no other test in this file
 * exercises.
 *
 * A temp index INSIDE the worktree (`<repo>/.orcaops/tmp/snap-<uuid>.index`)
 * makes capture self-referential — `git add -A` walks the very index it is
 * writing — so step 8 must carry an `:(exclude).orcaops/tmp/**` pathspec to
 * keep it out of the tree. Once a repo gitignores `.orcaops/tmp/` (which real
 * repos do, to keep that index and the storage lockdir out of `git status`),
 * git refuses the exclude outright — "The following paths are ignored by one
 * of your .gitignore files: .orcaops/tmp", exit 1 — and every capture in that
 * repo fails. `createTempRepo` writes no `.gitignore` at all, so every other
 * test here runs in the single state where that cannot reproduce.
 */
const GITIGNORE_ORCAOPS_TMP = '.orcaops/tmp/\n';

/** The `orcaops-snap-*` private capture directories currently under `root`. */
async function snapTempDirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root)).filter((e) => e.startsWith('orcaops-snap-')).sort();
  } catch {
    return [];
  }
}

/**
 * Run `fn` while sampling `root` for `orcaops-snap-*` entries on every
 * event-loop turn; report every private directory that existed at any point.
 *
 * Load-bearing for the teardown assertions: "no debris remains" is VACUOUSLY
 * true if nothing was ever allocated, so each teardown test pairs it with
 * proof the directory really did exist mid-capture. A capture holds its
 * directory across several awaited `git` spawns, so it cannot slip between
 * two samples.
 */
async function withSnapTempWatch<T>(
  root: string,
  fn: () => Promise<T>
): Promise<{ result: T; observed: string[] }> {
  const observed = new Set<string>();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      for (const name of await snapTempDirs(root)) observed.add(name);
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  let result: T;
  try {
    result = await fn();
  } finally {
    sampling = false;
    await sampler;
  }
  return { result, observed: [...observed].sort() };
}

describe('captureWorktreeTree — gitignored .orcaops/tmp/', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    // Crucially — and unlike every other snapshot fixture in this file — the
    // repo DOES gitignore .orcaops/tmp/.
    await writeFile(path.join(repo.path, '.gitignore'), GITIGNORE_ORCAOPS_TMP, 'utf8');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('captures a tree when .gitignore ignores .orcaops/tmp/', async () => {
    await writeFile(path.join(repo.path, 'work.ts'), 'export const w = 1;\n', 'utf8');

    const result = await captureWorktreeTree(new Repo(repo.path), `${ART}/1/open`);

    // An in-worktree index fails here with { ok: false, error_reason:
    // 'unknown', error_message: 'The following paths are ignored by one of
    // your .gitignore files: .orcaops/tmp' }.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree_sha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40,64}$/);

    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).toContain('work.ts');
    expect(paths).toContain('.gitignore');
  });

  it('captureCheckpointSnapshot succeeds and pins a real ref in the gitignored configuration', async () => {
    await writeFile(path.join(repo.path, 'work.ts'), 'export const w = 1;\n', 'utf8');

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref).toBe(`${SNAPSHOT_REF_PREFIX}/${ART}/1/open`);
    expect(result.tree_sha).toMatch(/^[0-9a-f]{40,64}$/);

    // The ref must genuinely exist — a fail-open capture pins nothing.
    const revParse = await runGit(repo.path, ['rev-parse', result.ref]);
    expect(revParse.code).toBe(0);
    expect(revParse.stdout.toString('utf8').trim()).toBe(result.commit_sha);
  });

  it('captures when .orcaops/tmp/ is gitignored AND already populated (live repo: the storage lockdir)', async () => {
    // The live-repo shape: `.orcaops/tmp/locks/` is created lazily by the
    // storage lock, and earlier runs can leave `snap-*.index` files behind.
    // Git only refuses an exclude pathspec once the ignored directory EXISTS
    // on disk, so this is the state a long-lived repo is in.
    await mkdir(path.join(repo.path, '.orcaops', 'tmp', 'locks'), { recursive: true });
    await writeFile(path.join(repo.path, '.orcaops', 'tmp', 'locks', 'art.lock'), '', 'utf8');
    await writeFile(path.join(repo.path, '.orcaops', 'tmp', 'snap-leftover.index'), '', 'utf8');
    await writeFile(path.join(repo.path, 'work.ts'), 'export const w = 1;\n', 'utf8');

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).toContain('work.ts');
    expect(paths.some((p) => p.startsWith('.orcaops/tmp/'))).toBe(false);
  });
});

describe('captureCheckpointSnapshot — index stays out of the tree in EITHER gitignore configuration', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const configurations = [
    { label: '.orcaops/tmp/ IS gitignored', gitignore: GITIGNORE_ORCAOPS_TMP },
    { label: '.orcaops/tmp/ is NOT gitignored', gitignore: null },
  ] as const;

  for (const configuration of configurations) {
    it(`captures no .orcaops/tmp/ path and no snap-*.index / *.index.lock when ${configuration.label}`, async () => {
      if (configuration.gitignore !== null) {
        await writeFile(path.join(repo.path, '.gitignore'), configuration.gitignore, 'utf8');
      }

      // Decoys under .orcaops/tmp/. In the NOT-gitignored configuration these
      // are staged by `git add -A` and must be removed by step 11's
      // `rm -r --cached`; in the gitignored configuration `add -A` skips them.
      const tmpDir = path.join(repo.path, '.orcaops', 'tmp');
      await mkdir(path.join(tmpDir, 'locks'), { recursive: true });
      await writeFile(path.join(tmpDir, 'snap-decoy.index'), '', 'utf8');
      await writeFile(path.join(tmpDir, 'snap-decoy.index.lock'), '', 'utf8');
      await writeFile(path.join(tmpDir, 'locks', 'art.lock'), '', 'utf8');
      // Non-vacuity witnesses: real content the capture MUST keep.
      await writeFile(path.join(repo.path, 'src.ts'), 'export const s = 1;\n', 'utf8');
      await writeFile(path.join(repo.path, '.orcaops', 'install.json'), '{}\n', 'utf8');

      const result = await captureCheckpointSnapshot({
        repo: new Repo(repo.path),
        artifactId: ART,
        checkpointN: 1,
        phase: 'open',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const paths = await lsTreePaths(repo.path, result.tree_sha);
      expect(paths.filter((p) => p.startsWith('.orcaops/tmp/'))).toEqual([]);
      expect(paths.filter((p) => /(^|\/)snap-[^/]*\.index$/.test(p))).toEqual([]);
      expect(paths.filter((p) => p.endsWith('.index'))).toEqual([]);
      expect(paths.filter((p) => p.endsWith('.index.lock'))).toEqual([]);
      // Scope sanity — the tree is real, so the emptiness above means something.
      expect(paths).toContain('src.ts');
      expect(paths).toContain('.orcaops/install.json');
    });
  }
});

describe('captureWorktreeTree — private temp directory lifecycle', () => {
  let repo: TempRepo;
  let privateTmp: string;
  let originalTmpdir: string | undefined;

  beforeEach(async () => {
    // Repo FIRST: createTempRepo also allocates under os.tmpdir(), and it must
    // not land inside the directory these tests assert about.
    repo = await createTempRepo({ initialBranch: 'main' });
    privateTmp = await mkdtemp(path.join(tmpdir(), 'orcaops-snapdir-test-'));
    originalTmpdir = process.env.TMPDIR;
    // allocateTempIndex mkdtemps under os.tmpdir(), which Node re-resolves
    // from TMPDIR on every call — so this redirects the captures' private
    // directories into a directory the test owns and can enumerate exactly.
    process.env.TMPDIR = privateTmp;
  });

  afterEach(async () => {
    // Restore FIRST so a failed assertion cannot poison later tests in the worker.
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    await rm(privateTmp, { recursive: true, force: true });
    await repo.cleanup();
  });

  it('removes the private directory when the capture FAILS after allocation', async () => {
    // Force a failure at step 8 (`git add -A`), which runs after the temp
    // directory is allocated: a REQUIRED clean filter that always exits
    // non-zero makes git abort the add rather than fall back to raw content.
    // (The suite's `update-index --index-info` merge-conflict trick is no
    // help here — an unmerged index does not fail capture at all.)
    await writeFile(path.join(repo.path, '.gitattributes'), '* filter=explode\n', 'utf8');
    const cleanCfg = await runGit(repo.path, ['config', 'filter.explode.clean', 'false']);
    const requiredCfg = await runGit(repo.path, ['config', 'filter.explode.required', 'true']);
    expect(cleanCfg.code).toBe(0);
    expect(requiredCfg.code).toBe(0);

    const { result, observed } = await withSnapTempWatch(privateTmp, () =>
      captureWorktreeTree(new Repo(repo.path), `${ART}/1/open`)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error_message).toBe('string');
    expect((result.error_message ?? '').length).toBeGreaterThan(0);

    // A directory WAS allocated (so the next assertion is not vacuous) …
    expect(observed.length).toBe(1);
    // … and the failure path still tore it down.
    expect(await snapTempDirs(privateTmp)).toEqual([]);
    await expect(stat(path.join(privateTmp, observed[0]))).rejects.toThrow();
  });

  it('is unaffected by an abandoned orcaops-snap-* directory leaked by an earlier run', async () => {
    const leaked = path.join(privateTmp, 'orcaops-snap-LEAKED');
    await mkdir(leaked, { recursive: true });
    await writeFile(path.join(leaked, 'snap-abandoned.index'), 'garbage\n', 'utf8');
    await writeFile(path.join(repo.path, 'work.ts'), 'export const w = 1;\n', 'utf8');

    const result = await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await lsTreePaths(repo.path, result.tree_sha)).toContain('work.ts');

    // Teardown removes EXACTLY the capture's own directory — a sibling's dir
    // (here a leak, in production a concurrent capture) is never touched, and
    // the leak never leaks back into the capture.
    expect(await snapTempDirs(privateTmp)).toEqual(['orcaops-snap-LEAKED']);
    expect(await readdir(leaked)).toEqual(['snap-abandoned.index']);
  });

  it('snapshot data outlives the private directory: ref, commit, tree and file contents survive teardown', async () => {
    await writeFile(path.join(repo.path, 'durable.ts'), 'export const d = 42;\n', 'utf8');
    await mkdir(path.join(repo.path, 'nested'), { recursive: true });
    await writeFile(path.join(repo.path, 'nested', 'deep.txt'), 'deep content\n', 'utf8');

    const { result, observed } = await withSnapTempWatch(privateTmp, () =>
      captureCheckpointSnapshot({
        repo: new Repo(repo.path),
        artifactId: ART,
        checkpointN: 1,
        phase: 'close',
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The private directory existed during the capture and is gone now …
    expect(observed.length).toBe(1);
    expect(await snapTempDirs(privateTmp)).toEqual([]);
    // … and nothing the snapshot needs may live under the OS temp root at
    // all, so remove the whole thing before reading anything back. (Recreated
    // empty only so TMPDIR keeps pointing somewhere valid for the git reads.)
    await rm(privateTmp, { recursive: true, force: true });
    await mkdir(privateTmp, { recursive: true });

    // 1. The ref still resolves, to the same commit.
    const revParse = await runGit(repo.path, ['rev-parse', result.ref]);
    expect(revParse.code).toBe(0);
    expect(revParse.stdout.toString('utf8').trim()).toBe(result.commit_sha);

    // 2. The commit and tree objects still resolve, and the commit points at
    //    the returned tree.
    const commitType = await runGit(repo.path, ['cat-file', '-t', result.commit_sha]);
    expect(commitType.code).toBe(0);
    expect(commitType.stdout.toString('utf8').trim()).toBe('commit');
    const treeType = await runGit(repo.path, ['cat-file', '-t', result.tree_sha]);
    expect(treeType.code).toBe(0);
    expect(treeType.stdout.toString('utf8').trim()).toBe('tree');
    const commitTreeSha = await runGit(repo.path, ['rev-parse', `${result.commit_sha}^{tree}`]);
    expect(commitTreeSha.code).toBe(0);
    expect(commitTreeSha.stdout.toString('utf8').trim()).toBe(result.tree_sha);
    expect(await catFileCommit(repo.path, result.commit_sha)).toContain(
      `orcaops snapshot ${ART}/1/close`
    );

    // 3. The tree is readable and the captured file CONTENTS still come back.
    const paths = await lsTreePaths(repo.path, result.tree_sha);
    expect(paths).toContain('durable.ts');
    expect(paths).toContain('nested/deep.txt');
    expect(await showAtTree(repo.path, result.tree_sha, 'durable.ts')).toBe(
      'export const d = 42;\n'
    );
    expect(await showAtTree(repo.path, result.tree_sha, 'nested/deep.txt')).toBe('deep content\n');
  });

  it('runs 10 parallel captures, each in its OWN private directory, leaving none behind', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'parallel-test\n', 'utf8');

    const repoObj = new Repo(repo.path);
    const tuples: Array<{ n: number; phase: SnapshotPhase }> = [];
    for (let n = 1; n <= 5; n++) {
      tuples.push({ n, phase: 'open' });
      tuples.push({ n, phase: 'close' });
    }

    const { result: results, observed } = await withSnapTempWatch(privateTmp, () =>
      Promise.all(
        tuples.map((t) =>
          captureCheckpointSnapshot({
            repo: repoObj,
            artifactId: ART,
            checkpointN: t.n,
            phase: t.phase,
          })
        )
      )
    );

    const refs = new Set<string>();
    const trees = new Set<string>();
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      refs.add(r.ref);
      trees.add(r.tree_sha);
    }
    expect(refs.size).toBe(tuples.length);
    // One unchanging worktree ⇒ one tree. Divergence here would mean captures
    // saw each other's temp state.
    expect(trees.size).toBe(1);

    // ONE private directory per capture, all distinct (they are distinct by
    // construction of the Set), and every one of them torn down.
    expect(observed.length).toBe(tuples.length);
    expect(await snapTempDirs(privateTmp)).toEqual([]);
  });
});

// ── diffSnapshotTrees ──────────────────────────────────────────────

/**
 * Helper: write `content` to `<repoPath>/<file>`, stage + commit it,
 * and return the resulting HEAD tree SHA. Used to set up paired trees
 * for diff tests without depending on captureCheckpointSnapshot.
 */
async function commitTree(
  repoPath: string,
  file: string,
  content: string,
  msg: string
): Promise<string> {
  await writeFile(path.join(repoPath, file), content, 'utf8');
  const git = gitClient(repoPath);
  await git.add(file);
  await git.commit(msg, { '--allow-empty': null });
  const r = await runGit(repoPath, ['rev-parse', 'HEAD^{tree}']);
  expect(r.code).toBe(0);
  return r.stdout.toString('utf8').trim();
}

describe('diffSnapshotTrees', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns ok:true, truncated:false, with stdout bytes for a real diff under the cap', async () => {
    const treeA = await commitTree(repo.path, 'a.txt', 'one\ntwo\nthree\n', 'add a');
    const treeB = await commitTree(repo.path, 'a.txt', 'one\nTWO\nthree\nfour\n', 'modify a');

    const result = await diffSnapshotTrees({
      repo: new Repo(repo.path),
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: 10 * 1024 * 1024,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(false);
    expect(result.byte_count).toBeGreaterThan(0);
    expect(result.byte_count).toBe(result.diff.length);
    // The diff bytes should contain unified-diff markers for our change.
    const text = Buffer.from(result.diff).toString('utf8');
    expect(text).toMatch(/^diff --git/m);
    expect(text).toMatch(/-two/);
    expect(text).toMatch(/\+TWO/);
    expect(text).toMatch(/\+four/);
  });

  it('returns ok:true, truncated:false, byte_count:0 for identical trees', async () => {
    const tree = await commitTree(repo.path, 'a.txt', 'same\n', 'add a');

    const result = await diffSnapshotTrees({
      repo: new Repo(repo.path),
      openTreeSha: tree,
      closeTreeSha: tree,
      maxDiffBytes: 1024,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(false);
    expect(result.byte_count).toBe(0);
    expect(result.diff.length).toBe(0);
  });

  it('cap-triggered SIGTERM surfaces as ok:true, truncated:true (NOT git_diff_failed)', async () => {
    // Build a sizable diff: a 200 KB blob of unique lines becomes a 200 KB
    // unified-diff body (every line is an add). A 256-byte cap is tiny
    // relative to that, so the child will be killed by our cap logic.
    const lines: string[] = [];
    for (let i = 0; i < 8000; i++) {
      lines.push(`line-${i}-${'x'.repeat(20)}`);
    }
    const big = lines.join('\n') + '\n';
    const treeA = await commitTree(repo.path, 'big.txt', '', 'add empty big');
    const treeB = await commitTree(repo.path, 'big.txt', big, 'add big content');

    const CAP = 256;
    const result = await diffSnapshotTrees({
      repo: new Repo(repo.path),
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: CAP,
    });

    // Critical regression guard: cap-kill MUST surface as ok:true, NOT
    // ok:false git_diff_failed. The whole point of the
    // killedByCap-before-exit-code rule is that storage
    // can build a partial manifest from the truncated bytes
    // instead of recording a 'skipped' projection.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.byte_count).toBe(CAP);
    expect(result.diff.length).toBe(CAP);
  });

  it('returns ok:false git_diff_failed when one of the tree SHAs is invalid', async () => {
    const realTree = await commitTree(repo.path, 'a.txt', 'one\n', 'add a');

    // A 40-hex SHA that does not exist in the object database. Git will
    // exit non-zero with "fatal: bad object" / "ambiguous argument".
    const fakeSha = 'a'.repeat(40);

    const result = await diffSnapshotTrees({
      repo: new Repo(repo.path),
      openTreeSha: realTree,
      closeTreeSha: fakeSha,
      maxDiffBytes: 1024 * 1024,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('git_diff_failed');
  });

  it('works when Repo points at a subdirectory of the repo', async () => {
    // Like captureCheckpointSnapshot, diffSnapshotTrees should not care
    // whether Repo.cwd is the toplevel or a subdir — `git diff` against
    // tree SHAs is content-addressed and finds the repo upward.
    const treeA = await commitTree(repo.path, 'a.txt', 'one\n', 'add a');
    const treeB = await commitTree(repo.path, 'a.txt', 'two\n', 'modify a');
    const subDir = path.join(repo.path, 'subdir');
    await mkdir(subDir, { recursive: true });

    const result = await diffSnapshotTrees({
      repo: new Repo(subDir),
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: 10 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byte_count).toBeGreaterThan(0);
  });

  it('pathspecs scope the diff to declared files and collapse unrelated churn to empty', async () => {
    // treeA → treeB changes BOTH a.txt and b.txt; c.txt is unchanged.
    await commitTree(repo.path, 'a.txt', 'A1\n', 'a1');
    await commitTree(repo.path, 'b.txt', 'B1\n', 'b1');
    const treeA = await commitTree(repo.path, 'c.txt', 'C1\n', 'c1');
    await commitTree(repo.path, 'a.txt', 'A2\n', 'a2');
    const treeB = await commitTree(repo.path, 'b.txt', 'B2\n', 'b2');
    const repoObj = new Repo(repo.path);

    // Unscoped: both changed files appear.
    const full = await diffSnapshotTrees({
      repo: repoObj,
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: 1024 * 1024,
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const fullText = Buffer.from(full.diff).toString('utf8');
    expect(fullText).toMatch(/a\.txt/);
    expect(fullText).toMatch(/b\.txt/);

    // Scoped to [a.txt]: only a.txt; b.txt's churn is excluded.
    const scoped = await diffSnapshotTrees({
      repo: repoObj,
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: 1024 * 1024,
      pathspecs: ['a.txt'],
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    const scopedText = Buffer.from(scoped.diff).toString('utf8');
    expect(scopedText).toMatch(/a\.txt/);
    expect(scopedText).not.toMatch(/b\.txt/);

    // Scoped to [c.txt] (unchanged across the window): collapses to EMPTY —
    // the case where the declared files didn't participate in the churn.
    const empty = await diffSnapshotTrees({
      repo: repoObj,
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: 1024 * 1024,
      pathspecs: ['c.txt'],
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.byte_count).toBe(0);
    expect(empty.diff.length).toBe(0);
  });

  it('a new-path-only pathspec renders an old→new rename as an add (accepted degradation)', async () => {
    const treeA = await commitTree(repo.path, 'old.txt', 'shared content\nline two\n', 'add old');
    // Rename old.txt → new.txt (content identical) and commit → treeB.
    const git = gitClient(repo.path);
    await git.mv('old.txt', 'new.txt');
    await git.commit('rename old to new');
    const tb = await runGit(repo.path, ['rev-parse', 'HEAD^{tree}']);
    expect(tb.code).toBe(0);
    const treeB = tb.stdout.toString('utf8').trim();
    const repoObj = new Repo(repo.path);

    // Unscoped + --find-renames detects the rename pair.
    const full = await diffSnapshotTrees({
      repo: repoObj,
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: 1024 * 1024,
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const fullText = Buffer.from(full.diff).toString('utf8');
    expect(fullText).toMatch(/rename from old\.txt/);
    expect(fullText).toMatch(/rename to new\.txt/);

    // Scoped to ONLY the new path: the old.txt deletion is filtered out, so
    // --find-renames cannot pair it → the rename renders as an ADD of new.txt
    // (content lines prefixed with +), with no rename detected. This is the
    // documented best-effort degradation of scoped recovery.
    const scoped = await diffSnapshotTrees({
      repo: repoObj,
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: 1024 * 1024,
      pathspecs: ['new.txt'],
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    const scopedText = Buffer.from(scoped.diff).toString('utf8');
    expect(scopedText).not.toMatch(/rename from/);
    expect(scopedText).toMatch(/new\.txt/);
    expect(scopedText).toMatch(/\+shared content/);
  });

  it('treats glob-looking pathspecs LITERALLY: "*.txt" matches no real file → empty scoped diff', async () => {
    // `pathspecs` is untrusted agent input (files_changed). Without
    // GIT_LITERAL_PATHSPECS a glob-looking name ("*.txt") expands to EVERY .txt
    // file — widening a scoped recovery diff far beyond the named files (or a
    // `:(exclude)…` magic prefix could erase it). With literal pathspecs, "*.txt"
    // matches only a file LITERALLY named "*.txt" (none here) → empty.
    await commitTree(repo.path, 'a.txt', 'a-one\n', 'add a');
    const treeA = await commitTree(repo.path, 'b.txt', 'b-one\n', 'add b');
    await commitTree(repo.path, 'a.txt', 'a-two\n', 'edit a');
    const treeB = await commitTree(repo.path, 'b.txt', 'b-two\n', 'edit b');
    const repoObj = new Repo(repo.path);

    // Both a.txt and b.txt changed between treeA and treeB; a glob would scope
    // to both. Literal "*.txt" matches neither → no diff.
    const glob = await diffSnapshotTrees({
      repo: repoObj,
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: 1024 * 1024,
      pathspecs: ['*.txt'],
    });
    expect(glob.ok).toBe(true);
    if (!glob.ok) return;
    expect(glob.byte_count).toBe(0);
    expect(glob.diff.length).toBe(0);

    // Control: a literal real path still scopes correctly and does NOT pull in
    // the sibling — proving the env didn't break ordinary scoping.
    const literal = await diffSnapshotTrees({
      repo: repoObj,
      openTreeSha: treeA,
      closeTreeSha: treeB,
      maxDiffBytes: 1024 * 1024,
      pathspecs: ['a.txt'],
    });
    expect(literal.ok).toBe(true);
    if (!literal.ok) return;
    const literalText = Buffer.from(literal.diff).toString('utf8');
    expect(literalText).toMatch(/a\.txt/);
    expect(literalText).not.toMatch(/b\.txt/);
  });
});

// ── listSnapshotRefs / pruneSnapshotRefs ───────────────────────────

describe('listSnapshotRefs', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns [] for a repo with no snapshot refs', async () => {
    const r = await listSnapshotRefs(new Repo(repo.path));
    expect(r).toEqual([]);
  });

  it('returns parsed entries sorted by (artifact_id, n, phase)', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    // Pin refs in deliberate out-of-order order to assert the sort.
    const artA = '019e293d-aaaa-7000-8000-000000000001';
    const artB = '019e293d-bbbb-7000-8000-000000000002';
    for (const cap of [
      { art: artB, n: 2, phase: 'close' as SnapshotPhase },
      { art: artA, n: 1, phase: 'close' as SnapshotPhase },
      { art: artA, n: 1, phase: 'open' as SnapshotPhase },
      { art: artB, n: 1, phase: 'open' as SnapshotPhase },
    ]) {
      const r = await captureCheckpointSnapshot({
        repo: repoObj,
        artifactId: cap.art,
        checkpointN: cap.n,
        phase: cap.phase,
      });
      expect(r.ok).toBe(true);
    }

    const refs = await listSnapshotRefs(repoObj);
    expect(refs.map((r) => `${r.artifact_id}/${r.n}/${r.phase}`)).toEqual([
      `${artA}/1/open`,
      `${artA}/1/close`,
      `${artB}/1/open`,
      `${artB}/2/close`,
    ]);
    // Every entry must carry a 40-or-64-char hex commit SHA.
    for (const e of refs) {
      expect(e.commit_sha).toMatch(/^[0-9a-f]{40,64}$/);
      expect(e.ref).toBe(`${SNAPSHOT_REF_PREFIX}/${e.artifact_id}/${e.n}/${e.phase}`);
    }
  });

  it('filters by artifactId when filter.artifactId is provided', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    const artA = '019e293d-aaaa-7000-8000-000000000001';
    const artB = '019e293d-bbbb-7000-8000-000000000002';
    for (const cap of [
      { art: artA, n: 1, phase: 'open' as SnapshotPhase },
      { art: artA, n: 1, phase: 'close' as SnapshotPhase },
      { art: artB, n: 1, phase: 'open' as SnapshotPhase },
    ]) {
      await captureCheckpointSnapshot({
        repo: repoObj,
        artifactId: cap.art,
        checkpointN: cap.n,
        phase: cap.phase,
      });
    }

    const onlyA = await listSnapshotRefs(repoObj, { artifactId: artA });
    expect(onlyA).toHaveLength(2);
    expect(onlyA.every((e) => e.artifact_id === artA)).toBe(true);

    const onlyB = await listSnapshotRefs(repoObj, { artifactId: artB });
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0].artifact_id).toBe(artB);

    const noMatch = await listSnapshotRefs(repoObj, { artifactId: 'nobody' });
    expect(noMatch).toEqual([]);
  });

  it('silently skips refs in refs/orcaops/snap/* that do not match the namespace shape', async () => {
    // Pre-create a malformed ref directly under the namespace (no
    // <artifact>/<n>/<phase> components — just a stray ref). The
    // listing should skip it rather than crash.
    const refDir = path.join(repo.path, '.git', 'refs', 'orcaops', 'snap');
    await mkdir(refDir, { recursive: true });
    // Need a real commit SHA to point at. Use HEAD.
    const head = await new Repo(repo.path).getHeadSha();
    await writeFile(path.join(refDir, 'malformed-stray'), head + '\n', 'utf8');

    // Also pin one well-formed ref.
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    await captureCheckpointSnapshot({
      repo: new Repo(repo.path),
      artifactId: 'art-x',
      checkpointN: 1,
      phase: 'open',
    });

    const refs = await listSnapshotRefs(new Repo(repo.path));
    // Only the well-formed ref should appear.
    expect(refs).toHaveLength(1);
    expect(refs[0].artifact_id).toBe('art-x');
  });
});

describe('pruneSnapshotRefs', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns deleted:0 for empty input without calling git', async () => {
    const r = await pruneSnapshotRefs(new Repo(repo.path), []);
    expect(r).toEqual({ deleted: 0, refs: [] });
  });

  it('deletes exactly the requested refs (single-ref direct form)', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    const cap = await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(cap.ok).toBe(true);
    if (!cap.ok) return;

    const result = await pruneSnapshotRefs(repoObj, [cap.ref]);
    expect(result.deleted).toBe(1);
    expect(result.refs).toEqual([cap.ref]);

    const remaining = await listSnapshotRefs(repoObj);
    expect(remaining).toEqual([]);
  });

  it('deletes a subset of refs (multi-ref --stdin batch form) and leaves others', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    const caps: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const c = await captureCheckpointSnapshot({
        repo: repoObj,
        artifactId: ART,
        checkpointN: n,
        phase: 'open',
      });
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      caps.push(c.ref);
    }

    // Delete the first and third refs; the second must remain.
    const result = await pruneSnapshotRefs(repoObj, [caps[0], caps[2]]);
    expect(result.deleted).toBe(2);
    expect(new Set(result.refs)).toEqual(new Set([caps[0], caps[2]]));

    const remaining = await listSnapshotRefs(repoObj);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ref).toBe(caps[1]);
  });

  it('refuses refs outside the refs/orcaops/snap/ namespace (typed throw, no deletions)', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    // A live ref that should NOT be deleted by us.
    const cap = await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(cap.ok).toBe(true);

    await expect(pruneSnapshotRefs(repoObj, ['refs/heads/main'])).rejects.toThrow(
      /refusing to delete ref outside refs\/orcaops\/snap/
    );

    // refs/heads/main and our snapshot ref both still exist.
    const fer = await runGit(repo.path, ['for-each-ref', '--format=%(refname)']);
    expect(fer.code).toBe(0);
    const live = fer.stdout.toString('utf8');
    expect(live).toMatch(/^refs\/heads\/main$/m);
    expect(live).toMatch(new RegExp(`^${SNAPSHOT_REF_PREFIX}/${ART}/1/open$`, 'm'));
  });

  it('refuses refs that fail git check-ref-format (typed throw, no deletions)', async () => {
    // A ref with consecutive slashes and a leading dot — both forbidden
    // by check-ref-format. Starts with the right prefix to clear the
    // namespace check, so this exercises the check-ref-format gate.
    const bad = `${SNAPSHOT_REF_PREFIX}/.bad-art/1/open`;
    await expect(pruneSnapshotRefs(new Repo(repo.path), [bad])).rejects.toThrow(/invalid ref name/);
  });

  it('tolerates a list containing refs that no longer exist (filters before delete)', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    const cap = await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    expect(cap.ok).toBe(true);
    if (!cap.ok) return;

    // Mix one real ref with one that doesn't exist. Both are well-formed
    // ref names in our namespace; the non-existent one is just absent
    // from for-each-ref output, so the prefilter drops it.
    const ghost = `${SNAPSHOT_REF_PREFIX}/${ART}/99/open`;
    const result = await pruneSnapshotRefs(repoObj, [cap.ref, ghost]);
    expect(result.deleted).toBe(1);
    expect(result.refs).toEqual([cap.ref]);
  });

  it('compare-and-delete removes an unchanged ref set in one transaction', async () => {
    const repoObj = new Repo(repo.path);
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 2,
      phase: 'close',
    });
    const identities = await listRawSnapshotRefIdentities(repoObj, { artifactId: ART });

    await expect(pruneSnapshotRefsIfUnchanged(repoObj, identities)).resolves.toEqual({
      deleted: 2,
      refs: identities.map((entry) => entry.ref),
    });
    expect(await listRawSnapshotRefIdentities(repoObj, { artifactId: ART })).toEqual([]);
  });

  it('compare-and-delete preserves every ref when one OID changed after inventory', async () => {
    const repoObj = new Repo(repo.path);
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 2,
      phase: 'close',
    });
    const identities = await listRawSnapshotRefIdentities(repoObj, { artifactId: ART });
    const replacement = await repoObj.getHeadSha();
    const changed = identities[0];
    const unchanged = identities[1];
    const update = await runGit(repo.path, ['update-ref', changed.ref, replacement]);
    expect(update.code).toBe(0);

    await expect(pruneSnapshotRefsIfUnchanged(repoObj, identities)).rejects.toThrow(
      /compare-and-delete failed/u
    );
    const after = await listRawSnapshotRefIdentities(repoObj, { artifactId: ART });
    expect(after).toContainEqual({ ref: changed.ref, object_id: replacement });
    expect(after).toContainEqual(unchanged);
  });
});

// ── collectPrunableRefsForArtifact (selective set) ──────────

describe('collectPrunableRefsForArtifact', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const ref = (n: number, phase: SnapshotPhase): string =>
    `${SNAPSHOT_REF_PREFIX}/${ART}/${n}/${phase}`;

  // Minimal Checkpoint fixtures — the selector only reads `n`, `status`,
  // and (closed) `diff_fingerprint_summary.manifest_hash`. Mirrors the
  // `as unknown as Checkpoint` partial-fixture pattern in hash.test.ts.
  type FpStatus = 'captured' | 'empty' | 'truncated' | 'skipped';
  const closedCp = (n: number, fp: FpStatus): Checkpoint => {
    const landed = fp !== 'skipped';
    return {
      artifact_id: ART,
      n,
      status: 'closed',
      diff_fingerprint_summary: {
        status: fp,
        hunk_count: 0,
        captured_hunk_count: 0,
        truncated: fp === 'truncated',
        fingerprint_algorithm: landed ? 'blake3-xof-96-base64url-nopad-v2' : null,
        manifest_hash: landed ? `mh-${n}` : null,
        manifest_hash_algorithm: landed ? 'blake3-xof-256-jcs-rfc8785-base64url-nopad-v1' : null,
        error_reason: null,
      },
    } as unknown as Checkpoint;
  };
  const simpleCp = (n: number, status: 'abandoned' | 'open'): Checkpoint =>
    ({ artifact_id: ART, n, status }) as unknown as Checkpoint;

  async function pin(repoObj: Repo, n: number, phase: SnapshotPhase): Promise<void> {
    const r = await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: n,
      phase,
    });
    expect(r.ok).toBe(true);
  }

  it('returns [] when the artifact has no refs', async () => {
    const r = await collectPrunableRefsForArtifact(new Repo(repo.path), ART, {
      checkpoints: [closedCp(1, 'captured')],
    });
    expect(r).toEqual([]);
  });

  it('selects open+close for a captured closed cp (manifest landed)', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    await pin(repoObj, 1, 'open');
    await pin(repoObj, 1, 'close');
    const r = await collectPrunableRefsForArtifact(repoObj, ART, {
      checkpoints: [closedCp(1, 'captured')],
    });
    expect(r).toEqual([ref(1, 'close'), ref(1, 'open')].sort());
  });

  it('treats empty and truncated closed cps as landed too', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    for (const n of [1, 2]) {
      await pin(repoObj, n, 'open');
      await pin(repoObj, n, 'close');
    }
    const r = await collectPrunableRefsForArtifact(repoObj, ART, {
      checkpoints: [closedCp(1, 'empty'), closedCp(2, 'truncated')],
    });
    expect(r).toEqual([ref(1, 'open'), ref(1, 'close'), ref(2, 'open'), ref(2, 'close')].sort());
  });

  it('keeps ALL refs of a skipped closed cp (re-derivability)', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    await pin(repoObj, 1, 'open');
    await pin(repoObj, 1, 'close');
    const r = await collectPrunableRefsForArtifact(repoObj, ART, {
      checkpoints: [closedCp(1, 'skipped')],
    });
    expect(r).toEqual([]);
  });

  it('keeps BOTH refs of an abandoned cp (salvage viability)', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    await pin(repoObj, 1, 'open');
    await pin(repoObj, 1, 'abandon');
    const r = await collectPrunableRefsForArtifact(repoObj, ART, {
      checkpoints: [simpleCp(1, 'abandoned')],
    });
    // Salvage diffs open→abandon: auto-prune deleting the open ref would
    // strand the abandon tree with nothing to diff against. Total-wipe
    // paths (prune --artifact/--all, gc-on-delete) still remove both.
    expect(r).toEqual([]);
  });

  it('keeps the open ref of an in-flight open cp', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    await pin(repoObj, 1, 'open');
    const r = await collectPrunableRefsForArtifact(repoObj, ART, {
      checkpoints: [simpleCp(1, 'open')],
    });
    expect(r).toEqual([]);
  });

  it('keeps refs whose n is absent from the projected checkpoints (defensive)', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    await pin(repoObj, 7, 'open');
    await pin(repoObj, 7, 'close');
    const r = await collectPrunableRefsForArtifact(repoObj, ART, {
      checkpoints: [closedCp(1, 'captured')], // no cp for n=7
    });
    expect(r).toEqual([]);
  });

  it('returns the exact selective subset for a mixed artifact', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    await pin(repoObj, 1, 'open');
    await pin(repoObj, 1, 'close'); // captured → both prunable
    await pin(repoObj, 2, 'open');
    await pin(repoObj, 2, 'close'); // skipped → neither
    await pin(repoObj, 3, 'open');
    await pin(repoObj, 3, 'abandon'); // abandoned → neither
    await pin(repoObj, 4, 'open'); // in-flight → none
    const r = await collectPrunableRefsForArtifact(repoObj, ART, {
      checkpoints: [
        closedCp(1, 'captured'),
        closedCp(2, 'skipped'),
        simpleCp(3, 'abandoned'),
        simpleCp(4, 'open'),
      ],
    });
    expect(r).toEqual([ref(1, 'close'), ref(1, 'open')].sort());
  });
});

// ── collectBaselineRefsForArtifact (plan-time baseline prune) ─

describe('collectBaselineRefsForArtifact', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  // Pin a REAL baseline ref so listRawBaselineRefNames returns non-empty —
  // the selector short-circuits to [] when there is no baseline ref, so the
  // keep-vs-prune branches are only reachable with one pinned.
  async function pinBaseline(): Promise<void> {
    await writeFile(path.join(repo.path, 'seed.txt'), 'seed\n', 'utf8');
    const r = await captureBaselineSnapshot(new Repo(repo.path), ART);
    expect(r.ok).toBe(true);
  }

  // Minimal Checkpoint fixtures. The selector reads `n`, `status`, and (for the
  // first finalized closed cp) `files_changed` + `diff_fingerprint_summary.status`
  // — NOT manifest_hash (a fallback empty manifest can carry a non-null hash, so
  // status is the authoritative landed-signal here). Mirrors the
  // `as unknown as Checkpoint` partial-fixture pattern in
  // collectPrunableRefsForArtifact above.
  type FpStatus = 'captured' | 'empty' | 'truncated' | 'skipped';
  const closedCp = (n: number, fp: FpStatus, filesChanged: string[]): Checkpoint =>
    ({
      artifact_id: ART,
      n,
      status: 'closed',
      files_changed: filesChanged,
      diff_fingerprint_summary: {
        status: fp,
        hunk_count: 0,
        captured_hunk_count: 0,
        truncated: fp === 'truncated',
        fingerprint_algorithm: null,
        manifest_hash: fp === 'skipped' ? null : `mh-${n}`,
        manifest_hash_algorithm: null,
        error_reason: null,
      },
    }) as unknown as Checkpoint;
  const simpleCp = (n: number, status: 'abandoned' | 'open'): Checkpoint =>
    ({ artifact_id: ART, n, status }) as unknown as Checkpoint;

  const BASELINE_REF = `${BASELINE_REF_PREFIX}/${ART}`;

  it('returns [] when the artifact has no baseline ref (nothing to prune)', async () => {
    // No pinBaseline() — listRawBaselineRefNames is empty, so even an
    // accounted-for closed cp yields [] (the short-circuit).
    const r = await collectBaselineRefsForArtifact(new Repo(repo.path), ART, {
      checkpoints: [closedCp(1, 'captured', ['src/a.ts'])],
    });
    expect(r).toEqual([]);
  });

  it('KEEPS the baseline when no checkpoint has finalized yet (still needed for first-cp recovery)', async () => {
    await pinBaseline();
    const repoObj = new Repo(repo.path);
    // Only an in-flight open cp → no finalized cp → keep.
    expect(
      await collectBaselineRefsForArtifact(repoObj, ART, { checkpoints: [simpleCp(1, 'open')] })
    ).toEqual([]);
    // And with NO checkpoints at all → keep.
    expect(await collectBaselineRefsForArtifact(repoObj, ART, { checkpoints: [] })).toEqual([]);
  });

  it("KEEPS the baseline when the first finalized cp claimed work but its fingerprint did NOT land (status 'empty')", async () => {
    await pinBaseline();
    // First finalized cp: closed, files_changed non-empty, status 'empty' →
    // the fingerprint is still re-derivable from the baseline → keep. This is
    // the exact empty-fence-recovery-pending case.
    const r = await collectBaselineRefsForArtifact(new Repo(repo.path), ART, {
      checkpoints: [closedCp(1, 'empty', ['src/a.ts'])],
    });
    expect(r).toEqual([]);
  });

  it("KEEPS the baseline when the first finalized cp claimed work but status is 'skipped'", async () => {
    await pinBaseline();
    const r = await collectBaselineRefsForArtifact(new Repo(repo.path), ART, {
      checkpoints: [closedCp(1, 'skipped', ['src/a.ts'])],
    });
    expect(r).toEqual([]);
  });

  it("PRUNES the baseline once the first finalized cp landed a real fingerprint (status 'captured')", async () => {
    await pinBaseline();
    const r = await collectBaselineRefsForArtifact(new Repo(repo.path), ART, {
      checkpoints: [closedCp(1, 'captured', ['src/a.ts'])],
    });
    expect(r).toEqual([BASELINE_REF]);
  });

  it('PRUNES the baseline when the first finalized cp claimed NOTHING (files_changed empty)', async () => {
    await pinBaseline();
    // A verification-only first cp claimed no files → recovery never applied →
    // the baseline has no further use → prune. (Even status 'empty' prunes here,
    // because the files_changed>0 KEEP guard does not match.)
    const r = await collectBaselineRefsForArtifact(new Repo(repo.path), ART, {
      checkpoints: [closedCp(1, 'empty', [])],
    });
    expect(r).toEqual([BASELINE_REF]);
  });

  it('PRUNES the baseline when the first finalized cp was ABANDONED (no diff_fingerprint_summary)', async () => {
    await pinBaseline();
    // The `status === 'closed'` short-circuit in the KEEP guard protects the
    // diff_fingerprint_summary access — an AbandonedCheckpoint has none.
    const r = await collectBaselineRefsForArtifact(new Repo(repo.path), ART, {
      checkpoints: [simpleCp(1, 'abandoned')],
    });
    expect(r).toEqual([BASELINE_REF]);
  });

  it('keys on the FIRST finalized cp (lowest n), ignoring an in-flight open at a higher n', async () => {
    await pinBaseline();
    // n=1 closed+captured (landed) is the first finalized; the later open cp
    // does not change the decision → prune.
    const r = await collectBaselineRefsForArtifact(new Repo(repo.path), ART, {
      checkpoints: [closedCp(1, 'captured', ['src/a.ts']), simpleCp(2, 'open')],
    });
    expect(r).toEqual([BASELINE_REF]);
  });
});

// ── listRawSnapshotRefNames (shared raw-namespace source) ───

describe('listRawSnapshotRefNames', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns [] for a repo with no snapshot refs', async () => {
    expect(await listRawSnapshotRefNames(new Repo(repo.path))).toEqual([]);
  });

  it('returns ALL raw names incl. malformed, sorted (no filter)', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    // Wholly-stray malformed ref directly under the namespace —
    // listSnapshotRefs would silently drop this; the raw lister keeps it.
    const snapDir = path.join(repo.path, '.git', 'refs', 'orcaops', 'snap');
    await mkdir(snapDir, { recursive: true });
    const head = await repoObj.getHeadSha();
    await writeFile(path.join(snapDir, 'malformed-stray'), head + '\n', 'utf8');

    const raw = await listRawSnapshotRefNames(repoObj);
    expect(raw).toEqual(
      [`${SNAPSHOT_REF_PREFIX}/malformed-stray`, `${SNAPSHOT_REF_PREFIX}/${ART}/1/open`].sort()
    );
    // Contrast: the parsed lister drops the stray.
    expect((await listSnapshotRefs(repoObj)).map((e) => e.ref)).toEqual([
      `${SNAPSHOT_REF_PREFIX}/${ART}/1/open`,
    ]);
  });

  it('with { artifactId } prefix-matches incl. a malformed-after-id ref, excludes others', async () => {
    await writeFile(path.join(repo.path, 'work.txt'), 'x\n', 'utf8');
    const repoObj = new Repo(repo.path);
    const other = '019e293d-bbbb-7000-8000-000000000002';
    await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: ART,
      checkpointN: 1,
      phase: 'open',
    });
    await captureCheckpointSnapshot({
      repo: repoObj,
      artifactId: other,
      checkpointN: 1,
      phase: 'open',
    });
    // Malformed-AFTER-id ref under ART (parses to null, but is a valid
    // git ref and belongs to ART by prefix). Wholly-stray excluded.
    const head = await repoObj.getHeadSha();
    const artDir = path.join(repo.path, '.git', 'refs', 'orcaops', 'snap', ART);
    await mkdir(artDir, { recursive: true });
    await writeFile(path.join(artDir, 'garbage'), head + '\n', 'utf8');
    const snapDir = path.join(repo.path, '.git', 'refs', 'orcaops', 'snap');
    await writeFile(path.join(snapDir, 'malformed-stray'), head + '\n', 'utf8');

    const onlyArt = await listRawSnapshotRefNames(repoObj, { artifactId: ART });
    expect(onlyArt).toEqual(
      [`${SNAPSHOT_REF_PREFIX}/${ART}/1/open`, `${SNAPSHOT_REF_PREFIX}/${ART}/garbage`].sort()
    );
    expect(onlyArt).not.toContain(`${SNAPSHOT_REF_PREFIX}/${other}/1/open`);
    expect(onlyArt).not.toContain(`${SNAPSHOT_REF_PREFIX}/malformed-stray`);
  });
});

// ── pinBaselineTree (supersession repin) ──────────────────────
describe('pinBaselineTree', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const ART_SUP = '019e0000-aaaa-7000-8000-000000000001';
  const ART_B = '019e0000-bbbb-7000-8000-000000000002';

  it('repins the baseline ref to an arbitrary tree, keeping it reachable after the original holder is pruned + gc', async () => {
    const repoObj = new Repo(repo.path);
    // Tsup: an UNCOMMITTED worktree tree (NOT reachable via git history), pinned
    // by the superseded artifact's own baseline ref.
    await writeFile(path.join(repo.path, 'pre.txt'), 'pre-work\nstate\n', 'utf8');
    const sup = await captureBaselineSnapshot(repoObj, ART_SUP);
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;
    const tsup = sup.tree_sha;

    // B captures its OWN (different) baseline, then repins it to Tsup.
    await writeFile(path.join(repo.path, 'other.txt'), 'other\n', 'utf8');
    const b = await captureBaselineSnapshot(repoObj, ART_B);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.tree_sha).not.toEqual(tsup);

    const repin = await pinBaselineTree(repoObj, ART_B, tsup);
    expect(repin.ok).toBe(true);
    // B's baseline ref now wraps Tsup.
    const bRefTree = (
      await runGit(repo.path, ['rev-parse', `${baselineRefName(ART_B)}^{tree}`])
    ).stdout
      .toString('utf8')
      .trim();
    expect(bRefTree).toEqual(tsup);

    // Remove the ORIGINAL holder of Tsup (the superseded artifact's baseline ref);
    // Tsup is now held ONLY by B's repinned ref. gc must NOT collect it.
    await pruneBaselineRefs(repoObj, [baselineRefName(ART_SUP)]);
    execFileSync('git', ['gc', '--prune=now'], { cwd: repo.path });
    expect((await runGit(repo.path, ['cat-file', '-e', tsup])).code).toBe(0);
  });

  it('negative control: a baseline tree with no remaining holder IS gc-collected (proves gc is real)', async () => {
    const repoObj = new Repo(repo.path);
    await writeFile(path.join(repo.path, 'lonely.txt'), 'only-in-baseline\n', 'utf8');
    const sup = await captureBaselineSnapshot(repoObj, ART_SUP);
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;
    const tsup = sup.tree_sha;
    // Remove the sole holder + gc → Tsup is unreachable and collected.
    await pruneBaselineRefs(repoObj, [baselineRefName(ART_SUP)]);
    execFileSync('git', ['gc', '--prune=now'], { cwd: repo.path });
    expect((await runGit(repo.path, ['cat-file', '-e', tsup])).code).not.toBe(0);
  });
});

// ── capture.exclude ───────

describe('captureWorktreeTree — capture.exclude', () => {
  let repo: TempRepo;

  const EXCLUDES = ['**/.env', '**/.env.*', '**/id_rsa*'];

  const treeEntries = async (treeSha: string): Promise<string[]> =>
    execFileSync('git', ['ls-tree', '-r', '--name-only', treeSha], { cwd: repo.path })
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .sort();

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeFile(path.join(repo.path, 'src.ts'), 'export const a = 1;\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('src.ts');
    await git.commit('root');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('keeps a matching untracked file out of the tree while its neighbour stays', async () => {
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=x\n', 'utf8');
    await writeFile(path.join(repo.path, 'notes.md'), 'untracked but harmless\n', 'utf8');

    const result = await captureWorktreeTree(new Repo(repo.path), 'excl', {
      skipCommit: true,
      excludePatterns: EXCLUDES,
    });
    expect(result.ok).toBe(true);
    const entries = await treeEntries((result as { tree_sha: string }).tree_sha);
    expect(entries).not.toContain('.env');
    // Scoped, not a blanket drop of everything untracked.
    expect(entries).toContain('notes.md');
    expect(entries).toContain('src.ts');
  });

  it('never writes the excluded blob, so the object store cannot resurrect it', async () => {
    // Step 8's exclude pathspecs, not step 12's scrub, are what this asserts:
    // scrubbing the index entry leaves the object behind, and a snapshot ref is
    // durable. Staging the path first and removing it afterwards would satisfy
    // every tree assertion above while leaving the credential in the store.
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=EXAMPLE0EXAMPLE0\n', 'utf8');

    const result = await captureWorktreeTree(new Repo(repo.path), 'excl-blob', {
      skipCommit: true,
      excludePatterns: EXCLUDES,
    });
    expect(result.ok).toBe(true);
    const blob = execFileSync('git', ['hash-object', '.env'], { cwd: repo.path })
      .toString('utf8')
      .trim();
    expect(() =>
      execFileSync('git', ['cat-file', '-e', blob], { cwd: repo.path, stdio: 'ignore' })
    ).toThrow();
  });

  it('matches at any depth', async () => {
    await mkdir(path.join(repo.path, 'packages/app'), { recursive: true });
    await writeFile(path.join(repo.path, 'packages/app/.env.local'), 'K=v\n', 'utf8');

    const result = await captureWorktreeTree(new Repo(repo.path), 'excl-deep', {
      skipCommit: true,
      excludePatterns: EXCLUDES,
    });
    const entries = await treeEntries((result as { tree_sha: string }).tree_sha);
    expect(entries).not.toContain('packages/app/.env.local');
  });

  it('still captures a TRACKED file matching the same pattern', async () => {
    // Dropping it would forge a permanent phantom deletion in every manifest
    // that follows, and git already carries it regardless.
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=x\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('.env');
    await git.commit('track the env file');

    const result = await captureWorktreeTree(new Repo(repo.path), 'excl-tracked', {
      skipCommit: true,
      excludePatterns: EXCLUDES,
    });
    const entries = await treeEntries((result as { tree_sha: string }).tree_sha);
    expect(entries).toContain('.env');
  });

  it('still captures when a matching path is gitignored', async () => {
    // Why the concrete set is resolved from `ls-files --others
    // --exclude-standard`: an exclude pathspec naming an ignored path makes
    // `git add` fail outright.
    await writeFile(path.join(repo.path, '.gitignore'), '.env\n', 'utf8');
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=x\n', 'utf8');

    const result = await captureWorktreeTree(new Repo(repo.path), 'excl-ignored', {
      skipCommit: true,
      excludePatterns: EXCLUDES,
    });
    expect(result.ok).toBe(true);
    const entries = await treeEntries((result as { tree_sha: string }).tree_sha);
    expect(entries).not.toContain('.env');
  });

  it('captures the file when no exclude set is supplied', async () => {
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=x\n', 'utf8');
    const result = await captureWorktreeTree(new Repo(repo.path), 'no-excl', { skipCommit: true });
    const entries = await treeEntries((result as { tree_sha: string }).tree_sha);
    expect(entries).toContain('.env');
  });
});

describe('listSensitiveTreePaths', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeFile(path.join(repo.path, 'src.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(path.join(repo.path, '.env'), 'TOKEN=x\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add(['src.ts', '.env']);
    await git.commit('root with an env file');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports what a checkout would write, without altering the tree', async () => {
    const r = new Repo(repo.path);
    // A tree captured before excludes existed still carries the file.
    const captured = await captureWorktreeTree(r, 'pre-exclude', { skipCommit: true });
    const treeSha = (captured as { tree_sha: string }).tree_sha;

    expect(await listSensitiveTreePaths(r, treeSha, ['**/.env'])).toEqual(['.env']);

    // Disclosure only: the tree is untouched, which is what makes a checkout
    // still mirror the pinned tree exactly.
    const entries = execFileSync('git', ['ls-tree', '-r', '--name-only', treeSha], {
      cwd: repo.path,
    })
      .toString('utf8')
      .split('\n')
      .filter(Boolean);
    expect(entries).toContain('.env');
  });

  it('discloses nothing when no pattern is in effect', async () => {
    const r = new Repo(repo.path);
    const captured = await captureWorktreeTree(r, 'no-patterns', { skipCommit: true });
    expect(
      await listSensitiveTreePaths(r, (captured as { tree_sha: string }).tree_sha, [])
    ).toEqual([]);
  });

  it('fails open on an unresolvable tree rather than blocking a checkout', async () => {
    const r = new Repo(repo.path);
    expect(await listSensitiveTreePaths(r, 'not-a-tree-sha', ['**/.env'])).toEqual([]);
  });
});
