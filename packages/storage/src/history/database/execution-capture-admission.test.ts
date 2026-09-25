import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { appendProjectArtifactEvents } from './artifacts.js';
import { readProjectArtifact } from './artifacts.js';
import {
  beginProjectCaptureRetention,
  settleProjectCaptureRetention,
} from './capture-retention.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  appendProjectExecutionCapture,
  type CaptureProcessingAdmission,
} from './execution-capture.js';
import { readProjectExecution } from './execution-records.js';
import { appendProjectImportedArtifact } from './imported-artifact.js';
import { readProcessingBacklog, readProcessingJob } from './processing-reader.js';
import { type PrepareProjectGitRetention, prepareProjectGitRetention } from './retention-input.js';
import {
  type ArtifactDraftSemantics,
  prepareArtifactDraft,
} from '../../artifacts/draft-preparation.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';

const ORIGIN_WORKTREE = path.join(path.sep, 'checkouts', 'the-origin');
const PROCESSING: CaptureProcessingAdmission = {
  processorContract: 'knowledge-interpretation@2',
  withoutModel: false,
  origin: { worktreeRoot: ORIGIN_WORKTREE },
};
const TS = '2026-09-01T00:00:00.000Z';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'capture-admission-')),
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
    initializedAt: TS,
    authorize() {},
  });
  handles.push(handle);
  const binding = {
    repository_instance_id: authority.repositoryInstanceId,
    worktree_id: uuidv7(),
    git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
  };
  return { handle, authority, binding };
}

function plan(artifactId: string, imported = false) {
  return {
    schema_version: 4 as const,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'a'.repeat(40),
    agent: 'codex' as const,
    agent_session_id: null,
    task: 'Interpret what a capture retained',
    label: 'Captured plan',
    plan_steps: [
      {
        step_id: uuidv7(),
        text: 'Retain the original capture',
        label: 'Retained capture',
        acceptance_criteria: [{ criterion_id: uuidv7(), text: 'the capture is retained' }],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: TS,
    revision_n: 0,
    revised_at: null,
    rationale: null,
    prior_plan_event_id: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    ...(imported
      ? {
          origin: {
            kind: 'git-import' as const,
            imported_at: TS,
            tool_version: 'test',
            source_range: 'HEAD',
            authors: ['Test'],
            enriched_at: null,
          },
        }
      : {}),
  };
}

async function draft<T>(
  handle: ProjectDatabase,
  artifactId: string,
  evaluate: (semantics: ArtifactDraftSemantics) => Promise<T>
) {
  const retained = readProjectArtifact(handle, artifactId);
  const prepared = await prepareArtifactDraft(
    {
      artifactId,
      priorEvents: retained?.thread.events ?? [],
      authoredPayload: {},
      secretAllow: [],
      idempotencyBlocks: [],
    },
    evaluate
  );
  if (prepared.evaluation.kind === 'threw') throw prepared.evaluation.error;
  return {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: retained?.revision ?? null,
    eventBytes: Buffer.concat(prepared.events.map((event) => event.eventBytes)),
    sidecarPayloads: prepared.events.flatMap((event) =>
      event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
    ),
    secretAllow: [],
    eventIds: prepared.events.map((event) => event.record.event_id),
    eventTypes: prepared.events.map((event) => event.record.type),
  };
}

/** A live plan capture that creates the artifact, as `capture plan` settles it. */
async function capturePlan(
  value: Awaited<ReturnType<typeof project>>,
  processing: CaptureProcessingAdmission | null = PROCESSING,
  imported = false
) {
  const artifactId = uuidv7();
  const request = await draft(value.handle, artifactId, (semantics) =>
    semantics.writePlan(plan(artifactId, imported), { idempotencyKey: uuidv7() })
  );
  const result = await appendProjectExecutionCapture(
    value.handle,
    { ...request, execution: { kind: 'create', context: value.binding, ts: TS } },
    { processing: processing ?? undefined }
  );
  return { artifactId, request, result };
}

/** Any later live capture on the same artifact, as every other capture verb settles it. */
async function captureTask<T>(
  value: Awaited<ReturnType<typeof project>>,
  artifactId: string,
  evaluate: (semantics: ArtifactDraftSemantics) => Promise<T>,
  processing: CaptureProcessingAdmission | undefined = PROCESSING,
  kind: 'task' | 'historical_maintenance' = 'task'
) {
  const request = await draft(value.handle, artifactId, evaluate);
  const execution = readProjectExecution(value.handle, artifactId)!;
  const result = await appendProjectExecutionCapture(
    value.handle,
    {
      ...request,
      execution: {
        kind,
        context: value.binding,
        expectedVersion: execution.version,
        expectedGeneration: execution.state.binding_generation,
        explicitTarget: true,
      },
    },
    { processing }
  );
  return { request, result };
}

function closeCheckpoint(artifactId: string) {
  return async (semantics: ArtifactDraftSemantics) => {
    const retained = await semantics.readPlan(artifactId);
    const opened = await semantics.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [retained!.plan_steps[0]!.step_id] },
      { idempotencyKey: uuidv7(), headSha: 'a'.repeat(40) }
    );
    if (!('checkpoint' in opened)) throw new Error('The fixture checkpoint did not open');
    return semantics.writeCheckpointClosed(
      {
        artifact_id: artifactId,
        n: opened.checkpoint.n,
        head_sha: 'a'.repeat(40),
        summary: 'What the checkpoint retained',
        files_changed: ['src/one.ts'],
        completed_step_ids: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
      },
      { idempotencyKey: uuidv7() }
    );
  };
}

