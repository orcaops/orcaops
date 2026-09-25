import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { ProjectDatabaseError } from './errors.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import * as secretGuard from '../../text/secret-guard.js';
import { recordChecksum } from '../event-integrity.js';
import * as provenance from '../metadata-provenance.js';
import { normalizeHistoryRoot } from '../paths.js';
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
import { readProjectEvaluatorRunFindings } from './evaluator-findings.js';
import { readProjectExecution } from './execution-records.js';
import { type PendingCaptureInput, readProjectPendingCapture } from './pending-capture.js';
import {
  gitRetentionPreparation,
  prepareProjectGitRetention,
  type PrepareProjectGitRetention,
} from './retention-input.js';
import { readProjectGitRetention } from './retention-records.js';
import { retireProjectGitRetention } from './retention.js';
import * as sourceTime from './source-time-records.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const prior = JSON.parse(
  readFileSync(new URL('./fixtures/retention-inputs.json', import.meta.url), 'utf8')
) as {
  rows: Record<string, Array<Record<string, string | number | null | { blobHex: string }>>>;
};
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-capture-retention-')),
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
  const event = prior.rows.artifact_events![0]!;
  const originalRecord = JSON.parse(
    Buffer.from((event.record_bytes as { blobHex: string }).blobHex, 'hex').toString('utf8')
  );
  const { checksum: _checksum, ...planRecord } = originalRecord;
  const planWithBaseline = {
    ...planRecord,
    payload: { ...planRecord.payload, baseline_seed_tree_sha: 'c'.repeat(40) },
  };
  const capture: PendingCaptureInput = {
    artifactId: event.artifact_id as string,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: Buffer.from(
      JSON.stringify({ ...planWithBaseline, checksum: recordChecksum(planWithBaseline) }) + '\n'
    ),
    sidecarPayloads:
      event.sidecar_payload_bytes === null
        ? []
        : [
            {
              eventId: event.event_id as string,
              bytes: Buffer.from(
                (event.sidecar_payload_bytes as { blobHex: string }).blobHex,
                'hex'
              ),
            },
          ],
    secretAllow: [],
    execution: {
      kind: 'create',
      context: {
        repository_instance_id: authority.repositoryInstanceId,
        worktree_id: uuidv7(),
        git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
      },
      ts: '2026-09-01T00:00:00.000Z',
    },
  };
  const retention: PrepareProjectGitRetention = {
    operationId: capture.operationId,
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:00:00.000Z',
    target: {
      kind: 'capture',
      artifactId: capture.artifactId,
      expectedRevision: null,
      expectedExecutionVersion: null,
      expectedBindingGeneration: null,
      expectedBaselinePublicationId: null,
    },
    publications: [
      {
        publicationId: uuidv7(),
        role: 'baseline',
        targetId: event.event_id as string,
        checkpointNumber: null,
        checkpointPhase: null,
        objectOid: 'b'.repeat(40),
        treeOid: 'c'.repeat(40),
      },
    ],
    secretAllow: [],
  };
  return { handle, authority, capture, retention };
}
function begin(value: Awaited<ReturnType<typeof fixture>>) {
  return beginProjectCaptureRetention(value.handle, {
    capture: value.capture,
    retention: prepareProjectGitRetention(value.retention),
  });
}
function selection(retention: PrepareProjectGitRetention) {
  return {
    originalOperationId: retention.operationId,
    expectedTransitionId: retention.preparedTransitionId,
    selectedTransitionId: uuidv7(),
  };
}
function state(handle: ProjectDatabase) {
  return handle.read((view) => ({
    artifacts: view.all('SELECT * FROM artifacts'),
    events: view.all('SELECT event_id FROM artifact_events'),
    execution: view.all('SELECT * FROM execution_current'),
    operations: view.all('SELECT * FROM operations'),
    current: view.all('SELECT * FROM git_retention_current'),
    bindings: view.all('SELECT * FROM artifact_retention_selections'),
    pending: view.all(
      'SELECT original_operation_id, ordinal, hex(event_bytes) AS bytes FROM pending_capture_events'
    ),
  }));
}
async function checkpoint(value: Awaited<ReturnType<typeof fixture>>) {
  if (!readProjectArtifact(value.handle, value.capture.artifactId)) {
    await begin(value);
    await settleProjectCaptureRetention(value.handle, selection(value.retention));
  }
  const artifact = readProjectArtifact(value.handle, value.capture.artifactId)!;
  const execution = readProjectExecution(value.handle, value.capture.artifactId)!;
  const operationId = uuidv7(),
    eventId = uuidv7();
  const retention: PrepareProjectGitRetention = {
    ...value.retention,
    operationId,
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    target: {
      kind: 'capture',
      artifactId: artifact.artifactId,
      expectedRevision: artifact.revision,
      expectedExecutionVersion: execution.version,
      expectedBindingGeneration: execution.state.binding_generation,
      expectedBaselinePublicationId: value.retention.publications[0]!.publicationId,
    },
    publications: [
      {
        publicationId: uuidv7(),
        role: 'checkpoint',
        targetId: eventId,
        checkpointNumber: 1,
        checkpointPhase: 'open',
        objectOid: 'd'.repeat(40),
        treeOid: 'e'.repeat(40),
      },
    ],
  };
  const publication = gitRetentionPreparation(prepareProjectGitRetention(retention))
    .publications[0]!;
  const record = {
    event_id: eventId,
    type: 'checkpoint_opened',
    ts: '2026-09-01T00:01:00.000Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: {
      artifact_id: artifact.artifactId,
      n: 1,
      declared_step_ids: [artifact.thread.plan!.plan_steps[0]!.step_id],
      agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: artifact.thread.plan!.source_event_id,
      opened_at: '2026-09-01T00:01:00.000Z',
      head_sha: 'a'.repeat(40),
      open_snapshot: {
        snapshot_ref: publication.fullRef,
        tree_sha: publication.treeOid,
        snapshot_commit_sha: publication.objectOid,
        snapshot_error_reason: null,
      },
    },
  };
  const capture: PendingCaptureInput = {
    ...value.capture,
    operationId,
    expectedRevision: artifact.revision,
    eventBytes: Buffer.from(
      ` ${JSON.stringify({ ...record, checksum: recordChecksum(record) })}\n`
    ),
    sidecarPayloads: [],
    execution: {
      kind: 'task',
      context: value.capture.execution.context,
      expectedVersion: execution.version,
      expectedGeneration: execution.state.binding_generation,
      explicitTarget: true,
    },
  };
  return { ...value, capture, retention };
}

