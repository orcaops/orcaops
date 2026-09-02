import type { OssReviewFeedbackStatusResponse } from '@orcaops/sdk';
import { stripControlChars } from '@orcaops/storage';

import { withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../io/cloud-error-envelope.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../../io/output.js';

export interface ReviewFeedbackStatusClient {
  review: { status(input: { schema_version: 1 }): Promise<OssReviewFeedbackStatusResponse> };
}

export type ReviewFeedbackStatusResult = OssReviewFeedbackStatusResponse;

export async function runReviewFeedbackStatus(args: {
  client: ReviewFeedbackStatusClient;
}): Promise<ReviewFeedbackStatusResult> {
  return args.client.review.status({ schema_version: 1 });
}

export function formatHumanReviewFeedbackStatus(result: ReviewFeedbackStatusResult): string {
  const lines: string[] = [`Open PRs under review (${result.items.length})`];
  for (const item of result.items) {
    const s = item.subject;
    const a = item.activity;
    let line = `  PR #${s.pull_request_number}  ${stripControlChars(s.pull_request_title)}`;
    if (s.task_number !== null) line += `  (task #${s.task_number})`;
    lines.push(line);
    if (a.has_new_human_activity) {
      lines.push(
        `    NEW human activity since your agent's last pass — ${a.open_thread_count} open thread(s)`
      );
      lines.push(`    Next: orcaops review pull --pr ${s.pull_request_id}`);
    } else {
      lines.push(`    quiet — ${a.open_thread_count} open thread(s), nothing new for the agent`);
    }
  }
  if (result.items.length === 0) lines.push('  (none)');
  return lines.join('\n') + '\n';
}

/** `orcaops review status` — my open reviewed PRs + the arming flag (read-only). */
export async function reviewFeedbackStatusAction(
  opts: { baseUrl?: string; json?: boolean } = {}
): Promise<void> {
  try {
    const result = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [],
        operation: 'review status',
      },
      (ctx) => runReviewFeedbackStatus({ client: ctx.client })
    );
    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(formatHumanReviewFeedbackStatus(result));
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
