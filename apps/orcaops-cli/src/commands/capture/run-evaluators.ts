import { CaptureRunEvaluatorsInputSchema } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { buildContext } from '../../lib/context.js';
import { recordLifecycleCompletion, runLifecycleEvaluators } from '../../lib/evaluator-bridge.js';
import { runCapture } from '../../lib/run-capture.js';

export interface CaptureRunEvaluatorsOptions {
  input?: string;
  noLlm?: boolean;
}

/**
 * Explicit re-run for a given lifecycle. Runs all matching evaluators,
 * records completion, and returns results + blocking flag.
 *
 * Useful when the agent wants to re-evaluate without changing the artifact
 * thread (e.g., after the user fixed an evaluator's prompt and wants to
 * re-test against the existing plan/checkpoint).
 */
export async function captureRunEvaluatorsAction(
  opts: CaptureRunEvaluatorsOptions = {}
): Promise<void> {
  await runCapture(async () => {
    const raw = await readPayloadInput({ inputPath: opts.input });
    const input = CaptureRunEvaluatorsInputSchema.parse(raw);

    if (
      (input.fires_at === 'checkpoint-close' || input.fires_at === 'checkpoint-open') &&
      input.checkpoint_n === undefined
    ) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `\`checkpoint_n\` is required when \`fires_at\` is "${input.fires_at}".`,
        'checkpoint_n'
      );
    }

    const ctx = await buildContext();
    try {
      const artifact = ctx.store.store.getArtifact(input.artifact_id);
      if (!artifact) {
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact with id "${input.artifact_id}".`
        );
      }

      const sequenceN =
        input.fires_at === 'post-plan-revision'
          ? (await ctx.store.readPlan(input.artifact_id))?.revision_n
          : input.fires_at === 'checkpoint-open' || input.fires_at === 'checkpoint-close'
            ? input.checkpoint_n
            : undefined;

      const evalResult = await runLifecycleEvaluators({
        ctx,
        artifactId: input.artifact_id,
        firesAt: input.fires_at,
        checkpointN: input.checkpoint_n,
        noLlm: opts.noLlm,
      });
      await recordLifecycleCompletion(ctx, {
        artifactId: input.artifact_id,
        firesAt: input.fires_at,
        sequenceN,
      });

      // Deliberately NOT wired with appendNextActions: run-evaluators is an
      // ad-hoc re-evaluation, not a lifecycle transition, so it's excluded
      // from the next_actions surface (v1). The blocked→resolve loop closes
      // via block acknowledge/dismiss instead. Re-run `orcaops status` for a
      // fresh hint after this.
      return {
        artifact_id: input.artifact_id,
        fires_at: input.fires_at,
        ...evalResult,
      };
    } finally {
      ctx.store.close();
    }
  });
}
