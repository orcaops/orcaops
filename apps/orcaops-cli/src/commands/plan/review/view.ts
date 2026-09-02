import { ORCAOPS_CAPABILITIES } from '@orcaops/core';
import type { OssSourcePlanReviewDetail, SourcePlanReviewDetailResponse } from '@orcaops/sdk';
import { stripControlChars } from '@orcaops/storage';

import { mapPlanCloudReadError, pinRefOf, requireRef, withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../../io/cloud-error-envelope.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../../io/output.js';

export interface ReviewViewOptions {
  proposal?: string;
  comments?: boolean;
  history?: boolean;
  baseUrl?: string;
  json?: boolean;
}

/** The only cloud method `runReviewView` needs — fakeable in tests. */
export interface ReviewViewClient {
  sourcePlan: {
    reviewDetail(input: OssSourcePlanReviewDetail): Promise<SourcePlanReviewDetailResponse>;
  };
}

export interface ReviewViewResult extends SourcePlanReviewDetailResponse {
  /** Ready-to-paste `capture plan --source-plan` ref; null until approved. */
  pinRef: string | null;
}

export interface RunReviewViewArgs {
  client: ReviewViewClient;
  externalId: string;
  proposalId?: string;
}

/**
 * I/O-light core: one `reviewDetail` wire call, result decorated with the
 * computed pin ref. TRIAGE, not checkout — no bodies come back and NOTHING is
 * written to the review cache (the core takes no repoRoot at all), so a view
 * sweep can never clobber an in-flight edit's CAS token.
 */
export async function runReviewView(args: RunReviewViewArgs): Promise<ReviewViewResult> {
  let res: SourcePlanReviewDetailResponse;
  try {
    res = await args.client.sourcePlan.reviewDetail({
      schema_version: 1,
      external_id: args.externalId,
      proposal_id: args.proposalId ?? null,
    });
  } catch (err) {
    const target = args.proposalId
      ? `proposal "${args.proposalId}" on "${args.externalId}"`
      : `a plan under review for "${args.externalId}"`;
    throw mapPlanCloudReadError(err, {
      notFoundMessage: `Not found: ${target}. Check the ref (refs are externalIds — \`plan upload\` echoes the canonical one).`,
      inputPath: 'plan-review-view',
    });
  }
  return { ...res, pinRef: pinRefOf(res.externalId, res.approvedVersionNumber) };
}

const COMMENT_PREVIEW_COUNT = 3;

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

/**
 * Render an authoring baseline as `branch @ sha7` (only the non-null
 * segments), or null when there is nothing to show. The cloud sends the full
 * sha; we render 7 chars. Null baselines are valid for web-authored bodies and
 * git-less uploads, so the caller omits the line.
 */
export function formatBaseline(
  b: { branch: string | null; headSha: string | null } | null
): string | null {
  if (b === null) return null;
  const sha7 = b.headSha ? b.headSha.slice(0, 7) : null;
  if (b.branch && sha7) return `${b.branch} @ ${sha7}`;
  if (b.branch) return b.branch;
  if (sha7) return `@ ${sha7}`;
  return null;
}

type ReviewComment = ReviewViewResult['comments'][number];

interface ClassifiedComments {
  /** Top-level comments: true roots, detached verdict-replies (cloud-folded), and
   *  orphan comment-replies whose parent isn't a rendered root (folded, never dropped). */
  roots: ReviewComment[];
  /** parentCommentId -> its one-level comment-replies. */
  repliesByParent: Map<string, ReviewComment[]>;
  /** parentVerdictId (attached to a current reviewer's verdict) -> verdict-replies. */
  repliesByVerdict: Map<string, ReviewComment[]>;
}

/**
 * Partition comments the way the cloud's `isRootPlanComment` does: a comment-reply
 * (parentCommentId set) nests under its parent; a verdict-reply whose parentVerdictId
 * matches a current reviewer's verdict renders under that verdict; everything else —
 * including a DETACHED verdict-reply whose verdict is no longer a current reviewer's —
 * is a root and must NOT be dropped (the cloud has already folded it back to a root).
 *
 * Two passes: a comment is a root iff it has no parent comment AND is not an attached
 * verdict-reply — independent of other comments, so the root id-set is computable up
 * front. A comment-reply then nests only when its parent is an actual root; an ORPHAN
 * (parent absent / not a root) folds back to a root, so no reply is ever dropped —
 * symmetric with the detached-verdict-reply fold.
 */
function classifyComments(result: ReviewViewResult): ClassifiedComments {
  const attachedVerdictIds = new Set(result.reviewers.flatMap((r) => r.history.map((h) => h.id)));
  const isRoot = (c: ReviewComment): boolean =>
    c.parentCommentId === null &&
    !(c.parentVerdictId !== null && attachedVerdictIds.has(c.parentVerdictId));
  const rootIds = new Set(result.comments.filter(isRoot).map((c) => c.commentId));
  const roots: ReviewComment[] = [];
  const repliesByParent = new Map<string, ReviewComment[]>();
  const repliesByVerdict = new Map<string, ReviewComment[]>();
  const push = (m: Map<string, ReviewComment[]>, k: string, c: ReviewComment): void => {
    const arr = m.get(k);
    if (arr) arr.push(c);
    else m.set(k, [c]);
  };
  for (const c of result.comments) {
    if (c.parentCommentId !== null) {
      if (rootIds.has(c.parentCommentId)) push(repliesByParent, c.parentCommentId, c);
      else roots.push(c); // orphan comment-reply: fold to root, never drop
    } else if (c.parentVerdictId !== null && attachedVerdictIds.has(c.parentVerdictId)) {
      // An attached verdict-reply (parentVerdictId is in a current reviewer's history).
      push(repliesByVerdict, c.parentVerdictId, c);
    } else {
      roots.push(c);
    }
  }
  return { roots, repliesByParent, repliesByVerdict };
}

/** Comments sorted oldest-first (stable chronological), tolerant of undefined. */
function sortedByDate(cs: ReviewComment[] | undefined): ReviewComment[] {
  return cs ? [...cs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
}

/**
 * Human triage render: header, reviewers (standing; `--history` expands each
 * reviewer's verdict trail with its replies), proposals, and the comment thread
 * (3-newest root preview, or the full root thread with nested replies under
 * `--comments`), then a `Next:` hint. JSON always carries every comment/verdict —
 * the flags only widen the human rendering.
 */
export function formatHumanView(
  result: ReviewViewResult,
  opts: { comments?: boolean; history?: boolean }
): string {
  const lines: string[] = [];
  lines.push(`${result.slug} (${result.externalId})  ${result.status}`);
  lines.push(`Title:      ${result.title}`);
  if (result.candidate) {
    const c = result.candidate;
    lines.push(
      `Candidate:  v${c.versionNumber} (${c.versionId})  ${c.contentHash.slice(0, 12)}…  by ${c.authorHandle}  ${shortDate(c.createdAt)}`
    );
    const cb = formatBaseline(c.baseline);
    if (cb) lines.push(`Baseline:   ${cb}`);
  } else {
    lines.push('Candidate:  (none)');
  }
  lines.push(
    result.pinRef !== null
      ? `Approved:   v${result.approvedVersionNumber}  →  pin ref: ${result.pinRef}`
      : 'Approved:   (not yet approved)'
  );

  const { roots, repliesByParent, repliesByVerdict } = classifyComments(result);

  lines.push('');
  lines.push(`Reviewers (${result.reviewers.length})`);
  for (const r of result.reviewers) {
    // `standing` is the cloud-resolved headline (PENDING / APPROVED /
    // CHANGES_REQUESTED / NEEDS_RE_REVIEW) — staleness is folded in server-side,
    // so the CLI never re-derives it from a version compare.
    let line = `  ${r.handle.padEnd(28)} ${r.standing.padEnd(18)}`;
    if (r.currentVerdict?.note) {
      // A live verdict on the current candidate — its note is current.
      line += ` "${r.currentVerdict.note}"`;
    } else if (r.standing === 'NEEDS_RE_REVIEW' && r.history[0]) {
      // The reviewer's prior verdict is stale against a newer candidate; show what it was.
      const h = r.history[0];
      const ver = h.versionNumber != null ? ` on v${h.versionNumber}` : '';
      const note = h.note ? ` "${h.note}"` : '';
      line += ` (was ${h.state}${ver}${note})`;
    }
    const verdictReplyCount = r.history.reduce(
      (n, h) => n + (repliesByVerdict.get(h.id)?.length ?? 0),
      0
    );
    // Point at `--history` only when there's more to see than the current standing.
    if (!opts.history && (r.hasEarlierVerdicts || verdictReplyCount > 0)) {
      line += '  (--history for the trail)';
    }
    lines.push(line.trimEnd());

    if (opts.history) {
      // `history` is newest-first (SDK contract); render the trail oldest→newest so it
      // reads as a chronology. The default-view `(was …)` read above still uses
      // history[0] = newest — only this display order is reversed.
      for (const h of [...r.history].reverse()) {
        const ver = h.versionNumber != null ? ` v${h.versionNumber}` : '';
        let hl = `      ${h.state.padEnd(18)}${ver}  ${shortDate(h.createdAt)}`;
        if (h.note) hl += `  "${h.note}"`;
        lines.push(hl);
        for (const reply of sortedByDate(repliesByVerdict.get(h.id))) {
          lines.push(formatReply(reply, '        '));
        }
      }
    }
  }
  if (result.reviewers.length === 0) lines.push('  (none requested)');

  const open = result.proposals.filter((p) => p.state === 'OPEN');
  lines.push('');
  lines.push(`Proposals (${result.proposals.length}, ${open.length} open)`);
  for (const p of result.proposals) {
    let line = `  ${p.proposalId}  ${p.state.padEnd(10)} by ${p.authorHandle}`;
    if (p.baseVersionNumber !== null) line += `  base v${p.baseVersionNumber}`;
    const pb = formatBaseline(p.baseline);
    if (pb) line += `  [${pb}]`;
    if (p.needsRebase) line += '  NEEDS REBASE';
    if (p.summary) line += `  "${p.summary}"`;
    if (p.state === 'DECLINED' && p.declineReason) line += `  (declined: ${p.declineReason})`;
    lines.push(line);
  }
  if (result.proposals.length === 0) lines.push('  (none)');

  // The Comments section counts and previews ROOTS only (matching the cloud's
  // `commentCount = rootComments.length`); comment-replies nest under their root,
  // and verdict-replies live in the Reviewers section above.
  lines.push('');
  const renderRoot = (c: ReviewComment, expand: boolean): void => {
    lines.push(formatComment(c));
    const replies = repliesByParent.get(c.commentId) ?? [];
    if (replies.length === 0) return;
    if (expand) {
      for (const reply of sortedByDate(replies)) lines.push(formatReply(reply, '      '));
    } else {
      lines.push(
        `      (+${replies.length} repl${replies.length === 1 ? 'y' : 'ies'} — --comments)`
      );
    }
  };
  if (opts.comments) {
    lines.push(`Comments (${roots.length})`);
    for (const c of sortedByDate(roots)) renderRoot(c, true);
  } else {
    const more =
      roots.length > COMMENT_PREVIEW_COUNT
        ? ` — newest ${COMMENT_PREVIEW_COUNT}; --comments for the thread`
        : '';
    lines.push(`Comments (${roots.length}${more})`);
    const newest = [...roots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const c of newest.slice(0, COMMENT_PREVIEW_COUNT)) renderRoot(c, false);
  }
  if (roots.length === 0) lines.push('  (none)');
  // Verdict-replies render under their verdict (Reviewers section, via `--history`),
  // not here — so `--comments` alone never reads as "the whole thread" when it isn't.
  const verdictReplyTotal = [...repliesByVerdict.values()].reduce((n, a) => n + a.length, 0);
  if (!opts.history && verdictReplyTotal > 0) {
    lines.push(
      `  (${verdictReplyTotal} verdict-repl${verdictReplyTotal === 1 ? 'y' : 'ies'} under reviewer verdicts — --history)`
    );
  }

  const next = nextHint(result);
  if (next) {
    lines.push('');
    lines.push(`Next: ${next}`);
  }
  return lines.join('\n') + '\n';
}

function formatComment(c: ReviewComment): string {
  const where = c.target === 'proposal' && c.proposalId ? `proposal ${c.proposalId}` : 'candidate';
  let line = `  [${where}] ${stripControlChars(c.authorHandle)}  ${shortDate(c.createdAt)}  (${c.commentId})`;
  if (c.quote) line += `  on "${stripControlChars(c.quote)}"`;
  line += `: ${stripControlChars(c.body)}`;
  return line;
}

/** A one-level reply, indented under its parent comment or verdict. */
function formatReply(c: ReviewComment, indent: string): string {
  return `${indent}↳ ${stripControlChars(c.authorHandle)}  ${shortDate(c.createdAt)}  (${c.commentId}): ${stripControlChars(c.body)}`;
}

function nextHint(result: ReviewViewResult): string | null {
  const firstOpen = result.proposals.find((p) => p.state === 'OPEN');
  if (firstOpen) {
    return `orcaops plan review pull ${result.externalId} --proposal ${firstOpen.proposalId}`;
  }
  if (result.status === 'APPROVED' && result.pinRef !== null) {
    return `orcaops capture plan --source-plan ${result.pinRef}`;
  }
  return null;
}

/**
 * `plan review view <ref>` — the triage surface: full review state (candidate,
 * reviewer verdicts, proposals, comments) in one read-only call. Bodies stay on
 * `plan review pull` (checkout); this verb never writes the review cache.
 */
export async function reviewViewAction(ref: string, opts: ReviewViewOptions = {}): Promise<void> {
  try {
    requireRef(ref, 'plan-review-view');
    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [ORCAOPS_CAPABILITIES.SOURCE_PLAN_REVIEW],
        operation: 'plan review view',
      },
      (ctx) =>
        runReviewView({
          client: ctx.client,
          externalId: ref,
          ...(opts.proposal ? { proposalId: opts.proposal } : {}),
        })
    );

    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(
      formatHumanView(result, {
        comments: opts.comments ?? false,
        history: opts.history ?? false,
      })
    );
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
