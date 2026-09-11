import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import type { EventType } from '../../events/event-log.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest, recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  appendProjectArtifactEvents,
  type AppendProjectArtifactEvents,
  readProjectArtifact,
} from './artifacts.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  appendProjectExecutionCapture,
  type CaptureExecutionContext,
} from './execution-capture.js';
import {
  prepareExecutionRecords,
  readProjectExecution,
  settleExecutionRecords,
} from './execution-records.js';
import { initializeUnboundExecution } from '../execution.js';
import { ProjectDatabaseError } from './errors.js';
import { transitionProjectExecution } from './execution-transitions.js';
import { runProjectOperation } from './transactions.js';
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-artifacts-')),
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
    initializedAt: new Date().toISOString(),
    authorize() {},
  });
  handles.push(handle);
  return { handle, authority };
}
function plan(artifactId: string, branch = 'topic', startedAt = '2026-06-01T00:00:00.000Z') {
  return {
    schema_version: 4,
    artifact_id: artifactId,
    branch,
    base_sha: 'original-base',
    agent: 'codex',
    agent_session_id: null,
    task: 'Retain original bytes',
    label: 'Original plan',
    plan_steps: [
      {
        step_id: uuidv7(),
        text: 'Keep identities',
        label: 'Keep identities',
        acceptance_criteria: [],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: startedAt,
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  };
}
function event(type: EventType, payload: unknown, sidecar = false) {
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const record = {
    event_id: uuidv7(),
    type,
    ts: '2026-06-01T00:01:00.000Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    ...(sidecar
      ? { sidecar_sha256: digest(payloadBytes), sidecar_size: payloadBytes.length }
      : { payload }),
  };
  const checked = { ...record, checksum: recordChecksum(record) };
  return { record: checked, bytes: Buffer.from(` ${JSON.stringify(checked)} \n`), payloadBytes };
}
function input(artifactId = uuidv7(), branch?: string): AppendProjectArtifactEvents {
  return {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: null,
    eventBytes: event('plan_captured', plan(artifactId, branch)).bytes,
    sidecarPayloads: [],
    secretAllow: [],
  };
}

async function captured() {
  const created = await fixture();
  const original = {
    ...input(),
    execution: {
      kind: 'create' as const,
      context: {
        repository_instance_id: created.authority.repositoryInstanceId,
        worktree_id: uuidv7(),
        git_context: { branch: 'topic', head_sha: 'a'.repeat(40) },
      },
      ts: '2026-06-01T00:00:00.000Z',
    },
  };
  return { ...created, original };
}
function opened(
  handle: ProjectDatabase,
  original: Awaited<ReturnType<typeof captured>>['original']
) {
  const artifact = readProjectArtifact(handle, original.artifactId)!;
  const owner = readProjectExecution(handle, original.artifactId)!;
  const record = event('checkpoint_opened', {
    artifact_id: original.artifactId,
    n: 1,
    declared_step_ids: [artifact.thread.plan!.plan_steps[0].step_id],
    agent: 'codex',
    policy_exceptions: [],
    plan_revision_id: null,
    open_plan_revision_event_id: artifact.thread.plan!.source_event_id,
    opened_at: '2026-06-01T00:03:00.000Z',
    head_sha: 'a'.repeat(40),
    open_snapshot: {
      snapshot_ref: null,
      tree_sha: null,
      snapshot_commit_sha: null,
      snapshot_error_reason: null,
    },
  });
  return {
    ...original,
    operationId: uuidv7(),
    expectedRevision: artifact.revision,
    eventBytes: record.bytes,
    execution: {
      kind: 'task',
      context: original.execution.context,
      expectedVersion: owner.version,
      expectedGeneration: owner.state.binding_generation,
      explicitTarget: true,
    } satisfies CaptureExecutionContext,
  };
}
it('commits an authored plan and its original execution owner under one operation receipt', async () => {
  const { handle, original } = await captured();
  const before = handle.read(() => null).counters;
  const result = await appendProjectExecutionCapture(handle, original);
  const owner = readProjectExecution(handle, original.artifactId)!;
  expect(owner.state.origin_kind).toBe('captured');
  expect(owner.state.current_binding).toEqual(original.execution.context);
  expect(owner.state.binding_history[0].operation_id).toBe(original.operationId);
  expect(result).toMatchObject({
    replayed: false,
    value: { executionVersion: 1, bindingGeneration: 1 },
    counters: {
      writeSequence: before.writeSequence + 1,
      intentChangeCounter: before.intentChangeCounter + 1,
    },
  });
  expect(
    handle.read((v) =>
      v.get('SELECT operation_id FROM artifact_revisions WHERE artifact_id=?', original.artifactId)
    ).value
  ).toEqual({ operation_id: original.operationId });
  const replay = await appendProjectExecutionCapture(handle, original);
  expect(replay).toEqual({ ...result, replayed: true });
});
it('rolls back artifact rows and search indexes when execution publication fails, then retries the same operation', async () => {
  const { handle, original } = await captured();
  const before = handle.read(() => null).counters;
  const run = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.includes('INSERT INTO execution_transitions'))
      throw new Database.SqliteError('Injected storage failure', 'SQLITE_FULL');
    return run.call(this, sql);
  });
  await expect(appendProjectExecutionCapture(handle, original)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'disk-full',
  });
  vi.restoreAllMocks();
  expect(readProjectArtifact(handle, original.artifactId)).toBeNull();
  expect(readProjectExecution(handle, original.artifactId)).toBeNull();
  expect(handle.read((v) => v.all('SELECT * FROM artifact_search_sources')).value).toEqual([]);
  expect(
    handle.read((v) =>
      v.get('SELECT operation_id FROM operations WHERE operation_id=?', original.operationId)
    ).value
  ).toBeNull();
  expect(handle.read(() => null).counters).toEqual(before);
  await expect(appendProjectExecutionCapture(handle, original)).resolves.toMatchObject({
    replayed: false,
  });
});
it('attributes a real checkpoint in its event transaction and replays after later history without re-preparing', async () => {
  const { handle, original } = await captured();
  const first = await appendProjectExecutionCapture(handle, original);
  const next = opened(handle, original);
  const before = handle.read(() => null).counters;
  const result = await appendProjectExecutionCapture(handle, next);
  const artifact = readProjectArtifact(handle, original.artifactId)!;
  expect(readProjectExecution(handle, original.artifactId)!.state.checkpoint_execution).toEqual([
    {
      checkpoint_event_id: artifact.thread.checkpoints[0].source_event_id,
      binding_generation: 1,
      context: original.execution.context,
    },
  ]);
  expect(result).toMatchObject({
    value: { executionVersion: 2 },
    counters: {
      writeSequence: before.writeSequence + 1,
      intentChangeCounter: before.intentChangeCounter,
    },
  });
  expect(await appendProjectExecutionCapture(handle, original)).toEqual({
    ...first,
    replayed: true,
  });
  await expect(
    appendProjectExecutionCapture(handle, {
      ...next,
      execution: { ...next.execution, explicitTarget: false },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('refuses another owner and stale execution versions without publishing the authored checkpoint', async () => {
  const { handle, original } = await captured();
  await appendProjectExecutionCapture(handle, original);
  const next = opened(handle, original);
  const before = readProjectArtifact(handle, original.artifactId)!;
  await expect(
    appendProjectExecutionCapture(handle, {
      ...next,
      execution: {
        ...next.execution,
        context: { ...next.execution.context, worktree_id: uuidv7() },
      },
    })
  ).rejects.toMatchObject({ code: 'EXECUTION_BOUND_ELSEWHERE' });
  await expect(
    appendProjectExecutionCapture(handle, {
      ...next,
      execution: { ...next.execution, expectedVersion: 8 },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProjectArtifact(handle, original.artifactId)).toEqual(before);
});
function summary(artifactId: string) {
  return event('summary_captured', {
    schema_version: 1,
    artifact_id: artifactId,
    outcome: 'Finished retained work',
    tests_written: [],
    tests_run: [],
    open_items: [],
    deferred_decisions: [],
    head_sha: 'a'.repeat(40),
    ts: '2026-06-01T00:05:00.000Z',
  });
}
it('completes execution with its summary while an explicit amendment preserves the terminal binding', async () => {
  const { handle, original } = await captured();
  await appendProjectExecutionCapture(handle, original);
  const terminal = { ...opened(handle, original), eventBytes: summary(original.artifactId).bytes };
  await appendProjectExecutionCapture(handle, terminal);
  const ended = readProjectExecution(handle, original.artifactId)!;
  expect(ended.state.lifecycle).toBe('completed');
  expect(ended.state.current_binding).toBeNull();
  expect(ended.state.associations).toEqual([original.execution.context.worktree_id]);
  const amended = {
    ...terminal,
    operationId: uuidv7(),
    expectedRevision: readProjectArtifact(handle, original.artifactId)!.revision,
    eventBytes: summary(original.artifactId).bytes,
    execution: {
      ...terminal.execution,
      kind: 'summary_amendment' as const,
      expectedGeneration: ended.state.binding_generation,
      expectedVersion: ended.version,
    },
  };
  const secret = 'ghp_' + 'A'.repeat(36);
  const branch = JSON.stringify(secret).replaceAll('A', '\\u0041');
  await expect(
    appendProjectExecutionCapture(handle, {
      ...amended,
      execution: {
        ...amended.execution,
        context: {
          ...amended.execution.context,
          git_context: { ...amended.execution.context.git_context, branch },
        },
      },
    })
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(
    handle.read((v) =>
      v.get('SELECT operation_id FROM operations WHERE operation_id=?', amended.operationId)
    ).value
  ).toBeNull();
  await appendProjectExecutionCapture(handle, amended);
  expect(readProjectExecution(handle, original.artifactId)!.state).toEqual(ended.state);
  expect(readProjectExecution(handle, original.artifactId)!.version).toBe(ended.version);
});
it('refuses completion while a real checkpoint remains open without retaining its summary', async () => {
  const { handle, original } = await captured();
  await appendProjectExecutionCapture(handle, original);
  await appendProjectExecutionCapture(handle, opened(handle, original));
  const next = opened(handle, original);
  const before = readProjectArtifact(handle, original.artifactId)!;
  await expect(
    appendProjectExecutionCapture(handle, {
      ...next,
      eventBytes: summary(original.artifactId).bytes,
    })
  ).rejects.toMatchObject({ code: 'OPEN_CHECKPOINTS' });
  expect(readProjectArtifact(handle, original.artifactId)).toEqual(before);
});
it('refuses escaped authored context secrets before the first artifact row is written', async () => {
  const { handle, original } = await captured();
  const before = handle.read(() => null).counters;
  const secret = 'ghp_' + 'A'.repeat(36);
  const branch = JSON.stringify(secret).replaceAll('A', '\\u0041');
  const forbidden = {
    ...original,
    execution: {
      ...original.execution,
      context: {
        ...original.execution.context,
        git_context: { ...original.execution.context.git_context, branch },
      },
    },
  };
  await expect(appendProjectExecutionCapture(handle, forbidden)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(readProjectArtifact(handle, original.artifactId)).toBeNull();
  expect(readProjectExecution(handle, original.artifactId)).toBeNull();
  expect(handle.read(() => null).counters).toEqual(before);
});
it('rejects a waiting capture after another writer commits the checkpoint and ownership together', async () => {
  const { handle, authority, original } = await captured();
  await appendProjectExecutionCapture(handle, original);
  const next = opened(handle, original);
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  const blocker = new Database(projectDatabasePath(authority));
  blocker.exec('BEGIN IMMEDIATE');
  let winner: ReturnType<typeof appendProjectExecutionCapture> | undefined;
  try {
    await expect(
      appendProjectExecutionCapture(handle, next, {
        onWait() {
          blocker.exec('ROLLBACK');
          winner = appendProjectExecutionCapture(other, { ...next, operationId: uuidv7() });
        },
      })
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    await expect(winner).resolves.toMatchObject({ replayed: false });
    expect(readProjectArtifact(handle, original.artifactId)!.thread.checkpoints).toHaveLength(1);
    expect(
      readProjectExecution(handle, original.artifactId)!.state.checkpoint_execution
    ).toHaveLength(1);
    expect(
      handle.read((v) =>
        v.get('SELECT operation_id FROM operations WHERE operation_id=?', next.operationId)
      ).value
    ).toBeNull();
  } finally {
    blocker.close();
  }
});

function transition(
  handle: ProjectDatabase,
  original: Awaited<ReturnType<typeof captured>>['original']
) {
  const owner = readProjectExecution(handle, original.artifactId)!;
  return {
    operationId: uuidv7(),
    artifactId: original.artifactId,
    expectedRevision: readProjectArtifact(handle, original.artifactId)!.revision,
    action: 'handoff' as const,
    target: { ...original.execution.context, worktree_id: uuidv7() },
    expectedBinding: owner.state.current_binding,
    expectedGeneration: owner.state.binding_generation,
    expectedVersion: owner.version,
    reason: null,
    ts: '2026-06-01T00:04:00.000Z',
    secretAllow: [],
  };
}
it('retains explicit handoff history and replays it after a later context change without changing artifact bytes', async () => {
  const { handle, original } = await captured();
  await appendProjectExecutionCapture(handle, original);
  const before = readProjectArtifact(handle, original.artifactId)!;
  const handoff = transition(handle, original);
  const first = await transitionProjectExecution(handle, handoff);
  const handed = readProjectExecution(handle, original.artifactId)!;
  expect(handed.state.associations).toEqual([
    original.execution.context.worktree_id,
    handoff.target.worktree_id,
  ]);
  expect(readProjectArtifact(handle, original.artifactId)!.eventBytes).toEqual(before.eventBytes);
  expect(first.counters.intentChangeCounter).toBe(before.counters.intentChangeCounter);
  await transitionProjectExecution(handle, {
    ...handoff,
    operationId: uuidv7(),
    action: 'context_changed',
    expectedVersion: handed.version,
    expectedGeneration: handed.state.binding_generation,
    expectedBinding: handed.state.current_binding,
    target: {
      ...handoff.target,
      git_context: { ...handoff.target.git_context, branch: 'another-topic' },
    },
  });
  expect(await transitionProjectExecution(handle, handoff)).toEqual({ ...first, replayed: true });
  await expect(
    transitionProjectExecution(handle, { ...handoff, reason: 'Changed authored intent' })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('uses the real open checkpoint set and returns a typed refusal for ordinary handoff', async () => {
  const { handle, original } = await captured();
  await appendProjectExecutionCapture(handle, original);
  await appendProjectExecutionCapture(handle, opened(handle, original));
  const before = readProjectExecution(handle, original.artifactId)!;
  const request = transition(handle, original);
  const result = await transitionProjectExecution(handle, request).catch((error) => error);
  expect(result).toBeInstanceOf(ProjectDatabaseError);
  expect(result).toMatchObject({ code: 'OPEN_CHECKPOINTS' });
  expect(result.message).toContain('Close the original');
  expect(readProjectExecution(handle, original.artifactId)).toEqual(before);
});
it('refuses standalone completion and orphan recovery instead of accepting unverified lifecycle actions', async () => {
  const { handle, original } = await captured();
  await appendProjectExecutionCapture(handle, original);
  const request = transition(handle, original);
  const before = readProjectExecution(handle, original.artifactId)!;
  for (const action of ['completed', 'orphan_recovered'])
    await expect(
      transitionProjectExecution(handle, { ...request, action } as unknown as Parameters<
        typeof transitionProjectExecution
      >[1])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(readProjectExecution(handle, original.artifactId)).toEqual(before);
});

it('first binding preserves unknown association provenance and requires recovery of original open checkpoints', async () => {
  const { handle, original } = await captured();
  await appendProjectArtifactEvents(handle, original);
  const operationId = uuidv7();
  const state = initializeUnboundExecution({
    artifactId: original.artifactId,
    operationId,
    reason: 'legacy_unknown',
    ts: '2026-06-01T00:00:00.000Z',
  });
  const records = prepareExecutionRecords({
    state,
    previous: null,
    operationId,
    artifactRevision: readProjectArtifact(handle, original.artifactId)!.revision,
    secretAllow: [],
  });
  await runProjectOperation(
    handle,
    {
      operationId,
      kind: 'execution.import',
      target: { artifactId: original.artifactId },
      payload: { state },
      expectedState: null,
      intentChange: false,
    },
    (tx) => settleExecutionRecords(tx, records)
  );
  const checkpoint = opened(handle, original);
  await appendProjectArtifactEvents(handle, checkpoint);
  await transitionProjectExecution(handle, {
    ...transition(handle, original),
    action: 'first_bind',
    target: original.execution.context,
  });
  const bound = readProjectExecution(handle, original.artifactId)!;
  expect(bound.state.associations_unknown).toBe(true);
  expect(bound.state.associations).toEqual([original.execution.context.worktree_id]);
  expect(bound.state.checkpoint_execution).toEqual([]);
  expect(bound.state.recovery?.checkpoint_ids).toEqual([
    readProjectArtifact(handle, original.artifactId)!.thread.checkpoints[0].source_event_id,
  ]);
});

const importedOrigin = {
  kind: 'git-import',
  imported_at: '2026-06-01T00:00:00.000Z',
  tool_version: '0.2.0-rc.2',
  source_range: 'a..b',
  authors: ['original author'],
  enriched_at: null,
};
function revisionRequest(
  handle: ProjectDatabase,
  original: Awaited<ReturnType<typeof captured>>['original'],
  origin?: typeof importedOrigin
) {
  const current = readProjectArtifact(handle, original.artifactId)!;
  return {
    ...opened(handle, original),
    eventBytes: event('plan_revised', {
      ...current.thread.plan!,
      label: 'Revised plan',
      revision_n: current.thread.plan!.revision_n + 1,
      revised_at: '2026-06-01T00:02:00.000Z',
      rationale: 'Clarified intent',
      prior_plan_event_id: current.thread.plan!.source_event_id,
      ...(origin ? { origin } : {}),
    }).bytes,
  };
}

it('accepts a coherent authored revision but refuses changing its retained origin kind', async () => {
  const { handle, original } = await captured();
  await appendProjectExecutionCapture(handle, original);
  await appendProjectExecutionCapture(handle, revisionRequest(handle, original));
  const before = readProjectArtifact(handle, original.artifactId)!;
  const owner = readProjectExecution(handle, original.artifactId)!;
  const request = revisionRequest(handle, original, importedOrigin);
  await expect(appendProjectExecutionCapture(handle, request)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(readProjectArtifact(handle, original.artifactId)).toEqual(before);
  expect(readProjectExecution(handle, original.artifactId)).toEqual(owner);
});

it('refuses a prior plan and execution origin disagreement before appending another checkpoint', async () => {
  const { handle, original } = await captured();
  await appendProjectExecutionCapture(handle, original);
  await appendProjectArtifactEvents(handle, revisionRequest(handle, original, importedOrigin));
  const before = readProjectArtifact(handle, original.artifactId)!;
  const owner = readProjectExecution(handle, original.artifactId)!;
  expect(before.thread.plan!.origin!.kind).toBe('git-import');
  expect(owner.state.origin_kind).toBe('captured');
  await expect(
    appendProjectExecutionCapture(handle, opened(handle, original))
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(readProjectArtifact(handle, original.artifactId)).toEqual(before);
  expect(readProjectExecution(handle, original.artifactId)).toEqual(owner);
});

it('refuses missing expected execution history without inventing an owner', async () => {
  const { handle, original } = await captured();
  await appendProjectArtifactEvents(handle, original);
  const artifact = readProjectArtifact(handle, original.artifactId)!;
  const request = {
    ...original,
    operationId: uuidv7(),
    expectedRevision: artifact.revision,
    eventBytes: summary(original.artifactId).bytes,
    execution: {
      kind: 'task' as const,
      context: original.execution.context,
      expectedVersion: 1,
      expectedGeneration: 1,
      explicitTarget: true,
    },
  };
  await expect(appendProjectExecutionCapture(handle, request)).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  await expect(
    transitionProjectExecution(handle, {
      operationId: uuidv7(),
      artifactId: original.artifactId,
      expectedRevision: artifact.revision,
      expectedBinding: original.execution.context,
      expectedGeneration: 1,
      expectedVersion: 1,
      action: 'handoff',
      target: { ...original.execution.context, worktree_id: uuidv7() },
      reason: null,
      ts: original.execution.ts,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(readProjectExecution(handle, original.artifactId)).toBeNull();
  expect(readProjectArtifact(handle, original.artifactId)).toEqual(artifact);
});

it('settles artifact and execution query owners atomically and preserves them on receipt replay', async () => {
  const { handle, original } = await captured();
  const first = await appendProjectExecutionCapture(handle, original);
  const selected = () =>
    handle.read((view) => ({
      artifacts: view.all('SELECT * FROM artifact_query_metadata'),
      executions: view.all('SELECT * FROM execution_query_metadata'),
      branches: view.all('SELECT * FROM execution_query_branches'),
    }));
  const initial = selected();
  expect(initial.value.artifacts).toHaveLength(1);
  expect(initial.value.executions).toHaveLength(1);
  expect(initial.value.executions[0]).toMatchObject({
    version: 1,
    binding_branch: 'topic',
    binding_updated_at: '2026-06-01T00:00:00.000Z',
  });
  const moved = transition(handle, original);
  moved.target.git_context = { ...moved.target.git_context, branch: 'new-owner' };
  await transitionProjectExecution(handle, moved);
  const later = selected();
  expect(later.value.artifacts).toEqual(initial.value.artifacts);
  expect(later.value.branches).toHaveLength(2);
  expect(await appendProjectExecutionCapture(handle, original)).toEqual({
    ...first,
    replayed: true,
  });
  expect(selected()).toEqual(later);
});
it('rolls back retained capture and both query owners when execution metadata cannot publish', async () => {
  const { handle, original } = await captured();
  const before = handle.read((view) => ({
    artifacts: view.all('SELECT * FROM artifacts'),
    operations: view.all('SELECT * FROM operations'),
  }));
  const prepare = Database.prototype.prepare;
  const fault = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.startsWith('INSERT INTO execution_query_metadata'))
      throw new Database.SqliteError('fixture full', 'SQLITE_FULL');
    return prepare.call(this, sql);
  });
  await expect(appendProjectExecutionCapture(handle, original)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'disk-full',
  });
  fault.mockRestore();
  expect(
    handle.read((view) => ({
      artifacts: view.all('SELECT * FROM artifacts'),
      operations: view.all('SELECT * FROM operations'),
    }))
  ).toEqual(before);
  expect(handle.read((view) => view.all('SELECT * FROM artifact_query_metadata')).value).toEqual(
    []
  );
  expect(handle.read((view) => view.all('SELECT * FROM execution_query_metadata')).value).toEqual(
    []
  );
  expect((await appendProjectExecutionCapture(handle, original)).replayed).toBe(false);
});
