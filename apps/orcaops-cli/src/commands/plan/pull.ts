import { realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  assertSiblingHostUrl,
  isMissingProcedureError,
  isNotFoundError,
  resolveCloudTarget,
  resolveCredentialStore,
} from '@orcaops/core';
import { createCanonicalCloudClient } from '@orcaops/core/history';
import type { SourcePlanApprovedPull, SourcePlanGetResult } from '@orcaops/sdk';
import { firstForbiddenControlChar, type PullCacheRecord, sha256Hex } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { mapPlanCloudReadError } from './review/shared.js';
import { toCloudErrorEnvelope } from '../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import {
  emitError,
  emitOk,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import { atomicWriteFile } from '../../lib/atomic-write.js';
import { CLI_VERSION } from '../../lib/cli-version.js';
import { assertNoSecretsOutbound } from '../../lib/cloud-secret-gate.js';
import {
  type DatabaseCaptureCommandContext,
  openDatabaseCaptureWriter,
  resolveDatabaseCaptureContext,
} from '../../lib/database-capture-context.js';
import { createDatabasePlanPullPersistence } from '../../lib/database-source-plan-pull.js';
import { stampDatabaseUsage } from '../../lib/database-usage-stamp.js';
import { getInvocationCwd } from '../../lib/invocation-context.js';
import { loadSecretAllowlist } from '../../lib/run-capture.js';
import { reviewUsageStamp } from '../../lib/usage-stamp.js';

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
  baseUrl: string;
  orgId: string;
  idOrSlug: string;
  /** Resolved absolute path to also write the body to (canonicalized before any I/O). */
  outPath?: string;
  secretAllow: readonly string[];
  pulledAt: string;
  persistence: PlanPullPersistence;
}

