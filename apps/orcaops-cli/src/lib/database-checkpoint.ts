import type { SnapshotPhase, SnapshotResult } from '@orcaops/core';
import {
  prepareDatabaseSnapshot,
  publishDatabaseCaptureRetention,
  resumeDatabaseCaptureRetention,
} from '@orcaops/core/history/database-capture';
import { type ArtifactThread, resolveCaptureExcludes, uuidv7 } from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  appendProjectExecutionCapture,
  type PendingCaptureInput,
  prepareProjectGitRetention,
  type ProjectDatabase,
  type ProjectOperationOptions,
  readProjectPendingCapture,
} from '@orcaops/storage/history/database';

import type { DatabaseCaptureCommandContext } from './database-capture-context.js';
import type { DatabaseCapturePublication } from './database-capture-events.js';
import { wakeProcessingWorker } from './knowledge-processing-wakeup.js';
import { ErrorCodes, type OpenCheckpointCandidate, OrcaopsError } from '../io/errors.js';

export type CheckpointEventFamily =
  | 'checkpoint_opened'
  | 'checkpoint_closed'
  | 'checkpoint_abandoned';

/** The terminal capture operation and its distinct admission, both derived from the agent's key. */
export function checkpointOperationIds(
  artifactId: string,
  idempotencyKey: string,
  family: CheckpointEventFamily
) {
  return {
    operationId: artifactOperationId(artifactId, idempotencyKey, family),
    admissionOperationId: artifactOperationId(artifactId, idempotencyKey, `${family}.admission`),
  };
}

export interface CheckpointSnapshotPublication {
  publicationId: string;
  fullRef: string;
  objectOid: string;
  treeOid: string;
  objectFormat: 'sha1' | 'sha256';
  checkpointNumber: number;
  checkpointPhase: SnapshotPhase;
}

/**
 * Prepares the boundary objects for one checkpoint phase. The ref is NOT created here:
 * its name is minted with the publication so the event payload can carry it, and the
 * retention admission records the publication before the ref exists.
 */
export async function prepareDatabaseCheckpointSnapshot(
  context: DatabaseCaptureCommandContext,
  request: {
    artifactId: string;
    n: number;
    phase: SnapshotPhase;
    authoredPayloads: unknown[];
  },
  options: { signal?: AbortSignal } = {}
): Promise<{ snapshot: SnapshotResult; publication: CheckpointSnapshotPublication | null }> {
  const publicationId = uuidv7();
  const fullRef = `refs/orcaops/snap/${request.artifactId}/${request.n}/${request.phase}-${publicationId}`;
  const prepared = await prepareDatabaseSnapshot(
    context.registered,
    {
      label: `checkpoint ${request.artifactId}/${request.n} ${request.phase}`,
      source: { kind: 'worktree' },
      excludePatterns: [...resolveCaptureExcludes(context.config.capture).patterns],
      authoredPayloads: JSON.parse(JSON.stringify(request.authoredPayloads)),
      secretAllow: [...context.config.redact.allow],
    },
    options
  );
  if (!prepared.ok)
    return {
      snapshot: {
        ok: false,
        phase: request.phase,
        error_reason: prepared.error_reason,
        ...(prepared.error_message === undefined ? {} : { error_message: prepared.error_message }),
      },
      publication: null,
    };
  return {
    snapshot: {
      ok: true,
      phase: request.phase,
      ref: fullRef,
      tree_sha: prepared.tree_sha,
      commit_sha: prepared.commit_sha,
      unmerged_paths: [...prepared.unmerged_paths],
      ...(prepared.unmerged_probe_failed ? { unmerged_probe_failed: true } : {}),
      ...(prepared.exclusion_probe_failed ? { exclusion_probe_failed: true } : {}),
    },
    publication: {
      publicationId,
      fullRef,
      objectOid: prepared.commit_sha,
      treeOid: prepared.tree_sha,
      objectFormat: prepared.object_format,
      checkpointNumber: request.n,
      checkpointPhase: request.phase,
    },
  };
}

/**
 * Settles a checkpoint capture. With a captured boundary the events and the ref
 * publication are admitted together and the ref is created only after the database
 * records it; without one the capture settles as an ordinary execution append.
 */
