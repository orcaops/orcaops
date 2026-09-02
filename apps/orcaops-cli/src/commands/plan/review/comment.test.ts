import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type SourcePlanReviewCommentResponse, TrpcRequestError } from '@orcaops/sdk';

import {
  assertNonEmptyCommentOptions,
  assertReplyTargetingExclusive,
  reviewCommentAction,
  type ReviewCommentClient,
  type RunReplyCommentArgs,
  runReviewComment,
  type RunReviewCommentArgs,
} from './comment.js';
import { seedCandidate, seedProposal } from './test-helpers.js';

const commentResp = (): SourcePlanReviewCommentResponse => ({
  externalId: 'ext-1',
  commentId: 'cmt_1',
});

function commentClient(
  reviewComment: ReviewCommentClient['sourcePlan']['reviewComment']
): ReviewCommentClient {
  return { sourcePlan: { reviewComment } };
}

describe('runReviewComment', () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-review-comment-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const base = (root: string) => ({
    kind: 'root' as const,
    repoRoot: root,
    baseUrl: 'https://cloud.example',
    orgId: 'org_1',
    externalId: 'ext-1',
    body: 'a comment',
  });

  const replyArgs = (
    reviewComment: ReviewCommentClient['sourcePlan']['reviewComment'],
    replyTo = 'cmt_parent'
  ): RunReplyCommentArgs => ({
    kind: 'reply',
    client: commentClient(reviewComment),
    baseUrl: 'https://cloud.example',
    orgId: 'org_1',
    externalId: 'ext-1',
    body: 'a comment',
    replyTo,
  });

  it('action rejects a dirty body or quote before credential resolution', async () => {
    const bodyPath = path.join(repoRoot, 'dirty.md');
    await writeFile(bodyPath, `looks\u0085wrong`, 'utf8');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(reviewCommentAction('ext-1', { input: bodyPath, json: true })).rejects.toThrow();
      let emitted = stdout.mock.calls.map((c) => String(c[0])).join('');
      expect(emitted).toMatch(/U\+0085 at offset 5/);

      stdout.mockClear();
      const cleanPath = path.join(repoRoot, 'clean.md');
      await writeFile(cleanPath, 'clean body', 'utf8');
      await expect(
        reviewCommentAction('ext-1', {
          input: cleanPath,
          quote: `bad\u0007quote`,
          json: true,
        })
      ).rejects.toThrow();
      emitted = stdout.mock.calls.map((c) => String(c[0])).join('');
      expect(emitted).toMatch(/quote contains a forbidden control character/);
    } finally {
      stdout.mockRestore();
    }
  });

  it('targets the candidate version by default', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewComment = vi.fn(async () => commentResp());
    const result = await runReviewComment({
      client: commentClient(reviewComment),
      ...base(repoRoot),
    });
    expect(result.target).toBe('candidate');
    expect(reviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ target_version_id: 'ver_4', target_proposal_id: null })
    );
  });

  it('targets a proposal with --proposal', async () => {
    await seedProposal(repoRoot, { proposalId: 'prop_9' });
    const reviewComment = vi.fn(async () => commentResp());
    const result = await runReviewComment({
      client: commentClient(reviewComment),
      proposalId: 'prop_9',
      ...base(repoRoot),
    });
    expect(result.target).toBe('proposal');
    expect(reviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ target_proposal_id: 'prop_9', target_version_id: null })
    );
  });

  it('defaults to the candidate when both candidate and proposal are cached', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    await seedProposal(repoRoot, { proposalId: 'prop_9' });
    const reviewComment = vi.fn(async () => commentResp());
    await runReviewComment({ client: commentClient(reviewComment), ...base(repoRoot) });
    expect(reviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ target_version_id: 'ver_4', target_proposal_id: null })
    );
  });

  it('passes quote + disambiguator through', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewComment = vi.fn(async () => commentResp());
    await runReviewComment({
      client: commentClient(reviewComment),
      quote: 'some span',
      disambiguator: 'preceding',
      ...base(repoRoot),
    });
    expect(reviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ quote: 'some span', disambiguator: 'preceding' })
    );
  });

  it('hard-errors NO_INPUT with no cached record', async () => {
    const err = await runReviewComment({
      client: commentClient(vi.fn(async () => commentResp())),
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
  });

  it('maps a PINNED CONFLICT to "comments are closed"', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewComment = vi.fn(async () => {
      throw new TrpcRequestError('conflict', { code: 'CONFLICT', httpStatus: 409 });
    });
    const err = await runReviewComment({
      client: commentClient(reviewComment),
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/comments are closed/i);
  });

  it('root comment sends parent_comment_id null', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    const reviewComment = vi.fn(async () => commentResp());
    await runReviewComment({ client: commentClient(reviewComment), ...base(repoRoot) });
    expect(reviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ parent_comment_id: null })
    );
  });

  it('reply: sends parent_comment_id with null targets/anchor and bypasses the cache', async () => {
    // No seedCandidate — a reply inherits the parent's target, so it must NOT
    // need a local record.
    const reviewComment = vi.fn(async () => commentResp());
    const result = await runReviewComment(replyArgs(reviewComment));
    expect(result.target).toBe('reply');
    expect(result.parent_comment_id).toBe('cmt_parent');
    expect(reviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_comment_id: 'cmt_parent',
        target_version_id: null,
        target_proposal_id: null,
        quote: null,
        disambiguator: null,
      })
    );
  });

  it('reply CONFLICT maps to the broad message (pinned / parent-not-found / reply-to-reply)', async () => {
    const reviewComment = vi.fn(async () => {
      // The cloud asserts pinned BEFORE resolving the parent, so any of the three
      // arrives as the same CONFLICT — the CLI must name all three, not guess one.
      throw new TrpcRequestError('cannot reply to a reply (one level only)', {
        code: 'CONFLICT',
        httpStatus: 409,
      });
    });
    const err = await runReviewComment(replyArgs(reviewComment)).then(
      () => null,
      (e: unknown) => e
    );
    const msg = (err as Error).message;
    expect(msg).toMatch(/parent comment was not found/i);
    expect(msg).toMatch(/one level only/i);
    expect(msg).toMatch(/pinned/i);
  });

  it('an empty reply id throws INVALID_INPUT before any client call (programmatic backstop)', async () => {
    const reviewComment = vi.fn(async () => commentResp());
    const err = await runReviewComment(replyArgs(reviewComment, '')).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'INVALID_INPUT' });
    expect(reviewComment).not.toHaveBeenCalled();
  });
});

