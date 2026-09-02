import {
  ORCAOPS_CAPABILITIES,
  type OssSourcePlanBaseline,
  resolveReviewBaseline,
} from '@orcaops/core';
import type {
  OssSourcePlanReviewPropose,
  OssSourcePlanReviewPush,
  SourcePlanReviewProposeResponse,
  SourcePlanReviewPushResponse,
} from '@orcaops/sdk';
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

export interface ReviewPushOptions {
  input?: string;
  baseVersionId?: string;
  onConflict?: string;
  baseUrl?: string;
  json?: boolean;
}

/** Cloud methods `runReviewPush` needs — fakeable in tests. */
export interface ReviewPushClient {
  sourcePlan: {
    reviewPush(input: OssSourcePlanReviewPush): Promise<SourcePlanReviewPushResponse>;
    reviewPropose(input: OssSourcePlanReviewPropose): Promise<SourcePlanReviewProposeResponse>;
  };
}

export interface ReviewPushResult {
  status: 'published' | 'filed_as_proposal';
  external_id: string;
  /** published: the new candidate version (nullable per the wire type). */
  candidate_version_id?: string | null;
  candidate_version_number?: number | null;
  /** filed_as_proposal (on-conflict=propose): the new proposal + where the candidate moved. */
  proposal_id?: string;
  current_version_number?: number;
}

export interface RunReviewPushArgs {
  client: ReviewPushClient;
  repoRoot: string;
  baseUrl: string;
  orgId: string;
  externalId: string;
  body: string;
  /** `--base-version-id` escape hatch: take it verbatim, SKIP the cache read. */
  baseVersionIdOverride?: string;
  onConflict: 'fail' | 'propose';
  /** Advisory authoring baseline (resolved by the action; optional so fakes skip it). */
  baseline?: OssSourcePlanBaseline | null;
  pulledAt: string;
}

async function resolveExpectedCandidateVersionId(args: RunReviewPushArgs): Promise<string> {
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
      'plan-review-push'
    );
  }
  return rec.version_id;
}

/**
 * I/O-light core: seal a new candidate (author only) against the pulled CAS
 * token. Branches on the SDK's DISCRIMINATED result — no try/catch for the
 * expected conflict:
 *  - `published` → overwrite the local candidate record (latest-wins), succeed.
 *  - `conflict` + on-conflict=propose → re-send the SAME body as a proposal off
 *    the version we pushed against (born needs_rebase), report it.
 *  - `conflict` + on-conflict=fail (default) → THROW REVIEW_PUSH_CONFLICT (the
 *    wrapper's catch emits it). We never `emitError` here — that throws CliExit;
 *    the core must stay testable against a fake client.
 * The cloud ALWAYS fails closed; `on_conflict` is a CLI-side recovery intent.
 */
