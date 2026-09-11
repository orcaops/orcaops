import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHistoryRepo as createFixture, type TempRepo } from '@orcaops/test-harness';

import { createHistoryRepo } from './repository.js';
import { Repo } from '../git/repo.js';

const fixtures: TempRepo[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture() {
  const selected = await createFixture([
    { type: 'commit', label: 'root', files: { 'selected.txt': 'Selected\n' } },
    { type: 'commit', label: 'changed', files: { 'selected.txt': 'Changed\n' } },
  ]);
  fixtures.push(selected);
  const foreign = await createFixture([
    { type: 'commit', label: 'root', files: { 'foreign.txt': 'Foreign\n' } },
  ]);
  fixtures.push(foreign);
  const before = { ...process.env };
  const selectedRepo = new Repo(selected.path, { env: before });
  const foreignRepo = new Repo(foreign.path, { env: before });
  const gitDir = await foreignRepo.getGitDirAbsolute();
  const redirects = {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: foreign.path,
    GIT_COMMON_DIR: gitDir,
    GIT_INDEX_FILE: path.join(gitDir, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(gitDir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, 'objects'),
  };
  for (const [key, value] of Object.entries(redirects)) vi.stubEnv(key, value);
  return { selected, foreign, selectedRepo, foreignRepo, redirects };
}

describe('selected history repository', () => {
  it('keeps scalar, probe, batched object and detailed-history reads in their own checkout', async () => {
    const f = await fixture();
    const repo = createHistoryRepo(f.selected.path);
    const foreign = createHistoryRepo(f.foreign.path);
    const root = f.selected.shas.root!;
    const head = f.selected.shas.changed!;
    const tree = await f.selectedRepo.resolveTree(head);
    const [selectedHead, foreignHead] = await Promise.all([
      repo.getHeadSha(),
      foreign.getHeadSha(),
    ]);
    expect(selectedHead).toBe(head);
    expect(foreignHead).toBe(f.foreign.shas.root);
    expect(await repo.getFileAtRef('HEAD', 'selected.txt')).toBe('Changed\n');
    expect(await repo.resolveTree(head)).toBe(tree);
    expect(await repo.resolveTreesBatch([head])).toEqual(new Map([[head, tree]]));
    expect(await repo.resolveCommitState(head)).toEqual({ status: 'resolved', sha: head });
    expect(await repo.resolveMergeBase(root, head)).toEqual({ status: 'resolved', sha: root });
    expect(await repo.checkReachability(root, head)).toBe('reachable');
    expect(await repo.branchPresence('main')).toBe('present');
    expect(await repo.listLocalBranchTipsState()).toEqual({ status: 'known', tips: [head] });
    expect(await repo.listUnmergedPaths()).toEqual([]);
    const commits = await repo.logDetailed('HEAD');
    expect(commits.map((commit) => commit.sha)).toEqual([head, root]);
    expect(commits[0].files).toEqual(['selected.txt']);
    expect((await repo.logFirstParentDetailed('HEAD')).map((commit) => commit.sha)).toEqual([
      head,
      root,
    ]);
    const diffs = await repo.diffCommitPairs([{ headSha: head, parentSha: root }], 10_000);
    expect(diffs.get(head)?.diff.toString('utf8')).toContain('+Changed');
    for (const [key, value] of Object.entries(f.redirects)) expect(process.env[key]).toBe(value);
  });

  it('keeps configuration, index and explicit ref mutations out of a foreign repository', async () => {
    const f = await fixture();
    const repo = createHistoryRepo(f.selected.path);
    const selectedIndex = path.join(await f.selectedRepo.getGitDirAbsolute(), 'index');
    const foreignIndex = path.join(await f.foreignRepo.getGitDirAbsolute(), 'index');
    const selectedBefore = await readFile(selectedIndex);
    const foreignBefore = await readFile(foreignIndex);
    await repo.setLocalConfig('orcaops.test-selection', 'selected');
    expect(await repo.getLocalConfig('orcaops.test-selection')).toBe('selected');
    expect(await f.foreignRepo.getLocalConfig('orcaops.test-selection')).toBeNull();
    expect(await repo.getIndexTreeSha()).toBe(await f.selectedRepo.resolveTree('HEAD'));
    const ref = 'refs/test/selected';
    await repo.updateRefsBatch([{ ref, sha: f.selected.shas.changed! }]);
    expect(await f.selectedRepo.resolveCommit(ref)).toBe(f.selected.shas.changed);
    expect(await f.foreignRepo.resolveCommit(ref)).toBeNull();
    expect(await readFile(selectedIndex)).toEqual(selectedBefore);
    expect(await readFile(foreignIndex)).toEqual(foreignBefore);
  });

  it('freezes an explicit repository environment before asynchronous commands', async () => {
    const f = await fixture();
    const env = { ...process.env, GIT_DIR: await f.foreignRepo.getGitDirAbsolute() };
    const repo = new Repo(f.selected.path, { env });
    env.GIT_DIR = '/unavailable/git';
    expect(await repo.getHeadSha()).toBe(f.foreign.shas.root);
    const canonical = createHistoryRepo(f.selected.path);
    vi.stubEnv('GIT_DIR', '/unavailable/git');
    expect(await canonical.getHeadSha()).toBe(f.selected.shas.changed);
  });
});
