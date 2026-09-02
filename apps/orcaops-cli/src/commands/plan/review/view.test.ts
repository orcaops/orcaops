import { describe, expect, it, vi } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';
import type { SourcePlanReviewDetailResponse } from '@orcaops/sdk';

import { formatBaseline, formatHumanView, type ReviewViewClient, runReviewView } from './view.js';

function detailResp(
  over: Partial<SourcePlanReviewDetailResponse> = {}
): SourcePlanReviewDetailResponse {
  return {
    externalId: 'ext-1',
    slug: 'fix-rate-limiter',
    title: 'Rate limiter hardening plan',
    status: 'IN_REVIEW',
    approvedVersionNumber: null,
    webUrl: 'https://cloud.example/plans/ext-1/review',
    candidate: {
      versionId: 'ver_4',
      versionNumber: 4,
      contentHash: 'ab'.repeat(32),
      authorHandle: 'alex@example.com',
      authorName: 'Alex Rivera',
      createdAt: '2026-06-09T22:01:00.000Z',
      baseline: null,
    },
    reviewers: [],
    reviewVerdict: {
      approvedCurrent: 0,
      approvedStale: 0,
      changesRequestedCurrent: 0,
      changesRequestedStale: 0,
      pending: 0,
    },
    proposals: [],
    comments: [],
    ...over,
  };
}

function client(reviewDetail: ReviewViewClient['sourcePlan']['reviewDetail']): ReviewViewClient {
  return { sourcePlan: { reviewDetail } };
}

function comment(
  n: number,
  over: Partial<SourcePlanReviewDetailResponse['comments'][number]> = {}
): SourcePlanReviewDetailResponse['comments'][number] {
  return {
    commentId: `cmt_${n}`,
    target: 'candidate',
    proposalId: null,
    authorHandle: 'alice@example.dev',
    authorName: 'Alice',
    body: `comment body ${n}`,
    quote: null,
    status: 'OPEN',
    createdAt: `2026-06-0${n}T00:00:00.000Z`,
    parentCommentId: null,
    parentVerdictId: null,
    ...over,
  };
}

