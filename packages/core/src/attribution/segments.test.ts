import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { computeWindowSegments, type SegmentBoundaryInput } from './segments.js';
import { Repo } from '../git/repo.js';

/** Commit the current worktree and return the commit's TREE sha. */
async function commitTree(repoPath: string, msg: string): Promise<string> {
  const git = gitClient(repoPath);
  await git.add(['-A']);
  await git.commit(msg);
  return (await git.revparse(['HEAD^{tree}'])).trim();
}

async function write(repoPath: string, file: string, content: string): Promise<void> {
  await writeFile(path.join(repoPath, file), content, 'utf8');
}

describe('computeWindowSegments', () => {
  let repo: TempRepo;
  let r: Repo;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    r = new Repo(repo.path);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const boundary = (
    eventIdx: number,
    n: number,
    phase: SegmentBoundaryInput['phase'],
    treeSha: string | null
  ): SegmentBoundaryInput => ({ eventIdx, n, phase, treeSha });

  it('classifies exclusive vs concurrent segments and diffs each boundary pair', async () => {
    // Timeline: A.open(T1) → B.open(T2) → A.close(T3) → B.close(T4).
    // a.ts changes in A-exclusive [T1,T2]; b.ts in concurrent [T2,T3];
    // c.ts in B-exclusive [T3,T4].
    const t1 = await commitTree(repo.path, 'baseline');
    await write(repo.path, 'a.ts', 'a\n');
    const t2 = await commitTree(repo.path, 'A exclusive work');
    await write(repo.path, 'b.ts', 'b\n');
    const t3 = await commitTree(repo.path, 'concurrent work');
    await write(repo.path, 'c.ts', 'c\n');
    const t4 = await commitTree(repo.path, 'B exclusive work');

    const segments = await computeWindowSegments({
      repo: r,
      boundaries: [
        boundary(0, 1, 'open', t1),
        boundary(1, 2, 'open', t2),
        boundary(2, 1, 'close', t3),
        boundary(3, 2, 'close', t4),
      ],
    });

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({
      activeNs: [1],
      kind: 'exclusive',
      changedFiles: ['a.ts'],
      degradedReason: null,
    });
    expect(segments[1]).toMatchObject({
      activeNs: [1, 2],
      kind: 'concurrent',
      changedFiles: ['b.ts'],
    });
    expect(segments[2]).toMatchObject({
      activeNs: [2],
      kind: 'exclusive',
      changedFiles: ['c.ts'],
    });
  });

  it('surfaces BOTH rename sides via --no-renames (D old + A new)', async () => {
    await write(repo.path, 'old.ts', 'same content\n');
    const t1 = await commitTree(repo.path, 'has old.ts');
    await rename(path.join(repo.path, 'old.ts'), path.join(repo.path, 'new.ts'));
    const t2 = await commitTree(repo.path, 'renamed');

    const segments = await computeWindowSegments({
      repo: r,
      boundaries: [boundary(0, 1, 'open', t1), boundary(1, 1, 'close', t2)],
    });
    expect(segments[0].changedFiles).toEqual(['new.ts', 'old.ts']);
  });

  it('includes deletions in the segment file-set', async () => {
    await write(repo.path, 'doomed.ts', 'x\n');
    const t1 = await commitTree(repo.path, 'has doomed.ts');
    await unlink(path.join(repo.path, 'doomed.ts'));
    const t2 = await commitTree(repo.path, 'deleted');

    const segments = await computeWindowSegments({
      repo: r,
      boundaries: [boundary(0, 1, 'open', t1), boundary(1, 1, 'close', t2)],
    });
    expect(segments[0].changedFiles).toEqual(['doomed.ts']);
  });

  it('degrades a segment with a missing boundary tree to claims-only, disclosed', async () => {
    const t1 = await commitTree(repo.path, 'baseline');
    await write(repo.path, 'a.ts', 'a\n');
    const t3 = await commitTree(repo.path, 'later');

    const segments = await computeWindowSegments({
      repo: r,
      boundaries: [
        boundary(0, 1, 'open', t1),
        boundary(1, 2, 'open', null), // skipped snapshot
        boundary(2, 1, 'close', t3),
      ],
    });
    expect(segments[0]).toMatchObject({
      changedFiles: null,
      degradedReason: 'missing_boundary_tree',
    });
    expect(segments[1]).toMatchObject({
      changedFiles: null,
      degradedReason: 'missing_boundary_tree',
    });
    // Active-set classification still folds correctly around the degraded boundary.
    expect(segments[0].activeNs).toEqual([1]);
    expect(segments[1].activeNs).toEqual([1, 2]);
  });

  it('degrades on git failure (unreachable tree sha), never guesses', async () => {
    const t1 = await commitTree(repo.path, 'baseline');
    const segments = await computeWindowSegments({
      repo: r,
      boundaries: [
        boundary(0, 1, 'open', t1),
        boundary(1, 1, 'close', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
      ],
    });
    expect(segments[0]).toMatchObject({
      changedFiles: null,
      degradedReason: 'git_diff_failed',
    });
  });

  it('returns an empty file-set for an unchanged boundary pair', async () => {
    const t1 = await commitTree(repo.path, 'baseline');
    const segments = await computeWindowSegments({
      repo: r,
      boundaries: [boundary(0, 1, 'open', t1), boundary(1, 1, 'close', t1)],
    });
    expect(segments[0].changedFiles).toEqual([]);
  });
});
