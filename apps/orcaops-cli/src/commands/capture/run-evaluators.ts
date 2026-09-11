import { CaptureRunEvaluatorsInputSchema } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import {
  openDatabaseCaptureWriter,
  prepareDatabaseCapture,
} from '../../lib/database-capture-context.js';
import { translateDatabaseCaptureError } from '../../lib/database-capture-response.js';
import { syncDatabaseCapture } from '../../lib/database-capture-sync.js';
import {
  publishDatabaseLifecycleCompletion,
  runDatabaseLifecycleEvaluators,
} from '../../lib/database-evaluators.js';
import { closeFailedHistoryRead } from '../../lib/history-reader-close.js';
import { runCapture } from '../../lib/run-capture.js';

export interface CaptureRunEvaluatorsOptions {
  input?: string;
  noLlm?: boolean;
}

/**
 * Explicit re-run of one lifecycle's evaluators against the retained thread. The
 * runs are appended as retained events and the completion is republished as a
 * further observation, so an explicit re-run never erases the original receipt.
 */
async function runEvaluators(opts: CaptureRunEvaluatorsOptions, signal: AbortSignal) {
  const prepared = await prepareDatabaseCapture({
    parse: async () =>
      CaptureRunEvaluatorsInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    signal,
  });
  const { context, input } = prepared;
  try {
    if (
      (input.fires_at === 'checkpoint-close' || input.fires_at === 'checkpoint-open') &&
      input.checkpoint_n === undefined
    )
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `\`checkpoint_n\` is required when \`fires_at\` is "${input.fires_at}".`,
        'checkpoint_n'
      );
    const writer = await openDatabaseCaptureWriter(context);
    let failed = false;
    try {
      const retained = readProjectArtifact(writer, input.artifact_id);
      if (!retained)
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact with id "${input.artifact_id}".`
        );
      const evaluatorCheckpointN =
        input.fires_at === 'checkpoint-close' || input.fires_at === 'checkpoint-open'
          ? input.checkpoint_n
          : undefined;
      const sequenceN =
        input.fires_at === 'post-plan-revision'
          ? (retained.thread.plan?.revision_n ?? 0)
          : (evaluatorCheckpointN ?? 0);
      const options = { signal };
      const evaluated = await runDatabaseLifecycleEvaluators({
        context,
        handle: writer,
        artifactId: input.artifact_id,
        firesAt: input.fires_at,
        checkpointN: evaluatorCheckpointN,
        noLlm: opts.noLlm,
        explicitTarget: true,
        options,
      });
      const completion = await publishDatabaseLifecycleCompletion(
        writer,
        {
          artifactId: input.artifact_id,
          key: { firesAt: input.fires_at, cpN: sequenceN },
          triggeredAt: new Date().toISOString(),
          command: 'capture run-evaluators',
          secretAllow: context.config.redact.allow,
          mode: 'replace',
        },
        options
      );
      // Deliberately no next_actions: an ad-hoc re-evaluation is not a lifecycle
      // transition, and the blocked-to-resolved loop closes through block acknowledge.
      return {
        artifact_id: input.artifact_id,
        fires_at: input.fires_at,
        evaluator_results: evaluated.evaluator_results,
        blocking: evaluated.blocking,
        ...(evaluated.pre_pr_review === undefined
          ? {}
          : { pre_pr_review: evaluated.pre_pr_review }),
        lifecycle: { status: completion.state },
        cloud_sync: await syncDatabaseCapture(context, writer, input.artifact_id, {
          ...options,
          replayed: false,
        }),
      };
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

export async function captureRunEvaluatorsAction(
  opts: CaptureRunEvaluatorsOptions = {}
): Promise<void> {
  await runCapture(async () => {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    try {
      return await runEvaluators(opts, controller.signal);
    } catch (cause) {
      throw translateDatabaseCaptureError(cause);
    } finally {
      process.off('SIGINT', interrupt);
    }
  });
}
