import type { SecretFinding } from '@orcaops/storage';

import { toSecretWarningReports } from './cloud-secret-gate.js';
import {
  clearDatabaseCaptureFocus,
  type DatabaseCaptureFocusOutcome,
} from './database-capture-focus.js';
import { databaseCaptureNextActions } from './database-capture-response.js';
import { type CaptureCloudSyncDeps, syncDatabaseCapture } from './database-capture-sync.js';
import { renderDatabaseArtifactDigest } from './database-digest.js';
import type { DatabaseExistingCapture } from './database-existing-capture.js';
import { stampDatabaseUsage } from './database-usage-stamp.js';
import { getInvocationCwd } from './invocation-context.js';
import { lifecycleUsageStamp } from './usage-stamp.js';
import { InfoCodes } from '../io/errors.js';

export type { CaptureCloudSyncDeps, CaptureCloudSyncSession } from './database-capture-sync.js';

/**
 * The tail both `capture summary` and `finish` run once a summary is committed:
 * clear the session focus, stamp usage, render the digest, sync to the cloud, shape
 * the response. Keeping it in one place is why the replay skip cannot drift between
 * the two — a replay is a pure read of the retained receipt, so it moves no focus row
 * and no usage row, and records no cloud sync (all writes). The digest render is itself
 * a pure read that caches nothing, so a replay renders it exactly like a fresh run —
 * returning or repairing the digest the way the file era did — rather than skipping it.
 */
export interface FinalizeDatabaseSummaryInput {
  captured: DatabaseExistingCapture<'summary'>;
  idempotencyKey: string;
  secretWarnings: readonly SecretFinding[];
  /** Optional test seam; production connects through the registered context and caller-owned writer. */
  openCloudSyncSession?: CaptureCloudSyncDeps['openCloudSyncSession'];
  cloud?: CaptureCloudSyncDeps['cloud'];
  /** Command-specific fields spliced ahead of the shared tail (finish carries review_id and evaluator_results). */
  extra?: Record<string, unknown>;
}

type DigestFinalization =
  | {
      finalization_status: 'finalized';
      digest: { status: 'current'; artifact_id: string; markdown: string; action: string };
    }
  | {
      finalization_status: 'finalized_without_digest';
      digest: { status: 'failed'; message: string; action: string };
    };

async function finalizeDigest(
  captured: DatabaseExistingCapture<'summary'>
): Promise<DigestFinalization> {
  const { context, artifactId } = captured;
  try {
    const rendered = await renderDatabaseArtifactDigest(
      { scope: context.scope, config: context.config },
      artifactId,
      context.env,
      context.registered.git.worktreeRoot
    );
    return {
      finalization_status: 'finalized',
      digest: {
        status: 'current',
        artifact_id: artifactId,
        markdown: rendered.markdown,
        action: `orcaops digest --artifact ${artifactId}`,
      },
    };
  } catch {
    // The summary is already committed; a digest read that fails must not undo it.
    return {
      finalization_status: 'finalized_without_digest',
      digest: {
        status: 'failed',
        message: 'The summary was saved, but digest generation failed.',
        action: `orcaops digest --artifact ${artifactId}`,
      },
    };
  }
}

export async function finalizeDatabaseSummary(
  input: FinalizeDatabaseSummaryInput
): Promise<Record<string, unknown>> {
  const { captured, idempotencyKey, secretWarnings, extra = {} } = input;
  const { context, writer, artifactId, result, operationId, options } = captured;
  const replayed = result.outcome === 'replay';

  const focus: DatabaseCaptureFocusOutcome = replayed
    ? { state: 'skipped', reason: 'replay' }
    : await clearDatabaseCaptureFocus(
        writer,
        {
          registered: context.registered,
          shellKey: context.shellKey,
          artifactId,
          secretAllow: context.config.redact.allow,
        },
        options
      );

  const usage = replayed
    ? { state: 'skipped' as const, reason: 'replay' as const }
    : await stampDatabaseUsage(
        writer,
        {
          descriptor: lifecycleUsageStamp({
            event: 'summary',
            artifactId,
            baselineHint: 'prior_same_artifact',
            asOf: result.summary.ts,
            discriminator: idempotencyKey,
          }),
          invokingAgent: context.invokingAgent.agent,
          env: context.env,
          cwd: getInvocationCwd(),
          secretAllow: context.config.redact.allow,
        },
        options
      );

  const finalization = await finalizeDigest(captured);

  const cloudSync = await syncDatabaseCapture(
    context,
    writer,
    artifactId,
    { ...options, replayed },
    { openCloudSyncSession: input.openCloudSyncSession, cloud: input.cloud }
  );

  const nextActions = await databaseCaptureNextActions(context, writer, artifactId);
  const warnings = toSecretWarningReports(secretWarnings);

  return {
    artifact_id: artifactId,
    ...extra,
    ...(result.event_id !== undefined ? { summary_event_id: result.event_id } : {}),
    completed_at: result.summary.ts,
    idempotency_status: replayed ? ('replay' as const) : ('created' as const),
    ...(replayed
      ? {
          code: InfoCodes.IDEMPOTENT_REPLAY,
          message: `Returning prior summary for idempotency_key="${idempotencyKey}".`,
        }
      : {}),
    operation_id: operationId,
    capture_status: 'committed' as const,
    ...finalization,
    usage,
    focus,
    cloud_sync: cloudSync,
    next_actions: nextActions,
    ...(warnings.length ? { secret_warnings: warnings } : {}),
  };
}
