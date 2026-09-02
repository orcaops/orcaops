import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactStore, getDefaultConfig, withNonDerivableWriteLease } from '@orcaops/storage';

import { markAcked, syncToGit } from './session-branch-state.js';
import type { Repo } from '../git/repo.js';

function buildRepo(opts: {
  branch: string;
  head: string;
  /** Branches that should report as still present via `branchExists`. Default: none — every prior branch reads as "deleted," i.e. the rename path. */
  existingBranches?: ReadonlyArray<string>;
}): Repo {
  const present = new Set(opts.existingBranches ?? []);
  return {
    cwd: '/tmp/working-dir',
    getCurrentBranch: vi.fn().mockResolvedValue(opts.branch),
    getHeadSha: vi.fn().mockResolvedValue(opts.head),
    branchExists: vi.fn().mockImplementation(async (name: string) => present.has(name)),
  } as unknown as Repo;
}

function buildDetachedRepo(): Repo {
  return {
    cwd: '/tmp/working-dir',
    // `git rev-parse --abbrev-ref HEAD` returns the literal string "HEAD"
    // when the working tree is in a detached state (rebase / bisect /
    // checkout-by-sha). Without a guard, that string would ship on the
    // wire as the canonical branch.
    getCurrentBranch: vi.fn().mockResolvedValue('HEAD'),
    getHeadSha: vi.fn().mockResolvedValue('sha-detached'),
    branchExists: vi.fn().mockResolvedValue(false),
  } as unknown as Repo;
}

function buildThrowingRepo(opts: { throwOn: 'getCurrentBranch' | 'getHeadSha' }): Repo {
  return {
    cwd: '/tmp/working-dir',
    getCurrentBranch:
      opts.throwOn === 'getCurrentBranch'
        ? vi.fn().mockRejectedValue(new Error('not a git repository'))
        : vi.fn().mockResolvedValue('feat-x'),
    getHeadSha:
      opts.throwOn === 'getHeadSha'
        ? vi.fn().mockRejectedValue(new Error('does not have any commits yet'))
        : vi.fn().mockResolvedValue('sha-x'),
    branchExists: vi.fn().mockResolvedValue(false),
  } as unknown as Repo;
}

