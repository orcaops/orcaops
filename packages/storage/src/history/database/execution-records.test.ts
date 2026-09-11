import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventType } from '../../events/event-log.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest, recordChecksum } from '../event-integrity.js';
import {
  type ExecutionState,
  initializeCapturedExecution,
  initializeUnboundExecution,
  prepareExecutionCheckpointRecovery,
  prepareExecutionTransition,
  recordExecutionCheckpointOpen,
} from '../execution.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  appendProjectArtifactEvents,
  type AppendProjectArtifactEvents,
  readProjectArtifact,
} from './artifacts.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  prepareExecutionRecords,
  type ProjectExecutionSnapshot,
  readProjectExecution,
  settleExecutionRecords,
} from './execution-records.js';
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
async function existing() {
  const created = await fixture();
  const original = input();
  await appendProjectArtifactEvents(created.handle, original);
  const state = initializeCapturedExecution({
    artifactId: original.artifactId,
    operationId: uuidv7(),
    ts: '2026-06-01T00:02:00.000Z',
    context: {
      repository_instance_id: created.authority.repositoryInstanceId,
      worktree_id: uuidv7(),
      git_context: { branch: 'topic', head_sha: 'a'.repeat(40) },
    },
  });
  return { ...created, original, state };
}
async function publish(
  handle: ProjectDatabase,
  state: ExecutionState,
  previous: ProjectExecutionSnapshot | null,
  operationId = uuidv7()
) {
  const prepared = prepareExecutionRecords({
    state,
    previous,
    operationId,
    secretAllow: [],
    artifactRevision: readProjectArtifact(handle, state.artifact_id)!.revision,
  });
  return runProjectOperation(
    handle,
    {
      operationId,
      kind: 'execution.records',
      target: { artifactId: state.artifact_id },
      payload: { state },
      expectedState: { version: previous?.version ?? null },
      intentChange: false,
    },
    (tx) => settleExecutionRecords(tx, prepared)
  );
}
function handoff(state: ExecutionState) {
  return prepareExecutionTransition({
    state,
    operationId: uuidv7(),
    expectedGeneration: state.binding_generation,
    expectedBinding: state.current_binding,
    action: 'handoff',
    target: { ...state.current_binding!, worktree_id: uuidv7() },
    openCheckpointIds: [],
    ts: '2026-06-01T00:03:00.000Z',
  }).executionState;
}

