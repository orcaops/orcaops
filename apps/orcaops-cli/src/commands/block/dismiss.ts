import {
  assertNoSecretsInPayload,
  type EvaluatorDispositionPayload,
  uuidv7,
} from '@orcaops/storage';

import { resolveTargetRun } from './helpers.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { buildContext } from '../../lib/context.js';
import { discoverEvaluatorsForCli, evaluatorNotFound } from '../../lib/evaluator-discovery.js';
import { LIFECYCLE_INVENTORY_EVALUATOR_REF } from '../../lib/evaluator-inventory.js';
import { appendNextActions, buildAcknowledgeByRef } from '../../lib/next-actions.js';
import { loadSecretAllowlist, runCapture } from '../../lib/run-capture.js';

export interface BlockDismissOptions {
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
 * `orcaops block dismiss` — always-available override for a
 * block-severity violation. Unlike `block acknowledge`, dismiss is
 * NOT gated on the evaluator's `resolution.acknowledge.enabled`; the
 * audit difference matters (dismiss = "I reject this evaluator's
 * call entirely"; acknowledge = "I accept the underlying change as
 * a breaking change").
 *
 * Doctor surfaces per-evaluator dismiss rates — persistently
 * dismissed evaluators get flagged for revision rather than silently
 * ignored.
 *
 * Writes an `evaluator_disposition_recorded` event with
 * `disposition: 'dismissed'` via the storage event-first writer; the
 * projection materializes the `disposition` column atomically.
 */
export async function blockDismissAction(opts: BlockDismissOptions): Promise<void> {
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

      const { evaluators, errors } = await discoverEvaluatorsForCli(ctx.repoRoot);
      const resolved = evaluators.find((e) => e.ref === opts.evaluator);
      const evaluatorRef =
        resolved?.ref ??
        (opts.evaluator === LIFECYCLE_INVENTORY_EVALUATOR_REF
          ? LIFECYCLE_INVENTORY_EVALUATOR_REF
          : null);
      if (evaluatorRef === null) throw evaluatorNotFound(opts.evaluator, errors);
      if (resolved && resolved.severity !== 'block') {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `Evaluator "${opts.evaluator}" has severity "${resolved.severity}"; ` +
            `dismiss only applies to block-severity evaluators (warn / info ` +
            `verdicts don't block capture and don't need explicit dismissal).`,
          'evaluator'
        );
      }

      const targetRun = resolveTargetRun(ctx, opts, evaluatorRef, 'dismiss');

      const ts = new Date().toISOString();
      const payload: EvaluatorDispositionPayload = {
        schema: 'orcaops.evaluator_disposition/v1',
        disposition_id: uuidv7(),
        artifact_id: opts.artifact,
        run_id: targetRun.run_id,
        evaluator_ref: evaluatorRef,
        disposition: 'dismissed',
        reason: opts.reason,
        agent_session_id: opts.agentSessionId ?? null,
        ts,
      };
      await ctx.store.writeEvaluatorDisposition(opts.artifact, payload, {
        idempotencyKey: opts.idempotencyKey ?? uuidv7(),
      });

      const result = {
        artifact_id: opts.artifact,
        evaluator: evaluatorRef,
        run_id: targetRun.run_id,
        action: 'dismissed' as const,
        dismissed_at: ts,
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
