import path from 'node:path';

import {
  assertCloudSupports,
  assertSiblingHostUrl,
  createCloudClient,
  isMissingProcedureError,
  isNotFoundError,
  resolveCloudTarget,
  resolveCredentialStore,
} from '@orcaops/core';
import type { SourcePlanApprovedPull, SourcePlanGetResult } from '@orcaops/sdk';
import {
  firstForbiddenControlChar,
  sha256Hex,
  sourcePlanCacheDir,
  writePullCachePathPointer,
  writePullCacheRecord,
} from '@orcaops/storage';

import { mapPlanCloudReadError } from './review/shared.js';
import { toCloudErrorEnvelope } from '../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../io/output.js';
import { atomicWriteFile } from '../../lib/atomic-write.js';
import { CLI_VERSION } from '../../lib/cli-version.js';
import { buildContext } from '../../lib/context.js';
import { getInvocationCwd } from '../../lib/invocation-context.js';
import { reviewUsageStamp, stampPlanReviewUsage } from '../../lib/usage-stamp.js';

export interface PlanPullOptions {
  out?: string;
  baseUrl?: string;
  json?: boolean;
}

/**
 * The cloud methods `runPlanPull` needs — fakeable in tests. The metadata read
 * disambiguates a NOT_FOUND from `getApproved` when the plan is PINNED rather
 * than missing.
 */
export interface PullClient {
  sourcePlan: {
    getApproved(input: { slugOrExternalId: string }): Promise<SourcePlanApprovedPull>;
    /** Metadata-only resolve (no body) — existence + status + approved version. */
    get(input: { slugOrExternalId: string }): Promise<SourcePlanGetResult>;
  };
}

export interface PlanPullResult {
  external_id: string;
  slug: string;
  version_number: number;
  ref: string;
  out?: string;
}

export interface RunPlanPullArgs {
  client: PullClient;
  repoRoot: string;
  baseUrl: string;
  orgId: string;
  idOrSlug: string;
  /** Resolved absolute path to also write the body to (records lineage). */
  outPath?: string;
  pulledAt: string;
}

function printableWebUrl(raw: unknown, baseUrl: string): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return assertSiblingHostUrl(raw, baseUrl, 'plan web URL').toString();
  } catch {
    return null;
  }
}

/**
 * I/O-light core: fetch the approved version, verify its body hash, optionally
 * write it to `--out`, and persist the org-scoped pull-cache record. Returnable
 * so it unit-tests against a fake client + a temp repoRoot. NOT_FOUND is mapped
 * by the caller (it owns the SDK error type).
 */