describe('retained database execution records', () => {
  it('rejects a plan event used as checkpoint ownership without changing execution history', async () => {
    const { handle, state } = await existing();
    await publish(handle, state, null);
    const before = readProjectExecution(handle, state.artifact_id)!;
    const planEventId = readProjectArtifact(handle, state.artifact_id)!.thread.plan!
      .source_event_id;
    const wrong = recordExecutionCheckpointOpen({
      state,
      checkpointEventId: planEventId,
      expectedGeneration: 1,
      context: state.current_binding!,
    });
    await expect(publish(handle, wrong, before)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(readProjectExecution(handle, state.artifact_id)).toEqual(before);
  });

  it('retains original checkpoint ownership while later recovery appends a separate outcome', async () => {
    const { handle, state, original } = await existing();
    await publish(handle, state, null);
    const initial = readProjectExecution(handle, state.artifact_id)!;
    const artifact = readProjectArtifact(handle, state.artifact_id)!;
    const opened = event('checkpoint_opened', {
      artifact_id: state.artifact_id,
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
    await appendProjectArtifactEvents(handle, {
      ...original,
      operationId: uuidv7(),
      expectedRevision: artifact.revision,
      eventBytes: opened.bytes,
    });
    const attributed = recordExecutionCheckpointOpen({
      state,
      checkpointEventId: opened.record.event_id,
      expectedGeneration: 1,
      context: state.current_binding!,
    });
    await publish(handle, attributed, initial);
    const owned = readProjectExecution(handle, state.artifact_id)!;
    expect(owned.state).toEqual(attributed);
    const recovered = prepareExecutionTransition({
      state: attributed,
      operationId: uuidv7(),
      expectedGeneration: 1,
      expectedBinding: attributed.current_binding,
      action: 'orphan_recovered',
      target: { ...attributed.current_binding!, worktree_id: uuidv7() },
      reason: 'Original checkout is unavailable',
      openCheckpointIds: [opened.record.event_id],
      ts: '2026-06-01T00:04:00.000Z',
    }).executionState;
    await publish(handle, recovered, owned);
    const pending = readProjectExecution(handle, state.artifact_id)!;
    expect(pending.state).toEqual(recovered);
    const verified = prepareExecutionCheckpointRecovery({
      state: recovered,
      operationId: uuidv7(),
      checkpointEventId: opened.record.event_id,
      action: 'verified_continuation',
      reason: 'Original evidence was reviewed',
    });
    await publish(handle, verified, pending);
    const completed = readProjectExecution(handle, state.artifact_id)!;
    expect(completed.state).toEqual(verified);
    expect(completed.state.checkpoint_execution[0].context.worktree_id).toBe(
      state.current_worktree_id
    );
    expect(completed.state.recovery).toBeNull();
    expect(completed.state.binding_generation).toBe(2);
    expect(completed.version).toBe(4);
  });

  it('retains exact original transition identities and permanent associations through completion', async () => {
    const { handle, state } = await existing();
    const initial = await publish(handle, state, null);
    const first = readProjectExecution(handle, state.artifact_id)!;
    expect(first.state).toEqual(state);
    expect(first.version).toBe(1);
    const moved = handoff(state);
    await publish(handle, moved, first);
    const second = readProjectExecution(handle, state.artifact_id)!;
    expect(second.state).toEqual(moved);
    expect(second.state.associations).toHaveLength(2);
    const completed = prepareExecutionTransition({
      state: moved,
      operationId: uuidv7(),
      expectedGeneration: moved.binding_generation,
      expectedBinding: moved.current_binding,
      action: 'completed',
      reason: 'Work is done',
      openCheckpointIds: [],
      ts: '2026-06-01T00:04:00.000Z',
    }).executionState;
    await publish(handle, completed, second);
    const last = readProjectExecution(handle, state.artifact_id)!;
    expect(last.state).toEqual(completed);
    expect(last.state.associations).toEqual(moved.associations);
    expect(last.counters.intentChangeCounter).toBe(initial.counters.intentChangeCounter);
    expect(last.counters.writeSequence).toBe(initial.counters.writeSequence + 2);
  });

  it('preserves independent association and association-history ordering', async () => {
    const { handle, state } = await existing();
    const moved = handoff(state);
    moved.associations.reverse();
    await publish(handle, moved, null);
    expect(readProjectExecution(handle, state.artifact_id)!.state).toEqual(moved);
  });

  it('retains unknown and completed unbound provenance without creating associations', async () => {
    const { handle, state } = await existing();
    const unbound = initializeUnboundExecution({
      artifactId: state.artifact_id,
      operationId: uuidv7(),
      reason: 'completed',
      ts: '2026-06-01T00:04:00.000Z',
    });
    await publish(handle, unbound, null);
    expect(readProjectExecution(handle, state.artifact_id)!.state).toEqual(unbound);
    expect(readProjectExecution(handle, uuidv7())).toBeNull();
  });

  it('rejects changed retained prefixes and stale execution versions without deleting history', async () => {
    const { handle, state } = await existing();
    await publish(handle, state, null);
    const first = readProjectExecution(handle, state.artifact_id)!;
    const changed = structuredClone(state);
    changed.binding_history[0].ts = '2026-06-02T00:00:00.000Z';
    await expect(publish(handle, changed, first)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await publish(handle, handoff(state), first);
    const before = readProjectExecution(handle, state.artifact_id)!;
    await expect(publish(handle, handoff(state), first)).rejects.toMatchObject({
      code: 'STALE_CONTEXT',
    });
    expect(readProjectExecution(handle, state.artifact_id)).toEqual(before);
  });

  it('rejects an artifact change between execution preparation and settlement', async () => {
    const { handle, state, original } = await existing();
    const artifact = readProjectArtifact(handle, state.artifact_id)!;
    const operationId = uuidv7();
    const prepared = prepareExecutionRecords({
      state,
      previous: null,
      artifactRevision: artifact.revision,
      operationId,
      secretAllow: [],
    });
    await appendProjectArtifactEvents(handle, {
      ...original,
      operationId: uuidv7(),
      expectedRevision: artifact.revision,
      eventBytes: event('pin_displaced', { artifact_id: state.artifact_id }).bytes,
    });
    await expect(
      runProjectOperation(
        handle,
        {
          operationId,
          kind: 'execution.records',
          target: { artifactId: state.artifact_id },
          payload: { state },
          expectedState: { version: null },
          intentChange: false,
        },
        (tx) => settleExecutionRecords(tx, prepared)
      )
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    expect(readProjectExecution(handle, state.artifact_id)).toBeNull();
  });

  it('rolls back every execution row and original receipt on a late selection failure', async () => {
    const { handle, authority, state } = await existing();
    const raw = new Database(projectDatabasePath(authority));
    const operationId = uuidv7();
    try {
      raw.exec(
        "CREATE TRIGGER refuse_execution BEFORE INSERT ON execution_current BEGIN SELECT RAISE(ABORT,'test selection failure'); END;"
      );
      const before = handle.read(() => null).counters;
      await expect(publish(handle, state, null, operationId)).rejects.toMatchObject({
        code: 'TRANSACTION_FAILED',
      });
      expect(raw.prepare('SELECT count(*) n FROM execution_initializations').get()).toEqual({
        n: 0,
      });
      expect(raw.prepare('SELECT count(*) n FROM execution_transitions').get()).toEqual({ n: 0 });
      expect(
        raw.prepare('SELECT operation_id FROM operations WHERE operation_id=?').get(operationId)
      ).toBeUndefined();
      expect(handle.read(() => null).counters).toEqual(before);
      raw.exec('DROP TRIGGER refuse_execution');
      await publish(handle, state, null, operationId);
      expect(readProjectExecution(handle, state.artifact_id)!.state).toEqual(state);
    } finally {
      raw.close();
    }
  });

  it('refuses authored secrets before record settlement and leaves no execution rows', async () => {
    const { handle, state } = await existing();
    const secret = 'ghp_' + 'A'.repeat(36);
    state.binding_history[0].reason = JSON.stringify(secret).replaceAll('A', '\\u0041');
    await expect(publish(handle, state, null)).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(readProjectExecution(handle, state.artifact_id)).toBeNull();
  });

  it('detects missing selection and corrupt retained bytes without repair', async () => {
    const { handle, authority, state } = await existing();
    await publish(handle, state, null);
    const raw = new Database(projectDatabasePath(authority));
    try {
      expect(() => raw.exec('DELETE FROM execution_transitions')).toThrow();
      raw.exec('DROP TRIGGER execution_transitions_no_update');
      raw.exec("UPDATE execution_transitions SET record_hash='wrong'");
      expect(() => readProjectExecution(handle, state.artifact_id)).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
      expect(raw.prepare('SELECT record_hash FROM execution_transitions').get()).toEqual({
        record_hash: 'wrong',
      });
      raw.exec('DELETE FROM execution_current');
      expect(() => readProjectExecution(handle, state.artifact_id)).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
    } finally {
      raw.close();
    }
  });
});
