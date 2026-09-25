import type { EvaluatorRunPayload } from '@orcaops/evaluator-protocol';
import {
  BlockedError,
  CaptureSummaryInputSchema,
  OpenCheckpointsPendingError,
  WarningAcceptanceInvalidError,
} from '@orcaops/storage';
import { type ProjectDatabase, readProjectArtifact } from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { readPayloadInput } from '../io/input.js';
import {
  type DatabaseCaptureCommandContext,
  openDatabaseCaptureWriter,
  prepareDatabaseCapture,
  type PreparedDatabaseCapture,
  selectDatabaseCaptureArtifact,
} from '../lib/database-capture-context.js';
import {
  type CaptureCloudSyncDeps,
  finalizeDatabaseSummary,
} from '../lib/database-capture-finalize.js';
import { translateDatabaseCaptureError } from '../lib/database-capture-response.js';
import { syncDatabaseCapture } from '../lib/database-capture-sync.js';
import { databaseEvaluatorContext, retainedFindings } from '../lib/database-evaluators.js';
import { captureDatabaseExisting } from '../lib/database-existing-capture.js';
import {
  authorityReport,
  readDatabasePrePrReview,
  runDatabasePrePrPass,
} from '../lib/database-pre-pr-pass.js';
import { buildEvaluatorContext } from '../lib/evaluator-bridge.js';
import { discoverEvaluatorsForCli } from '../lib/evaluator-discovery.js';
import { classifyFinishPrePr } from '../lib/finish-decision.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { computePrePrReviewFingerprints } from '../lib/pre-pr-review.js';
import { runCapture } from '../lib/run-capture.js';

export { classifyFinishPrePr } from '../lib/finish-decision.js';

export interface FinishOptions {
  input?: string;
  noLlm?: boolean;
}

/** Storage gates surface as the public codes the file era used; storage does not know the CLI registry. */
function translateFinishGate(cause: unknown): unknown {
  if (cause instanceof BlockedError) return new OrcaopsError(ErrorCodes.BLOCKED, cause.message);
  if (cause instanceof OpenCheckpointsPendingError)
    return new OrcaopsError(ErrorCodes.INVALID_INPUT, cause.message);
  if (cause instanceof WarningAcceptanceInvalidError)
    return new OrcaopsError(ErrorCodes.INVALID_INPUT, cause.message, cause.path);
  return translateDatabaseCaptureError(cause);
}

/**
 * A warning acceptance names the marker it was offered against. Re-check that the
 * marker still exists, still needs attention, and still describes the inputs that
 * were reviewed — otherwise the acceptance would carry warnings forward past the
 * change that invalidated them.
 */
