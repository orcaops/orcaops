import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { CapturePlanInputSchema, PlanInputSchema, uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  beginProjectPlanCaptureRetention,
  initializeProjectDatabase,
  planCaptureCommand,
  planCaptureInput,
  preparePlanCaptureCommand,
  preparePlanCaptureInput,
  prepareProjectGitRetention,
  type ProjectDatabase,
  ProjectDatabaseError,
  projectDatabasePath,
  readProjectArtifact,
  readProjectExecution,
  readProjectPendingCapture,
  readProjectPlanCapture,
} from '@orcaops/storage/history/database';
import { digest } from '@orcaops/storage/history/primitives';

import { captureDatabasePlan, type DatabasePlanCaptureInput } from './plan.js';
import { appendProjectExecutionCapture } from '../../../../storage/dist/history/database/execution-capture.js';
import { encodeArtifactEvent } from '../../../../storage/dist/history/event-encoding.js';
import * as contexts from '../context/execution.js';
import type { RegisteredDatabaseContext } from '../context/execution.js';
import * as publication from '../retention/publication.js';
import * as snapshots from '../retention/snapshot.js';

vi.mock('../context/execution.js', async (original) => ({
  ...(await original<typeof import('../context/execution.js')>()),
}));
vi.mock('../retention/publication.js', async (original) => ({
  ...(await original<typeof import('../retention/publication.js')>()),
}));
vi.mock('../retention/snapshot.js', async (original) => ({
  ...(await original<typeof import('../retention/snapshot.js')>()),
}));
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-plan-composition-')),
  });
  roots.push(root.resolvedRoot);
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
    initializedAt: '2026-09-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(handle);
  const context = {
    authority,
    git: { worktreeRoot: '/original-checkout' },
    binding: {
      repository_instance_id: authority.repositoryInstanceId,
      worktree_id: uuidv7(),
      git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
    },
  } as RegisteredDatabaseContext;
  const revalidate = vi
    .spyOn(contexts, 'revalidateDatabaseExecutionContext')
    .mockImplementation(
      async (expected) =>
        structuredClone(expected) as Awaited<
          ReturnType<typeof contexts.revalidateDatabaseExecutionContext>
        >
    );
  const snapshot = vi.spyOn(snapshots, 'prepareDatabaseSnapshot').mockResolvedValue({
    ok: true,
    tree_sha: 'c'.repeat(40),
    commit_sha: 'b'.repeat(40),
    object_format: 'sha1',
    unmerged_paths: [],
  });
  const publish = vi
    .spyOn(publication, 'publishDatabaseGitRef')
    .mockImplementation(async (_context, ref) => ({
      publication: 'created',
      fullRef: ref.fullRef,
      objectOid: ref.objectOid,
    }));
  return { handle, context, revalidate, snapshot, publish };
}
function input(enabled = false): DatabasePlanCaptureInput {
  return {
    authored: CapturePlanInputSchema.parse({
      idempotency_key: 'original:core-plan',
      task: 'Publish original plan once',
      label: 'Original plan',
      plan_steps: [
        {
          text: 'Retain original identities',
          label: 'Retain identities',
          acceptance_criteria: [{ text: 'Original IDs survive retry' }],
        },
      ],
    }),
    sourcePlan: null,
    agent: 'codex',
    snapshot: { enabled, excludePatterns: [] },
    secretAllow: [],
  };
}
function state(handle: ProjectDatabase) {
  return handle.read((view) => ({
    commands: view.all('SELECT idempotency_key, artifact_id FROM plan_capture_commands'),
    operations: view.all('SELECT * FROM operations'),
    artifacts: view.all('SELECT * FROM artifacts'),
  }));
}

