import {
  assertNoSecretsInPayload,
  type EvaluatorDispositionPayload,
  uuidv7,
} from '@orcaops/storage';

import { resolveTargetRun } from './helpers.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { buildContext } from '../../lib/context.js';
import { discoverEvaluatorsForCli, evaluatorNotFound } from '../../lib/evaluator-discovery.js';
import { appendNextActions, buildAcknowledgeByRef } from '../../lib/next-actions.js';
import { loadSecretAllowlist, runCapture } from '../../lib/run-capture.js';

export interface BlockAcknowledgeOptions {
  artifact: string;
  /** Resolved evaluator ref: `<pack-id>/<evaluator-id>`. */
  evaluator: string;
  /** Optional explicit run_id; when omitted, the latest unresolved blocking run wins. */
  runId?: string;
  reason: string;
  agentSessionId?: string;
  /** Optional idempotency key; auto-generated when omitted. */
  idempotencyKey?: string;
}

/**
 * `orcaops block acknowledge` — formal acknowledgement of a
 * block-severity violation. Resolves the target
 * via `--run-id <id>` (explicit) OR by looking up the latest
 * unresolved blocking run for `--evaluator <ref>` on the artifact.
 *
 * Acknowledge is **gated** on the resolved evaluator's
 * `resolution.acknowledge.enabled`; rejects with
 * `BLOCK_NOT_ACKNOWLEDGEABLE` when the evaluator doesn't opt in. Use
 * `orcaops block dismiss` instead (always available on block severity).
 *
 * Writes an `evaluator_disposition_recorded` event with
 * `disposition: 'acknowledged'` via the storage event-first writer;
 * the projection materializes the `disposition` column atomically.
 */
export async function blockAcknowledgeAction(opts: BlockAcknowledgeOptions): Promise<void> {
  await runCapture(async () => {
    // Both arrive as CLI flags, so they bypass the payload gate in
    // runCaptureWithSync — but each is agent-supplied and each is persisted
    // onto the disposition row. Gate them here, before buildContext, so a
    // refusal still leaves no state behind.
    assertNoSecretsInPayload(
      { reason: opts.reason, agent_session_id: opts.agentSessionId },
      await loadSecretAllowlist()
    );
    const ctx = await buildContext();
    try {
      const artifact = ctx.store.store.getArtifact(opts.artifact);
      if (!artifact) {
        throw new OrcaopsError(
          ErrorCodes.UNKNOWN_ARTIFACT,
          `No artifact with id "${opts.artifact}".`
        );
      }

      // Inspection-mode discovery — collect errors but don't throw so
      // the agent can resolve blocks even when other evaluator specs
      // have config issues. doctor surfaces those independently.
      const { evaluators, errors } = await discoverEvaluatorsForCli(ctx.repoRoot);
      const resolved = evaluators.find((e) => e.ref === opts.evaluator);
      if (!resolved) throw evaluatorNotFound(opts.evaluator, errors);
      if (resolved.severity !== 'block') {
        throw new OrcaopsError(
          ErrorCodes.BLOCK_NOT_ACKNOWLEDGEABLE,
          `Evaluator "${opts.evaluator}" has severity "${resolved.severity}"; ` +
            `acknowledge only applies to block-severity evaluators.`,
          'evaluator'
        );
      }
      if (!resolved.resolution.acknowledge.enabled) {
        throw new OrcaopsError(
          ErrorCodes.BLOCK_NOT_ACKNOWLEDGEABLE,
          `Evaluator "${opts.evaluator}" does not permit acknowledgement. Its spec ` +
            `must set \`resolution.acknowledge.enabled: true\` to opt into the ack ` +
            `escape valve. Use \`orcaops block dismiss\` instead, or amend the work.`,
          'evaluator'
        );
      }

      const targetRun = resolveTargetRun(ctx, opts, resolved.ref, 'acknowledge');

      const ts = new Date().toISOString();
      const payload: EvaluatorDispositionPayload = {
        schema: 'orcaops.evaluator_disposition/v1',
        disposition_id: uuidv7(),
        artifact_id: opts.artifact,
        run_id: targetRun.run_id,
        evaluator_ref: resolved.ref,
        disposition: 'acknowledged',
        reason: opts.reason,
        agent_session_id: opts.agentSessionId ?? null,
        ts,
      };
      await ctx.store.writeEvaluatorDisposition(opts.artifact, payload, {
        idempotencyKey: opts.idempotencyKey ?? uuidv7(),
      });

      const result = {
        artifact_id: opts.artifact,
        evaluator: resolved.ref,
        run_id: targetRun.run_id,
        action: 'acknowledged' as const,
        acknowledged_at: ts,
      };
      // Reuse the already-discovered evaluators for ack eligibility (no second
      // discovery). After this disposition the block clears, so the hint
      // advances to the next lifecycle step.
      const acknowledgeByRef = buildAcknowledgeByRef(evaluators);
      return await appendNextActions(ctx, result, { acknowledgeByRef });
    } finally {
      ctx.store.close();
    }
  });
}
