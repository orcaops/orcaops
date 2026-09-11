import {
  BlockedError,
  CaptureSummaryInputSchema,
  OpenCheckpointsPendingError,
  WarningAcceptanceInvalidError,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { prepareDatabaseCapture } from '../../lib/database-capture-context.js';
import {
  type CaptureCloudSyncDeps,
  finalizeDatabaseSummary,
} from '../../lib/database-capture-finalize.js';
import { translateDatabaseCaptureError } from '../../lib/database-capture-response.js';
import { captureDatabaseExisting } from '../../lib/database-existing-capture.js';
import { closeFailedHistoryRead } from '../../lib/history-reader-close.js';
import { runCapture } from '../../lib/run-capture.js';

export interface CaptureSummaryOptions {
  input?: string;
}

/** Storage gates surface as the public codes the file era used; storage does not know the CLI registry. */
function translateSummaryGate(cause: unknown): unknown {
  if (cause instanceof BlockedError) return new OrcaopsError(ErrorCodes.BLOCKED, cause.message);
  if (cause instanceof OpenCheckpointsPendingError)
    return new OrcaopsError(ErrorCodes.INVALID_INPUT, cause.message);
  if (cause instanceof WarningAcceptanceInvalidError)
    return new OrcaopsError(ErrorCodes.INVALID_INPUT, cause.message, cause.path);
  return translateDatabaseCaptureError(cause);
}

export async function captureSummary(
  opts: CaptureSummaryOptions,
  signal: AbortSignal,
  deps: CaptureCloudSyncDeps = {}
) {
  const prepared = await prepareDatabaseCapture({
    parse: async () =>
      CaptureSummaryInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    signal,
  });
  const { context, input } = prepared;
  try {
    const captured = await captureDatabaseExisting('summary', prepared, signal);
    const { writer, result } = captured;
    let failed = false;
    try {
      if (result.outcome === 'conflict')
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior summary capture with a structurally-different payload (prior event_id=${result.priorEventId}). Use a fresh key — the prior decision stands.`,
          'idempotency_key'
        );
      return await finalizeDatabaseSummary({
        captured,
        idempotencyKey: input.idempotency_key,
        secretWarnings: prepared.secretWarnings,
        openCloudSyncSession: deps.openCloudSyncSession,
        cloud: deps.cloud,
      });
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

export async function captureSummaryAction(opts: CaptureSummaryOptions = {}): Promise<void> {
  await runCapture(async () => {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    try {
      return await captureSummary(opts, controller.signal);
    } catch (cause) {
      throw translateSummaryGate(cause);
    } finally {
      process.off('SIGINT', interrupt);
    }
  });
}
