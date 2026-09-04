import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHistoryRepo,
  createLinkedWorktree,
  createTempRepo,
  gitClient,
  type TempRepo,
} from '@orcaops/test-harness';

import { probeWorktree, Repo } from './repo.js';

describe('Repo.logFirstParentDetailed', () => {
  it('parses roots, bodies, parents, and non-ASCII file names without following merge sides', async () => {
    const history = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: root',
        body: 'A body with\nmultiple lines',
        files: { 'café.txt': 'root\n' },
      },
      { type: 'branch', name: 'feature' },
      { type: 'checkout', branch: 'feature' },
      { type: 'commit', label: 'side', files: { 'side.ts': 'side\n' } },
      { type: 'checkout', branch: 'main' },
      { type: 'commit', label: 'main', files: { 'main.ts': 'main\n' } },
      { type: 'merge', label: 'merge', branch: 'feature', subject: 'Merge feature' },
    ]);
    try {
      const repo = new Repo(history.path);
      const firstParent = await repo.logFirstParentDetailed('main');
      expect(firstParent.map((commit) => commit.sha)).toEqual([
        history.shas.merge,
        history.shas.main,
        history.shas.root,
      ]);
      expect(firstParent.at(-1)).toMatchObject({
        parentShas: [],
        subject: 'feat: root',
        body: 'A body with\nmultiple lines\n',
        files: ['café.txt'],
      });
      expect(firstParent[0]?.parentShas).toHaveLength(2);

      const graph = await repo.logDetailed('main');
      expect(graph.map((commit) => commit.sha)).toContain(history.shas.side);
      expect(graph.find((commit) => commit.sha === history.shas.side)?.files).toEqual(['side.ts']);
    } finally {
      await history.cleanup();
    }
  });
});

