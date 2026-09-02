import {
  ORCAOPS_CAPABILITIES,
  type OssSourcePlanBaseline,
  resolveReviewBaseline,
} from '@orcaops/core';
import type { OssSourcePlanReviewPropose, SourcePlanReviewProposeResponse } from '@orcaops/sdk';
import {
  firstForbiddenControlChar,
  readReviewCandidate,
  sha256Hex,
  sourcePlanCacheDir,
  writeReviewPullRecord,
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

export interface ReviewProposeOptions {
  input?: string;
  baseVersionId?: string;
  supersedes?: string;
  summary?: string;
  sourceRef?: string;
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud method `runReviewPropose` needs — fakeable in tests. */
export interface ReviewProposeClient {
  sourcePlan: {
    reviewPropose(input: OssSourcePlanReviewPropose): Promise<SourcePlanReviewProposeResponse>;
  };
}

export interface ReviewProposeResult {
  external_id: string;
  proposal_id: string;
  base_version_id: string;
  needs_rebase: boolean;
  /** The resolved cloud base — the hints carry it when it isn't the default. */
  base_url: string;
}

export interface RunReviewProposeArgs {
  client: ReviewProposeClient;
  repoRoot: string;
  baseUrl: string;
  orgId: string;
  externalId: string;
  body: string;
  /** `--base-version-id` escape hatch: take it verbatim, SKIP the cache read. */
  baseVersionIdOverride?: string;
  supersedesProposalId?: string;
  summary?: string;
  sourceRef?: string;
  /** Advisory authoring baseline (resolved by the action; optional so fakes skip it). */
  baseline?: OssSourcePlanBaseline | null;
  pulledAt: string;
}

/** Resolve the base candidate version id from the local cache, or hard-error. */
async function resolveBaseVersionId(args: RunReviewProposeArgs): Promise<string> {
  if (args.baseVersionIdOverride !== undefined) return args.baseVersionIdOverride;
  const rec = await readReviewCandidate(
    sourcePlanCacheDir(args.repoRoot),
    args.baseUrl,
    args.orgId,
    args.externalId,
    args.repoRoot
  );
  if (!rec || rec.version_id === null) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `No pulled candidate for "${args.externalId}". Run \`orcaops plan review pull ${args.externalId}\` first ` +
        `(refs are externalIds — \`pull\` prints the canonical one), or pass --base-version-id <id>.`,
      'plan-review-propose'
    );
  }
  return rec.version_id;
}

/**
 * I/O-light core: resolve the base candidate version (local record or override),
 * send the edited body as a proposal, and persist a proposal record so a
 * follow-up `comment` can target it without a re-pull. NO conflict path — a
 * stale base is simply born `needs_rebase` (surfaced as a ⚠, never an error).
 */
export async function runReviewPropose(
  args: RunReviewProposeArgs
): Promise<WithSecretWarnings<ReviewProposeResult>> {
  const secretWarnings = assertNoSecretsOutbound(
    'plan-review-propose',
    [
      ['body', args.body],
      ['summary', args.summary],
      ['source_ref', args.sourceRef],
    ],
    await loadSecretAllowlist()
  );
  // ASSERT (never strip) the wire control-char policy BEFORE any wire
  // call: content_hash seals these exact bytes, so a dirty body would
  // become an approved, hash-anchored plan that `plan pull` must
  // permanently reject — a trap this CLI would have minted itself.
  const forbidden = firstForbiddenControlChar(args.body);
  if (forbidden !== null) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `the plan body contains a forbidden control character ` +
        `(U+${forbidden.code.toString(16).toUpperCase().padStart(4, '0')} at offset ${forbidden.index}). ` +
        `Remove the byte and re-run — an approved plan is hash-anchored, so a dirty body ` +
        `would be permanently unpullable.`,
      'plan-review-propose'
    );
  }
  const baseVersionId = await resolveBaseVersionId(args);
  const contentHash = sha256Hex(args.body);

  let res: SourcePlanReviewProposeResponse;
  try {
    res = await args.client.sourcePlan.reviewPropose({
      schema_version: 1,
      external_id: args.externalId,
      body: args.body,
      content_hash: contentHash,
      base_version_id: baseVersionId,
      supersedes_proposal_id: args.supersedesProposalId ?? null,
      summary: args.summary ?? null,
      source_ref: args.sourceRef ?? null,
      baseline: args.baseline ?? null,
    });
  } catch (err) {
    throw mapReviewAuthzError(err, {
      command: 'propose',
      supersedes: args.supersedesProposalId !== undefined,
    });
  }

  // Persist the new proposal (version_id/version_number null — propose's response
  // has neither; proposal_id + the local body/hash are what `comment` needs).
  await writeReviewPullRecord(
    sourcePlanCacheDir(args.repoRoot),
    {
      schema_version: 1,
      target: 'proposal',
      external_id: res.externalId,
      version_id: null,
      version_number: null,
      proposal_id: res.proposalId,
      base_version_number: null,
      content_hash: contentHash,
      body: args.body,
      base_url: args.baseUrl,
      org_id: args.orgId,
      pulled_at: args.pulledAt,
    },
    args.repoRoot
  );

  return withSecretWarnings(
    {
      external_id: res.externalId,
      proposal_id: res.proposalId,
      base_version_id: res.baseVersionId,
      needs_rebase: res.needsRebase,
      base_url: args.baseUrl,
    },
    secretWarnings
  );
}

