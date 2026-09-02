import { describe, expect, it, vi } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';
import type { SourcePlanReviewVerdictResponse } from '@orcaops/sdk';

import { parseVerdictValue, type ReviewVerdictClient, runReviewVerdict } from './verdict.js';

function resp(
  over: Partial<SourcePlanReviewVerdictResponse> = {}
): SourcePlanReviewVerdictResponse {
  return {
    externalId: 'ext-1',
    reviewer: 'alice@example.dev',
    state: 'CHANGES_REQUESTED',
    note: null,
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...over,
  };
}

function client(
  setReviewerVerdict: ReviewVerdictClient['sourcePlan']['setReviewerVerdict']
): ReviewVerdictClient {
  return { sourcePlan: { setReviewerVerdict } };
}

const fail = (
  data: { code: string; httpStatus: number; appCode?: 'UNKNOWN_PROCEDURE' },
  message = 'x'
) =>
  vi.fn(async () => {
    throw new TrpcRequestError(message, data);
  });

describe('parseVerdictValue', () => {
  it('maps each flag to its wire value', () => {
    expect(parseVerdictValue({ approve: true })).toBe('approved');
    expect(parseVerdictValue({ requestChanges: true })).toBe('changes_requested');
  });

  it('rejects neither-set with a friendly INVALID_INPUT', () => {
    expect(() => parseVerdictValue({})).toThrowError(/exactly one of --approve/);
  });

  it('rejects both-set (backstop behind commander conflicts)', () => {
    expect(() => parseVerdictValue({ approve: true, requestChanges: true })).toThrowError(
      /mutually exclusive/
    );
  });
});

describe('runReviewVerdict', () => {
  it('issues one setReviewerVerdict call with an explicit null note', async () => {
    const setReviewerVerdict = vi.fn(async () => resp());
    await runReviewVerdict({
      client: client(setReviewerVerdict),
      externalId: 'ext-1',
      verdict: 'changes_requested',
    });
    expect(setReviewerVerdict).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      external_id: 'ext-1',
      verdict: 'changes_requested',
      note: null,
    });
  });

  it('snake_cases the ack like the sibling mutation verbs', async () => {
    const result = await runReviewVerdict({
      client: client(vi.fn(async () => resp({ note: 'cap the backoff' }))),
      externalId: 'ext-1',
      verdict: 'changes_requested',
      note: 'cap the backoff',
    });
    expect(result).toEqual({
      external_id: 'ext-1',
      reviewer: 'alice@example.dev',
      state: 'CHANGES_REQUESTED',
      note: 'cap the backoff',
      updated_at: '2026-06-10T00:00:00.000Z',
    });
  });

  it('maps FORBIDDEN to the not-a-requested-reviewer message', async () => {
    const err = await runReviewVerdict({
      client: client(fail({ code: 'FORBIDDEN', httpStatus: 403 })),
      externalId: 'ext-1',
      verdict: 'approved',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/not a requested reviewer/);
  });

  it('maps CONFLICT to the verdicts-only-in-review message', async () => {
    const err = await runReviewVerdict({
      client: client(fail({ code: 'CONFLICT', httpStatus: 409 })),
      externalId: 'ext-1',
      verdict: 'approved',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/verdicts only apply while it is in review/);
  });

  it('maps NOT_FOUND to a friendly NO_INPUT and skew to the surface message', async () => {
    const notFound = await runReviewVerdict({
      client: client(fail({ code: 'NOT_FOUND', httpStatus: 404 })),
      externalId: 'ext-1',
      verdict: 'approved',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(notFound).toMatchObject({ code: 'NO_INPUT' });

    const skew = await runReviewVerdict({
      client: client(fail({ code: 'NOT_FOUND', httpStatus: 404, appCode: 'UNKNOWN_PROCEDURE' })),
      externalId: 'ext-1',
      verdict: 'approved',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((skew as Error).message).toMatch(/doesn't expose the plan-review surface/);
  });
});
