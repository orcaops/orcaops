import {
  ORCAOPS_CAPABILITIES,
  type OssSourcePlanBaseline,
  resolveReviewBaseline,
} from '@orcaops/core';
import type { OssSourcePlanReviewPropose, SourcePlanReviewProposeResponse } from '@orcaops/sdk';
import { firstForbiddenControlChar, sha256Hex } from '@orcaops/storage';

import type { PlanReviewPersistence } from './persistence.js';
import {
  cloudRetryFlags,
  createReviewMutation,
  mapReviewAuthzError,
  pulledRefMissError,
  refuseAliasedRef,
  requireRef,
  withReviewCloud,
} from './shared.js';
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
import { reviewUsageStamp } from '../../../lib/usage-stamp.js';

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
  local_record_advanced?: false;
}

export interface RunReviewProposeArgs {
  persistence: PlanReviewPersistence;
  client: ReviewProposeClient;
  repoRoot: string;
  baseUrl: string;
  orgId: string;
  externalId: string;
  body: string;
  /** `--base-version-id` escape hatch: take it verbatim, skip the retained read. */
  baseVersionIdOverride?: string;
  supersedesProposalId?: string;
  summary?: string;
  sourceRef?: string;
  /** Advisory authoring baseline (resolved by the action; optional so fakes skip it). */
  baseline?: OssSourcePlanBaseline | null;
  pulledAt: string;
  retryFlags?: readonly string[];
}

/** Resolve the base candidate version id from project history, or hard-error. */
async function resolveBaseVersionId(args: RunReviewProposeArgs): Promise<string> {
  if (args.baseVersionIdOverride !== undefined) return args.baseVersionIdOverride;
  const rec = await args.persistence.readCandidate(args.externalId);
  if (!rec || rec.version_id === null) throw await pulledRefMissError(refusalRequest(args));
  return rec.version_id;
}

function refusalRequest(args: RunReviewProposeArgs) {
  return {
    persistence: args.persistence,
    ref: args.externalId,
    command: 'propose' as const,
    ...(args.retryFlags ? { retryFlags: args.retryFlags } : {}),
    escape: 'pass --base-version-id <id>',
  };
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
  // Before any wire work, including when --base-version-id skips the cache read.
  await refuseAliasedRef(refusalRequest(args));
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
  await args.persistence.preflight();
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
  // Retaining a record whose id differs from the admission's typed ref raises
  // IDEMPOTENCY_CONFLICT — after the proposal has already been filed.
  const refWasCanonical = res.externalId === args.externalId;
  if (refWasCanonical)
    await args.persistence.writeRecord(
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
      { preserveEquivalent: true }
    );

  return withSecretWarnings(
    {
      ...(refWasCanonical ? {} : { local_record_advanced: false as const }),
      external_id: res.externalId,
      proposal_id: res.proposalId,
      base_version_id: res.baseVersionId,
      needs_rebase: res.needsRebase,
      base_url: args.baseUrl,
    },
    secretWarnings
  );
}

export function proposeRetryFlags(opts: ReviewProposeOptions): string[] {
  return [
    ...(opts.baseVersionId !== undefined ? ['--base-version-id', opts.baseVersionId] : []),
    ...(opts.supersedes !== undefined ? ['--supersedes', opts.supersedes] : []),
    ...(opts.summary !== undefined ? ['--summary', opts.summary] : []),
    ...(opts.sourceRef !== undefined ? ['--source-ref', opts.sourceRef] : []),
    ...cloudRetryFlags(opts),
  ];
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
        ['external_id', ref],
        ['body', body],
        ['base_version_id', opts.baseVersionId],
        ['supersedes_proposal_id', opts.supersedes],
        ['summary', opts.summary],
        ['source_ref', opts.sourceRef],
        ['base_url', opts.baseUrl],
      ],
      await loadSecretAllowlist()
    );

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review propose',
        registerWorktree: true,
      },
      async (ctx) => {
        const pulledAt = new Date().toISOString();
        const mutation = createReviewMutation(
          ctx,
          {
            verb: 'propose',
            externalId: ref,
            body,
            baseVersionId: opts.baseVersionId ?? null,
            supersedes: opts.supersedes ?? null,
            summary: opts.summary ?? null,
            sourceRef: opts.sourceRef ?? null,
          },
          { publicationAt: pulledAt }
        );
        const result = await runReviewPropose({
          client: mutation.client,
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
          pulledAt,
          persistence: mutation.persistence,
          retryFlags: proposeRetryFlags(opts),
        });
        if (mutation.didDispatch())
          await ctx.stampUsage(reviewUsageStamp('propose', result.external_id, result.proposal_id));
        return result;
      }
    );

    writeSecretWarnings(result.secret_warnings);
    if (opts.json) {
      emitOk(result);
      return;
    }
    let out = `Filed proposal ${result.proposal_id} on ${result.external_id} (base ${result.base_version_id})\n`;
    if (result.needs_rebase) {
      out += `  ⚠ needs rebase — the candidate has advanced past this base; rebase before it can be integrated.\n`;
    }
    if (result.local_record_advanced === false) {
      out += `  ⚠ local record not retained — re-pull under ${result.external_id} to work this proposal.\n`;
    }
    out += `  comment on it: orcaops plan review comment ${result.external_id} --proposal ${result.proposal_id} --input <file>\n`;
    writeTerminalSafeStdout(out);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