describe('Repo.resolveTree', () => {
  it('resolves commit trees and rejects missing refs', async () => {
    const repo = await createTempRepo();
    try {
      const tree = await new Repo(repo.path).resolveTree('HEAD');
      expect(tree).toMatch(/^[0-9a-f]{40}$/u);
      expect(await new Repo(repo.path).resolveTree('missing')).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });
});

describe('Repo.getIndexTreeSha', () => {
  it('tracks the index independently from unstaged worktree edits', async () => {
    const fixture = await createTempRepo();
    try {
      const repo = new Repo(fixture.path);
      const before = await repo.getIndexTreeSha();
      await writeFile(path.join(fixture.path, 'README.md'), '# unstaged\n', 'utf8');
      expect(await repo.getIndexTreeSha()).toBe(before);
      await gitClient(fixture.path).add('README.md');
      expect(await repo.getIndexTreeSha()).not.toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('Repo batched seed plumbing', () => {
  it('pins refs transactionally and resolves trees and bounded diffs in batches', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', files: { 'root.txt': 'root\n' } },
      { type: 'commit', label: 'second', files: { 'second.txt': 'second\n' } },
      { type: 'commit', label: 'third', files: { 'third.txt': 'third\n' } },
    ]);
    try {
      const repo = new Repo(history.path);
      const rootSha = history.shas.root!;
      const secondSha = history.shas.second!;
      const thirdSha = history.shas.third!;
      await repo.updateRefsBatch([
        { ref: 'refs/orcaops/snap/test/1/open', sha: rootSha },
        { ref: 'refs/orcaops/snap/test/1/close', sha: secondSha },
        { ref: 'refs/orcaops/snap/test/2/open', sha: secondSha },
        { ref: 'refs/orcaops/snap/test/2/close', sha: thirdSha },
      ]);
      expect(await repo.resolveCommit('refs/orcaops/snap/test/1/open')).toBe(rootSha);
      expect(await repo.resolveCommit('refs/orcaops/snap/test/2/close')).toBe(thirdSha);

      const trees = await repo.resolveTreesBatch([rootSha, secondSha, thirdSha, rootSha]);
      expect(trees).toHaveLength(3);
      expect(trees.get(secondSha)).toBe(await repo.resolveTree(secondSha));

      const pairs = [
        { parentSha: rootSha, headSha: secondSha },
        { parentSha: secondSha, headSha: thirdSha },
      ];
      const diffs = await repo.diffCommitPairs(pairs, 100_000);
      expect(diffs.get(secondSha)?.diff.toString('utf8')).toContain('second.txt');
      expect(diffs.get(thirdSha)?.diff.toString('utf8')).toContain('third.txt');
      expect(diffs.get(secondSha)?.truncated).toBe(false);

      const capped = await repo.diffCommitPairs([pairs[0]!], 8);
      expect(capped.get(secondSha)).toMatchObject({ truncated: true });
      expect(capped.get(secondSha)?.diff).toHaveLength(8);
    } finally {
      await history.cleanup();
    }
  });
});

async function commit(
  repoPath: string,
  file: string,
  content: string,
  msg: string
): Promise<string> {
  await writeFile(path.join(repoPath, file), content, 'utf8');
  const git = gitClient(repoPath);
  await git.add(file);
  await git.commit(msg);
  return (await git.revparse(['HEAD'])).trim();
}

describe('Repo.getWorkingTreeStatus', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns "" for a clean working tree', async () => {
    const r = new Repo(repo.path);
    expect(await r.getWorkingTreeStatus()).toBe('');
  });

  it('reports modified tracked files', async () => {
    await commit(repo.path, 'a.ts', 'one\n', 'add a');
    await writeFile(path.join(repo.path, 'a.ts'), 'two\n', 'utf8');
    const r = new Repo(repo.path);
    const out = await r.getWorkingTreeStatus();
    expect(out).toMatch(/^\s*M\s+a\.ts$/);
  });

  it('reports untracked files', async () => {
    await writeFile(path.join(repo.path, 'new.ts'), 'x\n', 'utf8');
    const r = new Repo(repo.path);
    const out = await r.getWorkingTreeStatus();
    expect(out).toMatch(/\?\?\s+new\.ts/);
  });

  it('reports multiple changes joined by newlines', async () => {
    await commit(repo.path, 'a.ts', 'one\n', 'add a');
    await writeFile(path.join(repo.path, 'a.ts'), 'two\n', 'utf8');
    await writeFile(path.join(repo.path, 'b.ts'), 'b\n', 'utf8');
    const r = new Repo(repo.path);
    const out = await r.getWorkingTreeStatus();
    expect(out.split('\n')).toHaveLength(2);
  });
});

describe('Repo.listUnmergedPaths', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  function forgeConflict(repoPath: string, filePath: string): void {
    const stageLine = (content: string, stage: number): string => {
      const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repoPath,
        input: content,
      })
        .toString()
        .trim();
      return `100644 ${sha} ${stage}\t${filePath}`;
    };
    const info = `${[stageLine('base\n', 1), stageLine('ours\n', 2), stageLine('theirs\n', 3)].join(
      '\n'
    )}\n`;
    execFileSync('git', ['update-index', '--index-info'], { cwd: repoPath, input: info });
  }

  it('returns [] on a clean index', async () => {
    expect(await new Repo(repo.path).listUnmergedPaths()).toEqual([]);
  });

  it('lists conflicted paths, unique and sorted', async () => {
    forgeConflict(repo.path, 'b.txt');
    forgeConflict(repo.path, 'a.txt');
    expect(await new Repo(repo.path).listUnmergedPaths()).toEqual(['a.txt', 'b.txt']);
  });

  it('returns null when the probe cannot run', async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), 'orcaops-notrepo-'));
    try {
      expect(await new Repo(notARepo).listUnmergedPaths()).toBeNull();
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});