describe('session-branch-state', () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-session-'));
    store = new ArtifactStore({ repoRoot: dir, config: getDefaultConfig() });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('syncToGit', () => {
    it('seeds first-sight state with empty branchHistory and pinned base SHA', async () => {
      const repo = buildRepo({ branch: 'feat-x', head: 'sha-base' });
      const state = await syncToGit({
        repo,
        store,
        repoUrl: 'git@example:repo.git',
        workingDir: '/tmp/working-dir',
      });
      expect(state).not.toBeNull();
      expect(state!.currentBranch).toBe('feat-x');
      expect(state!.branchHistory).toEqual([]);
      expect(state!.baseCommitSha).toBe('sha-base');
      expect(state!.lastAckedAt).toBeNull();
    });

    it('does not commit a queued session write after its operation is aborted', async () => {
      let releaseHolder!: () => void;
      let holderEntered!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        holderEntered = resolve;
      });
      const holder = withNonDerivableWriteLease(dir, async () => {
        holderEntered();
        await held;
      });
      await entered;
      const abort = new AbortController();
      const pending = syncToGit({
        repo: buildRepo({ branch: 'feat-x', head: 'sha-base' }),
        store,
        repoUrl: 'git@example:repo.git',
        workingDir: '/tmp/working-dir',
        signal: abort.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      abort.abort(new Error('eager deadline reached'));
      releaseHolder();

      await expect(pending).rejects.toThrow('eager deadline reached');
      await holder;
      expect(
        store.store.getSessionBranchState('git@example:repo.git', '/tmp/working-dir')
      ).toBeNull();
    });

    it('returns the stored state unchanged when branch has not changed', async () => {
      const repo = buildRepo({ branch: 'feat-x', head: 'sha-1' });
      await syncToGit({
        repo,
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });

      const repo2 = buildRepo({ branch: 'feat-x', head: 'sha-2' }); // HEAD advanced
      const state = await syncToGit({
        repo: repo2,
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).not.toBeNull();
      expect(state!.branchHistory).toEqual([]);
      // base_commit_sha pins to first-sight HEAD; HEAD advancing doesn't reset it.
      expect(state!.baseCommitSha).toBe('sha-1');
    });

    it('falls back to current HEAD when a stored row carries null baseCommitSha and the branch changed', async () => {
      // Pre-populate a partially restored row with base_commit_sha = null.
      // syncToGit's `existing.baseCommitSha ?? headSha` fallback should fire
      // on the rename path.
      store.store.upsertSessionBranchState({
        repoUrl: 'r',
        workingDir: '/tmp/wd',
        currentBranch: 'old',
        branchHistory: [],
        baseCommitSha: null,
      });
      const state = await syncToGit({
        repo: buildRepo({ branch: 'new', head: 'sha-fresh' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).not.toBeNull();
      expect(state!.currentBranch).toBe('new');
      expect(state!.branchHistory).toEqual(['old']);
      // The fallback re-anchored base to current HEAD.
      expect(state!.baseCommitSha).toBe('sha-fresh');
    });

    it('preserves a non-null baseCommitSha across renames (does not re-anchor)', async () => {
      store.store.upsertSessionBranchState({
        repoUrl: 'r',
        workingDir: '/tmp/wd',
        currentBranch: 'old',
        branchHistory: [],
        baseCommitSha: 'sha-original',
      });
      const state = await syncToGit({
        repo: buildRepo({ branch: 'new', head: 'sha-fresh' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).not.toBeNull();
      expect(state!.baseCommitSha).toBe('sha-original');
    });

    it('appends prior branch to history on local rename', async () => {
      const repo1 = buildRepo({ branch: 'feat-x', head: 'sha-1' });
      await syncToGit({ repo: repo1, store, repoUrl: 'r', workingDir: '/tmp/wd' });

      const repo2 = buildRepo({ branch: 'PROJ-feat-x', head: 'sha-1' });
      const state = await syncToGit({
        repo: repo2,
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).not.toBeNull();
      expect(state!.currentBranch).toBe('PROJ-feat-x');
      expect(state!.branchHistory).toEqual(['feat-x']);
      expect(state!.baseCommitSha).toBe('sha-1');
    });

    it('handles chained renames — accumulates each prior name into history', async () => {
      // A → B → C, all observed via separate syncs (e.g., between offline pushes)
      await syncToGit({
        repo: buildRepo({ branch: 'A', head: 'sha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      await syncToGit({
        repo: buildRepo({ branch: 'B', head: 'sha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      const state = await syncToGit({
        repo: buildRepo({ branch: 'C', head: 'sha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).not.toBeNull();
      expect(state!.currentBranch).toBe('C');
      expect(state!.branchHistory).toEqual(['A', 'B']);
    });

    it('returns null on detached HEAD without persisting a row', async () => {
      const state = await syncToGit({
        repo: buildDetachedRepo(),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).toBeNull();
      // No row written — subsequent invocations on a real branch start clean.
      expect(store.store.getSessionBranchState('r', '/tmp/wd')).toBeNull();
    });

    it('returns null when getCurrentBranch throws (worktree corruption / not a repo)', async () => {
      const state = await syncToGit({
        repo: buildThrowingRepo({ throwOn: 'getCurrentBranch' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).toBeNull();
      expect(store.store.getSessionBranchState('r', '/tmp/wd')).toBeNull();
    });

    it('invokes onError with stage=getCurrentBranch when the git read throws', async () => {
      const onError = vi.fn();
      await syncToGit({
        repo: buildThrowingRepo({ throwOn: 'getCurrentBranch' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
        onError,
      });
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.any(Error), {
        stage: 'getCurrentBranch',
      });
    });

    it('returns null when getHeadSha throws (empty repo, no commits yet)', async () => {
      const state = await syncToGit({
        repo: buildThrowingRepo({ throwOn: 'getHeadSha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).toBeNull();
      expect(store.store.getSessionBranchState('r', '/tmp/wd')).toBeNull();
    });

    it('invokes onError with stage=getHeadSha when the git read throws', async () => {
      const onError = vi.fn();
      await syncToGit({
        repo: buildThrowingRepo({ throwOn: 'getHeadSha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
        onError,
      });
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'getHeadSha' });
    });

    it('does not invoke onError on the happy path', async () => {
      const onError = vi.fn();
      await syncToGit({
        repo: buildRepo({ branch: 'feat-x', head: 'sha-1' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
        onError,
      });
      expect(onError).not.toHaveBeenCalled();
    });

    it('treats branch change as branch-off (not rename) when the prior branch still exists locally', async () => {
      // First push from feat-a. Stored row: currentBranch=feat-a, history=[].
      await syncToGit({
        repo: buildRepo({ branch: 'feat-a', head: 'sha-a' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      // User runs `git checkout -b feat-b feat-a` — both branches exist now.
      // Without the branch-off detection this would look identical to a
      // rename and history would accumulate [feat-a].
      const state = await syncToGit({
        repo: buildRepo({
          branch: 'feat-b',
          head: 'sha-b',
          existingBranches: ['feat-a'],
        }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state?.currentBranch).toBe('feat-b');
      expect(state?.branchHistory).toEqual([]);
      // baseCommitSha resets to the new branch's HEAD — fresh session.
      expect(state?.baseCommitSha).toBe('sha-b');
      // No carryover ack ts; the branch-off is treated as first-sight.
      expect(state?.lastAckedAt).toBeNull();
      // Stored row replaced in place (PK is (repoUrl, workingDir)).
      const stored = store.store.getSessionBranchState('r', '/tmp/wd');
      expect(stored?.currentBranch).toBe('feat-b');
      expect(stored?.branchHistory).toEqual([]);
    });

    it('still threads rename history when the prior branch was removed (true rename)', async () => {
      // A true rename (prior ref gone) threads the prior branch into history.
      await syncToGit({
        repo: buildRepo({ branch: 'feat-a', head: 'sha-a' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      const state = await syncToGit({
        repo: buildRepo({
          branch: 'feat-renamed',
          head: 'sha-a',
          // existingBranches omitted → branchExists returns false for feat-a.
        }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state?.currentBranch).toBe('feat-renamed');
      expect(state?.branchHistory).toEqual(['feat-a']);
    });

    it('keeps each (repo_url, working_dir) pair independent', async () => {
      await syncToGit({
        repo: buildRepo({ branch: 'main', head: 'sha-a' }),
        store,
        repoUrl: 'repo-A',
        workingDir: '/tmp/clone-a',
      });
      await syncToGit({
        repo: buildRepo({ branch: 'feat', head: 'sha-b' }),
        store,
        repoUrl: 'repo-B',
        workingDir: '/tmp/clone-b',
      });

      const stateA = await syncToGit({
        repo: buildRepo({ branch: 'main', head: 'sha-a' }),
        store,
        repoUrl: 'repo-A',
        workingDir: '/tmp/clone-a',
      });
      const stateB = await syncToGit({
        repo: buildRepo({ branch: 'feat', head: 'sha-b' }),
        store,
        repoUrl: 'repo-B',
        workingDir: '/tmp/clone-b',
      });
      expect(stateA).not.toBeNull();
      expect(stateB).not.toBeNull();
      expect(stateA!.currentBranch).toBe('main');
      expect(stateB!.currentBranch).toBe('feat');
    });
  });

  describe('markAcked', () => {
    it('clears the chain after a successful start ack', async () => {
      // Build up a 2-entry chain via two renames.
      await syncToGit({
        repo: buildRepo({ branch: 'A', head: 'sha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      await syncToGit({
        repo: buildRepo({ branch: 'B', head: 'sha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      await syncToGit({
        repo: buildRepo({ branch: 'C', head: 'sha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });

      // Push acked.
      markAcked({ store, repoUrl: 'r', workingDir: '/tmp/wd' });

      // Next sync: history is empty even though current_branch unchanged.
      const state = await syncToGit({
        repo: buildRepo({ branch: 'C', head: 'sha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).not.toBeNull();
      expect(state!.branchHistory).toEqual([]);
      expect(state!.lastAckedAt).not.toBeNull();
    });

    it('a rename after ack starts a fresh chain', async () => {
      await syncToGit({
        repo: buildRepo({ branch: 'A', head: 'sha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      markAcked({ store, repoUrl: 'r', workingDir: '/tmp/wd' });

      const state = await syncToGit({
        repo: buildRepo({ branch: 'B', head: 'sha' }),
        store,
        repoUrl: 'r',
        workingDir: '/tmp/wd',
      });
      expect(state).not.toBeNull();
      expect(state!.currentBranch).toBe('B');
      expect(state!.branchHistory).toEqual(['A']);
    });

    it('is a safe no-op when no row exists yet', () => {
      // No prior syncToGit call. markAcked must not throw.
      expect(() =>
        markAcked({ store, repoUrl: 'r-empty', workingDir: '/tmp/wd-empty' })
      ).not.toThrow();
    });
  });
});
