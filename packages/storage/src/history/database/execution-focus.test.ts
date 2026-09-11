import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import type { EventType } from '../../events/event-log.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { recordChecksum } from '../event-integrity.js';
import { createExecutionPin } from '../execution-focus.js';
import { initializeUnboundExecution } from '../execution.js';
import { normalizeHistoryRoot } from '../paths.js';
import { appendProjectArtifactEvents, readProjectArtifact } from './artifacts.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { appendProjectExecutionCapture } from './execution-capture.js';
import {
  prepareProjectFocus,
  type ProjectFocusChange,
  projectFocusScopeJson,
} from './execution-focus-input.js';
import { publishProjectExecutionFocus, readProjectExecutionFocus } from './execution-focus.js';
import {
  prepareExecutionRecords,
  readProjectExecution,
  settleExecutionRecords,
} from './execution-records.js';
import { transitionProjectExecution } from './execution-transitions.js';
import { runProjectOperation } from './transactions.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const timestamp = '2026-06-01T00:00:00.000Z';
function event(type: EventType, payload: unknown) {
  const record = {
    event_id: uuidv7(),
    type,
    ts: timestamp,
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload,
  };
  return Buffer.from(' ' + JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n');
}
async function fixture(kind: 'captured' | 'imported' | 'completed' = 'captured') {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-focus-')),
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
    initializedAt: timestamp,
    authorize() {},
  });
  handles.push(handle);
  const context = {
    repository_instance_id: authority.repositoryInstanceId,
    worktree_id: uuidv7(),
    git_context: { branch: 'topic', head_sha: 'a'.repeat(40) },
  };
  const artifactId = uuidv7();
  const original = {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: null,
    secretAllow: [],
    sidecarPayloads: [],
    eventBytes: event('plan_captured', {
      schema_version: 4,
      artifact_id: artifactId,
      branch: 'topic',
      base_sha: 'a'.repeat(40),
      agent: 'codex',
      agent_session_id: null,
      task: 'Retain focus independently',
      label: 'Original focus target',
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
      started_at: timestamp,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
      ...(kind === 'imported'
        ? {
            origin: {
              kind: 'git-import',
              imported_at: timestamp,
              tool_version: 'test',
              source_range: 'a..b',
              authors: ['original author'],
              enriched_at: null,
            },
          }
        : {}),
    }),
    execution: { kind: 'create' as const, context, ts: timestamp },
  };
  if (kind === 'imported') {
    await appendProjectArtifactEvents(handle, original);
    const state = initializeUnboundExecution({
      artifactId,
      operationId: uuidv7(),
      reason: 'imported',
      ts: timestamp,
    });
    const operationId = uuidv7();
    const prepared = prepareExecutionRecords({
      state,
      previous: null,
      operationId,
      artifactRevision: readProjectArtifact(handle, artifactId)!.revision,
      secretAllow: [],
    });
    await runProjectOperation(
      handle,
      {
        operationId,
        kind: 'fixture.execution',
        target: { artifactId },
        payload: { state },
        expectedState: null,
        intentChange: false,
      },
      (tx) => settleExecutionRecords(tx, prepared)
    );
  } else {
    await appendProjectExecutionCapture(handle, original);
    if (kind === 'completed') {
      const current = readProjectExecution(handle, artifactId)!;
      await appendProjectExecutionCapture(handle, {
        ...original,
        operationId: uuidv7(),
        expectedRevision: readProjectArtifact(handle, artifactId)!.revision,
        eventBytes: event('summary_captured', {
          schema_version: 1,
          artifact_id: artifactId,
          outcome: 'Completed retained work',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
          head_sha: 'a'.repeat(40),
          ts: timestamp,
        }),
        execution: {
          kind: 'task',
          context,
          expectedVersion: current.version,
          expectedGeneration: current.state.binding_generation,
          explicitTarget: true,
        },
      });
    }
  }
  const execution = readProjectExecution(handle, artifactId)!;
  const pin = createExecutionPin({
    authority: { ...authority, formatVersion: 1 },
    gitContext: {
      commonDir: '/repo/.git',
      gitDir: '/repo/.git',
      worktreeRoot: '/repo',
      repositoryInstanceId: authority.repositoryInstanceId,
      worktreeId: context.worktree_id,
      branch: context.git_context.branch,
      headOid: context.git_context.head_sha,
    },
    shellKey: { kind: 'codex_session', value: 'full/session/value' },
    state: execution.state,
    pinnedAt: timestamp,
  });
  const input: Extract<ProjectFocusChange, { action: 'set' }> = {
    operationId: uuidv7(),
    action: 'set',
    scope: {
      rootKey: authority.rootKey,
      projectId: authority.projectId,
      storeInstanceId: authority.storeInstanceId,
      repositoryInstanceId: authority.repositoryInstanceId,
      worktreeId: context.worktree_id,
      shellKey: pin.shell_key as Exclude<typeof pin.shell_key, { kind: 'none' }>,
    },
    expectedSelection: null,
    pinBytes: Buffer.from('  ' + JSON.stringify(pin) + '\n'),
    expectedArtifactRevision: readProjectArtifact(handle, artifactId)!.revision,
    expectedExecutionVersion: execution.version,
    secretAllow: [],
  };
  return { handle, authority, artifactId, original, context, input, pin };
}
function focusState(handle: ProjectDatabase) {
  return handle.read((view) => ({
    records: view.all(
      'SELECT operation_id, scope_json, hex(pin_bytes) AS bytes, pin_hash FROM execution_focus_records ORDER BY rowid'
    ),
    current: view.all('SELECT * FROM execution_focus_current ORDER BY rowid'),
    receipts: view.all('SELECT * FROM operations ORDER BY rowid'),
    execution: view.all('SELECT * FROM execution_current ORDER BY rowid'),
  }));
}
function clear(
  input: Extract<ProjectFocusChange, { action: 'set' }>,
  selection: { operationId: string; version: number } | null
): ProjectFocusChange {
  return {
    action: 'clear',
    operationId: uuidv7(),
    scope: input.scope,
    expectedSelection: selection,
    secretAllow: [],
  };
}

