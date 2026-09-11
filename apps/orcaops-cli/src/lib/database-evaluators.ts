import { type EvaluatorPhase, isBlockingEvaluatorFailure } from '@orcaops/evaluator-protocol';
import {
  type ArtifactThread,
  canonicalJson,
  type LifecycleFiresAt,
  type OpenCheckpoint,
  type Plan,
  PlanSchema,
  type ProposedOpenCheckpoint,
  uuidv7,
} from '@orcaops/storage';
import {
  type ProjectDatabase,
  type ProjectOperationOptions,
  publishProjectLifecycleCompletion,
  readProjectArtifact,
  readProjectLifecycleCompletions,
} from '@orcaops/storage/history/database';

import type { DatabaseCaptureCommandContext } from './database-capture-context.js';
import { appendDatabaseCaptureEvents } from './database-capture-events.js';
import {
  type LifecycleEvaluatorContext,
  runLifecycleEvaluators,
  type RunLifecycleResult,
} from './evaluator-bridge.js';

function planRevisions(thread: ArtifactThread): Map<number, Plan> {
  const revisions = new Map<number, Plan>();
  for (const event of thread.events) {
    if (event.record.type !== 'plan_captured' && event.record.type !== 'plan_revised') continue;
    const plan = PlanSchema.parse({
      ...(event.payload as Record<string, unknown>),
      source_event_id: event.record.event_id,
    });
    revisions.set(plan.revision_n, plan);
  }
  return revisions;
}

/** The evaluator bridge's read surface over one retained thread; writes go through the capture composer. */
export function databaseEvaluatorStore(thread: ArtifactThread): LifecycleEvaluatorContext['store'] {
  const revisions = planRevisions(thread);
  return {
    readPlan: async () => thread.plan,
    readPlanRevision: async (_artifactId, revisionN) => revisions.get(revisionN) ?? null,
    readCheckpoints: async () => thread.checkpoints,
    readSummary: async () => thread.summary,
    readArtifact: async () => thread.artifactJson,
    readEvaluatorLog: async () => thread.evaluatorLog,
    writeEvaluatorRunPayload: async () => {
      throw new Error(
        'Evaluator runs are appended through the capture composer, not the read view'
      );
    },
  };
}

export function databaseEvaluatorContext(
  context: DatabaseCaptureCommandContext,
  thread: ArtifactThread
): LifecycleEvaluatorContext {
  return {
    repoRoot: context.registered.git.worktreeRoot,
    repo: context.repo,
    config: context.config,
    store: databaseEvaluatorStore(thread),
  };
}

export interface DatabaseLifecycleEvaluation extends RunLifecycleResult {
  run_event_ids: string[];
  publication: Awaited<ReturnType<typeof appendDatabaseCaptureEvents>>['publication'];
}

/**
 * Runs the phase's evaluators against the retained thread and appends their runs as
 * artifact events. Blocking is recomputed from the appended log so a run left
 * unresolved by an earlier disposition blocks exactly as it did under file authority.
 */
