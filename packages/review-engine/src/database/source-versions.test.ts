import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import * as store from '@orcaops/storage/history/database';

import { readDatabaseReviewSourceVersions } from './source-versions.js';
import { appendProjectExecutionCapture } from '../../../storage/dist/history/database/execution-capture.js';
import { transitionProjectExecution } from '../../../storage/dist/history/database/execution-transitions.js';

vi.mock('@orcaops/storage/history/database', async (original) => ({
  ...(await original<typeof store>()),
}));
const Database = createRequire(new URL('../../../storage/package.json', import.meta.url))(
  'better-sqlite3'
) as new (file: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown };
  close(): void;
};
const roots: string[] = [];
const handles: store.ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(execution = false) {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'review-source-versions-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    repositoryInstanceId: uuidv7(),
    storeInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(store.projectDatabasePath(authority)), { recursive: true });
  const writer = await store.initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(writer);
  const saved = JSON.parse(
    await readFile(
      new URL(
        '../../../storage/src/history/database/fixtures/artifact-history.json',
        import.meta.url
      ),
      'utf8'
    )
  );
  const rows = saved.rows.artifact_events as Array<{
    artifact_id: string;
    record_bytes: { blobHex: string };
  }>;
  const artifactId = rows[0].artifact_id;
  const append = {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: null,
    eventBytes: Buffer.from(rows[0].record_bytes.blobHex, 'hex'),
    sidecarPayloads: [],
    secretAllow: [],
  };
  if (execution)
    await appendProjectExecutionCapture(writer, {
      ...append,
      execution: {
        kind: 'create',
        ts: '2026-06-01T00:00:00.000Z',
        context: {
          repository_instance_id: authority.repositoryInstanceId,
          worktree_id: uuidv7(),
          git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
        },
      },
    });
  else await store.appendProjectArtifactEvents(writer, append);
  return { authority, writer, artifactId, rows };
}
it('observes exact metadata revisions without changing counters or decoding narrative bodies', async () => {
  const f = await fixture();
  const before = await readDatabaseReviewSourceVersions({ authority: f.authority, branch: 'main' });
  expect(before.sourceObservation).toBe('metadata-only');
  expect(before.value.artifacts).toHaveLength(1);
  const raw = new Database(store.projectDatabasePath(f.authority));
  try {
    const trigger = raw
      .prepare("SELECT sql FROM sqlite_schema WHERE name='artifact_events_no_update'")
      .get() as { sql: string };
    raw.exec('DROP TRIGGER artifact_events_no_update');
    raw
      .prepare('UPDATE artifact_events SET record_bytes=? WHERE artifact_id=?')
      .run(Buffer.from('unparseable narrative'), f.artifactId);
    raw
      .prepare(
        `UPDATE artifact_query_metadata SET watch_json=?,
          details_json=json_object('historicalStepCount', json_extract(details_json,'$.historicalStepCount')),
          provenance_json=? WHERE artifact_id=?`
      )
      .run(
        JSON.stringify('unparseable watch'),
        JSON.stringify('unparseable provenance'),
        f.artifactId
      );
    raw.exec(trigger.sql);
  } finally {
    raw.close();
  }
  const selected = await readDatabaseReviewSourceVersions({
    authority: f.authority,
    branch: 'main',
  });
  expect(selected).toEqual(before);
  expect(f.writer.read(() => null).counters).toEqual(before.counters);
});
it.each([null, -1])(
  'refuses an invalid historical step count of %s without repairing it',
  async (count) => {
    const f = await fixture();
    const before = f.writer.read(() => null).counters;
    const raw = new Database(store.projectDatabasePath(f.authority));
    try {
      raw
        .prepare('UPDATE artifact_query_metadata SET details_json=? WHERE artifact_id=?')
        .run(JSON.stringify({ historicalStepCount: count }), f.artifactId);
      await expect(
        readDatabaseReviewSourceVersions({ authority: f.authority, branch: 'main' })
      ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
      expect(
        raw
          .prepare('SELECT details_json FROM artifact_query_metadata WHERE artifact_id=?')
          .get(f.artifactId)
      ).toEqual({ details_json: JSON.stringify({ historicalStepCount: count }) });
      expect(f.writer.read(() => null).counters).toEqual(before);
    } finally {
      raw.close();
    }
  }
);
it('changes on source append while unrelated operation receipts change only observed counters', async () => {
  const f = await fixture();
  const input = { authority: f.authority, branch: 'main' };
  const first = await readDatabaseReviewSourceVersions(input);
  await store.runProjectOperation(
    f.writer,
    {
      operationId: uuidv7(),
      kind: 'test.receipt',
      target: null,
      payload: null,
      expectedState: null,
      intentChange: false,
    },
    () => null
  );
  const receipt = await readDatabaseReviewSourceVersions(input);
  expect(receipt.digest).toBe(first.digest);
  expect(receipt.counters.writeSequence).toBe(first.counters.writeSequence + 1);
  const revision = store.readProjectArtifact(f.writer, f.artifactId)!.revision;
  await store.appendProjectArtifactEvents(f.writer, {
    operationId: uuidv7(),
    artifactId: f.artifactId,
    expectedRevision: revision,
    eventBytes: Buffer.from(f.rows[1].record_bytes.blobHex, 'hex'),
    sidecarPayloads: [],
    secretAllow: [],
  });
  const next = await readDatabaseReviewSourceVersions(input);
  expect(next.digest).not.toBe(first.digest);
  expect(next.value.artifacts[0].generation).toBe(revision.generation + 1);
  expect(next.value.artifacts[0].eventCount).toBe(revision.eventCount + 1);
  expect((await readDatabaseReviewSourceVersions({ ...input, branch: 'other' })).digest).not.toBe(
    next.digest
  );
});
it('refuses missing required metadata and preserves a usable existing handle', async () => {
  const f = await fixture();
  const raw = new Database(store.projectDatabasePath(f.authority));
  try {
    raw.prepare('DELETE FROM artifact_query_metadata WHERE artifact_id=?').run(f.artifactId);
  } finally {
    raw.close();
  }
  await expect(
    readDatabaseReviewSourceVersions({ authority: f.authority, branch: 'main' })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(f.writer.read(() => true).value).toBe(true);
});
it('freezes original request before opening and rejects invalid input without opening', async () => {
  const f = await fixture();
  const open = vi.spyOn(store, 'openProjectDatabase');
  await expect(
    readDatabaseReviewSourceVersions({ authority: f.authority, branch: ' ' })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(open).not.toHaveBeenCalled();
  const original = { authority: { ...f.authority }, branch: 'main' };
  const result = readDatabaseReviewSourceVersions(original);
  original.branch = 'mutated';
  original.authority.projectId = uuidv7();
  expect((await result).value).toMatchObject({
    authority: { projectId: f.authority.projectId },
    branch: 'main',
  });
  expect(open).toHaveBeenCalledTimes(1);
});

it('refuses missing expected history and mismatched store authority without initialization', async () => {
  const f = await fixture();
  const before = f.writer.read(() => null).counters;
  await expect(
    readDatabaseReviewSourceVersions({
      authority: { ...f.authority, storeInstanceId: uuidv7() },
      branch: 'main',
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  const missing = { ...f.authority, projectId: uuidv7() };
  await expect(
    readDatabaseReviewSourceVersions({ authority: missing, branch: 'main' })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(readFile(store.projectDatabasePath(missing))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(f.writer.read(() => null).counters).toEqual(before);
});

it('changes the source digest on an execution-only handoff without appending artifact bytes', async () => {
  const f = await fixture(true);
  const input = { authority: f.authority, branch: 'main' };
  const before = await readDatabaseReviewSourceVersions(input);
  const original = store.readProjectArtifact(f.writer, f.artifactId)!.revision;
  const execution = store.readProjectExecution(f.writer, f.artifactId)!;
  await transitionProjectExecution(f.writer, {
    operationId: uuidv7(),
    artifactId: f.artifactId,
    expectedRevision: original,
    action: 'handoff',
    target: {
      repository_instance_id: f.authority.repositoryInstanceId,
      worktree_id: uuidv7(),
      git_context: { branch: 'other', head_sha: 'b'.repeat(40) },
    },
    expectedBinding: execution.state.current_binding,
    expectedGeneration: execution.state.binding_generation,
    expectedVersion: execution.version,
    reason: 'Move execution to the selected worktree',
    ts: '2026-06-01T00:01:00.000Z',
    secretAllow: [],
  });
  const after = await readDatabaseReviewSourceVersions(input);
  expect(store.readProjectArtifact(f.writer, f.artifactId)!.revision).toEqual(original);
  expect(after.value.artifacts[0].executionVersion).toBe(
    before.value.artifacts[0].executionVersion! + 1
  );
  expect(after.value.artifacts[0].bindingGeneration).toBe(
    before.value.artifacts[0].bindingGeneration! + 1
  );
  expect(after.digest).not.toBe(before.digest);
});
