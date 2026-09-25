// A real project database in a temporary root, with real captured plans in it, for the tests of
// the writers that record continuing knowledge. Plans are captured through the public capture
// path, so a promoted criterion is found where a released build actually puts it: inside the
// retained bytes of the plan event.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readProjectArtifact } from '../src/history/database/artifacts.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  projectDatabasePath,
  type ProjectReadView,
} from '../src/history/database/connection.js';
import {
  appendProjectExecutionCapture,
  appendProjectPlanCapture,
  type CaptureProcessingAdmission,
} from '../src/history/database/execution-capture.js';
import { readProjectExecution } from '../src/history/database/execution-records.js';
import { publishProjectObservation } from '../src/history/database/knowledge-observations.js';
import { publishProjectKnowledgeSource } from '../src/history/database/knowledge-sources.js';
import {
  prepareProjectTaskUses,
  settleProjectTaskUses,
} from '../src/history/database/knowledge-task-uses.js';
import {
  preparePlanCaptureCommand,
  preparePlanCaptureInput,
} from '../src/history/database/plan-capture-input.js';
import { runProjectOperation } from '../src/history/database/transactions.js';
import { digest, recordChecksum } from '../src/history/event-integrity.js';
import { normalizeHistoryRoot } from '../src/history/paths.js';
import { uuidv7 } from '../src/ids/uuidv7.js';
import { CapturePlanInputSchema } from '../src/schema/capture-input.js';

const AT = '2026-09-17T09:00:00.000Z';

export interface KnowledgeStore {
  readonly handle: ProjectDatabase;
  readonly authority: ProjectDatabaseAuthority;
}

export interface PlanCriterion {
  readonly criterionId: string;
  readonly text: string;
}

export interface PlanStep {
  readonly stepId: string;
  readonly criteria: readonly PlanCriterion[];
}

export interface CapturedPlan {
  readonly artifactId: string;
  readonly planEventId: string;
  readonly steps: readonly PlanStep[];
  readonly task?: string;
  readonly label?: string;
}

const open: { handle: ProjectDatabase; root: string }[] = [];

export async function knowledgeStore(): Promise<KnowledgeStore> {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'orcaops-knowledge-writers-')),
  });
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: AT,
    authorize() {},
  });
  open.push({ handle, root: root.resolvedRoot });
  return { handle, authority };
}

export async function discardKnowledgeStores(): Promise<void> {
  const taken = open.splice(0);
  taken.forEach(({ handle }) => handle.close());
  await Promise.all(taken.map(({ root }) => rm(root, { recursive: true, force: true })));
}

/** Captures a plan whose steps and criteria carry exactly the identities the caller names. */
export async function capturePlan(
  handle: ProjectDatabase,
  plan: CapturedPlan,
  processing?: CaptureProcessingAdmission
): Promise<{ operationId: string; worktreeId: string }> {
  const task = plan.task ?? 'Keep local capture working offline';
  const authored = CapturePlanInputSchema.parse({
    idempotency_key: `knowledge:${plan.planEventId}`,
    task,
    label: plan.label ?? task,
    plan_steps: plan.steps.map((step, index) => ({
      text: `Step ${index + 1}`,
      label: `Step ${index + 1}`,
      acceptance_criteria: step.criteria.map((criterion) => ({ text: criterion.text })),
    })),
  });
  const prepared = preparePlanCaptureInput({ authored, sourcePlan: null }, []);
  const operationId = uuidv7();
  const worktreeId = uuidv7();
  const payload = {
    schema_version: 4,
    artifact_id: plan.artifactId,
    branch: 'main',
    base_sha: 'a'.repeat(40),
    agent: 'codex',
    agent_session_id: null,
    task: authored.task,
    label: authored.label,
    plan_steps: authored.plan_steps.map((step, index) => ({
      ...step,
      step_id: plan.steps[index]!.stepId,
      acceptance_criteria: step.acceptance_criteria.map((criterion, position) => ({
        ...criterion,
        criterion_id: plan.steps[index]!.criteria[position]!.criterionId,
      })),
    })),
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: AT,
    revision_n: 0,
    revised_at: null,
    rationale: null,
    prior_plan_event_id: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
  };
  const record = {
    event_id: plan.planEventId,
    type: 'plan_captured' as const,
    ts: AT,
    schema_version: 1,
    idempotency_key: authored.idempotency_key,
    payload,
  };
  await appendProjectPlanCapture(
    handle,
    {
      capture: {
        artifactId: plan.artifactId,
        operationId,
        expectedRevision: null,
        eventBytes: Buffer.from(
          `${JSON.stringify({ ...record, checksum: recordChecksum(record) })}\n`
        ),
        sidecarPayloads: [],
        secretAllow: [],
        execution: {
          kind: 'create',
          ts: AT,
          context: {
            repository_instance_id: handle.authority.repositoryInstanceId,
            worktree_id: worktreeId,
            git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
          },
        },
      },
      command: preparePlanCaptureCommand(prepared, {
        artifactId: plan.artifactId,
        planEventId: plan.planEventId,
        originalOperationId: operationId,
        admissionOperationId: operationId,
      }),
    },
    processing === undefined ? {} : { processing }
  );
  return { operationId, worktreeId };
}

