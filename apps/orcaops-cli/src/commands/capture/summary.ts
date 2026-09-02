import {
  BlockedError,
  CaptureSummaryInputSchema,
  normalizeAcceptedWarnings,
  normalizeAcceptedWarningsForReplay,
  OpenCheckpointsPendingError,
  type SummaryInput,
  WarningAcceptanceInvalidError,
} from '@orcaops/storage';

import { ErrorCodes, InfoCodes, OrcaopsError } from '../../io/errors.js';
import { readPayloadInput } from '../../io/input.js';
import { resolveActiveArtifactId } from '../../lib/active-artifact.js';
import type { CliContext } from '../../lib/context.js';
import { clearPinForCurrentShell, resolvePinTargets } from '../../lib/pin-helpers.js';
import { runCaptureWithSync } from '../../lib/run-capture.js';
import { lifecycleUsageStamp } from '../../lib/usage-stamp.js';

export interface CaptureSummaryOptions {
  input?: string;
}

export async function captureSummaryAction(opts: CaptureSummaryOptions = {}): Promise<void> {
  await runCaptureWithSync(
    async (ctx, input) => {
      const { artifactId } = await resolveActiveArtifactId(ctx, {
        explicitId: input.artifact_id,
      });

      // The completion gate (no open cps) lives inside writeSummary
      // (TOCTOU-safe — gate check + event append in the same lock).
      // OpenCheckpointsPendingError is remapped to INVALID_INPUT below.

      const ts = new Date().toISOString();
      // Current HEAD is only what a FIRST capture records. On a supersede
      // (prior_summary_event_id set) writeSummary discards this and carries the
      // superseded summary's head_sha forward, so amending after later commits
      // cannot restamp the summary onto work it never covered.
      const headSha = await ctx.repo.getHeadSha();

      const summary: SummaryInput = {
        schema_version: 1,
        artifact_id: artifactId,
        // Runtime-resolved invoking agent; NOT in replayPayload below, so a
        // cross-agent retry of the same summary replays instead of conflicting.
        agent: ctx.invokingAgent.agent,
        outcome: input.outcome,
        tests_written: input.tests_written,
        tests_run: input.tests_run,
        open_items: input.open_items,
        deferred_decisions: input.deferred_decisions,
        ...(input.accepted_warnings === undefined
          ? {}
          : { accepted_warnings: normalizeAcceptedWarnings(input.accepted_warnings) }),
        head_sha: headSha,
        ts,
      };

      // Replay shape excludes ts + head_sha (runtime-supplied, and on a supersede
      // head_sha is inherited from the superseded summary rather than derived) so
      // a retried call with same intent matches as replay, not conflict.
      const replayPayload = {
        artifact_id: artifactId,
        outcome: input.outcome,
        tests_written: input.tests_written,
        tests_run: input.tests_run,
        open_items: input.open_items,
        deferred_decisions: input.deferred_decisions,
        ...(input.accepted_warnings === undefined
          ? {}
          : { accepted_warnings: normalizeAcceptedWarnings(input.accepted_warnings) }),
      };

      let result;
      try {
        result = await ctx.store.writeSummary(summary, {
          idempotencyKey: input.idempotency_key,
          replayPayload,
          extractReplayShape: (priorPayload) => extractSummaryReplayShape(priorPayload),
          // Explicit supersede token — required to REPLACE an existing summary.
          priorSummaryEventId: input.prior_summary_event_id,
        });
      } catch (err) {
        // Storage's BLOCKED gate fires when an unresolved
        // block-severity violation exists. Remap to the public error
        // code envelope at the CLI boundary; storage doesn't depend
        // on the CLI's error registry.
        if (err instanceof BlockedError) {
          throw new OrcaopsError(ErrorCodes.BLOCKED, err.message, undefined);
        }
        if (err instanceof OpenCheckpointsPendingError) {
          throw new OrcaopsError(ErrorCodes.INVALID_INPUT, err.message);
        }
        if (err instanceof WarningAcceptanceInvalidError) {
          throw new OrcaopsError(ErrorCodes.INVALID_INPUT, err.message, err.path);
        }
        throw err;
      }

      if (result.outcome === 'conflict') {
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `idempotency_key="${input.idempotency_key}" was used by a prior summary capture ` +
            `with a structurally-different payload (prior event_id=${result.priorEventId}). ` +
            `Use a fresh key — the prior decision stands.`,
          'idempotency_key'
        );
      }
      if (result.outcome === 'replay') {
        // The prior summary already cleared the pin (if any). Run
        // clear again for resilience — it's idempotent.
        await maybeAutoClear(ctx, artifactId);
        return {
          artifact_id: artifactId,
          completed_at: result.summary.ts,
          idempotency_status: 'replay',
          code: InfoCodes.IDEMPOTENT_REPLAY,
          message: `Returning prior summary for idempotency_key="${input.idempotency_key}".`,
          renderFinalDigest: true,
        };
      }

      await maybeAutoClear(ctx, artifactId);

      return {
        artifact_id: artifactId,
        completed_at: ts,
        // Surface the summary event id so a later amend can pass it as the
        // prior_summary_event_id supersede token without a resume round-trip.
        ...(result.event_id !== undefined ? { summary_event_id: result.event_id } : {}),
        // Final lifecycle boundary: stamp cumulative coding-agent usage as of the
        // summary. The replay arm above returns earlier without this field, so a
        // retried summary never re-stamps (the stamp is structurally success-only).
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

/**
 * On successful capture summary, clear the current shell's pin if it
 * points at this artifact. Per spec, this is the auto-clear leg of the
 * pin lifecycle. Pins for OTHER artifacts (e.g., another shell pinned
 * something else) are left alone — `expectArtifactId` gates the clear.
 *
 * Failure cases (BLOCKED, IDEMPOTENCY_CONFLICT) never reach this point
 * — those throw before, so the pin is preserved as the spec demands.
 */
export async function maybeAutoClear(ctx: CliContext, artifactId: string): Promise<void> {
  const targets = await resolvePinTargets(ctx);
  if (targets.shellKey.kind === 'none') return;
  await clearPinForCurrentShell({ targets, expectArtifactId: artifactId });
}

/**
 * Strip ts + head_sha from a prior summary event's payload before the
 * replay comparison. Same rationale as the checkpoint version: only
 * agent-supplied INPUT fields participate in equality so retries
 * resolve as replay, not conflict.
 */
export function extractSummaryReplayShape(priorPayload: unknown): unknown {
  if (typeof priorPayload !== 'object' || priorPayload === null) return priorPayload;
  const p = priorPayload as Record<string, unknown>;
  return {
    artifact_id: p.artifact_id,
    outcome: p.outcome,
    tests_written: p.tests_written,
    tests_run: p.tests_run,
    open_items: p.open_items,
    deferred_decisions: p.deferred_decisions,
    accepted_warnings: normalizeAcceptedWarningsForReplay(p.accepted_warnings),
  };
}