it('captures through fixed draft semantics and resolves original direct receipt before new work', async () => {
  const f = await fixture();
  const authored = input();
  const result = await captureDatabasePlan(f.handle, f.context, authored);
  expect(result).toMatchObject({ replayed: false, historical: false, warnings: [] });
  const artifact = readProjectArtifact(f.handle, result.artifactId)!;
  expect(artifact.thread.plan?.task).toBe(authored.authored.task);
  expect(artifact.thread.plan?.plan_steps[0].acceptance_criteria[0].criterion_id).toBeTruthy();
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  const before = state(f.handle);
  f.revalidate.mockClear();
  const replay = await captureDatabasePlan(f.handle, f.context, {
    ...authored,
    snapshot: { enabled: true, excludePatterns: ['later'] },
  });
  expect(replay).toMatchObject({
    artifactId: result.artifactId,
    planEventId: result.planEventId,
    replayed: true,
  });
  expect(replay.publication).toEqual({ ...result.publication, replayed: true });
  expect(f.revalidate).not.toHaveBeenCalled();
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(state(f.handle)).toEqual(before);
  expect(readProjectArtifact(f.handle, result.artifactId)?.thread.plan).toEqual(
    artifact.thread.plan
  );
});

it('retains the original pending command before ref effects and resumes without preparing another snapshot', async () => {
  const f = await fixture();
  const authored = input(true);
  let admittedArtifact: string | null = null;
  f.publish.mockImplementationOnce(async () => {
    const found = readProjectPlanCapture(
      f.handle,
      preparePlanCaptureInput({ authored: authored.authored, sourcePlan: authored.sourcePlan }, [])
    );
    expect(found?.kind).toBe('command');
    if (found?.kind !== 'command') throw new Error('Original admission missing');
    admittedArtifact = planCaptureCommand(found.command).artifactId;
    expect(readProjectArtifact(f.handle, admittedArtifact)).toBeNull();
    throw new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Injected interrupted ref publication');
  });
  await expect(captureDatabasePlan(f.handle, f.context, authored)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  expect(state(f.handle).counters).toEqual({ writeSequence: 2, intentChangeCounter: 0 });
  f.snapshot.mockClear();
  f.publish.mockClear();
  const recovered = await captureDatabasePlan(f.handle, f.context, authored);
  expect(recovered.artifactId).toBe(admittedArtifact);
  expect(recovered.replayed).toBe(true);
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(state(f.handle).counters).toEqual({ writeSequence: 3, intentChangeCounter: 1 });
  f.publish.mockClear();
  f.revalidate.mockClear();
  const replay = await captureDatabasePlan(f.handle, f.context, authored);
  expect(replay.publication).toEqual({ ...recovered.publication, replayed: true });
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.revalidate).not.toHaveBeenCalled();
});

it('resumes an admitted pre-upgrade empty-rubric capture from its exact retained input', async () => {
  const f = await fixture();
  const authored = rubricFreeInput([]);
  authored.snapshot.enabled = true;
  const prepared = preparePlanCaptureInput(
    { authored: authored.authored, sourcePlan: authored.sourcePlan },
    []
  );
  const request = planCaptureInput(prepared);
  const operationId = uuidv7();
  const admissionOperationId = uuidv7();
  const artifactId = uuidv7();
  const startedAt = '2026-09-01T00:00:00.000Z';
  const plan = {
    ...PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'main',
      base_sha: 'a'.repeat(40),
      agent: 'codex',
      agent_session_id: null,
      task: authored.authored.task,
      label: authored.authored.label,
      plan_steps: authored.authored.plan_steps.map((step) => ({
        ...step,
        step_id: uuidv7(),
        acceptance_criteria: [],
      })),
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: startedAt,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      prior_plan_event_id: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    }),
    baseline_seed_tree_sha: 'c'.repeat(40),
  };
  const event = encodeArtifactEvent({
    type: 'plan_captured',
    ts: startedAt,
    idempotency_key: authored.authored.idempotency_key,
    payload: plan,
  });
  const command = preparePlanCaptureCommand(prepared, {
    originalOperationId: operationId,
    admissionOperationId,
    artifactId,
    planEventId: event.record.event_id,
  });
  const capture = {
    operationId,
    artifactId,
    expectedRevision: null,
    eventBytes: event.eventBytes,
    sidecarPayloads: [],
    secretAllow: [],
    execution: { kind: 'create' as const, context: f.context.binding!, ts: startedAt },
  };
  const retention = prepareProjectGitRetention({
    operationId,
    admissionOperationId,
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: f.handle.authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: startedAt,
    target: {
      kind: 'capture',
      artifactId,
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
        objectOid: 'b'.repeat(40),
        treeOid: 'c'.repeat(40),
      },
    ],
    secretAllow: [],
  });
  await beginProjectPlanCaptureRetention(f.handle, { capture, command, retention });
  const pending = readProjectPendingCapture(f.handle, operationId).value!;
  expect(pending.capture.eventBytes).toEqual(event.eventBytes);
  expect(readProjectArtifact(f.handle, artifactId)).toBeNull();

  f.snapshot.mockClear();
  const recovered = await captureDatabasePlan(f.handle, f.context, authored);
  expect(recovered).toMatchObject({
    artifactId,
    planEventId: event.record.event_id,
    replayed: true,
  });
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.publish.mock.calls[0]![1]).toMatchObject({
    objectOid: 'b'.repeat(40),
    treeOid: 'c'.repeat(40),
  });
  expect(readProjectArtifact(f.handle, artifactId)?.thread.plan?.plan_steps[0]).toMatchObject({
    text: 'Retain original identities',
    acceptance_criteria: [],
  });
  const retained = readProjectPlanCapture(f.handle, prepared);
  expect(retained?.kind).toBe('command');
  if (retained?.kind !== 'command') throw new Error('Retained command missing');
  expect(planCaptureCommand(retained.command)).toMatchObject({
    originalOperationId: operationId,
    admissionOperationId,
    artifactId,
    planEventId: event.record.event_id,
    requestBytes: request.requestBytes,
    requestHash: request.requestHash,
  });
  f.publish.mockClear();
  f.revalidate.mockClear();
  const replay = await captureDatabasePlan(f.handle, f.context, authored);
  expect(replay).toMatchObject({
    artifactId,
    planEventId: event.record.event_id,
    replayed: true,
  });
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.revalidate).not.toHaveBeenCalled();
});

