import path from 'node:path';

import {
  HistoryScopeError,
  resolveDatabaseHistoryScope,
} from '@orcaops/project-scope/history/database';
import { uuidv7 } from '@orcaops/storage';
import { HistoryError } from '@orcaops/storage/history/authority';
import {
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';

import { writeReviewError, writeReviewOutput } from '../reviewFiles.js';
import {
  defaultReviewRuntimeDescriptor,
  observeReviewExecutableIdentity,
  type ReviewRuntimeDescriptor,
} from '../runtimeIdentity.js';
import { cancelled, integrity, invalid, stale, withReviewDatabase } from './request.js';
import { selectDatabaseReview } from './review-selection.js';
import { hydrateDatabaseReview, readDatabaseReview, snapshotDatabaseReview } from './reviews.js';
import { readDatabaseReviewRun } from './run-read.js';
import {
  parseSemanticCommand,
  readSemanticCommandSubmission,
  type SemanticCommandInput,
} from './semantic-command-input.js';
import {
  formatSemanticCommandOutput,
  semanticCommandOutputSchema,
} from './semantic-command-output.js';
import { readDatabaseSemanticOperation } from './semantic-operation.js';
import {
  type PublishDatabaseSemanticGeneration,
  publishDatabaseSemanticGeneration,
} from './semantic-publish.js';
import { readDatabaseSemanticGeneration } from './semantic-read.js';
import { closeDatabaseReviewScope } from './source-scope.js';

const usage =
  'usage: review semantic-anchor-submit (--review <uuid> | --branch <branch>) --run <run-id> --profile semantic-anchor-profile-v1 --input <file|-> [--project <uuid>] [--root <checkout>] [--generation <pending-generation>] [--operation-id <uuidv7>] [--json]\n';
type OriginalOperation = NonNullable<
  Awaited<ReturnType<typeof readDatabaseSemanticOperation>>['value']
>;
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'This operation identity belongs to different semantic content or selectors; retain the original request or explicitly choose a new operation'
  );
}
function failure(error: unknown) {
  if (
    error instanceof ProjectDatabaseError ||
    error instanceof HistoryScopeError ||
    error instanceof HistoryError
  )
    return {
      code: error.code,
      message: error.message,
      ...(error instanceof HistoryScopeError && error.context?.candidates
        ? { candidates: error.context.candidates, truncated: error.context.truncated }
        : {}),
    };
  return {
    code: 'HISTORY_INACCESSIBLE',
    message:
      'Semantic submission could not access its required input or history; preserve the original operation and inspect storage before retrying',
  };
}
async function authorityFor(input: SemanticCommandInput) {
  const scope = await resolveDatabaseHistoryScope({
    cwd: input.cwd,
    env: input.env,
    selector: input.projectId ? { projectId: input.projectId } : {},
    profile: 'exact',
  });
  let primary: unknown;
  try {
    const project = scope.projects[0];
    if (!scope.completeness.complete || !project?.database || !project.authority) {
      const issue = scope.completeness.issues[0];
      throw new HistoryScopeError(
        issue?.code ?? 'HISTORY_MISSING',
        issue?.message ??
          'Expected semantic project history is unavailable; preserve it for explicit repair',
        { issues: scope.completeness.issues }
      );
    }
    return { ...project.authority };
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    closeDatabaseReviewScope(scope, primary);
  }
}
async function selectedReview(authority: ProjectDatabaseAuthority, input: SemanticCommandInput) {
  return withReviewDatabase(authority, 'reader', (database) => {
    const snapshot = database.read((view) => {
      const reviewId = selectDatabaseReview(view, input, authority.projectId);
      return snapshotDatabaseReview(view, reviewId);
    });
    const review = hydrateDatabaseReview(authority, snapshot.value);
    if (!review)
      throw new HistoryScopeError(
        'REVIEW_NOT_FOUND',
        'The exact review is not retained in the selected project'
      );
    if (input.branch !== undefined && review.identity.initial_context.branch !== input.branch)
      throw new HistoryScopeError(
        'REVIEW_CONTEXT_MISMATCH',
        'The requested review differs from the original branch; select its exact original identity'
      );
    return review.identity.review_id;
  });
}
async function requireOriginal(
  authority: ProjectDatabaseAuthority,
  input: SemanticCommandInput,
  rawHash: string,
  original: OriginalOperation
) {
  if (
    (input.reviewId !== undefined && input.reviewId !== original.target.reviewId) ||
    input.runId !== original.target.runId ||
    input.profile !== original.payload.authored.profile ||
    rawHash !== original.payload.rawSubmissionSha256 ||
    (input.generationId === undefined
      ? original.payload.attempt.kind !== 'initial'
      : original.payload.attempt.kind !== 'repair' ||
        input.generationId !== original.target.generationId)
  )
    conflict();
  if (input.branch !== undefined) {
    const review = await readDatabaseReview({ authority, reviewId: original.target.reviewId });
    if (!review.value)
      integrity(
        'Original semantic review identity is missing; preserve the committed operation for explicit repair'
      );
    if (review.value.identity.initial_context.branch !== input.branch) conflict();
  }
}
async function historyFor(
  authority: ProjectDatabaseAuthority,
  original: OriginalOperation,
  signal?: AbortSignal
) {
  try {
    cancelled(signal);
    const history = await readDatabaseSemanticGeneration({ authority, ...original.target });
    cancelled(signal);
    const attempt = history.value?.attempts.find(
      (item) => item.revisionId === original.payload.attemptRevisionId
    );
    if (
      !attempt ||
      attempt.hash !== original.result.attemptSha256 ||
      attempt.operationId !== original.operationId
    )
      integrity(
        'The original semantic attempt history is missing or differs from its committed receipt; preserve history for explicit repair'
      );
    const model =
      original.result.modelPublicationId === null ? null : history.value?.terminal?.model;
    if (
      original.result.modelPublicationId !== null &&
      (!model || model.sha256 !== original.result.modelSha256)
    )
      integrity(
        'The original accepted semantic model is missing; preserve its exact publication for explicit repair'
      );
    return {
      status: 'AVAILABLE' as const,
      diagnostics: attempt.event.diagnostics,
      warnings: attempt.event.warnings,
      model: model ?? null,
      observed_counters: history.counters,
    };
  } catch (cause) {
    return {
      status: 'UNAVAILABLE' as const,
      ...failure(cause),
      recovery:
        'Recheck this exact operation after resolving the reported condition. Missing history requires explicit repair, never reinitialization; this read performs no repair.',
    };
  }
}
async function response(
  authority: ProjectDatabaseAuthority,
  original: OriginalOperation,
  replayed: boolean,
  signal?: AbortSignal
) {
  const history = await historyFor(authority, original, signal);
  return semanticCommandOutputSchema.parse({
    schema_version: 3 as const,
    ok: original.result.accepted && history.status === 'AVAILABLE',
    project_id: authority.projectId,
    review_id: original.target.reviewId,
    run_id: original.target.runId,
    operation_id: original.operationId,
    generation_id: original.target.generationId,
    attempt_revision_id: original.payload.attemptRevisionId,
    attempt: original.result.attemptNumber,
    accepted: original.result.accepted,
    status: original.result.status,
    replayed,
    receipt: {
      scope: 'ORIGINAL_OPERATION' as const,
      committed_counters: original.committedCounters,
      result: original.result,
    },
    history,
  });
}