export async function runPlanPull(args: RunPlanPullArgs): Promise<PlanPullResult> {
  let approved: SourcePlanApprovedPull;
  try {
    approved = await args.client.sourcePlan.getApproved({ slugOrExternalId: args.idOrSlug });
  } catch (err) {
    // NOT_FOUND means no approved version to pull. But a successful pin
    // transitions the cloud plan APPROVED→PINNED, so the same rejection fires
    // for an already-pinned plan — which reads as "resolution
    // broke" when it actually means "the pin worked". Best-effort: ask for
    // metadata-only status to tell the two apart, so re-pulling a plan you just
    // pinned gets an honest message instead of a misleading "no APPROVED".
    // A failed metadata read or a non-PINNED status falls through to the
    // original mapping below. Exclude typed missing-procedure skew because its
    // tRPC code may also be NOT_FOUND; without this guard a cloud whose `get`
    // happened to resolve PINNED would be mislabeled
    // "is PINNED" instead of "doesn't expose the plan-review surface".
    if (isNotFoundError(err) && !isMissingProcedureError(err)) {
      const meta = await args.client.sourcePlan
        .get({ slugOrExternalId: args.idOrSlug })
        .catch(() => null);
      if (meta?.status === 'PINNED') {
        const webUrl = printableWebUrl(meta.webUrl, args.baseUrl);
        throw new OrcaopsError(
          ErrorCodes.NO_INPUT,
          `"${args.idOrSlug}" is PINNED — it has already been resolved into a capture, and ` +
            `\`plan pull\` only resolves the APPROVED version. Read the pinned plan from the ` +
            `capture (\`orcaops show <artifact>\` or the digest)` +
            (webUrl === null ? '.' : `, or its web page: ${webUrl}`),
          'plan-pull'
        );
      }
    }
    // The generic / ZodError path below stays CLOUD_ERROR: the cache-record
    // parse only ever sees cloud-data, so it is correctly NOT relabeled here.
    throw mapPlanCloudReadError(err, {
      notFoundMessage: `No APPROVED version for "${args.idOrSlug}". The plan must be reviewed and approved in the cloud before it can be pulled.`,
      inputPath: 'plan-pull',
    });
  }
  const { externalId, slug, title } = approved;
  const { versionNumber, body, contentHash, sourceRef } = approved.approvedVersion;

  const actual = sha256Hex(body);
  if (actual !== contentHash) {
    throw new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      `Integrity check failed for "${args.idOrSlug}": sha256(body)=${actual} != contentHash=${contentHash}. The plan body was altered in transit; retry the pull.`,
      'plan-pull'
    );
  }
  // ASSERT (never strip — the pin is content-addressed by this body's hash) the
  // wire control-char policy BEFORE anything durable stores the body. A dirty
  // body that reached the pull cache would become a pinned, hash-anchored
  // snapshot the cloud push's assertNoForbiddenControlChars can never ship — a
  // permanent non-retryable trap only fixable upstream.
  const forbidden = firstForbiddenControlChar(body);
  if (forbidden !== null) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `The approved version of "${args.idOrSlug}" contains a forbidden control character ` +
        `(U+${forbidden.code.toString(16).toUpperCase().padStart(4, '0')} at offset ${forbidden.index}). ` +
        `A pinned plan is hash-anchored, so the byte cannot be stripped locally, and the cloud push ` +
        `rejects it. Fix the plan on the web surface, re-upload and re-approve it, then pull again.`,
      'plan-pull'
    );
  }
  // A whitespace-only approved body is not a gradable conformance anchor.
  // Reject it BEFORE caching (mirrors the resolver's local + cloud blank guard)
  // so a blank pin can never reach `capture plan`.
  if (body.trim().length === 0) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `The approved version of "${args.idOrSlug}" has an empty body — nothing to pin as a conformance anchor.`,
      'plan-pull'
    );
  }

  const cacheDir = sourcePlanCacheDir(args.repoRoot);
  // Ordering: land the resolve-critical by-id record FIRST, then write the
  // optional --out file, then the by-path lineage pointer. So a failed/partial
  // --out write never strands the cache without its pinnable record, and the
  // pointer (the ONLY materialization record) only ever keys a file that already
  // exists on disk — the record makes no claim about a path it can't guarantee.
  await writePullCacheRecord(
    cacheDir,
    {
      schema_version: 1,
      external_id: externalId,
      slug,
      version_number: versionNumber,
      title,
      body,
      content_hash: contentHash,
      source_ref: sourceRef,
      base_url: args.baseUrl,
      org_id: args.orgId,
      pulled_at: args.pulledAt,
    },
    args.repoRoot
  );

  if (args.outPath) {
    await atomicWriteFile(args.outPath, body);
    await writePullCachePathPointer(
      cacheDir,
      {
        baseUrl: args.baseUrl,
        orgId: args.orgId,
        realPath: args.outPath,
        externalId,
        versionNumber,
      },
      args.repoRoot
    );
  }

  return {
    external_id: externalId,
    slug,
    version_number: versionNumber,
    ref: `cloud:${externalId}@${versionNumber}`,
    ...(args.outPath ? { out: args.outPath } : {}),
  };
}

/**
 * Pull the APPROVED version of a cloud plan into the local pull-cache so a
 * subsequent `capture plan --source-plan cloud:<externalId>@<version>` can pin
 * it offline. Verifies `sha256(body) === contentHash` before caching. With
 * `--out`, also writes the body to a file and records a by-path lineage pointer
 * (after the file exists) so a later born-pin push can trace `derived_from`.
 */
export async function planPullAction(idOrSlug: string, opts: PlanPullOptions = {}): Promise<void> {
  try {
    if (!idOrSlug || idOrSlug.length === 0) {
      throw new OrcaopsError(ErrorCodes.NO_INPUT, 'a plan id or slug is required.', 'plan-pull');
    }

    const credentialStore = resolveCredentialStore();
    const baseUrl = resolveCloudTarget(opts.baseUrl);
    const outPath = opts.out
      ? path.isAbsolute(opts.out)
        ? opts.out
        : path.resolve(getInvocationCwd(), opts.out)
      : undefined;

    const ctx = await buildContext();
    let result: PlanPullResult;
    try {
      const { client } = await createCloudClient({
        baseUrl,
        store: credentialStore,
        cliVersion: CLI_VERSION,
      });
      const ping = await client.cli.ping();
      assertCloudSupports(ping, [], 'plan pull', { cliVersion: CLI_VERSION });
      const orgId = ping.orgId;
      result = await runPlanPull({
        client,
        repoRoot: ctx.repoRoot,
        baseUrl,
        orgId,
        idOrSlug,
        ...(outPath ? { outPath } : {}),
        pulledAt: new Date().toISOString(),
      });
    } finally {
      ctx.store.close();
    }

    await stampPlanReviewUsage(reviewUsageStamp('pull', result.external_id, result.version_number));

    if (opts.json) {
      emitOk(result);
      return;
    }
    let out = `Pulled ${result.external_id} (${result.slug}) v${result.version_number}\n`;
    if (result.out) out += `  wrote body → ${result.out}\n`;
    out += `  pin it with: --source-plan ${result.ref}\n`;
    writeTerminalSafeStdout(out);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
