import {
  type ArtifactThread,
  assertNoSecretsInPayload,
  containsForbiddenControlChars,
  type EvaluatorDispositionPayload,
  EvaluatorDispositionPayloadSchema,
  isUuidV7,
  stripControlChars,
  uuidv7,
} from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import { openProjectDatabase, readProjectArtifact } from '@orcaops/storage/history/database';

import { resolveTargetRun } from './helpers.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { writeTerminalSafeStderr } from '../../io/output.js';
import { resolveDatabaseCaptureContext } from '../../lib/database-capture-context.js';
import { appendDatabaseCaptureEvents } from '../../lib/database-capture-events.js';
import {
  databaseCaptureNextActions,
  translateDatabaseCaptureError,
} from '../../lib/database-capture-response.js';
import { discoverEvaluatorsForCli, evaluatorNotFound } from '../../lib/evaluator-discovery.js';
import { LIFECYCLE_INVENTORY_EVALUATOR_REF } from '../../lib/evaluator-inventory.js';
import { closeFailedHistoryRead } from '../../lib/history-reader-close.js';
import { loadSecretAllowlist } from '../../lib/run-capture.js';

export interface BlockDispositionOptions {
  artifact: string;
  evaluator: string;
  runId?: string;
  reason: string;
  agentSessionId?: string;
  idempotencyKey?: string;
}

function resultOf(payload: EvaluatorDispositionPayload) {
  return {
    artifact_id: payload.artifact_id,
    evaluator: payload.evaluator_ref,
    run_id: payload.run_id,
    action: payload.disposition,
    ...(payload.disposition === 'acknowledged'
      ? { acknowledged_at: payload.ts }
      : { dismissed_at: payload.ts }),
  };
}

function retainedDisposition(
  thread: ArtifactThread,
  input: BlockDispositionOptions,
  key: string,
  disposition: EvaluatorDispositionPayload['disposition']
) {
  const prior = [...thread.events]
    .reverse()
    .find(
      (event) =>
        event.record.type === 'evaluator_disposition_recorded' &&
        event.record.idempotency_key === key
    );
  if (!prior) return null;
  const parsed = EvaluatorDispositionPayloadSchema.safeParse(prior.payload);
  if (
    !parsed.success ||
    parsed.data.artifact_id !== input.artifact ||
    parsed.data.evaluator_ref !== input.evaluator ||
    parsed.data.disposition !== disposition ||
    parsed.data.reason !== input.reason ||
    parsed.data.agent_session_id !== (input.agentSessionId ?? null) ||
    (input.runId !== undefined && parsed.data.run_id !== input.runId)
  )
    throw new OrcaopsError(
      ErrorCodes.IDEMPOTENCY_CONFLICT,
      'This idempotency key already identifies different authored input. Use a new key for a new block resolution.',
      'idempotency_key'
    );
  return parsed.data;
}