/**
 * File the edited body as a reviewer proposal off the pulled candidate (or
 * `--base-version-id`). Anyone with access may propose; `--supersedes <id>`
 * chains a rebase over the caller's own OPEN proposal.
 */
export async function reviewProposeAction(
  ref: string,
  opts: ReviewProposeOptions = {}
): Promise<void> {
  try {
    requireRef(ref, 'plan-review-propose');
    const body = await readBodyInput({ input: opts.input });
    // Gate the wire control-char policy IMMEDIATELY after reading —
    // before credential resolution and withReviewCloud's ping — so a
    // dirty body is diagnosable offline and costs no round trip. The
    // identical gate inside the run* core is defense in depth.
    const dirty = firstForbiddenControlChar(body);
    if (dirty !== null) {
      throw new OrcaopsError(
        ErrorCodes.NO_INPUT,
        `the plan body contains a forbidden control character ` +
          `(U+${dirty.code.toString(16).toUpperCase().padStart(4, '0')} at offset ${dirty.index}). ` +
          `Remove the byte and re-run — an approved plan is hash-anchored, so a dirty body ` +
          `would be permanently unpullable.`,
        'plan-review-propose'
      );
    }

    // The outbound secret gate runs HERE, before credential resolution and the
    // capability ping `withReviewCloud` makes, so a refusal precedes anything
    // authored reaching the network rather than only preceding the mutation.
    // The identical gate inside the run* core is defense in depth and is what
    // the client-injected core tests drive.
    assertNoSecretsOutbound(
      'plan-review-propose',
      [
        ['body', body],
        ['summary', opts.summary],
      ],
      await loadSecretAllowlist()
    );

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review propose',
      },
      async (ctx) =>
        runReviewPropose({
          client: ctx.client,
          repoRoot: ctx.repoRoot,
          baseUrl: ctx.baseUrl,
          orgId: ctx.orgId,
          externalId: ref,
          body,
          ...(opts.baseVersionId ? { baseVersionIdOverride: opts.baseVersionId } : {}),
          ...(opts.supersedes ? { supersedesProposalId: opts.supersedes } : {}),
          ...(opts.summary ? { summary: opts.summary } : {}),
          ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
          baseline: await resolveReviewBaseline(ctx.repo),
          pulledAt: new Date().toISOString(),
        })
    );

    await stampPlanReviewUsage(reviewUsageStamp('propose', result.external_id, result.proposal_id));

    writeSecretWarnings(result.secret_warnings);
    if (opts.json) {
      emitOk(result);
      return;
    }
    let out = `Filed proposal ${result.proposal_id} on ${result.external_id} (base ${result.base_version_id})\n`;
    if (result.needs_rebase) {
      out += `  ⚠ needs rebase — the candidate has advanced past this base; rebase before it can be integrated.\n`;
    }
    out += `  comment on it: orcaops plan review comment ${result.external_id} --proposal ${result.proposal_id} --input <file>\n`;
    writeTerminalSafeStdout(out);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
