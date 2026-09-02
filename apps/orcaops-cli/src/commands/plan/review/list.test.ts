import { describe, expect, it, vi } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';
import type { SourcePlanReviewListItem } from '@orcaops/sdk';

import {
  formatHumanReviewList,
  parseListFilters,
  type ReviewListClient,
  runReviewList,
} from './list.js';

function item(over: Partial<SourcePlanReviewListItem> = {}): SourcePlanReviewListItem {
  return {
    externalId: 'ext-1',
    slug: 'fix-rate-limiter',
    title: 'Rate limiter hardening plan',
    status: 'IN_REVIEW',
    candidateVersionNumber: 4,
    approvedVersionNumber: null,
    openProposalCount: 0,
    authorHandle: 'alex@example.com',
    authorName: 'Alex Rivera',
    baselineBranch: null,
    baselineRepoUrl: null,
    reviewers: [],
    reviewVerdict: {
      approvedCurrent: 0,
      approvedStale: 0,
      changesRequestedCurrent: 0,
      changesRequestedStale: 0,
      pending: 0,
    },
    updatedAt: '2026-06-09T22:01:00.000Z',
    ...over,
  };
}

function client(list: ReviewListClient['sourcePlan']['list']): ReviewListClient {
  return { sourcePlan: { list } };
}

describe('parseListFilters', () => {
  it('defaults to IN_REVIEW with limit 30 and verbatim-null handles', () => {
    expect(parseListFilters({})).toEqual({
      statuses: ['IN_REVIEW'],
      author: null,
      reviewer: null,
      authorMe: false,
      limit: 30,
    });
  });

  it('rejects --state draft with a teaching message', () => {
    expect(() => parseListFilters({ state: ['draft'] })).toThrowError(/no DRAFT state/);
  });

  it('rejects an unknown state', () => {
    expect(() => parseListFilters({ state: ['merged'] })).toThrowError(/Unknown --state/);
  });

  it('expands all and dedupes repeated states', () => {
    expect(parseListFilters({ state: ['all', 'approved', 'APPROVED '] }).statuses).toEqual([
      'IN_REVIEW',
      'APPROVED',
      'PINNED',
    ]);
  });

  it('rejects --mine with --author before the wire', () => {
    expect(() => parseListFilters({ mine: true, author: 'a@b.c' })).toThrowError(
      /mutually exclusive/
    );
  });

  it('passes handles through verbatim (matching is cloud-side)', () => {
    const f = parseListFilters({ author: '  Alex@Example.COM ' });
    expect(f.author).toBe('  Alex@Example.COM ');
  });

  it('bounds --limit to 1-100 integers', () => {
    expect(parseListFilters({ limit: '100' }).limit).toBe(100);
    expect(() => parseListFilters({ limit: '0' })).toThrowError(/between 1 and 100/);
    expect(() => parseListFilters({ limit: '101' })).toThrowError(/between 1 and 100/);
    expect(() => parseListFilters({ limit: '2.5' })).toThrowError(/between 1 and 100/);
  });
});

describe('runReviewList', () => {
  it('issues one list call with every wire field explicit', async () => {
    const list = vi.fn(async () => ({ plans: [], truncated: false }));
    await runReviewList({ client: client(list), filters: parseListFilters({ mine: true }) });
    expect(list).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      statuses: ['IN_REVIEW'],
      author: null,
      reviewer: null,
      author_me: true,
      reviewer_me: false,
      limit: 30,
    });
  });

  it('decorates items with pin refs and passes truncated through', async () => {
    const list = vi.fn(async () => ({
      plans: [item({ approvedVersionNumber: 3 }), item({ externalId: 'ext-2' })],
      truncated: true,
    }));
    const result = await runReviewList({ client: client(list), filters: parseListFilters({}) });
    expect(result.plans[0]?.pinRef).toBe('cloud:ext-1@3');
    expect(result.plans[1]?.pinRef).toBeNull();
    expect(result.truncated).toBe(true);
  });

  it('maps a handle-miss NOT_FOUND to the teaching message', async () => {
    const err = await runReviewList({
      client: client(
        vi.fn(async () => {
          throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
        })
      ),
      filters: parseListFilters({ author: 'nobody@example.com' }),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toMatch(/full email addresses/);
  });

  it('maps a missing-procedure rejection to the version-skew message', async () => {
    const err = await runReviewList({
      client: client(
        vi.fn(async () => {
          throw new TrpcRequestError('anything', {
            code: 'NOT_FOUND',
            httpStatus: 404,
            appCode: 'UNKNOWN_PROCEDURE',
          });
        })
      ),
      filters: parseListFilters({}),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/doesn't expose the plan-review surface/);
  });
});

describe('formatHumanReviewList', () => {
  it('announces truncation — never a silent cap', () => {
    const out = formatHumanReviewList({
      plans: [{ ...item(), pinRef: null }],
      truncated: true,
    });
    expect(out).toContain('showing 1; more exist — raise --limit');
  });

  it('renders an empty-state hint', () => {
    expect(formatHumanReviewList({ plans: [], truncated: false })).toContain('No plans found');
  });

  it('renders one row per plan with versions and author', () => {
    const out = formatHumanReviewList({
      plans: [
        { ...item({ approvedVersionNumber: 3, openProposalCount: 2 }), pinRef: 'cloud:ext-1@3' },
      ],
      truncated: false,
    });
    expect(out).toContain('ext-1');
    expect(out).toContain('IN_REVIEW');
    expect(out).toContain('v4');
    expect(out).toContain('v3');
    expect(out).toContain('alex@example.com');
  });

  it('renders the candidate baseline branch column; dash when absent', () => {
    const out = formatHumanReviewList({
      plans: [
        { ...item({ baselineBranch: 'feat/rate-limit' }), pinRef: null },
        { ...item({ externalId: 'ext-2', slug: 'older-plan' }), pinRef: null },
      ],
      truncated: false,
    });
    expect(out).toContain('BRANCH');
    expect(out).toContain('feat/rate-limit');
    const olderRow = out.split('\n').find((l) => l.includes('ext-2'));
    expect(olderRow).toContain(' - ');
  });
});
