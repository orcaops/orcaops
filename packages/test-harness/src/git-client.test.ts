import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { gitClient } from './git-client.js';
import { createTempRepo, type TempRepo } from './temp-repo.js';

describe('gitClient', () => {
  const repos: TempRepo[] = [];
  const repo = async (): Promise<TempRepo> => {
    const r = await createTempRepo({ initialBranch: 'main' });
    repos.push(r);
    return r;
  };
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((r) => r.cleanup()));
  });

  /** Two branches editing the same line, so merging them conflicts. */
  async function diverge(root: string): Promise<void> {
    const git = gitClient(root);
    await writeFile(path.join(root, 'f.txt'), 'base\n', 'utf8');
    await git.add('f.txt');
    await git.commit('base');
    await git.checkoutLocalBranch('feat');
    await writeFile(path.join(root, 'f.txt'), 'feat\n', 'utf8');
    await git.add('f.txt');
    await git.commit('feat');
    await git.checkout('main');
    await writeFile(path.join(root, 'f.txt'), 'main\n', 'utf8');
    await git.add('f.txt');
    await git.commit('main');
  }

  it('rejects a conflicted merge instead of reporting success', async () => {
    const r = await repo();
    await diverge(r.path);
    // git announces a conflict on STDOUT with an exit code and an empty stderr,
    // so a stderr-keyed failure rule would call this a success and hand the
    // caller a repo stuck mid-merge.
    await expect(gitClient(r.path).merge(['feat'])).rejects.toThrow(/CONFLICT/);
  });

  it('leaves a clean merge alone', async () => {
    const r = await repo();
    const git = gitClient(r.path);
    await writeFile(path.join(r.path, 'a.txt'), 'a\n', 'utf8');
    await git.add('a.txt');
    await git.commit('a');
    await git.checkoutLocalBranch('feat');
    await writeFile(path.join(r.path, 'b.txt'), 'b\n', 'utf8');
    await git.add('b.txt');
    await git.commit('b');
    await git.checkout('main');
    await expect(git.merge(['--no-ff', '--no-edit', 'feat'])).resolves.toBeUndefined();
  });

  it('still treats a silent non-zero exit as a no-op', async () => {
    const r = await repo();
    const git = gitClient(r.path);
    // `config --unset` of an absent key exits 5 with no output at all, and
    // committing a clean tree exits 1 with output only on stdout. Fixtures rely
    // on both being no-ops rather than errors.
    await expect(git.raw(['config', '--local', '--unset', 'nosuch.key'])).resolves.toBe('');
    await expect(git.commit('nothing to do')).resolves.toBeUndefined();
  });

  it('reports newest-first log entries', async () => {
    const r = await repo();
    const git = gitClient(r.path);
    for (const name of ['one', 'two']) {
      await writeFile(path.join(r.path, `${name}.txt`), `${name}\n`, 'utf8');
      await git.add(`${name}.txt`);
      await git.commit(name);
    }
    const log = await git.log();
    expect(log.all[0].message).toBe('two');
    expect(log.all.at(-1)?.message).toBe('initial commit');
    expect(log.total).toBe(log.all.length);
  });
});
