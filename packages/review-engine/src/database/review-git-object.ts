import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  prepareDatabaseGitClosure,
  prepareDatabaseSnapshot,
  type RegisteredDatabaseContext,
} from '@orcaops/core/history/database-retention';
import { type DatabaseJson, ProjectDatabaseError } from '@orcaops/storage/history/database';

import { cancelled, invalid, scanMetadata } from './request.js';

const exec = promisify(execFile);

export async function prepareReviewGitObject(
  context: RegisteredDatabaseContext,
  input: {
    reviewId: string;
    oid: string;
    recordedAt: string;
    role: 'floor' | 'base';
    authoredPayloads: DatabaseJson[];
    secretAllow: string[];
  },
  signal?: AbortSignal
) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.oid))
    invalid('Retain the exact original review object ID');
  scanMetadata(input, input.secretAllow);
  cancelled(signal);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  let kind: string;
  try {
    kind = (
      await exec('git', ['cat-file', '-t', input.oid], {
        cwd: context.git.worktreeRoot,
        env,
        signal,
        timeout: 120_000,
        maxBuffer: 4096,
        killSignal: 'SIGKILL',
      })
    ).stdout.trim();
  } catch (cause) {
    cancelled(signal);
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'The original review object is unavailable; restore its local Git objects before retrying',
      { cause }
    );
  }
  cancelled(signal);
  if (kind === 'commit' && input.role === 'base')
    return prepareDatabaseGitClosure(context, input.oid, { signal });
  if (kind !== 'tree')
    invalid(
      'A review floor requires its exact tree; a review base requires its original commit or tree'
    );
  const snapshot = await prepareDatabaseSnapshot(
    context,
    {
      label: input.role === 'floor' ? 'Retain review floor' : 'Retain review base',
      source: {
        kind: 'review-pin',
        treeOid: input.oid,
        reviewId: input.reviewId,
        generatedAt: input.recordedAt,
        role: input.role,
      },
      authoredPayloads: input.authoredPayloads,
      secretAllow: input.secretAllow,
    },
    { signal }
  );
  cancelled(signal);
  if (!snapshot.ok)
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'The original review tree could not be retained; inspect local Git objects before retrying'
    );
  return {
    objectOid: snapshot.commit_sha,
    treeOid: snapshot.tree_sha,
    objectFormat: snapshot.object_format,
  };
}