describe('runReviewView', () => {
  it('issues one reviewDetail call with an explicit null proposal_id', async () => {
    const reviewDetail = vi.fn(async () => detailResp());
    await runReviewView({ client: client(reviewDetail), externalId: 'ext-1' });
    expect(reviewDetail).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      external_id: 'ext-1',
      proposal_id: null,
    });
  });

  it('passes --proposal through as proposal_id', async () => {
    const reviewDetail = vi.fn(async () => detailResp());
    await runReviewView({
      client: client(reviewDetail),
      externalId: 'ext-1',
      proposalId: 'prop_9',
    });
    expect(reviewDetail).toHaveBeenCalledWith(expect.objectContaining({ proposal_id: 'prop_9' }));
  });

  it('computes the pin ref from the approved version', async () => {
    const result = await runReviewView({
      client: client(vi.fn(async () => detailResp({ approvedVersionNumber: 3 }))),
      externalId: 'ext-1',
    });
    expect(result.pinRef).toBe('cloud:ext-1@3');
  });

  it('pinRef is null when never approved', async () => {
    const result = await runReviewView({
      client: client(vi.fn(async () => detailResp())),
      externalId: 'ext-1',
    });
    expect(result.pinRef).toBeNull();
  });

  it('maps NOT_FOUND to a friendly NO_INPUT naming the ref', async () => {
    const err = await runReviewView({
      client: client(
        vi.fn(async () => {
          throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
        })
      ),
      externalId: 'ext-1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toContain('"ext-1"');
  });

  it('NOT_FOUND with --proposal names the proposal', async () => {
    const err = await runReviewView({
      client: client(
        vi.fn(async () => {
          throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
        })
      ),
      externalId: 'ext-1',
      proposalId: 'prop_9',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toContain('proposal "prop_9"');
  });

  it('maps a missing-procedure rejection to the version-skew message', async () => {
    const err = await runReviewView({
      client: client(
        vi.fn(async () => {
          throw new TrpcRequestError('anything', {
            code: 'NOT_FOUND',
            httpStatus: 404,
            appCode: 'UNKNOWN_PROCEDURE',
          });
        })
      ),
      externalId: 'ext-1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/doesn't expose the plan-review surface/);
  });
});

describe('formatHumanView', () => {
  it('renders header, approved pin ref, reviewers, and proposals', () => {
    const out = formatHumanView(
      {
        ...detailResp({
          approvedVersionNumber: 3,
          reviewers: [
            {
              handle: 'alice@example.dev',
              name: 'Alice',
              standing: 'CHANGES_REQUESTED',
              currentVerdict: {
                state: 'CHANGES_REQUESTED',
                note: 'step 3 is under-scoped',
                versionNumber: 4,
              },
              hasEarlierVerdicts: false,
              history: [
                {
                  id: 'vd_1',
                  state: 'CHANGES_REQUESTED',
                  note: 'step 3 is under-scoped',
                  versionNumber: 4,
                  createdAt: '2026-06-09T00:00:00.000Z',
                },
              ],
            },
          ],
          proposals: [
            {
              proposalId: 'prop_1',
              state: 'OPEN',
              authorHandle: 'alice@example.dev',
              authorName: 'Alice',
              summary: 'tighten step 3',
              baseVersionNumber: 3,
              needsRebase: true,
              supersededByProposalId: null,
              declineReason: null,
              commentCount: 1,
              baseline: null,
              createdAt: '2026-06-09T00:00:00.000Z',
            },
          ],
        }),
        pinRef: 'cloud:ext-1@3',
      },
      {}
    );
    expect(out).toContain('fix-rate-limiter (ext-1)  IN_REVIEW');
    expect(out).toContain('pin ref: cloud:ext-1@3');
    expect(out).toContain('CHANGES_REQUESTED');
    expect(out).toContain('NEEDS REBASE');
    // An open proposal wins the Next: hint.
    expect(out).toContain('Next: orcaops plan review pull ext-1 --proposal prop_1');
  });

  it('previews the 3 newest comments and points at --comments for the thread', () => {
    const out = formatHumanView(
      {
        ...detailResp({ comments: [comment(1), comment(2), comment(3), comment(4)] }),
        pinRef: null,
      },
      {}
    );
    expect(out).toContain('--comments for the thread');
    expect(out).toContain('comment body 4');
    expect(out).toContain('comment body 2');
    expect(out).not.toContain('comment body 1');
  });

  it('--comments renders the full thread chronologically', () => {
    const out = formatHumanView(
      { ...detailResp({ comments: [comment(2), comment(1)] }), pinRef: null },
      { comments: true }
    );
    expect(out).toContain('comment body 1');
    expect(out).toContain('comment body 2');
    expect(out.indexOf('comment body 1')).toBeLessThan(out.indexOf('comment body 2'));
  });

  it('APPROVED with no open proposals hints the capture pin', () => {
    const out = formatHumanView(
      { ...detailResp({ status: 'APPROVED', approvedVersionNumber: 4 }), pinRef: 'cloud:ext-1@4' },
      {}
    );
    expect(out).toContain('Next: orcaops capture plan --source-plan cloud:ext-1@4');
  });
});

describe('v1.1 renders — baseline + stale verdicts', () => {
  const fullBaseline = {
    repoUrl: 'https://github.com/foo/bar',
    branch: 'main',
    headSha: 'ab12f3e0000000000000000000000000000000ff',
  };

  it('formatBaseline renders only the non-null segments (sha at 7 chars)', () => {
    expect(formatBaseline(fullBaseline)).toBe('main @ ab12f3e');
    expect(formatBaseline({ ...fullBaseline, headSha: null })).toBe('main');
    expect(formatBaseline({ ...fullBaseline, branch: null })).toBe('@ ab12f3e');
    expect(formatBaseline({ branch: null, headSha: null })).toBeNull();
    expect(formatBaseline(null)).toBeNull();
  });

  it('renders the Baseline line under Candidate, omitted when absent', () => {
    const base = detailResp();
    const withBaseline = formatHumanView(
      {
        ...base,
        candidate: { ...base.candidate!, baseline: fullBaseline },
        pinRef: null,
      },
      {}
    );
    expect(withBaseline).toContain('Baseline:   main @ ab12f3e');

    const without = formatHumanView({ ...detailResp(), pinRef: null }, {});
    expect(without).not.toContain('Baseline:');
  });

  it('renders standing: NEEDS_RE_REVIEW shows the stale verdict, current shows its note, pending is bare', () => {
    const stale = {
      handle: 'stale@example.dev',
      name: 'Stale',
      standing: 'NEEDS_RE_REVIEW',
      currentVerdict: null,
      hasEarlierVerdicts: false,
      history: [
        {
          id: 'vd_stale',
          state: 'CHANGES_REQUESTED',
          note: 'fix step 3',
          versionNumber: 1,
          createdAt: '2026-06-09T00:00:00.000Z',
        },
      ],
    };
    const current = {
      handle: 'current@example.dev',
      name: 'Current',
      standing: 'APPROVED',
      currentVerdict: { state: 'APPROVED', note: 'lgtm', versionNumber: 4 },
      hasEarlierVerdicts: false,
      history: [
        {
          id: 'vd_cur',
          state: 'APPROVED',
          note: 'lgtm',
          versionNumber: 4,
          createdAt: '2026-06-09T00:00:00.000Z',
        },
      ],
    };
    const pending = {
      handle: 'pending@example.dev',
      name: 'Pending',
      standing: 'PENDING',
      currentVerdict: null,
      hasEarlierVerdicts: false,
      history: [],
    };
    const out = formatHumanView(
      { ...detailResp({ reviewers: [stale, current, pending] }), pinRef: null },
      {}
    );
    const staleLine = out.split('\n').find((l) => l.includes('stale@example.dev'));
    expect(staleLine).toContain('NEEDS_RE_REVIEW');
    expect(staleLine).toContain('(was CHANGES_REQUESTED on v1 "fix step 3")');
    const currentLine = out.split('\n').find((l) => l.includes('current@example.dev'));
    expect(currentLine).toContain('APPROVED');
    expect(currentLine).toContain('"lgtm"');
    expect(currentLine).not.toContain('NEEDS_RE_REVIEW');
    const pendingLine = out.split('\n').find((l) => l.includes('pending@example.dev'));
    expect(pendingLine).toContain('PENDING');
    expect(pendingLine).not.toContain('was ');
  });

  it('chips a proposal baseline on the proposal line', () => {
    const out = formatHumanView(
      {
        ...detailResp({
          proposals: [
            {
              proposalId: 'prop_1',
              state: 'OPEN',
              authorHandle: 'alice@example.dev',
              authorName: 'Alice',
              summary: null,
              baseVersionNumber: 3,
              needsRebase: false,
              supersededByProposalId: null,
              declineReason: null,
              commentCount: 0,
              baseline: { repoUrl: null, branch: 'alice/tweak', headSha: 'deadbee7'.repeat(5) },
              createdAt: '2026-06-09T00:00:00.000Z',
            },
          ],
        }),
        pinRef: null,
      },
      {}
    );
    expect(out).toContain('[alice/tweak @ deadbee]');
  });
});

describe('threaded comments + verdict history', () => {
  const reviewerWithHistory = {
    handle: 'rev@example.dev',
    name: 'Rev',
    standing: 'CHANGES_REQUESTED',
    currentVerdict: { state: 'CHANGES_REQUESTED', note: 'see notes', versionNumber: 4 },
    hasEarlierVerdicts: true,
    history: [
      {
        id: 'vd_cur',
        state: 'CHANGES_REQUESTED',
        note: 'see notes',
        versionNumber: 4,
        createdAt: '2026-06-04T00:00:00.000Z',
      },
      {
        id: 'vd_old',
        state: 'CHANGES_REQUESTED',
        note: 'first pass',
        versionNumber: 1,
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ],
  };

  it('renders commentId, nests a one-level comment-reply, and counts roots only', () => {
    const root = comment(1, { commentId: 'cmt_root' });
    const reply = comment(2, {
      commentId: 'cmt_reply',
      parentCommentId: 'cmt_root',
      body: 'a reply body',
    });
    const out = formatHumanView(
      { ...detailResp({ comments: [root, reply] }), pinRef: null },
      { comments: true }
    );
    expect(out).toContain('(cmt_root)'); // commentId is copy-pasteable for --reply-to
    expect(out).toContain('↳'); // nested reply marker
    expect(out).toContain('a reply body');
    expect(out).toContain('Comments (1)'); // the reply does not inflate the root count
  });

  it('folds comment-replies in the default preview with a count hint', () => {
    const root = comment(1, { commentId: 'cmt_root' });
    const reply = comment(2, { commentId: 'cmt_reply', parentCommentId: 'cmt_root' });
    const out = formatHumanView({ ...detailResp({ comments: [root, reply] }), pinRef: null }, {});
    expect(out).toContain('(+1 reply — --comments)');
    expect(out).not.toContain('↳');
  });

  it('renders an ATTACHED verdict-reply under its verdict (--history), excluded from roots', () => {
    const vreply = comment(3, {
      commentId: 'cmt_vr',
      parentVerdictId: 'vd_cur',
      body: 'reply to the verdict',
    });
    const out = formatHumanView(
      { ...detailResp({ reviewers: [reviewerWithHistory], comments: [vreply] }), pinRef: null },
      { history: true, comments: true }
    );
    expect(out).toContain('reply to the verdict');
    expect(out).toContain('Comments (0)'); // a verdict-reply is not a root comment
  });

  it('renders a DETACHED verdict-reply (matches no current verdict) as a root, never dropped', () => {
    const detached = comment(4, {
      commentId: 'cmt_det',
      parentVerdictId: 'vd_gone',
      body: 'orphaned reply',
    });
    const out = formatHumanView(
      { ...detailResp({ reviewers: [reviewerWithHistory], comments: [detached] }), pinRef: null },
      { comments: true }
    );
    expect(out).toContain('orphaned reply');
    expect(out).toContain('Comments (1)'); // cloud-folded back to a root
  });

  it('--history renders the full verdict trail; default view shows only an affordance', () => {
    const withHistory = formatHumanView(
      { ...detailResp({ reviewers: [reviewerWithHistory] }), pinRef: null },
      { history: true }
    );
    expect(withHistory).toContain('first pass'); // the earlier verdict's note
    expect(withHistory).toContain('v1'); // the earlier verdict's version

    const defaultView = formatHumanView(
      { ...detailResp({ reviewers: [reviewerWithHistory] }), pinRef: null },
      {}
    );
    expect(defaultView).toContain('--history for the trail');
    expect(defaultView).not.toContain('first pass'); // earlier verdict hidden by default
  });

  it('--comments hints attached verdict-replies (count only) without --history', () => {
    const vreply = comment(3, {
      commentId: 'cmt_vr',
      parentVerdictId: 'vd_cur',
      body: 'reply to the verdict',
    });
    const out = formatHumanView(
      { ...detailResp({ reviewers: [reviewerWithHistory], comments: [vreply] }), pinRef: null },
      { comments: true } // no --history
    );
    expect(out).not.toContain('reply to the verdict'); // body stays under --history
    expect(out).toContain('1 verdict-reply under reviewer verdicts — --history'); // discoverability hint
    expect(out).toContain('Comments (0)'); // still excluded from roots
  });

  it('folds an orphan comment-reply (parent absent) into roots, never dropped', () => {
    const orphan = comment(5, {
      commentId: 'cmt_orphan',
      parentCommentId: 'cmt_missing',
      body: 'orphaned comment-reply',
    });
    const out = formatHumanView(
      { ...detailResp({ comments: [orphan] }), pinRef: null },
      { comments: true }
    );
    expect(out).toContain('orphaned comment-reply');
    expect(out).toContain('Comments (1)'); // folded to a root and counted, not dropped
  });

  it('--history renders the verdict trail oldest→newest (display reversal)', () => {
    // currentVerdict.note is null so neither trail note leaks onto the standing line —
    // both tokens appear only in the trail, so their order is the trail's order.
    const reviewer = {
      handle: 'rev@example.dev',
      name: 'Rev',
      standing: 'APPROVED',
      currentVerdict: { state: 'APPROVED', note: null, versionNumber: 3 },
      hasEarlierVerdicts: true,
      history: [
        {
          id: 'vd_new',
          state: 'APPROVED',
          note: 'newer trail note',
          versionNumber: 3,
          createdAt: '2026-06-03T00:00:00.000Z',
        },
        {
          id: 'vd_old',
          state: 'CHANGES_REQUESTED',
          note: 'older trail note',
          versionNumber: 1,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    };
    const out = formatHumanView(
      { ...detailResp({ reviewers: [reviewer] }), pinRef: null },
      { history: true }
    );
    expect(out.indexOf('older trail note')).toBeLessThan(out.indexOf('newer trail note'));
  });
});