export async function recordDatabaseBlockDisposition(
  verb: 'acknowledge' | 'dismiss',
  received: BlockDispositionOptions
) {
  const raw = structuredClone(received);
  assertNoSecretsInPayload(raw, await loadSecretAllowlist());
  for (const [field, errorPath] of [
    ['artifact', 'artifact'],
    ['evaluator', 'evaluator'],
    ['runId', 'run_id'],
    ['agentSessionId', 'agent_session_id'],
    ['idempotencyKey', 'idempotency_key'],
  ] as const) {
    const value = raw[field];
    if (value !== undefined && containsForbiddenControlChars(value))
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Identifiers must not contain control characters.',
        errorPath
      );
  }
  if (!isUuidV7(raw.artifact))
    throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${raw.artifact}".`);
  const input = { ...raw, reason: stripControlChars(raw.reason) };
  const key = input.idempotencyKey ?? uuidv7();
  const disposition = verb === 'acknowledge' ? 'acknowledged' : 'dismissed';
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  let context: Awaited<ReturnType<typeof resolveDatabaseCaptureContext>> | undefined;
  let writer: Awaited<ReturnType<typeof openProjectDatabase>> | undefined;
  try {
    context = await resolveDatabaseCaptureContext({
      registerWorktree: true,
      signal: controller.signal,
    });
    const retained = readProjectArtifact(context.project.database, input.artifact);
    if (!retained)
      throw new OrcaopsError(
        ErrorCodes.UNKNOWN_ARTIFACT,
        `No artifact with id "${input.artifact}".`
      );
    const prior = retainedDisposition(retained.thread, input, key, disposition);
    if (prior) {
      // A committed resolution keeps its original target even after a newer run or policy change.
      return {
        ...resultOf(prior),
        next_actions: await databaseCaptureNextActions(
          context,
          context.project.database,
          input.artifact
        ),
      };
    }

    const { evaluators, errors } = await discoverEvaluatorsForCli(
      context.registered.git.worktreeRoot
    );
    const evaluator = evaluators.find((entry) => entry.ref === input.evaluator);
    const evaluatorRef =
      evaluator?.ref ??
      (verb === 'dismiss' && input.evaluator === LIFECYCLE_INVENTORY_EVALUATOR_REF
        ? LIFECYCLE_INVENTORY_EVALUATOR_REF
        : null);
    if (evaluatorRef === null) throw evaluatorNotFound(input.evaluator, errors);
    if (evaluator && evaluator.severity !== 'block')
      throw new OrcaopsError(
        verb === 'acknowledge' ? ErrorCodes.BLOCK_NOT_ACKNOWLEDGEABLE : ErrorCodes.INVALID_INPUT,
        `Evaluator "${evaluatorRef}" has severity "${evaluator.severity}"; ${verb} only applies to block-severity evaluators.`,
        'evaluator'
      );
    if (verb === 'acknowledge' && !evaluator?.resolution.acknowledge.enabled)
      throw new OrcaopsError(
        ErrorCodes.BLOCK_NOT_ACKNOWLEDGEABLE,
        `Evaluator "${evaluatorRef}" does not permit acknowledgement. Use \`orcaops block dismiss\` instead, or amend the work.`,
        'evaluator'
      );
    const target = resolveTargetRun(
      retained.thread.evaluatorLog?.runs ?? [],
      input,
      evaluatorRef,
      verb
    );
    const payload = EvaluatorDispositionPayloadSchema.parse({
      schema: 'orcaops.evaluator_disposition/v1',
      disposition_id: uuidv7(),
      artifact_id: input.artifact,
      run_id: target.run_id,
      evaluator_ref: evaluatorRef,
      disposition,
      reason: input.reason,
      agent_session_id: input.agentSessionId ?? null,
      ts: new Date().toISOString(),
    });
    assertNoSecretsInPayload(payload, context.config.redact.allow);
    writer = await openProjectDatabase({
      authority: context.registered.authority,
      mode: 'writer',
      signal: controller.signal,
    });
    let waiting = false;
    const appended = await appendDatabaseCaptureEvents({
      handle: writer,
      binding: context.binding,
      artifactId: input.artifact,
      operationId: artifactOperationId(input.artifact, key, 'evaluator_disposition'),
      authoredPayload: payload,
      secretAllow: context.config.redact.allow,
      explicitTarget: true,
      options: {
        signal: controller.signal,
        onWait: () => {
          if (waiting) return;
          waiting = true;
          writeTerminalSafeStderr(
            `Waiting to ${verb} the evaluator block; Ctrl-C cancels the wait.\n`
          );
        },
      },
      evaluate: async (semantics, thread) => {
        const committed = retainedDisposition(thread, input, key, disposition);
        if (committed) return committed;
        resolveTargetRun(
          thread.evaluatorLog?.runs ?? [],
          { ...input, runId: target.run_id },
          evaluatorRef,
          verb
        );
        await semantics.writeEvaluatorDisposition(input.artifact, payload, { idempotencyKey: key });
        return payload;
      },
    });
    return {
      ...resultOf(appended.value),
      next_actions: await databaseCaptureNextActions(context, writer, input.artifact),
    };
  } catch (cause) {
    if (writer) {
      closeFailedHistoryRead(writer);
      writer = undefined;
    }
    if (context) {
      closeFailedHistoryRead(context);
      context = undefined;
    }
    throw translateDatabaseCaptureError(cause);
  } finally {
    process.removeListener('SIGINT', interrupt);
    writer?.close();
    context?.close();
  }
}
