import { z } from 'zod';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { copyDatabaseAuthoredValue, refuseDatabaseAuthoredSecrets } from '../authored-input.js';
import { retentionCancelled, retentionGitEnvironment } from './git-process.js';
import { prepareDatabaseGitClosure, requireOwnedDatabaseGitObjects } from './object-closure.js';
import { Repo } from '../../git/repo.js';
import {
  captureWorktreeTree,
  classifySnapshotFailure,
  runGit,
  type SnapshotFailureReason,
} from '../../git/snapshots.js';
import type { RegisteredDatabaseContext } from '../context/execution.js';

const oid = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .refine((value) => !/^0+$/.test(value));
const inputSchema = z.strictObject({
  label: z.string().min(1),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('worktree') }),
    z.strictObject({ kind: z.literal('tree'), treeOid: oid }),
    z.strictObject({
      kind: z.literal('review-pin'),
      treeOid: oid,
      reviewId: z.string().min(1),
      generatedAt: z.string().min(1),
      role: z.enum(['floor', 'base']),
    }),
  ]),
  excludePatterns: z.array(z.string()).optional(),
  authoredPayloads: z.array(z.json()),
  secretAllow: z.array(z.string()),
});
export type PrepareDatabaseSnapshot = z.infer<typeof inputSchema>;
export type PreparedDatabaseSnapshotResult =
  | {
      ok: true;
      tree_sha: string;
      commit_sha: string;
      object_format: 'sha1' | 'sha256';
      unmerged_paths: readonly string[];
      unmerged_probe_failed?: boolean;
      exclusion_probe_failed?: boolean;
    }
  | { ok: false; error_reason: SnapshotFailureReason; error_message?: string };

export async function prepareDatabaseSnapshot(
  expected: RegisteredDatabaseContext,
  raw: PrepareDatabaseSnapshot,
  options: { signal?: AbortSignal } = {}
): Promise<PreparedDatabaseSnapshotResult> {
  const authoredPayloads = copyDatabaseAuthoredValue(raw?.authoredPayloads, 'snapshot preparation');
  const parsed = inputSchema.safeParse({ ...raw, authoredPayloads });
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide explicit snapshot source, authored JSON and established secret allowances before preparing objects',
      { cause: parsed.error }
    );
  const input = parsed.data;
  const context = structuredClone(expected);
  const callerSignal = options.signal;
  refuseDatabaseAuthoredSecrets(
    { ...input, authoredPayloads, secretAllow: undefined },
    input.secretAllow,
    'snapshot preparation'
  );
  retentionCancelled(callerSignal);
  const deadline = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), 300_000);
  timer.unref();
  const checkLifetime = () => {
    retentionCancelled(callerSignal);
    if (deadline.signal.aborted)
      throw new Error(
        'Snapshot preparation exceeded its five-minute operation budget; inspect repository size and access before explicitly retrying'
      );
  };
  try {
    const owned = await requireOwnedDatabaseGitObjects(context, { signal });
    checkLifetime();
    let tree: {
      tree_sha: string;
      commit_sha: string;
      unmerged_paths: readonly string[];
      unmerged_probe_failed?: boolean;
      exclusion_probe_failed?: boolean;
    };
    if (input.source.kind === 'worktree') {
      const captured = await captureWorktreeTree(
        new Repo(owned.context.git.worktreeRoot),
        input.label,
        {
          durableObjects: true,
          commandTimeoutMs: 120_000,
          signal,
          excludePatterns: input.excludePatterns,
        }
      );
      checkLifetime();
      if (!captured.ok) return captured;
      tree = captured;
    } else {
      const cwd = owned.context.git.worktreeRoot;
      const inspected = await runGit(cwd, ['cat-file', '-t', input.source.treeOid], {
        env: retentionGitEnvironment(),
        commandTimeoutMs: 120_000,
        signal,
      });
      checkLifetime();
      if (inspected.code !== 0 || inspected.stdout.toString('utf8').trim() !== 'tree')
        return {
          ok: false,
          error_reason: 'unknown',
          error_message:
            'The exact inherited snapshot tree is unavailable; restore the original tree before explicitly retrying',
        };
      const review = input.source.kind === 'review-pin';
      const identity = review ? 'orcaops-review' : 'orcaops-snapshot';
      const env = {
        ...retentionGitEnvironment(),
        GIT_AUTHOR_NAME: identity,
        GIT_AUTHOR_EMAIL: 'orcaops@local',
        GIT_COMMITTER_NAME: identity,
        GIT_COMMITTER_EMAIL: 'orcaops@local',
        ...(review
          ? { GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' }
          : {}),
      };
      const message =
        input.source.kind === 'review-pin'
          ? `review-pin: ${input.source.reviewId}${input.source.role === 'base' ? '-base' : ''} ${input.source.generatedAt}`
          : `orcaops snapshot ${input.label}`;
      const created = await runGit(
        cwd,
        [
          '-c',
          'core.fsync=loose-object',
          '-c',
          'core.fsyncMethod=fsync',
          'commit-tree',
          input.source.treeOid,
          '-m',
          message,
        ],
        { env, commandTimeoutMs: 120_000, signal }
      );
      checkLifetime();
      if (created.code !== 0)
        return {
          ok: false,
          error_reason: classifySnapshotFailure(created.stderr),
          error_message: created.stderr.trim(),
        };
      tree = {
        tree_sha: input.source.treeOid,
        commit_sha: created.stdout.toString('utf8').trim(),
        unmerged_paths: [],
      };
    }
    const closure = await prepareDatabaseGitClosure(owned.context, tree.commit_sha, { signal });
    checkLifetime();
    if (closure.treeOid !== tree.tree_sha)
      throw new Error('Prepared tree identity changed before owned closure verification');
    return {
      ok: true,
      tree_sha: tree.tree_sha,
      commit_sha: tree.commit_sha,
      object_format: closure.objectFormat,
      unmerged_paths: [...tree.unmerged_paths],
      ...(tree.unmerged_probe_failed ? { unmerged_probe_failed: true } : {}),
      ...(tree.exclusion_probe_failed ? { exclusion_probe_failed: true } : {}),
    };
  } catch (cause) {
    retentionCancelled(callerSignal);
    if (
      cause instanceof ProjectDatabaseError &&
      !['HISTORY_INACCESSIBLE', 'CANCELLED'].includes(cause.code)
    )
      throw cause;
    return {
      ok: false,
      error_reason: 'unknown',
      error_message: deadline.signal.aborted
        ? 'Snapshot preparation exceeded its five-minute operation budget; inspect repository size and access before explicitly retrying'
        : cause instanceof Error
          ? cause.message
          : 'Snapshot object preparation is unavailable; inspect the original repository before explicitly retrying',
    };
  } finally {
    clearTimeout(timer);
  }
}
