import { CapturePrePrCheckInputSchema, uuidv7 } from '@orcaops/storage';

import { readPayloadInput } from '../../io/input.js';
import { toSecretWarningReports } from '../../lib/cloud-secret-gate.js';
import {
  openDatabaseCaptureWriter,
  prepareDatabaseCapture,
  selectDatabaseCaptureArtifact,
} from '../../lib/database-capture-context.js';
import {
  databaseCaptureNextActions,
  translateDatabaseCaptureError,
} from '../../lib/database-capture-response.js';
import { syncDatabaseCapture } from '../../lib/database-capture-sync.js';
import { runDatabasePrePrPass } from '../../lib/database-pre-pr-pass.js';
import { stampDatabaseUsage } from '../../lib/database-usage-stamp.js';
import { closeFailedHistoryRead } from '../../lib/history-reader-close.js';
import { getInvocationCwd } from '../../lib/invocation-context.js';
import { runCapture } from '../../lib/run-capture.js';
import { lifecycleUsageStamp } from '../../lib/usage-stamp.js';

export interface CapturePrePrCheckOptions {
  input?: string;
  noLlm?: boolean;
}

/**
 * Final pre-PR evaluator pass. The gate, the evaluator run, the completion and the
 * marker are shared with `finish`, which runs the same pass before its summary.
 */
async function prePrCheck(opts: CapturePrePrCheckOptions, signal: AbortSignal) {
  const prepared = await prepareDatabaseCapture({
    parse: async () =>
      CapturePrePrCheckInputSchema.parse(
        await readPayloadInput({ inputPath: opts.input, allowEmpty: true })
      ),
    signal,
  });
  const { context, input } = prepared;
  try {
    const writer = await openDatabaseCaptureWriter(context);
    let failed = false;
    try {
      const { artifactId } = selectDatabaseCaptureArtifact(writer, {
        explicitId: input.artifact_id,
        branch: context.registered.git.branch,
      });
      const options = { signal };
      const { evaluated, marker } = await runDatabasePrePrPass({
        context,
        handle: writer,
        artifactId,
        command: 'capture pre-pr-check',
        noLlm: opts.noLlm,
        explicitTarget: input.artifact_id !== undefined,
        options,
      });
      // Tokens were spent whether or not the pass blocked, and a stable key would
      // freeze cumulative usage at the first, lower read — so every invocation stamps.
      const usage = await stampDatabaseUsage(
        writer,
        {
          descriptor: lifecycleUsageStamp({
            event: 'pre_pr_check',
            artifactId,
            baselineHint: 'prior_same_artifact',
            asOf: new Date().toISOString(),
            discriminator: uuidv7(),
          }),
          invokingAgent: context.invokingAgent.agent,
          env: context.env,
          cwd: getInvocationCwd(),
          secretAllow: context.config.redact.allow,
        },
        options
      );
      const warnings = toSecretWarningReports(prepared.secretWarnings);
      return {
        artifact_id: artifactId,
        evaluator_results: evaluated.evaluator_results,
        blocking: evaluated.blocking,
        ...(evaluated.pre_pr_review === undefined
          ? {}
          : { pre_pr_review: evaluated.pre_pr_review }),
        review_id: marker?.event_id ?? null,
        pre_pr_outcome: marker?.outcome ?? null,
        usage,
        cloud_sync: await syncDatabaseCapture(context, writer, artifactId, {
          ...options,
          replayed: false,
        }),
        next_actions: await databaseCaptureNextActions(context, writer, artifactId),
        ...(warnings.length ? { secret_warnings: warnings } : {}),
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

export async function capturePrePrCheckAction(opts: CapturePrePrCheckOptions = {}): Promise<void> {
  await runCapture(async () => {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    try {
      return await prePrCheck(opts, controller.signal);
    } catch (cause) {
      throw translateDatabaseCaptureError(cause);
    } finally {
      process.off('SIGINT', interrupt);
    }
  });
}
