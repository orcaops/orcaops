import { describe, expect, it, vi } from 'vitest';

import { CloudWireError, TrpcRequestError } from '@orcaops/sdk';
import type { SourcePlanApprovedPull, SourcePlanReviewPullResponse } from '@orcaops/sdk';
import { sha256Hex } from '@orcaops/storage';

import { type ReviewDiffClient, runReviewDiff } from './diff.js';

function approved(body: string, versionNumber = 3): SourcePlanApprovedPull {
  return {
    externalId: 'ext-1',
    slug: 'fix-rate-limiter',
    title: 'Rate limiter hardening plan',
    approvedVersion: { versionNumber, body, contentHash: sha256Hex(body), sourceRef: null },
  };
}

function candidate(body: string, versionNumber = 4): SourcePlanReviewPullResponse {
  return {
    externalId: 'ext-1',
    target: 'candidate',
    versionId: `ver_${versionNumber}`,
    versionNumber,
    proposalId: null,
    baseVersionNumber: null,
    contentHash: sha256Hex(body),
    body,
  };
}

function proposal(body: string, proposalId = 'prop_1', base = 4): SourcePlanReviewPullResponse {
  return {
    externalId: 'ext-1',
    target: 'proposal',
    versionId: null,
    versionNumber: null,
    proposalId,
    baseVersionNumber: base,
    contentHash: sha256Hex(body),
    body,
  };
}

function sealed(versionNumber: number, body: string): SourcePlanReviewPullResponse {
  return {
    externalId: 'ext-1',
    target: 'version',
    versionId: `ver_${versionNumber}`,
    versionNumber,
    proposalId: null,
    baseVersionNumber: null,
    contentHash: sha256Hex(body),
    body,
  };
}

function client(over: Partial<ReviewDiffClient['sourcePlan']>): ReviewDiffClient {
  return {
    sourcePlan: {
      getApproved: vi.fn(async () => approved('old')),
      reviewPull: vi.fn(async () => candidate('new')),
      ...over,
    },
  };
}

/** Routes version_number pulls to sealed bodies, null to the candidate. */
function versionedReviewPull(versions: Record<number, string>, candidateBody: string) {
  return vi.fn(async (input: { proposal_id: string | null; version_number: number | null }) => {
    if (input.version_number !== null) {
      const body = versions[input.version_number];
      if (body === undefined) {
        throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
      }
      return sealed(input.version_number, body);
    }
    return candidate(candidateBody);
  });
}

