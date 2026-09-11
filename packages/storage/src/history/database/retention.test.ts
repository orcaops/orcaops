import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import * as secretGuard from '../../text/secret-guard.js';
import { recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import { readProjectArtifact } from './artifacts.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { appendProjectExecutionCapture } from './execution-capture.js';
import { readProjectExecution } from './execution-records.js';
import {
  gitRetentionPreparation,
  prepareProjectGitRetention,
  type PrepareProjectGitRetention,
} from './retention-input.js';
import { listProjectGitRetentions, readProjectGitRetention } from './retention-records.js';
import {
  beginProjectGitRetention,
  retireProjectGitRetention,
  settleProjectGitRetention,
} from './retention.js';
import { type ProjectSettlement, runProjectOperation } from './transactions.js';

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
async function fixture(checkpoint = false, retainedEvidence = true) {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-retention-')),
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
  const artifactId = event.artifact_id as string;
  const originalBytes = Buffer.from((event.record_bytes as { blobHex: string }).blobHex, 'hex');
  const originalRecord = JSON.parse(originalBytes.toString('utf8'));
  const { checksum: _checksum, ...planRecord } = originalRecord;
  const planWithBaseline = {
    ...planRecord,
    payload: { ...planRecord.payload, baseline_seed_tree_sha: 'b'.repeat(40) },
  };
  const planBytes = retainedEvidence
    ? Buffer.from(
        JSON.stringify({ ...planWithBaseline, checksum: recordChecksum(planWithBaseline) }) + '\n'
      )
    : originalBytes;
  const checkpointPublicationId = uuidv7();
  const context = {
    repository_instance_id: authority.repositoryInstanceId,
    worktree_id: uuidv7(),
    git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
  };
  await appendProjectExecutionCapture(handle, {
    artifactId,
    operationId: uuidv7(),
    expectedRevision: null,
    eventBytes: planBytes,
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
    execution: { kind: 'create', context, ts: '2026-09-01T00:00:00.000Z' },
  });
  let checkpointId: string | null = null;
  if (checkpoint) {
    const artifact = readProjectArtifact(handle, artifactId)!,
      execution = readProjectExecution(handle, artifactId)!;
    const record = {
      event_id: uuidv7(),
      type: 'checkpoint_opened' as const,
      ts: '2026-09-01T00:01:00.000Z',
      schema_version: 1 as const,
      idempotency_key: uuidv7(),
      payload: {
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: [artifact.thread.plan!.plan_steps[0]!.step_id],
        agent: 'codex',
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: artifact.thread.plan!.source_event_id,
        opened_at: '2026-09-01T00:01:00.000Z',
        head_sha: 'a'.repeat(40),
        open_snapshot: {
          snapshot_ref: retainedEvidence
            ? `refs/orcaops/snap/${artifactId}/1/open-${checkpointPublicationId}`
            : null,
          tree_sha: retainedEvidence ? 'd'.repeat(40) : null,
          snapshot_commit_sha: retainedEvidence ? 'c'.repeat(40) : null,
          snapshot_error_reason: null,
        },
      },
    };
    checkpointId = record.event_id;
    await appendProjectExecutionCapture(handle, {
      artifactId,
      operationId: uuidv7(),
      expectedRevision: artifact.revision,
      eventBytes: Buffer.from(
        JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n'
      ),
      sidecarPayloads: [],
      secretAllow: [],
      execution: {
        kind: 'task',
        context,
        expectedVersion: execution.version,
        expectedGeneration: execution.state.binding_generation,
        explicitTarget: true,
      },
    });
  }
  const artifact = readProjectArtifact(handle, artifactId)!,
    execution = readProjectExecution(handle, artifactId)!;
  const input: PrepareProjectGitRetention = {
    operationId: uuidv7(),
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:02:00.000Z',
    target: {
      kind: 'capture',
      artifactId,
      expectedRevision: artifact.revision,
      expectedExecutionVersion: execution.version,
      expectedBindingGeneration: execution.state.binding_generation,
      expectedBaselinePublicationId: null,
    },
    publications: [
      {
        publicationId: uuidv7(),
        role: 'baseline',
        targetId: event.event_id as string,
        checkpointNumber: null,
        checkpointPhase: null,
        objectOid: 'a'.repeat(40),
        treeOid: 'b'.repeat(40),
      },
    ],
    secretAllow: [],
  };
  if (checkpointId)
    input.publications.push({
      publicationId: checkpointPublicationId,
      role: 'checkpoint',
      targetId: checkpointId,
      checkpointNumber: 1,
      checkpointPhase: 'open',
      objectOid: 'c'.repeat(40),
      treeOid: 'd'.repeat(40),
    });
  return { handle, authority, input, retainedEvidence };
}
function next(input: PrepareProjectGitRetention): PrepareProjectGitRetention {
  return {
    ...structuredClone(input),
    operationId: uuidv7(),
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    publications: input.publications.map((publication) => ({
      ...publication,
      publicationId: uuidv7(),
    })),
  };
}
function retire(
  input: PrepareProjectGitRetention,
  expectedTransitionId = input.preparedTransitionId
) {
  return {
    operationId: uuidv7(),
    originalOperationId: input.operationId,
    expectedTransitionId,
    transitionId: uuidv7(),
    reason: 'Explicit operation cancellation',
    secretAllow: [],
  };
}
it('canonicalizes an unordered publication set and replays original admission and settlement results', async () => {
  const { handle, input } = await fixture(true);
  const prepared = prepareProjectGitRetention(input);
  const reordered = prepareProjectGitRetention({
    ...input,
    publications: [...input.publications].reverse(),
  });
  expect(gitRetentionPreparation(reordered)).toEqual(gitRetentionPreparation(prepared));
  const counters = handle.read(() => null).counters;
  const admitted = await beginProjectGitRetention(handle, prepared);
  expect(admitted.counters).toEqual({
    writeSequence: counters.writeSequence + 1,
    intentChangeCounter: counters.intentChangeCounter,
  });
  const observed = readProjectGitRetention(handle, input.operationId)!;
  expect(observed.value!.input).toEqual(gitRetentionPreparation(prepared));
  const replay = await beginProjectGitRetention(handle, reordered);
  expect(replay).toEqual({ ...admitted, replayed: true });
  const selectedId = uuidv7();
  const selected = await settleProjectGitRetention(
    handle,
    reordered,
    input.preparedTransitionId,
    selectedId
  );
  const beforeReplay = handle.read(() => null).counters;
  expect(
    await settleProjectGitRetention(handle, prepared, input.preparedTransitionId, selectedId)
  ).toEqual({ ...selected, replayed: true });
  expect(handle.read(() => null).counters).toEqual(beforeReplay);
  expect(
    handle.read((view) => view.all('SELECT * FROM artifact_retention_selections')).value
  ).toHaveLength(2);
  expect(readProjectGitRetention(handle, input.operationId).value!.current.kind).toBe('selected');
});
it('rejects changed descriptors under the same admission identity without advancing counters', async () => {
  const { handle, input } = await fixture();
  await beginProjectGitRetention(handle, prepareProjectGitRetention(input));
  const before = readProjectGitRetention(handle, input.operationId);
  input.publications[0]!.objectOid = 'e'.repeat(40);
  await expect(
    beginProjectGitRetention(handle, prepareProjectGitRetention(input))
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(readProjectGitRetention(handle, input.operationId)).toEqual(before);
});
it('retires pending input permanently while a new original operation can progress', async () => {
  const { handle, input } = await fixture();
  const prepared = prepareProjectGitRetention(input);
  await beginProjectGitRetention(handle, prepared);
  const command = retire(input);
  const result = await retireProjectGitRetention(handle, command);
  expect(await retireProjectGitRetention(handle, command)).toEqual({ ...result, replayed: true });
  const before = readProjectGitRetention(handle, input.operationId);
  await expect(
    settleProjectGitRetention(handle, prepared, input.preparedTransitionId, uuidv7())
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProjectGitRetention(handle, input.operationId)).toEqual(before);
  const second = next(input),
    nextPrepared = prepareProjectGitRetention(second);
  await beginProjectGitRetention(handle, nextPrepared);
  await settleProjectGitRetention(handle, nextPrepared, second.preparedTransitionId, uuidv7());
  expect(readProjectGitRetention(handle, input.operationId).value!.current.kind).toBe('retired');
});
it('rejects an intervening baseline selection while preserving both admitted original requests', async () => {
  const { handle, input } = await fixture();
  const second = next(input),
    firstPrepared = prepareProjectGitRetention(input),
    secondPrepared = prepareProjectGitRetention(second);
  await beginProjectGitRetention(handle, firstPrepared);
  await beginProjectGitRetention(handle, secondPrepared);
  await settleProjectGitRetention(handle, firstPrepared, input.preparedTransitionId, uuidv7());
  const before = handle.read((view) => view.all('SELECT * FROM git_retention_transitions'));
  await expect(
    settleProjectGitRetention(handle, secondPrepared, second.preparedTransitionId, uuidv7())
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(handle.read((view) => view.all('SELECT * FROM git_retention_transitions'))).toEqual(
    before
  );
  expect(readProjectGitRetention(handle, second.operationId).value!.current.kind).toBe('prepared');
});
it('replays the original selected result after later retirement without changing its selection', async () => {
  const { handle, input } = await fixture();
  const prepared = prepareProjectGitRetention(input),
    selectedId = uuidv7();
  await beginProjectGitRetention(handle, prepared);
  const result = await settleProjectGitRetention(
    handle,
    prepared,
    input.preparedTransitionId,
    selectedId
  );
  await retireProjectGitRetention(handle, retire(input, selectedId));
  const before = handle.read((view) => view.all('SELECT * FROM artifact_baseline_current'));
  expect(
    await settleProjectGitRetention(handle, prepared, input.preparedTransitionId, selectedId)
  ).toEqual({ ...result, replayed: true });
  expect(handle.read((view) => view.all('SELECT * FROM artifact_baseline_current'))).toEqual(
    before
  );
});
it('reads original intent without reapplying current authored refusal or publishing state', async () => {
  const { handle, input } = await fixture();
  await beginProjectGitRetention(handle, prepareProjectGitRetention(input));
  const before = readProjectGitRetention(handle, input.operationId);
  const guard = vi.spyOn(secretGuard, 'assertNoSecretsInPayload').mockImplementation(() => {
    throw new Error('Later authored policy');
  });
  expect(readProjectGitRetention(handle, input.operationId)).toEqual(before);
  expect(guard).not.toHaveBeenCalled();
});
it('refuses missing selected original rows without passive repair', async () => {
  const { handle, input, authority } = await fixture();
  await beginProjectGitRetention(handle, prepareProjectGitRetention(input));
  const db = new Database(projectDatabasePath(authority));
  try {
    db.exec('DROP TRIGGER git_retention_publications_no_delete');
    db.prepare('DELETE FROM git_retention_publications WHERE original_operation_id = ?').run(
      input.operationId
    );
    const counters = handle.read(() => null).counters;
    expect(() => readProjectGitRetention(handle, input.operationId)).toThrowError(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(handle.read(() => null).counters).toEqual(counters);
  } finally {
    db.close();
  }
});
it('validates exact checkpoint event number and phase before retaining an admission receipt', async () => {
  const { handle, input } = await fixture(true);
  input.publications.find((publication) => publication.role === 'checkpoint')!.checkpointNumber = 2;
  const before = handle.read((view) => view.all('SELECT * FROM operations'));
  await expect(
    beginProjectGitRetention(handle, prepareProjectGitRetention(input))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(handle.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
});
it('refuses stale artifact and execution expectations rather than refreshing them', async () => {
  const { handle, input } = await fixture();
  if (input.target.kind !== 'capture') throw new Error('capture fixture');
  input.target.expectedExecutionVersion!++;
  const counters = handle.read(() => null).counters;
  await expect(
    beginProjectGitRetention(handle, prepareProjectGitRetention(input))
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(handle.read(() => null).counters).toEqual(counters);
});
it('rolls back a failure after selecting the operation but before binding the baseline', async () => {
  const { handle, input } = await fixture();
  const prepared = prepareProjectGitRetention(input);
  await beginProjectGitRetention(handle, prepared);
  const before = readProjectGitRetention(handle, input.operationId);
  const original = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.startsWith('INSERT INTO artifact_baseline_current'))
      throw new Database.SqliteError('Fixture disk full', 'SQLITE_FULL');
    return original.call(this, sql);
  });
  await expect(
    settleProjectGitRetention(handle, prepared, input.preparedTransitionId, uuidv7())
  ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED', reason: 'disk-full' });
  vi.restoreAllMocks();
  expect(readProjectGitRetention(handle, input.operationId)).toEqual(before);
  expect(
    handle.read((view) => view.all('SELECT * FROM artifact_retention_selections')).value
  ).toEqual([]);
});
it('requires the fixed review aggregate instead of inferring publication meaning from row existence', async () => {
  const { handle, authority } = await fixture();
  const db = new Database(projectDatabasePath(authority));
  try {
    db.exec('BEGIN IMMEDIATE');
    db.pragma('defer_foreign_keys = ON');
    for (const [table, rows] of Object.entries(prior.rows).filter(
      ([table]) => table === 'operations' || table.startsWith('review')
    ))
      for (const row of rows) {
        const columns = Object.keys(row);
        db.prepare(
          'INSERT INTO ' +
            table +
            ' (' +
            columns.join(',') +
            ') VALUES (' +
            columns.map(() => '?').join(',') +
            ')'
        ).run(
          ...Object.values(row).map((value) =>
            value && typeof value === 'object' ? Buffer.from(value.blobHex, 'hex') : value
          )
        );
      }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  const target = handle.read((view) =>
    view.get(
      'SELECT s.review_id AS reviewId, s.membership_revision_id AS membershipRevisionId, s.base_revision_id AS baseRevisionId, s.floor_publication_id AS floorPublicationId, s.current_run_id AS runId, r.current_revision_id AS runRevisionId, s.membership_version AS membershipVersion, s.base_version AS baseVersion, s.floor_version AS floorVersion, s.run_selection_version AS runSelectionVersion FROM review_selections s LEFT JOIN review_runs r ON r.run_id = s.current_run_id LIMIT 1'
    )
  ).value as Omit<Extract<PrepareProjectGitRetention['target'], { kind: 'review' }>, 'kind'>;
  const input: PrepareProjectGitRetention = {
    operationId: uuidv7(),
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: authority.repositoryInstanceId,
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:00:00.000Z',
    target: { kind: 'review', ...target },
    publications: [
      {
        publicationId: uuidv7(),
        role: 'review-floor',
        targetId: target.floorPublicationId!,
        checkpointNumber: null,
        checkpointPhase: null,
        objectOid: 'a'.repeat(40),
        treeOid: 'b'.repeat(40),
      },
    ],
    secretAllow: [],
  };
  const prepared = prepareProjectGitRetention(input);
  const before = handle.read((view) => ({
    selections: view.all('SELECT * FROM review_selections'),
    operations: view.all('SELECT * FROM operations'),
  }));
  await expect(beginProjectGitRetention(handle, prepared)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  await expect(
    settleProjectGitRetention(handle, prepared, input.preparedTransitionId, uuidv7())
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    handle.read((view) => ({
      selections: view.all('SELECT * FROM review_selections'),
      operations: view.all('SELECT * FROM operations'),
    }))
  ).toEqual(before);
  expect(handle.read((view) => view.all('SELECT * FROM review_retention_bindings')).value).toEqual(
    []
  );
});

it('selects a new baseline only with the exact retained prior publication', async () => {
  const { handle, input } = await fixture();
  const first = prepareProjectGitRetention(input);
  await beginProjectGitRetention(handle, first);
  await settleProjectGitRetention(handle, first, input.preparedTransitionId, uuidv7());
  const following = next(input);
  if (following.target.kind !== 'capture') throw new Error('capture fixture');
  following.target.expectedBaselinePublicationId = input.publications[0]!.publicationId;
  const prepared = prepareProjectGitRetention(following);
  await beginProjectGitRetention(handle, prepared);
  await settleProjectGitRetention(handle, prepared, following.preparedTransitionId, uuidv7());
  expect(
    handle.read((view) => view.get('SELECT publication_id FROM artifact_baseline_current')).value
  ).toEqual({ publication_id: following.publications[0]!.publicationId });
  expect(readProjectGitRetention(handle, following.operationId).value!.input.target).toMatchObject({
    expectedBaselinePublicationId: input.publications[0]!.publicationId,
  });
});

it('lists only the exact target with an explicit bounded identifier order', async () => {
  const { handle, input } = await fixture();
  const second = next(input);
  await beginProjectGitRetention(handle, prepareProjectGitRetention(input));
  await beginProjectGitRetention(handle, prepareProjectGitRetention(second));
  if (input.target.kind !== 'capture') throw new Error('capture fixture');
  const all = listProjectGitRetentions(handle, {
    kind: 'capture',
    artifactId: input.target.artifactId,
  });
  expect(all.value.map((row) => row.input.operationId)).toEqual(
    [input.operationId, second.operationId].sort().reverse()
  );
  expect(
    listProjectGitRetentions(handle, { kind: 'capture', artifactId: input.target.artifactId }, 1)
      .value
  ).toEqual(all.value.slice(0, 1));
  expect(listProjectGitRetentions(handle, { kind: 'capture', artifactId: uuidv7() }).value).toEqual(
    []
  );
  expect(() =>
    listProjectGitRetentions(
      handle,
      {
        kind: 'capture',
        artifactId: input.target.kind === 'capture' ? input.target.artifactId : '',
      },
      101
    )
  ).toThrow();
});
it('refuses authored retirement content before any transition, receipt or counter change', async () => {
  const { handle, input } = await fixture();
  await beginProjectGitRetention(handle, prepareProjectGitRetention(input));
  const before = handle.read((view) => ({
    operations: view.all('SELECT * FROM operations'),
    transitions: view.all('SELECT * FROM git_retention_transitions'),
  }));
  const command = { ...retire(input), reason: 'ghp_' + '0'.repeat(37) };
  await expect(retireProjectGitRetention(handle, command)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(
    handle.read((view) => ({
      operations: view.all('SELECT * FROM operations'),
      transitions: view.all('SELECT * FROM git_retention_transitions'),
    }))
  ).toEqual(before);
});
it('rejects multiple baseline selections in one original request before admission', async () => {
  const { handle, input } = await fixture();
  input.publications.push({
    ...input.publications[0]!,
    publicationId: uuidv7(),
    targetId: uuidv7(),
  });
  const before = handle.read(() => null).counters;
  expect(() => prepareProjectGitRetention(input)).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(handle.read(() => null).counters).toEqual(before);
});

it('refuses a checkpoint publication when its retained snapshot is absent', async () => {
  const { handle, input } = await fixture(true, false);
  input.publications = input.publications.filter(
    (publication) => publication.role === 'checkpoint'
  );
  const before = handle.read((view) => view.all('SELECT * FROM operations'));
  await expect(
    beginProjectGitRetention(handle, prepareProjectGitRetention(input))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(handle.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
});
it('refuses a baseline publication when its original plan tree is absent', async () => {
  const { handle, input } = await fixture(false, false);
  const before = handle.read((view) => view.all('SELECT * FROM operations'));
  await expect(
    beginProjectGitRetention(handle, prepareProjectGitRetention(input))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(handle.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
});

it.each(['objectOid', 'treeOid', 'publicationId'] as const)(
  'refuses a checkpoint publication with a different original %s',
  async (field) => {
    const { handle, input } = await fixture(true);
    const checkpoint = input.publications.find((publication) => publication.role === 'checkpoint')!;
    checkpoint[field] = field === 'publicationId' ? uuidv7() : 'f'.repeat(40);
    const before = handle.read((view) => view.all('SELECT * FROM operations'));
    await expect(
      beginProjectGitRetention(handle, prepareProjectGitRetention(input))
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(handle.read((view) => view.all('SELECT * FROM operations'))).toEqual(before);
  }
);
it('keeps a retired selected baseline readable and usable as the next exact selection expectation', async () => {
  const { handle, input } = await fixture();
  const first = prepareProjectGitRetention(input);
  await beginProjectGitRetention(handle, first);
  const selected = uuidv7();
  await settleProjectGitRetention(handle, first, input.preparedTransitionId, selected);
  await retireProjectGitRetention(handle, retire(input, selected));
  const publicationId = input.publications[0]!.publicationId;
  expect(
    handle.read((view) => view.get('SELECT publication_id FROM artifact_baseline_current')).value
  ).toEqual({ publication_id: publicationId });
  expect(
    readProjectArtifact(handle, input.target.kind === 'capture' ? input.target.artifactId : '')
  ).not.toBeNull();
  const following = next(input);
  if (following.target.kind !== 'capture') throw new Error('capture fixture');
  following.target.expectedBaselinePublicationId = publicationId;
  const prepared = prepareProjectGitRetention(following);
  await beginProjectGitRetention(handle, prepared);
  await settleProjectGitRetention(handle, prepared, following.preparedTransitionId, uuidv7());
  expect(readProjectGitRetention(handle, input.operationId).value!.current.kind).toBe('retired');
  expect(
    handle.read((view) => view.get('SELECT publication_id FROM artifact_baseline_current')).value
  ).toEqual({ publication_id: following.publications[0]!.publicationId });
});

it.each(['prepared', 'retired'] as const)(
  'protects the original terminal identity of a %s publication from unrelated settlement',
  async (state) => {
    const { handle, input } = await fixture();
    const prepared = prepareProjectGitRetention(input);
    await beginProjectGitRetention(handle, prepared);
    if (state === 'retired') await retireProjectGitRetention(handle, retire(input));
    const before = handle.read((view) => ({
      operations: view.all('SELECT * FROM operations ORDER BY operation_id'),
      retention: view.all('SELECT * FROM git_retention_transitions ORDER BY transition_id'),
      current: view.all('SELECT * FROM git_retention_current'),
    }));
    const callback = vi.fn((tx: ProjectSettlement) => {
      tx.run('INSERT INTO operation_probes VALUES (?)', 'unrelated write');
      return { accepted: true };
    });
    const raw = new Database(handle.databasePath);
    raw.exec('CREATE TABLE operation_probes (value TEXT) STRICT');
    raw.close();
    await expect(
      runProjectOperation(
        handle,
        {
          operationId: input.operationId,
          kind: 'usage.record',
          target: null,
          payload: { body: 'unrelated' },
          expectedState: null,
          intentChange: false,
        },
        callback
      )
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(
      handle.read((view) => ({
        operations: view.all('SELECT * FROM operations ORDER BY operation_id'),
        retention: view.all('SELECT * FROM git_retention_transitions ORDER BY transition_id'),
        current: view.all('SELECT * FROM git_retention_current'),
      }))
    ).toEqual(before);
    expect(handle.read((view) => view.all('SELECT * FROM operation_probes')).value).toEqual([]);
    if (state === 'prepared') {
      const selectedId = uuidv7();
      const result = await settleProjectGitRetention(
        handle,
        prepared,
        input.preparedTransitionId,
        selectedId
      );
      expect(result.value.state).toBe('selected');
      expect(
        await settleProjectGitRetention(handle, prepared, input.preparedTransitionId, selectedId)
      ).toEqual({ ...result, replayed: true });
    }
  }
);

it('refuses a retained selection whose original receipt is missing', async () => {
  const { handle, input } = await fixture();
  const prepared = prepareProjectGitRetention(input);
  await beginProjectGitRetention(handle, prepared);
  await settleProjectGitRetention(handle, prepared, input.preparedTransitionId, uuidv7());
  const raw = new Database(handle.databasePath);
  const trigger = raw
    .prepare("SELECT sql FROM sqlite_schema WHERE name = 'operations_no_delete'")
    .get() as { sql: string };
  raw.pragma('foreign_keys = OFF');
  raw.exec('DROP TRIGGER operations_no_delete');
  raw.prepare('DELETE FROM operations WHERE operation_id = ?').run(input.operationId);
  raw.exec(trigger.sql);
  raw.close();
  const before = handle.read((view) => view.all('SELECT * FROM operations ORDER BY operation_id'));
  const callback = vi.fn(() => null);
  await expect(
    runProjectOperation(
      handle,
      {
        operationId: input.operationId,
        kind: 'usage.record',
        target: null,
        payload: null,
        expectedState: null,
        intentChange: false,
      },
      callback
    )
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(callback).not.toHaveBeenCalled();
  expect(handle.read((view) => view.all('SELECT * FROM operations ORDER BY operation_id'))).toEqual(
    before
  );
});
