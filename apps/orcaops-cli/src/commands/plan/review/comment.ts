import { ORCAOPS_CAPABILITIES } from '@orcaops/core';
import type { OssSourcePlanReviewComment, SourcePlanReviewCommentResponse } from '@orcaops/sdk';
import {
  firstForbiddenControlChar,
  readReviewCandidate,
  readReviewProposal,
  sourcePlanCacheDir,
} from '@orcaops/storage';

import { mapReviewAuthzError, requireRef, withReviewCloud } from './shared.js';
import { readBodyInput } from '../../../io/body-input.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../../io/output.js';
import {
  assertNoSecretsOutbound,
  type WithSecretWarnings,
  withSecretWarnings,
  writeSecretWarnings,
} from '../../../lib/cloud-secret-gate.js';
import { loadSecretAllowlist } from '../../../lib/run-capture.js';
import { reviewUsageStamp, stampPlanReviewUsage } from '../../../lib/usage-stamp.js';

export interface ReviewCommentOptions {
  input?: string;
  quote?: string;
  disambiguator?: string;
  proposal?: string;
  replyTo?: string;
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud method `runReviewComment` needs — fakeable in tests. */
export interface ReviewCommentClient {
  sourcePlan: {
    reviewComment(input: OssSourcePlanReviewComment): Promise<SourcePlanReviewCommentResponse>;
  };
}

export interface ReviewCommentResult {
  external_id: string;
  comment_id: string;
  /** 'candidate' | 'proposal' for a root comment; 'reply' when --reply-to was used. */
  target: 'candidate' | 'proposal' | 'reply';
  /** The parent comment id — present only on a reply. */
  parent_comment_id?: string;
}

/** Fields shared by both comment shapes. */
interface RunReviewCommentBase {
  client: ReviewCommentClient;
  baseUrl: string;
  orgId: string;
  externalId: string;
  body: string;
}

/**
 * A root comment on the candidate (default) or a proposal (`--proposal <id>`),
 * optionally anchored with `--quote` / `--disambiguator`.
 */
export interface RunRootCommentArgs extends RunReviewCommentBase {
  kind: 'root';
  /** Worktree root — needed to read the pulled candidate / proposal record. */
  repoRoot: string;
  quote?: string;
  disambiguator?: string;
  /** `--proposal <id>` selects the proposal target (else the candidate). */
  proposalId?: string;
}

/**
 * A one-level reply (`--reply-to <commentId>`): inherits the parent's target and
 * carries no anchor, so `quote` / `disambiguator` / `proposalId` are intentionally
 * absent here — a reply that tries to carry an anchor is a compile error.
 */
export interface RunReplyCommentArgs extends RunReviewCommentBase {
  kind: 'reply';
  replyTo: string;
}

/** Discriminated on `kind` so the anchor/reply conflict is unrepresentable. */
export type RunReviewCommentArgs = RunRootCommentArgs | RunReplyCommentArgs;

/**
 * I/O-light core: derive EXACTLY ONE target from the local record(s) — a
 * candidate (`target_version_id`) or, when `--proposal` is given, a proposal
 * (`target_proposal_id`) — then post the comment. The protocol superRefine
 * rejects both-null/both-set, so the exactly-one derivation here is load-bearing.
 */
export async function runReviewComment(
  args: RunReviewCommentArgs
): Promise<WithSecretWarnings<ReviewCommentResult>> {
  const secretWarnings = assertNoSecretsOutbound(
    'plan-review-comment',
    [
      ['body', args.body],
      ['quote', args.kind === 'root' ? args.quote : undefined],
      ['disambiguator', args.kind === 'root' ? args.disambiguator : undefined],
    ],
    await loadSecretAllowlist()
  );
  // A reply inherits the parent comment's target and carries no anchor, so no
  // local candidate/proposal record is needed — bypass the target derivation.
  if (args.kind === 'reply') {
    // The opts boundary guards empties for the CLI; this backstops a programmatic
    // caller passing an empty id (the SDK forwards input without local parsing, so
    // an empty id would otherwise fail only at the cloud — or silently in tests).
    if (args.replyTo.trim() === '') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--reply-to requires a comment id.',
        'plan-review-comment'
      );
    }
    let replyRes: SourcePlanReviewCommentResponse;
    try {
      replyRes = await args.client.sourcePlan.reviewComment({
        schema_version: 1,
        external_id: args.externalId,
        parent_comment_id: args.replyTo,
        target_version_id: null,
        target_proposal_id: null,
        body: args.body,
        quote: null,
        disambiguator: null,
      });
    } catch (err) {
      throw mapReviewAuthzError(err, { command: 'comment', reply: true });
    }
    return withSecretWarnings(
      {
        external_id: replyRes.externalId,
        comment_id: replyRes.commentId,
        target: 'reply',
        parent_comment_id: args.replyTo,
      },
      secretWarnings
    );
  }

  const cacheDir = sourcePlanCacheDir(args.repoRoot);

  let targetVersionId: string | null = null;
  let targetProposalId: string | null = null;
  let target: 'candidate' | 'proposal';

  if (args.proposalId !== undefined) {
    const prop = await readReviewProposal(
      cacheDir,
      args.baseUrl,
      args.orgId,
      args.proposalId,
      args.repoRoot
    );
    if (!prop) {
      throw new OrcaopsError(
        ErrorCodes.NO_INPUT,
        `No pulled proposal "${args.proposalId}" for "${args.externalId}". ` +
          `Run \`orcaops plan review pull ${args.externalId} --proposal ${args.proposalId}\` first.`,
        'plan-review-comment'
      );
    }
    targetProposalId = args.proposalId;
    target = 'proposal';
  } else {
    const cand = await readReviewCandidate(
      cacheDir,
      args.baseUrl,
      args.orgId,
      args.externalId,
      args.repoRoot
    );
    if (!cand || cand.version_id === null) {
      throw new OrcaopsError(
        ErrorCodes.NO_INPUT,
        `No pulled candidate for "${args.externalId}". Run \`orcaops plan review pull ${args.externalId}\` first, ` +
          `or pass --proposal <id> to comment on a proposal.`,
        'plan-review-comment'
      );
    }
    targetVersionId = cand.version_id;
    target = 'candidate';
  }

  let res: SourcePlanReviewCommentResponse;
  try {
    res = await args.client.sourcePlan.reviewComment({
      schema_version: 1,
      external_id: args.externalId,
      parent_comment_id: null,
      target_version_id: targetVersionId,
      target_proposal_id: targetProposalId,
      body: args.body,
      quote: args.quote ?? null,
      disambiguator: args.disambiguator ?? null,
    });
  } catch (err) {
    throw mapReviewAuthzError(err, { command: 'comment' });
  }

  return withSecretWarnings(
    { external_id: res.externalId, comment_id: res.commentId, target },
    secretWarnings
  );
}

