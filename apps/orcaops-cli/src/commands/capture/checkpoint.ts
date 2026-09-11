import {
  buildDefaultSkippedSnapshotBoundary,
  CaptureCheckpointAbandonInputSchema,
  CaptureCheckpointCloseInputSchema,
  CaptureCheckpointOpenInputSchema,
  type CheckpointAbandonWriteResult,
  type CheckpointCloseWriteResult,
  type CheckpointOpenWriteResult,
  resolveCaptureExcludes,
} from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { ErrorCodes, InfoCodes, OrcaopsError } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { captureFailure } from '../../lib/canonical-capture-outcome.js';
import { prepareCheckpointOpenEvaluators } from '../../lib/canonical-checkpoint-evaluators.js';
import { prepareCheckpointFingerprint } from '../../lib/canonical-checkpoint-fingerprint.js';
import {
  attributionDegradedWarnings,
  captureExcludeInvalidWarning,
  captureExcludeProbeFailedWarning,
  emptyDiffWindowWarning,
  extractAbandonReplayShape,
  extractCloseReplayShape,
  extractOpenReplayShape,
  makeSkippedCloseResult,
  snapshotCaptureFailedWarning,
  type SnapshotCaptureFailure,
  toBoundary,
  unmergedPathsDegradedWarning,
  unmergedProbeFailedWarning,
  windowOverlapWarnings,
} from '../../lib/canonical-checkpoint-shapes.js';
import { toSecretWarningReports } from '../../lib/cloud-secret-gate.js';
import {
  publishDatabaseCaptureAttempts,
  retainedAttemptBlocks,
} from '../../lib/database-capture-attempts.js';
import {
  openDatabaseCaptureWriter,
  prepareDatabaseCapture,
  type PreparedDatabaseCapture,
  selectDatabaseCaptureArtifact,
} from '../../lib/database-capture-context.js';
import { appendDatabaseCaptureEvents } from '../../lib/database-capture-events.js';
import {
  isStaleCaptureRefusal,
  replayCaptureRefusal,
  retainStaleCaptureRefusal,
  STALE_CAPTURE_REFUSAL,
} from '../../lib/database-capture-refusal.js';
import {
  databaseCaptureNextActions,
  translateDatabaseCaptureError,
} from '../../lib/database-capture-response.js';
import { syncDatabaseCapture } from '../../lib/database-capture-sync.js';
import { readDatabaseCheckpointOverlapSiblings } from '../../lib/database-checkpoint-overlap.js';
import {
  checkpointOperationIds,
  type CheckpointSnapshotPublication,
  prepareDatabaseCheckpointSnapshot,
  publishDatabaseCheckpointCapture,
  resolveDatabaseCloseCheckpoint,
  resumeDatabaseCheckpointCapture,
} from '../../lib/database-checkpoint.js';
import {
  databaseEvaluatorContext,
  publishDatabaseLifecycleCompletion,
  readDatabaseLifecycleCompletion,
  runDatabaseLifecycleEvaluators,
} from '../../lib/database-evaluators.js';
import { stampDatabaseUsage } from '../../lib/database-usage-stamp.js';
import { closeFailedHistoryRead } from '../../lib/history-reader-close.js';
import { getInvocationCwd, getInvocationEnv } from '../../lib/invocation-context.js';
import { runCapture } from '../../lib/run-capture.js';
import { lifecycleUsageStamp, usageStampKey } from '../../lib/usage-stamp.js';

export interface CaptureCheckpointOptions {
  input?: string;
  noLlm?: boolean;
}

/**
 * One writer, one artifact selection, one receipt lookup and one interrupted-capture
 * resume for each of the three checkpoint verbs. The resume runs before any preparation,
 * so a capture that admitted its boundary but never created the ref finishes as its
 * original operation. A capture prepared against a revision another writer has since
 * advanced can never finish that way: its admission is retired and the refusal retained,
 * and any later call under the same key returns that receipt instead of resuming a
 * request whose precondition is permanently unsatisfiable.
 */
