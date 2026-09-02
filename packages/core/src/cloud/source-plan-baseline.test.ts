import { describe, expect, expectTypeOf, it } from 'vitest';

import { OssSourcePlanBaseline } from '@orcaops/protocol';
import { type SourcePlanBaseline, SourcePlanBaselineSchema } from '@orcaops/storage';

import {
  type BaselineRepo,
  resolveReviewBaseline,
  resolveWireRepoUrl,
} from './source-plan-baseline.js';

function fakeRepo(over: Partial<BaselineRepo> = {}): BaselineRepo {
  return {
    getRemoteUrl: async () => 'https://github.com/foo/bar.git',
    getCurrentBranch: async () => 'main',
    getHeadSha: async () => 'ab12f3e0000000000000000000000000000000ff',
    ...over,
  };
}

describe('resolveWireRepoUrl', () => {
  it('canonicalizes an SSH-alias remote via the injected resolver', async () => {
    const repo = fakeRepo({ getRemoteUrl: async () => 'git@github.com-work:foo/bar.git' });
    const url = await resolveWireRepoUrl(repo, async () => 'github.com');
    expect(url).toBe('git@github.com:foo/bar.git');
  });

  it('returns null when no remote is configured', async () => {
    expect(await resolveWireRepoUrl(fakeRepo({ getRemoteUrl: async () => null }))).toBeNull();
  });

  it('degrades to the raw URL when alias resolution fails', async () => {
    const repo = fakeRepo({ getRemoteUrl: async () => 'git@github.com-work:foo/bar.git' });
    const url = await resolveWireRepoUrl(repo, async () => {
      throw new Error('ssh exploded');
    });
    expect(url).toBe('git@github.com-work:foo/bar.git');
  });

  it('returns null (never rejects) when the remote read itself throws', async () => {
    const repo = fakeRepo({
      getRemoteUrl: async () => {
        throw new Error('not a repo');
      },
    });
    await expect(resolveWireRepoUrl(repo)).resolves.toBeNull();
  });
});

describe('resolveReviewBaseline', () => {
  it('resolves all three components on a healthy worktree', async () => {
    const baseline = await resolveReviewBaseline(fakeRepo(), async () => null);
    expect(baseline).toEqual({
      repo_url: 'https://github.com/foo/bar.git',
      branch: 'main',
      head_sha: 'ab12f3e0000000000000000000000000000000ff',
    });
  });

  it('nulls the branch on a detached HEAD (the literal "HEAD" abbrev-ref)', async () => {
    const baseline = await resolveReviewBaseline(
      fakeRepo({ getCurrentBranch: async () => 'HEAD' }),
      async () => null
    );
    expect(baseline?.branch).toBeNull();
    expect(baseline?.head_sha).not.toBeNull();
  });

  it('nulls only repo_url when no remote is configured', async () => {
    const baseline = await resolveReviewBaseline(
      fakeRepo({ getRemoteUrl: async () => null }),
      async () => null
    );
    expect(baseline).toEqual({
      repo_url: null,
      branch: 'main',
      head_sha: 'ab12f3e0000000000000000000000000000000ff',
    });
  });

  it('nulls only head_sha on an empty repo (rev-parse HEAD throws)', async () => {
    const baseline = await resolveReviewBaseline(
      fakeRepo({
        getHeadSha: async () => {
          throw new Error('unknown revision HEAD');
        },
      }),
      async () => null
    );
    expect(baseline).toEqual({
      repo_url: 'https://github.com/foo/bar.git',
      branch: 'main',
      head_sha: null,
    });
  });

  it('nulls each component independently when its getter throws', async () => {
    const baseline = await resolveReviewBaseline(
      fakeRepo({
        getCurrentBranch: async () => {
          throw new Error('boom');
        },
      }),
      async () => null
    );
    expect(baseline?.branch).toBeNull();
    expect(baseline?.repo_url).not.toBeNull();
  });

  it('collapses to a null baseline when every component fails', async () => {
    const explode = async (): Promise<never> => {
      throw new Error('not a repo');
    };
    const repo: BaselineRepo = {
      getRemoteUrl: explode,
      getCurrentBranch: explode,
      getHeadSha: explode,
    };
    await expect(resolveReviewBaseline(repo)).resolves.toBeNull();
  });

  it('treats empty-string branch and sha as absent', async () => {
    const baseline = await resolveReviewBaseline(
      fakeRepo({ getCurrentBranch: async () => '  ', getHeadSha: async () => '' }),
      async () => null
    );
    expect(baseline).toEqual({
      repo_url: 'https://github.com/foo/bar.git',
      branch: null,
      head_sha: null,
    });
  });

  it('nulls a component the wire schema would reject (over-cap), keeping the rest', async () => {
    // Git permits slash-separated refs past the wire's branch cap; an
    // un-clamped over-cap component would freeze immutably into the pin
    // and permanently fail the attach parse in background sync.
    const baseline = await resolveReviewBaseline(
      fakeRepo({ getCurrentBranch: async () => 'feature/'.repeat(40) }),
      async () => null
    );
    expect(baseline).toEqual({
      repo_url: 'https://github.com/foo/bar.git',
      branch: null,
      head_sha: 'ab12f3e0000000000000000000000000000000ff',
    });
  });

  it('clamps an over-cap repo_url independently too', async () => {
    const baseline = await resolveReviewBaseline(
      fakeRepo({ getRemoteUrl: async () => `https://example.com/${'x'.repeat(2100)}` }),
      async () => null
    );
    expect(baseline).toEqual({
      repo_url: null,
      branch: 'main',
      head_sha: 'ab12f3e0000000000000000000000000000000ff',
    });
  });

  it('collapses to a null baseline when every component is over-cap or absent', async () => {
    const baseline = await resolveReviewBaseline(
      fakeRepo({
        getRemoteUrl: async () => null,
        getCurrentBranch: async () => 'x'.repeat(300),
        getHeadSha: async () => 'f'.repeat(100),
      }),
      async () => null
    );
    expect(baseline).toBeNull();
  });
});