/**
 * One operation that publishes a plan event and records the uses that event selected with it,
 * which is the shape the capture path settles in and the only way a use is an original selection.
 */
export async function capturePlanWithTaskUses(
  handle: ProjectDatabase,
  plan: CapturedPlan,
  uses: readonly unknown[]
) {
  const prepared = prepareProjectTaskUses(uses, [], null);
  const record = {
    event_id: plan.planEventId,
    type: 'plan_captured' as const,
    ts: AT,
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: {
      artifact_id: plan.artifactId,
      plan_steps: plan.steps.map((step) => ({
        step_id: step.stepId,
        acceptance_criteria: step.criteria.map((criterion) => ({
          criterion_id: criterion.criterionId,
          text: criterion.text,
        })),
      })),
    },
  };
  const bytes = Buffer.from(`${JSON.stringify({ ...record, checksum: recordChecksum(record) })}\n`);
  return runProjectOperation(
    handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.plan.settlement',
      target: { artifactId: plan.artifactId, planEventId: plan.planEventId },
      payload: { uses: prepared.authoredSha256.slice() },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      transaction.run(
        'INSERT INTO artifacts (artifact_id, current_generation) VALUES (?,1)',
        plan.artifactId
      );
      transaction.run(
        `INSERT INTO artifact_events (artifact_id, event_id, ordinal, record_bytes, sidecar_payload_bytes, checksum, record_hash, event_type, recorded_at)
         VALUES (?,?,1,?,NULL,?,?,'plan_captured',?)`,
        plan.artifactId,
        plan.planEventId,
        bytes,
        recordChecksum(record),
        digest(bytes),
        AT
      );
      transaction.run(
        `INSERT INTO artifact_revisions (artifact_id, generation, operation_id, ordered_hash, event_count, byte_length, tail_event_id)
         VALUES (?,1,?,?,1,?,?)`,
        plan.artifactId,
        settling.operationId,
        digest(bytes),
        bytes.length,
        plan.planEventId
      );
      return settleProjectTaskUses(transaction, settling, prepared, null);
    }
  );
}

/** A capture event that is not a plan event, for the rules that only a plan event satisfies. */
export async function captureCheckpoint(
  handle: ProjectDatabase,
  plan: CapturedPlan,
  worktreeId: string,
  n = 1
): Promise<string> {
  const artifact = readProjectArtifact(handle, plan.artifactId)!;
  const owner = readProjectExecution(handle, plan.artifactId)!;
  const record = {
    event_id: uuidv7(),
    type: 'checkpoint_opened' as const,
    ts: '2026-09-17T09:05:00.000Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: {
      artifact_id: plan.artifactId,
      n,
      // One step per checkpoint, because two open checkpoints may not declare the same one.
      declared_step_ids: [(plan.steps[n - 1] ?? plan.steps[0]!).stepId],
      agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: plan.planEventId,
      opened_at: '2026-09-17T09:05:00.000Z',
      head_sha: 'a'.repeat(40),
      open_snapshot: {
        snapshot_ref: null,
        tree_sha: null,
        snapshot_commit_sha: null,
        snapshot_error_reason: null,
      },
    },
  };
  await appendProjectExecutionCapture(handle, {
    artifactId: plan.artifactId,
    operationId: uuidv7(),
    expectedRevision: artifact.revision,
    eventBytes: Buffer.from(`${JSON.stringify({ ...record, checksum: recordChecksum(record) })}\n`),
    sidecarPayloads: [],
    secretAllow: [],
    execution: {
      kind: 'task',
      context: {
        repository_instance_id: handle.authority.repositoryInstanceId,
        worktree_id: worktreeId,
        git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
      },
      expectedVersion: owner.version,
      expectedGeneration: owner.state.binding_generation,
      explicitTarget: true,
    },
  });
  return record.event_id;
}