describe('runReviewDiff (approved → candidate, default)', () => {
  it('fetches both sides over the SDK and renders a unified patch', async () => {
    const getApproved = vi.fn(async () => approved('line a\nline b\n'));
    const reviewPull = vi.fn(async () => candidate('line a\nline c\n'));
    const result = await runReviewDiff({
      client: client({ getApproved, reviewPull }),
      externalId: 'ext-1',
    });
    expect(getApproved).toHaveBeenCalledExactlyOnceWith({ slugOrExternalId: 'ext-1' });
    expect(reviewPull).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      external_id: 'ext-1',
      proposal_id: null,
      version_number: null,
    });
    expect(result.from).toEqual({ target: 'approved', versionNumber: 3 });
    expect(result.to).toEqual({ target: 'candidate', versionNumber: 4 });
    expect(result.identical).toBe(false);
    expect(result.unified).toContain('approved v3');
    expect(result.unified).toContain('candidate v4');
    expect(result.unified).toContain('-line b');
    expect(result.unified).toContain('+line c');
  });

  it('identical bodies report identical with an empty patch', async () => {
    const result = await runReviewDiff({
      client: client({
        getApproved: vi.fn(async () => approved('same\n')),
        reviewPull: vi.fn(async () => candidate('same\n')),
      }),
      externalId: 'ext-1',
    });
    expect(result.identical).toBe(true);
    expect(result.unified).toBe('');
  });

  it('errors NO_INPUT when no approved version exists', async () => {
    const err = await runReviewDiff({
      client: client({
        getApproved: vi.fn(async () => {
          throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
        }),
      }),
      externalId: 'ext-1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toMatch(/No APPROVED version/);
  });

  it('rejects a tampered body with the integrity message', async () => {
    const bad = { ...candidate('real'), contentHash: sha256Hex('other') };
    const err = await runReviewDiff({
      client: client({ reviewPull: vi.fn(async () => bad) }),
      externalId: 'ext-1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/Integrity check failed/);
  });
});

describe('runReviewDiff --proposal (candidate → proposal)', () => {
  it('compares the candidate against the proposal without touching getApproved', async () => {
    const getApproved = vi.fn(async () => approved('unused'));
    const reviewPull = vi.fn(async (input: { proposal_id: string | null }) =>
      input.proposal_id === null ? candidate('cand body\n') : proposal('prop body\n')
    );
    const result = await runReviewDiff({
      client: client({ getApproved, reviewPull }),
      externalId: 'ext-1',
      proposalId: 'prop_1',
    });
    expect(getApproved).not.toHaveBeenCalled();
    expect(reviewPull).toHaveBeenCalledTimes(2);
    expect(result.from).toEqual({ target: 'candidate', versionNumber: 4 });
    expect(result.to).toEqual({ target: 'proposal', versionNumber: 4, proposalId: 'prop_1' });
    expect(result.unified).toContain('proposal prop_1 (base v4)');
  });

  it('maps an unknown proposal to NO_INPUT naming it', async () => {
    const reviewPull = vi.fn(async (input: { proposal_id: string | null }) => {
      if (input.proposal_id === null) return candidate('cand');
      throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
    });
    const err = await runReviewDiff({
      client: client({ reviewPull }),
      externalId: 'ext-1',
      proposalId: 'prop_9',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toContain('proposal "prop_9"');
  });

  it('maps a missing-procedure rejection to the version-skew message', async () => {
    const err = await runReviewDiff({
      client: client({
        reviewPull: vi.fn(async () => {
          throw new TrpcRequestError('anything', {
            code: 'NOT_FOUND',
            httpStatus: 404,
            appCode: 'UNKNOWN_PROCEDURE',
          });
        }),
      }),
      externalId: 'ext-1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/doesn't expose the plan-review surface/);
  });
});

describe('runReviewDiff --from/--to (version → version/candidate)', () => {
  it('--from N diffs the sealed version against the current candidate (no getApproved)', async () => {
    const getApproved = vi.fn(async () => approved('unused'));
    const reviewPull = versionedReviewPull({ 1: 'line a\nline b\n' }, 'line a\nline c\n');
    const result = await runReviewDiff({
      client: client({ getApproved, reviewPull }),
      externalId: 'ext-1',
      fromVersion: 1,
    });
    expect(getApproved).not.toHaveBeenCalled();
    expect(reviewPull).toHaveBeenCalledWith(expect.objectContaining({ version_number: 1 }));
    expect(reviewPull).toHaveBeenCalledWith(expect.objectContaining({ version_number: null }));
    expect(result.from).toEqual({ target: 'version', versionNumber: 1 });
    expect(result.to).toEqual({ target: 'candidate', versionNumber: 4 });
    expect(result.unified).toContain('v1');
    expect(result.unified).toContain('candidate v4');
    expect(result.unified).toContain('-line b');
    expect(result.unified).toContain('+line c');
  });

  it('--from N --to M diffs two sealed versions (candidate never fetched)', async () => {
    const reviewPull = versionedReviewPull(
      { 1: 'one\n', 2: 'two\n' },
      'CANDIDATE MUST NOT BE FETCHED'
    );
    const result = await runReviewDiff({
      client: client({ reviewPull }),
      externalId: 'ext-1',
      fromVersion: 1,
      toVersion: 2,
    });
    expect(reviewPull).toHaveBeenCalledTimes(2);
    expect(result.from).toEqual({ target: 'version', versionNumber: 1 });
    expect(result.to).toEqual({ target: 'version', versionNumber: 2 });
    expect(result.unified).toContain('-one');
    expect(result.unified).toContain('+two');
  });

  it('identical sealed versions report identical', async () => {
    const reviewPull = versionedReviewPull({ 1: 'same\n', 2: 'same\n' }, 'cand');
    const result = await runReviewDiff({
      client: client({ reviewPull }),
      externalId: 'ext-1',
      fromVersion: 1,
      toVersion: 2,
    });
    expect(result.identical).toBe(true);
    expect(result.unified).toBe('');
  });

  it('a never-existed version maps to the friendly does-not-exist message', async () => {
    const reviewPull = versionedReviewPull({ 1: 'one\n' }, 'cand');
    const err = await runReviewDiff({
      client: client({ reviewPull }),
      externalId: 'ext-1',
      fromVersion: 9,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toMatch(/Version 9 does not exist/);
  });

  it('CloudWireError from a version pull surfaces UNCHANGED (never a wrong-body diff)', async () => {
    const wireErr = new CloudWireError('cloud returned the candidate for a version pull');
    const reviewPull = vi.fn(async () => {
      throw wireErr;
    });
    const err = await runReviewDiff({
      client: client({ reviewPull }),
      externalId: 'ext-1',
      fromVersion: 1,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBe(wireErr);
  });

  it('rejects --to without --from with INVALID_INPUT before any fetch', async () => {
    const reviewPull = vi.fn(async () => candidate('x'));
    const err = await runReviewDiff({
      client: client({ reviewPull }),
      externalId: 'ext-1',
      toVersion: 2,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'INVALID_INPUT' });
    expect(reviewPull).not.toHaveBeenCalled();
  });

  it('rejects --from combined with --proposal with INVALID_INPUT before any fetch', async () => {
    const reviewPull = vi.fn(async () => candidate('x'));
    const err = await runReviewDiff({
      client: client({ reviewPull }),
      externalId: 'ext-1',
      fromVersion: 1,
      proposalId: 'prop_1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'INVALID_INPUT' });
    expect(reviewPull).not.toHaveBeenCalled();
  });
});
