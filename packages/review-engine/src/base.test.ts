import { describe, expect, it } from 'vitest';

import { chooseBase, resolveTargetAndAncestry, validateOverrideBase } from './base.js';

describe('resolveTargetAndAncestry (target-first)', () => {
  it('on-branch → live worktree tree + HEAD', () => {
    expect(
      resolveTargetAndAncestry({
        onBranch: true,
        worktreeTree: 'WT',
        worktreeHead: 'HEAD_SHA',
        latestClosed: { tree: 'CT', headSha: 'CPHEAD' },
      })
    ).toEqual({ targetTree: 'WT', ancestryRef: 'HEAD_SHA', degraded: false });
  });

  it('cross-checkout → the branch tip’s captured tree + that checkpoint’s head_sha (not HEAD)', () => {
    expect(
      resolveTargetAndAncestry({
        onBranch: false,
        worktreeTree: 'WT',
        worktreeHead: 'UNRELATED_HEAD',
        latestClosed: { tree: 'CT', headSha: 'CPHEAD' },
      })
    ).toEqual({ targetTree: 'CT', ancestryRef: 'CPHEAD', degraded: false });
  });

  it('off-branch with no captured target → degraded fallback to the current checkout', () => {
    expect(
      resolveTargetAndAncestry({
        onBranch: false,
        worktreeTree: 'WT',
        worktreeHead: 'HEAD_SHA',
        latestClosed: null,
      })
    ).toEqual({ targetTree: 'WT', ancestryRef: 'HEAD_SHA', degraded: true });
  });
});

describe('chooseBase', () => {
  const base = {
    mergeBaseTree: null,
    targetTree: 'T',
    oldestArtifactBaseTree: null,
    fallbackTree: 'F',
  };

  it('clean branch → merge-base is preferred', () => {
    const r = chooseBase({ ...base, mergeBaseTree: 'MB', oldestArtifactBaseTree: 'OLD' });
    expect(r).toMatchObject({ baseTree: 'MB', source: 'merge_base' });
    expect(r.disclosures).toEqual([]);
  });

  it('rebased-unmerged → merge-base (post-rebase) beats oldest-artifact base (pre-rebase), excluding the rebase delta', () => {
    const r = chooseBase({ ...base, mergeBaseTree: 'MB_POST', oldestArtifactBaseTree: 'OLD_PRE' });
    expect(r.baseTree).toBe('MB_POST'); // NOT OLD_PRE — the fix's whole point
    expect(r.source).toBe('merge_base');
  });

  it('merged (degenerate: merge-base tree == target) → falls back to oldest + degenerate_scope disclosure', () => {
    const r = chooseBase({ ...base, mergeBaseTree: 'T', oldestArtifactBaseTree: 'OLD' });
    expect(r).toMatchObject({ baseTree: 'OLD', source: 'oldest_artifact' });
    expect(r.disclosures.map((d) => d.code)).toEqual(['degenerate_scope']);
  });

  it('merged flagged by ancestry (tip is ancestor of default; tree differs by post-checkpoint drift) → oldest + disclosure', () => {
    // The merged-with-drift case: merge-base tree != target, but the branch is merged.
    const r = chooseBase({
      ...base,
      mergeBaseTree: 'MB_TIP',
      mergeBaseDegenerate: true,
      oldestArtifactBaseTree: 'OLD',
    });
    expect(r).toMatchObject({ baseTree: 'OLD', source: 'oldest_artifact' });
    expect(r.disclosures.map((d) => d.code)).toEqual(['degenerate_scope']);
  });

  it('override always wins', () => {
    const r = chooseBase({ ...base, overrideTree: 'OVR', mergeBaseTree: 'MB' });
    expect(r).toMatchObject({ baseTree: 'OVR', source: 'override' });
  });

  it('no merge-base → oldest-artifact base, no disclosure', () => {
    const r = chooseBase({ ...base, mergeBaseTree: null, oldestArtifactBaseTree: 'OLD' });
    expect(r).toMatchObject({ baseTree: 'OLD', source: 'oldest_artifact' });
    expect(r.disclosures).toEqual([]);
  });

  it('everything degenerate/absent → branch-scoped fallback', () => {
    const r = chooseBase({
      ...base,
      mergeBaseTree: 'T',
      oldestArtifactBaseTree: 'T',
      fallbackTree: 'F',
    });
    expect(r).toMatchObject({ baseTree: 'F', source: 'fallback' });
    expect(r.disclosures.map((d) => d.code)).toEqual(['degenerate_scope']);
  });
});

describe('validateOverrideBase', () => {
  it('throws on an unresolvable explicit --base (a typo must not silently fall through)', () => {
    expect(() => validateOverrideBase('typo-not-a-ref', null)).toThrow(/invalid --base/);
  });

  it('accepts a --base that resolved to a tree', () => {
    expect(() => validateOverrideBase('good-ref', 'TREE')).not.toThrow();
  });

  it('is a no-op when no --base was given', () => {
    expect(() => validateOverrideBase(undefined, null)).not.toThrow();
    expect(() => validateOverrideBase('', null)).not.toThrow();
  });
});
