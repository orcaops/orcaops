import {
  type ArtifactDraftResult,
  type ArtifactDraftSemantics,
  type ArtifactThread,
  type IdempotencyBlockRow,
  type KnowledgeUseInput,
  prepareArtifactDraft,
} from '@orcaops/storage';
import {
  appendProjectExecutionCapture,
  type CaptureExecutionContext,
  type CaptureOperationOptions,
  type CaptureProcessingAdmission,
  type EvaluatorRunEvidence,
  type PendingCaptureInput,
  type PreparedTaskUses,
  preparePlanTaskUses,
  type ProjectArtifactSnapshot,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectExecutionSnapshot,
  readProjectArtifact,
  readProjectExecution,
  requireRetainedUseTargets,
} from '@orcaops/storage/history/database';
import type { ExecutionBinding } from '@orcaops/storage/history/execution';

import { wakeProcessingWorker } from './knowledge-processing-wakeup.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export type DatabaseCaptureOperation = Exclude<CaptureExecutionContext['kind'], 'create'>;

export interface AppendDatabaseCaptureInput<T> {
  handle: ProjectDatabase;
  binding: ExecutionBinding;
  /** What this capture admits for background processing; the command's context carries it. */
  processing: CaptureProcessingAdmission;
  /** `knowledge_processing.enabled` for this checkout: whether a worker is started at all. */
  processingEnabled: boolean;
  artifactId: string;
  operationId: string;
  authoredPayload: unknown;
  secretAllow: readonly string[];
  explicitTarget: boolean;
  /**
   * What each evaluator run these events establish produced beside itself. Read where the capture
   * input is built, after the draft has been evaluated, so the checkpoint-open gate — which only
   * dispatches while the draft is being evaluated — can fill it in place.
   */
  evaluatorEvidence?: readonly EvaluatorRunEvidence[];
  operation?: DatabaseCaptureOperation;
  /**
   * The exact revisions a plan event among these events selects. They are settled in the same
   * operation that writes that event, which is what makes the store derive `selected_with_plan`.
   */
  knowledgeUses?: readonly KnowledgeUseInput[];
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
  options?: CaptureOperationOptions;
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

const PLAN_EVENT_TYPES = ['plan_captured', 'plan_revised'];

/**
 * The uses named for the plan event these events establish, prepared and checked before anything
 * settles. A use is keyed to one plan event, so a capture that named uses and drafted no single
 * plan event has nothing to key them to and is refused rather than attaching them to a guess.
 */
function planTaskUses<T>(
  handle: ProjectDatabase,
  input: AppendDatabaseCaptureInput<T>,
  events: ArtifactDraftResult<T>['events']
): PreparedTaskUses | null {
  if (!input.knowledgeUses?.length) return null;
  const planEvents = events.filter((event) => PLAN_EVENT_TYPES.includes(event.record.type));
  if (planEvents.length !== 1)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'A knowledge use is keyed to one plan event; this capture establishes none or several'
    );
  const uses = preparePlanTaskUses({
    artifactId: input.artifactId,
    planEventId: planEvents[0]!.record.event_id,
    uses: input.knowledgeUses,
    secretAllow: input.secretAllow,
  });
  if (uses)
    handle.read((view) => {
      requireRetainedUseTargets(view, uses);
      return null;
    });
  return uses;
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
  const uses = planTaskUses(handle, input, draft.events);
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
    ...(input.evaluatorEvidence?.length ? { evaluatorEvidence: [...input.evaluatorEvidence] } : {}),
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
    : await appendProjectExecutionCapture(
        handle,
        capture,
        { ...input.options, processing: input.processing },
        uses
      );
  // The capture is committed by the time this runs, and the wake-up never throws,
  // so nothing behind it can fail a capture or add anything to its success path.
  wakeProcessingWorker(publication.admittedProcessingJobs, {
    repoRoot: input.processing.origin.worktreeRoot,
    authority: handle.authority,
    enabled: input.processingEnabled,
  });
  return { ...common, publication };
}
