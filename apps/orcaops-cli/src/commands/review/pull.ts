import { writeFile } from 'node:fs/promises';

import type {
  OssReviewFeedbackAnchorState,
  OssReviewFeedbackPull,
  OssReviewFeedbackTranscript,
} from '@orcaops/sdk';
// storage re-exports crypto (`export * from './crypto.js'`), so sha256Hex is public.
import { sha256Hex, stripControlChars, writeReviewFeedbackPullRecord } from '@orcaops/storage';

import { reviewFeedbackCacheDir, withReviewCloud } from './shared.js';
import { toCloudErrorEnvelope } from '../../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { emitError, emitOk, writePipeFriendlyStdout } from '../../io/output.js';
import { parseDigitInt } from '../../lib/strict-int.js';

export interface ReviewFeedbackPullClient {
  review: { pull(input: OssReviewFeedbackPull): Promise<OssReviewFeedbackTranscript> };
}

export async function runReviewFeedbackPull(args: {
  client: ReviewFeedbackPullClient;
  taskNumber: number | null;
  pullRequestId: string | null;
}): Promise<OssReviewFeedbackTranscript> {
  if ((args.taskNumber === null) === (args.pullRequestId === null)) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Pass exactly one of --task <n> / --pr <pull_request_id>.',
      'review-pull'
    );
  }
  return args.client.review.pull({
    schema_version: 1,
    task_number: args.taskNumber,
    pull_request_id: args.pullRequestId,
  });
}

function indentBody(body: string): string {
  return body
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

function anchorStateMarker(state: OssReviewFeedbackAnchorState): string {
  switch (state) {
    case 'CURRENT':
      return '';
    case 'OUTDATED':
      return ' [OUTDATED anchor — line moved out of the current diff]';
    case 'DETACHED':
      return ' [DETACHED anchor]';
    default: {
      const unreachable: never = state;
      throw new Error(`Unsupported review anchor state: ${String(unreachable)}`);
    }
  }
}

/** Wire transcript → agent-readable markdown. The activity cursor is printed
 *  FIRST-CLASS: replies echo it as --pass-token so one pass = one notification. */
export function renderTranscriptMarkdown(t: OssReviewFeedbackTranscript): string {
  const s = t.subject;
  // Server-supplied free text goes straight to the agent's TTY — strip control
  // chars (ESC/OSC/NUL ride along in comment bodies trivially, even by accident).
  const clean = stripControlChars;
  const lines: string[] = [];
  lines.push(`# Review feedback — PR #${s.pull_request_number}: ${clean(s.pull_request_title)}`);
  lines.push('');
  lines.push(`- pull_request_id: ${s.pull_request_id}`);
  if (s.task_number !== null) lines.push(`- task: #${s.task_number}`);
  lines.push(`- url: ${s.pull_request_url}`);
  lines.push(`- current snapshot: ${s.current_snapshot_id ?? 'none'}`);
  lines.push(
    `- threads: ${t.dispositions.open_thread_count} open / ${t.dispositions.resolved_thread_count} resolved`
  );
  lines.push(
    `- activity cursor (echo as --pass-token on replies): ${t.activity.last_human_activity_at ?? 'none'}`
  );
  if (t.submissions.length > 0) {
    lines.push('');
    lines.push('## Feedback submissions');
    for (const sub of t.submissions) {
      const currency = sub.is_current_snapshot
        ? 'current snapshot'
        : `STALE (reviewed ${sub.reviewed_version_key})`;
      const note = sub.note ? ` — note: ${clean(sub.note)}` : '';
      lines.push(
        `- ${sub.created_at} — ${sub.published_comment_ids.length} comment(s), ${currency}${note}`
      );
    }
  }
  lines.push('');
  lines.push('## Threads');
  for (const th of t.threads) {
    const label = clean(th.anchor_context?.label ?? th.root.anchor_key ?? th.root.anchor_type);
    const stateMarker = anchorStateMarker(th.anchor_state);
    lines.push('');
    lines.push(`### [${th.root.status}] ${label}${stateMarker}`);
    if (th.anchor_context?.excerpt) lines.push(`> ${clean(th.anchor_context.excerpt)}`);
    lines.push(`- comment_id: ${th.root.id}`);
    lines.push(
      `- ${clean(th.root.author_name)} (${th.root.author_actor_type}) at ${th.root.created_at}:`
    );
    lines.push(indentBody(clean(th.root.body)));
    for (const r of th.replies) {
      lines.push(
        `- reply ${r.id} — ${clean(r.author_name)} (${r.author_actor_type}) at ${r.created_at}:`
      );
      lines.push(indentBody(clean(r.body)));
    }
  }
  if (t.threads.length === 0) {
    lines.push('');
    lines.push('(no threads yet)');
  }
  if (t.dispositions.finding_states.length > 0) {
    lines.push('');
    lines.push('## Finding dispositions');
    for (const f of t.dispositions.finding_states) {
      lines.push(`- ${f.finding_key}: ${f.state}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** `orcaops review pull [--task N | --pr <id>] [--out <file>]` */
export async function reviewFeedbackPullAction(
  opts: { task?: string; pr?: string; out?: string; baseUrl?: string; json?: boolean } = {}
): Promise<void> {
  try {
    let taskNumber: number | null = null;
    if (opts.task !== undefined) {
      taskNumber = parseDigitInt(opts.task) ?? NaN;
      if (!Number.isInteger(taskNumber) || taskNumber < 1) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--task must be a positive integer (got "${opts.task}").`,
          'review-pull'
        );
      }
    }
    const { transcript, markdown } = await withReviewCloud(
      {
        baseUrl: opts.baseUrl,
        requires: [],
        operation: 'review pull',
      },
      async (ctx) => {
        const t = await runReviewFeedbackPull({
          client: ctx.client,
          taskNumber,
          pullRequestId: opts.pr ?? null,
        });
        const transcriptJson = JSON.stringify(t);
        await writeReviewFeedbackPullRecord(
          reviewFeedbackCacheDir(ctx.repoRoot),
          {
            schema_version: 1,
            pull_request_id: t.subject.pull_request_id,
            task_number: t.subject.task_number,
            activity_cursor: t.activity.last_human_activity_at,
            transcript_json: transcriptJson,
            content_hash: sha256Hex(transcriptJson),
            base_url: ctx.baseUrl,
            org_id: ctx.orgId,
            pulled_at: new Date().toISOString(),
          },
          ctx.repoRoot
        );
        return { transcript: t, markdown: renderTranscriptMarkdown(t) };
      }
    );
    if (opts.out) await writeFile(opts.out, markdown, 'utf8');
    if (opts.json) {
      emitOk(transcript);
      return;
    }
    writePipeFriendlyStdout(markdown);
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
