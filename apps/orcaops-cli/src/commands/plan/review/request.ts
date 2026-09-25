import { randomUUID } from 'node:crypto';

import { ORCAOPS_CAPABILITIES } from '@orcaops/core';
import { stringifyTerminalSafeJson } from '@orcaops/evaluator-protocol/terminal';
import { OssSourcePlanReviewRequest, type SourcePlanReviewRequestResponse } from '@orcaops/sdk';

import {
  createReviewMutation,
  mapPlanCloudReadError,
  mapReviewAuthzError,
  requireRef,
  withReviewCloud,
} from './shared.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../../io/errors.js';
import { CliExit } from '../../../io/exit.js';
import { emitError, writeTerminalSafeStdout } from '../../../io/output.js';
import {
  assertNoSecretsOutbound,
  withSecretWarnings,
  writeSecretWarnings,
} from '../../../lib/cloud-secret-gate.js';
import { loadSecretAllowlist } from '../../../lib/run-capture.js';
import { reviewUsageStamp } from '../../../lib/usage-stamp.js';

export interface ReviewRequestOptions {
  reviewer?: string[];
  baseUrl?: string;
  json?: boolean;
  resend?: boolean;
}

/**
 * Injectable so a test can pin the exact journal command rather than only
 * observing that two differ.
 */
export interface ReviewRequestDeps {
  resendToken: () => string;
}

const defaultDeps: ReviewRequestDeps = { resendToken: () => randomUUID() };

export interface ReviewRequestClient {
  sourcePlan: {
    reviewRequest(input: OssSourcePlanReviewRequest): Promise<SourcePlanReviewRequestResponse>;
  };
}

function requestInput(ref: string, reviewers: string[]) {
  requireRef(ref, 'plan-review-request');
  const normalizedReviewers = [
    ...new Map(
      reviewers.map((reviewer) => {
        const normalized = reviewer.trim();
        return [normalized.toLowerCase(), normalized] as const;
      })
    ).values(),
  ].sort();
  const parsed = OssSourcePlanReviewRequest.safeParse({
    schema_version: 1,
    external_id: ref,
    reviewers: normalizedReviewers,
  });
  if (!parsed.success) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Provide a plan reference and 1–25 nonempty --reviewer identifiers (at most 200 characters each).',
      'plan-review-request'
    );
  }
  return parsed.data;
}

export async function runReviewRequest(args: {
  client: ReviewRequestClient;
  externalId: string;
  reviewers: string[];
}) {
  const input = requestInput(args.externalId, args.reviewers);
  const warnings = assertNoSecretsOutbound(
    'plan-review-request',
    [
      ['external_id', input.external_id],
      ...input.reviewers.map((reviewer, i): [string, string] => [`reviewer[${i}]`, reviewer]),
    ],
    await loadSecretAllowlist()
  );
  let response: SourcePlanReviewRequestResponse;
  try {
    response = await args.client.sourcePlan.reviewRequest(input);
  } catch (error) {
    const mapped = mapPlanCloudReadError(error, {
      notFoundMessage: `Not found: plan "${args.externalId}". Use a reference from plan upload or plan review list.`,
      inputPath: 'plan-review-request',
    });
    if (mapped !== error) throw mapped;
    throw mapReviewAuthzError(error, { command: 'request' });
  }
  const returnedIdentifiers = [
    ...response.added.map((reviewer) => reviewer.rawTag),
    ...response.alreadyRequested.map((reviewer) => reviewer.rawTag),
    ...response.unresolved,
  ];
  const returned = new Set(
    returnedIdentifiers.map((identifier) => identifier.trim().toLowerCase())
  );
  const notConfirmed =
    returnedIdentifiers.length < input.reviewers.length
      ? input.reviewers.filter((reviewer) => !returned.has(reviewer.toLowerCase()))
      : [];
  const incomplete = response.unresolved.length + notConfirmed.length > 0;
  const attached = response.added.length + response.alreadyRequested.length;
  return withSecretWarnings(
    {
      status: incomplete
        ? attached
          ? 'partial'
          : 'unresolved'
        : response.added.length
          ? 'requested'
          : 'unchanged',
      external_id: response.externalId,
      added: response.added.map((r) => ({ user_id: r.userId, reviewer: r.rawTag })),
      already_requested: response.alreadyRequested.map((r) => ({
        user_id: r.userId,
        reviewer: r.rawTag,
      })),
      unresolved: response.unresolved,
      not_confirmed: notConfirmed,
    },
    warnings
  );
}

