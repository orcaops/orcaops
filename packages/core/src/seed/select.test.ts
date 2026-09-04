import { describe, expect, it } from 'vitest';

import { createHistoryRepo, gitClient } from '@orcaops/test-harness';

import type { SeedCluster } from './cluster.js';
import {
  defaultSeedSince,
  loadSeedHistory,
  resolveSeedBranch,
  selectSeedClusters,
} from './select.js';
import { Repo } from '../git/repo.js';

function cluster(index: number, commits: number, date: string): SeedCluster {
  return {
    key: `run:${index}`,
    kind: 'run',
    label: `cluster ${index}`,
    baseSha: `${index}`.padEnd(40, '0'),
    headSha: `${index + 1}`.padEnd(40, '0'),
    commits: Array.from({ length: commits }, (_, member) => ({
      sha: `${index}-${member}`.padEnd(40, '0'),
      parentShas: [],
      authorEmail: 'dev@example.com',
      committerDateIso: date,
      subject: `commit ${member}`,
      body: '',
      files: ['src/file.ts'],
    })),
    checkpoints: [],
    authors: ['dev@example.com'],
    files: ['src/file.ts'],
    firstParentPosition: index,
    displayDateIso: date,
    latestCommitDateIso: date,
    conventionalType: null,
    conventionalScope: null,
    warnings: [],
  };
}

describe('selectSeedClusters', () => {
  it('uses a six-month UTC cutoff snapped to the day boundary', () => {
    expect(defaultSeedSince(new Date('2025-08-31T12:00:00.000Z'))).toBe('2025-02-28T00:00:00.000Z');
  });

  it('yields one stable cutoff for every clock reading within a UTC day', () => {
    expect(defaultSeedSince(new Date('2026-08-17T20:52:03.240Z'))).toBe(
      defaultSeedSince(new Date('2026-08-17T23:59:59.999Z'))
    );
  });

  it('takes newest whole clusters and discloses commit and artifact truncation', () => {
    const clusters = [
      cluster(0, 4, '2025-01-02T00:00:00.000Z'),
      cluster(1, 4, '2025-01-03T00:00:00.000Z'),
      cluster(2, 4, '2025-01-04T00:00:00.000Z'),
    ];
    const byCommits = selectSeedClusters(clusters, {
      sinceIso: '2025-01-01T00:00:00.000Z',
      recencyCommitCap: 8,
    });
    expect(byCommits.clusters.map((item) => item.key)).toEqual(['run:1', 'run:2']);
    expect(byCommits).toMatchObject({
      selectedCommitCount: 8,
      truncatedByCommitCap: true,
      truncatedClusterCount: 1,
      truncatedCommitCount: 4,
    });

    const byArtifacts = selectSeedClusters(clusters, {
      sinceIso: '2025-01-01T00:00:00.000Z',
      artifactCeiling: 2,
      recencyCommitCap: 20,
    });
    expect(byArtifacts.clusters.map((item) => item.key)).toEqual(['run:1', 'run:2']);
    expect(byArtifacts.truncatedByArtifactCeiling).toBe(true);
    expect(byArtifacts.truncatedClusterCount).toBe(1);
    expect(byArtifacts.truncatedCommitCount).toBe(4);
  });

  it('reports zero beyond-budget counts when everything eligible was selected', () => {
    const selection = selectSeedClusters([cluster(0, 4, '2025-01-02T00:00:00.000Z')], {
      sinceIso: '2025-01-01T00:00:00.000Z',
    });
    expect(selection.truncatedClusterCount).toBe(0);
    expect(selection.truncatedCommitCount).toBe(0);
  });

  it('selects targeted old commits without reshaping their canonical cluster', () => {
    const old = cluster(0, 3, '2020-01-01T00:00:00.000Z');
    const selection = selectSeedClusters([old], {
      sinceIso: '2025-01-01T00:00:00.000Z',
      commit: old.commits[1]!.sha.slice(0, 7),
    });
    expect(selection.clusters).toEqual([old]);
    expect(selection.selectedCommitCount).toBe(3);
    expect(selection.windowExcludedClusterCount).toBe(0);
  });

  it('enforces an explicit since on targeted selection and counts the exclusion', () => {
    const old = cluster(0, 3, '2020-01-01T00:00:00.000Z');
    const selection = selectSeedClusters([old], {
      sinceIso: '2025-01-01T00:00:00.000Z',
      sinceExplicit: true,
      commit: old.commits[1]!.sha.slice(0, 7),
    });
    expect(selection.clusters).toEqual([]);
    expect(selection.windowExcludedClusterCount).toBe(1);
  });
});

