import { type ArtifactThread, PrePrCheckedPayloadSchema, uuidv7 } from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  type ProjectDatabase,
  type ProjectOperationOptions,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import type { DatabaseCaptureCommandContext } from './database-capture-context.js';
import { appendDatabaseCaptureEvents } from './database-capture-events.js';
import {
  type DatabaseLifecycleEvaluation,
  publishDatabaseLifecycleCompletion,
  runDatabaseLifecycleEvaluators,
} from './database-evaluators.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface PrePrMarker {
  event_id: string;
  outcome: 'passed' | 'needs_attention';
}

export interface DatabasePrePrPass {
  evaluated: DatabaseLifecycleEvaluation;
  marker: PrePrMarker | null;
}

/**
 * The open-checkpoint gate, in the wording each command owns. `finish` and
 * `capture pre-pr-check` refuse for the same reason but name themselves, and the
 * detail exists so a refusal says which checkpoint and how long it has been idle
 * rather than only how many there are.
 */
export function assertNoOpenCheckpoints(thread: ArtifactThread, command: string): void {
  const open = thread.checkpoints.filter((checkpoint) => checkpoint.status === 'open');
  if (open.length === 0) return;
  const now = Date.now();
  const detail = open
    .map(
      (checkpoint) =>
        `#${checkpoint.n}` +
        (checkpoint.agent_session_id ? ` (${checkpoint.agent_session_id})` : '') +
        ` declared [${checkpoint.declared_step_ids.join(', ')}], opened ${checkpoint.opened_at} ` +
        `(idle ${Math.max(0, Math.round((now - new Date(checkpoint.opened_at).getTime()) / 1000))}s)`
    )
    .join('; ');
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `Cannot run ${command} while ${open.length} open checkpoint(s) exist: ${detail}. ` +
      `Close or abandon each before retrying.`
  );
}

function requireThread(handle: ProjectDatabase, artifactId: string): ArtifactThread {
  const retained = readProjectArtifact(handle, artifactId);
  if (!retained)
    throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${artifactId}".`);
  return retained.thread;
}

/**
 * The pre-PR evaluator pass `finish` and `capture pre-pr-check` share: gate on open
 * checkpoints, run the phase, gate again, record the completion, and mint the marker
 * unless the pass blocked.
 *
 * The gate is re-read after the evaluators because they are long-running and hold no
 * transaction, so a checkpoint opened meanwhile must still refuse before anything is
 * recorded. A blocking pass records the completion but no marker: the marker is what a
 * later `finish` accepts warnings against, and there is nothing to accept.
 */
export async function runDatabasePrePrPass(input: {
  context: DatabaseCaptureCommandContext;
  handle: ProjectDatabase;
  artifactId: string;
  command: 'finish' | 'capture pre-pr-check';
  noLlm?: boolean;
  explicitTarget: boolean;
  options?: ProjectOperationOptions;
}): Promise<DatabasePrePrPass> {
  const { context, handle, artifactId, command, options } = input;
  assertNoOpenCheckpoints(requireThread(handle, artifactId), command);
  const evaluated = await runDatabaseLifecycleEvaluators({
    context,
    handle,
    artifactId,
    firesAt: 'pre-pr',
    noLlm: input.noLlm,
    explicitTarget: input.explicitTarget,
    options,
  });
  assertNoOpenCheckpoints(requireThread(handle, artifactId), command);
  await publishDatabaseLifecycleCompletion(
    handle,
    {
      artifactId,
      key: { firesAt: 'pre-pr', cpN: 0 },
      triggeredAt: new Date().toISOString(),
      command,
      secretAllow: context.config.redact.allow,
      mode: 'replace',
    },
    options
  );
  if (evaluated.blocking) return { evaluated, marker: null };
  if (!evaluated.pre_pr_review)
    throw new Error('pre-pr evaluator run did not produce review fingerprints');
  const review = evaluated.pre_pr_review;
  const headSha = context.registered.git.headOid;
  if (!headSha)
    throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'A pre-PR marker requires a Git commit');
  const outcome = evaluated.evaluator_results.some(
    (run) =>
      run.severity === 'warn' &&
      (run.run_status === 'error' ||
        (run.run_status === 'completed' && run.verdict === 'violation'))
  )
    ? ('needs_attention' as const)
    : ('passed' as const);
  const markerKey = uuidv7();
  const appended = await appendDatabaseCaptureEvents<{ event_id: string }>({
    handle,
    binding: context.binding,
    artifactId,
    operationId: artifactOperationId(artifactId, markerKey, 'pre_pr_checked'),
    authoredPayload: { kind: 'pre_pr_checked', artifact_id: artifactId, outcome },
    secretAllow: context.config.redact.allow,
    explicitTarget: input.explicitTarget,
    operation: 'task',
    options,
    evaluate: async (semantics) =>
      semantics.writePrePrChecked(
        artifactId,
        {
          head_sha: headSha,
          outcome,
          evaluator_set_fingerprint: review.evaluator_set_fingerprint,
          review_context_fingerprint: review.review_context_fingerprint,
          run_ids: evaluated.evaluator_results.map((run) => run.run_id),
        },
        { idempotencyKey: markerKey }
      ),
  });
  return { evaluated, marker: { event_id: appended.value.event_id, outcome } };
}

/** The retained pre-PR marker an accepted-warnings finish names, or null. */
export function readDatabasePrePrReview(
  handle: ProjectDatabase,
  artifactId: string,
  reviewId: string
): { event_id: string; payload: ReturnType<typeof PrePrCheckedPayloadSchema.parse> } | null {
  const thread = requireThread(handle, artifactId);
  const event = thread.events.find(
    (candidate) =>
      candidate.record.type === 'pre_pr_checked' && candidate.record.event_id === reviewId
  );
  if (!event) return null;
  const payload = PrePrCheckedPayloadSchema.safeParse(event.payload);
  return payload.success ? { event_id: reviewId, payload: payload.data } : null;
}
