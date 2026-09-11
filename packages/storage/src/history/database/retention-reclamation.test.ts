import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  beginProjectCaptureRetention,
  settleProjectCaptureRetention,
} from './capture-retention.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { type PendingCaptureInput } from './pending-capture.js';
import { prepareProjectGitRetention, type PrepareProjectGitRetention } from './retention-input.js';
import {
  beginProjectGitReclamation,
  readProjectGitReclamation,
  readProjectGitReclamationAdmission,
  settleProjectGitReclamation,
} from './retention-reclamation.js';
import { retireProjectGitRetention } from './retention.js';
const roots: string[] = [],
  handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((h) => h.close());
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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
async function retired() {
  const f = await fixture();
  await beginProjectCaptureRetention(f.handle, {
    capture: f.capture,
    retention: prepareProjectGitRetention(f.retention),
  });
  await retireProjectGitRetention(f.handle, {
    operationId: uuidv7(),
    originalOperationId: f.retention.operationId,
    expectedTransitionId: f.retention.preparedTransitionId,
    transitionId: uuidv7(),
    reason: 'Cancelled original publication',
    secretAllow: [],
  });
  const preview = readProjectGitReclamation(
    f.handle,
    f.retention.publications[0]!.publicationId
  ).value;
  if (preview.status !== 'eligible') throw new Error('Fixture must be eligible');
  return {
    ...f,
    admission: {
      admissionOperationId: uuidv7(),
      terminalOperationId: uuidv7(),
      target: preview.target,
    },
  };
}
it('protects unknown and pending publications without writing while previewing', async () => {
  const f = await fixture();
  const id = f.retention.publications[0]!.publicationId;
  const before = f.handle.read((v) => v.all('SELECT * FROM operations'));
  expect(readProjectGitReclamation(f.handle, id).value).toMatchObject({
    status: 'protected',
    reason: 'unknown',
  });
  expect(f.handle.read((v) => v.all('SELECT * FROM operations'))).toEqual(before);
  await beginProjectCaptureRetention(f.handle, {
    capture: f.capture,
    retention: prepareProjectGitRetention(f.retention),
  });
  expect(readProjectGitReclamation(f.handle, id).value).toMatchObject({
    status: 'protected',
    reason: 'pending',
  });
});
it('retains exact admitted preview and separately settles an original removal result', async () => {
  const f = await retired();
  const before = f.handle.read(() => null).counters;
  const admitted = await beginProjectGitReclamation(f.handle, f.admission);
  expect(admitted.value.terminalOperationId).toBe(f.admission.terminalOperationId);
  expect(
    readProjectGitReclamationAdmission(f.handle, f.admission.admissionOperationId).value!.input
  ).toEqual(f.admission);
  const settled = await settleProjectGitReclamation(f.handle, {
    admissionOperationId: f.admission.admissionOperationId,
    outcome: 'removed',
  });
  expect(settled.value.outcome).toBe('removed');
  expect(settled.counters).toEqual({
    writeSequence: before.writeSequence + 2,
    intentChangeCounter: before.intentChangeCounter,
  });
  expect(
    (
      await settleProjectGitReclamation(f.handle, {
        admissionOperationId: f.admission.admissionOperationId,
        outcome: 'removed',
      })
    ).replayed
  ).toBe(true);
  expect(
    readProjectGitReclamationAdmission(f.handle, f.admission.admissionOperationId).value!.terminal!
      .value
  ).toEqual(settled.value);
  await expect(
    settleProjectGitReclamation(f.handle, {
      admissionOperationId: f.admission.admissionOperationId,
      outcome: 'absent',
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('records a re-observed absent outcome without inventing removal evidence', async () => {
  const f = await retired();
  await beginProjectGitReclamation(f.handle, f.admission);
  const result = await settleProjectGitReclamation(f.handle, {
    admissionOperationId: f.admission.admissionOperationId,
    outcome: 'absent',
  });
  expect(result.value.outcome).toBe('absent');
  expect(
    f.handle.read((v) =>
      v.get<{ outcome: string }>('SELECT outcome FROM git_retention_reclamations')
    ).value!.outcome
  ).toBe('absent');
});
it('refuses changed exact preview under the same admission and never retargets', async () => {
  const f = await retired();
  await beginProjectGitReclamation(f.handle, f.admission);
  await expect(
    beginProjectGitReclamation(f.handle, {
      ...f.admission,
      target: { ...f.admission.target, objectOid: 'd'.repeat(40) },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    beginProjectGitReclamation(f.handle, {
      ...f.admission,
      admissionOperationId: uuidv7(),
      target: { ...f.admission.target, retiredTransitionId: uuidv7() },
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(
    readProjectGitReclamationAdmission(f.handle, f.admission.admissionOperationId).value!.input
  ).toEqual(f.admission);
});
it('protects selected historical publications even after retirement', async () => {
  const f = await fixture();
  await beginProjectCaptureRetention(f.handle, {
    capture: f.capture,
    retention: prepareProjectGitRetention(f.retention),
  });
  const selected = await settleProjectCaptureRetention(f.handle, {
    originalOperationId: f.retention.operationId,
    expectedTransitionId: f.retention.preparedTransitionId,
    selectedTransitionId: uuidv7(),
  });
  await retireProjectGitRetention(f.handle, {
    operationId: uuidv7(),
    originalOperationId: f.retention.operationId,
    expectedTransitionId: selected.value.transitionId,
    transitionId: uuidv7(),
    reason: 'Retain committed publication',
    secretAllow: [],
  });
  expect(
    readProjectGitReclamation(f.handle, f.retention.publications[0]!.publicationId).value
  ).toMatchObject({ status: 'protected', reason: 'selected' });
});
it('refuses a missing cleanup admission instead of inferring ownership', async () => {
  const f = await retired();
  await expect(
    settleProjectGitReclamation(f.handle, { admissionOperationId: uuidv7(), outcome: 'absent' })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(f.handle.read((v) => v.all('SELECT * FROM git_retention_reclamations')).value).toEqual([]);
});
it('refuses another retained operation kind as a cleanup admission', async () => {
  const f = await retired();
  expect(() =>
    readProjectGitReclamationAdmission(f.handle, f.retention.admissionOperationId)
  ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(
    readProjectGitReclamationAdmission(f.handle, f.admission.admissionOperationId).value
  ).toBeNull();
});

it('rejects another cleanup admission reserving the same terminal identity', async () => {
  const f = await retired();
  await beginProjectGitReclamation(f.handle, f.admission);
  const before = f.handle.read((view) => view.all('SELECT * FROM operations'));
  await expect(
    beginProjectGitReclamation(f.handle, {
      ...f.admission,
      admissionOperationId: uuidv7(),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(f.handle.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
});

it('serializes concurrent admissions sharing one terminal identity and permits distinct identities', async () => {
  const f = await retired();
  const other = await openProjectDatabase({ authority: f.authority, mode: 'writer' });
  handles.push(other);
  const before = f.handle.read(() => null).counters;
  const locker = new Database(projectDatabasePath(f.authority));
  locker.exec('BEGIN IMMEDIATE');
  const observed = new Set<string>();
  const onWait = (name: string) => () => {
    observed.add(name);
    if (observed.size === 2 && locker.inTransaction) locker.exec('COMMIT');
  };
  const limit = setTimeout(() => {
    if (locker.inTransaction) locker.exec('ROLLBACK');
  }, 1000);
  let outcomes;
  try {
    outcomes = await Promise.allSettled([
      beginProjectGitReclamation(f.handle, f.admission, { onWait: onWait('first') }),
      beginProjectGitReclamation(
        other,
        { ...f.admission, admissionOperationId: uuidv7() },
        { onWait: onWait('second') }
      ),
    ]);
  } finally {
    clearTimeout(limit);
    if (locker.inTransaction) locker.exec('ROLLBACK');
    locker.close();
  }
  expect(observed.size).toBe(2);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(
    outcomes.filter((result) => result.status === 'rejected').map((result) => result.reason)
  ).toEqual([expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })]);
  expect(f.handle.read(() => null).counters).toEqual({
    ...before,
    writeSequence: before.writeSequence + 1,
  });
  const rows = f.handle.read((view) =>
    view.all<{ operationId: string }>(
      "SELECT operation_id AS operationId FROM operations WHERE operation_kind = 'git.retention.cleanup.begin'"
    )
  );
  expect(rows.value).toHaveLength(1);
  expect(
    readProjectGitReclamationAdmission(f.handle, rows.value[0]!.operationId).value!.input
      .terminalOperationId
  ).toBe(f.admission.terminalOperationId);
  expect(
    (
      await beginProjectGitReclamation(other, {
        ...f.admission,
        admissionOperationId: uuidv7(),
        terminalOperationId: uuidv7(),
      })
    ).replayed
  ).toBe(false);
});
it('protects a reserved terminal identity from reuse as another admission identity', async () => {
  const f = await retired();
  await beginProjectGitReclamation(f.handle, f.admission);
  const before = f.handle.read((view) => view.all('SELECT * FROM operations'));
  await expect(
    beginProjectGitReclamation(f.handle, {
      ...f.admission,
      admissionOperationId: f.admission.terminalOperationId,
      terminalOperationId: uuidv7(),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(f.handle.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
  expect(
    readProjectGitReclamationAdmission(f.handle, f.admission.admissionOperationId).value!.terminal
  ).toBeNull();
});