it.each(['captured', 'imported', 'completed'] as const)(
  'retains exact %s focus without rebinding, adoption or an intent counter change',
  async (kind) => {
    const { handle, artifactId, input } = await fixture(kind);
    const before = readProjectExecution(handle, artifactId)!;
    const counters = handle.read(() => null).counters;
    expect(readProjectExecutionFocus(handle, input.scope)).toMatchObject({ status: 'absent' });
    const result = await publishProjectExecutionFocus(handle, input);
    expect(result).toMatchObject({
      replayed: false,
      value: { status: 'present', selection: { operationId: input.operationId, version: 1 } },
      counters: {
        writeSequence: counters.writeSequence + 1,
        intentChangeCounter: counters.intentChangeCounter,
      },
    });
    const selected = readProjectExecutionFocus(handle, input.scope);
    expect(selected.status).toBe('present');
    if (selected.status !== 'present') throw new Error('Expected focus');
    expect(selected.pinBytes).toEqual(Buffer.from(input.pinBytes));
    expect(selected.pin.binding_generation).toBe(before.state.binding_generation);
    expect(readProjectExecution(handle, artifactId)!.state).toEqual(before.state);
    expect(readProjectExecution(handle, artifactId)!.version).toBe(before.version);
    selected.pinBytes.fill(0);
    expect(readProjectExecutionFocus(handle, input.scope)).toMatchObject({
      pinBytes: Buffer.from(input.pinBytes),
    });
    if (kind === 'completed')
      expect(readProjectArtifact(handle, artifactId)!.thread.summary).toBeTruthy();
  }
);

it('publishes explicit clear for a never-focused slot and keeps it distinct from absence', async () => {
  const { handle, input } = await fixture();
  const result = await publishProjectExecutionFocus(handle, clear(input, null));
  expect(result.value.status).toBe('cleared');
  expect(readProjectExecutionFocus(handle, input.scope)).toMatchObject({
    status: 'cleared',
    selection: result.value.selection,
  });
  expect(focusState(handle).value.records).toHaveLength(1);
});