async function withCheckpointCapture<TRaw, T>(
  prepared: PreparedDatabaseCapture<TRaw, TRaw & { artifact_id?: string }>,
  family: 'checkpoint_opened' | 'checkpoint_closed' | 'checkpoint_abandoned',
  idempotencyKey: string,
  signal: AbortSignal,
  body: (scope: {
    writer: Awaited<ReturnType<typeof openDatabaseCaptureWriter>>;
    artifactId: string;
    operationId: string;
    admissionOperationId: string;
    options: { signal: AbortSignal };
  }) => Promise<T>
): Promise<T> {
  const { context, input } = prepared;
  try {
    const writer = await openDatabaseCaptureWriter(context);
    let failed = false;
    try {
      const { artifactId } = selectDatabaseCaptureArtifact(writer, {
        explicitId: input.artifact_id,
        branch: context.registered.git.branch,
      });
      const ids = checkpointOperationIds(artifactId, idempotencyKey, family);
      const options = { signal };
      replayCaptureRefusal(writer, {
        artifactId,
        eventType: family,
        idempotencyKey,
        replayPayload: input,
      });
      await resumeDatabaseCheckpointCapture(writer, context, ids.operationId, options);
      try {
        return await body({ writer, artifactId, ...ids, options });
      } catch (cause) {
        if (!isStaleCaptureRefusal(cause)) throw cause;
        await retainStaleCaptureRefusal(writer, context, {
          artifactId,
          eventType: family,
          idempotencyKey,
          replayPayload: input,
          operationId: ids.operationId,
          command: 'capture checkpoint',
          options,
        });
        throw new ProjectDatabaseError('STALE_CONTEXT', STALE_CAPTURE_REFUSAL);
      }
    } catch (cause) {
      failed = true;
      closeFailedHistoryRead(writer);
      throw cause;
    } finally {
      if (!failed) writer.close();
    }
  } finally {
    context.close();
  }
}

function requireHeadSha(headOid: string | null): string {
  if (!headOid)
    throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'Checkpoint capture requires a Git commit');
  return headOid;
}