async function canonicalPlanPullOutputPath(outPath: string): Promise<string> {
  let candidate = path.resolve(outPath);
  const missingSuffix: string[] = [];
  for (;;) {
    try {
      const existingAncestor = await realpath(candidate);
      return path.join(existingAncestor, ...missingSuffix);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw cause;
      missingSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export interface PlanPullPersistence {
  preflight(): Promise<void>;
  writeRecord(record: PullCacheRecord): Promise<void>;
  writePathPointer(input: {
    realPath: string;
    externalId: string;
    versionNumber: number;
  }): Promise<void>;
}

async function stampPlanPullUsage(
  context: DatabaseCaptureCommandContext,
  result: PlanPullResult,
  signal: AbortSignal,
  onWait: () => void
): Promise<void> {
  let writer;
  try {
    if (signal.aborted)
      throw new ProjectDatabaseError('CANCELLED', 'Plan pull cancelled before usage attribution');
    writer = await openDatabaseCaptureWriter(context, signal);
    await stampDatabaseUsage(
      writer,
      {
        descriptor: reviewUsageStamp('pull', result.external_id, result.version_number),
        invokingAgent: context.invokingAgent.agent,
        env: context.env,
        cwd: getInvocationCwd(),
        secretAllow: context.config.redact.allow,
      },
      { signal, onWait }
    );
  } catch {
    return;
  } finally {
    writer?.close();
  }
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
 * write it to `--out`, and persist the account-scoped approved record. Returnable
 * so it unit-tests against a fake client + a temp repoRoot. NOT_FOUND is mapped
 * by the caller (it owns the SDK error type).
 */
export async function runPlanPull(args: RunPlanPullArgs): Promise<PlanPullResult> {
  args = { ...args, persistence: { ...args.persistence } };
  assertNoSecretsOutbound('plan-pull', [['out', args.outPath]], args.secretAllow);
  const outPath = args.outPath ? await canonicalPlanPullOutputPath(args.outPath) : undefined;
  assertNoSecretsOutbound('plan-pull', [['out_realpath', outPath]], args.secretAllow);
  await args.persistence.preflight();
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
    // The generic / ZodError path below stays CLOUD_ERROR: the approved-record
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
  // body that reached retained history would become a pinned, hash-anchored
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
  // Reject it BEFORE persistence (mirrors the resolver's local + cloud blank guard)
  // so a blank pin can never reach `capture plan`.
  if (body.trim().length === 0) {
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `The approved version of "${args.idOrSlug}" has an empty body — nothing to pin as a conformance anchor.`,
      'plan-pull'
    );
  }

  // Ordering: land the resolve-critical by-id record FIRST, then write the
  // optional --out file, then the by-path lineage pointer. So a failed/partial
  // --out write never strands history without its pinnable record, and the
  // pointer (the ONLY materialization record) only ever keys a file that already
  // exists on disk — the record makes no claim about a path it can't guarantee.
  const record: PullCacheRecord = {
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
  };
  await args.persistence.writeRecord(record);

  if (outPath) {
    await atomicWriteFile(outPath, body);
    const pointer = {
      baseUrl: args.baseUrl,
      orgId: args.orgId,
      realPath: outPath,
      externalId,
      versionNumber,
    };
    await args.persistence.writePathPointer(pointer);
  }

  return {
    external_id: externalId,
    slug,
    version_number: versionNumber,
    ref: `cloud:${externalId}@${versionNumber}`,
    ...(outPath ? { out: outPath } : {}),
  };
}

/**
 * Pull the APPROVED version of a cloud plan into project history so a
 * subsequent `capture plan --source-plan cloud:<externalId>@<version>` can pin
 * it offline. Verifies `sha256(body) === contentHash` before persistence. With
 * `--out`, also writes the body to a file and records a by-path lineage pointer
 * (after the file exists) so a later born-pin push can trace `derived_from`.
 */
export async function planPullAction(idOrSlug: string, opts: PlanPullOptions = {}): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  try {
    if (!idOrSlug || idOrSlug.length === 0) {
      throw new OrcaopsError(ErrorCodes.NO_INPUT, 'a plan id or slug is required.', 'plan-pull');
    }

    const secretAllow = await loadSecretAllowlist();
    assertNoSecretsOutbound(
      'plan-pull',
      [
        ['id_or_slug', idOrSlug],
        ['base_url', opts.baseUrl],
        ['out', opts.out],
      ],
      secretAllow
    );
    const outPath = opts.out
      ? await canonicalPlanPullOutputPath(path.resolve(getInvocationCwd(), opts.out))
      : undefined;
    assertNoSecretsOutbound('plan-pull', [['out_realpath', outPath]], secretAllow);
    const baseUrl = resolveCloudTarget(opts.baseUrl);

    const context = await resolveDatabaseCaptureContext({
      registerWorktree: true,
      signal: controller.signal,
    });
    let result: PlanPullResult;
    try {
      const credentialStore = resolveCredentialStore();
      const { client, target } = await createCanonicalCloudClient({
        baseUrl,
        store: credentialStore,
        cliVersion: CLI_VERSION,
        requires: [],
        operation: 'plan pull',
        signal: controller.signal,
      });
      if (controller.signal.aborted)
        throw new ProjectDatabaseError('CANCELLED', 'Plan pull cancelled before the cloud read');
      let waiting = false;
      const onWait = () => {
        if (waiting) return;
        waiting = true;
        writeTerminalSafeStderr(
          'Waiting for plan pull on the selected project database; Ctrl-C cancels the wait.\n'
        );
      };
      const persistence = createDatabasePlanPullPersistence({
        reader: context.project.database,
        target,
        secretAllow: context.config.redact.allow,
        openWriter: async () => {
          if (controller.signal.aborted)
            throw new ProjectDatabaseError(
              'CANCELLED',
              'Plan pull cancelled before opening the writer'
            );
          return openDatabaseCaptureWriter(context, controller.signal);
        },
        signal: controller.signal,
        onWait,
      });
      result = await runPlanPull({
        client,
        baseUrl: target.server_url,
        orgId: target.org_id,
        idOrSlug,
        ...(outPath ? { outPath } : {}),
        secretAllow: context.config.redact.allow,
        pulledAt: new Date().toISOString(),
        persistence,
      });

      await stampPlanPullUsage(context, result, controller.signal, onWait);
    } finally {
      context.close();
    }

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
  } finally {
    process.off('SIGINT', interrupt);
  }
}