describe('storage ↔ protocol baseline contract', () => {
  // @orcaops/storage must not depend on @orcaops/protocol, so its
  // SourcePlanBaselineSchema is a hand-maintained structural mirror of
  // OssSourcePlanBaseline. Core depends on BOTH, so this is the one
  // place drift can be converted into a failure instead of a silent
  // strip at writePlan's parse boundary.
  it('key sets are identical', () => {
    expect(Object.keys(SourcePlanBaselineSchema.shape).sort()).toEqual(
      Object.keys(OssSourcePlanBaseline.shape).sort()
    );
  });

  it('shapes are mutually assignable', () => {
    expectTypeOf<SourcePlanBaseline>().toExtend<OssSourcePlanBaseline>();
    expectTypeOf<OssSourcePlanBaseline>().toExtend<SourcePlanBaseline>();
  });

  it('pins the wire caps the resolver clamps against (conscious update on a protocol change)', () => {
    expect(OssSourcePlanBaseline.shape.repo_url.safeParse('x'.repeat(2048)).success).toBe(true);
    expect(OssSourcePlanBaseline.shape.repo_url.safeParse('x'.repeat(2049)).success).toBe(false);
    expect(OssSourcePlanBaseline.shape.branch.safeParse('x'.repeat(255)).success).toBe(true);
    expect(OssSourcePlanBaseline.shape.branch.safeParse('x'.repeat(256)).success).toBe(false);
    expect(OssSourcePlanBaseline.shape.head_sha.safeParse('x'.repeat(64)).success).toBe(true);
    expect(OssSourcePlanBaseline.shape.head_sha.safeParse('x'.repeat(65)).success).toBe(false);
  });

  it('a storage-valid baseline parses on the wire and vice versa', () => {
    const populated = {
      repo_url: 'https://github.com/acme/widgets',
      branch: 'main',
      head_sha: 'a'.repeat(40),
    };
    expect(OssSourcePlanBaseline.parse(populated)).toEqual(populated);
    expect(SourcePlanBaselineSchema.parse(populated)).toEqual(populated);
  });
});