export function publishDatabaseCheckpointCapture(
  handle: ProjectDatabase,
  context: DatabaseCaptureCommandContext,
  input: {
    eventId: string;
    admissionOperationId: string;
    publication: CheckpointSnapshotPublication | null;
    createdAt: string;
  },
  options: ProjectOperationOptions = {}
): (capture: PendingCaptureInput) => Promise<DatabaseCapturePublication> {
  return async (capture: PendingCaptureInput) => {
    const runtime = { ...options, processing: context.processing };
    if (!input.publication) return appendProjectExecutionCapture(handle, capture, runtime);
    const execution = capture.execution;
    const retention = prepareProjectGitRetention({
      operationId: capture.operationId,
      admissionOperationId: input.admissionOperationId,
      preparedTransitionId: uuidv7(),
      repositoryInstanceId: handle.authority.repositoryInstanceId,
      objectFormat: input.publication.objectFormat,
      createdAt: input.createdAt,
      target: {
        kind: 'capture',
        artifactId: capture.artifactId,
        expectedRevision: capture.expectedRevision,
        expectedExecutionVersion: execution.kind === 'create' ? null : execution.expectedVersion,
        expectedBindingGeneration:
          execution.kind === 'create' ? null : execution.expectedGeneration,
        expectedBaselinePublicationId: null,
      },
      publications: [
        {
          publicationId: input.publication.publicationId,
          role: 'checkpoint',
          targetId: input.eventId,
          checkpointNumber: input.publication.checkpointNumber,
          checkpointPhase: input.publication.checkpointPhase,
          objectOid: input.publication.objectOid,
          treeOid: input.publication.treeOid,
        },
      ],
      secretAllow: [...context.config.redact.allow],
    });
    return publishDatabaseCaptureRetention(
      handle,
      context.registered,
      { capture, retention },
      runtime
    );
  };
}

/**
 * Finishes an interrupted checkpoint capture by its original operation ID before any
 * new preparation, so the retained request publishes its own ref rather than a new one.
 */
export async function resumeDatabaseCheckpointCapture(
  handle: ProjectDatabase,
  context: DatabaseCaptureCommandContext,
  operationId: string,
  options: ProjectOperationOptions = {}
): Promise<boolean> {
  // Only a still-prepared admission is resumable. A retired one is the residue of a
  // refusal that can never settle, and resuming it would refuse forever.
  const pending = readProjectPendingCapture(handle, operationId).value;
  if (!pending || pending.retention.current.kind !== 'prepared') return false;
  const resumed = await resumeDatabaseCaptureRetention(handle, context.registered, operationId, {
    ...options,
    processing: context.processing,
  });
  wakeProcessingWorker(resumed.admittedProcessingJobs, {
    repoRoot: context.processing.origin.worktreeRoot,
    authority: handle.authority,
    enabled: context.config.knowledge_processing.enabled,
  });
  return true;
}

/**
 * Resolves which checkpoint a close targets: an explicit `n`, the `n` a prior close
 * under this key already committed, or the single open checkpoint. The highest open
 * `n` is never auto-picked — under concurrent sessions that closes another agent's work.
 */
export function resolveDatabaseCloseCheckpoint(
  thread: ArtifactThread,
  input: { explicitN?: number; idempotencyKey: string; artifactId: string }
): number {
  if (input.explicitN !== undefined) return input.explicitN;
  const committed = thread.events.find(
    (event) =>
      event.record.type === 'checkpoint_closed' &&
      event.record.idempotency_key === input.idempotencyKey
  );
  if (committed) return (committed.payload as { n: number }).n;
  const open = thread.checkpoints.filter((checkpoint) => checkpoint.status === 'open');
  if (open.length === 1) return open[0].n;
  if (open.length === 0)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No open checkpoint to close on artifact "${input.artifactId}".`,
      'n'
    );
  const candidates: OpenCheckpointCandidate[] = open.map((checkpoint) => ({
    n: checkpoint.n,
    declared_step_ids: checkpoint.declared_step_ids,
    agent_session_id: checkpoint.agent_session_id ?? null,
    opened_at: checkpoint.opened_at,
  }));
  throw new OrcaopsError(
    ErrorCodes.AMBIGUOUS_CHECKPOINT,
    `${candidates.length} open checkpoints (${candidates.map((c) => `#${c.n}`).join(', ')}) under concurrent work; pass n explicitly.`,
    'n',
    { open_checkpoints: candidates }
  );
}