export async function executeDatabaseSemanticCommand(
  argv: readonly string[],
  context: { env: NodeJS.ProcessEnv; cwd?: string; runtime?: ReviewRuntimeDescriptor },
  options: ProjectOperationOptions & {
    stdin?: NodeJS.ReadableStream;
    preparedBytes?: Uint8Array;
  } = {}
) {
  const invocationCwd = path.resolve(context.cwd ?? process.cwd());
  const input = parseSemanticCommand(argv, context.env, invocationCwd);
  const descriptor = { ...(context.runtime ?? defaultReviewRuntimeDescriptor()) };
  const runtime = {
    packageRoot: path.resolve(invocationCwd, descriptor.packageRoot),
    entrypointPath: path.resolve(invocationCwd, descriptor.entrypointPath),
  };
  const invocation = {
    signal: options.signal,
    onWait: options.onWait,
    stdin: options.stdin,
    preparedBytes: options.preparedBytes,
  };
  const startedAt = new Date().toISOString();
  const operationId = input.operationId ?? uuidv7();
  const submission = await readSemanticCommandSubmission(input, invocation);
  cancelled(invocation.signal);
  const authority = await authorityFor(input);
  cancelled(invocation.signal);
  const committed = await readDatabaseSemanticOperation({ authority, operationId });
  if (committed.value) {
    await requireOriginal(authority, input, submission.raw_sha256, committed.value);
    return response(authority, committed.value, true, invocation.signal);
  }
  const reviewId = await selectedReview(authority, input);
  const run = await readDatabaseReviewRun({ authority, reviewId, runId: input.runId });
  if (!run.value) invalid('Semantic submission requires the exact retained terminal run');
  if (run.value.selection.current_run_id !== input.runId)
    stale(
      'The requested semantic run is no longer selected; retain its original target and choose an explicitly new operation'
    );
  const selected = await readDatabaseSemanticGeneration({
    authority,
    reviewId,
    runId: input.runId,
    ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
  });
  let attempt: PublishDatabaseSemanticGeneration['attempt'] = { kind: 'initial' };
  if (input.generationId !== undefined) {
    const first = selected.value?.attempts[0];
    if (
      !first ||
      first.event.accepted ||
      selected.value?.attempts.length !== 1 ||
      selected.value.terminal !== null
    )
      stale('The exact generation is not awaiting its single repair; retain the original target');
    attempt = { kind: 'repair', firstRevisionId: first.revisionId, firstRecordSha256: first.hash };
  }
  cancelled(invocation.signal);
  const runtimeIdentity = await observeReviewExecutableIdentity(runtime, input.env);
  cancelled(invocation.signal);
  const request: PublishDatabaseSemanticGeneration = {
    authority,
    operationId,
    reviewId,
    runId: input.runId,
    generationId: input.generationId ?? uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
    secretAllow: [],
    submissionBytes: submission.bytes,
    expected: {
      revisionId: run.value.revisionId,
      version: run.value.version,
      runSelectionVersion: run.value.selection.run_selection_version,
      semanticGenerationId: selected.value?.current?.generation_id ?? null,
      semanticVersion: selected.value?.current?.version ?? 0,
    },
    authored: {
      profile: input.profile,
      startedAt,
      submittedAt: new Date().toISOString(),
      runtimeIdentity,
    },
    attempt,
  };
  let published: Awaited<ReturnType<typeof publishDatabaseSemanticGeneration>>;
  try {
    published = await publishDatabaseSemanticGeneration(request, invocation);
  } catch (cause) {
    if (!(cause instanceof ProjectDatabaseError) || cause.code !== 'IDEMPOTENCY_CONFLICT')
      throw cause;
    const winner = await readDatabaseSemanticOperation({ authority, operationId });
    if (!winner.value) throw cause;
    await requireOriginal(authority, input, submission.raw_sha256, winner.value);
    return response(authority, winner.value, true, invocation.signal);
  }
  const original: OriginalOperation = {
    operationId,
    target: { reviewId, runId: input.runId, generationId: request.generationId },
    expected: request.expected,
    payload: {
      attemptRevisionId: request.attemptRevisionId,
      modelPublicationId: request.modelPublicationId,
      rawSubmissionSha256: submission.raw_sha256,
      authored: request.authored,
      attempt: request.attempt,
    },
    result: published.value,
    committedCounters: published.counters,
  };
  return response(authority, original, published.replayed, invocation.signal);
}

