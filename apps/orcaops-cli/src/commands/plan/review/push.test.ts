import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type SourcePlanReviewProposeResponse,
  type SourcePlanReviewPushResponse,
  TrpcRequestError,
} from '@orcaops/sdk';
import { readReviewCandidate, readReviewProposal, sourcePlanCacheDir } from '@orcaops/storage';

import { reviewPushAction, type ReviewPushClient, runReviewPush } from './push.js';
import { seedCandidate } from './test-helpers.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const EDITED = '# edited\n\nnew body';

const published = (vid: string | null, vn: number | null): SourcePlanReviewPushResponse => ({
  status: 'published',
  externalId: 'ext-1',
  candidateVersionId: vid,
  candidateVersionNumber: vn,
  contentHash: sha(EDITED),
});
const conflict = (vn: number): SourcePlanReviewPushResponse => ({
  status: 'conflict',
  conflict: { current_candidate_version_id: `ver_${vn}`, current_version_number: vn },
});
const proposed = (proposalId: string): SourcePlanReviewProposeResponse => ({
  externalId: 'ext-1',
  proposalId,
  baseVersionId: 'ver_4',
  needsRebase: true,
});

function pushClient(over: Partial<ReviewPushClient['sourcePlan']> = {}): ReviewPushClient {
  return {
    sourcePlan: {
      reviewPush: vi.fn(async () => published('ver_5', 5)),
      reviewPropose: vi.fn(async () => proposed('prop_1')),
      ...over,
    },
  };
}

