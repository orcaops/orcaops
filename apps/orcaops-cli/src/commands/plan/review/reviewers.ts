import { ORCAOPS_CAPABILITIES, resolveWireRepoUrl } from '@orcaops/core';
import type { SourcePlanReviewerDiscoveryResponse } from '@orcaops/sdk';

import { mapPlanCloudReadError, withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../../io/output.js';

export interface ReviewersOptions {
  baseUrl?: string;
  json?: boolean;
}

/**
 * The only cloud method `runReviewReviewers` needs — fakeable in tests. The
 * input is typed structurally (the vendored SDK doesn't re-export the
 * discovery payload type); it matches `OssSourcePlanReviewerDiscovery`'s
 * parsed shape exactly.
 */
export interface ReviewersClient {
  sourcePlan: {
    listReviewers(input: {
      schema_version: 1;
      repo_url: string | null;
    }): Promise<SourcePlanReviewerDiscoveryResponse>;
  };
}

export interface RunReviewersArgs {
  client: ReviewersClient;
  /** Canonicalized current remote — ALWAYS sent when resolvable (see below). */
  repoUrl: string | null;
}

/**
 * I/O-light core: one `listReviewers` wire call. The canonicalized current
 * remote ALWAYS rides the request when the worktree has one: v1 ignores it
 * and returns all ACTIVE org members (`scope: 'all_members'`), but when
 * per-repo reviewer lists are configured later the SAME call filters
 * server-side and flips to `scope: 'repo_configured'` — a cloud-only update,
 * zero CLI change. A typed missing-procedure response uses a discovery-specific
 * message because the generic plan-review message would misidentify the
 * unavailable surface.
 */
export async function runReviewReviewers(
  args: RunReviewersArgs
): Promise<SourcePlanReviewerDiscoveryResponse> {
  try {
    return await args.client.sourcePlan.listReviewers({
      schema_version: 1,
      repo_url: args.repoUrl,
    });
  } catch (err) {
    throw mapPlanCloudReadError(err, {
      missingProcedureMessage: "This cloud doesn't expose reviewer discovery; check the deploy.",
      notFoundMessage: 'Not found: the cloud rejected the reviewer-discovery read.',
      inputPath: 'plan-review-reviewers',
    });
  }
}

/** Human roster render: handle + name rows, then the scope semantics note. */
export function formatHumanReviewers(result: SourcePlanReviewerDiscoveryResponse): string {
  const lines: string[] = [];
  lines.push(`Reviewers (${result.members.length})`);
  for (const m of result.members) {
    lines.push(`  ${m.handle.padEnd(28)} ${m.name}`.trimEnd());
  }
  if (result.members.length === 0) lines.push('  (none)');
  lines.push('');
  lines.push(scopeNote(result.scope));
  lines.push('Request one at upload: --reviewer <handle> (handles are full emails in v1).');
  return lines.join('\n') + '\n';
}

function scopeNote(scope: string): string {
  if (scope === 'all_members') {
    return 'Scope: all org members (repo-scoped reviewer lists come later — same call, no CLI change).';
  }
  if (scope === 'repo_configured') {
    return 'Scope: reviewers configured for this repo.';
  }
  // The wire types scope permissively so a future value is not a break — render it raw.
  return `Scope: ${scope}`;
}

/**
 * `plan review reviewers` — the discovery read backing `--reviewer` handle
 * resolution: who can be requested, by exact handle. Read-only; never touches
 * the review cache. Pairs with `plan upload`'s `unresolved[]` warning (the
 * upload prints likely matches from this same read).
 */
export async function reviewersAction(opts: ReviewersOptions = {}): Promise<void> {
  try {
    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.REVIEWER_DISCOVERY],
        operation: 'plan review reviewers',
      },
      async (ctx) =>
        runReviewReviewers({ client: ctx.client, repoUrl: await resolveWireRepoUrl(ctx.repo) })
    );

    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(formatHumanReviewers(result));
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