/** A store holding one captured plan, with the identities that plan minted. */
export async function plannedKnowledgeStore(criteria = 1): Promise<{
  handle: ProjectDatabase;
  plan: CapturedPlan;
  planOperationId: string;
  worktreeId: string;
}> {
  const { handle } = await knowledgeStore();
  const plan: CapturedPlan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [
      {
        stepId: uuidv7(),
        criteria: Array.from({ length: criteria }, (_, index) => ({
          criterionId: uuidv7(),
          text: `Acceptance condition ${index + 1}`,
        })),
      },
    ],
  };
  const { operationId, worktreeId } = await capturePlan(handle, plan);
  return { handle, plan, planOperationId: operationId, worktreeId };
}

export const AGENT = { identity: 'claude-code', basis: 'source_attributed' } as const;
export const OWNER = {
  identity: 'owner@example.test',
  basis: 'agent_reported_user_instruction',
} as const;

/** The same two as attributions, for every field that names an actor or a detector. */
export const BY_AGENT = { kind: 'actor', actor: AGENT } as const;
export const BY_OWNER = { kind: 'actor', actor: OWNER } as const;
export const DETECTOR = { kind: 'detector', detector: 'knowledge-processor' } as const;

/** The capture field a plan criterion was read from, published as a source. */
export async function captureFieldSource(
  handle: ProjectDatabase,
  plan: Pick<CapturedPlan, 'artifactId' | 'planEventId'>,
  fieldPath = 'plan_steps[0].acceptance_criteria[0].text',
  position = 0
): Promise<string> {
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'capture_field',
        artifact_id: plan.artifactId,
        event_id: plan.planEventId,
        field_path: fieldPath,
        position,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: AGENT,
    secretAllow: [],
  });
  return published.value.sourceId;
}

/** A source retaining exactly `text`, for the rules that read what a source actually says. */
export async function retainedTextSource(
  handle: ProjectDatabase,
  text: string,
  kind: 'user_instruction' | 'document_revision' | 'evaluator_result' = 'user_instruction'
): Promise<string> {
  const bytes = Buffer.from(text, 'utf8');
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind,
        retention: { kind: 'bytes', content_sha256: digest(bytes) },
        location: null,
        source_time: null,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: AGENT,
    retainedBytes: bytes,
    secretAllow: [],
  });
  return published.value.sourceId;
}

/** A source held only by an immutable reference, which retains no text anything can be checked in. */
export async function referencedSource(handle: ProjectDatabase, text: string): Promise<string> {
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'external_reference',
        retention: {
          kind: 'retained_reference',
          reference: 'retained/specification@1',
          content_sha256: digest(Buffer.from(text, 'utf8')),
        },
        location: null,
        source_time: null,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: AGENT,
    secretAllow: [],
  });
  return published.value.sourceId;
}

/**
 * An agent-reported observation on an unknown basis, which is what a command somebody ran and
 * wrote down is worth. Tests that need a finding's evidence take this rather than inventing an id.
 */
export async function agentReportedObservation(
  handle: ProjectDatabase,
  sourceId: string,
  command = 'pnpm --filter @orcaops/storage exec vitest run src/history/database/retention.test.ts'
): Promise<string> {
  const published = await publishProjectObservation(handle, {
    operationId: uuidv7(),
    observation: {
      observation_id: uuidv7(),
      source_id: sourceId,
      method: { name: 'vitest', configuration_sha256: null },
      execution: { kind: 'agent_reported', command },
      input_basis: 'unknown',
      known_inputs: [],
      outcome: 'passed',
      detail: null,
      retained_artifacts: [],
      started_at: null,
      finished_at: null,
      limits: [],
    },
    observedBy: AGENT,
    secretAllow: [],
  });
  return published.value.observationId;
}

export const counters = (handle: ProjectDatabase) => handle.read(() => null).counters;

export const read = <T>(handle: ProjectDatabase, query: (view: ProjectReadView) => T): T =>
  handle.read(query).value;

export const rowCount = (handle: ProjectDatabase, table: string): number =>
  handle.read((view) => view.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n).value;