describe('runReviewPush', () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-review-push-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const base = (root: string) => ({
    repoRoot: root,
    baseUrl: 'https://cloud.example',
    orgId: 'org_1',
    externalId: 'ext-1',
    body: EDITED,
    pulledAt: '2026-06-09T00:00:00.000Z',
  });

  it('action rejects a dirty body before credential resolution', async () => {
    // No seeded credentials, no cloud: the hoisted gate must fire on the
    // body alone. Without the hoist, withReviewCloud's credential/base-url
    // resolution and ping would produce a different error first.
    const bodyPath = path.join(repoRoot, 'dirty.md');
    await writeFile(bodyPath, `# Plan\n\nbody\u0085tail`, 'utf8');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(reviewPushAction('ext-1', { input: bodyPath, json: true })).rejects.toThrow();
      const emitted = stdout.mock.calls.map((c) => String(c[0])).join('');
      expect(emitted).toMatch(/U\+0085 at offset 12/);
    } finally {
      stdout.mockRestore();
    }
  });

  it('rejects a body with a forbidden control character before any wire call', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    let called = 0;
    const client = {
      sourcePlan: {
        reviewPush: async () => {
          called += 1;
          throw new Error('must not reach the wire');
        },
      },
    } as never;
    await expect(
      runReviewPush({
        client,
        onConflict: 'fail',
        ...base(repoRoot),
        body: `# Plan\n\nbody\u0085tail`,
      })
    ).rejects.toThrow(/U\+0085 at offset 12/);
    expect(called).toBe(0);
  });

  it('published: overwrites the local candidate record with the new version', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const result = await runReviewPush({
      client: pushClient(),
      onConflict: 'fail',
      ...base(repoRoot),
    });
    expect(result.status).toBe('published');
    expect(result.candidate_version_number).toBe(5);
    const rec = await readReviewCandidate(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'ext-1'
    );
    expect(rec?.version_id).toBe('ver_5');
    expect(rec?.version_number).toBe(5);
    expect(rec?.body).toBe(EDITED);
  });

  it('sends expected_candidate_version_id + raw content_hash from the cached candidate', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewPush = vi.fn(async () => published('ver_5', 5));
    await runReviewPush({
      client: pushClient({ reviewPush }),
      onConflict: 'fail',
      ...base(repoRoot),
    });
    expect(reviewPush).toHaveBeenCalledWith(
      expect.objectContaining({ expected_candidate_version_id: 'ver_4', content_hash: sha(EDITED) })
    );
  });

  it('ships the authoring baseline on the push wire call (null when unresolved)', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const baseline = {
      repo_url: 'https://github.com/foo/bar',
      branch: 'main',
      head_sha: 'ab12f3e',
    };
    const reviewPush = vi.fn(async () => published('ver_5', 5));
    await runReviewPush({
      client: pushClient({ reviewPush }),
      onConflict: 'fail',
      baseline,
      ...base(repoRoot),
    });
    expect(reviewPush).toHaveBeenCalledWith(expect.objectContaining({ baseline }));

    const bare = vi.fn(async () => published('ver_6', 6));
    await runReviewPush({
      client: pushClient({ reviewPush: bare }),
      onConflict: 'fail',
      ...base(repoRoot),
    });
    expect(bare).toHaveBeenCalledWith(expect.objectContaining({ baseline: null }));
  });

  it('carries the same baseline onto the conflict-conversion propose (provenance survives)', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const baseline = {
      repo_url: 'https://github.com/foo/bar',
      branch: 'main',
      head_sha: 'ab12f3e',
    };
    const reviewPush = vi.fn(async () => conflict(5));
    const reviewPropose = vi.fn(async () => proposed('prop_9'));
    await runReviewPush({
      client: pushClient({ reviewPush, reviewPropose }),
      onConflict: 'propose',
      baseline,
      ...base(repoRoot),
    });
    expect(reviewPropose).toHaveBeenCalledWith(expect.objectContaining({ baseline }));
  });

  it('published with a null candidate version reports published but does NOT advance the record', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewPush = vi.fn(async () => published(null, null));
    const result = await runReviewPush({
      client: pushClient({ reviewPush }),
      onConflict: 'fail',
      ...base(repoRoot),
    });
    expect(result.status).toBe('published');
    // The skip-the-write fail-safe: a null version can't advance the CAS token, so
    // the seeded ver_4 stays — the next op re-pulls rather than trusting a gap.
    const rec = await readReviewCandidate(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'ext-1'
    );
    expect(rec?.version_id).toBe('ver_4');
  });

  it('conflict + fail: throws REVIEW_PUSH_CONFLICT carrying current_version_number, record un-advanced', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewPush = vi.fn(async () => conflict(9));
    const err = await runReviewPush({
      client: pushClient({ reviewPush }),
      onConflict: 'fail',
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({
      code: 'REVIEW_PUSH_CONFLICT',
      details: { current_version_number: 9 },
    });
    // The local record is NOT advanced — push fails closed, the user re-pulls.
    const rec = await readReviewCandidate(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'ext-1'
    );
    expect(rec?.version_id).toBe('ver_4');
  });

  it('conflict + propose: re-files the SAME body as a proposal based on expected', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewPush = vi.fn(async () => conflict(9));
    const reviewPropose = vi.fn(async () => proposed('prop_77'));
    const result = await runReviewPush({
      client: pushClient({ reviewPush, reviewPropose }),
      onConflict: 'propose',
      ...base(repoRoot),
    });
    expect(result.status).toBe('filed_as_proposal');
    expect(result.proposal_id).toBe('prop_77');
    expect(result.current_version_number).toBe(9);
    expect(reviewPropose).toHaveBeenCalledWith(
      expect.objectContaining({ base_version_id: 'ver_4', body: EDITED })
    );
    const prop = await readReviewProposal(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'prop_77'
    );
    expect(prop?.proposal_id).toBe('prop_77');
  });

  it('maps a non-author FORBIDDEN to the friendly author-only message', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewPush = vi.fn(async () => {
      throw new TrpcRequestError('forbidden', { code: 'FORBIDDEN', httpStatus: 403 });
    });
    const err = await runReviewPush({
      client: pushClient({ reviewPush }),
      onConflict: 'fail',
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'CLOUD_ERROR' });
    expect((err as Error).message).toMatch(/only the plan author/i);
  });

  it('maps an APPROVED/PINNED CONFLICT (thrown) to "no longer in review"', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewPush = vi.fn(async () => {
      throw new TrpcRequestError('conflict', { code: 'CONFLICT', httpStatus: 409 });
    });
    const err = await runReviewPush({
      client: pushClient({ reviewPush }),
      onConflict: 'fail',
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/no longer in review/i);
  });

  it('hard-errors NO_INPUT with no local record; --base-version-id bypasses the cache read', async () => {
    const noRecord = await runReviewPush({
      client: pushClient(),
      onConflict: 'fail',
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(noRecord).toMatchObject({ code: 'NO_INPUT' });

    const reviewPush = vi.fn(async () => published('ver_2', 2));
    const result = await runReviewPush({
      client: pushClient({ reviewPush }),
      onConflict: 'fail',
      baseVersionIdOverride: 'ver_override',
      ...base(repoRoot),
    });
    expect(result.status).toBe('published');
    expect(reviewPush).toHaveBeenCalledWith(
      expect.objectContaining({ expected_candidate_version_id: 'ver_override' })
    );
  });
});
