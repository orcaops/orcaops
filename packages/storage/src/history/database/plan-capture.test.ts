import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { CapturePlanInputSchema } from '../../schema/capture-input.js';
import { digest, recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import { readProjectArtifact } from './artifacts.js';
import { publishProjectPlanIdempotency } from './capture-lifecycles.js';
import {
  beginProjectCaptureRetention,
  beginProjectPlanCaptureRetention,
  settleProjectCaptureRetention,
} from './capture-retention.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  appendProjectExecutionCapture,
  appendProjectPlanCapture,
  prepareExecutionCaptureRequest,
} from './execution-capture.js';
import { readProjectExecution } from './execution-records.js';
import { type PendingCaptureInput, readProjectPendingCapture } from './pending-capture.js';
import { assertPendingPlanKeyOwnership, insertPendingPlanKeys } from './pending-plan-keys.js';
import {
  planCaptureCommand,
  preparePlanCaptureCommand,
  preparePlanCaptureInput,
} from './plan-capture-input.js';
import { replayProjectPlanCapture } from './plan-capture-replay.js';
import { assertPlanCaptureMeaning, readProjectPlanCapture } from './plan-capture.js';
import { gitRetentionPreparation, prepareProjectGitRetention } from './retention-input.js';
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
    root: await mkdtemp(path.join(tmpdir(), 'database-plan-command-')),
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
  return { handle, authority };
}
function input(handle: ProjectDatabase, baseline = false, key = 'original:command') {
  const authored = CapturePlanInputSchema.parse({
    idempotency_key: key,
    task: 'Keep the original command',
    label: 'Original command',
    plan_steps: [
      {
        text: 'Retain immutable input',
        label: 'Retain input',
        acceptance_criteria: [{ text: 'Original input survives' }],
      },
    ],
  });
  const prepared = preparePlanCaptureInput({ authored, sourcePlan: null }, []);
  const artifactId = uuidv7(),
    operationId = uuidv7(),
    eventId = uuidv7();
  const plan = {
    schema_version: 4,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'a'.repeat(40),
    agent: 'codex',
    agent_session_id: null,
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
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-09-01T00:00:00.000Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    prior_plan_event_id: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    ...(baseline ? { baseline_seed_tree_sha: 'c'.repeat(40) } : {}),
  };
  const record = {
    event_id: eventId,
    type: 'plan_captured' as const,
    ts: plan.started_at,
    schema_version: 1,
    idempotency_key: authored.idempotency_key,
    payload: plan,
  };
  const capture: PendingCaptureInput = {
    artifactId,
    operationId,
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
    execution: {
      kind: 'create',
      ts: plan.started_at,
      context: {
        repository_instance_id: handle.authority.repositoryInstanceId,
        worktree_id: uuidv7(),
        git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
      },
    },
  };
  const admissionOperationId = baseline ? uuidv7() : operationId;
  const command = preparePlanCaptureCommand(prepared, {
    artifactId,
    planEventId: eventId,
    originalOperationId: operationId,
    admissionOperationId,
  });
  const retention = baseline
    ? prepareProjectGitRetention({
        operationId,
        admissionOperationId,
        preparedTransitionId: uuidv7(),
        repositoryInstanceId: handle.authority.repositoryInstanceId,
        objectFormat: 'sha1',
        createdAt: plan.started_at,
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
            targetId: eventId,
            checkpointNumber: null,
            checkpointPhase: null,
            objectOid: 'b'.repeat(40),
            treeOid: 'c'.repeat(40),
          },
        ],
        secretAllow: [],
      })
    : null;
  return { prepared, authored, command, capture, retention };
}
function rows(handle: ProjectDatabase) {
  return handle.read((view) => ({
    pendingKeys: view.all('SELECT * FROM pending_plan_keys ORDER BY event_id'),
    commands: view.all(
      'SELECT idempotency_key, hex(request_bytes) AS bytes FROM plan_capture_commands'
    ),
    events: view.all('SELECT event_id FROM artifact_events'),
    operations: view.all('SELECT * FROM operations'),
    execution: view.all('SELECT * FROM execution_current'),
  }));
}