it('retains original pending bytes before atomically publishing artifact execution and baseline', async () => {
  const value = await fixture();
  const before = value.handle.read(() => null).counters;
  const admitted = await begin(value);
  expect(readProjectArtifact(value.handle, value.capture.artifactId)).toBeNull();
  expect(readProjectExecution(value.handle, value.capture.artifactId)).toBeNull();
  expect(admitted.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const pending = readProjectPendingCapture(value.handle, value.capture.operationId).value!;
  expect(pending.capture.eventBytes).toEqual(value.capture.eventBytes);
  expect(pending.capture.sidecarPayloads).toEqual(value.capture.sidecarPayloads);
  const result = await settleProjectCaptureRetention(value.handle, selection(value.retention));
  const artifact = readProjectArtifact(value.handle, value.capture.artifactId)!;
  expect(artifact.eventBytes).toEqual(value.capture.eventBytes);
  expect(readProjectExecution(value.handle, value.capture.artifactId)!.version).toBe(1);
  expect(result.counters.writeSequence).toBe(admitted.counters.writeSequence + 1);
  expect(result.counters.intentChangeCounter).toBe(admitted.counters.intentChangeCounter + 1);
  expect(readProjectPendingCapture(value.handle, value.capture.operationId).value!.capture).toEqual(
    pending.capture
  );
});

it('replays original admission and terminal results after explicit retirement without callbacks', async () => {
  const value = await fixture();
  const admitted = await begin(value);
  const command = selection(value.retention);
  const selected = await settleProjectCaptureRetention(value.handle, command);
  await retireProjectGitRetention(value.handle, {
    operationId: uuidv7(),
    originalOperationId: value.capture.operationId,
    expectedTransitionId: command.selectedTransitionId,
    transitionId: uuidv7(),
    reason: 'Retire retained publication',
    secretAllow: [],
  });
  const before = state(value.handle);
  expect(await begin(value)).toEqual({ ...admitted, replayed: true });
  expect(await settleProjectCaptureRetention(value.handle, command)).toEqual({
    ...selected,
    replayed: true,
  });
  expect(state(value.handle)).toEqual(before);
});

it('binds a newly committed checkpoint revision while retaining its original expected revision', async () => {
  const value = await checkpoint(await fixture());
  await begin(value);
  const result = await settleProjectCaptureRetention(value.handle, selection(value.retention));
  expect(result.value.revision.generation).toBe(2);
  expect(
    readProjectGitRetention(value.handle, value.capture.operationId).value!.input.target
  ).toEqual(value.retention.target);
  expect(
    value.handle.read((view) =>
      view.get<{ generation: number }>(
        'SELECT artifact_generation AS generation FROM artifact_retention_selections WHERE publication_id = ?',
        value.retention.publications[0]!.publicationId
      )
    ).value!.generation
  ).toBe(2);
  expect(
    readProjectExecution(value.handle, value.capture.artifactId)!.state.checkpoint_execution
  ).toHaveLength(1);
});

it('rolls back all domain and retention settlement rows when final baseline binding fails', async () => {
  const value = await fixture();
  await begin(value);
  const before = state(value.handle);
  const original = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.startsWith('INSERT INTO artifact_baseline_current'))
      throw new Database.SqliteError('Fixture disk full', 'SQLITE_FULL');
    return original.call(this, sql);
  });
  const command = selection(value.retention);
  await expect(settleProjectCaptureRetention(value.handle, command)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'disk-full',
  });
  vi.restoreAllMocks();
  expect(state(value.handle)).toEqual(before);
  expect((await settleProjectCaptureRetention(value.handle, command)).value.state).toBe('selected');
});

