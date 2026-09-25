import {
  type AuthorityAtBoundary,
  authorityAtBoundary,
  retainedAuthorityFindings,
} from '@orcaops/core';
import { type ArtifactThread, PrePrCheckedPayloadSchema, uuidv7 } from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  type ProjectDatabase,
  type ProjectOperationOptions,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import type { DatabaseCaptureCommandContext } from './database-capture-context.js';
import { appendDatabaseCaptureEvents } from './database-capture-events.js';
import {
  type DatabaseLifecycleEvaluation,
  publishDatabaseLifecycleCompletion,
  runDatabaseLifecycleEvaluators,
} from './database-evaluators.js';
import { readIntegrationAuthority } from './integration-authority-facts.js';
import { assertIntegrationPublication } from './integration-authority-gate.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface PrePrMarker {
  event_id: string;
  outcome: 'passed' | 'needs_attention';
}

export interface DatabasePrePrPass {
  evaluated: DatabaseLifecycleEvaluation;
  marker: PrePrMarker | null;
  /** Null for an artifact with no captured plan, where there is no selection to compare. */
  authority: AuthorityAtBoundary | null;
}

/**
 * The open-checkpoint gate, in the wording each command owns. `finish` and
 * `capture pre-pr-check` refuse for the same reason but name themselves, and the
 * detail exists so a refusal says which checkpoint and how long it has been idle
 * rather than only how many there are.
 */
export function assertNoOpenCheckpoints(thread: ArtifactThread, command: string): void {
  const open = thread.checkpoints.filter((checkpoint) => checkpoint.status === 'open');
  if (open.length === 0) return;
  const now = Date.now();
  const detail = open
    .map(
      (checkpoint) =>
        `#${checkpoint.n}` +
        (checkpoint.agent_session_id ? ` (${checkpoint.agent_session_id})` : '') +
        ` declared [${checkpoint.declared_step_ids.join(', ')}], opened ${checkpoint.opened_at} ` +
        `(idle ${Math.max(0, Math.round((now - new Date(checkpoint.opened_at).getTime()) / 1000))}s)`
    )
    .join('; ');
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `Cannot run ${command} while ${open.length} open checkpoint(s) exist: ${detail}. ` +
      `Close or abandon each before retrying.`
  );
}

function requireThread(handle: ProjectDatabase, artifactId: string): ArtifactThread {
  const retained = readProjectArtifact(handle, artifactId);
  if (!retained)
    throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${artifactId}".`);
  return retained.thread;
}

/**
 * What an integration boundary compares, and the refusal a revoked authority earns.
 *
 * It is an in-process gate of the pass and not an evaluator: an evaluator can be turned off with a
 * pack, and whether an act may be integrated is not a matter of which checks a repository chose to
 * install. It runs before the evaluators so a pass that must refuse spends no model call, and it
 * reads one snapshot so the uses, the revisions that govern and every authority are observed at one
 * boundary.
 *
 * The refusal writes nothing to the act, to what it rested on, or to the revocation. The lifecycle
 * completion IS recorded, exactly as a pass the evaluators block records one: the phase ran, and a
 * completion is what says so.
 */
async function assertAuthorityAtBoundary(input: {
  context: DatabaseCaptureCommandContext;
  handle: ProjectDatabase;
  artifactId: string;
  command: 'finish' | 'capture pre-pr-check';
  options?: ProjectOperationOptions;
}): Promise<AuthorityAtBoundary | null> {
  const read = readIntegrationAuthority(input.handle, {
    projectId: input.context.project.projectId,
    artifactId: input.artifactId,
  });
  if (read === null) return null;
  const findings = authorityAtBoundary(read.facts, {
    artifactId: input.artifactId,
    planEventId: read.planEventId,
    boundary: 'now',
    judgedAt: read.judgedAt,
    actingIdentity: read.actingIdentity,
  });
  if (findings.revoked.length === 0) return findings;
  await publishDatabaseLifecycleCompletion(
    input.handle,
    {
      artifactId: input.artifactId,
      key: { firesAt: 'pre-pr', cpN: 0 },
      triggeredAt: new Date().toISOString(),
      command: input.command,
      secretAllow: input.context.config.redact.allow,
      mode: 'replace',
    },
    input.options
  );
  throw new OrcaopsError(
    ErrorCodes.AUTHORITY_REVOKED,
    `Cannot run ${input.command}: ${findings.revoked.length} act(s) of this task rest on ` +
      `authority that no longer stands at this boundary. ` +
      findings.revoked.map((entry) => `${entry.statement} ${entry.lifts}`).join(' ') +
      ` Nothing was written: the acts, what they rest on and the revocations are exactly as retained.`
  );
}

/**
 * The pre-PR evaluator pass `finish` and `capture pre-pr-check` share: gate on open
 * checkpoints, compare the authority at this boundary, run the phase, gate again, record the
 * completion, and mint the marker unless the pass blocked.
 *
 * The gate is re-read after the evaluators because they are long-running and hold no
 * transaction, so a checkpoint opened meanwhile must still refuse before anything is
 * recorded. A blocking pass records the completion but no marker: the marker is what a
 * later `finish` accepts warnings against, and there is nothing to accept.
 */
