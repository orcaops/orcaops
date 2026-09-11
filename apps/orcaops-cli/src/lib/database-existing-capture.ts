import {
  type ArtifactDraftSemantics,
  type CaptureAgentId,
  type CapturePlanReviseInput,
  type CaptureSummaryInput,
  normalizeAcceptedWarnings,
  type PlanReviseWriteResult,
  type SummaryInput,
  type SummaryWriteResult,
} from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  type ProjectArtifactSnapshot,
  ProjectDatabaseError,
  readProjectExecution,
} from '@orcaops/storage/history/database';

import {
  type ArtifactAttemptChanges,
  publishDatabaseCaptureAttempts,
  retainedAttemptBlocks,
} from './database-capture-attempts.js';
import {
  type DatabaseCaptureCommandContext,
  openDatabaseCaptureWriter,
  type PreparedDatabaseCapture,
  selectDatabaseCaptureArtifact,
} from './database-capture-context.js';
import { appendDatabaseCaptureEvents } from './database-capture-events.js';
import {
  isStaleCaptureRefusal,
  replayCaptureRefusal,
  retainStaleCaptureRefusal,
  STALE_CAPTURE_REFUSAL,
} from './database-capture-refusal.js';
import { extractSummaryReplayShape, summaryReplayPayload } from './summary-replay-shape.js';
import { writeTerminalSafeStderr } from '../io/output.js';

export type ExistingCaptureKind = 'plan_revision' | 'summary';
type CaptureInput<K extends ExistingCaptureKind> = K extends 'plan_revision'
  ? CapturePlanReviseInput
  : CaptureSummaryInput;
type CaptureResult<K extends ExistingCaptureKind> = K extends 'plan_revision'
  ? PlanReviseWriteResult
  : SummaryWriteResult;

export interface DatabaseExistingCapture<K extends ExistingCaptureKind> {
  context: DatabaseCaptureCommandContext;
  writer: Awaited<ReturnType<typeof openDatabaseCaptureWriter>>;
  artifactId: string;
  operationId: string;
  result: CaptureResult<K>;
  appended: Awaited<ReturnType<typeof appendDatabaseCaptureEvents<CaptureResult<K>>>>;
  options: { signal: AbortSignal; onWait: () => void };
}

/** Runtime-supplied fields stay out of the semantic replay comparison so a retry replays instead of conflicting. */
function summaryInput(
  input: CaptureSummaryInput,
  artifactId: string,
  agent: CaptureAgentId,
  headSha: string,
  ts: string
): SummaryInput {
  return {
    schema_version: 1,
    artifact_id: artifactId,
    agent,
    outcome: input.outcome,
    tests_written: input.tests_written,
    tests_run: input.tests_run,
    open_items: input.open_items,
    deferred_decisions: input.deferred_decisions,
    ...(input.accepted_warnings === undefined
      ? {}
      : { accepted_warnings: normalizeAcceptedWarnings(input.accepted_warnings) }),
    head_sha: headSha,
    ts,
  };
}

/**
 * Selects the target artifact, opens the writer and settles the semantic result of
 * a revision or summary through the execution-capture composer. The caller owns
 * every follow-up (evaluators, stamps, focus) and must close the returned writer.
 *
 * `preselectedArtifactId` pins the target a caller already resolved under an earlier
 * writer — `finish` selects the artifact for its pre-PR checks, so the summary must
 * land on that same artifact rather than re-running the branch heuristic, which a
 * concurrent completion could resolve to a different one between the two writers. The
 * pinned id is still validated: a target that no longer exists refuses rather than
 * retargeting, and one already summarized settles as the summary's own refusal.
 */