async function captureCheckpointOpen(opts: CaptureCheckpointOptions, signal: AbortSignal) {
  const prepared = await prepareDatabaseCapture({
    parse: async () =>
      CaptureCheckpointOpenInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    signal,
  });
  const { context, input } = prepared;
  return withCheckpointCapture(
    prepared,
    'checkpoint_opened',
    input.idempotency_key,
    signal,
    async ({ writer, artifactId, operationId, admissionOperationId, options }) => {
      const headSha = requireHeadSha(context.registered.git.headOid);
      const failures: SnapshotCaptureFailure[] = [];
      const degraded = { paths: [] as string[], probeFailed: false, excludeProbeFailed: false };
      const retained: { publication: CheckpointSnapshotPublication | null } = {
        publication: null,
      };
      const appended = await appendDatabaseCaptureEvents<CheckpointOpenWriteResult>({
        handle: writer,
        binding: context.binding,
        artifactId,
        operationId,
        authoredPayload: { kind: 'checkpoint_open', input },
        secretAllow: context.config.redact.allow,
        explicitTarget: input.artifact_id !== undefined,
        operation: 'task',
        idempotencyBlocks: retainedAttemptBlocks(writer, artifactId),
        options,
        settleAttempts: (changes, before) =>
          publishDatabaseCaptureAttempts(
            writer,
            {
              artifactId,
              artifactRevision: before.revision,
              changes,
              command: 'capture checkpoint open',
              secretAllow: context.config.redact.allow,
            },
            options
          ),
        publish: (capture, events) => {
          const event = events.find((entry) => entry.record.type === 'checkpoint_opened');
          if (!event)
            throw new OrcaopsError(
              ErrorCodes.INVALID_INPUT,
              'A retained checkpoint boundary requires its original checkpoint event'
            );
          return publishDatabaseCheckpointCapture(
            writer,
            context,
            {
              eventId: event.record.event_id,
              admissionOperationId,
              publication: retained.publication,
              createdAt: event.record.ts,
            },
            options
          )(capture);
        },
        evaluate: async (semantics, thread) =>
          semantics.writeCheckpointOpened(
            {
              artifact_id: artifactId,
              declared_step_ids: input.declared_step_ids,
              agent_session_id: input.agent_session_id,
              policy_exceptions: input.policy_exceptions,
              plan_revision_id: input.plan_revision_id ?? null,
            },
            {
              idempotencyKey: input.idempotency_key,
              invokedByAgent: context.invokingAgent.agent,
              replayPayload: {
                artifact_id: artifactId,
                declared_step_ids: input.declared_step_ids,
                agent_session_id: input.agent_session_id,
                policy_exceptions: input.policy_exceptions,
                plan_revision_id: input.plan_revision_id ?? null,
              },
              extractReplayShape: (priorPayload) => extractOpenReplayShape(priorPayload),
              headSha,
              evaluatorContext: () =>
                prepareCheckpointOpenEvaluators({
                  ctx: databaseEvaluatorContext(context, thread),
                  artifactId,
                  declaredStepIds: input.declared_step_ids,
                  policyExceptions: input.policy_exceptions,
                  noLlm: opts.noLlm,
                  env: getInvocationEnv(),
                }),
              snapshotCallbacks: {
                captureOpenSnapshot: async ({ artifact_id, n }) => {
                  if (!context.config.diff_fingerprint.enabled)
                    return { boundary: buildDefaultSkippedSnapshotBoundary() };
                  const captured = await prepareDatabaseCheckpointSnapshot(
                    context,
                    {
                      artifactId: artifact_id,
                      n,
                      phase: 'open',
                      authoredPayloads: [{ declared_step_ids: input.declared_step_ids }],
                    },
                    options
                  );
                  retained.publication = captured.publication;
                  const mapped = toBoundary(captured.snapshot);
                  if (mapped.failure !== undefined) failures.push(mapped.failure);
                  const snap = captured.snapshot;
                  if (snap.ok) {
                    degraded.paths.push(...snap.unmerged_paths);
                    degraded.probeFailed = snap.unmerged_probe_failed === true;
                    degraded.excludeProbeFailed = snap.exclusion_probe_failed === true;
                  }
                  return {
                    boundary: mapped.boundary,
                    ...(snap.ok && snap.unmerged_paths.length > 0
                      ? { unmerged_paths: [...snap.unmerged_paths] }
                      : {}),
                    ...(snap.ok && snap.unmerged_probe_failed === true
                      ? { unmerged_probe_failed: true }
                      : {}),
                  };
                },
              },
            }
          ),
      });
      const result = appended.value;
      if (result.outcome === 'conflict')
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior open with a different payload. Use a fresh key.`,
          'idempotency_key'
        );
      if (result.outcome === 'blocked') return result.envelope as Record<string, unknown>;
      const n = result.checkpoint.n;
      const key = { firesAt: 'checkpoint-open' as const, cpN: n };
      const lifecycle = readDatabaseLifecycleCompletion(writer, artifactId, key)
        ? { state: 'replayed' as const }
        : await publishDatabaseLifecycleCompletion(
            writer,
            {
              artifactId,
              key,
              triggeredAt: new Date().toISOString(),
              command: 'capture checkpoint open',
              secretAllow: context.config.redact.allow,
              mode: 'once',
            },
            options
          ).then(
            (published) => ({ state: published.state }),
            (cause: unknown) => ({ state: 'failed' as const, error: captureFailure(cause) })
          );
      if (result.outcome === 'replay')
        return {
          artifact_id: artifactId,
          n,
          status: 'open' as const,
          declared_step_ids: result.checkpoint.declared_step_ids,
          idempotency_status: 'replay' as const,
          code: InfoCodes.IDEMPOTENT_REPLAY,
          message: `Returning prior open cp for idempotency_key="${input.idempotency_key}".`,
          operation_id: operationId,
          capture_status: 'committed' as const,
          lifecycle,
          usage: { state: 'skipped' as const, reason: 'replay' as const },
          cloud_sync: await syncDatabaseCapture(context, writer, artifactId, {
            ...options,
            replayed: true,
          }),
          next_actions: await databaseCaptureNextActions(context, writer, artifactId),
        };
      const invalidExcludes = resolveCaptureExcludes(context.config.capture).invalid;
      const warnings = [
        ...(invalidExcludes.length > 0 ? [captureExcludeInvalidWarning(invalidExcludes)] : []),
        ...failures.map((failure) => snapshotCaptureFailedWarning(n, failure)),
        ...(degraded.paths.length > 0
          ? [unmergedPathsDegradedWarning(n, 'open', degraded.paths)]
          : []),
        ...(degraded.probeFailed ? [unmergedProbeFailedWarning(n, 'open')] : []),
        ...(degraded.excludeProbeFailed ? [captureExcludeProbeFailedWarning(n, 'open')] : []),
      ];
      const usage = await stampDatabaseUsage(
        writer,
        {
          descriptor: {
            lifecycle_event: 'checkpoint_open',
            artifactId,
            checkpoint_n: n,
            baselineHint: 'prior_same_artifact',
            asOf: result.checkpoint.opened_at,
            stableEventId: usageStampKey(artifactId, 'checkpoint_open', n),
          },
          invokingAgent: context.invokingAgent.agent,
          env: context.env,
          cwd: getInvocationCwd(),
          secretAllow: context.config.redact.allow,
        },
        options
      );
      const secretWarnings = toSecretWarningReports(prepared.secretWarnings);
      return {
        artifact_id: artifactId,
        n,
        status: 'open' as const,
        declared_step_ids: result.checkpoint.declared_step_ids,
        agent_session_id: result.checkpoint.agent_session_id,
        policy_exceptions: result.checkpoint.policy_exceptions,
        opened_at: result.checkpoint.opened_at,
        idempotency_status: 'created' as const,
        operation_id: operationId,
        capture_status: 'committed' as const,
        snapshot_ref: retained.publication?.fullRef ?? null,
        lifecycle,
        usage,
        cloud_sync: await syncDatabaseCapture(context, writer, artifactId, {
          ...options,
          replayed: false,
        }),
        next_actions: await databaseCaptureNextActions(context, writer, artifactId),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(secretWarnings.length ? { secret_warnings: secretWarnings } : {}),
      };
    }
  );
}

async function captureCheckpointClose(opts: CaptureCheckpointOptions, signal: AbortSignal) {
  const prepared = await prepareDatabaseCapture({
    parse: async () =>
      CaptureCheckpointCloseInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    signal,
  });
  const { context, input } = prepared;
  return withCheckpointCapture(
    prepared,
    'checkpoint_closed',
    input.idempotency_key,
    signal,
    async ({ writer, artifactId, operationId, admissionOperationId, options }) => {
      const headSha = requireHeadSha(context.registered.git.headOid);
      const failures: SnapshotCaptureFailure[] = [];
      let fenceEmpty = false;
      let excludeProbeFailed = false;
      const retained: { publication: CheckpointSnapshotPublication | null } = {
        publication: null,
      };
      const closedAt = new Date().toISOString();
      const appended = await appendDatabaseCaptureEvents<CheckpointCloseWriteResult>({
        handle: writer,
        binding: context.binding,
        artifactId,
        operationId,
        authoredPayload: { kind: 'checkpoint_close', input },
        secretAllow: context.config.redact.allow,
        explicitTarget: input.artifact_id !== undefined,
        operation: 'task',
        options,
        idempotencyBlocks: retainedAttemptBlocks(writer, artifactId),
        settleAttempts: (changes, before) =>
          publishDatabaseCaptureAttempts(
            writer,
            {
              artifactId,
              artifactRevision: before.revision,
              changes,
              command: 'capture checkpoint close',
              secretAllow: context.config.redact.allow,
            },
            options
          ),
        publish: (capture, events) => {
          const event = events.find((entry) => entry.record.type === 'checkpoint_closed');
          if (!event)
            throw new OrcaopsError(
              ErrorCodes.INVALID_INPUT,
              'A retained checkpoint boundary requires its original checkpoint event'
            );
          return publishDatabaseCheckpointCapture(
            writer,
            context,
            {
              eventId: event.record.event_id,
              admissionOperationId,
              publication: retained.publication,
              createdAt: event.record.ts,
            },
            options
          )(capture);
        },
        evaluate: async (semantics, thread) => {
          const n = resolveDatabaseCloseCheckpoint(thread, {
            explicitN: input.n,
            idempotencyKey: input.idempotency_key,
            artifactId,
          });
          const checkpoint = thread.checkpoints.find((entry) => entry.n === n);
          const crossArtifactSiblings =
            checkpoint?.status === 'open' &&
            Date.parse(checkpoint.opened_at) <= Date.parse(closedAt)
              ? readDatabaseCheckpointOverlapSiblings(writer, {
                  artifactId,
                  worktreeId: context.binding.worktree_id,
                  windowStart: checkpoint.opened_at,
                  windowEnd: closedAt,
                })
              : [];
          return semantics.writeCheckpointClosed(
            {
              artifact_id: artifactId,
              n,
              summary: input.summary,
              files_changed: input.files_changed,
              decisions: input.decisions,
              uncertainty: input.uncertainty,
              done_criteria: input.done_criteria,
              verification: input.verification,
              completed_step_ids: input.completed_step_ids,
              head_sha: headSha,
            },
            {
              idempotencyKey: input.idempotency_key,
              invokedByAgent: context.invokingAgent.agent,
              closedAt,
              crossArtifactSiblings,
              replayPayload: {
                artifact_id: artifactId,
                n,
                summary: input.summary,
                files_changed: input.files_changed,
                decisions: input.decisions,
                uncertainty: input.uncertainty,
                done_criteria: input.done_criteria,
                ...(input.verification.length > 0 ? { verification: input.verification } : {}),
                completed_step_ids: input.completed_step_ids,
              },
              extractReplayShape: (priorPayload) => extractCloseReplayShape(priorPayload),
              snapshotCallbacks: {
                captureCloseFingerprint: async ({
                  openCheckpoint,
                  closeContext,
                  recovery,
                  overlap,
                }) => {
                  const cap = context.config.diff_fingerprint;
                  if (!cap.enabled) return makeSkippedCloseResult(null);
                  const captured = await prepareDatabaseCheckpointSnapshot(
                    context,
                    {
                      artifactId: closeContext.artifact_id,
                      n: closeContext.n,
                      phase: 'close',
                      authoredPayloads: [{ files_changed: input.files_changed }],
                    },
                    options
                  );
                  retained.publication = captured.publication;
                  const closeSnap = captured.snapshot;
                  excludeProbeFailed = closeSnap.ok && closeSnap.exclusion_probe_failed === true;
                  const failure = toBoundary(closeSnap).failure;
                  if (failure !== undefined) failures.push(failure);
                  fenceEmpty =
                    closeSnap.ok &&
                    openCheckpoint.open_snapshot.tree_sha !== null &&
                    openCheckpoint.open_snapshot.tree_sha === closeSnap.tree_sha;
                  return prepareCheckpointFingerprint({
                    repo: context.repo,
                    cap,
                    closeSnap,
                    openCheckpoint,
                    closeContext,
                    recovery,
                    overlap,
                  });
                },
              },
            }
          );
        },
      });
      const result = appended.value;
      if (result.outcome === 'conflict')
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior close with a different payload. Use a fresh key.`,
          'idempotency_key'
        );
      const checkpoint = result.checkpoint;
      const replayed = result.outcome === 'replay';
      const key = { firesAt: 'checkpoint-close' as const, cpN: checkpoint.n };
      const completed = readDatabaseLifecycleCompletion(writer, artifactId, key) !== null;
      let evaluated: Awaited<ReturnType<typeof runDatabaseLifecycleEvaluators>> | null = null;
      let lifecycle: { state: string; error?: ReturnType<typeof captureFailure> } = {
        state: 'replayed',
      };
      if (!completed) {
        try {
          evaluated = await runDatabaseLifecycleEvaluators({
            context,
            handle: writer,
            artifactId,
            firesAt: 'checkpoint-close',
            checkpointN: checkpoint.n,
            noLlm: opts.noLlm,
            explicitTarget: input.artifact_id !== undefined,
            options,
          });
          await publishDatabaseLifecycleCompletion(
            writer,
            {
              artifactId,
              key,
              triggeredAt: new Date().toISOString(),
              command: 'capture checkpoint close',
              secretAllow: context.config.redact.allow,
              mode: 'once',
            },
            options
          );
          lifecycle = { state: 'complete' };
        } catch (cause) {
          lifecycle = { state: 'failed', error: captureFailure(cause) };
        }
      }
      const replayFenceEmpty =
        replayed &&
        checkpoint.open_snapshot.tree_sha !== null &&
        checkpoint.close_snapshot.tree_sha !== null &&
        checkpoint.open_snapshot.tree_sha === checkpoint.close_snapshot.tree_sha;
      const warnings = [
        ...failures.map((failure) => snapshotCaptureFailedWarning(checkpoint.n, failure)),
        ...attributionDegradedWarnings(checkpoint.n, checkpoint.attribution_degraded),
        ...((replayed ? replayFenceEmpty : fenceEmpty) &&
        (replayed ? checkpoint.files_changed.length : input.files_changed.length) > 0
          ? [emptyDiffWindowWarning(checkpoint.n)]
          : []),
        ...windowOverlapWarnings(checkpoint.n, checkpoint.window_overlap),
        ...(excludeProbeFailed ? [captureExcludeProbeFailedWarning(checkpoint.n, 'close')] : []),
      ];
      const usage = replayed
        ? { state: 'skipped' as const, reason: 'replay' as const }
        : await stampDatabaseUsage(
            writer,
            {
              descriptor: {
                lifecycle_event: 'checkpoint_close',
                artifactId,
                checkpoint_n: checkpoint.n,
                baselineHint: 'checkpoint_open',
                asOf: checkpoint.closed_at,
                stableEventId: usageStampKey(artifactId, 'checkpoint_close', checkpoint.n),
              },
              invokingAgent: context.invokingAgent.agent,
              env: context.env,
              cwd: getInvocationCwd(),
              secretAllow: context.config.redact.allow,
            },
            options
          );
      const secretWarnings = toSecretWarningReports(prepared.secretWarnings);
      return {
        artifact_id: artifactId,
        n: checkpoint.n,
        status: 'closed' as const,
        idempotency_status: replayed ? ('replay' as const) : ('created' as const),
        ...(replayed
          ? {
              code: InfoCodes.IDEMPOTENT_REPLAY,
              message:
                `Returning prior closed cp for idempotency_key="${input.idempotency_key}"` +
                (lifecycle.state === 'complete'
                  ? '; missing post-event evaluator work was resumed.'
                  : '.'),
            }
          : {}),
        operation_id: operationId,
        capture_status: 'committed' as const,
        snapshot_ref: retained.publication?.fullRef ?? null,
        evaluator_results: evaluated?.evaluator_results ?? [],
        blocking: evaluated?.blocking ?? false,
        lifecycle,
        usage,
        cloud_sync: await syncDatabaseCapture(context, writer, artifactId, {
          ...options,
          replayed: replayed,
        }),
        next_actions: await databaseCaptureNextActions(context, writer, artifactId),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(secretWarnings.length ? { secret_warnings: secretWarnings } : {}),
      };
    }
  );
}

