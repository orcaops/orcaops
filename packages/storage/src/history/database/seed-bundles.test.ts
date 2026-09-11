import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  prepareImportedProjectSeedBundle,
  prepareProjectSeedBundle,
  type PrepareProjectSeedBundle,
  type SeedBundleSource,
} from './seed-bundle-input.js';
import { publishProjectSeedBundle, readProjectSeedBundle } from './seed-bundles.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-seed-bundle-')),
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
const at = '2026-09-05T00:00:00.000Z';
function source(key: string, value: unknown): SeedBundleSource {
  return {
    sourceId: uuidv7(),
    sourceIdentity: 'original-source',
    sourceLocation: key,
    sourceRevisionId: 'original-revision',
    sourceOperationId: 'original-operation',
    key,
    bytes: Buffer.from(typeof value === 'string' ? value : '  ' + JSON.stringify(value) + '\n'),
  };
}
function enrichment(changes: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    cluster_key: 'cluster',
    options_hash: 'original-options',
    used_pr_context: false,
    label: 'Original label',
    task: 'Original task',
    steps: [{ label: 'Change', text: 'Original change' }],
    checkpoint_summaries: ['Original summary'],
    outcome: 'Original outcome',
    decisions: [{ decision: 'Original decision', reason: 'Original reason' }],
    ...changes,
  };
}
function request(): PrepareProjectSeedBundle {
  const manifest = {
    schema_version: 2,
    options_hash: 'original-options',
    bundles: [
      {
        filename: 'cluster.md',
        artifact_id: uuidv7(),
        cluster_key: 'cluster',
        kind: 'run',
        label: 'Original cluster',
        date: at,
        commit_count: 1,
        checkpoint_count: 1,
        warnings: [],
        nomination_count: 0,
        distinct_task_count: 1,
      },
    ],
  };
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    expectedRevision: null,
    secretAllow: [],
    identity: { kind: 'pending' },
    sources: [
      source('manifest', manifest),
      source('bundle:cluster.md', '# Original input\n'),
      source('authored:matching.json', enrichment()),
      source('authored:unmatched.json', enrichment({ cluster_key: 'unknown-cluster' })),
    ],
  };
}
function stored(handle: ProjectDatabase) {
  return handle.read((view) => ({
    operations: view.all('SELECT operation_id, result_json FROM operations ORDER BY operation_id'),
    sources: view.all(
      'SELECT source_id,bundle_key,hex(record_bytes) AS bytes FROM seed_bundle_sources ORDER BY source_id'
    ),
    revisions: view.all('SELECT * FROM seed_bundle_revisions ORDER BY revision_id'),
    selections: view.all('SELECT * FROM seed_bundle_selection ORDER BY bundle_key'),
    artifacts: view.all('SELECT * FROM artifacts'),
  }));
}
it('retains exact pending members and unmatched authoring without artifact enrichment or adoption', async () => {
  const { handle, authority } = await fixture();
  const input = request();
  expect(readProjectSeedBundle(handle, input.identity)).toBeNull();
  const first = await publishProjectSeedBundle(handle, prepareProjectSeedBundle(input));
  expect(first.counters).toEqual({ writeSequence: 2, intentChangeCounter: 0 });
  const read = readProjectSeedBundle(handle, input.identity)!;
  expect(read.sources.map((item) => item.bytes)).toEqual(input.sources.map((item) => item.bytes));
  expect(read.identity).toEqual({ kind: 'pending' });
  expect(read.authored.map((item) => [item.selection, item.acceptance])).toEqual([
    ['matching', 'not-established'],
    ['unmatched', 'not-established'],
  ]);
  expect(stored(handle).value.artifacts).toEqual([]);
  const readonly = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(readonly);
  expect(readProjectSeedBundle(readonly, input.identity)?.revision).toEqual(first.value.revision);
});
it('retains rejected duplicate authoring and exact historical bundle revisions', async () => {
  const { handle } = await fixture();
  const input = request();
  const first = await publishProjectSeedBundle(handle, prepareProjectSeedBundle(input));
  const changed = {
    ...input,
    operationId: uuidv7(),
    revisionId: uuidv7(),
    expectedRevision: first.value.revision,
    sources: [
      ...input.sources,
      source('authored:rejected.json', enrichment({ options_hash: 'other', steps: [] })),
    ],
  };
  const second = await publishProjectSeedBundle(handle, prepareProjectSeedBundle(changed));
  const current = readProjectSeedBundle(handle, input.identity)!;
  expect(current.authored[0]?.reasons).toEqual(['duplicate-cluster']);
  expect(current.authored[2]?.reasons).toEqual([
    'duplicate-cluster',
    'options-mismatch',
    'checkpoint-count-mismatch',
  ]);
  expect(
    readProjectSeedBundle(handle, input.identity, first.value.revision)?.authored[0]?.selection
  ).toBe('matching');
  expect(current.revision).toEqual(second.value.revision);
  expect(stored(handle).value.sources).toHaveLength(5);
  expect(
    handle.read((view) => view.get('SELECT count(*) AS n FROM seed_bundle_members')).value
  ).toEqual({ n: 9 });
  expect(second.counters.intentChangeCounter).toBe(0);
});
it('returns original replay after later bundle changes and rejects changed operation targets', async () => {
  const { handle } = await fixture();
  const input = request();
  const prepared = prepareProjectSeedBundle(input);
  const first = await publishProjectSeedBundle(handle, prepared);
  await publishProjectSeedBundle(
    handle,
    prepareProjectSeedBundle({
      ...input,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      expectedRevision: first.value.revision,
    })
  );
  const before = stored(handle);
  expect(await publishProjectSeedBundle(handle, prepared)).toEqual({ ...first, replayed: true });
  await expect(
    publishProjectSeedBundle(handle, prepareProjectSeedBundle({ ...input, revisionId: uuidv7() }))
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    publishProjectSeedBundle(handle, prepareProjectSeedBundle(request()))
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(stored(handle)).toEqual(before);
});
it('keeps accepted artifact associations exact and prevents original occurrence retargeting', async () => {
  const { handle } = await fixture();
  const artifactId = uuidv7();
  const input = {
    ...request(),
    identity: { kind: 'accepted' as const, artifactId },
    sources: [
      source('enrichment', { ...enrichment(), enriched_at: at }),
      source('authored', enrichment()),
    ],
  };
  const first = await publishProjectSeedBundle(handle, prepareProjectSeedBundle(input));
  expect(readProjectSeedBundle(handle, input.identity)?.enrichment?.enriched_at).toBe(at);
  expect(first.counters.intentChangeCounter).toBe(0);
  const before = stored(handle);
  const otherIdentity = { kind: 'accepted' as const, artifactId: uuidv7() };
  await expect(
    publishProjectSeedBundle(
      handle,
      prepareProjectSeedBundle({
        ...input,
        operationId: uuidv7(),
        revisionId: uuidv7(),
        identity: otherIdentity,
      })
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(() => readProjectSeedBundle(handle, otherIdentity, first.value.revision)).toThrow(
    expect.objectContaining({ code: 'HISTORY_MISSING' })
  );
  expect(stored(handle)).toEqual(before);
});
it.each(['seed_bundle_details', 'seed_bundle_entries', 'seed_bundle_authoring'])(
  'refuses new writes over missing %s while retaining original reads and replay',
  async (table) => {
    const { handle, file } = await fixture();
    const input = request();
    const prepared = prepareProjectSeedBundle(input);
    const first = await publishProjectSeedBundle(handle, prepared);
    const original = readProjectSeedBundle(handle, input.identity);
    const database = new Database(file);
    database.exec(`DELETE FROM ${table} WHERE rowid=(SELECT rowid FROM ${table} LIMIT 1)`);
    database.close();
    const before = stored(handle);
    expect(readProjectSeedBundle(handle, input.identity)).toEqual(original);
    await expect(
      publishProjectSeedBundle(
        handle,
        prepareProjectSeedBundle({
          ...input,
          operationId: uuidv7(),
          revisionId: uuidv7(),
          expectedRevision: first.value.revision,
        })
      )
    ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(await publishProjectSeedBundle(handle, prepared)).toEqual({ ...first, replayed: true });
    expect(stored(handle)).toEqual(before);
  }
);
it('refuses missing current bundle selection while preserving an explicit original revision', async () => {
  const { handle, file } = await fixture();
  const input = request();
  const first = await publishProjectSeedBundle(handle, prepareProjectSeedBundle(input));
  const database = new Database(file);
  const trigger = database
    .prepare("SELECT sql FROM sqlite_schema WHERE name='seed_bundle_selection_no_delete'")
    .get() as { sql: string };
  database.exec('DROP TRIGGER seed_bundle_selection_no_delete; DELETE FROM seed_bundle_selection');
  database.exec(trigger.sql);
  database.close();
  expect(() => readProjectSeedBundle(handle, input.identity)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(readProjectSeedBundle(handle, input.identity, first.value.revision)?.revision).toEqual(
    first.value.revision
  );
});
it('rolls back source, revision and lookup insertion after a terminal statement failure', async () => {
  const { handle, file } = await fixture();
  const database = new Database(file);
  database.exec(
    "CREATE TRIGGER refuse_bundle_entries BEFORE INSERT ON seed_bundle_entries BEGIN SELECT RAISE(ABORT, 'fixture constraint'); END"
  );
  database.close();
  const before = stored(handle);
  await expect(
    publishProjectSeedBundle(handle, prepareProjectSeedBundle(request()))
  ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED', reason: 'constraint' });
  expect(stored(handle)).toEqual(before);
});
it('rejects cancellation and historical preparation without any receipt or state change', async () => {
  const { handle } = await fixture();
  const input = request();
  const before = stored(handle);
  const controller = new AbortController();
  controller.abort();
  await expect(
    publishProjectSeedBundle(handle, prepareProjectSeedBundle(input), { signal: controller.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(
    publishProjectSeedBundle(
      handle,
      prepareImportedProjectSeedBundle({
        ...input,
        sourceManifestIdentity: 'original-manifest',
      }) as never
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(stored(handle)).toEqual(before);
});
it('preserves explicitly allowed original bytes and refuses changed immutable source content', async () => {
  const { handle } = await fixture();
  const input = request();
  const token = 'ghp_' + 'A'.repeat(36);
  const sources = input.sources.map((item) =>
    item.key === 'bundle:cluster.md'
      ? { ...item, bytes: Buffer.from(`# Original\n${token}`) }
      : item
  );
  const first = await publishProjectSeedBundle(
    handle,
    prepareProjectSeedBundle({ ...input, sources, secretAllow: [token] })
  );
  expect(readProjectSeedBundle(handle, input.identity)?.sources[1]?.bytes).toEqual(
    sources[1]!.bytes
  );
  const before = stored(handle);
  await expect(
    publishProjectSeedBundle(
      handle,
      prepareProjectSeedBundle({
        ...input,
        operationId: uuidv7(),
        revisionId: uuidv7(),
        expectedRevision: first.value.revision,
      })
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(stored(handle)).toEqual(before);
});
