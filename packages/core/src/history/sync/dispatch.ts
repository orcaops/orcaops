import { uuidv7 } from '@orcaops/storage';
import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';
import {
  admitProjectRemoteAttempt,
  ARTIFACT_PUSH_METHODS,
  beginProjectArtifactPush,
  completeProjectArtifactPush,
  type ProjectArtifactPushInput,
  readProjectArtifactPush,
  recordProjectRemoteOutcome,
} from '@orcaops/storage/history/database/artifact-push';

type PushMethod = (typeof ARTIFACT_PUSH_METHODS)[number];
type Send = (payloadBytes: Buffer) => Promise<Buffer>;
/**
 * The nine methods a grouped push may call, each named explicitly: a dispatcher that
 * accepted an arbitrary map could send a retained call through a handler the push schema
 * never admitted.
 */
export interface ArtifactPushClient {
  captureThread: {
    start: Send;
    attachPlan: Send;
    attachPlanRevision: Send;
    attachCheckpointOpened: Send;
    attachCheckpoint: Send;
    attachSummary: Send;
    attachEvaluators: Send;
    attachCodingSessionsUsage: Send;
  };
  sourcePlan: { attachPin: Send };
}
export interface DispatchArtifactPushOptions extends ProjectOperationOptions {
  /** Clock for the observation timestamps the transport retains. */
  now?: () => string;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Push dispatch cancelled before the next original call was attempted'
    );
}
function unresolved(message: string): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    `${message}. The original call will not be resent. Run \`orcaops push-status\` to inspect retained push progress. Status cannot prove remote absence; report the unknown delivery before preparing another push`
  );
}
function send(client: ArtifactPushClient, method: PushMethod): Send {
  switch (method) {
    case 'captureThread.start':
      return (bytes) => client.captureThread.start(bytes);
    case 'captureThread.attachPlan':
      return (bytes) => client.captureThread.attachPlan(bytes);
    case 'captureThread.attachPlanRevision':
      return (bytes) => client.captureThread.attachPlanRevision(bytes);
    case 'captureThread.attachCheckpointOpened':
      return (bytes) => client.captureThread.attachCheckpointOpened(bytes);
    case 'captureThread.attachCheckpoint':
      return (bytes) => client.captureThread.attachCheckpoint(bytes);
    case 'captureThread.attachSummary':
      return (bytes) => client.captureThread.attachSummary(bytes);
    case 'captureThread.attachEvaluators':
      return (bytes) => client.captureThread.attachEvaluators(bytes);
    case 'captureThread.attachCodingSessionsUsage':
      return (bytes) => client.captureThread.attachCodingSessionsUsage(bytes);
    case 'sourcePlan.attachPin':
      return (bytes) => client.sourcePlan.attachPin(bytes);
  }
}
function failureOf(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind: 'unknown' as const, message };
}
/**
 * Dispatch one admitted grouped push and complete it under the header's original terminal
 * operation ID.
 *
 * Every call's retained progress is restored from the push itself before an attempt ID is
 * minted, so a resumed dispatch neither re-sends an acknowledged call nor invents a second
 * attempt. Unknown delivery is never resent.
 */
export async function dispatchProjectArtifactPush(
  handle: ProjectDatabase,
  client: ArtifactPushClient,
  pushId: string,
  options: DispatchArtifactPushOptions = {}
) {
  const { now = () => new Date().toISOString(), ...operation } = options;
  const restored = readProjectArtifactPush(handle, pushId);
  if (restored.value === null)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'No retained push has this identity; admit the original push before dispatching it'
    );
  const push = restored.value;
  const terminal = { pushId: push.input.pushId, operationId: push.input.terminalOperationId };
  // A settled push replays its original result; no call is sent and no ID is minted.
  if (push.terminal !== null) return completeProjectArtifactPush(handle, terminal, operation);
  for (const call of push.calls) {
    cancelled(operation.signal);
    const latest = call.outcomes.at(-1) ?? null;
    if (latest?.kind === 'acknowledged') continue;
    if (latest?.kind === 'ack_unknown')
      unresolved('This call has an unknown delivery outcome retained against its original attempt');
    if (call.attempt !== null)
      unresolved('This call has an admitted attempt with no retained outcome');
    const attempt = {
      operationId: uuidv7(),
      attemptId: uuidv7(),
      requestId: call.request.requestId,
      scope: call.request.scope,
      expectedSelection: call.current,
      attemptedAt: now(),
    };
    await admitProjectRemoteAttempt(handle, attempt, { secretAllow: [] }, operation);
    const admitted = readProjectArtifactPush(handle, pushId).value!.calls.find(
      (value) => value.request.requestId === call.request.requestId
    )!;
    const outcome = {
      operationId: uuidv7(),
      outcomeId: uuidv7(),
      requestId: call.request.requestId,
      attemptId: attempt.attemptId,
      scope: call.request.scope,
      expectedSelection: admitted.current,
      observedAt: now(),
    };
    let responseBytes: Buffer;
    try {
      responseBytes = await send(
        client,
        call.request.scope.method as PushMethod
      )(call.request.payloadBytes);
    } catch (cause) {
      await recordProjectRemoteOutcome(
        handle,
        { ...outcome, kind: 'ack_unknown', responseBytes: null, failure: failureOf(cause) },
        { secretAllow: [] },
        operation
      );
      unresolved('The original call was interrupted before its delivery was observed');
    }
    await recordProjectRemoteOutcome(
      handle,
      { ...outcome, kind: 'acknowledged', responseBytes, failure: null },
      { secretAllow: [] },
      operation
    );
  }
  return completeProjectArtifactPush(handle, terminal, operation);
}
export interface ComposeArtifactPushOptions extends DispatchArtifactPushOptions {
  /** Forwarded to admission; every grouped push admits under an explicit refusal allowlist. */
  secretAllow?: readonly string[];
}
/**
 * Admit one grouped push and settle it over the same client in a single call.
 *
 * Admission and settlement each replay by their own original identity, so a resumed
 * composition re-admits nothing and re-sends nothing: the admission builder replays its
 * receipt for a known operation ID, dispatch replays the terminal for a settled push. The
 * settlement's honest outcome is returned unchanged — a push whose cloud or session source
 * moved after admission still completes under its original terminal identity with
 * cloudApplied / sessionApplied false and no retarget. Admission enforces the reciprocal
 * reserved-child guards, so no checkout focus identity is silently reused as a push identity.
 */
export async function composeProjectArtifactPush(
  handle: ProjectDatabase,
  client: ArtifactPushClient,
  input: ProjectArtifactPushInput,
  options: ComposeArtifactPushOptions = {}
) {
  const { secretAllow = [], now, ...operation } = options;
  await beginProjectArtifactPush(handle, input, { ...operation, secretAllow: [...secretAllow] });
  return dispatchProjectArtifactPush(handle, client, input.pushId, { ...operation, now });
}
