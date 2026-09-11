import * as childProcess from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { Repo } from './repo.js';
import {
  captureReviewWorktreeTreeSha,
  captureWorktreeTree,
  diffSnapshotStats,
  diffSnapshotTrees,
} from './snapshots.js';

const repos: TempRepo[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});
async function fixture() {
  const repo = await createTempRepo({ initialBranch: 'main' });
  repos.push(repo);
  return repo;
}
const git = (cwd: string, args: string[]) =>
  childProcess
    .execFileSync('git', ['-C', cwd, ...args], {
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            ![
              'GIT_DIR',
              'GIT_WORK_TREE',
              'GIT_COMMON_DIR',
              'GIT_INDEX_FILE',
              'GIT_OBJECT_DIRECTORY',
              'GIT_ALTERNATE_OBJECT_DIRECTORIES',
            ].includes(key)
        )
      ),
    })
    .toString();

describe('durable snapshot objects', () => {
  it('requests synchronous loose-object durability for blobs, trees and the unpublished commit', async () => {
    const repo = await fixture();
    await writeFile(path.join(repo.path, 'README.md'), 'durable tracked bytes\n');
    const index = await readFile(path.join(repo.path, '.git', 'index'));
    const tracePath = path.join(repo.path, '.git', 'object-trace.ndjson');
    vi.stubEnv('GIT_TRACE2_EVENT', tracePath);
    const result = await captureWorktreeTree(new Repo(repo.path), 'retained work', {
      durableObjects: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error_message);
    const trace = (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { event: string; argv?: string[]; key?: string; value?: string }
      );
    const calls = trace.filter((event) => event.event === 'start').map((event) => event.argv ?? []);
    for (const verb of ['add', 'write-tree', 'commit-tree']) {
      const writes = calls.filter((args) => args.includes(verb));
      expect(writes.length).toBeGreaterThan(0);
      for (const args of writes)
        expect(args).toEqual(
          expect.arrayContaining(['core.fsync=loose-object', 'core.fsyncMethod=fsync'])
        );
    }
    expect(git(repo.path, ['show', `${result.commit_sha}:README.md`])).toBe(
      'durable tracked bytes\n'
    );
    expect(await readFile(path.join(repo.path, '.git', 'index'))).toEqual(index);
    expect(git(repo.path, ['for-each-ref', 'refs/orcaops'])).toBe('');
  });

  it('selects the requested checkout despite ambient repository, object-store and index overrides', async () => {
    const selected = await fixture();
    const foreign = await fixture();
    await writeFile(path.join(selected.path, 'README.md'), 'selected bytes\n');
    await writeFile(path.join(selected.path, 'evidence.txt'), 'selected explicit evidence\n');
    await writeFile(path.join(foreign.path, 'README.md'), 'foreign bytes\n');
    const selectedEnv = { ...process.env };
    const baseTree = git(selected.path, ['rev-parse', 'HEAD^{tree}']).trim();
    const selectedIndex = await readFile(path.join(selected.path, '.git', 'index'));
    const foreignIndex = await readFile(path.join(foreign.path, '.git', 'index'));
    for (const [key, value] of Object.entries({
      GIT_DIR: path.join(foreign.path, '.git'),
      GIT_WORK_TREE: foreign.path,
      GIT_COMMON_DIR: path.join(foreign.path, '.git'),
      GIT_INDEX_FILE: path.join(foreign.path, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: path.join(foreign.path, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(foreign.path, '.git', 'objects'),
    }))
      vi.stubEnv(key, value);
    const result = await captureReviewWorktreeTreeSha(new Repo(selected.path), ['evidence.txt'], {
      durableObjects: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error_message);
    expect(git(selected.path, ['show', `${result.tree_sha}:README.md`])).toBe('selected bytes\n');
    expect(git(selected.path, ['show', `${result.tree_sha}:evidence.txt`])).toBe(
      'selected explicit evidence\n'
    );
    expect(result.included_untracked).toEqual(['evidence.txt']);
    const diff = await diffSnapshotTrees({
      repo: new Repo(selected.path),
      openTreeSha: baseTree,
      closeTreeSha: result.tree_sha,
      maxDiffBytes: 100_000,
      pathspecs: ['README.md'],
      env: selectedEnv,
    });
    expect(diff.ok).toBe(true);
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.diff.toString()).toContain('selected bytes');
    expect(diff.diff.toString()).not.toContain('evidence.txt');
    const stats = await diffSnapshotStats({
      repo: new Repo(selected.path),
      openTreeSha: baseTree,
      closeTreeSha: result.tree_sha,
      env: selectedEnv,
    });
    expect(stats).toMatchObject({
      ok: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'README.md' }),
        expect.objectContaining({ path: 'evidence.txt' }),
      ]),
    });
    expect(await readFile(path.join(selected.path, '.git', 'index'))).toEqual(selectedIndex);
    expect(await readFile(path.join(foreign.path, '.git', 'index'))).toEqual(foreignIndex);
  });
});
