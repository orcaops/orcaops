import { describe, expect, it, vi } from 'vitest';

import {
  chronologicalOrderForAnchors,
  classifyRangeRelationship,
  type RangeAnchor,
  resolveBranchDigestRange,
} from './range-artifacts.js';

const anchors: RangeAnchor[] = [{ source: 'summary', head_sha: 'artifact-head' }];

describe('classifyRangeRelationship', () => {
  it('distinguishes all four Git evidence outcomes', async () => {
    const check = vi.fn();
    await expect(
      classifyRangeRelationship({
        anchors,
        rangeShas: new Set(['artifact-head']),
        headSha: 'branch-head',
        checkReachability: check,
      })
    ).resolves.toBe('in_range');
    expect(check).not.toHaveBeenCalled();

    await expect(
      classifyRangeRelationship({
        anchors,
        rangeShas: new Set(),
        headSha: 'branch-head',
        checkReachability: async () => 'reachable',
      })
    ).resolves.toBe('reachable_out_of_range');
    await expect(
      classifyRangeRelationship({
        anchors,
        rangeShas: new Set(),
        headSha: 'branch-head',
        checkReachability: async () => 'unreachable',
      })
    ).resolves.toBe('unreachable_from_head');
    await expect(
      classifyRangeRelationship({
        anchors,
        rangeShas: new Set(),
        headSha: 'branch-head',
        checkReachability: async () => 'unknown',
      })
    ).resolves.toBe('unverifiable');
    await expect(
      classifyRangeRelationship({
        anchors: [],
        rangeShas: new Set(),
        headSha: 'branch-head',
        checkReachability: async () => 'reachable',
      })
    ).resolves.toBe('unverifiable');
  });
});

describe('chronologicalOrderForAnchors', () => {
  it('returns the earliest matched commit position', () => {
    expect(
      chronologicalOrderForAnchors(
        [
          { source: 'checkpoint', n: 1, head_sha: 'later' },
          { source: 'summary', head_sha: 'earlier' },
        ],
        new Map([
          ['earlier', 2],
          ['later', 5],
        ])
      )
    ).toBe(2);
  });

  it('fails clearly when a matched anchor has no chronological position', () => {
    expect(() =>
      chronologicalOrderForAnchors([{ source: 'pre_pr', head_sha: 'missing' }], new Map())
    ).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });
});

type CommitState =
  | { status: 'resolved'; sha: string }
  | { status: 'absent' }
  | { status: 'unknown' };

function rangeContext(refs: Readonly<Record<string, CommitState | undefined>>) {
  return {
    repo: {
      getCurrentBranch: vi.fn(async () => 'feature'),
      branchPresence: vi.fn(async () => 'present' as const),
      resolveCommitState: vi.fn(async (ref: string) => refs[ref] ?? { status: 'absent' }),
      resolveMergeBase: vi.fn(async () => ({ status: 'resolved' as const, sha: 'merge-base' })),
    },
  };
}

describe('resolveBranchDigestRange default base', () => {
  it.each([
    {
      name: 'origin HEAD',
      refs: {
        'refs/heads/feature': { status: 'resolved', sha: 'head' },
        'refs/remotes/origin/HEAD': { status: 'resolved', sha: 'origin-head' },
      } satisfies Record<string, CommitState>,
      base: 'refs/remotes/origin/HEAD',
      baseSha: 'origin-head',
    },
    {
      name: 'local main',
      refs: {
        'refs/heads/feature': { status: 'resolved', sha: 'head' },
        'refs/heads/main': { status: 'resolved', sha: 'main-head' },
      } satisfies Record<string, CommitState>,
      base: 'refs/heads/main',
      baseSha: 'main-head',
    },
    {
      name: 'local master',
      refs: {
        'refs/heads/feature': { status: 'resolved', sha: 'head' },
        'refs/heads/master': { status: 'resolved', sha: 'master-head' },
      } satisfies Record<string, CommitState>,
      base: 'refs/heads/master',
      baseSha: 'master-head',
    },
  ])('discovers $name', async ({ refs, base, baseSha }) => {
    const ctx = rangeContext(refs);
    await expect(
      resolveBranchDigestRange({ ctx: ctx as never, branch: 'feature' })
    ).resolves.toEqual({
      branch: 'feature',
      head_ref: 'refs/heads/feature',
      head_sha: 'head',
      base,
      base_sha: baseSha,
      merge_base: 'merge-base',
    });
  });

  it.each([
    {
      name: 'both local names exist',
      refs: {
        'refs/heads/feature': { status: 'resolved', sha: 'head' },
        'refs/heads/main': { status: 'resolved', sha: 'main-head' },
        'refs/heads/master': { status: 'resolved', sha: 'master-head' },
      } satisfies Record<string, CommitState>,
    },
    {
      name: 'neither local name exists',
      refs: {
        'refs/heads/feature': { status: 'resolved', sha: 'head' },
      } satisfies Record<string, CommitState>,
    },
  ])('requires an explicit base when $name', async ({ refs }) => {
    const ctx = rangeContext(refs);
    await expect(
      resolveBranchDigestRange({ ctx: ctx as never, branch: 'feature' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([
    {
      name: 'origin HEAD cannot be inspected',
      refs: {
        'refs/heads/feature': { status: 'resolved', sha: 'head' },
        'refs/remotes/origin/HEAD': { status: 'unknown' },
      } satisfies Record<string, CommitState>,
    },
    {
      name: 'a local fallback cannot be inspected',
      refs: {
        'refs/heads/feature': { status: 'resolved', sha: 'head' },
        'refs/heads/main': { status: 'unknown' },
      } satisfies Record<string, CommitState>,
    },
  ])('reports an operational error when $name', async ({ refs }) => {
    const ctx = rangeContext(refs);
    await expect(
      resolveBranchDigestRange({ ctx: ctx as never, branch: 'feature' })
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
