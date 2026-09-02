import { ORCAOPS_CAPABILITIES } from '@orcaops/core';
import type { OssSourcePlanReviewDecline, SourcePlanReviewDeclineResponse } from '@orcaops/sdk';

import {
  mapPlanCloudReadError,
  mapReviewAuthzError,
  requireRef,
  withReviewCloud,
} from './shared.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../../io/output.js';
import {
  assertNoSecretsOutbound,
  type WithSecretWarnings,
  withSecretWarnings,
  writeSecretWarnings,
} from '../../../lib/cloud-secret-gate.js';
import { loadSecretAllowlist } from '../../../lib/run-capture.js';
import { reviewUsageStamp, stampPlanReviewUsage } from '../../../lib/usage-stamp.js';

export interface ReviewDeclineOptions {
  proposal: string;
  reason?: string;
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud method `runReviewDecline` needs — fakeable in tests. */
export interface ReviewDeclineClient {
  sourcePlan: {
    declineProposal(input: OssSourcePlanReviewDecline): Promise<SourcePlanReviewDeclineResponse>;
  };
}

export interface ReviewDeclineResult {
  external_id: string;
  proposal_id: string;
  state: string;
  reason: string | null;
}

export interface RunReviewDeclineArgs {
  client: ReviewDeclineClient;
  externalId: string;
  proposalId: string;
  reason?: string;
}

/**
 * I/O-light core: author closes a proposal (OPEN → DECLINED) with an optional
 * recorded reason. Allowed while IN_REVIEW and APPROVED (triage continues);
 * blocked on PINNED. There is deliberately no CLI integrate — absorbing a
 * proposal stays `pull --proposal` → edit → `push`.
 */
export async function runReviewDecline(
  args: RunReviewDeclineArgs
): Promise<WithSecretWarnings<ReviewDeclineResult>> {
  const secretWarnings = assertNoSecretsOutbound(
    'plan-review-decline',
    [['reason', args.reason]],
    await loadSecretAllowlist()
  );
  let res: SourcePlanReviewDeclineResponse;
  try {
    res = await args.client.sourcePlan.declineProposal({
      schema_version: 1,
      external_id: args.externalId,
      proposal_id: args.proposalId,
      reason: args.reason ?? null,
    });
  } catch (err) {
    const mapped = mapPlanCloudReadError(err, {
      notFoundMessage: `Not found: proposal "${args.proposalId}" on "${args.externalId}". Check both ids — \`plan review view\` lists the open proposals.`,
      inputPath: 'plan-review-decline',
    });
    if (mapped !== err) throw mapped;
    throw mapReviewAuthzError(err, { command: 'decline' });
  }
  return withSecretWarnings(
    {
      external_id: res.externalId,
      proposal_id: res.proposalId,
      state: res.state,
      reason: res.reason,
    },
    secretWarnings
  );
}

/**
 * `plan review decline <ref> --proposal <id> [--reason]` — author-only triage:
 * close a proposal without absorbing it. The reason surfaces in `view` and on
 * the web.
 */
export async function reviewDeclineAction(ref: string, opts: ReviewDeclineOptions): Promise<void> {
  try {
    requireRef(ref, 'plan-review-decline');
    // The outbound secret gate runs HERE, before credential resolution and the
    // capability ping `withReviewCloud` makes, so a refusal precedes anything
    // authored reaching the network rather than only preceding the mutation.
    // The identical gate inside the run* core is defense in depth and is what
    // the client-injected core tests drive.
    assertNoSecretsOutbound(
      'plan-review-decline',
      [['reason', opts.reason]],
      await loadSecretAllowlist()
    );

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review decline',
      },
      (ctx) =>
        runReviewDecline({
          client: ctx.client,
          externalId: ref,
          proposalId: opts.proposal,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        })
    );

    // Stamp only a SUBSTANTIVE decline (a non-empty --reason); a bare decline is
    // ~0 authoring and is excluded.
    if (opts.reason !== undefined && opts.reason.trim().length > 0) {
      await stampPlanReviewUsage(
        reviewUsageStamp('decline', result.external_id, result.proposal_id, opts.reason)
      );
    }

    writeSecretWarnings(result.secret_warnings);
    if (opts.json) {
      emitOk(result);
      return;
    }
    let out = `Declined proposal ${result.proposal_id} on ${result.external_id}\n`;
    if (result.reason) out += `  reason: ${result.reason}\n`;
    writeTerminalSafeStdout(out);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
