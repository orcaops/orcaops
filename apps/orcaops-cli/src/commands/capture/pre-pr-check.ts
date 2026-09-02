import { CapturePrePrCheckInputSchema, uuidv7 } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { resolveActiveArtifactId } from '../../lib/active-artifact.js';
import type { CliContext } from '../../lib/context.js';
import { recordLifecycleCompletion, runLifecycleEvaluators } from '../../lib/evaluator-bridge.js';
import { runCaptureWithSync } from '../../lib/run-capture.js';
import { lifecycleUsageStamp } from '../../lib/usage-stamp.js';

export interface CapturePrePrCheckOptions {
  input?: string;
  noLlm?: boolean;
}

/**
 * Final pre-PR evaluator pass. Runs all evaluators with `fires_at: pre-pr`,
 * records lifecycle completion, and returns the results + a blocking flag
 * the agent uses to decide whether to proceed to capture summary.
 */
export async function capturePrePrCheckAction(opts: CapturePrePrCheckOptions = {}): Promise<void> {
  await runCaptureWithSync(
    async (ctx, input) => {
      const { artifactId } = await resolveActiveArtifactId(ctx, {
        explicitId: input.artifact_id,
      });

      // Check the completion gate under the artifact lock. Evaluator work
      // happens after release — long-running LLM calls must not hold the
      // artifact lock. The lifecycle row is a completion marker and is
      // therefore written only after evaluator persistence succeeds.
      await ctx.store.withArtifactLock(artifactId, async () => {
        assertNoOpenCheckpoints(ctx, artifactId);
      });

      const evalResult = await runLifecycleEvaluators({
        ctx,
        artifactId: artifactId,
        firesAt: 'pre-pr',
        noLlm: opts.noLlm,
      });
      await ctx.store.withArtifactLock(artifactId, async () => {
        assertNoOpenCheckpoints(ctx, artifactId);
        await recordLifecycleCompletion(ctx, {
          artifactId,
          firesAt: 'pre-pr',
        });
      });

      let reviewMarker: { event_id: string; outcome: 'passed' | 'needs_attention' } | null = null;
      if (!evalResult.blocking) {
        if (!evalResult.pre_pr_review) {
          throw new Error('pre-pr evaluator run did not produce review fingerprints');
        }
        const headSha = await ctx.repo.getHeadSha();
        const needsAttention = evalResult.evaluator_results.some(
          (run) =>
            run.severity === 'warn' &&
            (run.run_status === 'error' ||
              (run.run_status === 'completed' && run.verdict === 'violation'))
        );
        const outcome = needsAttention ? 'needs_attention' : 'passed';
        const marker = await ctx.store.writePrePrChecked(artifactId, {
          head_sha: headSha,
          outcome,
          evaluator_set_fingerprint: evalResult.pre_pr_review.evaluator_set_fingerprint,
          review_context_fingerprint: evalResult.pre_pr_review.review_context_fingerprint,
          run_ids: evalResult.evaluator_results.map((run) => run.run_id),
        });
        reviewMarker = { event_id: marker.event_id, outcome };
      }

      return {
        artifact_id: artifactId,
        ...evalResult,
        review_id: reviewMarker?.event_id ?? null,
        pre_pr_outcome: reviewMarker?.outcome ?? null,
        // Stamp coding-agent usage UNCONDITIONALLY (pass or block): tokens were
        // spent either way and the `pre-pr` lifecycle event is always recorded
        // above. Keyed on a fresh per-invocation uuid, NOT the (accepted-but-
        // ignored) idempotency_key — pre-pr-check re-runs freely, and a stable key
        // would hit the ledger's skip-if-seen and freeze cumulative usage at the
        // first, lower read. Each pass stamps the current cumulative; high-water
        // attribution then takes the true max. (No idempotency_status on this
        // return, so the run-capture replay-skip is a no-op here — by design.)
        usageStamp: lifecycleUsageStamp({
          event: 'pre_pr_check',
          artifactId,
          baselineHint: 'prior_same_artifact',
          asOf: new Date().toISOString(),
          discriminator: uuidv7(),
        }),
      };
    },
    {
      // allowEmpty — a bare `orcaops capture pre-pr-check` (no payload)
      // resolves to {} so the all-optional schema parses and the single active
      // artifact is autodetected, mirroring checkpoint open/close and summary.
      parseInput: async () =>
        CapturePrePrCheckInputSchema.parse(
          await readPayloadInput({ inputPath: opts.input, allowEmpty: true })
        ),
    }
  );
}

function assertNoOpenCheckpoints(ctx: CliContext, artifactId: string): void {
  const openCps = ctx.store.store.getOpenCheckpoints(artifactId);
  if (openCps.length === 0) return;
  const now = Date.now();
  const detail = openCps
    .map((cp) => {
      const idleSeconds = Math.max(0, Math.round((now - new Date(cp.opened_at).getTime()) / 1000));
      return (
        `#${cp.n}` +
        (cp.agent_session_id ? ` (${cp.agent_session_id})` : '') +
        ` declared [${cp.declared_step_ids.join(', ')}], opened ${cp.opened_at} ` +
        `(idle ${idleSeconds}s)`
      );
    })
    .join('; ');
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `Cannot run pre-pr-check while ${openCps.length} open checkpoint(s) exist: ${detail}. ` +
      `Close or abandon each before retrying.`
  );
}
