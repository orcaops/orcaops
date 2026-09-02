import { ORCAOPS_CAPABILITIES } from '@orcaops/core';
import type { OssSourcePlanReviewVerdict, SourcePlanReviewVerdictResponse } from '@orcaops/sdk';

import {
  mapPlanCloudReadError,
  mapReviewAuthzError,
  requireRef,
  withReviewCloud,
} from './shared.js';
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

export interface ReviewVerdictOptions {
  approve?: boolean;
  requestChanges?: boolean;
  note?: string;
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud method `runReviewVerdict` needs — fakeable in tests. */
export interface ReviewVerdictClient {
  sourcePlan: {
    setReviewerVerdict(input: OssSourcePlanReviewVerdict): Promise<SourcePlanReviewVerdictResponse>;
  };
}

export type VerdictValue = 'approved' | 'changes_requested';

/**
 * Exactly one of --approve / --request-changes. Commander's `conflicts` guards
 * the both-set case at the parser; this helper is the testable backstop and the
 * neither-set rejection.
 */
export function parseVerdictValue(opts: {
  approve?: boolean;
  requestChanges?: boolean;
}): VerdictValue {
  if (opts.approve && opts.requestChanges) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--approve and --request-changes are mutually exclusive.',
      'plan-review-verdict'
    );
  }
  if (opts.approve) return 'approved';
  if (opts.requestChanges) return 'changes_requested';
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    'Pass exactly one of --approve or --request-changes.',
    'plan-review-verdict'
  );
}

export interface ReviewVerdictResult {
  external_id: string;
  /** Cloud-resolved from the bearer identity — whoever ran the command. */
  reviewer: string;
  state: string;
  note: string | null;
  updated_at: string | null;
}

export interface RunReviewVerdictArgs {
  client: ReviewVerdictClient;
  externalId: string;
  verdict: VerdictValue;
  note?: string;
}

/**
 * I/O-light core: record the CALLER's advisory verdict. ADVISORY is the
 * contract — this never transitions plan status (the APPROVED transition is
 * web-session-only), and there is no value for clearing back to PENDING (also
 * web-only).
 */
export async function runReviewVerdict(
  args: RunReviewVerdictArgs
): Promise<WithSecretWarnings<ReviewVerdictResult>> {
  const secretWarnings = assertNoSecretsOutbound(
    'plan-review-verdict',
    [['note', args.note]],
    await loadSecretAllowlist()
  );
  let res: SourcePlanReviewVerdictResponse;
  try {
    res = await args.client.sourcePlan.setReviewerVerdict({
      schema_version: 1,
      external_id: args.externalId,
      verdict: args.verdict,
      note: args.note ?? null,
    });
  } catch (err) {
    const mapped = mapPlanCloudReadError(err, {
      notFoundMessage: `Not found: a plan under review for "${args.externalId}". Check the ref (refs are externalIds).`,
      inputPath: 'plan-review-verdict',
    });
    if (mapped !== err) throw mapped;
    throw mapReviewAuthzError(err, { command: 'verdict' });
  }
  return withSecretWarnings(
    {
      external_id: res.externalId,
      reviewer: res.reviewer,
      state: res.state,
      note: res.note,
      updated_at: res.updatedAt,
    },
    secretWarnings
  );
}

/**
 * `plan review verdict <ref> (--approve | --request-changes) [--note]` — the
 * reviewer-seat opinion, ≈ `gh pr review --approve|--request-changes`. Named
 * `verdict` deliberately: `approve` is reserved for the author-side web
 * approval launcher, and these flags never transition the plan.
 */
export async function reviewVerdictAction(
  ref: string,
  opts: ReviewVerdictOptions = {}
): Promise<void> {
  try {
    requireRef(ref, 'plan-review-verdict');
    const verdict = parseVerdictValue(opts);
    // The outbound secret gate runs HERE, before credential resolution and the
    // capability ping `withReviewCloud` makes, so a refusal precedes anything
    // authored reaching the network rather than only preceding the mutation.
    // The identical gate inside the run* core is defense in depth and is what
    // the client-injected core tests drive.
    assertNoSecretsOutbound(
      'plan-review-verdict',
      [['note', opts.note]],
      await loadSecretAllowlist()
    );

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review verdict',
      },
      (ctx) =>
        runReviewVerdict({
          client: ctx.client,
          externalId: ref,
          verdict,
          ...(opts.note !== undefined ? { note: opts.note } : {}),
        })
    );

    // Stamp only a SUBSTANTIVE verdict (a non-empty --note); a bare verdict is
    // ~0 authoring and is excluded.
    if (opts.note !== undefined && opts.note.trim().length > 0) {
      await stampPlanReviewUsage(reviewUsageStamp('verdict', result.external_id, opts.note));
    }

    writeSecretWarnings(result.secret_warnings);
    if (opts.json) {
      emitOk(result);
      return;
    }
    let out = `Recorded verdict ${result.state} on ${result.external_id} (reviewer: ${result.reviewer})\n`;
    if (result.note) out += `  note: ${result.note}\n`;
    out += '  Advisory only — approval itself happens on the web.\n';
    writeTerminalSafeStdout(out);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