async function captureCheckpointAbandon(opts: CaptureCheckpointOptions, signal: AbortSignal) {
  const prepared = await prepareDatabaseCapture({
    parse: async () =>
      CaptureCheckpointAbandonInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    signal,
  });
  const { context, input } = prepared;
  return withCheckpointCapture(
    prepared,
    'checkpoint_abandoned',
    input.idempotency_key,
    signal,
    async ({ writer, artifactId, operationId, admissionOperationId, options }) => {
      const failures: SnapshotCaptureFailure[] = [];
      const degraded = { paths: [] as string[], probeFailed: false, excludeProbeFailed: false };
      const retained: { publication: CheckpointSnapshotPublication | null } = {
        publication: null,
      };
      const appended = await appendDatabaseCaptureEvents<CheckpointAbandonWriteResult>({
        handle: writer,
        binding: context.binding,
        artifactId,
        operationId,
        authoredPayload: { kind: 'checkpoint_abandon', input },
        secretAllow: context.config.redact.allow,
        explicitTarget: input.artifact_id !== undefined,
        operation: 'task',
        options,
        idempotencyBlocks: retainedAttemptBlocks(writer, artifactId),
        settleAttempts: (changes, before) =>
          publishDatabaseCaptureAttempts(
            writer,
            {
              artifactId,
              artifactRevision: before.revision,
              changes,
              command: 'capture checkpoint abandon',
              secretAllow: context.config.redact.allow,
            },
            options
          ),
        publish: (capture, events) => {
          const event = events.find((entry) => entry.record.type === 'checkpoint_abandoned');
          if (!event)
            throw new OrcaopsError(
              ErrorCodes.INVALID_INPUT,
              'A retained checkpoint boundary requires its original checkpoint event'
            );
          return publishDatabaseCheckpointCapture(
            writer,
            context,
            {
              eventId: event.record.event_id,
              admissionOperationId,
              publication: retained.publication,
              createdAt: event.record.ts,
            },
            options
          )(capture);
        },
        evaluate: async (semantics) =>
          semantics.writeCheckpointAbandoned(
            { artifact_id: artifactId, n: input.n, reason: input.reason },
            {
              idempotencyKey: input.idempotency_key,
              invokedByAgent: context.invokingAgent.agent,
              replayPayload: { artifact_id: artifactId, n: input.n, reason: input.reason },
              extractReplayShape: (priorPayload) => extractAbandonReplayShape(priorPayload),
              snapshotCallbacks: {
                captureAbandonSnapshot: async ({ artifact_id, n }) => {
                  if (!context.config.diff_fingerprint.enabled)
                    return { boundary: buildDefaultSkippedSnapshotBoundary() };
                  const captured = await prepareDatabaseCheckpointSnapshot(
                    context,
                    {
                      artifactId: artifact_id,
                      n,
                      phase: 'abandon',
                      authoredPayloads: [{ reason: input.reason }],
                    },
                    options
                  );
                  retained.publication = captured.publication;
                  const mapped = toBoundary(captured.snapshot);
                  if (mapped.failure !== undefined) failures.push(mapped.failure);
                  const snap = captured.snapshot;
                  if (snap.ok) {
                    degraded.paths.push(...snap.unmerged_paths);
                    degraded.probeFailed = snap.unmerged_probe_failed === true;
                    degraded.excludeProbeFailed = snap.exclusion_probe_failed === true;
                  }
                  return { boundary: mapped.boundary };
                },
              },
            }
          ),
      });
      const result = appended.value;
      if (result.outcome === 'conflict')
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior abandon with a different payload. Use a fresh key.`,
          'idempotency_key'
        );
      const replayed = result.outcome === 'replay';
      const checkpoint = result.checkpoint;
      const warnings = [
        ...failures.map((failure) => snapshotCaptureFailedWarning(input.n, failure)),
        ...(degraded.paths.length > 0
          ? [unmergedPathsDegradedWarning(input.n, 'abandon', degraded.paths)]
          : []),
        ...(degraded.probeFailed ? [unmergedProbeFailedWarning(input.n, 'abandon')] : []),
        ...(degraded.excludeProbeFailed
          ? [captureExcludeProbeFailedWarning(input.n, 'abandon')]
          : []),
      ];
      const usage = replayed
        ? { state: 'skipped' as const, reason: 'replay' as const }
        : await stampDatabaseUsage(
            writer,
            {
              descriptor: lifecycleUsageStamp({
                event: 'checkpoint_abandon',
                artifactId,
                baselineHint: 'checkpoint_open',
                checkpoint_n: input.n,
                asOf: checkpoint.abandoned_at,
                discriminator: input.n,
              }),
              invokingAgent: context.invokingAgent.agent,
              env: context.env,
              cwd: getInvocationCwd(),
              secretAllow: context.config.redact.allow,
            },
            options
          );
      const secretWarnings = toSecretWarningReports(prepared.secretWarnings);
      return {
        artifact_id: artifactId,
        n: checkpoint.n,
        status: 'abandoned' as const,
        reason: checkpoint.reason,
        abandoned_at: checkpoint.abandoned_at,
        idempotency_status: replayed ? ('replay' as const) : ('created' as const),
        ...(replayed
          ? {
              code: InfoCodes.IDEMPOTENT_REPLAY,
              message: `Returning prior abandoned cp for idempotency_key="${input.idempotency_key}".`,
            }
          : {}),
        operation_id: operationId,
        capture_status: 'committed' as const,
        snapshot_ref: retained.publication?.fullRef ?? null,
        usage,
        cloud_sync: await syncDatabaseCapture(context, writer, artifactId, {
          ...options,
          replayed: replayed,
        }),
        next_actions: await databaseCaptureNextActions(context, writer, artifactId),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(secretWarnings.length ? { secret_warnings: secretWarnings } : {}),
      };
    }
  );
}

function runCheckpointVerb<T extends Record<string, unknown>>(
  verb: (opts: CaptureCheckpointOptions, signal: AbortSignal) => Promise<T>,
  opts: CaptureCheckpointOptions
): Promise<void> {
  return runCapture(async () => {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    try {
      return await verb(opts, controller.signal);
    } catch (cause) {
      throw translateDatabaseCaptureError(cause);
    } finally {
      process.off('SIGINT', interrupt);
    }
  });
}

export async function captureCheckpointOpenAction(
  opts: CaptureCheckpointOptions = {}
): Promise<void> {
  await runCheckpointVerb(captureCheckpointOpen, opts);
}

export async function captureCheckpointCloseAction(
  opts: CaptureCheckpointOptions = {}
): Promise<void> {
  await runCheckpointVerb(captureCheckpointClose, opts);
}

export async function captureCheckpointAbandonAction(
  opts: CaptureCheckpointOptions = {}
): Promise<void> {
  await runCheckpointVerb(captureCheckpointAbandon, opts);
}