export async function runReviewPush(
  args: RunReviewPushArgs
): Promise<WithSecretWarnings<ReviewPushResult>> {
  const secretWarnings = assertNoSecretsOutbound(
    'plan-review-push',
    [['body', args.body]],
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
      'plan-review-push'
    );
  }
  const expectedCandidateVersionId = await resolveExpectedCandidateVersionId(args);
  const contentHash = sha256Hex(args.body);

  let res: SourcePlanReviewPushResponse;
  try {
    res = await args.client.sourcePlan.reviewPush({
      schema_version: 1,
      external_id: args.externalId,
      body: args.body,
      content_hash: contentHash,
      expected_candidate_version_id: expectedCandidateVersionId,
      on_conflict: args.onConflict,
      baseline: args.baseline ?? null,
    });
  } catch (err) {
    // A thrown error here is authz / status (non-author FORBIDDEN, or the plan
    // left IN_REVIEW → CONFLICT). The CAS publish-conflict does NOT throw — it
    // arrives as res.status==='conflict' below.
    throw mapReviewAuthzError(err, { command: 'push' });
  }

  const cacheDir = sourcePlanCacheDir(args.repoRoot);

  if (res.status === 'published') {
    // Overwrite the local candidate with the new version (latest-wins, same key).
    // candidateVersionId/Number are nullable in the wire type; persist only when
    // both are present (a published candidate normally has them). If null, the
    // CAS token can't advance — skip the write; the next op re-pulls.
    if (res.candidateVersionId !== null && res.candidateVersionNumber !== null) {
      await writeReviewPullRecord(
        cacheDir,
        {
          schema_version: 1,
          target: 'candidate',
          external_id: res.externalId,
          version_id: res.candidateVersionId,
          version_number: res.candidateVersionNumber,
          proposal_id: null,
          base_version_number: null,
          content_hash: contentHash,
          body: args.body,
          base_url: args.baseUrl,
          org_id: args.orgId,
          pulled_at: args.pulledAt,
        },
        args.repoRoot
      );
    }
    return withSecretWarnings(
      {
        status: 'published',
        external_id: res.externalId,
        candidate_version_id: res.candidateVersionId,
        candidate_version_number: res.candidateVersionNumber,
      },
      secretWarnings
    );
  }

  // res.status === 'conflict' — the candidate advanced since the pull.
  const currentVersionNumber = res.conflict.current_version_number;

  if (args.onConflict === 'propose') {
    // Opt-in conversion: re-send the SAME body as a proposal based on what we
    // pushed against (born needs_rebase — the base is now stale).
    let proposed: SourcePlanReviewProposeResponse;
    try {
      proposed = await args.client.sourcePlan.reviewPropose({
        schema_version: 1,
        external_id: args.externalId,
        body: args.body,
        content_hash: contentHash,
        base_version_id: expectedCandidateVersionId,
        supersedes_proposal_id: null,
        summary: null,
        source_ref: null,
        // The conversion seals the SAME body authored in the SAME worktree —
        // it carries the same baseline, or the proposal loses its provenance.
        baseline: args.baseline ?? null,
      });
    } catch (err) {
      throw mapReviewAuthzError(err, { command: 'propose' });
    }
    await writeReviewPullRecord(
      cacheDir,
      {
        schema_version: 1,
        target: 'proposal',
        external_id: proposed.externalId,
        version_id: null,
        version_number: null,
        proposal_id: proposed.proposalId,
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
        status: 'filed_as_proposal',
        external_id: proposed.externalId,
        proposal_id: proposed.proposalId,
        current_version_number: currentVersionNumber,
      },
      secretWarnings
    );
  }

  // on_conflict === 'fail' (default): throw the structured conflict. The
  // current_version_number rides the envelope so an agent can auto-re-pull.
  throw new OrcaopsError(
    ErrorCodes.REVIEW_PUSH_CONFLICT,
    `The candidate moved to v${currentVersionNumber}; re-pull, re-apply your edit, and push again. ` +
      `(A re-pull --out to the same path overwrites your edited file — re-apply from your own copy.)`,
    'plan-review-push',
    { current_version_number: currentVersionNumber }
  );
}

/**
 * Seal a new candidate version from the edited body (AUTHOR ONLY). Resolves the
 * expected candidate version from the pulled record (or `--base-version-id`).
 * `--on-conflict fail` (default) reports the conflict and exits non-zero;
 * `--on-conflict propose` re-files the edit as a proposal instead.
 */
export async function reviewPushAction(ref: string, opts: ReviewPushOptions = {}): Promise<void> {
  try {
    requireRef(ref, 'plan-review-push');
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
        'plan-review-push'
      );
    }
    // The outbound secret gate runs HERE, before credential resolution and the
    // capability ping `withReviewCloud` makes, so a refusal precedes anything
    // authored reaching the network rather than only preceding the mutation.
    // The identical gate inside the run* core is defense in depth and is what
    // the client-injected core tests drive.
    assertNoSecretsOutbound('plan-review-push', [['body', body]], await loadSecretAllowlist());
    const onConflict = opts.onConflict === 'propose' ? 'propose' : 'fail';

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review push',
      },
      async (ctx) =>
        runReviewPush({
          client: ctx.client,
          repoRoot: ctx.repoRoot,
          baseUrl: ctx.baseUrl,
          orgId: ctx.orgId,
          externalId: ref,
          body,
          ...(opts.baseVersionId ? { baseVersionIdOverride: opts.baseVersionId } : {}),
          onConflict,
          baseline: await resolveReviewBaseline(ctx.repo),
          pulledAt: new Date().toISOString(),
        })
    );

    await stampPlanReviewUsage(
      reviewUsageStamp(
        'push',
        result.external_id,
        result.candidate_version_number ?? result.current_version_number
      )
    );

    writeSecretWarnings(result.secret_warnings);
    if (opts.json) {
      emitOk(result);
      return;
    }
    if (result.status === 'published') {
      let out = `Published ${result.external_id}`;
      if (result.candidate_version_number != null) {
        out += ` → candidate v${result.candidate_version_number}`;
      }
      writeTerminalSafeStdout(`${out}\n`);
    } else {
      writeTerminalSafeStdout(
        `Candidate moved to v${result.current_version_number}; filed your edit as proposal ${result.proposal_id} on ${result.external_id}.\n`
      );
    }
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
