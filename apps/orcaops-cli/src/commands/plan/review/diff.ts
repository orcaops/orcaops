import { createTwoFilesPatch } from 'diff';

import { ORCAOPS_CAPABILITIES } from '@orcaops/core';
import type {
  OssSourcePlanReviewPull,
  SourcePlanApprovedPull,
  SourcePlanReviewPullResponse,
} from '@orcaops/sdk';
import { sha256Hex } from '@orcaops/storage';

import { parseVersionFlag } from './pull.js';
import { mapPlanCloudReadError, requireRef, withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../../io/errors.js';
import { emitError, emitOk, writePipeFriendlyStdout } from '../../../io/output.js';

export interface ReviewDiffOptions {
  proposal?: string;
  /** Sealed version number for the FROM side (version-to-version diff). */
  from?: string;
  /** Sealed version number for the TO side (defaults to the current candidate). */
  to?: string;
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud methods `runReviewDiff` needs — fakeable in tests. */
export interface ReviewDiffClient {
  sourcePlan: {
    getApproved(input: { slugOrExternalId: string }): Promise<SourcePlanApprovedPull>;
    reviewPull(input: OssSourcePlanReviewPull): Promise<SourcePlanReviewPullResponse>;
  };
}

export interface ReviewDiffSide {
  target: 'approved' | 'candidate' | 'proposal' | 'version';
  versionNumber: number | null;
  proposalId?: string;
}

export interface ReviewDiffResult {
  externalId: string;
  from: ReviewDiffSide;
  to: ReviewDiffSide;
  identical: boolean;
  unified: string;
}

export interface RunReviewDiffArgs {
  client: ReviewDiffClient;
  externalId: string;
  proposalId?: string;
  /** Sealed FROM version (mutually exclusive with proposalId). */
  fromVersion?: number;
  /** Sealed TO version; requires fromVersion (omitted = current candidate). */
  toVersion?: number;
}

function verifyBody(externalId: string, label: string, body: string, contentHash: string): void {
  const actual = sha256Hex(body);
  if (actual !== contentHash) {
    throw new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      `Integrity check failed for the ${label} of "${externalId}": sha256(body)=${actual} != contentHash=${contentHash}. The body was altered in transit; retry.`,
      'plan-review-diff'
    );
  }
}

/**
 * I/O-light core, rendered LOCALLY off direct SDK fetches — deliberately NOT
 * `runReviewPull`: diff is a read and must never write the review cache (a
 * cache write would clobber an in-flight edit's CAS token). Three renderable
 * comparisons:
 *
 *   default       approved → candidate   ("what changed since the pin source")
 *   --proposal    candidate → proposal   (the integration view)
 *   --from n      vN → candidate         ("what changed since I reviewed vN?")
 *     [--to m]    vN → vM                (any two sealed versions)
 *
 * A `--from`/`--to` fetch that receives a candidate response throws the SDK's
 * `CloudWireError`. It is deliberately not caught: a hard CLOUD_ERROR beats a
 * wrong-body diff.
 */
export async function runReviewDiff(args: RunReviewDiffArgs): Promise<ReviewDiffResult> {
  if (args.fromVersion !== undefined && args.proposalId) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--from/--to and --proposal are mutually exclusive — a version diff has no proposal side.',
      'plan-review-diff'
    );
  }
  if (args.toVersion !== undefined && args.fromVersion === undefined) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--to requires --from (omit --to to diff against the current candidate).',
      'plan-review-diff'
    );
  }

  const pullBody = async (sel: {
    proposalId?: string;
    versionNumber?: number;
  }): Promise<SourcePlanReviewPullResponse> => {
    try {
      return await args.client.sourcePlan.reviewPull({
        schema_version: 1,
        external_id: args.externalId,
        proposal_id: sel.proposalId ?? null,
        version_number: sel.versionNumber ?? null,
      });
    } catch (err) {
      const notFoundMessage =
        sel.versionNumber !== undefined
          ? `Version ${sel.versionNumber} does not exist for "${args.externalId}" (\`plan review view\` shows the current candidate version).`
          : `Not found: ${
              sel.proposalId
                ? `proposal "${sel.proposalId}" on "${args.externalId}"`
                : `a review candidate for "${args.externalId}"`
            }. Check the ref and that the plan is in review.`;
      throw mapPlanCloudReadError(err, { notFoundMessage, inputPath: 'plan-review-diff' });
    }
  };
  const pullVersion = async (n: number): Promise<SourcePlanReviewPullResponse> => {
    const v = await pullBody({ versionNumber: n });
    verifyBody(args.externalId, `sealed v${n}`, v.body, v.contentHash);
    return v;
  };
  const pullCandidate = async (): Promise<SourcePlanReviewPullResponse> => {
    const c = await pullBody({});
    verifyBody(args.externalId, 'candidate', c.body, c.contentHash);
    return c;
  };

  let externalId: string;
  let from: ReviewDiffSide;
  let fromLabel: string;
  let fromBody: string;
  let to: ReviewDiffSide;
  let toLabel: string;
  let toBody: string;

  if (args.fromVersion !== undefined) {
    const fromV = await pullVersion(args.fromVersion);
    from = { target: 'version', versionNumber: fromV.versionNumber };
    fromLabel = `v${fromV.versionNumber}`;
    fromBody = fromV.body;
    if (args.toVersion !== undefined) {
      const toV = await pullVersion(args.toVersion);
      to = { target: 'version', versionNumber: toV.versionNumber };
      toLabel = `v${toV.versionNumber}`;
      toBody = toV.body;
    } else {
      const candidate = await pullCandidate();
      to = { target: 'candidate', versionNumber: candidate.versionNumber };
      toLabel = `candidate v${candidate.versionNumber}`;
      toBody = candidate.body;
    }
    externalId = fromV.externalId;
  } else if (args.proposalId) {
    const candidate = await pullCandidate();
    const proposal = await pullBody({ proposalId: args.proposalId });
    verifyBody(args.externalId, 'proposal', proposal.body, proposal.contentHash);
    from = { target: 'candidate', versionNumber: candidate.versionNumber };
    fromLabel = `candidate v${candidate.versionNumber}`;
    fromBody = candidate.body;
    to = {
      target: 'proposal',
      versionNumber: proposal.baseVersionNumber,
      proposalId: args.proposalId,
    };
    toLabel = `proposal ${args.proposalId} (base v${proposal.baseVersionNumber})`;
    toBody = proposal.body;
    externalId = candidate.externalId;
  } else {
    const candidate = await pullCandidate();
    let approved: SourcePlanApprovedPull;
    try {
      approved = await args.client.sourcePlan.getApproved({ slugOrExternalId: args.externalId });
    } catch (err) {
      throw mapPlanCloudReadError(err, {
        notFoundMessage: `No APPROVED version for "${args.externalId}" — nothing to diff against. (\`diff --proposal <id>\` compares against the candidate; \`diff --from <n>\` compares sealed versions.)`,
        inputPath: 'plan-review-diff',
      });
    }
    verifyBody(
      args.externalId,
      'approved version',
      approved.approvedVersion.body,
      approved.approvedVersion.contentHash
    );
    from = { target: 'approved', versionNumber: approved.approvedVersion.versionNumber };
    fromLabel = `approved v${approved.approvedVersion.versionNumber}`;
    fromBody = approved.approvedVersion.body;
    to = { target: 'candidate', versionNumber: candidate.versionNumber };
    toLabel = `candidate v${candidate.versionNumber}`;
    toBody = candidate.body;
    externalId = candidate.externalId;
  }

  const identical = fromBody === toBody;
  const unified = identical
    ? ''
    : createTwoFilesPatch(fromLabel, toLabel, fromBody, toBody, undefined, undefined, {
        context: 3,
      });

  return { externalId, from, to, identical, unified };
}

