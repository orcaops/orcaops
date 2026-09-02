import path from 'node:path';

import { ORCAOPS_CAPABILITIES } from '@orcaops/core';
import type { OssSourcePlanReviewPull, SourcePlanReviewPullResponse } from '@orcaops/sdk';
import {
  type ReviewPullRecord,
  sha256Hex,
  sourcePlanCacheDir,
  writeReviewPullRecord,
} from '@orcaops/storage';

import { mapPlanCloudReadError, requireRef, withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../../io/output.js';
import { atomicWriteFile } from '../../../lib/atomic-write.js';
import { getInvocationCwd } from '../../../lib/invocation-context.js';
import { parseDigitInt } from '../../../lib/strict-int.js';
import { reviewUsageStamp, stampPlanReviewUsage } from '../../../lib/usage-stamp.js';

export interface ReviewPullOptions {
  proposal?: string;
  /** Sealed historical version number (read-only fetch; NOT a push base). */
  version?: string;
  out?: string;
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud method `runReviewPull` needs — fakeable in tests. */
export interface ReviewPullClient {
  sourcePlan: {
    reviewPull(input: OssSourcePlanReviewPull): Promise<SourcePlanReviewPullResponse>;
  };
}

export interface ReviewPullResult {
  external_id: string;
  target: 'candidate' | 'proposal' | 'version';
  version_id: string | null;
  version_number: number | null;
  proposal_id: string | null;
  base_version_number: number | null;
  /** The canonical externalId to reuse on propose/push/comment (cache key). */
  ref: string;
  /** The resolved cloud base — the hints carry it when it isn't the default. */
  base_url: string;
  out?: string;
}

export interface RunReviewPullArgs {
  client: ReviewPullClient;
  repoRoot: string;
  baseUrl: string;
  orgId: string;
  externalId: string;
  proposalId?: string;
  /** Sealed historical version to fetch (mutually exclusive with proposalId). */
  versionNumber?: number;
  /** Resolved absolute path to also write the body to. */
  outPath?: string;
  pulledAt: string;
}

/**
 * I/O-light core: fetch the candidate (or a proposal, or `--version <n>` a
 * sealed historical version), verify its body hash, optionally write it to
 * `--out`, and persist the review-pull record (the CAS token for `push`) —
 * EXCEPT for historical pulls, which never touch the record (see below).
 * Returnable so it unit-tests against a fake client + a temp repoRoot.
 *
 * The SDK throws `CloudWireError` when a version-number request receives a
 * candidate response. It is deliberately not caught here: a wire violation
 * must surface as a hard CLOUD_ERROR, never be mistaken for NOT_FOUND or feed
 * a wrong-body diff.
 */
export async function runReviewPull(args: RunReviewPullArgs): Promise<ReviewPullResult> {
  let res: SourcePlanReviewPullResponse;
  try {
    res = await args.client.sourcePlan.reviewPull({
      schema_version: 1,
      external_id: args.externalId,
      proposal_id: args.proposalId ?? null,
      version_number: args.versionNumber ?? null,
    });
  } catch (err) {
    // A bad ref / no candidate / not-in-review surfaces as NOT_FOUND. Map it to a
    // friendly NO_INPUT (mirroring `plan pull`) instead of a raw CLOUD_ERROR; the
    // integrity / generic paths below stay CLOUD_ERROR (genuine cloud failures).
    const notFoundMessage =
      args.versionNumber !== undefined
        ? `Version ${args.versionNumber} does not exist for "${args.externalId}" (\`plan review view\` shows the current candidate version).`
        : `Not found: ${
            args.proposalId
              ? `proposal "${args.proposalId}" on "${args.externalId}"`
              : `a review candidate for "${args.externalId}"`
          }. Check the ref (refs are externalIds — \`plan review pull\` echoes the canonical one) and that the plan is in review.`;
    throw mapPlanCloudReadError(err, {
      notFoundMessage,
      inputPath: 'plan-review-pull',
    });
  }
  const {
    externalId,
    target,
    versionId,
    versionNumber,
    proposalId,
    baseVersionNumber,
    contentHash,
    body,
  } = res;

  // A 'version' target is only valid when we asked for one — otherwise it's a
  // wire violation that must not reach the CAS record. The inverse mismatch is
  // the SDK's CloudWireError, thrown before we get here.
  if (target === 'version' && args.versionNumber === undefined) {
    throw new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      `Unexpected wire response for "${args.externalId}": the cloud returned a sealed historical version for a candidate/proposal pull. Retry; if it persists, check the cloud deploy.`,
      'plan-review-pull'
    );
  }

  // The cloud hashes raw utf8 — verify the transit didn't corrupt/truncate it.
  const actual = sha256Hex(body);
  if (actual !== contentHash) {
    throw new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      `Integrity check failed for "${args.externalId}": sha256(body)=${actual} != contentHash=${contentHash}. The review body was altered in transit; retry the pull.`,
      'plan-review-pull'
    );
  }
  if (body.trim().length === 0) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `The ${target} of "${args.externalId}" has an empty body — nothing to review.`,
      'plan-review-pull'
    );
  }

  // FILE FIRST, record SECOND — the deliberate INVERSE of `plan pull`'s
  // record-first order. The review record is not a pin; it is the CAS token for
  // `push`. Record-first here would fail OPEN: the cache would advance to the new
  // version_id while a failed `--out` left the OLD body on disk, and a later
  // `push --input <that file>` would CAS-pass and silently publish the stale
  // body. File-first fails CLOSED: the new body lands on disk, the record stays
  // un-advanced → the next push conflicts → the user re-pulls.
  if (args.outPath) {
    await atomicWriteFile(args.outPath, body);
  }
  // A sealed historical version is NOT a CAS base: a `--version` pull writes NO
  // record at all — writing one would clobber the candidate record an in-flight
  // edit's `push` CASes against. (The narrowing also keeps the record schema's
  // candidate|proposal discriminant closed.)
  if (target === 'candidate' || target === 'proposal') {
    const record: ReviewPullRecord = {
      schema_version: 1,
      target,
      external_id: externalId,
      version_id: versionId,
      version_number: versionNumber,
      proposal_id: proposalId,
      base_version_number: baseVersionNumber,
      content_hash: contentHash,
      body,
      base_url: args.baseUrl,
      org_id: args.orgId,
      pulled_at: args.pulledAt,
    };
    await writeReviewPullRecord(sourcePlanCacheDir(args.repoRoot), record, args.repoRoot);
  }

  return {
    external_id: externalId,
    target,
    version_id: versionId,
    version_number: versionNumber,
    proposal_id: proposalId,
    base_version_number: baseVersionNumber,
    ref: externalId,
    base_url: args.baseUrl,
    ...(args.outPath ? { out: args.outPath } : {}),
  };
}

