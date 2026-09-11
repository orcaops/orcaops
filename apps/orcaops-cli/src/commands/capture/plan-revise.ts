import {
  CapturePlanReviseInputSchema,
  criterionMoveWarnings,
  criterionRewordWarnings,
  type Plan,
} from '@orcaops/storage';

import { ErrorCodes, InfoCodes, OrcaopsError } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { captureFailure } from '../../lib/canonical-capture-outcome.js';
import { toSecretWarningReports } from '../../lib/cloud-secret-gate.js';
import { prepareDatabaseCapture } from '../../lib/database-capture-context.js';
import {
  databaseCaptureNextActions,
  translateDatabaseCaptureError,
} from '../../lib/database-capture-response.js';
import { syncDatabaseCapture } from '../../lib/database-capture-sync.js';
import {
  type DatabaseLifecycleEvaluation,
  publishDatabaseLifecycleCompletion,
  readDatabaseLifecycleCompletion,
  runDatabaseLifecycleEvaluators,
} from '../../lib/database-evaluators.js';
import { captureDatabaseExisting } from '../../lib/database-existing-capture.js';
import { stampDatabaseUsage } from '../../lib/database-usage-stamp.js';
import { closeFailedHistoryRead } from '../../lib/history-reader-close.js';
import { getInvocationCwd } from '../../lib/invocation-context.js';
import { runCapture } from '../../lib/run-capture.js';
import { lifecycleUsageStamp } from '../../lib/usage-stamp.js';

export interface CapturePlanReviseOptions {
  input?: string;
  noLlm?: boolean;
}

interface RevisionLifecycle {
  status: 'complete' | 'replayed' | 'unavailable' | 'failed';
  evaluator_results: DatabaseLifecycleEvaluation['evaluator_results'];
  blocking: boolean;
  error?: ReturnType<typeof captureFailure>;
}

/**
 * A revision fires post-plan (every plan-aware evaluator re-validates the new
 * plan) and post-plan-revision (checks on the diff against the prior revision).
 */
async function evaluateRevision(
  captured: Awaited<ReturnType<typeof captureDatabaseExisting<'plan_revision'>>>,
  plan: Plan,
  noLlm: boolean | undefined
): Promise<RevisionLifecycle> {
  const { context, writer, artifactId, options } = captured;
  const key = { firesAt: 'post-plan-revision' as const, cpN: plan.revision_n };
  if (readDatabaseLifecycleCompletion(writer, artifactId, key))
    return { status: 'replayed', evaluator_results: [], blocking: false };
  try {
    const shared = {
      context,
      handle: writer,
      artifactId,
      planOverride: plan,
      noLlm,
      explicitTarget: true,
      options,
    };
    const postPlan = await runDatabaseLifecycleEvaluators({ ...shared, firesAt: 'post-plan' });
    // No priorPlanOverride: the revision evaluators compare against the immediately
    // prior revision, which the bridge reads back from the retained thread.
    const priorPlan = await runDatabaseLifecycleEvaluators({
      ...shared,
      firesAt: 'post-plan-revision',
    });
    await publishDatabaseLifecycleCompletion(
      writer,
      {
        artifactId,
        key,
        triggeredAt: new Date().toISOString(),
        command: 'capture plan revise',
        secretAllow: context.config.redact.allow,
        mode: 'once',
      },
      options
    );
    return {
      status: 'complete',
      evaluator_results: [...postPlan.evaluator_results, ...priorPlan.evaluator_results],
      blocking: postPlan.blocking || priorPlan.blocking,
    };
  } catch (cause) {
    return {
      status: 'failed',
      evaluator_results: [],
      blocking: false,
      error: captureFailure(cause),
    };
  }
}

async function capturePlanRevision(opts: CapturePlanReviseOptions, signal: AbortSignal) {
  const prepared = await prepareDatabaseCapture({
    parse: async () =>
      CapturePlanReviseInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    signal,
  });
  const { context, input } = prepared;
  try {
    const captured = await captureDatabaseExisting('plan_revision', prepared, signal);
    const { writer, artifactId, result, options } = captured;
    let failed = false;
    try {
      if (result.outcome === 'conflict')
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior revision with a different payload. Use a fresh key.`,
          'idempotency_key'
        );
      const replayed = result.outcome === 'replay';
      // A replayed key names an older revision; its evaluators completed (or not) back
      // then, so only the latest revision's missing completion is resumed here.
      const latest = captured.appended.before.thread.plan;
      const lifecycle: RevisionLifecycle =
        replayed && latest && latest.revision_n !== result.plan.revision_n
          ? { status: 'unavailable', evaluator_results: [], blocking: false }
          : await evaluateRevision(captured, result.plan, opts.noLlm);
      const usage = replayed
        ? { state: 'skipped' as const, reason: 'replay' as const }
        : await stampDatabaseUsage(
            writer,
            {
              descriptor: lifecycleUsageStamp({
                event: 'plan_revision',
                artifactId,
                baselineHint: 'prior_same_artifact',
                asOf: result.plan.revised_at ?? new Date().toISOString(),
                discriminator: result.plan.revision_n,
              }),
              invokingAgent: context.invokingAgent.agent,
              env: context.env,
              cwd: getInvocationCwd(),
              secretAllow: context.config.redact.allow,
            },
            options
          );
      const nextActions = await databaseCaptureNextActions(context, writer, artifactId, {
        offerPlanApproval: true,
      });
      const warnings = toSecretWarningReports(prepared.secretWarnings);
      return {
        artifact_id: artifactId,
        revision_n: result.plan.revision_n,
        plan_event_id: result.priorEventId,
        idempotency_status: replayed ? ('replay' as const) : ('created' as const),
        ...(replayed
          ? {
              code: InfoCodes.IDEMPOTENT_REPLAY,
              message:
                `Returning prior plan revision_n=${result.plan.revision_n} for idempotency_key="${input.idempotency_key}"; ` +
                (lifecycle.status === 'complete'
                  ? 'missing post-event evaluator work was resumed.'
                  : lifecycle.status === 'unavailable'
                    ? 'historical evaluator completion is unavailable, so no evaluators reran.'
                    : lifecycle.status === 'failed'
                      ? 'resuming the missing post-event evaluator work failed; see lifecycle.error.'
                      : 'no new evaluators ran.'),
            }
          : {}),
        label: result.plan.label,
        plan_steps: result.plan.plan_steps.map((step, idx) => ({
          step_id: step.step_id,
          idx: idx + 1,
          label: step.label,
          text: step.text,
          acceptance_criteria: step.acceptance_criteria,
        })),
        step_lineage: result.plan.step_lineage,
        criterion_lineage: result.plan.criterion_lineage,
        warnings: replayed ? [] : criterionRewordWarnings(result.plan),
        criterion_move_warnings: replayed ? [] : criterionMoveWarnings(result.plan),
        operation_id: captured.operationId,
        capture_status: 'committed' as const,
        evaluator_results: lifecycle.evaluator_results,
        blocking: lifecycle.blocking,
        lifecycle: {
          status: lifecycle.status,
          ...(lifecycle.error ? { error: lifecycle.error } : {}),
        },
        usage,
        cloud_sync: await syncDatabaseCapture(context, writer, artifactId, {
          ...options,
          replayed: replayed,
        }),
        next_actions: nextActions,
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

export async function capturePlanReviseAction(opts: CapturePlanReviseOptions = {}): Promise<void> {
  await runCapture(async () => {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    try {
      return await capturePlanRevision(opts, controller.signal);
    } catch (cause) {
      throw translateDatabaseCaptureError(cause);
    } finally {
      process.off('SIGINT', interrupt);
    }
  });
}
