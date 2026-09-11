import path from 'node:path';

import { HistoryScopeError } from '@orcaops/project-scope/history/database';
import { HistoryError } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { writeReviewError, writeReviewOutput } from '../reviewFiles.js';
import { type ReviewArgs } from '../run.js';
import { readDatabaseReviewContext } from './read-context.js';

const usage =
  'usage: review state health (--review <uuid> | --branch <branch>) [--project <uuid>] [--root <checkout>] [--json]\n';
const allowed = new Set([
  'cmd',
  'sub',
  'action',
  'json',
  'help',
  'projectId',
  'reviewId',
  'branch',
  'root',
]);

export async function runDatabaseReviewHealth(
  args: ReviewArgs,
  env: NodeJS.ProcessEnv,
  cwd?: string
): Promise<number> {
  if (args.help) {
    writeReviewOutput(usage);
    return 0;
  }
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    if (args.json)
      writeReviewOutput(
        `${JSON.stringify({ ok: false, schema_version: 3, code: 'INVALID_INPUT', message: usage.trim() })}\n`
      );
    else writeReviewError(usage);
    return 2;
  }
  const invocationCwd = path.resolve(cwd ?? process.cwd());
  const input = {
    projectId: args.projectId,
    reviewId: args.reviewId,
    branch: args.branch,
    cwd: path.resolve(invocationCwd, args.root ?? env.ORCAOPS_ROOT ?? '.'),
    env: { ...env },
  };
  const json = args.json;
  try {
    const context = await readDatabaseReviewContext(input);
    const states = [
      {
        kind: 'REVIEW_STATE',
        status: 'HEALTHY',
        resource: 'database',
        selection: context.selection,
      },
      {
        kind: 'FLOOR',
        status: context.floor === null ? 'ABSENT' : 'HEALTHY',
        resource: 'immutable-evidence',
        publication_id: context.floor?.publicationId ?? null,
        source_write_sequence: context.floor?.sourceWriteSequence ?? null,
      },
      {
        kind: 'STORY',
        status:
          context.story === null
            ? 'ABSENT'
            : context.storyMatchesSelectedFloor
              ? 'HEALTHY'
              : 'STALE',
        resource: 'immutable-evidence',
        publication_id: context.selection.story_publication_id,
        run_id: context.story?.runId ?? null,
        matches_selected_floor: context.storyMatchesSelectedFloor,
      },
      {
        kind: 'COMMENTS',
        status: 'HEALTHY',
        resource: 'database',
        count: context.comments.comments.length,
      },
      {
        kind: 'JOURNAL',
        status: 'HEALTHY',
        resource: 'database',
        sequence: context.workflow.sequence,
      },
    ];
    const result = {
      schema_version: 3,
      project_id: context.projectId,
      store_instance_id: context.authority.storeInstanceId,
      review_id: context.reviewId,
      branch: context.identity.initial_context.branch,
      status: context.storyMatchesSelectedFloor === false ? 'BLOCKED' : 'HEALTHY',
      states,
      counters: context.counters,
      repair: { behavior: 'Preserve retained history. This read does not repair or reset state.' },
    };
    writeReviewOutput(
      json
        ? `${JSON.stringify(result)}\n`
        : `review state ${result.status.toLowerCase()}: ${states.map((state) => `${state.kind}=${state.status}`).join(' · ')} (project ${result.project_id}, review ${result.review_id})\n`
    );
    return result.status === 'HEALTHY' ? 0 : 1;
  } catch (error) {
    const typed =
      error instanceof HistoryScopeError ||
      error instanceof ProjectDatabaseError ||
      error instanceof HistoryError;
    const code = typed ? error.code : 'HISTORY_INACCESSIBLE';
    const message = typed
      ? error.message
      : 'Review history could not be read; preserve it for explicit inspection';
    const context = error instanceof HistoryScopeError ? error.context : undefined;
    const failure = {
      ok: false,
      schema_version: 3,
      code,
      message,
      ...(context?.candidates === undefined ? {} : { candidates: context.candidates }),
      ...(context?.truncated === undefined ? {} : { truncated: context.truncated }),
    };
    if (json) writeReviewOutput(`${JSON.stringify(failure)}\n`);
    else
      writeReviewError(
        `review state: ${code}: ${message}\n${context?.candidates === undefined ? '' : `${JSON.stringify(context.candidates)}\n`}`
      );
    return code === 'INVALID_INPUT' ? 2 : 1;
  }
}
