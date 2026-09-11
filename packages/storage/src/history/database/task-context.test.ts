import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { recordChecksum } from '../event-integrity.js';
import { createExecutionPin } from '../execution-focus.js';
import { normalizeHistoryRoot } from '../paths.js';
import { readProjectArtifact } from './artifacts.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { appendProjectExecutionCapture } from './execution-capture.js';
import { publishProjectExecutionFocus } from './execution-focus.js';
import { readProjectExecution } from './execution-records.js';
import { readProjectTaskContext } from './task-context.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const ts = '2026-06-01T00:00:00.000Z';
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'task-context-')),
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
    initializedAt: ts,
    authorize() {},
  });
  handles.push(handle);
  const binding = {
    repository_instance_id: authority.repositoryInstanceId,
    worktree_id: uuidv7(),
    git_context: { branch: 'topic', head_sha: 'a'.repeat(40) },
  };
  const artifactId = uuidv7();
  const event = {
    event_id: uuidv7(),
    type: 'plan_captured' as const,
    ts,
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: {
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'topic',
      base_sha: 'a'.repeat(40),
      agent: 'codex',
      agent_session_id: null,
      task: 'Keep original task context',
      label: 'Original task context',
      plan_steps: [
        {
          step_id: uuidv7(),
          text: 'Retain original task',
          label: 'Retain original task',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: ts,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    },
  };
  await appendProjectExecutionCapture(handle, {
    artifactId,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...event, checksum: recordChecksum(event) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
    execution: { kind: 'create', context: binding, ts },
  });
  const scope = {
    rootKey: authority.rootKey,
    projectId: authority.projectId,
    storeInstanceId: authority.storeInstanceId,
    repositoryInstanceId: authority.repositoryInstanceId,
    worktreeId: binding.worktree_id,
    shellKey: { kind: 'codex_session' as const, value: 'original-session' },
  };
  return { handle, authority, artifactId, binding, scope };
}

it('returns metadata, original execution, focus and selected accounting without changing state', async () => {
  const f = await fixture();
  const before = f.handle.read(() => null).counters;
  const exec = vi.spyOn(Database.prototype, 'exec');
  const result = readProjectTaskContext(f.handle, { branch: 'topic' });
  expect(exec.mock.calls.filter(([sql]) => /^BEGIN/iu.test(sql))).toHaveLength(1);
  expect(result.counters).toEqual(before);
  expect(result.artifacts).toHaveLength(1);
  expect(result.artifacts[0]).toMatchObject({
    row: { artifactId: f.artifactId },
    details: { task: 'Keep original task context' },
    execution: { current_binding: f.binding },
  });
  expect(result.focus).toBeNull();
  expect(result.usage.events).toEqual([]);
  expect(f.handle.read(() => null).counters).toEqual(before);
});

it('distinguishes an absent focus slot from an exact retained clear', async () => {
  const f = await fixture();
  expect(readProjectTaskContext(f.handle, { focusScope: f.scope }).focus?.status).toBe('absent');
  const operationId = uuidv7();
  await publishProjectExecutionFocus(f.handle, {
    action: 'clear',
    operationId,
    scope: f.scope,
    expectedSelection: null,
    secretAllow: [],
  });
  expect(readProjectTaskContext(f.handle, { focusScope: f.scope }).focus).toMatchObject({
    status: 'cleared',
    selection: { operationId, version: 1 },
  });
});

it('returns the original focus bytes alongside the selected execution generation', async () => {
  const f = await fixture();
  const state = readProjectExecution(f.handle, f.artifactId)!;
  const pin = createExecutionPin({
    authority: { ...f.authority, formatVersion: 1 },
    gitContext: {
      commonDir: '',
      gitDir: '',
      worktreeRoot: '',
      repositoryInstanceId: f.authority.repositoryInstanceId,
      worktreeId: f.binding.worktree_id,
      branch: 'topic',
      headOid: 'a'.repeat(40),
    },
    shellKey: f.scope.shellKey,
    state: state.state,
    pinnedAt: ts,
  });
  const pinBytes = Buffer.from(' ' + JSON.stringify(pin) + '\n');
  await publishProjectExecutionFocus(f.handle, {
    action: 'set',
    operationId: uuidv7(),
    scope: f.scope,
    expectedSelection: null,
    pinBytes,
    expectedArtifactRevision: readProjectArtifact(f.handle, f.artifactId)!.revision,
    expectedExecutionVersion: state.version,
    secretAllow: [],
  });
  const result = readProjectTaskContext(f.handle, { focusScope: f.scope, branch: 'different' });
  expect(result.focus?.status).toBe('present');
  if (result.focus?.status !== 'present') throw new Error('Expected original focus');
  expect(result.focus.pinBytes).toEqual(pinBytes);
  expect(result.artifacts).toEqual([]);
  expect(result.focus.pin.binding_generation).toBe(
    result.focusedArtifact!.execution!.binding_generation
  );
});

it('refuses forged handles and malformed copied input before invoking a caller read', () => {
  const read = vi.fn();
  const fake = { read } as unknown as ProjectDatabase;
  expect(() => readProjectTaskContext(fake)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(() => readProjectTaskContext(fake, { branch: () => {} } as never)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(read).not.toHaveBeenCalled();
});

it('refuses a focus selection changed between preflight and the final snapshot', async () => {
  const f = await fixture();
  const first = await publishProjectExecutionFocus(f.handle, {
    action: 'clear',
    operationId: uuidv7(),
    scope: f.scope,
    expectedSelection: null,
    secretAllow: [],
  });
  const competing = await openProjectDatabase({ authority: f.authority, mode: 'writer' });
  handles.push(competing);
  let publication: ReturnType<typeof publishProjectExecutionFocus> | undefined;
  const original = Database.prototype.exec;
  let changed = false;
  const observing = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const result = original.call(this, sql);
    if (!changed && sql === 'COMMIT') {
      changed = true;
      publication = publishProjectExecutionFocus(competing, {
        action: 'clear',
        operationId: uuidv7(),
        scope: f.scope,
        expectedSelection: first.value.selection,
        secretAllow: [],
      });
    }
    return result;
  });
  try {
    expect(() => readProjectTaskContext(f.handle, { focusScope: f.scope })).toThrow(
      expect.objectContaining({ code: 'STALE_CONTEXT' })
    );
    expect(changed).toBe(true);
    expect((await publication)?.value.selection.version).toBe(2);
  } finally {
    observing.mockRestore();
  }
});
