import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  CAPTURE_AGENT_IDS,
  hasRecordedCriteria,
  missingCriteriaOnCaptureMessage,
  PlanAcceptanceCriteriaRequiredError,
  PlanInputSchema,
  prepareArtifactDraft,
  uuidv7,
} from '@orcaops/storage';
import {
  appendProjectPlanCapture,
  beginProjectPlanCaptureRetention,
  type CaptureOperationOptions,
  type PlanCaptureAuthoredInput,
  planCaptureCommand,
  planCaptureInput,
  preparePlanCaptureCommand,
  preparePlanCaptureInput,
  preparePlanTaskUses,
  prepareProjectGitRetention,
  type ProjectDatabase,
  ProjectDatabaseError,
  queryProjectArtifacts,
  readProjectArtifact,
  readProjectPlanCapture,
  replayProjectPlanCapture,
  requireRetainedUseTargets,
} from '@orcaops/storage/history/database';

import { copyDatabaseAuthoredValue, refuseDatabaseAuthoredSecrets } from '../authored-input.js';
import { resumeDatabaseCaptureRetention } from './retention.js';
import {
  type RegisteredDatabaseContext,
  revalidateDatabaseExecutionContext,
} from '../context/execution.js';
import { prepareDatabaseSnapshot } from '../retention/snapshot.js';

const settingsSchema = z.strictObject({
  agent: z.enum(CAPTURE_AGENT_IDS),
  snapshot: z.strictObject({ enabled: z.boolean(), excludePatterns: z.array(z.string()) }),
  secretAllow: z.array(z.string()),
});
export type DatabasePlanCaptureInput = PlanCaptureAuthoredInput & z.infer<typeof settingsSchema>;
type Publication =
  | Awaited<ReturnType<typeof appendProjectPlanCapture>>
  | Awaited<ReturnType<typeof resumeDatabaseCaptureRetention>>;
export interface DatabasePlanCaptureResult {
  artifactId: string;
  planEventId: string;
  publication: Publication | null;
  replayed: boolean;
  historical: boolean;
  warnings: string[];
}

function inheritedBaseline(handle: ProjectDatabase, branch: string) {
  const candidates = queryProjectArtifacts(handle, { branch, profile: 'versions' }).rows.filter(
    (row) => row.completedAt === null && row.openCheckpointCount > 0
  );
  if (candidates.length !== 1) return null;
  const row = candidates[0]!;
  const artifact = readProjectArtifact(handle, row.artifactId, {
    generation: row.generation,
    orderedHash: row.orderedHash,
    eventCount: row.eventCount,
    byteLength: row.byteLength,
    tailEventId: row.tailEventId,
  });
  if (!artifact)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The selected pre-work artifact is missing; preserve its identity for explicit repair'
    );
  const open = artifact.thread.checkpoints
    .filter((checkpoint) => checkpoint.status === 'open')
    .sort((a, b) => a.n - b.n)[0];
  return !artifact.thread.summary && open
    ? { artifactId: row.artifactId, tree: open.open_snapshot.tree_sha }
    : null;
}

