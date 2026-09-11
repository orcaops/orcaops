import {
  type ArtifactDraftResult,
  type ArtifactDraftSemantics,
  type ArtifactThread,
  type IdempotencyBlockRow,
  prepareArtifactDraft,
} from '@orcaops/storage';
import {
  appendProjectExecutionCapture,
  type CaptureExecutionContext,
  type PendingCaptureInput,
  type ProjectArtifactSnapshot,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectExecutionSnapshot,
  type ProjectOperationOptions,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';
import type { ExecutionBinding } from '@orcaops/storage/history/execution';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export type DatabaseCaptureOperation = Exclude<CaptureExecutionContext['kind'], 'create'>;

export interface AppendDatabaseCaptureInput<T> {
  handle: ProjectDatabase;
  binding: ExecutionBinding;
  artifactId: string;
  operationId: string;
  authoredPayload: unknown;
  secretAllow: readonly string[];
  explicitTarget: boolean;
  operation?: DatabaseCaptureOperation;
  idempotencyBlocks?: readonly IdempotencyBlockRow[];
  evaluate: (semantics: ArtifactDraftSemantics, thread: ArtifactThread) => Promise<T>;
  /**
   * Retained rejected-attempt evidence the draft produced. It is settled before the
   * events are, and before a refusal is rethrown, so a hard rejection leaves the same
   * receipt a committed one would.
   */
  settleAttempts?: (
    changes: ArtifactDraftResult<T>['idempotencyChanges'],
    before: ProjectArtifactSnapshot
  ) => Promise<void>;
  /** Settlement override for captures whose events also publish retained Git refs. */
  publish?: (
    capture: PendingCaptureInput,
    events: ArtifactDraftResult<T>['events']
  ) => Promise<DatabaseCapturePublication>;
  options?: ProjectOperationOptions;
}
export type DatabaseCapturePublication = Awaited<ReturnType<typeof appendProjectExecutionCapture>>;
export interface AppendedDatabaseCapture<T> {
  value: T;
  before: ProjectArtifactSnapshot;
  execution: ProjectExecutionSnapshot;
  events: ArtifactDraftResult<T>['events'];
  idempotencyChanges: ArtifactDraftResult<T>['idempotencyChanges'];
  publication: DatabaseCapturePublication | null;
}

/**
 * Evaluates the existing artifact semantics against the retained thread in memory,
 * then settles the produced events and the execution change in one operation. A
 * draft that produces no events (an idempotent replay) settles nothing.
 */
export async function appendDatabaseCaptureEvents<T>(
  input: AppendDatabaseCaptureInput<T>
): Promise<AppendedDatabaseCapture<T>> {
  const { handle, artifactId } = input;
  const before = readProjectArtifact(handle, artifactId);
  if (!before)
    throw new OrcaopsError(
      ErrorCodes.UNKNOWN_ARTIFACT,
      `No artifact with id "${artifactId}".`,
      'artifact_id'
    );
  const execution = readProjectExecution(handle, artifactId);
  if (!execution)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The artifact has no original execution history; preserve it for explicit repair instead of initializing an owner'
    );
  const draft = await prepareArtifactDraft(
    {
      artifactId,
      priorEvents: before.thread.events,
      authoredPayload: input.authoredPayload,
      secretAllow: input.secretAllow,
      idempotencyBlocks: input.idempotencyBlocks ?? [],
    },
    (semantics) => input.evaluate(semantics, before.thread)
  );
  if (input.settleAttempts) await input.settleAttempts(draft.idempotencyChanges, before);
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  const common = {
    value: draft.evaluation.value,
    before,
    execution,
    events: draft.events,
    idempotencyChanges: draft.idempotencyChanges,
  };
  if (!draft.events.length) return { ...common, publication: null };
  const kind =
    input.operation ??
    (execution.state.lifecycle === 'completed' ? 'historical_maintenance' : 'task');
  const capture: PendingCaptureInput = {
    operationId: input.operationId,
    artifactId,
    expectedRevision: before.revision,
    eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
    sidecarPayloads: draft.events.flatMap((event) =>
      event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
    ),
    secretAllow: [...input.secretAllow],
    execution: {
      kind,
      context: input.binding,
      expectedVersion: execution.version,
      expectedGeneration: execution.state.binding_generation,
      explicitTarget: input.explicitTarget,
    },
  };
  const publication = input.publish
    ? await input.publish(capture, draft.events)
    : await appendProjectExecutionCapture(handle, capture, input.options);
  return { ...common, publication };
}