it('replays the original operation after a later clear without making old focus current', async () => {
  const { handle, input } = await fixture();
  const first = await publishProjectExecutionFocus(handle, input);
  await publishProjectExecutionFocus(handle, clear(input, first.value.selection));
  const before = focusState(handle);
  expect(await publishProjectExecutionFocus(handle, input)).toEqual({ ...first, replayed: true });
  expect(focusState(handle)).toEqual(before);
  expect(readProjectExecutionFocus(handle, input.scope).status).toBe('cleared');
  await expect(
    publishProjectExecutionFocus(handle, { ...input, expectedSelection: first.value.selection })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    publishProjectExecutionFocus(handle, {
      ...input,
      pinBytes: Buffer.from(input.pinBytes).subarray(1),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(focusState(handle)).toEqual(before);
});

it.each(['captured', 'imported'] as const)(
  'refuses the retained %s binding operation ID as a focus publication',
  async (kind) => {
    const { handle, artifactId, input } = await fixture(kind);
    const originalId = readProjectExecution(handle, artifactId)!.state.binding_history[0]
      .operation_id;
    if (kind === 'imported')
      expect(
        handle.read((view) =>
          view.get('SELECT operation_id FROM operations WHERE operation_id = ?', originalId)
        ).value
      ).toBeNull();
    const before = focusState(handle);
    await expect(
      publishProjectExecutionFocus(handle, { ...input, operationId: originalId })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(focusState(handle)).toEqual(before);
  }
);

it('checks every exact artifact revision field and the execution version without writes on stale input', async () => {
  const { handle, input } = await fixture();
  const before = focusState(handle);
  for (const revision of [
    {
      ...input.expectedArtifactRevision,
      generation: input.expectedArtifactRevision.generation + 1,
    },
    { ...input.expectedArtifactRevision, orderedHash: 'f'.repeat(64) },
    {
      ...input.expectedArtifactRevision,
      eventCount: input.expectedArtifactRevision.eventCount + 1,
    },
    {
      ...input.expectedArtifactRevision,
      byteLength: input.expectedArtifactRevision.byteLength + 1,
    },
    { ...input.expectedArtifactRevision, tailEventId: uuidv7() },
  ])
    await expect(
      publishProjectExecutionFocus(handle, { ...input, expectedArtifactRevision: revision })
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  await expect(
    publishProjectExecutionFocus(handle, { ...input, expectedExecutionVersion: 99 })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(focusState(handle)).toEqual(before);
});

it('revalidates changed execution after waiting but clears the original slot independently', async () => {
  const { handle, authority, artifactId, input, context, original } = await fixture();
  const first = await publishProjectExecutionFocus(handle, input);
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  const blocker = new Database(projectDatabasePath(authority), { timeout: 0 });
  blocker.exec('BEGIN IMMEDIATE');
  let moved: ReturnType<typeof transitionProjectExecution> | undefined;
  try {
    await expect(
      publishProjectExecutionFocus(
        handle,
        { ...input, operationId: uuidv7(), expectedSelection: first.value.selection },
        {
          onWait() {
            blocker.exec('ROLLBACK');
            const state = readProjectExecution(other, artifactId)!;
            moved = transitionProjectExecution(other, {
              operationId: uuidv7(),
              artifactId,
              expectedRevision: input.expectedArtifactRevision,
              action: 'handoff',
              target: { ...context, worktree_id: uuidv7() },
              expectedBinding: state.state.current_binding,
              expectedGeneration: state.state.binding_generation,
              expectedVersion: state.version,
              reason: null,
              ts: timestamp,
              secretAllow: [],
            });
          },
        }
      )
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    await expect(moved).resolves.toMatchObject({ replayed: false });
  } finally {
    blocker.close();
  }
  const state = readProjectExecution(handle, artifactId)!;
  await appendProjectExecutionCapture(handle, {
    ...original,
    operationId: uuidv7(),
    expectedRevision: readProjectArtifact(handle, artifactId)!.revision,
    eventBytes: event('summary_captured', {
      schema_version: 1,
      artifact_id: artifactId,
      outcome: 'Completed after handoff',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: 'a'.repeat(40),
      ts: timestamp,
    }),
    execution: {
      kind: 'task',
      context: state.state.current_binding!,
      expectedVersion: state.version,
      expectedGeneration: state.state.binding_generation,
      explicitTarget: true,
    },
  });
  expect(readProjectArtifact(handle, artifactId)!.revision).not.toEqual(
    input.expectedArtifactRevision
  );
  const ended = readProjectExecution(handle, artifactId)!;
  const cleared = await publishProjectExecutionFocus(handle, clear(input, first.value.selection));
  expect(cleared.value.status).toBe('cleared');
  expect(readProjectExecution(handle, artifactId)!.state).toEqual(ended.state);
});

it('serializes competing slot selections and preserves the losing original operation for an explicit new attempt', async () => {
  const { handle, authority, input } = await fixture();
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  const competing = { ...input, operationId: uuidv7() };
  const results = await Promise.allSettled([
    publishProjectExecutionFocus(handle, input),
    publishProjectExecutionFocus(other, competing),
  ]);
  expect(results.map((value) => value.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(results.find((value) => value.status === 'rejected')).toMatchObject({
    reason: { code: 'STALE_CONTEXT' },
  });
  expect(focusState(handle).value.records).toHaveLength(1);
  expect(
    handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id = ?', competing.operationId)
    ).value
  ).toBeNull();
});

it('keeps full session and worktree slots isolated while refusing a foreign project authority', async () => {
  const { handle, input, pin } = await fixture();
  await publishProjectExecutionFocus(handle, input);
  const scope = {
    ...input.scope,
    worktreeId: uuidv7(),
    shellKey: { kind: 'codex_session' as const, value: 'full/session/value/other' },
  };
  const other = {
    ...input,
    operationId: uuidv7(),
    scope,
    pinBytes: Buffer.from(
      JSON.stringify({ ...pin, worktree_id: scope.worktreeId, shell_key: scope.shellKey })
    ),
  };
  await publishProjectExecutionFocus(handle, other);
  expect(focusState(handle).value.current).toHaveLength(2);
  const before = focusState(handle);
  const foreign = { ...scope, projectId: uuidv7() };
  await expect(
    publishProjectExecutionFocus(handle, clear({ ...other, scope: foreign }, null))
  ).rejects.toMatchObject({ code: 'AUTHORITY_MISMATCH' });
  expect(() => readProjectExecutionFocus(handle, foreign)).toThrow(
    expect.objectContaining({ code: 'AUTHORITY_MISMATCH' })
  );
  expect(focusState(handle)).toEqual(before);
});

it.each(['disk-full', 'cancel'] as const)(
  'rolls back the focus record, selection and receipt together on %s',
  async (failure) => {
    const { handle, input } = await fixture();
    const before = focusState(handle);
    const controller = new AbortController();
    const prepare = Database.prototype.prepare;
    const fault = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith('INSERT INTO execution_focus_current')) {
        const run = statement.run as (...parameters: unknown[]) => Database.RunResult;
        vi.spyOn(statement, 'run').mockImplementation(function (
          this: Database.Statement,
          ...parameters: unknown[]
        ) {
          const result = run.apply(this, parameters);
          if (failure === 'cancel') controller.abort();
          else throw new Database.SqliteError('fixture full disk', 'SQLITE_FULL');
          return result;
        });
      }
      return statement;
    });
    await expect(
      publishProjectExecutionFocus(handle, input, { signal: controller.signal })
    ).rejects.toMatchObject(
      failure === 'cancel'
        ? { code: 'CANCELLED' }
        : { code: 'TRANSACTION_FAILED', reason: 'disk-full' }
    );
    fault.mockRestore();
    expect(focusState(handle)).toEqual(before);
    await expect(publishProjectExecutionFocus(handle, input)).resolves.toMatchObject({
      replayed: false,
    });
  }
);

it('honors original cancellation during admission despite caller option replacement and permits same-ID retry', async () => {
  const { handle, authority, input } = await fixture();
  const before = focusState(handle);
  const blocker = new Database(projectDatabasePath(authority), { timeout: 0 });
  blocker.exec('BEGIN IMMEDIATE');
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    onWait: vi.fn(() => {
      options.signal = new AbortController().signal;
      controller.abort();
      blocker.exec('ROLLBACK');
    }),
  };
  try {
    await expect(publishProjectExecutionFocus(handle, input, options)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(options.onWait).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'execution.focus', reason: 'admission' })
    );
  } finally {
    blocker.close();
  }
  expect(focusState(handle)).toEqual(before);
  await expect(publishProjectExecutionFocus(handle, input)).resolves.toMatchObject({
    replayed: false,
  });
});

it('detaches authored bytes, scope and expected versions before waiting for admission', async () => {
  const { handle, authority, input } = await fixture();
  const originalScope = structuredClone(input.scope);
  const originalBytes = Buffer.from(input.pinBytes);
  const originalId = input.operationId;
  const blocker = new Database(projectDatabasePath(authority), { timeout: 0 });
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const result = await publishProjectExecutionFocus(handle, input, {
      onWait() {
        input.pinBytes.fill(0);
        input.scope.projectId = uuidv7();
        input.scope.shellKey = { kind: 'codex_session', value: 'retargeted' };
        input.expectedArtifactRevision.generation = 999;
        input.expectedExecutionVersion = 999;
        input.operationId = uuidv7();
        blocker.exec('ROLLBACK');
      },
    });
    expect(result.value.selection.operationId).toBe(originalId);
    expect(readProjectExecutionFocus(handle, originalScope)).toMatchObject({
      pinBytes: originalBytes,
    });
  } finally {
    blocker.close();
  }
});

it('refuses authored secrets before consulting even a fabricated database handle', async () => {
  const { input, pin } = await fixture();
  const read = vi.fn();
  const handle = { read } as unknown as ProjectDatabase;
  const secret = 'ghp_' + 'a'.repeat(36);
  const refused = { ...input, pinBytes: Buffer.from(JSON.stringify({ ...pin, branch: secret })) };
  expect(() => prepareProjectFocus(refused)).toThrow(
    expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
  );
  await expect(publishProjectExecutionFocus(handle, refused)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  await expect(publishProjectExecutionFocus(handle, input)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(() => readProjectExecutionFocus(handle, input.scope)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(read).not.toHaveBeenCalled();
});

function removeGuardedRow(file: string, table: string, triggerName: string) {
  const database = new Database(file);
  database.pragma('foreign_keys = OFF');
  try {
    const trigger = database
      .prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
      .get('trigger', triggerName) as { sql: string };
    database.exec('BEGIN IMMEDIATE');
    database.exec(`DROP TRIGGER ${triggerName}`);
    database.exec(`DELETE FROM ${table}`);
    database.exec(trigger.sql);
    database.exec('COMMIT');
  } finally {
    database.close();
  }
}

it('refuses missing selection proved by retained focus and never silently reconstructs it', async () => {
  const { handle, authority, input } = await fixture();
  const first = await publishProjectExecutionFocus(handle, input);
  removeGuardedRow(
    projectDatabasePath(authority),
    'execution_focus_current',
    'execution_focus_current_no_delete'
  );
  const before = focusState(handle);
  expect(before.value.records).toHaveLength(1);
  expect(before.value.current).toHaveLength(0);
  expect(() => readProjectExecutionFocus(handle, input.scope)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  await expect(publishProjectExecutionFocus(handle, clear(input, null))).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  expect(focusState(handle)).toEqual(before);
  const repair = new Database(projectDatabasePath(authority));
  repair
    .prepare('INSERT INTO execution_focus_current VALUES (?, ?, ?)')
    .run(
      projectFocusScopeJson(input.scope),
      first.value.selection.operationId,
      first.value.selection.version
    );
  repair.close();
  expect(readProjectExecutionFocus(handle, input.scope)).toMatchObject({
    status: 'present',
    selection: first.value.selection,
  });
});

it('refuses missing selected records without deleting or replacing current selection', async () => {
  const { handle, authority, input } = await fixture();
  const first = await publishProjectExecutionFocus(handle, input);
  removeGuardedRow(
    projectDatabasePath(authority),
    'execution_focus_records',
    'execution_focus_records_no_delete'
  );
  const before = focusState(handle);
  expect(() => readProjectExecutionFocus(handle, input.scope)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  await expect(
    publishProjectExecutionFocus(handle, clear(input, first.value.selection))
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(focusState(handle)).toEqual(before);
});

it('refuses missing expected execution without authorizing a new binding', async () => {
  const { handle, authority, input } = await fixture();
  const database = new Database(projectDatabasePath(authority));
  database.exec('DELETE FROM execution_current');
  database.close();
  const before = focusState(handle);
  await expect(publishProjectExecutionFocus(handle, input)).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  expect(focusState(handle)).toEqual(before);
});

it('keeps corrupted original pin bytes while an exact clear remains independent of that payload', async () => {
  const { handle, authority, input } = await fixture();
  const first = await publishProjectExecutionFocus(handle, input);
  const database = new Database(projectDatabasePath(authority));
  const trigger = database
    .prepare("SELECT sql FROM sqlite_schema WHERE name = 'execution_focus_records_no_update'")
    .get() as { sql: string };
  database.exec('DROP TRIGGER execution_focus_records_no_update');
  database
    .prepare('UPDATE execution_focus_records SET pin_bytes = ?')
    .run(Buffer.from('invalid original'));
  database.exec(trigger.sql);
  database.close();
  const before = focusState(handle);
  expect(() => readProjectExecutionFocus(handle, input.scope)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  const result = await publishProjectExecutionFocus(handle, clear(input, first.value.selection));
  expect(result.value.status).toBe('cleared');
  expect(focusState(handle).value.records[0]).toEqual(before.value.records[0]);
  expect(readProjectExecutionFocus(handle, input.scope).status).toBe('cleared');
});

it('uses copied short reads and metadata-only settlement without decoding the artifact or execution corpus', async () => {
  const { handle, input } = await fixture();
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (/\bartifact_events\b|\brecord_bytes\b/i.test(sql))
      throw new Error('Unexpected corpus hydration');
    return prepare.call(this, sql);
  });
  const exec = Database.prototype.exec;
  let active = false;
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const result = exec.call(this, sql);
    if (this.name === handle.databasePath) active = this.inTransaction;
    return result;
  });
  const decode = TextDecoder.prototype.decode;
  const observed = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (
    this: TextDecoder,
    ...args: Parameters<TextDecoder['decode']>
  ) {
    expect(active).toBe(false);
    return decode.apply(this, args);
  });
  expect(() =>
    handle.read(() => new TextDecoder().decode(Buffer.from('inside read transaction')))
  ).toThrow();
  await publishProjectExecutionFocus(handle, input);
  observed.mockClear();
  expect(readProjectExecutionFocus(handle, input.scope).status).toBe('present');
  expect(observed).toHaveBeenCalled();
  expect(active).toBe(false);
});

it('refuses an unknown artifact and a wrong current selection without publishing a receipt', async () => {
  const { handle, input, pin } = await fixture();
  const before = focusState(handle);
  await expect(
    publishProjectExecutionFocus(handle, {
      ...input,
      pinBytes: Buffer.from(JSON.stringify({ ...pin, artifact_id: uuidv7() })),
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(focusState(handle)).toEqual(before);
  const first = await publishProjectExecutionFocus(handle, input);
  const selected = focusState(handle);
  for (const expected of [
    null,
    { ...first.value.selection, version: 2 },
    { ...first.value.selection, operationId: uuidv7() },
  ]) {
    await expect(
      publishProjectExecutionFocus(handle, clear(input, expected))
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  }
  expect(focusState(handle)).toEqual(selected);
});
