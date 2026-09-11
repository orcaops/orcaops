import { uuidv7 } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';
import {
  type ProjectDatabase,
  type ProjectOperationOptions,
  readProjectArtifact,
  readProjectGitRetention,
  retireProjectGitRetention,
} from '@orcaops/storage/history/database';

import {
  readDatabaseCaptureRefusal,
  recordDatabaseCaptureRefusal,
} from './database-capture-attempts.js';
import type { DatabaseCaptureCommandContext } from './database-capture-context.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export const STALE_CAPTURE_REFUSAL =
  'Another capture advanced this artifact while this one was being prepared, so its ' +
  'admission was retired and nothing was written. Re-read the artifact (orcaops status) ' +
  'and submit again with a FRESH idempotency_key — this key now replays this refusal, ' +
  'because its request expected a revision that is already history.';

/**
 * Refusals this module already answered from a receipt. Retaining one again would
 * republish the row it was just read from, so a replayed refusal is deliberately not a
 * stale-precondition failure for the retaining callers.
 */
const replayed = new WeakSet<object>();

export function isStaleCaptureRefusal(cause: unknown): boolean {
  return (
    cause instanceof ProjectDatabaseError && cause.code === 'STALE_CONTEXT' && !replayed.has(cause)
  );
}

/**
 * Receipt-first: a capture refused on a precondition that can never be satisfied by
 * replaying its original operation answers from its retained receipt instead of
 * preparing again, and a different payload under that key is the ordinary conflict.
 */
export function replayCaptureRefusal(
  handle: ProjectDatabase,
  input: {
    artifactId: string;
    eventType: string;
    idempotencyKey: string;
    replayPayload: unknown;
  }
): void {
  const receipt = readDatabaseCaptureRefusal(handle, input);
  if (receipt?.state === 'refused') {
    const refusal = new ProjectDatabaseError('STALE_CONTEXT', receipt.refusal.message);
    replayed.add(refusal);
    throw refusal;
  }
  if (receipt?.state === 'conflict')
    throw new OrcaopsError(
      ErrorCodes.IDEMPOTENCY_CONFLICT,
      `idempotency_key="${input.idempotencyKey}" was refused by a prior capture with a different payload. Use a fresh key.`,
      'idempotency_key'
    );
}

/**
 * Retires the admission behind a refused capture when it has one — only the boundary
 * publishing verbs do — and retains the refusal. Both are secondary to reporting it, so
 * a failure here never replaces the precondition refusal the caller is about to raise.
 */
export async function retainStaleCaptureRefusal(
  handle: ProjectDatabase,
  context: DatabaseCaptureCommandContext,
  input: {
    artifactId: string;
    eventType: string;
    idempotencyKey: string;
    replayPayload: unknown;
    operationId: string;
    command: string;
    options: ProjectOperationOptions;
  }
): Promise<void> {
  try {
    const records = readProjectGitRetention(handle, input.operationId).value;
    if (records && records.current.kind === 'prepared')
      await retireProjectGitRetention(
        handle,
        {
          operationId: uuidv7(),
          originalOperationId: input.operationId,
          expectedTransitionId: records.current.transitionId,
          transitionId: uuidv7(),
          reason: 'The capture expected an artifact revision another writer advanced',
          secretAllow: [...context.config.redact.allow],
        },
        input.options
      );
    const retained = readProjectArtifact(handle, input.artifactId);
    if (!retained) return;
    await recordDatabaseCaptureRefusal(
      handle,
      {
        artifactId: input.artifactId,
        artifactRevision: retained.revision,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
        replayPayload: input.replayPayload,
        refusal: { code: 'STALE_CONTEXT', message: STALE_CAPTURE_REFUSAL },
        command: input.command,
        secretAllow: context.config.redact.allow,
      },
      input.options
    );
  } catch {
    // The precondition refusal is the primary outcome; a failed receipt never masks it.
  }
}