/**
 * A reply inherits the parent comment's target and carries no anchor, so
 * `--reply-to` cannot combine with `--quote` / `--disambiguator` / `--proposal`.
 * Commander's `.conflicts()` rejects it at the parser; this is the testable
 * backstop for the CLI opts boundary. (Programmatic callers can't express the
 * conflict at all — the core `RunReviewCommentArgs` union has no anchor fields on
 * its reply variant.) The cloud enforces it too.
 */
export function assertReplyTargetingExclusive(opts: {
  replyTo?: string;
  quote?: string;
  disambiguator?: string;
  proposal?: string;
}): void {
  if (
    opts.replyTo !== undefined &&
    (opts.quote !== undefined || opts.disambiguator !== undefined || opts.proposal !== undefined)
  ) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      "--reply-to inherits the parent comment's target and carries no anchor; it cannot combine with --quote / --disambiguator / --proposal.",
      'plan-review-comment'
    );
  }
}

/**
 * The SDK forwards input to the cloud WITHOUT local protocol parsing (it Zod-parses
 * only the response), so the protocol's `min(1)` on these fields runs server-side
 * only. Reject a present-but-empty value here so it fails as a clean local
 * `INVALID_INPUT` before any cloud round-trip — instead of an opaque cloud error
 * (or, with a fake client in tests, slipping through silently). Pairs with the
 * presence-based (`!== undefined`) option spreads below so a non-empty value never
 * mis-routes.
 */
