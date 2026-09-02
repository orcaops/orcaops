import open from 'open';

import { assertSiblingHostUrl } from '@orcaops/core';
import type { SourcePlanGetResult } from '@orcaops/sdk';

import { mapPlanCloudReadError, pinRefOf, requireRef, withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../../io/output.js';
import { parseDigitInt } from '../../../lib/strict-int.js';

export interface ReviewApproveOptions {
  wait?: boolean;
  timeout?: string;
  /** Commander `--no-open` negation: true by default, false when passed. */
  open?: boolean;
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud method `runReviewApprove` needs — fakeable in tests. */
export interface ReviewApproveClient {
  sourcePlan: {
    get(input: { slugOrExternalId: string }): Promise<SourcePlanGetResult>;
  };
}

/** Injectable side effects so tests drive the poll loop without real timers. */
export interface ApproveDeps {
  openUrl: (url: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const APPROVE_POLL_INTERVAL_MS = 4_000;
export const APPROVE_TIMEOUT_DEFAULT_SEC = 600;

export interface ReviewApproveResult {
  /** OPENED = launched, NOT approved. Only APPROVED means the plan moved. */
  status: 'OPENED' | 'APPROVED';
  externalId: string;
  url: string;
  approvedVersionNumber?: number;
  pinRef?: string;
}

export interface RunReviewApproveArgs {
  client: ReviewApproveClient;
  baseUrl: string;
  externalId: string;
  wait: boolean;
  timeoutMs: number;
  openBrowser: boolean;
  deps?: Partial<ApproveDeps>;
}

const defaultDeps: ApproveDeps = {
  openUrl: (url) => open(url),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

async function getPlan(
  client: ReviewApproveClient,
  externalId: string
): Promise<SourcePlanGetResult> {
  try {
    return await client.sourcePlan.get({ slugOrExternalId: externalId });
  } catch (err) {
    throw mapPlanCloudReadError(err, {
      notFoundMessage: `Not found: "${externalId}". Check the ref (refs are externalIds — \`plan upload\` echoes the canonical one).`,
      inputPath: 'plan-review-approve',
    });
  }
}

/**
 * I/O-light core: LAUNCHER, not approver. The APPROVED transition is never
 * callable with CLI credentials — this verb resolves the plan's cloud-owned
 * `webUrl`, opens the browser (the human web session does the approving), and
 * with `wait` polls the already-shipped `get` until a NEW approved version
 * appears. Returning `OPENED` (exit 0) means LAUNCHED, never approved.
 */
export async function runReviewApprove(args: RunReviewApproveArgs): Promise<ReviewApproveResult> {
  const deps: ApproveDeps = { ...defaultDeps, ...args.deps };
  let res = await getPlan(args.client, args.externalId);

  const raw: unknown = res.webUrl;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      'The cloud returned no web URL for this plan; check the deploy.',
      'plan-review-approve'
    );
  }

  let webUrl: string;
  try {
    webUrl = assertSiblingHostUrl(raw, args.baseUrl, 'plan web URL').toString();
  } catch (err) {
    throw new OrcaopsError(
      ErrorCodes.CLOUD_ERROR,
      `The cloud returned an unusable web URL for this plan: ${(err as Error).message}`,
      'plan-review-approve'
    );
  }

  if (args.openBrowser) {
    // Non-fatal, exactly like login's launcher: the URL is printed regardless.
    void deps.openUrl(webUrl).catch(() => undefined);
  }

  if (!args.wait) {
    return { status: 'OPENED', externalId: res.externalId, url: webUrl };
  }

  // Success requires a NEW approved version — already-APPROVED-at-start does
  // not count (the human is approving the next candidate, not the past one).
  const startApproved = res.approvedVersionNumber;
  const deadline = deps.now() + args.timeoutMs;
  for (;;) {
    if (
      res.status === 'APPROVED' &&
      res.approvedVersionNumber !== null &&
      res.approvedVersionNumber !== startApproved
    ) {
      return {
        status: 'APPROVED',
        externalId: res.externalId,
        url: webUrl,
        approvedVersionNumber: res.approvedVersionNumber,
        pinRef: pinRefOf(res.externalId, res.approvedVersionNumber) as string,
      };
    }
    if (deps.now() >= deadline) {
      throw new OrcaopsError(
        ErrorCodes.REVIEW_APPROVE_TIMEOUT,
        `Timed out waiting for approval of "${args.externalId}" (${Math.round(args.timeoutMs / 1000)}s). Not approved yet — a decline looks the same on this wire. Re-run \`plan review approve --wait\` or check \`plan review view\`.`,
        'plan-review-approve'
      );
    }
    await deps.sleep(APPROVE_POLL_INTERVAL_MS);
    res = await getPlan(args.client, args.externalId);
  }
}

/**
 * `plan review approve <ref>` — open the web approval page (`--no-open` just
 * prints it; SSH box → open it on a phone). `--wait` polls until approved and
 * prints the pin ref; the timeout exits 2 under the distinct
 * REVIEW_APPROVE_TIMEOUT code so scripts can branch on "not approved yet".
 */
export async function reviewApproveAction(
  ref: string,
  opts: ReviewApproveOptions = {}
): Promise<void> {
  try {
    requireRef(ref, 'plan-review-approve');
    let timeoutSec = APPROVE_TIMEOUT_DEFAULT_SEC;
    if (opts.timeout !== undefined) {
      timeoutSec = parseDigitInt(opts.timeout) ?? NaN;
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--timeout must be a positive integer of seconds (got "${opts.timeout}").`,
          'plan-review-approve'
        );
      }
    }

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [],
        operation: 'plan review approve',
      },
      (ctx) =>
        runReviewApprove({
          client: ctx.client,
          baseUrl: ctx.baseUrl,
          externalId: ref,
          wait: opts.wait === true,
          timeoutMs: timeoutSec * 1000,
          openBrowser: opts.open !== false,
        })
    );

    if (opts.json) {
      emitOk(result);
      return;
    }
    if (result.status === 'APPROVED') {
      writeTerminalSafeStdout(
        `APPROVED v${result.approvedVersionNumber}  →  pin ref: ${result.pinRef}\n` +
          `Next: orcaops plan pull ${result.externalId}, then orcaops capture plan --source-plan ${result.pinRef}\n`
      );
      return;
    }
    writeTerminalSafeStdout(
      'Opened the approval page — approve in your browser:\n' +
        `  ${result.url}\n` +
        `Exit 0 means LAUNCHED, not approved. Then: orcaops plan pull ${result.externalId} for the pin (or re-run with --wait).\n`
    );
  } catch (err) {
    const exitCode =
      err instanceof OrcaopsError && err.code === ErrorCodes.REVIEW_APPROVE_TIMEOUT ? 2 : 1;
    emitError(toCloudErrorEnvelope(err), { exitCode });
  }
}