it('publishes command input, plan and execution atomically and replays original receipt counters', async () => {
  const { handle } = await fixture();
  const original = input(handle);
  expect(readProjectPlanCapture(handle, original.prepared)).toBeNull();
  const result = await appendProjectPlanCapture(handle, original);
  const before = rows(handle);
  expect(before.value.commands).toHaveLength(1);
  expect(before.value.events).toHaveLength(1);
  expect(readProjectExecution(handle, original.capture.artifactId)).not.toBeNull();
  expect(result.counters).toEqual({ writeSequence: 2, intentChangeCounter: 1 });
  const lookup = readProjectPlanCapture(handle, original.prepared);
  expect(lookup?.kind).toBe('command');
  if (lookup?.kind === 'command')
    expect(planCaptureCommand(lookup.command)).toEqual(planCaptureCommand(original.command));
  const replay = await appendProjectPlanCapture(handle, original);
  expect(replay).toEqual({ ...result, replayed: true });
  expect(await replayProjectPlanCapture(handle, original.command)).toEqual({
    ...result,
    replayed: true,
  });
  expect(rows(handle)).toEqual(before);
});

it('keeps pending command input discoverable without effective artifact history or intent change', async () => {
  const { handle } = await fixture();
  const original = input(handle, true);
  const admitted = await beginProjectPlanCaptureRetention(handle, {
    ...original,
    retention: original.retention!,
  });
  expect(admitted.counters).toEqual({ writeSequence: 2, intentChangeCounter: 0 });
  expect(readProjectPlanCapture(handle, original.prepared)?.kind).toBe('command');
  expect(readProjectArtifact(handle, original.capture.artifactId)).toBeNull();
  const before = rows(handle);
  expect(
    await beginProjectPlanCaptureRetention(handle, { ...original, retention: original.retention! })
  ).toEqual({ ...admitted, replayed: true });
  expect(rows(handle)).toEqual(before);
  const result = await settleProjectCaptureRetention(handle, {
    originalOperationId: original.capture.operationId,
    expectedTransitionId: admitted.value.transitionId,
    selectedTransitionId: uuidv7(),
  });
  expect(result.counters).toEqual({ writeSequence: 3, intentChangeCounter: 1 });
  expect(readProjectArtifact(handle, original.capture.artifactId)?.thread.plan?.task).toBe(
    original.authored.task
  );
  expect(rows(handle).value.commands).toEqual(before.value.commands);
});

it('refuses changed original input and competing minted identities without adding effects', async () => {
  const { handle } = await fixture();
  const original = input(handle);
  await appendProjectPlanCapture(handle, original);
  const before = rows(handle);
  const changed = preparePlanCaptureInput(
    { authored: { ...original.authored, task: 'Different original task' }, sourcePlan: null },
    []
  );
  expect(() => readProjectPlanCapture(handle, changed)).toThrow(
    expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })
  );
  await expect(appendProjectPlanCapture(handle, input(handle))).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(rows(handle)).toEqual(before);
});

it('refuses a keyed plan event whose meaning differs from the original command', async () => {
  const { handle } = await fixture();
  const original = input(handle);
  const changed = preparePlanCaptureInput(
    { authored: { ...original.authored, touched_scope: ['other'] }, sourcePlan: null },
    []
  );
  const identity = planCaptureCommand(original.command);
  const command = preparePlanCaptureCommand(changed, {
    originalOperationId: identity.originalOperationId,
    admissionOperationId: identity.admissionOperationId,
    artifactId: identity.artifactId,
    planEventId: identity.planEventId,
  });
  const before = rows(handle);
  await expect(
    appendProjectPlanCapture(handle, { capture: original.capture, command })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rows(handle)).toEqual(before);
});

it('rolls back original command ownership if artifact publication fails', async () => {
  const { handle, authority } = await fixture();
  const original = input(handle);
  const db = new Database(projectDatabasePath(authority));
  db.exec(
    "CREATE TRIGGER refuse_fixture_artifact BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END"
  );
  db.close();
  const before = rows(handle);
  await expect(appendProjectPlanCapture(handle, original)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'constraint',
  });
  expect(rows(handle)).toEqual(before);
  expect(readProjectPlanCapture(handle, original.prepared)).toBeNull();
});