export async function captureDatabasePlan(
  handle: ProjectDatabase,
  expected: RegisteredDatabaseContext,
  raw: DatabasePlanCaptureInput,
  options: CaptureOperationOptions = {}
): Promise<DatabasePlanCaptureResult> {
  const copied = copyDatabaseAuthoredValue(
    raw,
    'plan capture'
  ) as unknown as DatabasePlanCaptureInput;
  const settings = settingsSchema.safeParse({
    agent: copied.agent,
    snapshot: copied.snapshot,
    secretAllow: copied.secretAllow,
  });
  if (!settings.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the capture agent, explicit snapshot policy and approved secret allowances',
      { cause: settings.error }
    );
  refuseDatabaseAuthoredSecrets(copied, settings.data.secretAllow, 'plan capture');
  const prepared = preparePlanCaptureInput(
    { authored: copied.authored, sourcePlan: copied.sourcePlan },
    settings.data.secretAllow
  );
  const original = planCaptureInput(prepared);
  const context = structuredClone(expected);
  const runtime = {
    signal: options.signal,
    onWait: options.onWait,
    processing: options.processing,
  };
  const replay = async (): Promise<DatabasePlanCaptureResult | null> => {
    const found = readProjectPlanCapture(handle, prepared);
    if (!isDeepStrictEqual(handle.authority, context.authority))
      throw new ProjectDatabaseError(
        'AUTHORITY_MISMATCH',
        'Use the original registered project database for this plan'
      );
    if (!found) return null;
    if (found.kind === 'historical')
      return {
        artifactId: found.artifact.artifactId,
        planEventId: found.planEventId,
        publication: null,
        replayed: true,
        historical: true,
        warnings: [],
      };
    const command = planCaptureCommand(found.command);
    const publication =
      command.admissionOperationId === command.originalOperationId
        ? await replayProjectPlanCapture(handle, found.command, runtime)
        : await resumeDatabaseCaptureRetention(
            handle,
            context,
            command.originalOperationId,
            runtime
          );
    return {
      artifactId: command.artifactId,
      planEventId: command.planEventId,
      publication,
      replayed: true,
      historical: false,
      warnings: [],
    };
  };
  const previous = await replay();
  if (previous) return previous;

  // New-request admission starts HERE, after the replay lookup missed. The rule
  // cannot move any earlier: `prepared` doubles as the idempotency lookup key,
  // so validating during preparation — or injecting a placeholder criterion
  // into it — would change the canonical bytes and orphan an already-admitted
  // pending command captured before this contract.
  const uncovered = original.authored.plan_steps
    .map((step, index) => ({ step, position: index + 1 }))
    .filter(({ step }) => !hasRecordedCriteria(step))
    .map(({ step, position }) => ({
      stepId: null,
      label: step.label,
      position,
      kind: 'authored' as const,
    }));
  if (uncovered.length > 0)
    throw new PlanAcceptanceCriteriaRequiredError(
      missingCriteriaOnCaptureMessage(uncovered),
      uncovered
    );
  const current = await revalidateDatabaseExecutionContext(context, { signal: runtime.signal });
  if (!current.binding)
    throw new ProjectDatabaseError(
      'EXECUTION_CONTEXT_CHANGED',
      'Establish the original worktree execution context before capturing a new plan'
    );
  const authored = original.authored;
  const operationId = uuidv7();
  const plan = PlanInputSchema.parse({
    schema_version: 4,
    artifact_id: uuidv7(),
    branch: authored.branch ?? current.binding.git_context.branch ?? 'HEAD',
    base_sha: current.binding.git_context.head_sha,
    agent: settings.data.agent,
    agent_session_id: authored.agent_session_id ?? null,
    task: authored.task,
    label: authored.label,
    plan_steps: authored.plan_steps.map((step) => ({
      ...step,
      step_id: uuidv7(),
      acceptance_criteria: step.acceptance_criteria.map((criterion) => ({
        ...criterion,
        criterion_id: uuidv7(),
      })),
    })),
    touched_scope: authored.touched_scope,
    non_goals: authored.non_goals,
    decisions: authored.decisions.map((decision) => ({ ...decision, revision_n: 0 })),
    started_at: new Date().toISOString(),
    revision_n: 0,
    revised_at: null,
    rationale: null,
    prior_plan_event_id: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
  });
  refuseDatabaseAuthoredSecrets(
    { plan, sourcePlan: original.sourcePlan },
    settings.data.secretAllow,
    'plan capture'
  );
  const warnings: string[] = [];
  const inherited =
    settings.data.snapshot.enabled && original.sourcePlan
      ? inheritedBaseline(handle, plan.branch)
      : null;
  const snapshotRequest = {
    label: `plan ${plan.artifact_id} baseline`,
    authoredPayloads: [JSON.parse(JSON.stringify({ plan, sourcePlan: original.sourcePlan }))],
    secretAllow: settings.data.secretAllow,
    excludePatterns: settings.data.snapshot.excludePatterns,
  };
  let snapshot = settings.data.snapshot.enabled
    ? await prepareDatabaseSnapshot(
        current,
        {
          ...snapshotRequest,
          source: inherited?.tree
            ? { kind: 'tree', treeOid: inherited.tree }
            : { kind: 'worktree' },
        },
        { signal: runtime.signal }
      )
    : null;
  if (snapshot && !snapshot.ok && inherited?.tree) {
    warnings.push(
      'The superseded pre-work tree is unavailable; retaining the current plan baseline if it can be captured.'
    );
    snapshot = await prepareDatabaseSnapshot(
      current,
      { ...snapshotRequest, source: { kind: 'worktree' } },
      { signal: runtime.signal }
    );
  }
  if (snapshot && !snapshot.ok)
    warnings.push(
      `Plan baseline snapshot is unavailable${snapshot.error_message ? ` (${snapshot.error_message})` : ''}; empty-fence seed recovery has no baseline.`
    );
  const draft = await prepareArtifactDraft(
    {
      artifactId: plan.artifact_id,
      priorEvents: [],
      authoredPayload: { authored, sourcePlan: original.sourcePlan, plan },
      secretAllow: settings.data.secretAllow,
      idempotencyBlocks: [],
    },
    (semantics) =>
      semantics.writePlan(plan, {
        idempotencyKey: authored.idempotency_key,
        sourcePlan: original.sourcePlan ?? undefined,
        baselineSeedTreeSha: snapshot?.ok ? snapshot.tree_sha : null,
        baselineUnmergedPaths: snapshot?.ok ? [...snapshot.unmerged_paths] : [],
        supersededArtifactId: inherited?.artifactId ?? null,
      })
  );
  if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
  const event = draft.events[0];
  if (
    !event ||
    draft.events.length !== 1 ||
    event.record.type !== 'plan_captured' ||
    draft.idempotencyChanges.length
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Initial plan preparation must produce its one original plan event without unrelated attempt changes'
    );
  // Read before the writer settles anything: a plan naming a revision this history does not
  // retain is refused with the writer's own code and captures nothing. The settlement checks the
  // same targets again inside its transaction, which is what actually decides.
  const uses = preparePlanTaskUses({
    artifactId: plan.artifact_id,
    planEventId: event.record.event_id,
    uses: authored.knowledge_uses,
    secretAllow: settings.data.secretAllow,
  });
  if (uses)
    handle.read((view) => {
      requireRetainedUseTargets(view, uses);
      return null;
    });
  const capture = {
    operationId,
    artifactId: plan.artifact_id,
    expectedRevision: null,
    eventBytes: event.eventBytes,
    sidecarPayloads: event.sidecar
      ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }]
      : [],
    secretAllow: settings.data.secretAllow,
    execution: { kind: 'create' as const, context: current.binding, ts: plan.started_at },
  };
  const admissionOperationId = snapshot?.ok ? uuidv7() : operationId;
  const command = preparePlanCaptureCommand(prepared, {
    originalOperationId: operationId,
    admissionOperationId,
    artifactId: plan.artifact_id,
    planEventId: event.record.event_id,
  });
  try {
    await revalidateDatabaseExecutionContext(current, { signal: runtime.signal });
    let publication: Publication;
    if (snapshot?.ok) {
      const retention = prepareProjectGitRetention({
        operationId,
        admissionOperationId,
        preparedTransitionId: uuidv7(),
        repositoryInstanceId: handle.authority.repositoryInstanceId,
        objectFormat: snapshot.object_format,
        createdAt: plan.started_at,
        target: {
          kind: 'capture',
          artifactId: plan.artifact_id,
          expectedRevision: null,
          expectedExecutionVersion: null,
          expectedBindingGeneration: null,
          expectedBaselinePublicationId: null,
        },
        publications: [
          {
            publicationId: uuidv7(),
            role: 'baseline',
            targetId: event.record.event_id,
            checkpointNumber: null,
            checkpointPhase: null,
            objectOid: snapshot.commit_sha,
            treeOid: snapshot.tree_sha,
          },
        ],
        secretAllow: settings.data.secretAllow,
      });
      await beginProjectPlanCaptureRetention(handle, { capture, command, retention }, runtime);
      publication = await resumeDatabaseCaptureRetention(handle, current, operationId, runtime);
    } else
      publication = await appendProjectPlanCapture(handle, { capture, command, uses }, runtime);
    return {
      artifactId: plan.artifact_id,
      planEventId: event.record.event_id,
      publication,
      replayed: publication.replayed,
      historical: false,
      warnings,
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'IDEMPOTENCY_CONFLICT') {
      const winner = await replay();
      if (winner) return winner;
    }
    throw cause;
  }
}