export async function captureDatabaseExisting<K extends ExistingCaptureKind>(
  kind: K,
  prepared: PreparedDatabaseCapture<CaptureInput<K>, CaptureInput<K>>,
  signal: AbortSignal,
  preselectedArtifactId?: string
): Promise<DatabaseExistingCapture<K>> {
  const { context, input } = prepared;
  if (signal.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'Capture cancelled before opening the writer');
  let waiting = false;
  const options = {
    signal,
    onWait: () => {
      if (waiting) return;
      waiting = true;
      writeTerminalSafeStderr(
        'Waiting for capture on the selected project database; Ctrl-C cancels the wait.\n'
      );
    },
  };
  const writer = await openDatabaseCaptureWriter(context);
  const refusal = {
    eventType: kind === 'plan_revision' ? 'plan_revised' : 'summary_captured',
    command: kind === 'plan_revision' ? 'capture plan revise' : 'capture summary',
  };
  let selected: string | null = null;
  try {
    const { artifactId } = selectDatabaseCaptureArtifact(writer, {
      explicitId: preselectedArtifactId ?? input.artifact_id,
      branch: context.registered.git.branch,
    });
    selected = artifactId;
    replayCaptureRefusal(writer, {
      artifactId,
      eventType: refusal.eventType,
      idempotencyKey: input.idempotency_key,
      replayPayload: input,
    });
    const operationId = artifactOperationId(artifactId, input.idempotency_key, kind);
    const headSha = context.registered.git.headOid;
    if (!headSha) throw new ProjectDatabaseError('INVALID_INPUT', 'Capture requires a Git commit');
    const ts = new Date().toISOString();
    const agent = context.invokingAgent.agent;
    const appended = await appendDatabaseCaptureEvents<CaptureResult<K>>({
      handle: writer,
      binding: context.binding,
      artifactId,
      operationId,
      authoredPayload: { kind, input },
      secretAllow: context.config.redact.allow,
      explicitTarget: input.artifact_id !== undefined,
      // A refused revision records a hard-rejected receipt the same way the file era
      // did, so a same-key retry with a different payload still resolves as a conflict.
      ...(kind === 'plan_revision'
        ? {
            idempotencyBlocks: retainedAttemptBlocks(writer, artifactId),
            settleAttempts: (
              changes: ArtifactAttemptChanges,
              before: ProjectArtifactSnapshot
            ): Promise<void> =>
              publishDatabaseCaptureAttempts(
                writer,
                {
                  artifactId,
                  artifactRevision: before.revision,
                  changes,
                  command: 'capture plan revise',
                  secretAllow: context.config.redact.allow,
                },
                options
              ),
          }
        : {}),
      // A summary over already-completed execution is an amendment; the generic
      // historical_maintenance default would lose that distinction.
      operation:
        kind === 'summary' &&
        readProjectExecution(writer, artifactId)?.state.lifecycle === 'completed'
          ? ('summary_amendment' as const)
          : ('task' as const),
      options,
      evaluate: async (semantics: ArtifactDraftSemantics) => {
        if (kind === 'plan_revision') {
          const revise = input as CapturePlanReviseInput;
          return (await semantics.revisePlan(
            { ...revise, artifact_id: artifactId },
            { idempotencyKey: revise.idempotency_key, invokedByAgent: agent }
          )) as CaptureResult<K>;
        }
        const summary = input as CaptureSummaryInput;
        return (await semantics.writeSummary(
          summaryInput(summary, artifactId, agent, headSha, ts),
          {
            idempotencyKey: summary.idempotency_key,
            replayPayload: summaryReplayPayload(summary, artifactId),
            extractReplayShape: extractSummaryReplayShape,
            priorSummaryEventId: summary.prior_summary_event_id,
          }
        )) as CaptureResult<K>;
      },
    });
    return { context, writer, artifactId, operationId, result: appended.value, appended, options };
  } catch (cause) {
    // A revision or summary prepared against a revision another writer advanced can never
    // settle by replaying this operation, so it refuses under the same contract the
    // checkpoint verbs use: nothing to resume, and the same key replays this answer.
    if (isStaleCaptureRefusal(cause) && selected !== null)
      await retainStaleCaptureRefusal(writer, context, {
        artifactId: selected,
        eventType: refusal.eventType,
        idempotencyKey: input.idempotency_key,
        replayPayload: input,
        operationId: artifactOperationId(selected, input.idempotency_key, kind),
        command: refusal.command,
        options,
      });
    try {
      writer.close();
    } catch {
      // The primary failure is what the caller must see.
    }
    throw isStaleCaptureRefusal(cause)
      ? new ProjectDatabaseError('STALE_CONTEXT', STALE_CAPTURE_REFUSAL)
      : cause;
  }
}
