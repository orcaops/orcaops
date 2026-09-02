import { describe, expect, it } from 'vitest';

import { createHistoryRepo } from '@orcaops/test-harness';

import type { SeedCluster } from './cluster.js';
import { rankSeedImportance, selectImportanceClusters } from './importance.js';
import { Repo } from '../git/repo.js';

function cluster(key: string, shas: string[], position: number): SeedCluster {
  const commits = shas.map((sha, index) => ({
    sha,
    parentShas: [],
    authorEmail: 'dev@example.com',
    committerDateIso: `2025-01-01T00:0${index}:00.000Z`,
    subject: key,
    body: '',
    files: [`${key}.ts`],
  }));
  return {
    key,
    kind: 'run',
    label: key,
    baseSha: shas[0]!,
    headSha: shas.at(-1)!,
    commits,
    checkpoints: [],
    authors: ['dev@example.com'],
    files: [`${key}.ts`],
    firstParentPosition: position,
    displayDateIso: '2025-01-01T00:00:00.000Z',
    latestCommitDateIso: '2025-01-01T00:00:00.000Z',
    conventionalType: null,
    conventionalScope: null,
    warnings: [],
  };
}

describe('rankSeedImportance', () => {
  it('uses blame line ownership, scopes paths, and filters vendored files', async () => {
    const history = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        files: {
          'src/a.ts': 'one\ntwo\nthree\n',
          'vendor/library.js': 'vendored\n',
        },
      },
      {
        type: 'commit',
        label: 'next',
        files: { 'src/b.ts': 'four\nfive\n' },
      },
    ]);
    try {
      const repo = new Repo(history.path);
      const commits = await repo.logDetailed('main');
      const ranking = await rankSeedImportance(repo, {
        branchSha: history.shas.next!,
        commits,
        historyCommitCount: commits.length,
        path: 'src',
        force: true,
      });
      expect(ranking.status).toBe('complete');
      expect(ranking.ownership.map((file) => file.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(ranking.lineMassByCommit.get(history.shas.root!)).toBe(3);
      expect(ranking.lineMassByCommit.get(history.shas.next!)).toBe(2);
    } finally {
      await history.cleanup();
    }
  });

  it('defers before blame on histories above the guard unless forced', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', files: { 'src/a.ts': 'one\n' } },
    ]);
    try {
      const repo = new Repo(history.path);
      const ranking = await rankSeedImportance(repo, {
        branchSha: history.shas.root!,
        commits: await repo.logDetailed('main'),
        historyCommitCount: 150_001,
      });
      expect(ranking).toMatchObject({ status: 'deferred', reason: 'large-history' });
      expect(ranking.ownership).toEqual([]);
      const forced = await rankSeedImportance(repo, {
        branchSha: history.shas.root!,
        commits: await repo.logDetailed('main'),
        historyCommitCount: 150_001,
        force: true,
      });
      expect(forced).toMatchObject({ status: 'complete', reason: null });
    } finally {
      await history.cleanup();
    }
  });
});

describe('selectImportanceClusters', () => {
  it('ranks by living-line mass, excludes recency clusters, and enforces expanded budgets', () => {
    const recent = cluster('recent', ['a'.repeat(40)], 0);
    const large = cluster('large', ['b'.repeat(40), 'c'.repeat(40)], 1);
    const fitting = cluster('fitting', ['d'.repeat(40)], 2);
    const result = selectImportanceClusters(
      [recent, large, fitting],
      new Map([
        [recent.commits[0]!.sha, 100],
        [large.commits[0]!.sha, 90],
        [fitting.commits[0]!.sha, 80],
      ]),
      { maxCommits: 1, excludedClusterKeys: new Set([recent.key]) }
    );
    expect(result.clusters.map((item) => item.key)).toEqual(['fitting']);
    expect(result).toMatchObject({
      selectedCommitCount: 1,
      candidateCommitCount: 3,
      truncated: true,
    });
    const artifactBound = selectImportanceClusters(
      [large, fitting],
      new Map([
        [large.commits[0]!.sha, 90],
        [fitting.commits[0]!.sha, 80],
      ]),
      { maxCommits: 10, maxClusters: 1 }
    );
    expect(artifactBound.clusters.map((item) => item.key)).toEqual(['large']);
    expect(artifactBound.truncated).toBe(true);
  });
});
