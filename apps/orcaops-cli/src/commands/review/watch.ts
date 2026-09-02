import type { OssReviewFeedbackStatusResponse } from '@orcaops/sdk';
import { readReviewFeedbackWatchCursor, writeReviewFeedbackWatchCursor } from '@orcaops/storage';

import { reviewFeedbackCacheDir, withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../io/output.js';
import { parseDigitInt } from '../../lib/strict-int.js';

// Poll + cap clone the plan loop's constants (APPROVE_POLL_INTERVAL_MS pattern).
export const REVIEW_WATCH_POLL_INTERVAL_MS = 4_000;
export const REVIEW_WATCH_TIMEOUT_DEFAULT_SEC = 600;

export interface ReviewFeedbackWatchClient {
  review: { status(input: { schema_version: 1 }): Promise<OssReviewFeedbackStatusResponse> };
}

export interface WatchDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: WatchDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

type StatusItem = OssReviewFeedbackStatusResponse['items'][number];

export type ReviewFeedbackWatchResult =
  | { status: 'NEW_ACTIVITY'; item: StatusItem; cursor: string }
  | { status: 'TIMEOUT'; pullRequestId: string; baseline: string | null };

function findSubject(
  items: StatusItem[],
  taskNumber: number | null,
  pullRequestId: string | null
): StatusItem {
  const matches =
    pullRequestId !== null
      ? items.filter((i) => i.subject.pull_request_id === pullRequestId)
      : items.filter((i) => i.subject.task_number === taskNumber);
  if (matches.length === 0) {
    // No generic NOT_FOUND in ErrorCodes — INVALID_INPUT matches the io/errors.ts convention.
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'No matching open reviewed PR in your review status — check --task/--pr (and that the task is yours).',
      'review-watch'
    );
  }
  if (matches.length > 1) {
    const listing = matches
      .map((m) => `PR #${m.subject.pull_request_number} (${m.subject.pull_request_id})`)
      .join('; ');
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Task has multiple open reviewed PRs — pass --pr explicitly: ${listing}`,
      'review-watch'
    );
  }
  return matches[0];
}

/**
 * Bounded poll on the activity cursor. Baseline-at-arm: with no
 * cached cursor the FIRST poll's last_human_activity_at becomes the baseline —
 * a fresh clone never fires on pre-arm activity (the status flag covers that).
 * Exit 0 = strictly newer human activity; exit 2 = timeout, NOT a failure.
 */
export async function runReviewFeedbackWatch(args: {
  client: ReviewFeedbackWatchClient;
  taskNumber: number | null;
  pullRequestId: string | null;
  baselineCursor: string | null;
  timeoutMs: number;
  deps?: Partial<WatchDeps>;
}): Promise<ReviewFeedbackWatchResult> {
  if ((args.taskNumber === null) === (args.pullRequestId === null)) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Pass exactly one of --task <n> / --pr <pull_request_id>.',
      'review-watch'
    );
  }
  const deps: WatchDeps = { ...defaultDeps, ...args.deps };
  const deadline = deps.now() + args.timeoutMs;

  let res = await args.client.review.status({ schema_version: 1 });
  let item = findSubject(res.items, args.taskNumber, args.pullRequestId);
  const pullRequestId = item.subject.pull_request_id;
  const baseline = args.baselineCursor ?? item.activity.last_human_activity_at;

  for (;;) {
    const current = item.activity.last_human_activity_at;
    if (current !== null && (baseline === null || current > baseline)) {
      return { status: 'NEW_ACTIVITY', item, cursor: current };
    }
    if (deps.now() >= deadline) {
      return { status: 'TIMEOUT', pullRequestId, baseline };
    }
    await deps.sleep(REVIEW_WATCH_POLL_INTERVAL_MS);
    res = await args.client.review.status({ schema_version: 1 });
    item = findSubject(res.items, null, pullRequestId);
  }
}

/** `orcaops review watch [--task N | --pr <id>] [--timeout <sec>]` */
export async function reviewFeedbackWatchAction(
  opts: { task?: string; pr?: string; timeout?: string; baseUrl?: string; json?: boolean } = {}
): Promise<void> {
  try {
    let taskNumber: number | null = null;
    if (opts.task !== undefined) {
      taskNumber = parseDigitInt(opts.task) ?? NaN;
      if (!Number.isInteger(taskNumber) || taskNumber < 1) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--task must be a positive integer (got "${opts.task}").`,
          'review-watch'
        );
      }
    }
    let timeoutSec = REVIEW_WATCH_TIMEOUT_DEFAULT_SEC;
    if (opts.timeout !== undefined) {
      timeoutSec = parseDigitInt(opts.timeout) ?? NaN;
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--timeout must be a positive integer of seconds (got "${opts.timeout}").`,
          'review-watch'
        );
      }
    }

    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [],
        operation: 'review watch',
      },
      async (ctx) => {
        const cacheDir = reviewFeedbackCacheDir(ctx.repoRoot);
        // Subject id for the cursor read may be unknown pre-poll (--task); the
        // baseline read happens against --pr when given, else after the arm poll
        // inside runReviewFeedbackWatch (null baseline = baseline-at-arm).
        const baselineCursor =
          opts.pr !== undefined
            ? await readReviewFeedbackWatchCursor(
                cacheDir,
                ctx.baseUrl,
                ctx.orgId,
                opts.pr,
                ctx.repoRoot
              )
            : null;
        const watch = await runReviewFeedbackWatch({
          client: ctx.client,
          taskNumber,
          pullRequestId: opts.pr ?? null,
          baselineCursor,
          timeoutMs: timeoutSec * 1000,
        });
        if (watch.status === 'NEW_ACTIVITY') {
          await writeReviewFeedbackWatchCursor(
            cacheDir,
            {
              baseUrl: ctx.baseUrl,
              orgId: ctx.orgId,
              pullRequestId: watch.item.subject.pull_request_id,
              lastSeenHumanActivityAt: watch.cursor,
            },
            ctx.repoRoot
          );
        }
        return watch;
      }
    );

    if (result.status === 'TIMEOUT') {
      // Exit 2 — distinct "nothing yet", NOT a failure. Scripts and
      // the skill branch on it; the skill then runs ONE status check.
      throw new OrcaopsError(
        ErrorCodes.REVIEW_WATCH_TIMEOUT,
        `No new human activity on ${result.pullRequestId} within the window. Not silence-as-failure — re-arm with \`orcaops review watch\` or check \`orcaops review status\`.`,
        'review-watch'
      );
    }
    if (opts.json) {
      emitOk(result);
      return;
    }
    const s = result.item.subject;
    writeTerminalSafeStdout(
      `NEW human activity on PR #${s.pull_request_number} (${s.pull_request_title}) — ` +
        `${result.item.activity.open_thread_count} open thread(s).\n` +
        `Next: orcaops review pull --pr ${s.pull_request_id}\n`
    );
  } catch (err) {
    const exitCode =
      err instanceof OrcaopsError && err.code === ErrorCodes.REVIEW_WATCH_TIMEOUT ? 2 : 1;
    emitError(toCloudErrorEnvelope(err), { exitCode });
  }
}