function writeSummary(artifactId: string) {
  return (semantics: ArtifactDraftSemantics) =>
    semantics.writeSummary({
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'What the work came to',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'a'.repeat(40),
      ts: TS,
    });
}

function jobs(handle: ProjectDatabase) {
  return handle.read((view) => view.all('SELECT job_id FROM processing_jobs')).value;
}

it('admits one job for the plan a live capture publishes, in its own transaction', async () => {
  const value = await project();
  const before = value.handle.read(() => null).counters;
  const { artifactId, request, result } = await capturePlan(value);

  expect(result.admittedProcessingJobs).toHaveLength(1);
  const job = readProcessingJob(value.handle, result.admittedProcessingJobs[0]!.jobId)!;
  expect(job).toMatchObject({
    source: { kind: 'capture_event', event_id: request.eventIds[0] },
    processorContract: 'knowledge-interpretation@2',
    admittingOperationId: request.operationId,
    state: 'pending',
    withoutModel: false,
    modelResume: null,
  });
  expect(job.admission).toMatchObject({
    path: 'live_capture_settlement',
    origin_kind: 'captured',
    derived_by_processing: false,
    settled_event_types: ['plan_captured'],
    // Dispatch re-reads the configuration of the checkout the capture was made
    // in, and reaches the event through the artifact that holds it; neither is
    // recoverable from this store afterwards, so both are retained here.
    context: { artifact_id: artifactId, origin: { worktree_root: ORIGIN_WORKTREE } },
  });
  // The admitting operation's own receipt and write sequence are the job's.
  expect(value.handle.read(() => null).counters.writeSequence).toBe(before.writeSequence + 1);
  expect(readProcessingBacklog(value.handle)).toEqual({
    paused_jobs: 1,
    latest_admitted_sequence: before.writeSequence + 1,
  });
});

it('admits one job for a revision, a closed checkpoint, an abandonment and a summary', async () => {
  const value = await project();
  const { artifactId, request: created } = await capturePlan(value);
  const revised = await captureTask(value, artifactId, (semantics) =>
    semantics.revisePlan(
      {
        artifact_id: artifactId,
        prior_plan_event_id: created.eventIds[0]!,
        idempotency_key: uuidv7(),
        label: 'Captured plan',
        rationale: 'The plan grew a step',
        touched_scope: [],
        non_goals: [],
        decisions: [],
        acknowledge_drops_completed_steps: [],
        acknowledge_criteria_changes: [],
        plan_steps: [
          {
            text: 'Retain the original capture',
            label: 'Retained capture',
            acceptance_criteria: [{ text: 'the capture is retained' }],
          },
        ],
      },
      { idempotencyKey: uuidv7(), invokedByAgent: 'codex' }
    )
  );
  expect(revised.request.eventTypes).toEqual(['plan_revised']);
  expect(revised.result.admittedProcessingJobs).toHaveLength(1);

  const closed = await captureTask(value, artifactId, closeCheckpoint(artifactId));
  expect(closed.request.eventTypes).toEqual(['checkpoint_opened', 'checkpoint_closed']);
  // Opening a checkpoint admits nothing; only the close in the same operation does.
  expect(closed.result.admittedProcessingJobs).toHaveLength(1);
  expect(
    readProcessingJob(value.handle, closed.result.admittedProcessingJobs[0]!.jobId)!.source
  ).toEqual({ kind: 'capture_event', event_id: closed.request.eventIds[1] });

  const abandoned = await captureTask(value, artifactId, async (semantics) => {
    const retained = await semantics.readPlan(artifactId);
    const opened = await semantics.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [retained!.plan_steps[0]!.step_id] },
      { idempotencyKey: uuidv7(), headSha: 'a'.repeat(40) }
    );
    if (!('checkpoint' in opened)) throw new Error('The fixture checkpoint did not open');
    return semantics.writeCheckpointAbandoned(
      { artifact_id: artifactId, n: opened.checkpoint.n, reason: 'The approach was wrong' },
      { idempotencyKey: uuidv7() }
    );
  });
  expect(abandoned.request.eventTypes).toEqual(['checkpoint_opened', 'checkpoint_abandoned']);
  expect(abandoned.result.admittedProcessingJobs).toHaveLength(1);

  const summary = await captureTask(value, artifactId, writeSummary(artifactId));
  expect(summary.result.admittedProcessingJobs).toHaveLength(1);
  expect(readProcessingBacklog(value.handle).paused_jobs).toBe(5);
});

