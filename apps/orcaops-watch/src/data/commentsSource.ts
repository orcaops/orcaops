// UI-side comment loader/actions. Mirrors journalSource.ts: spawn the app's own
// Node sidecar (`review comments` / `review comment …`) so the locked appends
// and the re-anchor enrichment stay off the Bun UI. Every verb prints the fresh
// enriched payload to stdout — comments are human-authored and small, so stdout
// capture is safe. Renderer-free (the src/data rule).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CommentAnchor, MemberRef } from '@orcaops/review-core';
import type { CommentsPayload } from '@orcaops/review-engine';

import { resolveRoot } from './reviewSource';
import { resolveSidecar, sidecarMissingError } from './sidecarPath';

export type { CommentsPayload, EnrichedComment } from '@orcaops/review-engine';

const execFileAsync = promisify(execFile);

export interface CommentsSourceOptions {
  /** Repo root; when omitted, resolved from git-toplevel (like reviewSource). */
  root?: string;
  branch: string;
  env?: NodeJS.ProcessEnv;
  /** Node binary to run the sidecar under (default: `node` on PATH). */
  nodeBin?: string;
}

const ARCHIVE_WARNING_CODES = new Set<string>([
  'REVIEW_ARCHIVE_SETUP_FAILED',
  'REVIEW_ARCHIVE_WRITE_FAILED',
]);

export function parsePayload(text: string): CommentsPayload {
  const data = JSON.parse(text) as CommentsPayload;
  const warnings: unknown = (data as { warnings?: unknown } | null)?.warnings;
  if (
    data === null ||
    typeof data !== 'object' ||
    !Array.isArray(data.comments) ||
    (warnings !== undefined &&
      (!Array.isArray(warnings) ||
        warnings.some(
          (warning: unknown) =>
            warning === null ||
            typeof warning !== 'object' ||
            !ARCHIVE_WARNING_CODES.has(String((warning as { code?: unknown }).code)) ||
            typeof (warning as { message?: unknown }).message !== 'string'
        )))
  ) {
    throw new Error('unexpected review comments shape');
  }
  return data;
}

async function runVerb(opts: CommentsSourceOptions, argv: string[]): Promise<CommentsPayload> {
  const sidecar = resolveSidecar();
  if (sidecar === null) {
    throw sidecarMissingError();
  }
  const root = await resolveRoot(opts.root);
  const env = { ...(opts.env ?? process.env) };
  env.ORCAOPS_ROOT = root;
  const node = opts.nodeBin ?? env.ORCAOPS_WATCH_NODE ?? 'node';
  const { stdout } = await execFileAsync(node, [sidecar, 'review', ...argv, '--json'], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePayload(String(stdout));
}

/** Replay + re-anchor the branch's comments (empty log ⇒ empty payload). */
export function loadComments(opts: CommentsSourceOptions): Promise<CommentsPayload> {
  return runVerb(opts, ['comments', '--branch', opts.branch]);
}

/** Author a reviewer comment at a content anchor; returns the fresh payload. */
export function addComment(
  opts: CommentsSourceOptions,
  input: { body: string; anchor: CommentAnchor }
): Promise<CommentsPayload> {
  return runVerb(opts, [
    'comment',
    'add',
    '--branch',
    opts.branch,
    // The input travels as ONE JSON argv (execFile is shell-free — injection-safe).
    '--input',
    JSON.stringify(input),
  ]);
}

/** Reply to a comment (optionally resolving it in the same call). */
export function replyComment(
  opts: CommentsSourceOptions,
  input: {
    id: string;
    body: string;
    author?: 'reviewer' | 'agent';
    checkpoint_ref?: MemberRef;
    resolve?: boolean;
  }
): Promise<CommentsPayload> {
  const argv = [
    'comment',
    'reply',
    '--branch',
    opts.branch,
    '--id',
    input.id,
    '--input',
    JSON.stringify({
      body: input.body,
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(input.checkpoint_ref !== undefined ? { checkpoint_ref: input.checkpoint_ref } : {}),
    }),
  ];
  if (input.resolve === true) argv.push('--resolve');
  return runVerb(opts, argv);
}

/** Resolve a comment without replying. */
export function resolveComment(
  opts: CommentsSourceOptions,
  input: { id: string; author?: 'reviewer' | 'agent' }
): Promise<CommentsPayload> {
  const argv = ['comment', 'resolve', '--branch', opts.branch, '--id', input.id];
  if (input.author !== undefined) argv.push('--author', input.author);
  return runVerb(opts, argv);
}

/** Reopen a resolved comment without changing its durable id or anchor. */
export function reopenComment(
  opts: CommentsSourceOptions,
  input: { id: string; author?: 'reviewer' | 'agent' }
): Promise<CommentsPayload> {
  const argv = ['comment', 'reopen', '--branch', opts.branch, '--id', input.id];
  if (input.author !== undefined) argv.push('--author', input.author);
  return runVerb(opts, argv);
}