describe('Repo.getCommitsBetween', () => {
  let repo: TempRepo;
  let initialSha: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    initialSha = (await gitClient(repo.path).revparse(['HEAD'])).trim();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns [] when base equals head', async () => {
    const r = new Repo(repo.path);
    const out = await r.getCommitsBetween(initialSha, initialSha);
    expect(out).toEqual([]);
  });

  it('returns [] when no commits separate base and head', async () => {
    const r = new Repo(repo.path);
    const out = await r.getCommitsBetween(initialSha);
    expect(out).toEqual([]);
  });

  it('returns the single commit between base and head, with files', async () => {
    const sha = await commit(repo.path, 'a.ts', 'a\n', 'add a');
    const r = new Repo(repo.path);
    const out = await r.getCommitsBetween(initialSha);
    expect(out).toHaveLength(1);
    expect(out[0].sha).toBe(sha);
    expect(out[0].subject).toBe('add a');
    expect(out[0].files).toEqual(['a.ts']);
  });

  it('returns commits in reverse chronological order (HEAD first)', async () => {
    const sha1 = await commit(repo.path, 'a.ts', 'a\n', 'commit 1');
    const sha2 = await commit(repo.path, 'b.ts', 'b\n', 'commit 2');
    const r = new Repo(repo.path);
    const out = await r.getCommitsBetween(initialSha);
    expect(out.map((c) => c.sha)).toEqual([sha2, sha1]);
  });

  it('attributes multiple files to the same commit', async () => {
    await writeFile(path.join(repo.path, 'a.ts'), 'a\n', 'utf8');
    await writeFile(path.join(repo.path, 'b.ts'), 'b\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add(['a.ts', 'b.ts']);
    await git.commit('two files');
    const r = new Repo(repo.path);
    const out = await r.getCommitsBetween(initialSha);
    expect(out[0].files.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('handles subjects with delimiter-like characters', async () => {
    const subject = 'fix(parser): some "tricky" subject — with em-dash';
    await writeFile(path.join(repo.path, 'a.ts'), 'a\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('a.ts');
    await git.commit(subject);
    const r = new Repo(repo.path);
    const out = await r.getCommitsBetween(initialSha);
    expect(out[0].subject).toBe(subject);
  });

  it('returns [] when base ref is unknown', async () => {
    const r = new Repo(repo.path);
    const out = await r.getCommitsBetween('0000000000000000000000000000000000000000');
    expect(out).toEqual([]);
  });
});

describe('Repo.getCommitsBetweenStrict', () => {
  let repo: TempRepo;
  let initialSha: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    initialSha = (await gitClient(repo.path).revparse(['HEAD'])).trim();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns commits with files like the lenient variant', async () => {
    const sha = await commit(repo.path, 'a.ts', 'a\n', 'add a');
    const r = new Repo(repo.path);
    const out = await r.getCommitsBetweenStrict(initialSha);
    expect(out).toEqual([{ sha, subject: 'add a', files: ['a.ts'] }]);
  });

  it('returns [] when base equals head (clean, not error)', async () => {
    const r = new Repo(repo.path);
    expect(await r.getCommitsBetweenStrict(initialSha, initialSha)).toEqual([]);
  });

  it('THROWS when the base ref is unknown — never an empty clean result', async () => {
    const r = new Repo(repo.path);
    await expect(
      r.getCommitsBetweenStrict('0000000000000000000000000000000000000000')
    ).rejects.toThrow();
  });

  it('THROWS when the head ref is unknown', async () => {
    const r = new Repo(repo.path);
    await expect(r.getCommitsBetweenStrict(initialSha, 'no-such-ref-anywhere')).rejects.toThrow();
  });
});

describe('Repo.branchExists', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    // Need at least one commit so `git rev-parse --verify refs/heads/main`
    // can resolve — a fresh `git init` leaves the branch unborn.
    await commit(repo.path, 'a.ts', 'one\n', 'init');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns true for a branch that exists in the working tree', async () => {
    const r = new Repo(repo.path);
    expect(await r.branchExists('main')).toBe(true);
  });

  it('returns false for a branch that does not exist', async () => {
    const r = new Repo(repo.path);
    expect(await r.branchExists('does-not-exist')).toBe(false);
  });

  it('distinguishes branch-off from rename — old branch survives after checkout -b', async () => {
    const r = new Repo(repo.path);
    const git = gitClient(repo.path);
    await git.checkoutLocalBranch('feat-b');
    // Both branches present: branch-off semantics.
    expect(await r.branchExists('main')).toBe(true);
    expect(await r.branchExists('feat-b')).toBe(true);
  });

  it('distinguishes branch-off from rename — old branch survives after `git switch -c`', async () => {
    // `git switch -c <new>` is the newer-syntax equivalent of `checkout -b`;
    // the test pins the end-state guarantee — branchExists keys on whether
    // the prior ref is intact, not on which git command produced the new
    // branch — so syncToGit's branch-off path fires identically for both.
    const r = new Repo(repo.path);
    const git = gitClient(repo.path);
    await git.raw(['switch', '-c', 'feat-c']);
    expect(await r.branchExists('main')).toBe(true);
    expect(await r.branchExists('feat-c')).toBe(true);
  });

  it('distinguishes branch-off from rename — old branch gone after branch -m', async () => {
    const r = new Repo(repo.path);
    const git = gitClient(repo.path);
    await git.raw(['branch', '-m', 'main', 'renamed']);
    expect(await r.branchExists('main')).toBe(false);
    expect(await r.branchExists('renamed')).toBe(true);
  });

  it('returns false for malformed ref names instead of throwing', async () => {
    const r = new Repo(repo.path);
    // git rev-parse rejects refs with embedded whitespace or special chars
    // — the helper swallows the failure rather than surfacing it.
    expect(await r.branchExists('with spaces')).toBe(false);
  });
});