/**
 * `plan review diff <ref> [--proposal <id> | --from <n> [--to <m>]]` — prose
 * diff rendered locally. Default compares the approved version to the current
 * candidate; --proposal compares the candidate to that proposal (most useful
 * when it needs a rebase); --from compares a sealed version to the candidate
 * (or to --to's sealed version) — the "what changed since I reviewed vN?"
 * read. Read-only — never writes the review cache.
 */
export async function reviewDiffAction(ref: string, opts: ReviewDiffOptions = {}): Promise<void> {
  try {
    requireRef(ref, 'plan-review-diff');
    const fromVersion =
      opts.from !== undefined
        ? parseVersionFlag(opts.from, '--from', 'plan-review-diff')
        : undefined;
    const toVersion =
      opts.to !== undefined ? parseVersionFlag(opts.to, '--to', 'plan-review-diff') : undefined;
    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        // Naming a version pins the pull to that revision, which is the
        // separately-advertised capability; a bare diff of the latest is not.
        requires:
          fromVersion !== undefined || toVersion !== undefined
            ? [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW, ORCAOPS_CAPABILITIES.REVIEW_VERSION_PULL]
            : [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review diff',
      },
      (ctx) =>
        runReviewDiff({
          client: ctx.client,
          externalId: ref,
          ...(opts.proposal ? { proposalId: opts.proposal } : {}),
          ...(fromVersion !== undefined ? { fromVersion } : {}),
          ...(toVersion !== undefined ? { toVersion } : {}),
        })
    );

    if (opts.json) {
      emitOk(result);
      return;
    }
    writePipeFriendlyStdout(result.identical ? 'No differences.\n' : result.unified);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
