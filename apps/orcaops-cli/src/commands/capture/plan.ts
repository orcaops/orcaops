import { resolveReviewBaseline, sourcePlanView } from '@orcaops/core';
import { captureDatabasePlan } from '@orcaops/core/history/database-capture';
import {
  canonicalSourcePlanRefId,
  type CapturePlanInput,
  CapturePlanInputSchema,
  resolveCaptureExcludes,
  rubricCoverage,
  rubricCoverageSentence,
  type SecretFinding,
  type SourcePlanPin,
  SourcePlanPinSchema,
} from '@orcaops/storage';
import {
  planCaptureCommand,
  preparePlanCaptureInput,
  ProjectDatabaseError,
  readProjectArtifact,
  readProjectPlanCapture,
} from '@orcaops/storage/history/database';

import { InfoCodes } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { writeTerminalSafeStderr } from '../../io/output.js';
import { captureFailure } from '../../lib/canonical-capture-outcome.js';
import { toSecretWarningReports } from '../../lib/cloud-secret-gate.js';
import {
  type DatabaseCaptureCommandContext,
  openDatabaseCaptureWriter,
  prepareDatabaseCapture,
  refuseCaptureInput,
} from '../../lib/database-capture-context.js';
import {
  type DatabaseCaptureFocusOutcome,
  focusDatabaseCapture,
} from '../../lib/database-capture-focus.js';
import {
  databaseCaptureNextActions,
  translateDatabaseCaptureError,
} from '../../lib/database-capture-response.js';
import { syncDatabaseCapture } from '../../lib/database-capture-sync.js';
import {
  publishDatabaseLifecycleCompletion,
  readDatabaseLifecycleCompletion,
  runDatabaseLifecycleEvaluators,
} from '../../lib/database-evaluators.js';
import { databaseSourcePlanLookup } from '../../lib/database-source-plan-resolver.js';
import { stampDatabaseUsage } from '../../lib/database-usage-stamp.js';
import { closeFailedHistoryRead } from '../../lib/history-reader-close.js';
import { getInvocationCwd } from '../../lib/invocation-context.js';
import { runCapture } from '../../lib/run-capture.js';
import { resolveSourcePlan } from '../../lib/source-plan-resolver.js';
import { usageStampKey } from '../../lib/usage-stamp.js';

export interface CapturePlanOptions {
  input?: string;
  noLlm?: boolean;
  /** `--source-plan <ref>`: a local path whose content is read, hashed and pinned immutably. */
  sourcePlan?: string;
}

interface AssembledPlan extends CapturePlanInput {
  branch: string;
  source_plan: SourcePlanPin | null;
}

/**
 * A cloud ref resolves through the project history that `orcaops plan pull` retains; a
 * local ref resolves through the filesystem. The resolver leaves a cloud pin's baseline
 * null — its authoring baseline already lives cloud-side from `plan upload` — so only a
 * local pin merges the current review baseline.
 */
async function resolvePlanPin(
  ref: string,
  context: DatabaseCaptureCommandContext
): Promise<{ pin: SourcePlanPin; warnings: readonly SecretFinding[] }> {
  const resolved = await resolveSourcePlan(
    ref,
    context.registered.git.worktreeRoot,
    context.config.redact.allow,
    databaseSourcePlanLookup(context.project.database)
  );
  const baseline =
    resolved.pin.source_ref.kind === 'cloud'
      ? resolved.pin.baseline
      : await resolveReviewBaseline(context.repo);
  return {
    pin: SourcePlanPinSchema.parse({ ...resolved.pin, baseline }),
    warnings: resolved.secretWarnings.map((finding) => ({
      ...finding,
      path: `source_plan.${finding.path}`,
    })),
  };
}