it('rejects a retired pending operation while allowing a new operation at the same checkpoint boundary', async () => {
  const base = await fixture();
  const value = await checkpoint(base);
  await begin(value);
  await retireProjectGitRetention(value.handle, {
    operationId: uuidv7(),
    originalOperationId: value.capture.operationId,
    expectedTransitionId: value.retention.preparedTransitionId,
    transitionId: uuidv7(),
    reason: 'Cancelled publication',
    secretAllow: [],
  });
  const before = state(value.handle);
  await expect(
    settleProjectCaptureRetention(value.handle, selection(value.retention))
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(state(value.handle)).toEqual(before);
  expect(readProjectArtifact(value.handle, value.capture.artifactId)!.revision.generation).toBe(1);
  const next = await checkpoint(base);
  expect(next.retention.publications[0]!.checkpointNumber).toBe(
    value.retention.publications[0]!.checkpointNumber
  );
  expect(
    gitRetentionPreparation(prepareProjectGitRetention(next.retention)).publications[0]!.fullRef
  ).not.toBe(
    gitRetentionPreparation(prepareProjectGitRetention(value.retention)).publications[0]!.fullRef
  );
  await begin(next);
  expect(
    (await settleProjectCaptureRetention(next.handle, selection(next.retention))).value.state
  ).toBe('selected');
  expect(
    readProjectPendingCapture(value.handle, value.capture.operationId).value!.retention.current.kind
  ).toBe('retired');
});

it('refuses changed exact event bytes under an existing admission identity', async () => {
  const value = await fixture();
  await begin(value);
  const before = state(value.handle);
  value.capture = {
    ...value.capture,
    eventBytes: Buffer.concat([Buffer.from(' '), value.capture.eventBytes]),
  };
  await expect(begin(value)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(state(value.handle)).toEqual(before);
});

it('reads and settles already admitted input without reapplying a changed authored secret policy', async () => {
  const value = await fixture();
  await begin(value);
  const expected = readProjectPendingCapture(value.handle, value.capture.operationId);
  const guard = vi.spyOn(secretGuard, 'assertNoSecretsInPayload').mockImplementation(() => {
    throw new Error('Later authored policy');
  });
  expect(readProjectPendingCapture(value.handle, value.capture.operationId)).toEqual(expected);
  await settleProjectCaptureRetention(value.handle, selection(value.retention));
  expect(guard).not.toHaveBeenCalled();
});

it('refuses missing pending events without reconstructing them from another source', async () => {
  const value = await fixture();
  await begin(value);
  const db = new Database(projectDatabasePath(value.authority));
  try {
    const trigger = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'pending_capture_events_no_delete'")
      .get() as { sql: string };
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TRIGGER pending_capture_events_no_delete');
    db.prepare('DELETE FROM pending_capture_events WHERE original_operation_id = ?').run(
      value.capture.operationId
    );
    db.exec(trigger.sql);
    db.pragma('foreign_keys = ON');
    const before = state(value.handle);
    expect(() => readProjectPendingCapture(value.handle, value.capture.operationId)).toThrowError(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    await expect(
      settleProjectCaptureRetention(value.handle, selection(value.retention))
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(state(value.handle)).toEqual(before);
  } finally {
    db.close();
  }
});

it('refuses a different checkpoint OID before retaining any pending input', async () => {
  const value = await checkpoint(await fixture());
  value.retention.publications[0]!.objectOid = 'f'.repeat(40);
  const before = state(value.handle);
  await expect(begin(value)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(state(value.handle)).toEqual(before);
});

it('refuses authored secrets before admission rows receipts or counters', async () => {
  const value = await fixture();
  value.capture.execution.context.git_context.branch = 'ghp_' + '0'.repeat(37);
  const before = state(value.handle);
  await expect(begin(value)).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(state(value.handle)).toEqual(before);
});

it('rejects an admitted competing capture after the original artifact and execution advance', async () => {
  const base = await fixture();
  const first = await checkpoint(base);
  const second = await checkpoint(base);
  await begin(first);
  await begin(second);
  await settleProjectCaptureRetention(first.handle, selection(first.retention));
  const before = state(base.handle);
  await expect(
    settleProjectCaptureRetention(second.handle, selection(second.retention))
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(state(base.handle)).toEqual(before);
  expect(
    readProjectPendingCapture(base.handle, second.capture.operationId).value!.retention.current.kind
  ).toBe('prepared');
});

it('detaches accepted capture bytes and execution context before returning to the caller', async () => {
  const value = await fixture();
  const originalBytes = Buffer.from(value.capture.eventBytes);
  const originalContext = structuredClone(value.capture.execution.context);
  const pending = begin(value);
  value.capture.eventBytes.fill(0);
  value.capture.execution.context.git_context.branch = 'changed caller branch';
  await pending;
  const retained = readProjectPendingCapture(value.handle, value.capture.operationId).value!;
  expect(retained.capture.eventBytes).toEqual(originalBytes);
  expect(retained.capture.execution.context).toEqual(originalContext);
  await settleProjectCaptureRetention(value.handle, selection(value.retention));
  expect(readProjectArtifact(value.handle, value.capture.artifactId)!.eventBytes).toEqual(
    originalBytes
  );
});

it('commits ordered plan and checkpoint events under one revision and intent advancement', async () => {
  const value = await fixture();
  const planRecord = JSON.parse(Buffer.from(value.capture.eventBytes).toString('utf8'));
  const eventId = uuidv7(),
    publicationId = uuidv7();
  value.retention.publications.push({
    publicationId,
    role: 'checkpoint',
    targetId: eventId,
    checkpointNumber: 1,
    checkpointPhase: 'open',
    objectOid: 'd'.repeat(40),
    treeOid: 'e'.repeat(40),
  });
  const publication = gitRetentionPreparation(
    prepareProjectGitRetention(value.retention)
  ).publications.find((entry) => entry.publicationId === publicationId)!;
  const record = {
    event_id: eventId,
    type: 'checkpoint_opened',
    ts: '2026-09-01T00:01:00.000Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: {
      artifact_id: value.capture.artifactId,
      n: 1,
      declared_step_ids: [planRecord.payload.plan_steps[0].step_id],
      agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: planRecord.event_id,
      opened_at: '2026-09-01T00:01:00.000Z',
      head_sha: 'a'.repeat(40),
      open_snapshot: {
        snapshot_ref: publication.fullRef,
        tree_sha: publication.treeOid,
        snapshot_commit_sha: publication.objectOid,
        snapshot_error_reason: null,
      },
    },
  };
  value.capture = {
    ...value.capture,
    eventBytes: Buffer.concat([
      value.capture.eventBytes,
      Buffer.from(JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n'),
    ]),
  };
  value.retention.publications.reverse();
  const admitted = await begin(value);
  expect(readProjectArtifact(value.handle, value.capture.artifactId)).toBeNull();
  const result = await settleProjectCaptureRetention(value.handle, selection(value.retention));
  expect(result.value.eventIds).toEqual([planRecord.event_id, eventId]);
  expect(result.value.revision).toMatchObject({
    generation: 1,
    eventCount: 2,
    tailEventId: eventId,
  });
  expect(result.counters.intentChangeCounter).toBe(admitted.counters.intentChangeCounter + 1);
  expect(
    value.handle.read((view) =>
      view.all('SELECT artifact_generation FROM artifact_retention_selections')
    ).value
  ).toEqual([{ artifact_generation: 1 }, { artifact_generation: 1 }]);
  expect(
    readProjectExecution(value.handle, value.capture.artifactId)!.state.checkpoint_execution
  ).toHaveLength(1);
});

it.each(['admission', 'settlement'] as const)(
  'keeps original cancellation across asynchronous capture %s preparation',
  async (phase) => {
    const value = await fixture();
    if (phase === 'settlement') await begin(value);
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const before = value.handle.read((view) => ({
      operations: view.all('SELECT * FROM operations'),
      artifacts: view.all('SELECT * FROM artifacts'),
      metadata: view.all('SELECT * FROM artifact_query_metadata'),
      current: view.all('SELECT * FROM git_retention_current'),
    }));
    const original = provenance.historyProvenanceMetadata;
    vi.spyOn(provenance, 'historyProvenanceMetadata').mockImplementationOnce(async (thread) => {
      options.signal = new AbortController().signal;
      controller.abort();
      return original(thread);
    });
    const outcome =
      phase === 'admission'
        ? beginProjectCaptureRetention(
            value.handle,
            { capture: value.capture, retention: prepareProjectGitRetention(value.retention) },
            options
          )
        : settleProjectCaptureRetention(value.handle, selection(value.retention), options);
    await expect(outcome).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(
      value.handle.read((view) => ({
        operations: view.all('SELECT * FROM operations'),
        artifacts: view.all('SELECT * FROM artifacts'),
        metadata: view.all('SELECT * FROM artifact_query_metadata'),
        current: view.all('SELECT * FROM git_retention_current'),
      }))
    ).toEqual(before);
  }
);

it.each(['once', 'twice', 'other-stale'] as const)(
  'retains the original pending capture through %s source snapshot failure',
  async (failure) => {
    const value = await fixture();
    await begin(value);
    const selected = selection(value.retention);
    const originalIds = { ...selected };
    const before = state(value.handle);
    const original = sourceTime.assertProjectSourceTimeSelection;
    let attempts = 0;
    const spy = vi
      .spyOn(sourceTime, 'assertProjectSourceTimeSelection')
      .mockImplementation((view, artifactId, expected) => {
        attempts++;
        if (failure === 'other-stale')
          throw new ProjectDatabaseError(
            'STALE_CONTEXT',
            'Authored target changed; select an explicitly new operation'
          );
        if (attempts <= (failure === 'once' ? 1 : 2)) {
          selected.originalOperationId = uuidv7();
          selected.selectedTransitionId = uuidv7();
          original(view, artifactId, { revisionId: uuidv7(), version: 1 });
        }
        original(view, artifactId, expected);
      });
    const result = settleProjectCaptureRetention(value.handle, selected);
    if (failure === 'once') {
      await expect(result).resolves.toMatchObject({
        replayed: false,
        value: {
          originalOperationId: originalIds.originalOperationId,
          transitionId: originalIds.selectedTransitionId,
        },
      });
      expect(attempts).toBe(2);
      spy.mockRestore();
      expect(readProjectArtifact(value.handle, value.capture.artifactId)!.eventBytes).toEqual(
        value.capture.eventBytes
      );
      const committed = state(value.handle);
      vi.spyOn(sourceTime, 'assertProjectSourceTimeSelection').mockImplementation(() => {
        throw new Error('receipt replay must skip preparation');
      });
      await expect(settleProjectCaptureRetention(value.handle, originalIds)).resolves.toMatchObject(
        { replayed: true }
      );
      expect(state(value.handle)).toEqual(committed);
    } else {
      await expect(result).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
      expect(attempts).toBe(failure === 'twice' ? 2 : 1);
      spy.mockRestore();
      expect(state(value.handle)).toEqual(before);
    }
  }
);

it('honors original cancellation before preparing a private source retry', async () => {
  const value = await fixture();
  await begin(value);
  const controller = new AbortController();
  const before = state(value.handle);
  const original = sourceTime.assertProjectSourceTimeSelection;
  const prepared = vi.spyOn(provenance, 'historyProvenanceMetadata');
  vi.spyOn(sourceTime, 'assertProjectSourceTimeSelection').mockImplementation(
    (view, artifactId) => {
      controller.abort();
      original(view, artifactId, { revisionId: uuidv7(), version: 1 });
    }
  );
  await expect(
    settleProjectCaptureRetention(value.handle, selection(value.retention), {
      signal: controller.signal,
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(prepared).toHaveBeenCalledTimes(1);
  expect(state(value.handle)).toEqual(before);
});

it('keeps an admitted handover for the next attempt when the settlement refuses', async () => {
  const value = await fixture();
  const runId = uuidv7();
  const payload = {
    schema: 'orcaops.evaluator_run/v1',
    run_id: runId,
    artifact_id: value.capture.artifactId,
    evaluator_ref: 'core/step-coverage',
    package_id: 'core',
    evaluator_id: 'step-coverage',
    phase: 'post-plan',
    severity: 'info',
    run_status: 'completed',
    verdict: 'pass',
    body: 'Every declared step is covered.',
    ts: '2026-09-01T00:00:00.000Z',
  };
  const runRecord = {
    event_id: uuidv7(),
    type: 'evaluator_run_recorded',
    ts: payload.ts,
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload,
  };
  value.capture = {
    ...value.capture,
    eventBytes: Buffer.concat([
      Buffer.from(value.capture.eventBytes),
      Buffer.from(`${JSON.stringify({ ...runRecord, checksum: recordChecksum(runRecord) })}\n`),
    ]),
    evaluatorEvidence: [
      {
        run_id: runId,
        findings: {
          status: 'established',
          record: {
            schema: 'orcaops.evaluator_run_findings/v1',
            run_id: runId,
            findings: [{ key: 'criterion/c1', title: 'The delivered tests cover criterion c1' }],
          },
        },
        basis: {
          context_sha256: 'd'.repeat(64),
          base_sha: 'a'.repeat(40),
          head_sha: 'b'.repeat(40),
          evaluator_version: null,
          producer_payload: null,
        },
      },
    ],
  };

  await begin(value);
  const admitted = value.handle.read((view) => ({
    pending: view.all('SELECT run_id FROM pending_capture_evaluator_evidence'),
    contexts: view.all('SELECT run_id FROM evaluator_run_contexts'),
  })).value;
  expect(admitted).toEqual({ pending: [{ run_id: runId }], contexts: [] });

  await expect(
    settleProjectCaptureRetention(value.handle, {
      ...selection(value.retention),
      expectedTransitionId: uuidv7(),
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(
    value.handle.read((view) => ({
      pending: view.all('SELECT run_id FROM pending_capture_evaluator_evidence'),
      contexts: view.all('SELECT run_id FROM evaluator_run_contexts'),
      findings: view.all('SELECT run_id FROM evaluator_findings'),
    })).value
  ).toEqual({ pending: [{ run_id: runId }], contexts: [], findings: [] });

  // The next attempt settles what the admission retained, with no allowlist to read it under.
  await settleProjectCaptureRetention(value.handle, selection(value.retention));
  const retained = readProjectEvaluatorRunFindings(value.handle, runId);
  if (retained.status !== 'established') throw new Error(retained.status);
  expect(retained.findings.map((finding) => finding.key)).toEqual(['criterion/c1']);
});