describe('Repo.resolveCommit / Repo.listCommitShasBetween', () => {
  let repo: TempRepo;
  let initialSha: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    initialSha = (await gitClient(repo.path).revparse(['HEAD'])).trim();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('resolves branch names, tags, shas, and relative refs to full commit shas', async () => {
    const sha = await commit(repo.path, 'a.ts', 'a\n', 'add a');
    await gitClient(repo.path).tag(['v1']);
    const r = new Repo(repo.path);
    expect(await r.resolveCommit('main')).toBe(sha);
    expect(await r.resolveCommit('v1')).toBe(sha);
    expect(await r.resolveCommit(sha)).toBe(sha);
    expect(await r.resolveCommit(sha.slice(0, 8))).toBe(sha);
    expect(await r.resolveCommit('HEAD~1')).toBe(initialSha);
  });

  it('returns null for garbage, missing refs, and non-commit objects', async () => {
    const r = new Repo(repo.path);
    expect(await r.resolveCommit('no-such-branch')).toBeNull();
    expect(await r.resolveCommit('not a ref')).toBeNull();
    // A tree sha is a real object but not a commit — the ^{commit} peel rejects it.
    const treeSha = (await gitClient(repo.path).revparse(['HEAD^{tree}'])).trim();
    expect(await r.resolveCommit(treeSha)).toBeNull();
  });

  it('lists shas in base..head and returns [] for an empty range', async () => {
    const sha1 = await commit(repo.path, 'a.ts', 'a\n', 'commit 1');
    const sha2 = await commit(repo.path, 'b.ts', 'b\n', 'commit 2');
    const r = new Repo(repo.path);
    expect(await r.listCommitShasBetween(initialSha, sha2)).toEqual([sha2, sha1]);
    // rev-list excludes the base itself.
    expect(await r.listCommitShasBetween(sha1, sha2)).toEqual([sha2]);
    expect(await r.listCommitShasBetween(sha2, sha2)).toEqual([]);
  });
});