export function assertNonEmptyCommentOptions(opts: {
  replyTo?: string;
  proposal?: string;
  quote?: string;
  disambiguator?: string;
}): void {
  const flags = {
    replyTo: '--reply-to',
    proposal: '--proposal',
    quote: '--quote',
    disambiguator: '--disambiguator',
  } as const;
  const empty = (Object.keys(flags) as (keyof typeof flags)[]).filter((k) => {
    const v = opts[k];
    return v !== undefined && v.trim() === '';
  });
  if (empty.length > 0) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Empty value for ${empty.map((k) => flags[k]).join(', ')}; provide a value or omit.`,
      'plan-review-comment'
    );
  }
}

/**
 * Post a comment on the pulled candidate (default) or a proposal (`--proposal
 * <id>`), or reply to an existing comment (`--reply-to <commentId>`). `--quote
 * <text>` anchors a root comment to a span (cloud-resolved; add `--disambiguator`
 * when the quote repeats); omit `--quote` for a whole-body note. Allowed by anyone
 * with access; rejected on a PINNED plan.
 */
export async function reviewCommentAction(
  ref: string,
  opts: ReviewCommentOptions = {}
): Promise<void> {
  try {
    requireRef(ref, 'plan-review-comment');
    assertReplyTargetingExclusive(opts);
    assertNonEmptyCommentOptions(opts);
    const body = await readBodyInput({ input: opts.input });
    // Gate the wire control-char policy IMMEDIATELY after reading —
    // before credential resolution and withReviewCloud's ping — for the
    // body AND the quote anchor: both land cloud-side and are pulled
    // back into the local review transcript.
    for (const [label, text] of [
      ['body', body],
      ['quote', opts.quote ?? ''],
    ] as const) {
      const dirty = firstForbiddenControlChar(text);
      if (dirty !== null) {
        throw new OrcaopsError(
          ErrorCodes.NO_INPUT,
          `the comment ${label} contains a forbidden control character ` +
            `(U+${dirty.code.toString(16).toUpperCase().padStart(4, '0')} at offset ${dirty.index}). ` +
            `Remove the byte and re-run — the cloud transcript rejects it on the way back down.`,
          'plan-review-comment'
        );
      }
    }

    // The outbound secret gate runs HERE, before credential resolution and the
    // capability ping `withReviewCloud` makes, so a refusal precedes anything
    // authored reaching the network rather than only preceding the mutation.
    // The identical gate inside the run* core is defense in depth and is what
    // the client-injected core tests drive.
    assertNoSecretsOutbound(
      'plan-review-comment',
      [
        ['body', body],
        ['quote', opts.quote],
        ['disambiguator', opts.disambiguator],
      ],
      await loadSecretAllowlist()
    );

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review comment',
      },
      (ctx) =>
        runReviewComment(
          opts.replyTo !== undefined
            ? {
                kind: 'reply',
                client: ctx.client,
                baseUrl: ctx.baseUrl,
                orgId: ctx.orgId,
                externalId: ref,
                body,
                replyTo: opts.replyTo,
              }
            : {
                kind: 'root',
                client: ctx.client,
                repoRoot: ctx.repoRoot,
                baseUrl: ctx.baseUrl,
                orgId: ctx.orgId,
                externalId: ref,
                body,
                ...(opts.quote !== undefined ? { quote: opts.quote } : {}),
                ...(opts.disambiguator !== undefined ? { disambiguator: opts.disambiguator } : {}),
                ...(opts.proposal !== undefined ? { proposalId: opts.proposal } : {}),
              }
        )
    );

    await stampPlanReviewUsage(reviewUsageStamp('comment', result.external_id, result.comment_id));

    writeSecretWarnings(result.secret_warnings);
    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(
      result.target === 'reply'
        ? `Posted reply ${result.comment_id} to comment ${result.parent_comment_id} on ${result.external_id}.\n`
        : `Posted comment ${result.comment_id} on the ${result.target} of ${result.external_id}.\n`
    );
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