async function captureDatabasePlanCommand(opts: CapturePlanOptions, signal: AbortSignal) {
  let pinWarnings: readonly SecretFinding[] = [];
  const prepared = await prepareDatabaseCapture<CapturePlanInput, AssembledPlan>({
    parse: async () =>
      CapturePlanInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    // `capture plan` is the only verb that can start history, so it is the only one that
    // refuses a fresh repository's authored payload before anything is initialized.
    initialize: async (raw, repository) => {
      const allow = repository.config.redact.allow;
      refuseCaptureInput(raw, allow);
      refuseCaptureInput({ ...raw, branch: raw.branch ?? repository.branch ?? 'HEAD' }, allow);
      // A bad pin — local or cloud — aborts here, before any history is initialized.
      if (opts.sourcePlan)
        await resolveSourcePlan(
          opts.sourcePlan,
          repository.worktreeRoot,
          allow,
          opts.sourcePlan.startsWith('cloud:') ? async () => [] : undefined
        );
      return [raw];
    },
    assemble: async (raw, context) => {
      const resolved = opts.sourcePlan ? await resolvePlanPin(opts.sourcePlan, context) : null;
      pinWarnings = resolved?.warnings ?? [];
      return {
        ...raw,
        branch: raw.branch ?? context.registered.git.branch ?? 'HEAD',
        source_plan: resolved?.pin ?? null,
      };
    },
    signal,
  });
  const { context, raw: authored, input } = prepared;
  try {
    if (signal.aborted)
      throw new ProjectDatabaseError(
        'CANCELLED',
        'Plan capture cancelled before opening the writer'
      );
    const allow = context.config.redact.allow;
    const sourcePlan = input.source_plan;
    let waiting = false;
    const options = {
      signal,
      onWait: () => {
        if (waiting) return;
        waiting = true;
        writeTerminalSafeStderr(
          'Waiting for plan capture on the selected project database; Ctrl-C cancels the wait.\n'
        );
      },
    };
    const writer = await openDatabaseCaptureWriter(context);
    let failed = false;
    try {
      const captured = await captureDatabasePlan(
        writer,
        context.registered,
        {
          authored,
          sourcePlan,
          agent: context.invokingAgent.agent,
          snapshot: {
            enabled: context.config.diff_fingerprint.enabled,
            excludePatterns: [...resolveCaptureExcludes(context.config.capture).patterns],
          },
          secretAllow: [...allow],
        },
        options
      );
      const artifactId = captured.artifactId;
      const receipt = readProjectPlanCapture(
        writer,
        preparePlanCaptureInput({ authored, sourcePlan }, allow)
      );
      const retained = readProjectArtifact(writer, artifactId);
      if (!retained?.thread.plan)
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The captured plan is not readable from project history; preserve it for explicit repair'
        );
      const plan = retained.thread.plan;
      const captureCoverage = rubricCoverage(plan);
      const key = { firesAt: 'post-plan' as const, cpN: 0 };
      let lifecycle: {
        status: 'complete' | 'replayed' | 'failed';
        evaluator_results: Awaited<
          ReturnType<typeof runDatabaseLifecycleEvaluators>
        >['evaluator_results'];
        blocking: boolean;
        error?: ReturnType<typeof captureFailure>;
      } = { status: 'replayed', evaluator_results: [], blocking: false };
      if (!readDatabaseLifecycleCompletion(writer, artifactId, key)) {
        try {
          const evaluated = await runDatabaseLifecycleEvaluators({
            context,
            handle: writer,
            artifactId,
            firesAt: 'post-plan',
            noLlm: opts.noLlm,
            explicitTarget: true,
            options,
          });
          await publishDatabaseLifecycleCompletion(
            writer,
            {
              artifactId,
              key,
              triggeredAt: new Date().toISOString(),
              command: 'capture plan',
              secretAllow: allow,
              mode: 'once',
            },
            options
          );
          lifecycle = {
            status: 'complete',
            evaluator_results: evaluated.evaluator_results,
            blocking: evaluated.blocking,
          };
        } catch (cause) {
          lifecycle = {
            status: 'failed',
            evaluator_results: [],
            blocking: false,
            error: captureFailure(cause),
          };
        }
      }
      const sourcePlanRefId = sourcePlan
        ? canonicalSourcePlanRefId({ source_ref: sourcePlan.source_ref, hash: sourcePlan.hash })
        : null;
      const usage = captured.replayed
        ? { state: 'skipped' as const, reason: 'replay' as const }
        : await stampDatabaseUsage(
            writer,
            {
              descriptor: {
                lifecycle_event: 'plan',
                artifactId,
                baselineHint: 'prior_same_artifact',
                asOf: plan.started_at,
                stableEventId: usageStampKey(artifactId, 'plan', 0),
              },
              invokingAgent: context.invokingAgent.agent,
              env: context.env,
              cwd: getInvocationCwd(),
              secretAllow: allow,
              sourcePlanLinks: sourcePlanRefId
                ? [
                    {
                      canonical_ref_id: sourcePlanRefId,
                      artifact_id: artifactId,
                      linked_at: plan.started_at,
                      pinned_version:
                        sourcePlan?.source_ref.kind === 'cloud'
                          ? sourcePlan.source_ref.version
                          : null,
                      idempotency_key: usageStampKey(sourcePlanRefId, 'link', artifactId),
                    },
                  ]
                : [],
            },
            options
          );
      // A replay is a read of the retained receipt: it must not move focus, and moving it
      // would also append an operation and advance the project counters.
      const focus: DatabaseCaptureFocusOutcome = captured.replayed
        ? { state: 'skipped', reason: 'replay' }
        : await focusDatabaseCapture(
            writer,
            {
              registered: context.registered,
              shellKey: context.shellKey,
              artifactId,
              secretAllow: allow,
            },
            options
          );
      if (focus.state === 'updated' && focus.displaced_artifact_id)
        writeTerminalSafeStderr(
          `note: session focus moved from ${focus.displaced_artifact_id} to ${artifactId}.\n`
        );
      const nextActions = await databaseCaptureNextActions(context, writer, artifactId, {
        offerPlanApproval: true,
      });
      const warnings = toSecretWarningReports([...prepared.secretWarnings, ...pinWarnings]);
      return {
        artifact_id: artifactId,
        branch: plan.branch,
        idempotency_status: captured.replayed ? ('replay' as const) : ('created' as const),
        ...(captured.replayed
          ? {
              code: InfoCodes.IDEMPOTENT_REPLAY,
              message:
                `Returning prior artifact for idempotency_key="${authored.idempotency_key}"; ` +
                (lifecycle.status === 'complete'
                  ? 'missing post-event evaluator work was resumed.'
                  : 'no new evaluators ran.'),
            }
          : {}),
        label: plan.label,
        plan_steps: plan.plan_steps.map((step, idx) => ({
          step_id: step.step_id,
          idx: idx + 1,
          text: step.text,
          label: step.label,
          acceptance_criteria: step.acceptance_criteria,
        })),
        revision_n: plan.revision_n,
        plan_event_id: captured.planEventId,
        // `plan` is the CURRENT retained plan, so a replayed capture after a
        // revision reports that later revision while plan_event_id stays the
        // original capture event. Deliberate and unchanged: the coverage block
        // carries revision_n, so the pairing is always legible.
        acceptance_criteria_coverage: captureCoverage,
        acceptance_criteria_status: rubricCoverageSentence(captureCoverage),
        source_plan: sourcePlanView(retained.thread.artifactJson?.source_plan ?? sourcePlan),
        operation_id:
          receipt?.kind === 'command'
            ? planCaptureCommand(receipt.command).originalOperationId
            : null,
        capture_status: 'committed' as const,
        historical: captured.historical,
        warnings: captured.warnings,
        evaluator_results: lifecycle.evaluator_results,
        blocking: lifecycle.blocking,
        lifecycle: {
          status: lifecycle.status,
          ...(lifecycle.error ? { error: lifecycle.error } : {}),
        },
        usage,
        focus,
        cloud_sync: await syncDatabaseCapture(context, writer, artifactId, {
          ...options,
          replayed: captured.replayed,
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

export async function capturePlanAction(opts: CapturePlanOptions = {}): Promise<void> {
  await runCapture(async () => {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    try {
      return await captureDatabasePlanCommand(opts, controller.signal);
    } catch (cause) {
      throw translateDatabaseCaptureError(cause);
    } finally {
      process.off('SIGINT', interrupt);
    }
  });
}
