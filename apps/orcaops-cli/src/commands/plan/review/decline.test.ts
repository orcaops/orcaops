import { describe, expect, it, vi } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';
import type { SourcePlanReviewDeclineResponse } from '@orcaops/sdk';

import { type ReviewDeclineClient, runReviewDecline } from './decline.js';

function resp(
  over: Partial<SourcePlanReviewDeclineResponse> = {}
): SourcePlanReviewDeclineResponse {
  return {
    externalId: 'ext-1',
    proposalId: 'prop_1',
    state: 'DECLINED',
    reason: null,
    ...over,
  };
}

function client(
  declineProposal: ReviewDeclineClient['sourcePlan']['declineProposal']
): ReviewDeclineClient {
  return { sourcePlan: { declineProposal } };
}

const fail = (
  data: { code: string; httpStatus: number; appCode?: 'UNKNOWN_PROCEDURE' },
  message = 'x'
) =>
  vi.fn(async () => {
    throw new TrpcRequestError(message, data);
  });

describe('runReviewDecline', () => {
  it('issues one declineProposal call with an explicit null reason', async () => {
    const declineProposal = vi.fn(async () => resp());
    await runReviewDecline({
      client: client(declineProposal),
      externalId: 'ext-1',
      proposalId: 'prop_1',
    });
    expect(declineProposal).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      external_id: 'ext-1',
      proposal_id: 'prop_1',
      reason: null,
    });
  });

  it('snake_cases the ack and carries the recorded reason', async () => {
    const result = await runReviewDecline({
      client: client(vi.fn(async () => resp({ reason: 'superseded by the v4 rewrite' }))),
      externalId: 'ext-1',
      proposalId: 'prop_1',
      reason: 'superseded by the v4 rewrite',
    });
    expect(result).toEqual({
      external_id: 'ext-1',
      proposal_id: 'prop_1',
      state: 'DECLINED',
      reason: 'superseded by the v4 rewrite',
    });
  });

  it('maps FORBIDDEN to the author-only message', async () => {
    const err = await runReviewDecline({
      client: client(fail({ code: 'FORBIDDEN', httpStatus: 403 })),
      externalId: 'ext-1',
      proposalId: 'prop_1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/Only the plan author can decline/);
  });

  it('maps CONFLICT to the plan-pinned message (decline survives APPROVED)', async () => {
    const err = await runReviewDecline({
      client: client(fail({ code: 'CONFLICT', httpStatus: 409 })),
      externalId: 'ext-1',
      proposalId: 'prop_1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/pinned; proposals can no longer be declined/);
  });

  it('maps NOT_FOUND to a friendly NO_INPUT naming the proposal', async () => {
    const err = await runReviewDecline({
      client: client(fail({ code: 'NOT_FOUND', httpStatus: 404 })),
      externalId: 'ext-1',
      proposalId: 'prop_9',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toContain('proposal "prop_9"');
  });

  it('maps a missing-procedure rejection to the version-skew message', async () => {
    const err = await runReviewDecline({
      client: client(fail({ code: 'NOT_FOUND', httpStatus: 404, appCode: 'UNKNOWN_PROCEDURE' })),
      externalId: 'ext-1',
      proposalId: 'prop_1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/doesn't expose the plan-review surface/);
  });
});
