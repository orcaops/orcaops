import { ORCAOPS_CAPABILITIES } from '@orcaops/core';
import type {
  OssSourcePlanReviewList,
  SourcePlanListResponse,
  SourcePlanReviewListItem,
} from '@orcaops/sdk';

import { mapPlanCloudReadError, pinRefOf, withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../../io/output.js';
import { parseDigitInt } from '../../../lib/strict-int.js';

export interface ReviewListOptions {
  state?: string[];
  author?: string;
  reviewer?: string;
  mine?: boolean;
  limit?: string;
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud method `runReviewList` needs — fakeable in tests. */
export interface ReviewListClient {
  sourcePlan: {
    list(input: OssSourcePlanReviewList): Promise<SourcePlanListResponse>;
  };
}

type WireStatus = 'IN_REVIEW' | 'APPROVED' | 'PINNED';

export interface ParsedListFilters {
  statuses: WireStatus[];
  author: string | null;
  reviewer: string | null;
  authorMe: boolean;
  limit: number;
}

const STATE_MAP: Record<string, WireStatus> = {
  'in-review': 'IN_REVIEW',
  approved: 'APPROVED',
  pinned: 'PINNED',
};
const ALL_STATUSES: WireStatus[] = ['IN_REVIEW', 'APPROVED', 'PINNED'];
const LIMIT_DEFAULT = 30;

/**
 * Pre-validate the filter flags into the wire shape BEFORE any cloud call, so
 * every rejection here is a friendly INVALID_INPUT rather than the protocol
 * superRefine's raw message. Handle filters pass through VERBATIM — matching
 * (v1: full email, case-insensitive, trimmed) is cloud-owned.
 */
export function parseListFilters(opts: {
  state?: string[];
  author?: string;
  reviewer?: string;
  mine?: boolean;
  limit?: string;
}): ParsedListFilters {
  const inputPath = 'plan-review-list';
  if (opts.mine && opts.author !== undefined) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--mine and --author are mutually exclusive (--mine is shorthand for --author <you>).',
      inputPath
    );
  }

  const statuses: WireStatus[] = [];
  for (const raw of opts.state ?? []) {
    const s = raw.trim().toLowerCase();
    if (s === 'draft') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'The cloud has no DRAFT state — plans enter review at upload. States: in-review, approved, pinned, all.',
        inputPath
      );
    }
    if (s === 'all') {
      statuses.push(...ALL_STATUSES);
      continue;
    }
    const mapped = STATE_MAP[s];
    if (!mapped) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Unknown --state "${raw}". States: in-review, approved, pinned, all.`,
        inputPath
      );
    }
    statuses.push(mapped);
  }
  const deduped = [...new Set(statuses)];

  let limit = LIMIT_DEFAULT;
  if (opts.limit !== undefined) {
    limit = parseDigitInt(opts.limit) ?? NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--limit must be an integer between 1 and 100 (got "${opts.limit}").`,
        inputPath
      );
    }
  }

  return {
    statuses: deduped.length > 0 ? deduped : ['IN_REVIEW'],
    author: opts.author ?? null,
    reviewer: opts.reviewer ?? null,
    authorMe: opts.mine === true,
    limit,
  };
}

export interface ReviewListItem extends SourcePlanReviewListItem {
  /** Ready-to-paste `capture plan --source-plan` ref; null until approved. */
  pinRef: string | null;
}

export interface ReviewListResult {
  plans: ReviewListItem[];
  /** True when rows exist beyond `limit` — ALWAYS announced, never a silent cap. */
  truncated: boolean;
}

export interface RunReviewListArgs {
  client: ReviewListClient;
  filters: ParsedListFilters;
}

/** I/O-light core: one `list` wire call, items decorated with their pin refs. */
export async function runReviewList(args: RunReviewListArgs): Promise<ReviewListResult> {
  let res: SourcePlanListResponse;
  try {
    res = await args.client.sourcePlan.list({
      schema_version: 1,
      statuses: args.filters.statuses,
      author: args.filters.author,
      reviewer: args.filters.reviewer,
      author_me: args.filters.authorMe,
      reviewer_me: false,
      limit: args.filters.limit,
    });
  } catch (err) {
    throw mapPlanCloudReadError(err, {
      notFoundMessage:
        'Not found: no org member matches the handle filter. Handles are full email addresses (v1), matched case-insensitively.',
      inputPath: 'plan-review-list',
    });
  }
  return {
    plans: res.plans.map((p) => ({
      ...p,
      pinRef: pinRefOf(p.externalId, p.approvedVersionNumber),
    })),
    truncated: res.truncated,
  };
}

/** Human table — inline padEnd formatter per the `list` command precedent. */
export function formatHumanReviewList(result: ReviewListResult): string {
  if (result.plans.length === 0) {
    return 'No plans found. (Filters: --state in-review by default; try --state all.)\n';
  }
  const lines: string[] = [];
  lines.push(
    `${'EXTERNAL ID'.padEnd(38)} ${'SLUG'.padEnd(22)} ${'STATUS'.padEnd(10)} ${'CAND'.padEnd(5)} ${'APPR'.padEnd(5)} ${'PROPS'.padEnd(5)} ${'BRANCH'.padEnd(16)} ${'AUTHOR'.padEnd(26)} UPDATED`
  );
  for (const p of result.plans) {
    const slug = p.slug.length > 22 ? `${p.slug.slice(0, 21)}…` : p.slug;
    const author = p.authorHandle.length > 26 ? `${p.authorHandle.slice(0, 25)}…` : p.authorHandle;
    // The candidate's authoring-baseline branch; '-' for candidates without
    // recorded baseline context, including web-authored and git-less uploads.
    const rawBranch = p.baselineBranch === null ? '-' : p.baselineBranch;
    const branch = rawBranch.length > 16 ? `${rawBranch.slice(0, 15)}…` : rawBranch;
    lines.push(
      `${p.externalId.padEnd(38)} ${slug.padEnd(22)} ${p.status.padEnd(10)} ${(p.candidateVersionNumber !== null ? `v${p.candidateVersionNumber}` : '-').padEnd(5)} ${(p.approvedVersionNumber !== null ? `v${p.approvedVersionNumber}` : '-').padEnd(5)} ${String(p.openProposalCount).padEnd(5)} ${branch.padEnd(16)} ${author.padEnd(26)} ${p.updatedAt.slice(0, 10)}`
    );
  }
  if (result.truncated) {
    lines.push(`showing ${result.plans.length}; more exist — raise --limit`);
  }
  return lines.join('\n') + '\n';
}

/**
 * `plan review list` — discovery: enumerate the org's plans under review,
 * filterable by state/author/reviewer. Read-only; never touches the review
 * cache. Truncation is always announced.
 */
export async function reviewListAction(opts: ReviewListOptions = {}): Promise<void> {
  try {
    const filters = parseListFilters(opts);
    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review list',
      },
      (ctx) => runReviewList({ client: ctx.client, filters })
    );

    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(formatHumanReviewList(result));
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