describe('Repo.resolveMergeBase', () => {
  it('distinguishes a merge base from unrelated histories', async () => {
    const temp = await createTempRepo({ initialBranch: 'main' });
    try {
      const git = gitClient(temp.path);
      const repo = new Repo(temp.path);
      const main = (await git.revparse(['HEAD'])).trim();
      await git.raw(['checkout', '--orphan', 'unrelated']);
      await writeFile(path.join(temp.path, 'unrelated.txt'), 'unrelated\n');
      await git.add(['unrelated.txt']);
      await git.commit('unrelated');
      const unrelated = (await git.revparse(['HEAD'])).trim();

      await expect(repo.resolveMergeBase(main, main)).resolves.toEqual({
        status: 'resolved',
        sha: main,
      });
      await expect(repo.resolveMergeBase(main, unrelated)).resolves.toEqual({ status: 'absent' });
    } finally {
      await temp.cleanup();
    }
  });
});

describe('Repo destructive Git probes', () => {
  let repo: TempRepo;
  let initialSha: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    initialSha = (await gitClient(repo.path).revparse(['HEAD'])).trim();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('distinguishes reachable, unreachable, and operationally unknown ancestry', async () => {
    const headSha = await commit(repo.path, 'a.ts', 'a\n', 'advance');
    const r = new Repo(repo.path);

    await expect(r.checkReachability(initialSha, headSha)).resolves.toBe('reachable');
    await expect(r.checkReachability(headSha, initialSha)).resolves.toBe('unreachable');
    await expect(
      r.checkReachability('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', headSha)
    ).resolves.toBe('unknown');
  });

  it('distinguishes absent branches and refs from resolved ones', async () => {
    const r = new Repo(repo.path);

    await expect(r.branchPresence('main')).resolves.toBe('present');
    await expect(r.branchPresence('missing')).resolves.toBe('absent');
    await expect(r.resolveCommitState('main')).resolves.toEqual({
      status: 'resolved',
      sha: initialSha,
    });
    await expect(r.resolveCommitState('missing')).resolves.toEqual({ status: 'absent' });
  });

  it('exact branch refs are not shadowed by same-named tags', async () => {
    const git = gitClient(repo.path);
    await git.raw(['tag', 'main', initialSha]);
    await git.raw(['branch', '-m', 'trunk']);
    const r = new Repo(repo.path);

    await expect(r.resolveCommitState('main')).resolves.toEqual({
      status: 'resolved',
      sha: initialSha,
    });
    await expect(r.resolveCommitState('refs/heads/main')).resolves.toEqual({ status: 'absent' });
    await expect(r.branchPresence('main')).resolves.toBe('absent');
  });
});

describe('Repo.getRemoteUrl', () => {
  // A dead placeholder shaped like a GitHub token; never a live credential.
  const TOKEN = 'ghp_0000000000000000000000000000000000000';
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('strips an http credential from the configured remote', async () => {
    const r = new Repo(repo.path);
    await r.setLocalConfig(
      'remote.origin.url',
      `https://x-access-token:${TOKEN}@github.com/foo/bar.git`
    );
    const url = await r.getRemoteUrl();
    expect(url).toBe('https://github.com/foo/bar.git');
    expect(url).not.toContain(TOKEN);
  });

  it('returns a credential-free remote unchanged, and null when unset', async () => {
    const r = new Repo(repo.path);
    expect(await r.getRemoteUrl()).toBeNull();
    await r.setLocalConfig('remote.origin.url', 'git@github.com:foo/bar.git');
    expect(await r.getRemoteUrl()).toBe('git@github.com:foo/bar.git');
  });
});