it.each([false, true])(
  'retains committed key records without new commands when pending input is %s',
  async (pending) => {
    const { handle, authority } = await fixture();
    const original = input(handle, pending);
    if (pending) {
      await beginProjectCaptureRetention(handle, {
        capture: original.capture,
        retention: original.retention!,
      });
      await settleProjectCaptureRetention(handle, {
        originalOperationId: original.capture.operationId,
        expectedTransitionId: readProjectPendingCapture(handle, original.capture.operationId).value!
          .retention.current.transitionId,
        selectedTransitionId: uuidv7(),
      });
    } else await appendProjectExecutionCapture(handle, original.capture);
    const artifact = readProjectArtifact(handle, original.capture.artifactId)!;
    const bytes = Buffer.from(
      ' ' +
        JSON.stringify({
          idempotency_key: original.authored.idempotency_key,
          artifact_id: artifact.artifactId,
          created_at: 'original time',
        }) +
        '\n'
    );
    await publishProjectPlanIdempotency(
      handle,
      {
        operationId: uuidv7(),
        artifactId: artifact.artifactId,
        artifactRevision: artifact.revision,
        bytes,
        source: {
          identity: 'original committed key',
          locator: 'sqlite:original#1',
          revisionId: null,
          eventId: null,
          operationId: null,
          sha256: digest(bytes),
        },
      },
      { secretAllow: [] }
    );
    const before = rows(handle);
    const lookup = readProjectPlanCapture(handle, original.prepared);
    expect(lookup?.kind).toBe('historical');
    if (lookup?.kind !== 'historical') throw new Error('Expected original committed key');
    expect(lookup.historical.bytes).toEqual(bytes);
    if (pending) {
      const database = new Database(projectDatabasePath(authority));
      const eventId = planCaptureCommand(original.command).planEventId;
      const row = database
        .prepare('SELECT event_bytes, record_hash FROM pending_capture_events WHERE event_id=?')
        .get(eventId) as { event_bytes: Buffer; record_hash: string };
      const trigger = database
        .prepare("SELECT sql FROM sqlite_schema WHERE name='pending_capture_events_no_update'")
        .get() as { sql: string };
      try {
        database.exec('DROP TRIGGER pending_capture_events_no_update');
        const changedBytes = Buffer.concat([row.event_bytes, Buffer.from(' ')]);
        database
          .prepare(
            'UPDATE pending_capture_events SET event_bytes=?, record_hash=? WHERE event_id=?'
          )
          .run(changedBytes, digest(changedBytes), eventId);
        expect(() => readProjectPlanCapture(handle, original.prepared)).toThrow(
          expect.objectContaining({ code: 'STALE_CONTEXT' })
        );
        database
          .prepare(
            'UPDATE pending_capture_events SET event_bytes=?, record_hash=? WHERE event_id=?'
          )
          .run(row.event_bytes, row.record_hash, eventId);
        database.exec(trigger.sql);
      } finally {
        database.close();
      }
      expect(readProjectPlanCapture(handle, original.prepared)?.kind).toBe('historical');
    }
    expect(assertPlanCaptureMeaning(original.prepared, artifact.thread.events[0]!)).toMatchObject({
      artifact_id: artifact.artifactId,
    });
    const changed = preparePlanCaptureInput(
      { authored: { ...original.authored, label: 'Different label' }, sourcePlan: null },
      []
    );
    expect(() => assertPlanCaptureMeaning(changed, artifact.thread.events[0]!)).toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })
    );
    expect(() => readProjectPlanCapture(handle, changed)).toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })
    );
    await expect(
      appendProjectPlanCapture(handle, input(handle, false, original.authored.idempotency_key))
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(rows(handle)).toEqual(before);
  }
);