export async function runDatabaseSemanticSubmit(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
  runtime?: ReviewRuntimeDescriptor
) {
  const args = [...argv];
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    writeReviewOutput(usage);
    return 0;
  }
  let operationId: string | undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  try {
    const input = parseSemanticCommand(args, env, path.resolve(cwd ?? process.cwd()));
    operationId = input.operationId ?? uuidv7();
    if (input.operationId === undefined) args.push('--operation-id', operationId);
    const result = await executeDatabaseSemanticCommand(
      args,
      { env, cwd, runtime },
      { signal: controller.signal }
    );
    writeReviewOutput(json ? `${JSON.stringify(result)}\n` : formatSemanticCommandOutput(result));
    return result.ok ? 0 : 1;
  } catch (cause) {
    const error = {
      ok: false,
      schema_version: 3,
      ...(operationId === undefined ? {} : { operation_id: operationId }),
      ...failure(cause),
    };
    if (json) writeReviewOutput(`${JSON.stringify(error)}\n`);
    else
      writeReviewError(
        `semantic submission${operationId === undefined ? '' : ` (operation ${operationId})`}: ${error.code}: ${error.message}\n${'candidates' in error ? `${JSON.stringify(error.candidates)}\n` : ''}`
      );
    return error.code === 'INVALID_INPUT' ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}