describe('Repo local config accessors', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('round-trips a value and returns null when unset', async () => {
    const r = new Repo(repo.path);
    expect(await r.getLocalConfig('orcaops.projectid')).toBeNull();
    await r.setLocalConfig('orcaops.projectid', '019f0000-aaaa-7000-8000-000000000001');
    expect(await r.getLocalConfig('orcaops.projectid')).toBe(
      '019f0000-aaaa-7000-8000-000000000001'
    );
  });

  it('distinguishes a configured empty value from an unset key', async () => {
    const r = new Repo(repo.path);
    await r.setLocalConfig('orcaops.projectid', '');
    expect(await r.getLocalConfig('orcaops.projectid')).toBe('');
    expect(await r.getLocalConfig('orcaops.absent')).toBeNull();
  });

  it('does not classify an operational config-read failure as an unset key', async () => {
    const r = new Repo(repo.path);
    await writeFile(path.join(repo.path, '.git', 'config'), '[broken\n', 'utf8');
    await expect(r.getLocalConfig('orcaops.projectid')).rejects.toThrow();
  });

  it('does not classify a missing local config file as an unset key', async () => {
    const config = path.join(repo.path, '.git', 'config');
    const displaced = path.join(repo.path, '.git', 'config.displaced');
    await rename(config, displaced);
    try {
      await expect(new Repo(repo.path).getLocalConfig('orcaops.projectid')).rejects.toThrow(
        'git config --local --get failed'
      );
    } finally {
      await rename(displaced, config);
    }
  });

  it('rejects when an absent-key exit is followed by an unreadable config exit', async () => {
    const bin = await mkdtemp(path.join(tmpdir(), 'orcaops-git-shim-'));
    const git = path.join(bin, 'git');
    await writeFile(git, '#!/bin/sh\nif [ "$3" = "--get" ]; then exit 1; fi\nexit 2\n', {
      encoding: 'utf8',
      mode: 0o700,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    try {
      await expect(new Repo(repo.path).getLocalConfig('orcaops.projectid')).rejects.toThrow(
        'git config --local --get failed'
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(bin, { recursive: true, force: true });
    }
  });

  it('rejects a silent nonzero config-read exit', async () => {
    const bin = await mkdtemp(path.join(tmpdir(), 'orcaops-git-shim-'));
    const git = path.join(bin, 'git');
    await writeFile(git, '#!/bin/sh\nexit 2\n', { encoding: 'utf8', mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    try {
      await expect(new Repo(repo.path).getLocalConfig('orcaops.projectid')).rejects.toThrow(
        'git config --local --get failed'
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(bin, { recursive: true, force: true });
    }
  });

  it('returns null for an absent key when Git emits trace diagnostics', async () => {
    const originalTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = '1';
    try {
      await expect(new Repo(repo.path).getLocalConfig('orcaops.absent')).resolves.toBeNull();
    } finally {
      if (originalTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = originalTrace;
    }
  });

  it('is case-insensitive on read (git normalizes config keys to lowercase)', async () => {
    const r = new Repo(repo.path);
    await r.setLocalConfig('orcaops.projectid', 'abc');
    expect(await r.getLocalConfig('Orcaops.ProjectId')).toBe('abc');
  });

  it('is shared across worktrees (local config lives in the common dir)', async () => {
    await commit(repo.path, 'a.ts', 'a\n', 'seed');
    const r = new Repo(repo.path);
    await r.setLocalConfig('orcaops.projectid', 'shared-id');
    const wtPath = `${repo.path}-wt`;
    await gitClient(repo.path).raw(['worktree', 'add', wtPath, '-b', 'wt-branch']);
    const wt = new Repo(wtPath);
    expect(await wt.getLocalConfig('orcaops.projectid')).toBe('shared-id');
    // And the reverse direction: a write from the worktree is visible at the root.
    await wt.setLocalConfig('orcaops.other', 'from-wt');
    expect(await r.getLocalConfig('orcaops.other')).toBe('from-wt');
  });
});

describe('Repo.listWorktrees', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  // git reports realpath'd absolute paths (macOS tmpdir is a /var → /private/var
  // symlink), so compare by basename — unique per temp dir here — not raw path.
  const base = (p: string): string => path.basename(p);

  it('pairs each worktree with its checked-out branch', async () => {
    await commit(repo.path, 'a.ts', 'a\n', 'seed');
    const wtPath = `${repo.path}-wt`;
    await gitClient(repo.path).raw(['worktree', 'add', wtPath, '-b', 'feature']);

    const worktrees = await new Repo(repo.path).listWorktrees();
    const main = worktrees.find((w) => w.branch === 'main');
    const feature = worktrees.find((w) => w.branch === 'feature');
    expect(base(main?.path ?? '')).toBe(base(repo.path));
    expect(base(feature?.path ?? '')).toBe(base(wtPath));

    await gitClient(repo.path).raw(['worktree', 'remove', '--force', wtPath]);
  });

  it('reports branch null for a detached worktree', async () => {
    const head = await commit(repo.path, 'a.ts', 'a\n', 'seed');
    const wtPath = `${repo.path}-detached`;
    await gitClient(repo.path).raw(['worktree', 'add', '--detach', wtPath, head]);

    const worktrees = await new Repo(repo.path).listWorktrees();
    const detached = worktrees.find((w) => base(w.path) === base(wtPath));
    expect(detached).toBeDefined();
    expect(detached?.branch).toBeNull();

    await gitClient(repo.path).raw(['worktree', 'remove', '--force', wtPath]);
  });

  it('fails open to [] outside a git repository', async () => {
    const nonRepo = await mkdtemp(path.join(tmpdir(), 'orcaops-nonrepo-'));
    try {
      expect(await new Repo(nonRepo).listWorktrees()).toEqual([]);
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});

describe('Repo git-path plumbing (getGitDirAbsolute / getGitPathAbsolute / getHooksDir)', () => {
  let repo: TempRepo;
  let root: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    // The methods canonicalize via realpath (macOS /var → /private/var), so
    // compare against the realpath'd root.
    root = await realpath(repo.path);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('normal repo: git dir, common dir, and git-path all land under <root>/.git', async () => {
    const r = new Repo(repo.path);
    expect(await r.getGitDirAbsolute()).toBe(path.join(root, '.git'));
    expect(await r.getCommonDirAbsolute()).toBe(path.join(root, '.git'));
    expect(await r.getGitPathAbsolute('info/exclude')).toBe(
      path.join(root, '.git', 'info', 'exclude')
    );
    expect(await r.getHooksDir()).toEqual({
      dir: path.join(root, '.git', 'hooks'),
      source: 'git',
    });
  });

  it('linked worktree: per-worktree git dir, shared common dir, common hooks/info', async () => {
    const wt = await createLinkedWorktree(repo.path, { branch: 'plumbing-wt' });
    try {
      const r = new Repo(wt.path);
      expect(await r.getGitDirAbsolute()).toBe(path.join(root, '.git', 'worktrees', 'plumbing-wt'));
      expect(await r.getCommonDirAbsolute()).toBe(path.join(root, '.git'));
      // hooks and info/exclude are SHARED state — the common dir, not the
      // worktree's private git dir.
      expect((await r.getHooksDir()).dir).toBe(path.join(root, '.git', 'hooks'));
      expect(await r.getGitPathAbsolute('info/exclude')).toBe(
        path.join(root, '.git', 'info', 'exclude')
      );
    } finally {
      await wt.cleanup();
    }
  });

  it('core.hooksPath (relative): hooks dir resolves to the override, source flags it', async () => {
    // The dir must exist for realpath canonicalization (as it does in any
    // real husky/lefthook repo); a missing path falls back un-canonicalized.
    await mkdir(path.join(repo.path, '.husky'), { recursive: true });
    await gitClient(repo.path).addConfig('core.hooksPath', '.husky');
    const r = new Repo(repo.path);
    const hooks = await r.getHooksDir();
    expect(hooks.dir).toBe(path.join(root, '.husky'));
    expect(hooks.source).toBe('core.hooksPath');
    // Non-hook git-paths are unaffected by the hooks override.
    expect(await r.getGitPathAbsolute('info/exclude')).toBe(
      path.join(root, '.git', 'info', 'exclude')
    );
  });

  it('core.hooksPath (absolute): reported verbatim with the override source', async () => {
    const external = await mkdtemp(path.join(tmpdir(), 'orcaops-hooks-ext-'));
    try {
      const canonical = await realpath(external);
      await gitClient(repo.path).addConfig('core.hooksPath', canonical);
      const hooks = await new Repo(repo.path).getHooksDir();
      expect(hooks.dir).toBe(canonical);
      expect(hooks.source).toBe('core.hooksPath');
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

describe('Repo.listTrackedPaths', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const commit = (files: string[]): void => {
    execFileSync('git', ['add', '--', ...files], { cwd: repo.path });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add'], {
      cwd: repo.path,
    });
  };

  it('returns only the tracked subset, as the strings passed in', async () => {
    await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
    await writeFile(path.join(repo.path, '.orcaops', 'config.json'), '{}', 'utf8');
    await writeFile(path.join(repo.path, '.orcaops', 'install.json'), '{}', 'utf8');
    commit(['.orcaops/config.json']);

    const tracked = await new Repo(repo.path).listTrackedPaths([
      path.join('.orcaops', 'config.json'),
      path.join('.orcaops', 'install.json'),
      'never-existed.txt',
    ]);
    expect([...tracked]).toEqual([path.join('.orcaops', 'config.json')]);
    expect(await new Repo(repo.path).isTracked(path.join('.orcaops', 'install.json'))).toBe(false);
  });

  it('answers an empty batch with an empty set instead of the whole index', async () => {
    await writeFile(path.join(repo.path, 'tracked.txt'), 'x', 'utf8');
    commit(['tracked.txt']);
    expect((await new Repo(repo.path).listTrackedPaths([])).size).toBe(0);
  });

  it('treats a leading colon literally rather than as pathspec magic', async () => {
    await writeFile(path.join(repo.path, ':odd.txt'), 'x', 'utf8');
    await writeFile(path.join(repo.path, 'plain.txt'), 'x', 'utf8');
    commit(['plain.txt']);
    const tracked = await new Repo(repo.path).listTrackedPaths([':odd.txt', 'plain.txt']);
    expect([...tracked]).toEqual(['plain.txt']);
  });
});

describe('probeWorktree', () => {
  let main: TempRepo;
  let linked: TempRepo;

  beforeEach(async () => {
    main = await createTempRepo({ initialBranch: 'main' });
    linked = await createLinkedWorktree(main.path, { branch: 'feature-probe' });
  });
  afterEach(async () => {
    await linked.cleanup();
    await main.cleanup();
  });

  it('resolves the relative common dir git prints from the main worktree root', async () => {
    const probe = await probeWorktree(main.path);
    expect(probe).not.toBeNull();
    expect(probe?.worktreeRoot).toBe(await realpath(main.path));
    expect(probe?.commonDir).toBe(await new Repo(main.path).getCommonDirAbsolute());
    expect(probe?.branch).toBe('main');
  });

  it('resolves `../.git` against the subdirectory the process ran in', async () => {
    const sub = path.join(main.path, 'pkg', 'src');
    await mkdir(sub, { recursive: true });
    const probe = await probeWorktree(sub);
    expect(probe?.worktreeRoot).toBe(await realpath(main.path));
    // Wrong resolution would land on <sub>/.git, which does not exist.
    expect(probe?.commonDir).toBe(await new Repo(main.path).getCommonDirAbsolute());
  });

  it('reports the shared common dir and its own branch from a linked worktree', async () => {
    const probe = await probeWorktree(linked.path);
    expect(probe?.worktreeRoot).toBe(await realpath(linked.path));
    expect(probe?.commonDir).toBe(await new Repo(main.path).getCommonDirAbsolute());
    expect(probe?.branch).toBe('feature-probe');
  });

  it('still answers the root and common dir in a repository with no commits', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'orcaops-probe-empty-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });
      const probe = await probeWorktree(empty);
      expect(probe?.worktreeRoot).toBe(await realpath(empty));
      expect(probe?.commonDir).toBe(path.join(await realpath(empty), '.git'));
      expect(probe?.branch).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('answers null outside a repository instead of guessing', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-probe-outside-'));
    try {
      expect(await probeWorktree(outside)).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