export async function runDatabaseLifecycleEvaluators(input: {
  context: DatabaseCaptureCommandContext;
  handle: ProjectDatabase;
  artifactId: string;
  firesAt: EvaluatorPhase;
  checkpointN?: number;
  planOverride?: Plan;
  priorPlanOverride?: Plan | null;
  proposedOpenCheckpoint?: OpenCheckpoint | ProposedOpenCheckpoint;
  noLlm?: boolean;
  explicitTarget: boolean;
  options?: ProjectOperationOptions;
}): Promise<DatabaseLifecycleEvaluation> {
  const { handle, artifactId } = input;
  const retained = readProjectArtifact(handle, artifactId);
  if (!retained) throw new Error(`Cannot evaluate: artifact "${artifactId}" is unavailable.`);
  const evaluated = await runLifecycleEvaluators({
    ctx: databaseEvaluatorContext(input.context, retained.thread),
    artifactId,
    firesAt: input.firesAt,
    checkpointN: input.checkpointN,
    planOverride: input.planOverride,
    priorPlanOverride: input.priorPlanOverride,
    proposedOpenCheckpoint: input.proposedOpenCheckpoint,
    noLlm: input.noLlm,
    dryRun: true,
  });
  if (!evaluated.evaluator_results.length)
    return { ...evaluated, run_event_ids: [], publication: null };
  const appended = await appendDatabaseCaptureEvents({
    handle,
    binding: input.context.binding,
    artifactId,
    operationId: uuidv7(),
    authoredPayload: {
      kind: 'evaluator-runs',
      artifact_id: artifactId,
      fires_at: input.firesAt,
      checkpoint_n: input.checkpointN ?? null,
      runs: evaluated.evaluator_results,
    },
    secretAllow: input.context.config.redact.allow,
    explicitTarget: input.explicitTarget,
    options: input.options,
    evaluate: async (semantics) => {
      for (const run of evaluated.evaluator_results)
        await semantics.writeEvaluatorRunPayload(artifactId, run, { idempotencyKey: uuidv7() });
      return null;
    },
  });
  const written = new Set(evaluated.evaluator_results.map((run) => run.run_id));
  const log = readProjectArtifact(handle, artifactId)?.thread.evaluatorLog ?? null;
  return {
    ...evaluated,
    blocking:
      evaluated.evaluator_results.some(isBlockingEvaluatorFailure) ||
      (log !== null &&
        log.runs.some((run) => written.has(run.run_id) && run.disposition === 'unresolved')),
    run_event_ids: appended.publication?.value.eventIds ?? [],
    publication: appended.publication,
  };
}

export interface DatabaseLifecycleKey {
  firesAt: LifecycleFiresAt;
  cpN: number;
}

export function readDatabaseLifecycleCompletion(
  handle: ProjectDatabase,
  artifactId: string,
  key: DatabaseLifecycleKey
) {
  return (
    readProjectLifecycleCompletions(handle, artifactId).records.find(
      (entry) => entry.record.fires_at === key.firesAt && entry.record.cp_n === key.cpN
    ) ?? null
  );
}

/**
 * Explicit evaluator completion is a retained receipt distinct from the runs. `once`
 * keeps the first completion for a key; `replace` retains a further observation as a
 * new revision, which is what an explicit re-run records.
 */
export async function publishDatabaseLifecycleCompletion(
  handle: ProjectDatabase,
  input: {
    artifactId: string;
    key: DatabaseLifecycleKey;
    triggeredAt: string;
    command: string;
    secretAllow: readonly string[];
    mode: 'once' | 'replace';
  },
  options: ProjectOperationOptions = {}
) {
  const existing = readDatabaseLifecycleCompletion(handle, input.artifactId, input.key);
  if (existing && input.mode === 'once')
    return { state: 'replayed' as const, selection: existing.selection };
  const artifact = readProjectArtifact(handle, input.artifactId);
  if (!artifact)
    throw new Error(`Cannot complete lifecycle: artifact "${input.artifactId}" is unavailable.`);
  const row = {
    fires_at: input.key.firesAt,
    cp_n: input.key.cpN,
    triggered_at: input.triggeredAt,
  };
  const published = await publishProjectLifecycleCompletion(
    handle,
    {
      operationId: uuidv7(),
      revisionId: uuidv7(),
      artifactId: input.artifactId,
      artifactRevision: artifact.revision,
      expectedSelection: existing?.selection ?? null,
      source: {
        identity: `cli:${input.command}`,
        locator: `sqlite:artifact_lifecycle_revisions:${input.artifactId}/${input.key.firesAt}/${input.key.cpN}`,
        revisionId: null,
        eventId: null,
        operationId: null,
        sha256: null,
      },
      bytes: Buffer.from(canonicalJson(row)),
    },
    { secretAllow: [...input.secretAllow] },
    options
  );
  return { state: 'published' as const, selection: published.value.selection };
}