export async function reviewRequestAction(
  ref: string,
  opts: ReviewRequestOptions = {},
  overrides: Partial<ReviewRequestDeps> = {}
): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  let result: Awaited<ReturnType<typeof runReviewRequest>> & {
    resend: boolean;
    dispatched: boolean;
  };
  try {
    const input = requestInput(ref, opts.reviewer ?? []);
    assertNoSecretsOutbound(
      'plan-review-request',
      [
        ['external_id', ref],
        ['base_url', opts.baseUrl],
        ...input.reviewers.map((reviewer, i): [string, string] => [`reviewer[${i}]`, reviewer]),
      ],
      await loadSecretAllowlist()
    );
    // Journal-only and never sent: the durable journal keys a mutation on this
    // command, so a value that is fresh per invocation is the only way past an
    // acknowledged replay. Absent the flag the member is omitted entirely, so
    // every already-retained plain request keeps its key.
    const resendToken = opts.resend === true ? deps.resendToken() : null;
    result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW_REQUEST],
        operation: 'plan review request',
        registerWorktree: true,
      },
      async (ctx) => {
        const mutation = createReviewMutation(ctx, {
          verb: 'request',
          externalId: ref,
          reviewers: input.reviewers,
          ...(resendToken === null ? {} : { resend: resendToken }),
        });
        const requested = await runReviewRequest({
          client: mutation.client,
          externalId: ref,
          reviewers: input.reviewers,
        });
        const dispatched = mutation.didDispatch();
        if (dispatched)
          await ctx.stampUsage(
            reviewUsageStamp(
              'request',
              requested.external_id,
              JSON.stringify(input.reviewers),
              resendToken
            )
          );
        return { ...requested, resend: resendToken !== null, dispatched };
      }
    );
  } catch (error) {
    emitError(toCloudErrorEnvelope(error));
  }
  writeSecretWarnings(result.secret_warnings);
  const unresolved = result.unresolved.length > 0 || result.not_confirmed.length > 0;
  if (opts.json) {
    writeTerminalSafeStdout(stringifyTerminalSafeJson({ ok: !unresolved, ...result }) + '\n');
  } else {
    const lines = [`Review requests for ${result.external_id}`];
    for (const reviewer of result.added)
      lines.push(`  Requested: ${reviewer.reviewer} (notification queued)`);
    for (const reviewer of result.already_requested)
      lines.push(`  Already requested: ${reviewer.reviewer}`);
    for (const reviewer of result.unresolved)
      lines.push(`  Unresolved: ${reviewer} (not requested)`);
    for (const reviewer of result.not_confirmed)
      lines.push(`  Not confirmed: ${reviewer} (the cloud did not confirm this spelling)`);
    if (unresolved)
      lines.push(
        'Run `orcaops plan review reviewers` to find an exact email for unknown or ambiguous identifiers.'
      );
    if (!result.dispatched)
      lines.push(
        '  note: replayed the recorded result of an identical earlier request — nothing was sent. Pass --resend to send it again.'
      );
    else if (result.status === 'unchanged')
      lines.push(
        result.resend
          ? '  No reviewer changes: --resend sent the request again, and the cloud reported nothing to change.'
          : '  No reviewer changes: the cloud reported nothing to change.'
      );
    writeTerminalSafeStdout(lines.join('\n') + '\n');
  }
  if (unresolved) throw new CliExit(1);
}
