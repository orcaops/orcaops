import type { EvaluatorRunPayload } from '@orcaops/evaluator-protocol';
import {
  BlockedError,
  CaptureSummaryInputSchema,
  normalizeAcceptedWarnings,
  OpenCheckpointsPendingError,
  type SummaryInput,
  WarningAcceptanceInvalidError,
} from '@orcaops/storage';

import { extractSummaryReplayShape, maybeAutoClear } from './capture/summary.js';
import { ErrorCodes, InfoCodes, OrcaopsError } from '../io/errors.js';
import { readPayloadInput } from '../io/input.js';
import { resolveActiveArtifactId } from '../lib/active-artifact.js';
import type { CliContext } from '../lib/context.js';
import {
  buildEvaluatorContext,
  recordLifecycleCompletion,
  runLifecycleEvaluators,
} from '../lib/evaluator-bridge.js';
import { discoverEvaluatorsForCli } from '../lib/evaluator-discovery.js';
import { computePrePrReviewFingerprints } from '../lib/pre-pr-review.js';
import { runCaptureWithSync } from '../lib/run-capture.js';
import { lifecycleUsageStamp } from '../lib/usage-stamp.js';

export async function finishAction(opts: { input?: string; noLlm?: boolean } = {}): Promise<void> {
  await runCaptureWithSync(
    async (ctx, input) => {
      const { artifactId } = await resolveActiveArtifactId(ctx, {
        explicitId: input.artifact_id,
      });
      await assertNoOpenCheckpoints(ctx, artifactId);

      let evaluatorResults: EvaluatorRunPayload[] = [];
      let reviewId: string | null = input.accepted_warnings?.[0]?.review_id ?? null;
      const existingSummary = await ctx.store.readSummary(artifactId);
      if (existingSummary !== null) {
        // Let writeSummary decide replay, conflict, or explicit supersede below.
        // Re-running an LLM cannot improve an already-persisted summary and
        // would make digest-only recovery needlessly expensive.
      } else if (input.accepted_warnings !== undefined) {
        reviewId = input.accepted_warnings[0]!.review_id;
        await assertReviewCurrent(ctx, artifactId, reviewId);
      } else {
        const evaluated = await runLifecycleEvaluators({
          ctx,
          artifactId,
          firesAt: 'pre-pr',
          noLlm: opts.noLlm,
        });
        evaluatorResults = evaluated.evaluator_results;
        await ctx.store.withArtifactLock(artifactId, async () => {
          assertNoOpenCheckpointsNow(ctx, artifactId);
          await recordLifecycleCompletion(ctx, { artifactId, firesAt: 'pre-pr' });
        });
        const decision = classifyFinishPrePr(evaluatorResults, evaluated.blocking);
        if (decision.kind === 'blocked') {
          return {
            artifact_id: artifactId,
            status: 'blocked',
            blocking: true,
            evaluator_results: evaluatorResults,
          };
        }
        if (!evaluated.pre_pr_review) throw new Error('pre-pr review fingerprints are missing');
        const warningRuns = decision.kind === 'needs_attention' ? decision.runs : [];
        const marker = await ctx.store.writePrePrChecked(artifactId, {
          head_sha: await ctx.repo.getHeadSha(),
          outcome: warningRuns.length > 0 ? 'needs_attention' : 'passed',
          evaluator_set_fingerprint: evaluated.pre_pr_review.evaluator_set_fingerprint,
          review_context_fingerprint: evaluated.pre_pr_review.review_context_fingerprint,
          run_ids: evaluatorResults.map((run) => run.run_id),
        });
        reviewId = marker.event_id;
        if (decision.kind === 'needs_attention') {
          return {
            artifact_id: artifactId,
            status: 'needs_attention',
            review_id: reviewId,
            evaluator_results: evaluatorResults,
            acceptance_allowed: decision.acceptance_allowed,
            ...(decision.acceptance_allowed
              ? {
                  accepted_warnings: warningRuns.map((run) => ({
                    review_id: reviewId,
                    run_id: run.run_id,
                    evaluator_ref: run.evaluator_ref,
                    reason: '',
                  })),
                }
              : { action: 'Re-run finish; evaluator errors cannot be accepted.' }),
          };
        }
      }

      const ts = new Date().toISOString();
      const acceptedWarnings =
        input.accepted_warnings === undefined
          ? undefined
          : normalizeAcceptedWarnings(input.accepted_warnings);
      const summary: SummaryInput = {
        schema_version: 1,
        artifact_id: artifactId,
        agent: ctx.invokingAgent.agent,
        outcome: input.outcome,
        tests_written: input.tests_written,
        tests_run: input.tests_run,
        open_items: input.open_items,
        deferred_decisions: input.deferred_decisions,
        ...(acceptedWarnings === undefined ? {} : { accepted_warnings: acceptedWarnings }),
        head_sha: await ctx.repo.getHeadSha(),
        ts,
      };
      const replayPayload = {
        artifact_id: artifactId,
        outcome: input.outcome,
        tests_written: input.tests_written,
        tests_run: input.tests_run,
        open_items: input.open_items,
        deferred_decisions: input.deferred_decisions,
        ...(acceptedWarnings === undefined ? {} : { accepted_warnings: acceptedWarnings }),
      };
      let result;
      try {
        result = await ctx.store.writeSummary(summary, {
          idempotencyKey: input.idempotency_key,
          replayPayload,
          extractReplayShape: extractSummaryReplayShape,
          priorSummaryEventId: input.prior_summary_event_id,
        });
      } catch (error) {
        if (error instanceof BlockedError) {
          throw new OrcaopsError(ErrorCodes.BLOCKED, error.message);
        }
        if (
          error instanceof OpenCheckpointsPendingError ||
          error instanceof WarningAcceptanceInvalidError
        ) {
          throw new OrcaopsError(ErrorCodes.INVALID_INPUT, error.message);
        }
        throw error;
      }
      if (result.outcome === 'conflict') {
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          'The finish idempotency key was reused with a different summary.',
          'idempotency_key'
        );
      }
      await maybeAutoClear(ctx, artifactId);
      if (result.outcome === 'replay') {
        return {
          artifact_id: artifactId,
          completed_at: result.summary.ts,
          idempotency_status: 'replay',
          code: InfoCodes.IDEMPOTENT_REPLAY,
          renderFinalDigest: true,
        };
      }
      return {
        artifact_id: artifactId,
        review_id: reviewId,
        summary_event_id: result.event_id,
        evaluator_results: evaluatorResults,
        completed_at: ts,
        usageStamp: lifecycleUsageStamp({
          event: 'summary',
          artifactId,
          baselineHint: 'prior_same_artifact',
          asOf: ts,
          discriminator: input.idempotency_key,
        }),
        renderFinalDigest: true,
      };
    },
    {
      parseInput: async () =>
        CaptureSummaryInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    }
  );
}