export async function runDatabasePrePrPass(input: {
  context: DatabaseCaptureCommandContext;
  handle: ProjectDatabase;
  artifactId: string;
  command: 'finish' | 'capture pre-pr-check';
  noLlm?: boolean;
  explicitTarget: boolean;
  options?: ProjectOperationOptions;
}): Promise<DatabasePrePrPass> {
  const { context, handle, artifactId, command, options } = input;
  assertNoOpenCheckpoints(requireThread(handle, artifactId), command);
  let authority = await assertAuthorityAtBoundary({
    context,
    handle,
    artifactId,
    command,
    ...(options === undefined ? {} : { options }),
  });
  const evaluated = await runDatabaseLifecycleEvaluators({
    context,
    handle,
    artifactId,
    firesAt: 'pre-pr',
    noLlm: input.noLlm,
    explicitTarget: input.explicitTarget,
    options,
  });
  assertNoOpenCheckpoints(requireThread(handle, artifactId), command);
  await publishDatabaseLifecycleCompletion(
    handle,
    {
      artifactId,
      key: { firesAt: 'pre-pr', cpN: 0 },
      triggeredAt: new Date().toISOString(),
      command,
      secretAllow: context.config.redact.allow,
      mode: 'replace',
    },
    options
  );
  authority = await assertAuthorityAtBoundary({
    context,
    handle,
    artifactId,
    command,
    ...(options === undefined ? {} : { options }),
  });
  if (evaluated.blocking) return { evaluated, marker: null, authority };
  if (!evaluated.pre_pr_review)
    throw new Error('pre-pr evaluator run did not produce review fingerprints');
  const review = evaluated.pre_pr_review;
  const headSha = context.registered.git.headOid;
  if (!headSha)
    throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'A pre-PR marker requires a Git commit');
  // A moved obligation needs attention exactly as a warning evaluator does: the work may still be
  // right, and nobody has looked at it against the revision that governs now.
  const outcome =
    (authority?.moved.length ?? 0) > 0 ||
    evaluated.evaluator_results.some(
      (run) =>
        run.severity === 'warn' &&
        (run.run_status === 'error' ||
          (run.run_status === 'completed' && run.verdict === 'violation'))
    )
      ? ('needs_attention' as const)
      : ('passed' as const);
  const markerKey = uuidv7();
  const appended = await appendDatabaseCaptureEvents<{ event_id: string }>({
    handle,
    binding: context.binding,
    processing: context.processing,
    processingEnabled: context.config.knowledge_processing.enabled,
    artifactId,
    operationId: artifactOperationId(artifactId, markerKey, 'pre_pr_checked'),
    authoredPayload: { kind: 'pre_pr_checked', artifact_id: artifactId, outcome },
    secretAllow: context.config.redact.allow,
    explicitTarget: input.explicitTarget,
    operation: 'task',
    options: {
      ...options,
      assertPublication: (view) =>
        assertIntegrationPublication(view, {
          projectId: context.project.projectId,
          artifactId,
          command,
          expected:
            authority === null ? { moved: [], revoked: [] } : retainedAuthorityFindings(authority),
          allowMoved: true,
        }),
    },
    evaluate: async (semantics) =>
      semantics.writePrePrChecked(
        artifactId,
        {
          head_sha: headSha,
          outcome,
          evaluator_set_fingerprint: review.evaluator_set_fingerprint,
          review_context_fingerprint: review.review_context_fingerprint,
          run_ids: evaluated.evaluator_results.map((run) => run.run_id),
          ...(authority === null ? {} : { authority: retainedAuthorityFindings(authority) }),
        },
        { idempotencyKey: markerKey }
      ),
  });
  return { evaluated, marker: { event_id: appended.value.event_id, outcome }, authority };
}

/**
 * What the two commands print about the authority at this boundary.
 *
 * `revoked` is always empty on a response, because a pass that found one refused instead of
 * returning; it is here so the field states both halves of the check rather than leaving a reader
 * to infer that nothing was looked at. Each finding carries its own sentence, which is the whole of
 * what a person reads: these commands answer in JSON and have no second, human rendering.
 */
export function authorityReport(findings: AuthorityAtBoundary) {
  return {
    boundary: findings.boundary,
    plan_event_id: findings.plan_event_id,
    moved: findings.moved,
    revoked: findings.revoked.map((entry) => ({
      act: { kind: entry.act.kind, id: entry.act.id },
      rested_on: { kind: entry.rested_on.kind, id: entry.rested_on.id },
      standing: entry.rested_on.standing,
      revocations: entry.rested_on.revocations,
      lifts: entry.lifts,
      statement: entry.statement,
    })),
  };
}

/** The retained pre-PR marker an accepted-warnings finish names, or null. */
export function readDatabasePrePrReview(
  handle: ProjectDatabase,
  artifactId: string,
  reviewId: string
): { event_id: string; payload: ReturnType<typeof PrePrCheckedPayloadSchema.parse> } | null {
  const thread = requireThread(handle, artifactId);
  const event = thread.events.find(
    (candidate) =>
      candidate.record.type === 'pre_pr_checked' && candidate.record.event_id === reviewId
  );
  if (!event) return null;
  const payload = PrePrCheckedPayloadSchema.safeParse(event.payload);
  return payload.success ? { event_id: reviewId, payload: payload.data } : null;
}
