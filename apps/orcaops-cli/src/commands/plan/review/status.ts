import { ORCAOPS_CAPABILITIES } from '@orcaops/core';
import { getAuthState } from '@orcaops/sdk';
import type {
  OssSourcePlanReviewList,
  SourcePlanListResponse,
  SourcePlanReviewVerdictCounts,
} from '@orcaops/sdk';

import { type ReviewListItem } from './list.js';
import { mapPlanCloudReadError, pinRefOf, withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../../io/output.js';

export interface ReviewStatusOptions {
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud method `runReviewStatus` needs — fakeable in tests. */
export interface ReviewStatusClient {
  sourcePlan: {
    list(input: OssSourcePlanReviewList): Promise<SourcePlanListResponse>;
  };
}

export interface ReviewStatusItem extends ReviewListItem {
  /** Advisory next step for THIS plan — same hint family the cli renders elsewhere. */
  nextAction: string | null;
}

export interface ReviewStatusResult {
  /** The handle the reviewing section was computed against; null = unknown identity. */
  myHandle: string | null;
  authored: ReviewStatusItem[];
  authoredTruncated: boolean;
  /** Plans where MY reviewer seat still wants action — standing PENDING or
   *  NEEDS_RE_REVIEW. Empty when myHandle is null. */
  reviewing: ReviewStatusItem[];
  reviewingTruncated: boolean;
}

export interface RunReviewStatusArgs {
  client: ReviewStatusClient;
  myHandle: string | null;
}

const SECTION_LIMIT = 30;

function listInput(section: 'authored' | 'reviewing'): OssSourcePlanReviewList {
  return {
    schema_version: 1,
    // Authored excludes PINNED (those are done); reviewing is the active queue.
    statuses: section === 'authored' ? ['IN_REVIEW', 'APPROVED'] : ['IN_REVIEW'],
    author: null,
    reviewer: null,
    author_me: section === 'authored',
    reviewer_me: section === 'reviewing',
    limit: SECTION_LIMIT,
  };
}

function handlesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * I/O-light core: TWO `list` calls (author_me / reviewer_me — there is no
 * dedicated status procedure), sectioned client-side. The reviewing section
 * keeps only plans where MY reviewer seat still wants action — standing PENDING
 * or NEEDS_RE_REVIEW — matching my handle the way the cloud does
 * (case-insensitive, trimmed). A null handle (no email
 * on the credential, e.g. an env-token store) degrades to an empty reviewing
 * section — never a throw.
 */
export async function runReviewStatus(args: RunReviewStatusArgs): Promise<ReviewStatusResult> {
  let authoredRes: SourcePlanListResponse;
  let reviewingRes: SourcePlanListResponse;
  try {
    [authoredRes, reviewingRes] = await Promise.all([
      args.client.sourcePlan.list(listInput('authored')),
      args.client.sourcePlan.list(listInput('reviewing')),
    ]);
  } catch (err) {
    throw mapPlanCloudReadError(err, {
      notFoundMessage: 'Not found: the cloud rejected the status query.',
      inputPath: 'plan-review-status',
    });
  }

  const authored: ReviewStatusItem[] = authoredRes.plans.map((p) => {
    const pinRef = pinRefOf(p.externalId, p.approvedVersionNumber);
    let nextAction: string | null = null;
    if (p.status === 'APPROVED' && pinRef !== null) {
      nextAction = `orcaops capture plan --source-plan ${pinRef}`;
    } else if (p.openProposalCount > 0) {
      // List items carry no proposal ids — route through view to pick one.
      nextAction = `orcaops plan review view ${p.externalId}`;
    }
    return { ...p, pinRef, nextAction };
  });

  const reviewing: ReviewStatusItem[] =
    args.myHandle === null
      ? []
      : reviewingRes.plans
          .filter((p) =>
            p.reviewers.some(
              (r) =>
                handlesMatch(r.handle, args.myHandle as string) &&
                // A seat still wanting MY action: never verdicted (PENDING) or
                // verdicted against an older candidate (NEEDS_RE_REVIEW). A current
                // APPROVED / CHANGES_REQUESTED means I'm done until the next push.
                (r.standing === 'PENDING' || r.standing === 'NEEDS_RE_REVIEW')
            )
          )
          .map((p) => ({
            ...p,
            pinRef: pinRefOf(p.externalId, p.approvedVersionNumber),
            nextAction: `orcaops plan review pull ${p.externalId}`,
          }));

  return {
    myHandle: args.myHandle,
    authored,
    authoredTruncated: authoredRes.truncated,
    reviewing,
    reviewingTruncated: reviewingRes.truncated,
  };
}

/**
 * One-line current-vs-stale verdict rollup from the cloud's `reviewVerdict`
 * counts — a stale approval reads as `needs-re-review`, never as a live one, so
 * an author can't mistake a stale sign-off for a current gate.
 */
function verdictRollupText(v: SourcePlanReviewVerdictCounts): string {
  const parts: string[] = [];
  if (v.approvedCurrent) parts.push(`${v.approvedCurrent} approved`);
  if (v.changesRequestedCurrent) parts.push(`${v.changesRequestedCurrent} changes-requested`);
  const needsReReview = v.approvedStale + v.changesRequestedStale;
  if (needsReReview) parts.push(`${needsReReview} needs-re-review`);
  if (v.pending) parts.push(`${v.pending} pending`);
  return parts.join(', ');
}

/** Human render: the two fixed sections with per-plan `Next:` hints. */
export function formatHumanReviewStatus(result: ReviewStatusResult): string {
  const lines: string[] = [];

  lines.push(`Authored by you (${result.authored.length})`);
  for (const p of result.authored) {
    let line = `  ${p.externalId}  ${p.status.padEnd(10)} ${p.slug}`;
    if (p.candidateVersionNumber !== null) line += `  cand v${p.candidateVersionNumber}`;
    if (p.approvedVersionNumber !== null) line += `  appr v${p.approvedVersionNumber}`;
    if (p.openProposalCount > 0) line += `  ${p.openProposalCount} open proposal(s)`;
    if (p.baselineBranch !== null) line += `  [${p.baselineBranch}]`;
    lines.push(line);
    const rollup = verdictRollupText(p.reviewVerdict);
    if (rollup) lines.push(`    Verdicts: ${rollup}`);
    if (p.nextAction) lines.push(`    Next: ${p.nextAction}`);
  }
  if (result.authored.length === 0) lines.push('  (none in review)');
  if (result.authoredTruncated) lines.push('  …more exist — use `plan review list --mine`');

  lines.push('');
  if (result.myHandle === null) {
    lines.push('Wants your review: unavailable — no email on the stored credential.');
  } else {
    lines.push(`Wants your review (${result.reviewing.length})`);
    for (const p of result.reviewing) {
      let line = `  ${p.externalId}  ${p.slug}  by ${p.authorHandle}`;
      if (p.baselineBranch !== null) line += `  [${p.baselineBranch}]`;
      lines.push(line);
      if (p.nextAction) lines.push(`    Next: ${p.nextAction}`);
    }
    if (result.reviewing.length === 0) lines.push('  (nothing pending)');
    if (result.reviewingTruncated) {
      lines.push('  …more exist — use `plan review list --reviewer <you>`');
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * `plan review status` — the agent landing page: plans you authored (with
 * pin-ref hints once approved) and plans waiting on YOUR verdict. Read-only.
 */
export async function reviewStatusAction(opts: ReviewStatusOptions = {}): Promise<void> {
  try {
    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review status',
      },
      async (ctx) => {
        const state = await getAuthState(ctx.credentialStore, ctx.baseUrl);
        const myHandle = state.kind === 'connected' && state.email ? state.email : null;
        return runReviewStatus({ client: ctx.client, myHandle });
      }
    );

    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(formatHumanReviewStatus(result));
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
