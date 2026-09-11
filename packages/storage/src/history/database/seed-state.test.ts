import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  prepareImportedProjectSeedState,
  prepareProjectSeedState,
  type PrepareProjectSeedState,
} from './seed-state-input.js';
import {
  publishProjectSeedState,
  readProjectSeedClusters,
  readProjectSeedJobs,
  readProjectSeedState,
} from './seed-state.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-seed-state-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const file = projectDatabasePath(authority);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
  });
  handles.push(handle);
  return { handle, authority, file };
}
function request(pending = false): PrepareProjectSeedState {
  const at = '2026-09-05T00:00:00.000Z';
  const nonce = 'a'.repeat(32);
  const values = {
    precious: {
      schema_version: 1,
      install_nonce: nonce,
      pr_context: false,
      pending_importance: pending,
      commit_graph_hint_shown: false,
      discovery_areas: { src: { declined_at: null }, tests: {} },
      updated_at: at,
    },
    journal: {
      schema_version: 2,
      install_nonce: nonce,
      options_hash: 'original',
      updated_at: at,
      clusters: {
        one: { artifact_id: 'original-one', status: 'writing' },
        two: { artifact_id: 'original-two', status: 'failed', error: 'Original error' },
      },
      jobs: {
        'original-job': {
          kind: 'resume',
          started_at: at,
          budget: { max_commits: 20, selected_commits: 2 },
          skipped_covered: 0,
        },
      },
    },
  };
  const operationId = uuidv7();
  return {
    operationId,
    revisionId: uuidv7(),
    expectedRevision: null,
    secretAllow: [],
    sources: Object.entries(values).map(([kind, value]) => ({
      sourceId: uuidv7(),
      sourceIdentity: operationId,
      sourceLocation: `${kind}.json`,
      sourceRevisionId: 'original-revision',
      bytes: Buffer.from('  ' + JSON.stringify(value) + '\n'),
      kind: kind as 'precious' | 'journal',
    })),
  };
}
function stored(handle: ProjectDatabase) {
  return handle.read((view) => ({
    operations: view.all('SELECT operation_id, result_json FROM operations ORDER BY operation_id'),
    revisions: view.all('SELECT * FROM seed_state_revisions ORDER BY generation'),
    sources: view.all(
      'SELECT source_id,hex(record_bytes) AS bytes FROM seed_state_sources ORDER BY source_id'
    ),
    selection: view.all('SELECT * FROM seed_state_selection'),
  }));
}
it('publishes exact seed revisions and selected lookups with write-sequence-only changes', async () => {
  const { handle, authority } = await fixture();
  expect(readProjectSeedState(handle)).toBeNull();
  const input = request();
  const first = await publishProjectSeedState(handle, prepareProjectSeedState(input));
  expect(first.counters).toEqual({ writeSequence: 2, intentChangeCounter: 0 });
  const state = readProjectSeedState(handle)!;
  expect(state.revision).toEqual(first.value.revision);
  expect(state.sources.map((source) => source.bytes)).toEqual(
    input.sources.map((source) => source.bytes)
  );
  expect(state.precious?.discovery_areas).toEqual({ src: { declined_at: null }, tests: {} });
  expect(readProjectSeedClusters(handle, { key: 'two' })?.clusters).toEqual({
    two: { artifact_id: 'original-two', status: 'failed', error: 'Original error' },
  });
  expect(readProjectSeedJobs(handle, { key: 'original-job' })?.jobs['original-job']).toMatchObject({
    kind: 'resume',
    skipped_covered: 0,
  });
  const second = await publishProjectSeedState(
    handle,
    prepareProjectSeedState({ ...request(true), expectedRevision: first.value.revision })
  );
  expect(second.counters).toEqual({ writeSequence: 3, intentChangeCounter: 0 });
  expect(readProjectSeedState(handle)?.precious?.pending_importance).toBe(true);
  expect(readProjectSeedState(handle, first.value.revision)?.precious?.pending_importance).toBe(
    false
  );
  const readonly = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(readonly);
  expect(readProjectSeedState(readonly)?.revision).toEqual(second.value.revision);
});
it('replays the original operation after later revisions without rerunning its state change', async () => {
  const { handle } = await fixture();
  const input = request();
  const prepared = prepareProjectSeedState(input);
  const first = await publishProjectSeedState(handle, prepared);
  await publishProjectSeedState(
    handle,
    prepareProjectSeedState({ ...request(true), expectedRevision: first.value.revision })
  );
  const before = stored(handle);
  expect(await publishProjectSeedState(handle, prepared)).toEqual({ ...first, replayed: true });
  expect(stored(handle)).toEqual(before);
  await expect(
    publishProjectSeedState(handle, prepareProjectSeedState({ ...input, revisionId: uuidv7() }))
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(stored(handle)).toEqual(before);
});
it('rejects stale context and changed immutable occurrence identities without new receipts', async () => {
  const { handle } = await fixture();
  const input = request();
  const first = await publishProjectSeedState(handle, prepareProjectSeedState(input));
  const before = stored(handle);
  await expect(
    publishProjectSeedState(handle, prepareProjectSeedState(request(true)))
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  const changed = request(true);
  await expect(
    publishProjectSeedState(
      handle,
      prepareProjectSeedState({
        ...changed,
        expectedRevision: first.value.revision,
        sources: changed.sources.map((source, index) => ({
          ...source,
          sourceId: input.sources[index]!.sourceId,
        })),
      })
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(stored(handle)).toEqual(before);
});
it('carries original source occurrences across revisions without copying authoritative bytes', async () => {
  const { handle } = await fixture();
  const input = request();
  const first = await publishProjectSeedState(handle, prepareProjectSeedState(input));
  const second = await publishProjectSeedState(
    handle,
    prepareProjectSeedState({
      ...input,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      expectedRevision: first.value.revision,
    })
  );
  expect(stored(handle).value.sources).toHaveLength(2);
  expect(readProjectSeedState(handle, first.value.revision)?.sources).toEqual(
    readProjectSeedState(handle, second.value.revision)?.sources
  );
  expect(
    handle.read((view) => view.get('SELECT count(*) AS n FROM seed_state_members')).value
  ).toEqual({ n: 4 });
});
it.each(['seed_clusters', 'seed_jobs', 'seed_discovery_areas', 'seed_state_details'])(
  'refuses incomplete %s lookups while retaining exact original access and original replay',
  async (table) => {
    const { handle, file } = await fixture();
    const input = request();
    const prepared = prepareProjectSeedState(input);
    const first = await publishProjectSeedState(handle, prepared);
    const original = readProjectSeedState(handle)!;
    const database = new Database(file);
    database.exec(`DELETE FROM ${table} WHERE rowid=(SELECT rowid FROM ${table} LIMIT 1)`);
    database.close();
    const before = stored(handle);
    expect(() => readProjectSeedClusters(handle)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(() => readProjectSeedJobs(handle)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(readProjectSeedState(handle)).toEqual(original);
    await expect(
      publishProjectSeedState(
        handle,
        prepareProjectSeedState({ ...request(true), expectedRevision: first.value.revision })
      )
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(await publishProjectSeedState(handle, prepared)).toEqual({ ...first, replayed: true });
    expect(stored(handle)).toEqual(before);
  }
);
it('never turns missing current selection into empty seed state', async () => {
  const { handle, file } = await fixture();
  const first = await publishProjectSeedState(handle, prepareProjectSeedState(request()));
  const database = new Database(file);
  const trigger = database
    .prepare("SELECT sql FROM sqlite_schema WHERE name='seed_state_selection_no_delete'")
    .get() as { sql: string };
  database.exec('DROP TRIGGER seed_state_selection_no_delete; DELETE FROM seed_state_selection');
  database.exec(trigger.sql);
  database.close();
  expect(() => readProjectSeedState(handle)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(readProjectSeedState(handle, first.value.revision)?.revision).toEqual(
    first.value.revision
  );
});
it('rolls back all seed rows after a terminal statement failure', async () => {
  const { handle, file } = await fixture();
  const database = new Database(file);
  database.exec(
    "CREATE TRIGGER refuse_seed_details BEFORE INSERT ON seed_state_details BEGIN SELECT RAISE(ABORT, 'fixture constraint'); END"
  );
  database.close();
  const before = stored(handle);
  await expect(
    publishProjectSeedState(handle, prepareProjectSeedState(request()))
  ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED', reason: 'constraint' });
  expect(stored(handle)).toEqual(before);
});
it('refuses cancellation and historical preparation before any authoritative change', async () => {
  const { handle } = await fixture();
  const input = request();
  const before = stored(handle);
  const controller = new AbortController();
  controller.abort();
  await expect(
    publishProjectSeedState(handle, prepareProjectSeedState(input), { signal: controller.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(
    publishProjectSeedState(
      handle,
      prepareImportedProjectSeedState({
        ...input,
        sourceManifestIdentity: 'original-manifest',
      }) as never
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(stored(handle)).toEqual(before);
});
it('serves indexed cluster and job lookups without hydrating original source bytes', async () => {
  const { handle } = await fixture();
  await publishProjectSeedState(handle, prepareProjectSeedState(request()));
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.includes('record_bytes')) throw new Error('Original byte hydration was not requested');
    return prepare.call(this, sql);
  });
  expect(readProjectSeedClusters(handle, { key: 'one' })?.clusters).toEqual({
    one: { artifact_id: 'original-one', status: 'writing' },
  });
  expect(Object.keys(readProjectSeedJobs(handle)?.jobs ?? {})).toEqual(['original-job']);
});
it('reads explicitly allowed original authored bytes without applying refusal again', async () => {
  const { handle } = await fixture();
  const input = request();
  const token = 'ghp_' + 'A'.repeat(36);
  const original = input.sources[1]!;
  const body = JSON.parse(Buffer.from(original.bytes).toString('utf8'));
  body.options_hash = token;
  const bytes = Buffer.from(JSON.stringify(body));
  const sources = [input.sources[0]!, { ...original, bytes }];
  const first = await publishProjectSeedState(
    handle,
    prepareProjectSeedState({ ...input, sources, secretAllow: [token] })
  );
  expect(readProjectSeedState(handle)?.sources[1]?.bytes).toEqual(bytes);
  expect(readProjectSeedState(handle)?.journal?.options_hash).toBe(token);
  expect(readProjectSeedState(handle)?.counters).toEqual(first.counters);
});
