import {
  CapturePlanReviseInputSchema,
  criterionMoveWarnings,
  criterionRewordWarnings,
  type Plan,
} from '@orcaops/storage';

import { ErrorCodes, InfoCodes, OrcaopsError } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import {
  hasLifecycleCompletion,
  recordLifecycleCompletion,
  runLifecycleEvaluators,
} from '../../lib/evaluator-bridge.js';
import { runCaptureWithSync } from '../../lib/run-capture.js';
import { lifecycleUsageStamp } from '../../lib/usage-stamp.js';

export interface CapturePlanReviseOptions {
  input?: string;
  noLlm?: boolean;
}

/**
 * `orcaops capture plan revise` — append-only plan revision. Three-
 * outcome idempotency on the `plan_revised` event_type. The agent
 * supplies a complete new `plan_steps[]` (full supersede), each
 * entry carrying an optional `step_id` to preserve identity for
 * carryovers / rewrites; absent step_ids are server-minted.
 *
 * Storage owns the six validation gates (artifact-finalized, schema
 * invariants, stale-token, carryover-exists, open-cp scope-loss,
 * unacknowledged closed-cp drops) — see ArtifactStore.revisePlan.
 *
 * On success, fires both `post-plan` (every plan-aware evaluator
 * re-validates the new plan) and `post-plan-revision` (revision-
 * specific evaluators that examine the diff itself).
 */
export async function capturePlanReviseAction(opts: CapturePlanReviseOptions = {}): Promise<void> {
  await runCaptureWithSync(
    async (ctx, input) => {
      const artifact = ctx.store.store.getArtifact(input.artifact_id);
      if (!artifact) {
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact with id "${input.artifact_id}". Call \`orcaops capture plan\` first ` +
            `to create the initial plan; revisions cannot precede the initial capture.`
        );
      }

      const result = await ctx.store.revisePlan(input, {
        idempotencyKey: input.idempotency_key,
        // Runtime provenance (options, not input — never payload-spoofable);
        // lands as `revised_by_agent` on the new plan revision.
        invokedByAgent: ctx.invokingAgent.agent,
      });

      if (result.outcome === 'conflict') {
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior revision with a ` +
            `different payload. Use a fresh key.`,
          'idempotency_key'
        );
      }

      if (result.outcome === 'replay') {
        const completionKey = {
          artifactId: input.artifact_id,
          firesAt: 'post-plan-revision' as const,
          sequenceN: result.plan.revision_n,
        };
        const completionMissing = !hasLifecycleCompletion(ctx, completionKey);
        let resumedPostEventWork = false;
        let skippedHistoricalResume = false;
        if (completionMissing) {
          const latestPlan = await ctx.store.readPlan(input.artifact_id);
          if (latestPlan !== null && latestPlan.revision_n !== result.plan.revision_n) {
            skippedHistoricalResume = true;
          } else {
            const priorPlan = await readPriorPlan(ctx, result.plan);
            await runPlanRevisionEvaluators(ctx, result.plan, priorPlan, opts.noLlm);
            await recordLifecycleCompletion(ctx, completionKey);
            resumedPostEventWork = true;
          }
        }
        return {
          artifact_id: input.artifact_id,
          revision_n: result.plan.revision_n,
          plan_event_id: result.priorEventId,
          idempotency_status: 'replay',
          code: InfoCodes.IDEMPOTENT_REPLAY,
          message:
            `Returning prior plan revision_n=${result.plan.revision_n} for ` +
            (resumedPostEventWork
              ? `idempotency_key="${input.idempotency_key}"; missing post-event evaluator ` +
                `work was resumed.`
              : skippedHistoricalResume
                ? `idempotency_key="${input.idempotency_key}"; historical evaluator completion ` +
                  `is unavailable, so no evaluators reran.`
                : `idempotency_key="${input.idempotency_key}"; no new evaluators ran.`),
        };
      }

      // Run post-plan evaluators (re-validate the new plan against
      // every plan-aware evaluator) AND post-plan-revision evaluators
      // (revision-specific checks on the diff).
      const priorPlan = await readPriorPlan(ctx, result.plan);
      const { evaluator_results, blocking } = await runPlanRevisionEvaluators(
        ctx,
        result.plan,
        priorPlan,
        opts.noLlm
      );
      await recordLifecycleCompletion(ctx, {
        artifactId: input.artifact_id,
        firesAt: 'post-plan-revision',
        sequenceN: result.plan.revision_n,
      });

      return {
        artifact_id: input.artifact_id,
        revision_n: result.plan.revision_n,
        plan_event_id: result.priorEventId,
        label: result.plan.label,
        plan_steps: result.plan.plan_steps.map((s, idx) => ({
          step_id: s.step_id,
          idx: idx + 1,
          label: s.label,
          text: s.text,
          acceptance_criteria: s.acceptance_criteria,
        })),
        step_lineage: result.plan.step_lineage,
        // criterion_lineage + warnings ride the `created` path only — computed once,
        // when the revision is first created. A `replay` returns just the idempotent-
        // replay envelope (no plan, no warnings) and a `conflict` returns no plan, so
        // a same-key retry does NOT re-surface the advisory; the agent is expected to
        // have seen it on the original `created` response.
        criterion_lineage: result.plan.criterion_lineage,
        warnings: criterionRewordWarnings(result.plan),
        // Non-blocking advisory for identical-text cross-step moves. It has a
        // dedicated field so the existing reword-warning contract stays stable
        // and, like that advisory, appears only on the created path.
        criterion_move_warnings: criterionMoveWarnings(result.plan),
        idempotency_status: 'created' as const,
        evaluator_results,
        blocking,
        // Stamp usage on the created revision only; the replay arm above returns
        // earlier without this field, so a re-applied revision never re-stamps.
        usageStamp: lifecycleUsageStamp({
          event: 'plan_revision',
          artifactId: input.artifact_id,
          baselineHint: 'prior_same_artifact',
          asOf: result.plan.revised_at ?? new Date().toISOString(),
          discriminator: result.plan.revision_n,
        }),
      };
    },
    {
      parseInput: async () =>
        CapturePlanReviseInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    }
  );
}

async function runPlanRevisionEvaluators(
  ctx: Parameters<typeof runLifecycleEvaluators>[0]['ctx'],
  plan: Plan,
  priorPlan: Plan | null,
  noLlm: boolean | undefined
): Promise<{
  evaluator_results: Awaited<ReturnType<typeof runLifecycleEvaluators>>['evaluator_results'];
  blocking: boolean;
}> {
  const postPlanResults = await runLifecycleEvaluators({
    ctx,
    artifactId: plan.artifact_id,
    firesAt: 'post-plan',
    planOverride: plan,
    noLlm,
  });
  const postRevisionResults = await runLifecycleEvaluators({
    ctx,
    artifactId: plan.artifact_id,
    firesAt: 'post-plan-revision',
    planOverride: plan,
    priorPlanOverride: priorPlan,
    noLlm,
  });
  return {
    evaluator_results: [
      ...postPlanResults.evaluator_results,
      ...postRevisionResults.evaluator_results,
    ],
    blocking: postPlanResults.blocking || postRevisionResults.blocking,
  };
}

async function readPriorPlan(
  ctx: Parameters<typeof runLifecycleEvaluators>[0]['ctx'],
  plan: Plan
): Promise<Plan | null> {
  return plan.revision_n > 0
    ? ctx.store.readPlanRevision(plan.artifact_id, plan.revision_n - 1)
    : null;
}