it('releases the genuine read claim after refusing damaged original command input', async () => {
  const { handle, authority } = await fixture();
  const original = input(handle);
  await appendProjectPlanCapture(handle, original);
  const db = new Database(projectDatabasePath(authority));
  const trigger = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name='plan_capture_commands_no_update'")
    .get() as { sql: string };
  db.exec('DROP TRIGGER plan_capture_commands_no_update');
  db.prepare('UPDATE plan_capture_commands SET request_hash=?').run('f'.repeat(64));
  db.exec(trigger.sql);
  db.close();
  const before = rows(handle);
  expect(() => readProjectPlanCapture(handle, original.prepared)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(rows(handle)).toEqual(before);
  expect(readProjectArtifact(handle, original.capture.artifactId)?.artifactId).toBe(
    original.capture.artifactId
  );
});

it('refuses a pending plan whose original terminal identity already belongs to another receipt', async () => {
  const { handle } = await fixture();
  const original = input(handle, true);
  await runProjectOperation(
    handle,
    {
      operationId: original.capture.operationId,
      kind: 'fixture.other',
      target: null,
      payload: null,
      expectedState: null,
      intentChange: false,
    },
    () => null
  );
  const before = rows(handle);
  await expect(
    beginProjectPlanCaptureRetention(handle, { ...original, retention: original.retention! })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rows(handle)).toEqual(before);
});

function readPendingKey(
  handle: ProjectDatabase,
  key: string,
  owner?: { eventId: string; originalOperationId?: string }
) {
  return handle.read((view) => {
    assertPendingPlanKeyOwnership(view, key, owner);
    return null;
  });
}
function rawSettlement(database: Database.Database) {
  return {
    get: <T>(sql: string, ...parameters: unknown[]) =>
      database.prepare(sql).get(...parameters) as T | null,
    all: <T>(sql: string, ...parameters: unknown[]) =>
      database.prepare(sql).all(...parameters) as T[],
    run: (sql: string, ...parameters: unknown[]) => database.prepare(sql).run(...parameters),
  };
}
it('retains the last duplicate header key on pending admission', async () => {
  const { handle } = await fixture();
  const original = input(handle, true);
  original.capture = {
    ...original.capture,
    eventBytes: Buffer.from(
      Buffer.from(original.capture.eventBytes)
        .toString('utf8')
        .replace(
          '"idempotency_key":"original:command"',
          '"idempotency_key":"discarded:key","idempotency_\\u006bey":"original:command"'
        )
    ),
  };
  await beginProjectCaptureRetention(handle, {
    capture: original.capture,
    retention: original.retention!,
  });
  const before = rows(handle);
  expect(() => readPendingKey(handle, 'original:command')).toThrow(
    expect.objectContaining({
      code: 'STALE_CONTEXT',
      message: expect.stringContaining(original.capture.operationId),
    })
  );
  expect(() => readPendingKey(handle, 'discarded:key')).not.toThrow();
  expect(rows(handle)).toEqual(before);
});

it('refuses missing pending membership without decoding or repairing original input', async () => {
  const { handle } = await fixture();
  const original = input(handle, true);
  await beginProjectCaptureRetention(handle, {
    capture: original.capture,
    retention: original.retention!,
  });
  const database = new Database(projectDatabasePath(handle.authority));
  database
    .prepare('DELETE FROM pending_plan_keys WHERE event_id = ?')
    .run(planCaptureCommand(original.command).planEventId);
  database.close();
  const before = rows(handle);
  expect(() => readPendingKey(handle, 'unrelated:key')).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(handle.read((view) => view.all('SELECT * FROM pending_plan_keys')).value).toEqual([]);
  expect(rows(handle)).toEqual(before);
});

it('recognizes only the exact command-owned pending event and refuses another owner of its key', async () => {
  const { handle } = await fixture();
  const original = input(handle, true);
  await beginProjectPlanCaptureRetention(handle, { ...original, retention: original.retention! });
  const owner = {
    eventId: planCaptureCommand(original.command).planEventId,
    originalOperationId: original.capture.operationId,
  };
  expect(() => readPendingKey(handle, 'original:command', owner)).not.toThrow();
  expect(() =>
    readPendingKey(handle, 'original:command', {
      ...owner,
      originalOperationId: uuidv7(),
    })
  ).toThrow(expect.objectContaining({ code: 'STALE_CONTEXT' }));
  const competing = input(handle, true);
  const before = rows(handle);
  await expect(
    beginProjectCaptureRetention(handle, {
      capture: competing.capture,
      retention: competing.retention!,
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rows(handle)).toEqual(before);
});

it('inserts derived membership from the already decoded original admission and preserves its command owner', async () => {
  const { handle } = await fixture();
  const original = input(handle, true);
  const prepared = prepareExecutionCaptureRequest(handle, original.capture);
  await beginProjectPlanCaptureRetention(handle, { ...original, retention: original.retention! });
  const before = rows(handle);
  const database = new Database(projectDatabasePath(handle.authority));
  try {
    database.prepare('DELETE FROM pending_plan_keys').run();
    database.transaction(() => insertPendingPlanKeys(rawSettlement(database), prepared))();
  } finally {
    database.close();
  }
  expect(() =>
    readPendingKey(handle, 'original:command', {
      eventId: planCaptureCommand(original.command).planEventId,
      originalOperationId: original.capture.operationId,
    })
  ).not.toThrow();
  expect(rows(handle)).toEqual(before);
});

it('retains original operation-ID recovery after pending key preparation and refuses foreign membership insertion', async () => {
  const { handle } = await fixture();
  const original = input(handle, true);
  await beginProjectCaptureRetention(handle, {
    capture: original.capture,
    retention: original.retention!,
  });
  const pending = readProjectPendingCapture(handle, original.capture.operationId);
  expect(readProjectPendingCapture(handle, original.capture.operationId)).toEqual(pending);
  const competing = input(handle, true, 'different:key');
  const prepared = prepareExecutionCaptureRequest(handle, competing.capture);
  await beginProjectCaptureRetention(handle, {
    capture: competing.capture,
    retention: competing.retention!,
  });
  const before = rows(handle);
  const database = new Database(projectDatabasePath(handle.authority));
  try {
    expect(() =>
      database.transaction(() => insertPendingPlanKeys(rawSettlement(database), prepared))()
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(database.prepare('SELECT * FROM pending_plan_keys').all()).toHaveLength(2);
    expect(() =>
      database
        .prepare('INSERT INTO pending_plan_keys VALUES (?, ?, ?)')
        .run(
          planCaptureCommand(competing.command).planEventId,
          original.capture.operationId,
          'different:key'
        )
    ).toThrow('Pending plan key must retain its exact original event owner');
  } finally {
    database.close();
  }
  expect(rows(handle)).toEqual(before);
});

it('preserves an older pending terminal identity against a different direct plan command', async () => {
  const { handle } = await fixture();
  const pending = input(handle, true);
  await beginProjectCaptureRetention(handle, {
    capture: pending.capture,
    retention: pending.retention!,
  });
  const attempted = input(handle, false, 'different:command');
  attempted.capture = { ...attempted.capture, operationId: pending.capture.operationId };
  attempted.command = preparePlanCaptureCommand(attempted.prepared, {
    artifactId: attempted.capture.artifactId,
    planEventId: planCaptureCommand(attempted.command).planEventId,
    originalOperationId: pending.capture.operationId,
    admissionOperationId: pending.capture.operationId,
  });
  const before = rows(handle);
  await expect(appendProjectPlanCapture(handle, attempted)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(rows(handle)).toEqual(before);
  const recovered = await settleProjectCaptureRetention(handle, {
    originalOperationId: pending.capture.operationId,
    expectedTransitionId: readProjectPendingCapture(handle, pending.capture.operationId).value!
      .retention.current.transitionId,
    selectedTransitionId: uuidv7(),
  });
  expect(recovered.value.artifactId).toBe(pending.capture.artifactId);
  expect(readProjectPlanCapture(handle, attempted.prepared)).toBeNull();
});

it('preserves a pending terminal identity when another plan proposes it as an admission ID', async () => {
  const { handle } = await fixture();
  const pending = input(handle, true);
  await beginProjectCaptureRetention(handle, {
    capture: pending.capture,
    retention: pending.retention!,
  });
  const attempted = input(handle, true, 'different:admission');
  attempted.command = preparePlanCaptureCommand(attempted.prepared, {
    artifactId: attempted.capture.artifactId,
    planEventId: planCaptureCommand(attempted.command).planEventId,
    originalOperationId: attempted.capture.operationId,
    admissionOperationId: pending.capture.operationId,
  });
  const {
    fingerprint: _fingerprint,
    publications,
    ...retained
  } = gitRetentionPreparation(attempted.retention!);
  attempted.retention = prepareProjectGitRetention({
    ...retained,
    publications: publications.map(({ fullRef: _fullRef, ...publication }) => publication),
    admissionOperationId: pending.capture.operationId,
    secretAllow: [],
  });
  const before = rows(handle);
  await expect(
    beginProjectPlanCaptureRetention(handle, { ...attempted, retention: attempted.retention! })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rows(handle)).toEqual(before);
  expect(
    readProjectPendingCapture(handle, pending.capture.operationId).value?.capture.artifactId
  ).toBe(pending.capture.artifactId);
});

it.each([false, true])(
  'retains original request bytes only in command ownership with pending=%s',
  async (pending) => {
    const { handle } = await fixture();
    const original = input(handle, pending);
    const record = planCaptureCommand(original.command);
    if (pending) {
      const admitted = await beginProjectPlanCaptureRetention(handle, {
        ...original,
        retention: original.retention!,
      });
      expect(
        await beginProjectPlanCaptureRetention(handle, {
          ...original,
          retention: original.retention!,
        })
      ).toEqual({ ...admitted, replayed: true });
    } else {
      const appended = await appendProjectPlanCapture(handle, original);
      expect(await replayProjectPlanCapture(handle, original.command)).toEqual({
        ...appended,
        replayed: true,
      });
    }
    const retained = handle.read((view) => ({
      command: view.get<{ bytes: string }>(
        'SELECT CAST(request_bytes AS TEXT) AS bytes FROM plan_capture_commands WHERE original_operation_id=?',
        record.originalOperationId
      ),
      receipt: view.get<{ payload: string }>(
        'SELECT payload_json AS payload FROM operations WHERE operation_id=?',
        record.admissionOperationId
      ),
    })).value;
    expect(retained.command?.bytes).toBe(record.requestBytes);
    const payload = JSON.parse(retained.receipt!.payload) as { command: unknown };
    expect(payload.command).toEqual({
      idempotencyKey: record.idempotencyKey,
      requestHash: record.requestHash,
      originalOperationId: record.originalOperationId,
      admissionOperationId: record.admissionOperationId,
      artifactId: record.artifactId,
      planEventId: record.planEventId,
    });
  }
);
