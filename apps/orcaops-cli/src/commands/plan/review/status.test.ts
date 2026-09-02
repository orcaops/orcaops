import { describe, expect, it, vi } from 'vitest';

import type { SourcePlanReviewListItem } from '@orcaops/sdk';

import { formatHumanReviewStatus, type ReviewStatusClient, runReviewStatus } from './status.js';

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

function client(list: ReviewStatusClient['sourcePlan']['list']): ReviewStatusClient {
  return { sourcePlan: { list } };
}

const ME = 'alex@example.com';

describe('runReviewStatus', () => {
  it('issues exactly two list calls: author_me then reviewer_me', async () => {
    const list = vi.fn(async () => ({ plans: [], truncated: false }));
    await runReviewStatus({ client: client(list), myHandle: ME });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledWith({
      schema_version: 1,
      statuses: ['IN_REVIEW', 'APPROVED'],
      author: null,
      reviewer: null,
      author_me: true,
      reviewer_me: false,
      limit: 30,
    });
    expect(list).toHaveBeenCalledWith({
      schema_version: 1,
      statuses: ['IN_REVIEW'],
      author: null,
      reviewer: null,
      author_me: false,
      reviewer_me: true,
      limit: 30,
    });
  });

  it('authored APPROVED plans get the capture-pin next action', async () => {
    const approved = item({ status: 'APPROVED', approvedVersionNumber: 3 });
    const list = vi.fn(async (input: { author_me: boolean }) =>
      input.author_me ? { plans: [approved], truncated: false } : { plans: [], truncated: false }
    );
    const result = await runReviewStatus({ client: client(list), myHandle: ME });
    expect(result.authored[0]).toMatchObject({
      pinRef: 'cloud:ext-1@3',
      nextAction: 'orcaops capture plan --source-plan cloud:ext-1@3',
    });
  });

  it('authored plans with open proposals route through view (list carries no proposal ids)', async () => {
    const withProps = item({ openProposalCount: 2 });
    const list = vi.fn(async (input: { author_me: boolean }) =>
      input.author_me ? { plans: [withProps], truncated: false } : { plans: [], truncated: false }
    );
    const result = await runReviewStatus({ client: client(list), myHandle: ME });
    expect(result.authored[0]?.nextAction).toBe('orcaops plan review view ext-1');
  });

  it('reviewing keeps plans where MY standing is PENDING or NEEDS_RE_REVIEW, matched case-insensitively', async () => {
    const mine = item({
      externalId: 'ext-pending',
      reviewers: [{ handle: ' Alex@Example.COM ', name: 'Alex Rivera', standing: 'PENDING' }],
    });
    // A prior verdict gone stale against a newer candidate — I must re-review, so it surfaces.
    const staleMine = item({
      externalId: 'ext-stale',
      reviewers: [{ handle: ME, name: 'Alex Rivera', standing: 'NEEDS_RE_REVIEW' }],
    });
    const alreadyVoted = item({
      externalId: 'ext-voted',
      reviewers: [{ handle: ME, name: 'Alex Rivera', standing: 'APPROVED' }],
    });
    const someoneElse = item({
      externalId: 'ext-other',
      reviewers: [{ handle: 'sam@example.com', name: 'Sam Chen', standing: 'PENDING' }],
    });
    const list = vi.fn(async (input: { reviewer_me: boolean }) =>
      input.reviewer_me
        ? { plans: [mine, staleMine, alreadyVoted, someoneElse], truncated: false }
        : { plans: [], truncated: false }
    );
    const result = await runReviewStatus({ client: client(list), myHandle: ME });
    expect(result.reviewing.map((p) => p.externalId)).toEqual(['ext-pending', 'ext-stale']);
    expect(result.reviewing[0]?.nextAction).toBe('orcaops plan review pull ext-pending');
  });

  it('a null handle degrades to an empty reviewing section, never a throw', async () => {
    const list = vi.fn(async () => ({ plans: [item()], truncated: false }));
    const result = await runReviewStatus({ client: client(list), myHandle: null });
    expect(result.myHandle).toBeNull();
    expect(result.reviewing).toEqual([]);
    expect(result.authored).toHaveLength(1);
  });

  it('carries per-section truncation flags', async () => {
    const list = vi.fn(async (input: { author_me: boolean }) =>
      input.author_me ? { plans: [item()], truncated: true } : { plans: [], truncated: false }
    );
    const result = await runReviewStatus({ client: client(list), myHandle: ME });
    expect(result.authoredTruncated).toBe(true);
    expect(result.reviewingTruncated).toBe(false);
  });
});

describe('formatHumanReviewStatus', () => {
  it('explains an unavailable reviewing section when no email is on the credential', () => {
    const out = formatHumanReviewStatus({
      myHandle: null,
      authored: [],
      authoredTruncated: false,
      reviewing: [],
      reviewingTruncated: false,
    });
    expect(out).toContain('Wants your review: unavailable');
  });

  it('renders both sections with Next: hints and truncation notes', () => {
    const out = formatHumanReviewStatus({
      myHandle: ME,
      authored: [
        {
          ...item({ status: 'APPROVED', approvedVersionNumber: 3 }),
          pinRef: 'cloud:ext-1@3',
          nextAction: 'orcaops capture plan --source-plan cloud:ext-1@3',
        },
      ],
      authoredTruncated: true,
      reviewing: [
        {
          ...item({ externalId: 'ext-2' }),
          pinRef: null,
          nextAction: 'orcaops plan review pull ext-2',
        },
      ],
      reviewingTruncated: false,
    });
    expect(out).toContain('Authored by you (1)');
    expect(out).toContain('Next: orcaops capture plan --source-plan cloud:ext-1@3');
    expect(out).toContain('Wants your review (1)');
    expect(out).toContain('Next: orcaops plan review pull ext-2');
    expect(out).toContain('more exist');
  });

  it('chips the candidate baseline branch on both sections when present', () => {
    const out = formatHumanReviewStatus({
      myHandle: ME,
      authored: [{ ...item({ baselineBranch: 'feat/limits' }), pinRef: null, nextAction: null }],
      authoredTruncated: false,
      reviewing: [
        {
          ...item({ externalId: 'ext-2', baselineBranch: 'alice/wip' }),
          pinRef: null,
          nextAction: null,
        },
      ],
      reviewingTruncated: false,
    });
    expect(out).toContain('[feat/limits]');
    expect(out).toContain('[alice/wip]');
  });

  it('surfaces the verdict rollup on an authored plan', () => {
    const out = formatHumanReviewStatus({
      myHandle: ME,
      authored: [
        {
          ...item({
            reviewVerdict: {
              approvedCurrent: 2,
              approvedStale: 0,
              changesRequestedCurrent: 0,
              changesRequestedStale: 1,
              pending: 1,
            },
          }),
          pinRef: null,
          nextAction: null,
        },
      ],
      authoredTruncated: false,
      reviewing: [],
      reviewingTruncated: false,
    });
    expect(out).toContain('Verdicts: 2 approved, 1 needs-re-review, 1 pending');
  });
});
