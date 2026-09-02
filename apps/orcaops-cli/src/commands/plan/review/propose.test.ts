import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type SourcePlanReviewProposeResponse, TrpcRequestError } from '@orcaops/sdk';
import { readReviewProposal, sourcePlanCacheDir } from '@orcaops/storage';

import { reviewProposeAction, type ReviewProposeClient, runReviewPropose } from './propose.js';
import { seedCandidate } from './test-helpers.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const EDITED = '# proposal\n\nedited body';

const proposeResp = (
  over: Partial<SourcePlanReviewProposeResponse> = {}
): SourcePlanReviewProposeResponse => ({
  externalId: 'ext-1',
  proposalId: 'prop_1',
  baseVersionId: 'ver_4',
  needsRebase: false,
  ...over,
});

function proposeClient(
  reviewPropose: ReviewProposeClient['sourcePlan']['reviewPropose']
): ReviewProposeClient {
  return { sourcePlan: { reviewPropose } };
}

describe('runReviewPropose', () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-review-propose-'));
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
    const bodyPath = path.join(repoRoot, 'dirty.md');
    await writeFile(bodyPath, `# proposal\n\nbody\u0085tail`, 'utf8');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(reviewProposeAction('ext-1', { input: bodyPath, json: true })).rejects.toThrow();
      const emitted = stdout.mock.calls.map((c) => String(c[0])).join('');
      expect(emitted).toMatch(/U\+0085 at offset 16/);
    } finally {
      stdout.mockRestore();
    }
  });

  it('rejects a body with a forbidden control character before any wire call', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewPropose = vi.fn(async () => proposeResp());
    await expect(
      runReviewPropose({
        client: proposeClient(reviewPropose),
        ...base(repoRoot),
        body: `# proposal\n\nbody\u0085tail`,
      })
    ).rejects.toThrow(/U\+0085 at offset 16/);
    expect(reviewPropose).not.toHaveBeenCalled();
  });

  it('resolves base_version_id from the cached candidate + persists the proposal record', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewPropose = vi.fn(async () => proposeResp({ proposalId: 'prop_77' }));
    const result = await runReviewPropose({
      client: proposeClient(reviewPropose),
      ...base(repoRoot),
    });
    expect(result.proposal_id).toBe('prop_77');
    expect(reviewPropose).toHaveBeenCalledWith(
      expect.objectContaining({ base_version_id: 'ver_4', content_hash: sha(EDITED) })
    );
    const prop = await readReviewProposal(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'prop_77'
    );
    expect(prop?.proposal_id).toBe('prop_77');
    expect(prop?.body).toBe(EDITED);
  });

  it('ships the authoring baseline on the wire (null when the arg is omitted)', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const baseline = {
      repo_url: 'https://github.com/foo/bar',
      branch: 'main',
      head_sha: 'ab12f3e',
    };
    const withBaseline = vi.fn(async () => proposeResp());
    await runReviewPropose({ client: proposeClient(withBaseline), baseline, ...base(repoRoot) });
    expect(withBaseline).toHaveBeenCalledWith(expect.objectContaining({ baseline }));

    const without = vi.fn(async () => proposeResp());
    await runReviewPropose({ client: proposeClient(without), ...base(repoRoot) });
    expect(without).toHaveBeenCalledWith(expect.objectContaining({ baseline: null }));
  });

  it('surfaces needs_rebase', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const result = await runReviewPropose({
      client: proposeClient(vi.fn(async () => proposeResp({ needsRebase: true }))),
      ...base(repoRoot),
    });
    expect(result.needs_rebase).toBe(true);
  });

  it('--base-version-id SKIPS the cache read (no candidate seeded)', async () => {
    const reviewPropose = vi.fn(async () => proposeResp());
    const result = await runReviewPropose({
      client: proposeClient(reviewPropose),
      baseVersionIdOverride: 'ver_manual',
      ...base(repoRoot),
    });
    expect(result.proposal_id).toBe('prop_1');
    expect(result.base_url).toBe('https://cloud.example');
    expect(reviewPropose).toHaveBeenCalledWith(
      expect.objectContaining({ base_version_id: 'ver_manual' })
    );
  });

  it('hard-errors NO_INPUT with no cached candidate and no override', async () => {
    const err = await runReviewPropose({
      client: proposeClient(vi.fn(async () => proposeResp())),
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toContain('orcaops plan review pull ext-1');
  });

  it('maps a --supersedes FORBIDDEN to the friendly own-OPEN-proposal message', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewPropose = vi.fn(async () => {
      throw new TrpcRequestError('forbidden', { code: 'FORBIDDEN', httpStatus: 403 });
    });
    const err = await runReviewPropose({
      client: proposeClient(reviewPropose),
      supersedesProposalId: 'prop_other',
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/supersede your own OPEN proposal/i);
  });
});