it('admits nothing when an open is the only lifecycle event the capture settles', async () => {
  const value = await project();
  const { artifactId } = await capturePlan(value);
  const opened = await captureTask(value, artifactId, async (semantics) => {
    const retained = await semantics.readPlan(artifactId);
    return semantics.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [retained!.plan_steps[0]!.step_id] },
      { idempotencyKey: uuidv7(), headSha: 'a'.repeat(40) }
    );
  });
  expect(opened.request.eventTypes).toEqual(['checkpoint_opened']);
  expect(opened.result.admittedProcessingJobs).toEqual([]);
  expect(readProcessingBacklog(value.handle).paused_jobs).toBe(1);
});

it("keeps the invocation's no-model choice with the job it admits", async () => {
  const value = await project();
  const { result } = await capturePlan(value, { ...PROCESSING, withoutModel: true });
  expect(readProcessingJob(value.handle, result.admittedProcessingJobs[0]!.jobId)).toMatchObject({
    withoutModel: true,
    modelResume: null,
  });
});

it('admits nothing when the settling caller names no processor contract', async () => {
  const value = await project();
  const { result } = await capturePlan(value, null);
  expect(result.admittedProcessingJobs).toEqual([]);
  expect(jobs(value.handle)).toEqual([]);
});

it('leaves neither the capture nor a job when the publishing transaction fails', async () => {
  const value = await project();
  const before = value.handle.read(() => null).counters;
  const run = Database.prototype.prepare;
  // The failure is injected after the settlement has written, on the receipt the
  // operation commits last, so the job exists inside the transaction that then fails.
  let admittedWhenItFailed: number | null = null;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.includes('INSERT INTO operations')) {
      admittedWhenItFailed = (
        run.call(this, 'SELECT count(*) AS jobs FROM processing_jobs').get({}) as {
          jobs: number;
        }
      ).jobs;
      throw new Database.SqliteError('Injected storage failure', 'SQLITE_FULL');
    }
    return run.call(this, sql);
  });
  const artifactId = uuidv7();
  const request = await draft(value.handle, artifactId, (semantics) =>
    semantics.writePlan(plan(artifactId), { idempotencyKey: uuidv7() })
  );
  await expect(
    appendProjectExecutionCapture(
      value.handle,
      { ...request, execution: { kind: 'create', context: value.binding, ts: TS } },
      { processing: PROCESSING }
    )
  ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
  vi.restoreAllMocks();
  expect(admittedWhenItFailed).toBe(1);
  expect(readProjectArtifact(value.handle, artifactId)).toBeNull();
  expect(jobs(value.handle)).toEqual([]);
  expect(value.handle.read(() => null).counters).toEqual(before);
});

it('admits nothing on a replay of the same capture and returns its original result', async () => {
  const value = await project();
  const artifactId = uuidv7();
  const request = await draft(value.handle, artifactId, (semantics) =>
    semantics.writePlan(plan(artifactId), { idempotencyKey: uuidv7() })
  );
  const capture = {
    ...request,
    execution: { kind: 'create' as const, context: value.binding, ts: TS },
  };
  const first = await appendProjectExecutionCapture(value.handle, capture, {
    processing: PROCESSING,
  });
  const replay = await appendProjectExecutionCapture(value.handle, capture, {
    processing: PROCESSING,
  });
  expect(replay).toEqual({
    ...first,
    replayed: true,
    admittedProcessingJobs: [],
  });
  expect(jobs(value.handle)).toHaveLength(1);
});

