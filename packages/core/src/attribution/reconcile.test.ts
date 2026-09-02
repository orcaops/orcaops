import { describe, expect, it } from 'vitest';

import { reconcileCommitsAgainstCoverage } from './reconcile.js';

const commit = (sha: string, files: string[], subject = `commit ${sha}`) => ({
  sha,
  subject,
  files,
});

describe('reconcileCommitsAgainstCoverage', () => {
  it('classifies a fully-covered commit as covered', () => {
    const out = reconcileCommitsAgainstCoverage({
      commits: [commit('a', ['src/a.ts', 'src/b.ts'])],
      coverage: ['src/a.ts', 'src/b.ts', 'src/unrelated.ts'],
    });
    expect(out.uncovered_commits).toEqual([]);
    expect(out.covered_commit_count).toBe(1);
    expect(out.commits[0].uncovered_files).toEqual([]);
    expect(out.commits[0].fully_uncovered).toBe(false);
  });

  it('reports per-commit uncovered files for a partially-covered commit', () => {
    const out = reconcileCommitsAgainstCoverage({
      commits: [commit('a', ['src/claimed.ts', 'src/extra.ts'])],
      coverage: ['src/claimed.ts'],
    });
    expect(out.uncovered_commits).toHaveLength(1);
    expect(out.uncovered_commits[0].uncovered_files).toEqual(['src/extra.ts']);
    expect(out.uncovered_commits[0].fully_uncovered).toBe(false);
    expect(out.covered_commit_count).toBe(0);
  });

  it('flags a commit with zero covered files as fully uncovered', () => {
    const out = reconcileCommitsAgainstCoverage({
      commits: [commit('a', ['src/smuggled.ts'])],
      coverage: ['src/other.ts'],
    });
    expect(out.uncovered_commits[0].fully_uncovered).toBe(true);
    expect(out.uncovered_commits[0].uncovered_files).toEqual(['src/smuggled.ts']);
  });

  it('never marks a zero-file commit (merge) as fully uncovered', () => {
    const out = reconcileCommitsAgainstCoverage({
      commits: [commit('m', [], 'Merge branch x')],
      coverage: [],
    });
    expect(out.commits[0].fully_uncovered).toBe(false);
    expect(out.commits[0].uncovered_files).toEqual([]);
    expect(out.uncovered_commits).toEqual([]);
    expect(out.covered_commit_count).toBe(1);
  });

  it('handles an empty commit list', () => {
    const out = reconcileCommitsAgainstCoverage({ commits: [], coverage: ['a.ts'] });
    expect(out.commits).toEqual([]);
    expect(out.uncovered_commits).toEqual([]);
    expect(out.covered_commit_count).toBe(0);
  });

  it('empty coverage marks every non-empty commit fully uncovered', () => {
    const out = reconcileCommitsAgainstCoverage({
      commits: [commit('a', ['x.ts']), commit('b', ['y.ts'])],
      coverage: [],
    });
    expect(out.uncovered_commits).toHaveLength(2);
    expect(out.uncovered_commits.every((c) => c.fully_uncovered)).toBe(true);
  });

  it('accepts a Set for coverage and preserves input order', () => {
    const out = reconcileCommitsAgainstCoverage({
      commits: [commit('newest', ['a.ts']), commit('older', ['b.ts'])],
      coverage: new Set(['b.ts']),
    });
    expect(out.commits.map((c) => c.sha)).toEqual(['newest', 'older']);
    expect(out.uncovered_commits.map((c) => c.sha)).toEqual(['newest']);
  });
});
