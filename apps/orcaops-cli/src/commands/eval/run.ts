import { run } from 'effection';

import { isBlockingEvaluatorFailure } from '@orcaops/evaluator-protocol';
import { createParamsValidator, dispatchOne } from '@orcaops/evaluator-runner';
import { buildLLMClient } from '@orcaops/llm';
import { uuidv7 } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import { buildContext } from '../../lib/context.js';
import { buildEvaluatorContext } from '../../lib/evaluator-bridge.js';
import { discoverEvaluatorsForCli, evaluatorNotFound } from '../../lib/evaluator-discovery.js';
import { computePackTrustDecisions } from '../../lib/evaluator-grants.js';
import { CLI_ROOT } from '../../lib/evaluators-config.js';
import { getInvocationEnv } from '../../lib/invocation-context.js';

export interface EvalRunOptions {
  /** Resolved evaluator ref `<pack>/<id>`. */
  ref: string;
  artifact?: string;
  checkpoint?: number;
  noLlm?: boolean;
  json?: boolean;
}

/**
 * Run a single evaluator against an existing artifact. Useful for
 * iterating on an evaluator's prompt or fixing a flake — the agent
 * lifecycle runs the whole eligible set; this targets one ref.
 *
 * Result IS persisted (the same write path the lifecycle uses); use
 * `eval test --fixture` for prompt iteration without persistence.
 */
export async function evalRunAction(opts: EvalRunOptions): Promise<void> {
  try {
    const ctx = await buildContext();
    try {
      const { evaluators, config, errors } = await discoverEvaluatorsForCli(ctx.repoRoot);
      const evaluator = evaluators.find((e) => e.ref === opts.ref);
      if (!evaluator) throw evaluatorNotFound(opts.ref, errors);
      const trust = await computePackTrustDecisions({
        packs: (config?.packages ?? [])
          .filter((entry) => entry.id === evaluator.package_id)
          .map((entry) => ({
            packageId: entry.id,
            source: entry.source,
          })),
        repoRoot: ctx.repoRoot,
        cliRoot: CLI_ROOT,
        warn: (msg) => writeTerminalSafeStderr(`${msg}\n`),
      });

      const artifactId = opts.artifact ?? findLatestArtifactId(ctx);
      if (!artifactId) {
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact ID provided and no artifact found on the current branch.`
        );
      }

      const checkpointN = opts.checkpoint;
      if (
        (evaluator.phase === 'checkpoint-close' || evaluator.phase === 'checkpoint-open') &&
        checkpointN === undefined
      ) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Evaluator "${opts.ref}" fires at ${evaluator.phase}; pass --checkpoint <n>.`,
          'checkpoint'
        );
      }

      const baseContext = await buildEvaluatorContext({
        ctx,
        artifactId,
        firesAt: evaluator.phase,
        ...(checkpointN !== undefined ? { checkpointN } : {}),
      });

      const llm = await run(function* () {
        return yield* buildLLMClient(ctx.config.llm, {
          ...(opts.noLlm !== undefined ? { noLlm: opts.noLlm } : {}),
          env: getInvocationEnv(),
        });
      });

      const validator = createParamsValidator();
      const runPayload = await dispatchOne(
        evaluator,
        baseContext,
        llm,
        {
          trust,
          validateRaw: (raw, schema) => validator(raw as Record<string, unknown>, schema),
        },
        uuidv7
      );
      const stamped =
        checkpointN !== undefined &&
        (evaluator.phase === 'checkpoint-open' || evaluator.phase === 'checkpoint-close')
          ? { ...runPayload, checkpoint_n: checkpointN }
          : runPayload;
      await ctx.store.writeEvaluatorRunPayload(artifactId, stamped, {
        idempotencyKey: uuidv7(),
      });

      const blocking = isBlockingEvaluatorFailure(stamped);

      const out = {
        artifact_id: artifactId,
        evaluator_ref: evaluator.ref,
        run: stamped,
        blocking,
      };
      if (opts.json) {
        emitOk(out);
        return;
      }
      const statusLine =
        stamped.run_status === 'completed'
          ? `${stamped.verdict}`
          : stamped.run_status === 'skipped'
            ? 'skipped'
            : `error: ${stamped.error?.code ?? 'unknown'}`;
      writeTerminalSafeStdout(
        `${stamped.evaluator_ref}: ${statusLine} (${stamped.severity})\n\n${stamped.body}\n` +
          (blocking ? '\n** BLOCKING **\n' : '')
      );
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function findLatestArtifactId(ctx: import('../../lib/context.js').CliContext): string | null {
  const rows = ctx.store.store.listArtifacts({});
  if (rows.length === 0) return null;
  return rows[0].id;
}