/** Parse a `--version <n>` flag value into a positive integer, or throw INVALID_INPUT. */
export function parseVersionFlag(raw: string, flag: string, inputPath: string): number {
  const n = parseDigitInt(raw) ?? NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `${flag} must be a positive integer version number (got "${raw}").`,
      inputPath
    );
  }
  return n;
}

/**
 * Pull the under-review candidate (or `--proposal <id>` a proposal) into the
 * local review-pull cache so a subsequent `propose` / `push` / `comment` can
 * echo its `version_id` without a re-pull. Verifies `sha256(body) ===
 * contentHash` before caching. With `--out`, also writes the body to a file
 * (file-first; see `runReviewPull`). `--version <n>` fetches a sealed
 * HISTORICAL version instead — read-only, never cached, NOT a push base (it
 * exists for "what changed since vN?" diffs). This is the REVIEW track — its
 * body is NOT pinnable as a `cloud:<id>@<n>` conformance anchor (that is
 * `plan pull`).
 */
export async function reviewPullAction(ref: string, opts: ReviewPullOptions = {}): Promise<void> {
  try {
    requireRef(ref, 'plan-review-pull');
    const versionNumber =
      opts.version !== undefined
        ? parseVersionFlag(opts.version, '--version', 'plan-review-pull')
        : undefined;
    const outPath = opts.out
      ? path.isAbsolute(opts.out)
        ? opts.out
        : path.resolve(getInvocationCwd(), opts.out)
      : undefined;

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        // Naming a version pins the pull to that revision, which is the
        // separately-advertised capability; pulling the latest is not.
        requires:
          versionNumber !== undefined
            ? [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW, ORCAOPS_CAPABILITIES.REVIEW_VERSION_PULL]
            : [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review pull',
      },
      (ctx) =>
        runReviewPull({
          client: ctx.client,
          repoRoot: ctx.repoRoot,
          baseUrl: ctx.baseUrl,
          orgId: ctx.orgId,
          externalId: ref,
          ...(opts.proposal ? { proposalId: opts.proposal } : {}),
          ...(versionNumber !== undefined ? { versionNumber } : {}),
          ...(outPath ? { outPath } : {}),
          pulledAt: new Date().toISOString(),
        })
    );

    await stampPlanReviewUsage(reviewUsageStamp('pull', result.external_id, result.target));

    if (opts.json) {
      emitOk(result);
      return;
    }
    // Print the canonical ref to reuse (the response's externalId — a slug typed
    // back would hash to a different cache key and miss this record).
    if (result.target === 'version') {
      let out = `Pulled sealed v${result.version_number} of ${result.external_id} (historical — read-only, NOT a push base)\n`;
      if (result.out) out += `  wrote body → ${result.out}\n`;
      out += `  diff it against the candidate: orcaops plan review diff ${result.ref} --from ${result.version_number}\n`;
      writeTerminalSafeStdout(out);
      return;
    }
    let out = `Pulled ${result.target} of ${result.external_id}`;
    if (result.target === 'candidate' && result.version_number !== null) {
      out += ` (v${result.version_number})`;
    } else if (result.target === 'proposal' && result.base_version_number !== null) {
      out += ` (proposal ${result.proposal_id}, base v${result.base_version_number})`;
    }
    out += '\n';
    if (result.out) out += `  wrote body → ${result.out}\n`;
    if (result.version_id) out += `  base version id: ${result.version_id}\n`;
    if (result.target === 'candidate') {
      out += `  edit it, then: orcaops plan review push ${result.ref} --input <file>  (author)\n`;
      out += `             or: orcaops plan review propose ${result.ref} --input <file>\n`;
    } else {
      out += `  comment on it: orcaops plan review comment ${result.ref} --proposal ${result.proposal_id} --input <file>\n`;
    }
    writeTerminalSafeStdout(out);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