async function assertReviewCurrent(
  context: DatabaseCaptureCommandContext,
  handle: ProjectDatabase,
  artifactId: string,
  reviewId: string
): Promise<void> {
  const review = readDatabasePrePrReview(handle, artifactId, reviewId);
  if (!review || review.payload.outcome !== 'needs_attention') {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Warning review "${reviewId}" is missing or stale. Re-run finish.`
    );
  }
  const retained = readProjectArtifact(handle, artifactId);
  if (!retained)
    throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${artifactId}".`);
  const { evaluators } = await discoverEvaluatorsForCli(context.registered.git.worktreeRoot);
  const eligible = evaluators.filter(
    (evaluator) => evaluator.enabled && evaluator.phase === 'pre-pr'
  );
  const evaluatorContext = await buildEvaluatorContext({
    ctx: databaseEvaluatorContext(context, retained.thread),
    artifactId,
    firesAt: 'pre-pr',
  });
  const current = await computePrePrReviewFingerprints({
    ctx: { repo: context.repo },
    evaluators: eligible,
    context: evaluatorContext,
  });
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

type PrePrPhase =
  | {
      kind: 'proceed';
      artifactId: string;
      reviewId: string | null;
      evaluatorResults: EvaluatorRunPayload[];
      findingsRetained: number;
    }
  | { kind: 'paused'; response: Record<string, unknown> };

/**
 * `finish` is the pre-PR pass and the summary in one invocation, and they run under
 * SEPARATE writers on purpose: the summary half goes through exactly the path
 * `capture summary` uses, which opens its own writer, and holding a second one across
 * it would contend with itself on the single-writer database. The gap between them is
 * the same gap the file era had — the summary half re-validates open checkpoints and
 * the warning acceptance for itself.
 */
async function runPrePrPhase(
  prepared: PreparedDatabaseCapture<
    ReturnType<typeof CaptureSummaryInputSchema.parse>,
    ReturnType<typeof CaptureSummaryInputSchema.parse>
  >,
  opts: FinishOptions,
  signal: AbortSignal,
  deps: CaptureCloudSyncDeps
): Promise<PrePrPhase> {
  const { context, input } = prepared;
  const writer = await openDatabaseCaptureWriter(context);
  let failed = false;
  try {
    const { artifactId } = selectDatabaseCaptureArtifact(writer, {
      explicitId: input.artifact_id,
      branch: context.registered.git.branch,
    });
    const retained = readProjectArtifact(writer, artifactId);
    if (!retained)
      throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${artifactId}".`);
    // A persisted summary means the pre-PR pass already happened for this artifact.
    // Re-running an LLM cannot improve it, and the summary half below decides replay,
    // conflict or explicit supersede on its own.
    if (retained.thread.summary !== null)
      return {
        kind: 'proceed',
        artifactId,
        reviewId: null,
        evaluatorResults: [],
        findingsRetained: 0,
      };
    if (input.accepted_warnings !== undefined) {
      const reviewId = input.accepted_warnings[0]!.review_id;
      await assertReviewCurrent(context, writer, artifactId, reviewId);
      return { kind: 'proceed', artifactId, reviewId, evaluatorResults: [], findingsRetained: 0 };
    }
    const options = { signal };
    const { evaluated, marker, authority } = await runDatabasePrePrPass({
      context,
      handle: writer,
      artifactId,
      command: 'finish',
      noLlm: opts.noLlm,
      explicitTarget: input.artifact_id !== undefined,
      options,
    });
    const decision = classifyFinishPrePr(evaluated.evaluator_results, evaluated.blocking);
    const moved = authority?.moved ?? [];
    const authorityField = authority === null ? {} : { authority: authorityReport(authority) };
    if (decision.kind === 'blocked') {
      return {
        kind: 'paused',
        response: {
          artifact_id: artifactId,
          status: 'blocked',
          blocking: true,
          evaluator_results: evaluated.evaluator_results,
          ...retainedFindings(evaluated.findings_retained),
          ...authorityField,
          cloud_sync: await syncDatabaseCapture(context, writer, artifactId, options, deps),
        },
      };
    }
    if (marker === null) throw new Error('a non-blocking pre-PR pass produced no marker');
    if (decision.kind === 'needs_attention' || moved.length > 0) {
      const acceptance =
        moved.length === 0 && decision.kind === 'needs_attention' && decision.acceptance_allowed;
      return {
        kind: 'paused',
        response: {
          artifact_id: artifactId,
          status: 'needs_attention',
          review_id: marker.event_id,
          evaluator_results: evaluated.evaluator_results,
          ...retainedFindings(evaluated.findings_retained),
          ...authorityField,
          acceptance_allowed: acceptance,
          cloud_sync: await syncDatabaseCapture(context, writer, artifactId, options, deps),
          ...(acceptance
            ? {
                accepted_warnings: (
                  decision as Extract<typeof decision, { kind: 'needs_attention' }>
                ).runs.map((run) => ({
                  review_id: marker.event_id,
                  run_id: run.run_id,
                  evaluator_ref: run.evaluator_ref,
                  reason: '',
                })),
              }
            : {
                action:
                  moved.length > 0
                    ? 'Record a use of the revision that governs now with `orcaops task uses ' +
                      'record`, or revise the plan, then re-run finish.'
                    : 'Re-run finish; evaluator errors cannot be accepted.',
              }),
        },
      };
    }
    return {
      kind: 'proceed',
      artifactId,
      reviewId: marker.event_id,
      evaluatorResults: evaluated.evaluator_results,
      findingsRetained: evaluated.findings_retained,
    };
  } catch (cause) {
    failed = true;
    closeFailedHistoryRead(writer);
    throw cause;
  } finally {
    if (!failed) writer.close();
  }
}

export async function finish(
  opts: FinishOptions,
  signal: AbortSignal,
  deps: CaptureCloudSyncDeps = {}
) {
  const prepared = await prepareDatabaseCapture({
    parse: async () =>
      CaptureSummaryInputSchema.parse(await readPayloadInput({ inputPath: opts.input })),
    signal,
    noLlm: opts.noLlm,
  });
  const { context, input } = prepared;
  try {
    const phase = await runPrePrPhase(prepared, opts, signal, deps);
    if (phase.kind === 'paused') return phase.response;

    // The summary lands on the artifact the pre-PR pass checked, not a fresh branch
    // selection a concurrent completion could have moved onto a different artifact.
    const captured = await captureDatabaseExisting(
      'summary',
      prepared,
      signal,
      phase.artifactId,
      phase.reviewId ?? undefined
    );
    const { writer, result } = captured;
    let failed = false;
    try {
      if (result.outcome === 'conflict')
        throw new OrcaopsError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          'The finish idempotency key was reused with a different summary.',
          'idempotency_key'
        );
      return await finalizeDatabaseSummary({
        captured,
        idempotencyKey: input.idempotency_key,
        secretWarnings: prepared.secretWarnings,
        openCloudSyncSession: deps.openCloudSyncSession,
        cloud: deps.cloud,
        extra: {
          ...(phase.reviewId === null ? {} : { review_id: phase.reviewId }),
          evaluator_results: phase.evaluatorResults,
          ...retainedFindings(phase.findingsRetained),
        },
      });
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

export async function finishAction(opts: FinishOptions = {}): Promise<void> {
  await runCapture(async () => {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    try {
      return await finish(opts, controller.signal);
    } catch (cause) {
      throw translateFinishGate(cause);
    } finally {
      process.off('SIGINT', interrupt);
    }
  });
}