it('admits nothing for a source belonging to an imported artifact', async () => {
  const value = await project();
  const artifactId = uuidv7();
  const request = await draft(value.handle, artifactId, (semantics) =>
    semantics.writePlan(plan(artifactId, true), { idempotencyKey: uuidv7() })
  );
  await appendProjectImportedArtifact(value.handle, request);
  expect(jobs(value.handle)).toEqual([]);

  // An imported artifact can still take an amend through the live capture path.
  const amended = await captureTask(
    value,
    artifactId,
    writeSummary(artifactId),
    PROCESSING,
    'historical_maintenance'
  );
  expect(amended.request.eventTypes).toEqual(['summary_captured']);
  expect(amended.result.admittedProcessingJobs).toEqual([]);
  expect(readProcessingBacklog(value.handle)).toEqual({
    paused_jobs: 0,
    latest_admitted_sequence: null,
  });
});

it('admits nothing when events are appended without a live capture', async () => {
  const value = await project();
  const artifactId = uuidv7();
  const request = await draft(value.handle, artifactId, (semantics) =>
    semantics.writePlan(plan(artifactId), { idempotencyKey: uuidv7() })
  );
  await appendProjectArtifactEvents(value.handle, request);
  expect(jobs(value.handle)).toEqual([]);
});

/** Stage a plan capture's Git inputs the way an interrupted capture leaves them. */
async function stageCapture(
  value: Awaited<ReturnType<typeof project>>,
  staged: { withoutModel: boolean }
) {
  const artifactId = uuidv7();
  const request = await draft(value.handle, artifactId, (semantics) =>
    semantics.writePlan(plan(artifactId), {
      idempotencyKey: uuidv7(),
      baselineSeedTreeSha: 'c'.repeat(40),
    })
  );
  const capture = {
    ...request,
    execution: { kind: 'create' as const, context: value.binding, ts: TS },
  };
  const staging: PrepareProjectGitRetention = {
    operationId: capture.operationId,
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: value.authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: TS,
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
        targetId: request.eventIds[0]!,
        checkpointNumber: null,
        checkpointPhase: null,
        objectOid: 'b'.repeat(40),
        treeOid: 'c'.repeat(40),
      },
    ],
    secretAllow: [],
  };
  await beginProjectCaptureRetention(
    value.handle,
    { capture, retention: prepareProjectGitRetention(staging) },
    { processing: { ...PROCESSING, withoutModel: staged.withoutModel } }
  );
  const settle = (resuming: { withoutModel: boolean }) =>
    settleProjectCaptureRetention(
      value.handle,
      {
        originalOperationId: capture.operationId,
        expectedTransitionId: staging.preparedTransitionId,
        selectedTransitionId: uuidv7(),
      },
      { processing: { ...PROCESSING, withoutModel: resuming.withoutModel } }
    );
  return { artifactId, request, capture, settle };
}

it('admits in the transaction that settles a capture whose Git inputs were staged first', async () => {
  const value = await project();
  const staged = await stageCapture(value, { withoutModel: true });
  // Staging admits nothing: no source is published yet.
  expect(jobs(value.handle)).toEqual([]);

  const settled = await staged.settle({ withoutModel: true });
  expect(settled.admittedProcessingJobs).toHaveLength(1);
  expect(readProcessingJob(value.handle, settled.admittedProcessingJobs[0]!.jobId)).toMatchObject({
    source: { kind: 'capture_event', event_id: staged.request.eventIds[0] },
    admittingOperationId: staged.capture.operationId,
    withoutModel: true,
  });
});

it('keeps a staged no-model capture without a model when a later invocation settles it', async () => {
  const value = await project();
  const staged = await stageCapture(value, { withoutModel: true });

  const settled = await staged.settle({ withoutModel: false });

  expect(readProcessingJob(value.handle, settled.admittedProcessingJobs[0]!.jobId)).toMatchObject({
    withoutModel: true,
  });
});

it('keeps a staged capture model-eligible when a later invocation settles it with no model', async () => {
  const value = await project();
  const staged = await stageCapture(value, { withoutModel: false });

  const settled = await staged.settle({ withoutModel: true });

  expect(readProcessingJob(value.handle, settled.admittedProcessingJobs[0]!.jobId)).toMatchObject({
    withoutModel: false,
  });
});