describe('assertReplyTargetingExclusive', () => {
  it('rejects --reply-to combined with --quote / --disambiguator / --proposal', () => {
    expect(() => assertReplyTargetingExclusive({ replyTo: 'c', quote: 'q' })).toThrow(
      /cannot combine/
    );
    expect(() => assertReplyTargetingExclusive({ replyTo: 'c', disambiguator: 'd' })).toThrow(
      /cannot combine/
    );
    expect(() => assertReplyTargetingExclusive({ replyTo: 'c', proposal: 'p' })).toThrow(
      /cannot combine/
    );
  });

  it('allows --reply-to alone, and a root comment with anchors', () => {
    expect(() => assertReplyTargetingExclusive({ replyTo: 'c' })).not.toThrow();
    expect(() => assertReplyTargetingExclusive({ quote: 'q', proposal: 'p' })).not.toThrow();
    expect(() => assertReplyTargetingExclusive({})).not.toThrow();
  });
});

describe('assertNonEmptyCommentOptions', () => {
  it('rejects a present-but-empty option value', () => {
    expect(() => assertNonEmptyCommentOptions({ replyTo: '' })).toThrow(/--reply-to/);
    expect(() => assertNonEmptyCommentOptions({ proposal: '   ' })).toThrow(/--proposal/);
    expect(() => assertNonEmptyCommentOptions({ quote: '' })).toThrow(/--quote/);
    expect(() => assertNonEmptyCommentOptions({ replyTo: '' })).toThrow(/INVALID_INPUT|Empty/i);
  });

  it('allows absent options and non-empty values', () => {
    expect(() => assertNonEmptyCommentOptions({})).not.toThrow();
    expect(() => assertNonEmptyCommentOptions({ proposal: 'prop_9', quote: 'span' })).not.toThrow();
  });
});

describe('RunReviewCommentArgs union', () => {
  it('rejects an anchor on a reply at BOTH construction and use sites', () => {
    const reply: RunReplyCommentArgs = {
      kind: 'reply',
      client: commentClient(vi.fn(async () => commentResp())),
      baseUrl: 'https://cloud.example',
      orgId: 'org_1',
      externalId: 'ext-1',
      body: 'a comment',
      replyTo: 'cmt_parent',
    };
    // Use-site: the reply variant has no `quote`, so reading it must not compile.
    // @ts-expect-error — RunReplyCommentArgs has no `quote`.
    const _q: unknown = reply.quote;
    void _q;

    // Construction-site: an explicitly-written anchor on a reply literal is
    // excess-property rejected (TS2353) against the narrowed member — when the
    // literal is typed as the reply variant directly...
    const _badReply: RunReplyCommentArgs = {
      kind: 'reply',
      client: commentClient(vi.fn(async () => commentResp())),
      baseUrl: 'https://cloud.example',
      orgId: 'org_1',
      externalId: 'ext-1',
      body: 'a comment',
      replyTo: 'cmt_parent',
      // @ts-expect-error — `quote` is not a property of RunReplyCommentArgs.
      quote: 'oops',
    };
    void _badReply;

    // ...AND when typed as the union: TS narrows on `kind: 'reply'` and applies the
    // excess-property check to that member, so the anchor is rejected here too.
    const _badUnion: RunReviewCommentArgs = {
      kind: 'reply',
      client: commentClient(vi.fn(async () => commentResp())),
      baseUrl: 'https://cloud.example',
      orgId: 'org_1',
      externalId: 'ext-1',
      body: 'a comment',
      replyTo: 'cmt_parent',
      // @ts-expect-error — anchor on the reply member of the union is rejected too.
      quote: 'oops',
    };
    void _badUnion;

    expect(reply.replyTo).toBe('cmt_parent');
  });
});