it('refuses changed authored input before resuming an admitted command', async () => {
  const f = await fixture();
  const authored = input(true);
  f.publish.mockRejectedValueOnce(
    new ProjectDatabaseError('HISTORY_INACCESSIBLE', 'Injected interruption')
  );
  await expect(captureDatabasePlan(f.handle, f.context, authored)).rejects.toMatchObject({
    code: 'HISTORY_INACCESSIBLE',
  });
  const before = state(f.handle);
  f.revalidate.mockClear();
  f.snapshot.mockClear();
  f.publish.mockClear();
  await expect(
    captureDatabasePlan(f.handle, f.context, {
      ...authored,
      authored: { ...authored.authored, task: 'Different payload' },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(f.revalidate).not.toHaveBeenCalled();
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  expect(state(f.handle)).toEqual(before);
});

it('publishes a degraded plan honestly when snapshot preparation is unavailable', async () => {
  const f = await fixture();
  f.snapshot.mockResolvedValue({
    ok: false,
    error_reason: 'unknown',
    error_message: 'Injected unavailable snapshot',
  });
  const result = await captureDatabasePlan(f.handle, f.context, input(true));
  expect(result.warnings).toEqual([
    'Plan baseline snapshot is unavailable; empty-fence seed recovery has no baseline.',
  ]);
  expect(
    readProjectArtifact(f.handle, result.artifactId)?.thread.artifactJson?.baseline_seed_tree_sha
  ).toBeNull();
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.handle.read((view) => view.all('SELECT * FROM pending_capture_requests')).value).toEqual(
    []
  );
  expect(state(f.handle).counters).toEqual({ writeSequence: 2, intentChangeCounter: 1 });
});

it('refuses authored secrets before consulting even a fabricated database handle', async () => {
  const f = await fixture();
  const authored = input();
  authored.authored.task = 'ghp_' + 'a'.repeat(36);
  const read = vi.fn();
  await expect(
    captureDatabasePlan({ read } as unknown as ProjectDatabase, f.context, authored)
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(read).not.toHaveBeenCalled();
  expect(f.revalidate).not.toHaveBeenCalled();
  expect(f.snapshot).not.toHaveBeenCalled();
});

it('detaches authored data and runtime context before asynchronous preparation', async () => {
  const f = await fixture();
  const authored = input();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  f.revalidate.mockImplementationOnce(async (expected) => {
    observed();
    await waiting;
    return structuredClone(expected) as Awaited<
      ReturnType<typeof contexts.revalidateDatabaseExecutionContext>
    >;
  });
  const capture = captureDatabasePlan(f.handle, f.context, authored);
  await started;
  authored.authored.task = 'Changed caller input';
  authored.snapshot.enabled = true;
  f.context.binding!.git_context.branch = 'changed';
  release();
  const result = await capture;
  expect(readProjectArtifact(f.handle, result.artifactId)?.thread.plan).toMatchObject({
    task: 'Publish original plan once',
    branch: 'main',
  });
  expect(f.snapshot).not.toHaveBeenCalled();
});

it('refuses stale execution context before admission without compensating object work', async () => {
  const f = await fixture();
  const before = state(f.handle);
  f.revalidate
    .mockImplementationOnce(
      async (expected) =>
        expected as Awaited<ReturnType<typeof contexts.revalidateDatabaseExecutionContext>>
    )
    .mockRejectedValueOnce(
      new ProjectDatabaseError('EXECUTION_CONTEXT_CHANGED', 'Injected changed context')
    );
  await expect(captureDatabasePlan(f.handle, f.context, input(true))).rejects.toMatchObject({
    code: 'EXECUTION_CONTEXT_CHANGED',
  });
  expect(f.snapshot).toHaveBeenCalledTimes(1);
  expect(f.publish).not.toHaveBeenCalled();
  expect(state(f.handle)).toEqual(before);
});

it.each([false, true])(
  'preserves the pre-work baseline and its explicit fallback when unavailable: %s',
  async (unavailable) => {
    const f = await fixture();
    const prior = await captureDatabasePlan(f.handle, f.context, input());
    const artifact = readProjectArtifact(f.handle, prior.artifactId)!;
    const execution = readProjectExecution(f.handle, prior.artifactId)!;
    const event = encodeArtifactEvent({
      type: 'checkpoint_opened',
      ts: '2026-09-01T00:01:00.000Z',
      idempotency_key: uuidv7(),
      payload: {
        artifact_id: prior.artifactId,
        n: 1,
        declared_step_ids: [artifact.thread.plan!.plan_steps[0].step_id],
        agent: 'codex',
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: prior.planEventId,
        opened_at: '2026-09-01T00:01:00.000Z',
        head_sha: 'a'.repeat(40),
        open_snapshot: {
          snapshot_ref: `refs/orcaops/snap/${prior.artifactId}/1/open-${uuidv7()}`,
          tree_sha: 'e'.repeat(40),
          snapshot_commit_sha: 'f'.repeat(40),
          snapshot_error_reason: null,
        },
      },
    });
    await appendProjectExecutionCapture(f.handle, {
      operationId: uuidv7(),
      artifactId: prior.artifactId,
      expectedRevision: artifact.revision,
      eventBytes: event.eventBytes,
      sidecarPayloads: [],
      secretAllow: [],
      execution: {
        kind: 'task',
        context: f.context.binding!,
        expectedVersion: execution.version,
        expectedGeneration: execution.state.binding_generation,
        explicitTarget: true,
      },
    });
    f.snapshot.mockImplementationOnce(async (_context, request) => {
      expect(request.source).toEqual({ kind: 'tree', treeOid: 'e'.repeat(40) });
      return unavailable
        ? { ok: false, error_reason: 'unknown' }
        : {
            ok: true,
            tree_sha: 'e'.repeat(40),
            commit_sha: 'b'.repeat(40),
            object_format: 'sha1',
            unmerged_paths: [],
          };
    });
    const authored = input(true);
    authored.authored.idempotency_key = 'new:source-plan';
    const content = 'Original approved source plan';
    const pinned: DatabasePlanCaptureInput = {
      ...authored,
      sourcePlan: {
        source_ref: { kind: 'local', locator: '/original/plan.md' },
        content,
        hash: digest(content),
        baseline: null,
      },
    };
    const result = await captureDatabasePlan(f.handle, f.context, pinned);
    const captured = readProjectArtifact(f.handle, result.artifactId)!.thread.artifactJson!;
    expect(captured.source_plan).toEqual(pinned.sourcePlan);
    expect(captured.superseded_artifact_id).toBe(prior.artifactId);
    expect(captured.baseline_seed_tree_sha).toBe((unavailable ? 'c' : 'e').repeat(40));
    expect(f.snapshot).toHaveBeenCalledTimes(unavailable ? 2 : 1);
    if (unavailable) {
      expect(f.snapshot.mock.calls[1]![1].source).toEqual({ kind: 'worktree' });
      expect(result.warnings).toEqual([
        'The superseded pre-work tree is unavailable; retaining the current plan baseline if it can be captured.',
      ]);
    } else expect(result.warnings).toEqual([]);
  }
);

it('rejects a forged capture handle before invoking supplied methods or getters', async () => {
  const f = await fixture();
  const read = vi.fn();
  const authority = vi.fn(() => f.handle.authority);
  const forged = {
    read,
    get authority() {
      return authority();
    },
  } as unknown as ProjectDatabase;
  const before = state(f.handle);
  await expect(captureDatabasePlan(forged, f.context, input())).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(read).not.toHaveBeenCalled();
  expect(authority).not.toHaveBeenCalled();
  expect(f.revalidate).not.toHaveBeenCalled();
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(state(f.handle)).toEqual(before);
});

it('refuses another registered authority before replaying a genuine command', async () => {
  const f = await fixture();
  const original = input();
  await captureDatabasePlan(f.handle, f.context, original);
  f.revalidate.mockClear();
  const before = state(f.handle);
  await expect(
    captureDatabasePlan(
      f.handle,
      {
        ...f.context,
        authority: { ...f.context.authority, projectId: uuidv7() },
      },
      original
    )
  ).rejects.toMatchObject({ code: 'AUTHORITY_MISMATCH' });
  expect(f.revalidate).not.toHaveBeenCalled();
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  expect(state(f.handle)).toEqual(before);
});

function rubricFreeInput(criteria?: unknown): DatabasePlanCaptureInput {
  return {
    authored: CapturePlanInputSchema.parse({
      idempotency_key: 'rubric-free:core-plan',
      task: 'Capture a step with no rubric',
      label: 'Rubric-free plan',
      plan_steps: [
        {
          text: 'Retain original identities',
          label: 'Retain identities',
          ...(criteria === undefined ? {} : { acceptance_criteria: criteria }),
        },
      ],
    }),
    sourcePlan: null,
    agent: 'codex',
    snapshot: { enabled: false, excludePatterns: [] },
    secretAllow: [],
  };
}

it('refuses a new capture whose step declares no acceptance criteria', async () => {
  const f = await fixture();
  const before = state(f.handle);
  await expect(captureDatabasePlan(f.handle, f.context, rubricFreeInput([]))).rejects.toMatchObject(
    {
      code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED',
      path: 'plan_steps',
      steps: [{ label: 'Retain identities', position: 1, kind: 'authored' }],
    }
  );
  expect(state(f.handle)).toEqual(before);
  expect(f.revalidate).not.toHaveBeenCalled();
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it('refuses the same capture when acceptance_criteria is omitted entirely', async () => {
  const f = await fixture();
  // The input schema defaults the omitted key to [], so both spellings of
  // "no rubric" reach the gate as the same shape.
  const authored = rubricFreeInput();
  expect(authored.authored.plan_steps[0].acceptance_criteria).toEqual([]);
  await expect(captureDatabasePlan(f.handle, f.context, authored)).rejects.toMatchObject({
    code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED',
  });
});

it('does not let authored origin input bypass the rubric requirement', async () => {
  const f = await fixture();
  const authored = rubricFreeInput([]);
  const forged = {
    ...authored,
    authored: CapturePlanInputSchema.parse({
      ...authored.authored,
      origin: {
        kind: 'git-import',
        imported_at: '2026-09-01T00:00:00.000Z',
        tool_version: 'forged',
        source_range: 'HEAD~1..HEAD',
        authors: ['forged@example.test'],
        enriched_at: null,
      },
    }),
  };
  expect(forged.authored).not.toHaveProperty('origin');
  await expect(captureDatabasePlan(f.handle, f.context, forged)).rejects.toMatchObject({
    code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED',
  });
});

it('names the step and teaches the nested YAML shape when the rubric is missing', async () => {
  const f = await fixture();
  await expect(captureDatabasePlan(f.handle, f.context, rubricFreeInput([]))).rejects.toThrow(
    /step #1 "Retain identities" declares no acceptance criteria[\s\S]*acceptance_criteria:\n {6}- text: \|-/
  );
});

it('rejects a blank-only criterion at the input boundary', () => {
  expect(() => rubricFreeInput([{ text: '   ' }])).toThrow();
});