export function classifyFinishPrePr(
  runs: readonly EvaluatorRunPayload[],
  blocking: boolean
):
  | { kind: 'blocked' }
  | { kind: 'clean' }
  | { kind: 'needs_attention'; runs: EvaluatorRunPayload[]; acceptance_allowed: boolean } {
  if (blocking) return { kind: 'blocked' };
  const attention = runs.filter(
    (run) =>
      run.severity === 'warn' &&
      (run.run_status === 'error' ||
        (run.run_status === 'completed' && run.verdict === 'violation'))
  );
  if (attention.length === 0) return { kind: 'clean' };
  return {
    kind: 'needs_attention',
    runs: attention,
    acceptance_allowed: !attention.some((run) => run.run_status === 'error'),
  };
}

async function assertNoOpenCheckpoints(ctx: CliContext, artifactId: string): Promise<void> {
  await ctx.store.withArtifactLock(artifactId, async () =>
    assertNoOpenCheckpointsNow(ctx, artifactId)
  );
}

function assertNoOpenCheckpointsNow(ctx: CliContext, artifactId: string): void {
  const open = ctx.store.store.getOpenCheckpoints(artifactId);
  if (open.length > 0) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Cannot finish while ${open.length} checkpoint(s) are open: ${open.map((checkpoint) => `#${checkpoint.n}`).join(', ')}.`
    );
  }
}

async function assertReviewCurrent(
  ctx: CliContext,
  artifactId: string,
  reviewId: string
): Promise<void> {
  const review = await ctx.store.readPrePrReview(artifactId, reviewId);
  if (!review || review.payload.outcome !== 'needs_attention') {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Warning review "${reviewId}" is missing or stale. Re-run finish.`
    );
  }
  const { evaluators } = await discoverEvaluatorsForCli(ctx.repoRoot);
  const eligible = evaluators.filter(
    (evaluator) => evaluator.enabled && evaluator.phase === 'pre-pr'
  );
  const context = await buildEvaluatorContext({ ctx, artifactId, firesAt: 'pre-pr' });
  const current = await computePrePrReviewFingerprints({ ctx, evaluators: eligible, context });
  if (
    current.evaluator_set_fingerprint !== review.payload.evaluator_set_fingerprint ||
    current.review_context_fingerprint !== review.payload.review_context_fingerprint
  ) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Warning review "${reviewId}" is stale because reviewed inputs changed. Re-run finish.`
    );
  }
}