describe('seed history discovery', () => {
  it('prefers origin/HEAD and expands merge history canonically', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', files: { 'root.ts': 'root\n' } },
      { type: 'branch', name: 'feature' },
      { type: 'checkout', branch: 'feature' },
      { type: 'commit', label: 'side', files: { 'side.ts': 'side\n' } },
      { type: 'checkout', branch: 'main' },
      { type: 'merge', label: 'merge', branch: 'feature' },
    ]);
    try {
      await gitClient(history.path).raw(['remote', 'add', 'origin', history.path]);
      await gitClient(history.path).raw([
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/main',
      ]);
      await gitClient(history.path).raw([
        'update-ref',
        'refs/remotes/origin/main',
        history.shas.merge!,
      ]);
      const repo = new Repo(history.path);
      expect(await resolveSeedBranch(repo)).toMatchObject({
        ref: 'origin/main',
        source: 'origin-head',
      });
      const loaded = await loadSeedHistory(repo, {
        sinceIso: '2024-01-01T00:00:00.000Z',
      });
      expect(loaded.clusters.find((item) => item.kind === 'merge')?.commits).toHaveLength(1);
      expect(loaded.checkedOut).toMatchObject({
        branch: 'main',
        headSha: history.shas.merge,
        excludedCommitCount: 0,
        fullyRepresented: true,
      });
    } finally {
      await history.cleanup();
    }
  });

  it('reports commits on the checked-out branch that the selected ref excludes', async () => {
    const history = await createHistoryRepo([
      { type: 'commit', label: 'root', files: { 'root.ts': 'root\n' } },
      { type: 'branch', name: 'feature' },
      { type: 'checkout', branch: 'feature' },
      { type: 'commit', label: 'ahead', files: { 'ahead.ts': 'ahead\n' } },
    ]);
    try {
      const loaded = await loadSeedHistory(new Repo(history.path), {
        branch: 'main',
        sinceIso: '2024-01-01T00:00:00.000Z',
      });
      expect(loaded.checkedOut).toMatchObject({
        branch: 'feature',
        headSha: history.shas.ahead,
        excludedCommitCount: 1,
        fullyRepresented: false,
      });
    } finally {
      await history.cleanup();
    }
  });

  it('keeps out-of-window merge members when a commit is targeted', async () => {
    const history = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: root',
        committerDate: '2020-01-01T00:00:00.000Z',
        files: { 'root.ts': 'root\n' },
      },
      { type: 'branch', name: 'feature', from: 'root' },
      { type: 'checkout', branch: 'feature' },
      {
        type: 'commit',
        label: 'side',
        subject: 'feat: legacy side work',
        committerDate: '2020-01-02T00:00:00.000Z',
        files: { 'legacy/old.ts': 'export const old = true;\n' },
      },
      { type: 'checkout', branch: 'main' },
      {
        type: 'merge',
        label: 'merge',
        branch: 'feature',
        committerDate: '2020-01-03T00:00:00.000Z',
      },
      {
        type: 'commit',
        label: 'recent',
        subject: 'feat: recent work',
        committerDate: '2026-08-01T00:00:00.000Z',
        files: { 'src/current.ts': 'export const current = true;\n' },
      },
    ]);
    try {
      const loaded = await loadSeedHistory(new Repo(history.path), {
        sinceIso: '2026-01-01T00:00:00.000Z',
        commit: history.shas.side!,
      });
      expect(loaded.clusters).toHaveLength(1);
      expect(loaded.clusters[0]!.commits.map((commit) => commit.sha)).toEqual([history.shas.side]);
    } finally {
      await history.cleanup();
    }
  });

  it('refuses detached HEAD when no default branch candidates exist', async () => {
    const history = await createHistoryRepo(
      [{ type: 'commit', label: 'root', files: { 'root.ts': 'root\n' } }],
      { initialBranch: 'topic' }
    );
    try {
      await gitClient(history.path).checkout(history.shas.root!);
      await expect(resolveSeedBranch(new Repo(history.path))).rejects.toThrow('detached HEAD');
    } finally {
      await history.cleanup();
    }
  });

  it('reports an unborn repository explicitly', async () => {
    const history = await createHistoryRepo([], { initialBranch: 'topic' });
    try {
      await expect(resolveSeedBranch(new Repo(history.path))).rejects.toThrow(
        'no commits yet — nothing to seed'
      );
    } finally {
      await history.cleanup();
    }
  });
});
