import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import * as inputs from './source-plan-input.js';
import type {
  SourcePlanLocatorInput,
  SourcePlanNamespace,
  SourcePlanRecordInput,
  SourcePlanSelection,
} from './source-plan-input.js';
import {
  publishProjectSourcePlanLocator,
  publishProjectSourcePlanRecord,
  readProjectSourcePlanRecordPublication,
} from './source-plan-publication.js';
import {
  readProjectApprovedSourcePlan,
  readProjectSourcePlanLocator,
  readProjectSourcePlanReview,
} from './source-plan-reader.js';
import { runProjectOperation } from './transactions.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const databases: Database.Database[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  handles.splice(0).forEach((h) => h.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'source-plan-publication-')),
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
    initializedAt: '2026-09-01T00:00:00Z',
    authorize() {},
  });
  handles.push(handle);
  const db = new Database(file);
  databases.push(db);
  db.pragma('foreign_keys=ON');
  return { db, handle, authority };
}
function namespace(): SourcePlanNamespace {
  return {
    namespaceId: uuidv7(),
    scopeKind: 'account',
    serverUrl: 'https://example.test',
    orgId: 'original organization',
    accountId: 'original account',
    originalNamespaceHash: null,
    originalLocatorHash: null,
  };
}
function input(
  kind: SourcePlanRecordInput['kind'] = 'approved',
  ns = namespace(),
  expectedSelection: SourcePlanSelection | null = null
): SourcePlanRecordInput {
  const body = 'Retain this exact source plan\n';
  const common = {
    schema_version: 1,
    external_id: 'plan:opaque / original',
    body,
    content_hash: digest(body),
    base_url: ns.serverUrl,
    org_id: ns.orgId,
    pulled_at: 'original pull time',
  };
  const value =
    kind === 'approved'
      ? { ...common, slug: 'original', version_number: 3, title: 'Original plan', source_ref: null }
      : {
          ...common,
          target: kind,
          version_id: kind === 'candidate' ? 'revision:opaque' : null,
          version_number: kind === 'candidate' ? 4 : null,
          proposal_id: kind === 'proposal' ? 'proposal:original' : null,
          base_version_number: null,
        };
  return {
    operationId: uuidv7(),
    recordId: uuidv7(),
    namespace: ns,
    kind,
    expectedSelection,
    recordBytes: Buffer.from(JSON.stringify(value, null, 2)),
  };
}
function changed(
  original: SourcePlanRecordInput,
  fields: Record<string, unknown>,
  expectedSelection = original.expectedSelection
): SourcePlanRecordInput {
  return {
    ...original,
    operationId: uuidv7(),
    recordId: uuidv7(),
    expectedSelection,
    recordBytes: Buffer.from(
      JSON.stringify(
        { ...JSON.parse(Buffer.from(original.recordBytes).toString('utf8')), ...fields },
        null,
        2
      )
    ),
  };
}
function locator(
  original: SourcePlanRecordInput,
  kind: SourcePlanLocatorInput['kind'] = 'path',
  expectedSelection: SourcePlanSelection | null = null
): SourcePlanLocatorInput {
  const value =
    kind === 'path'
      ? { real_path: '/original/plan.md', external_id: 'plan:opaque / original', version_number: 3 }
      : {
          fingerprint: 'a'.repeat(64),
          external_id: 'plan:opaque / original',
          unresolved: ['Zed', 'Ada', 'Zed'],
        };
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    namespace: original.namespace,
    kind,
    realPath: '/original/plan.md',
    approvedRecordId: kind === 'path' ? original.recordId : null,
    expectedSelection,
    recordBytes: Buffer.from(JSON.stringify(value, null, 2)),
  };
}
const options = { secretAllow: [] };
function rows(handle: ProjectDatabase) {
  return handle.read((view) => ({
    records: view.all(
      'SELECT record_id,namespace_id,kind,original_record_id,hex(record_bytes) AS record_bytes,publication_operation_id,import_provenance_id,record_sha256,external_id,approved_version,version_id,version_number,proposal_id,base_version_number,content_hash,pulled_at FROM source_plan_records ORDER BY record_id'
    ),
    locators: view.all(
      'SELECT revision_id,namespace_id,kind,hex(record_bytes) AS record_bytes,original_record_id,publication_operation_id,import_provenance_id,approved_record_id,record_sha256,real_path,path_hash,original_locator_hash,external_id,approved_version,fingerprint FROM source_plan_locator_revisions ORDER BY revision_id'
    ),
    operations: view.all('SELECT * FROM operations ORDER BY operation_id'),
    namespaces: view.all('SELECT * FROM source_plan_namespaces ORDER BY namespace_id'),
    approved: view.all(
      'SELECT * FROM source_plan_approved ORDER BY namespace_id,external_id,approved_version'
    ),
    reviews: view.all(
      'SELECT * FROM source_plan_review_current ORDER BY namespace_id,kind,subject_id'
    ),
    locatorSelection: view.all(
      'SELECT * FROM source_plan_locator_current ORDER BY namespace_id,kind,locator'
    ),
  }));
}
it('publishes exact approved bytes and replays the original result before authored preparation', async () => {
  const { handle } = await fixture();
  const original = input();
  const result = await publishProjectSourcePlanRecord(handle, original, options);
  const before = rows(handle);
  expect(result).toEqual({
    value: { recordId: original.recordId, selection: { recordId: original.recordId, version: 1 } },
    replayed: false,
    counters: { writeSequence: 2, intentChangeCounter: 0 },
  });
  vi.spyOn(inputs, 'prepareSourcePlanRecord').mockImplementation(() => {
    throw Error('authored preparation reran');
  });
  expect(await publishProjectSourcePlanRecord(handle, original, options)).toEqual({
    ...result,
    replayed: true,
  });
  expect(rows(handle)).toEqual(before);
  expect(
    readProjectApprovedSourcePlan(handle, {
      namespaceId: original.namespace.namespaceId,
      externalId: 'plan:opaque / original',
      approvedVersion: 3,
    })?.record.recordBase64
  ).toBe(Buffer.from(original.recordBytes).toString('base64'));
});
it('retains equal re-pull observation bytes and the first approved selection', async () => {
  const { handle } = await fixture();
  const original = input();
  await publishProjectSourcePlanRecord(handle, original, options);
  const next = changed(original, { pulled_at: 'later original observation' });
  const result = await publishProjectSourcePlanRecord(handle, next, options);
  expect(result.value).toEqual({
    recordId: next.recordId,
    selection: { recordId: original.recordId, version: 1 },
  });
  expect(result.counters).toEqual({ writeSequence: 3, intentChangeCounter: 0 });
  const records = handle.read((view) =>
    view.all<{ id: string; bytes: string }>(
      'SELECT record_id AS id,hex(record_bytes) AS bytes FROM source_plan_records'
    )
  ).value;
  expect(records).toEqual(
    expect.arrayContaining([
      {
        id: original.recordId,
        bytes: Buffer.from(original.recordBytes).toString('hex').toUpperCase(),
      },
      { id: next.recordId, bytes: Buffer.from(next.recordBytes).toString('hex').toUpperCase() },
    ])
  );
  expect(await publishProjectSourcePlanRecord(handle, next, options)).toEqual({
    ...result,
    replayed: true,
  });
});
it.each(['title', 'source_ref', 'slug', 'body'] as const)(
  'refuses changed approved %s without retaining a new row',
  async (field) => {
    const { handle } = await fixture();
    const original = input();
    await publishProjectSourcePlanRecord(handle, original, options);
    const before = rows(handle);
    const fields = {
      [field]: 'different approved fact',
      ...(field === 'body' ? { content_hash: digest('different approved fact') } : {}),
    };
    await expect(
      publishProjectSourcePlanRecord(handle, changed(original, fields), options)
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(rows(handle)).toEqual(before);
  }
);
it.each(['candidate', 'proposal'] as const)(
  'publishes and advances only the original %s expected selection',
  async (kind) => {
    const { handle } = await fixture();
    const original = input(kind);
    const first = await publishProjectSourcePlanRecord(handle, original, options);
    const next = changed(
      original,
      { pulled_at: 'next original observation' },
      first.value.selection
    );
    const second = await publishProjectSourcePlanRecord(handle, next, options);
    expect(second.value.selection).toEqual({ recordId: next.recordId, version: 2 });
    const before = rows(handle);
    expect(readProjectSourcePlanRecordPublication(handle, original)).toEqual(first.value);
    expect(rows(handle)).toEqual(before);
    await expect(
      publishProjectSourcePlanRecord(handle, changed(original, { pulled_at: 'stale' }), options)
    ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    expect(rows(handle)).toEqual(before);
    expect(await publishProjectSourcePlanRecord(handle, original, options)).toEqual({
      ...first,
      replayed: true,
    });
    expect(
      readProjectSourcePlanReview(handle, {
        namespaceId: original.namespace.namespaceId,
        kind,
        subjectId: kind === 'candidate' ? 'plan:opaque / original' : 'proposal:original',
      })?.record.recordId
    ).toBe(next.recordId);
  }
);
it('refuses retargeting an original proposal to another plan', async () => {
  const { handle } = await fixture();
  const original = input('proposal');
  const first = await publishProjectSourcePlanRecord(handle, original, options);
  const before = rows(handle);
  await expect(
    publishProjectSourcePlanRecord(
      handle,
      changed(original, { external_id: 'another plan' }, first.value.selection),
      options
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rows(handle)).toEqual(before);
});
it.each(['path', 'upload'] as const)(
  'publishes, advances and replays original %s locator ownership',
  async (kind) => {
    const { handle } = await fixture();
    const plan = input();
    await publishProjectSourcePlanRecord(handle, plan, options);
    const original = locator(plan, kind);
    const first = await publishProjectSourcePlanLocator(handle, original, options);
    const next = {
      ...original,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      expectedSelection: first.value.selection,
    };
    const second = await publishProjectSourcePlanLocator(handle, next, options);
    expect(second.value.selection).toEqual({ recordId: next.revisionId, version: 2 });
    const before = rows(handle);
    vi.spyOn(inputs, 'prepareSourcePlanLocator').mockImplementation(() => {
      throw Error('authored locator reran');
    });
    expect(await publishProjectSourcePlanLocator(handle, original, options)).toEqual({
      ...first,
      replayed: true,
    });
    expect(rows(handle)).toEqual(before);
    expect(
      readProjectSourcePlanLocator(handle, {
        namespaceId: plan.namespace.namespaceId,
        kind,
        realPath: original.realPath,
      })?.record.revisionId
    ).toBe(next.revisionId);
  }
);
it('refuses missing or wrong approved ownership for path publication', async () => {
  const { handle } = await fixture();
  const plan = input();
  const original = locator(plan);
  const before = rows(handle);
  await expect(publishProjectSourcePlanLocator(handle, original, options)).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(rows(handle)).toEqual(before);
  await publishProjectSourcePlanRecord(handle, plan, options);
  await expect(
    publishProjectSourcePlanLocator(handle, { ...original, approvedRecordId: uuidv7() }, options)
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
});
it('refuses changed original operation input and cross-family operation ownership', async () => {
  const { handle } = await fixture();
  const original = input();
  await publishProjectSourcePlanRecord(handle, original, options);
  const before = rows(handle);
  const different = changed(original, { pulled_at: 'changed retry' });
  await expect(
    publishProjectSourcePlanRecord(
      handle,
      { ...different, operationId: original.operationId, recordId: original.recordId },
      options
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    publishProjectSourcePlanLocator(
      handle,
      { ...locator(original, 'upload'), operationId: original.operationId },
      options
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rows(handle)).toEqual(before);
});
it('keeps exact original bytes out of immutable operation payloads', async () => {
  const { handle } = await fixture();
  const original = input();
  await publishProjectSourcePlanRecord(handle, original, options);
  const payload = handle.read((view) =>
    view.get<{ payload: string }>(
      'SELECT payload_json AS payload FROM operations WHERE operation_id=?',
      original.operationId
    )
  ).value!;
  expect(JSON.parse(payload.payload)).toEqual({
    recordId: original.recordId,
    recordSha256: digest(original.recordBytes),
  });
  expect(payload.payload).not.toContain('Retain this exact source plan');
});
it('refuses new secret-bearing bytes without rows or counters', async () => {
  const { handle } = await fixture();
  const original = input();
  const token = 'ghp_' + 'A'.repeat(36);
  const secret = changed(original, { body: token, content_hash: digest(token) });
  const before = rows(handle);
  await expect(publishProjectSourcePlanRecord(handle, secret, options)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(rows(handle)).toEqual(before);
});
it('replays previously allowed original bytes with no current allowance', async () => {
  const { handle } = await fixture();
  const token = 'ghp_' + 'A'.repeat(36);
  const original = changed(input(), { body: token, content_hash: digest(token) });
  const first = await publishProjectSourcePlanRecord(handle, original, { secretAllow: [token] });
  const before = rows(handle);
  expect(await publishProjectSourcePlanRecord(handle, original, options)).toEqual({
    ...first,
    replayed: true,
  });
  expect(rows(handle)).toEqual(before);
});
it('guards genuine writers before invoking supplied methods', async () => {
  const read = vi.fn();
  const fake = { read } as unknown as ProjectDatabase;
  const plan = input();
  await expect(publishProjectSourcePlanRecord(fake, plan, options)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  await expect(
    publishProjectSourcePlanLocator(fake, locator(plan, 'upload'), options)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(read).not.toHaveBeenCalled();
});
it('serializes two same-operation publications and returns one original receipt', async () => {
  const { db, handle, authority } = await fixture();
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  const original = input();
  db.exec('BEGIN IMMEDIATE');
  const waiting = new Set<string>();
  function wait(name: string) {
    waiting.add(name);
    if (waiting.size === 2 && db.inTransaction) db.exec('ROLLBACK');
  }
  const results = await Promise.all([
    publishProjectSourcePlanRecord(handle, original, {
      ...options,
      onWait() {
        wait('first');
      },
    }),
    publishProjectSourcePlanRecord(other, original, {
      ...options,
      onWait() {
        wait('second');
      },
    }),
  ]);
  expect(waiting.size).toBe(2);
  expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
  expect(results[0]!.value).toEqual(results[1]!.value);
  expect(rows(handle).value.records).toHaveLength(1);
});
it('cancels SQLite admission and preserves original input against caller mutation', async () => {
  const { db, handle } = await fixture();
  const original = input();
  const expected = structuredClone(original);
  const controller = new AbortController();
  db.exec('BEGIN IMMEDIATE');
  let observed = false;
  const result = publishProjectSourcePlanRecord(handle, original, {
    secretAllow: [],
    signal: controller.signal,
    onWait() {
      observed = true;
      original.recordId = uuidv7();
      original.recordBytes.fill(0);
      controller.abort();
    },
  });
  await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
  db.exec('ROLLBACK');
  expect(observed).toBe(true);
  expect(rows(handle).value.records).toEqual([]);
  expect((await publishProjectSourcePlanRecord(handle, expected, options)).value.recordId).toBe(
    expected.recordId
  );
});
it('rejects an operation identity already owned by a different domain', async () => {
  const { handle } = await fixture();
  const original = input();
  await runProjectOperation(
    handle,
    {
      operationId: original.operationId,
      kind: 'unrelated.domain',
      target: {},
      payload: {},
      expectedState: null,
      intentChange: false,
    },
    () => ({ retained: true })
  );
  const before = rows(handle);
  await expect(publishProjectSourcePlanRecord(handle, original, options)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(rows(handle)).toEqual(before);
});

it('commits the detached original input after admission waiting despite caller mutation', async () => {
  const { db, handle } = await fixture();
  const original = input();
  const expected = structuredClone(original);
  db.exec('BEGIN IMMEDIATE');
  const result = await publishProjectSourcePlanRecord(handle, original, {
    secretAllow: [],
    onWait() {
      original.recordId = uuidv7();
      original.recordBytes.fill(0);
      original.namespace.accountId = 'changed';
      db.exec('ROLLBACK');
    },
  });
  expect(result.value.recordId).toBe(expected.recordId);
  expect(
    readProjectApprovedSourcePlan(handle, {
      namespaceId: expected.namespace.namespaceId,
      externalId: 'plan:opaque / original',
      approvedVersion: 3,
    })?.record.recordBase64
  ).toBe(Buffer.from(expected.recordBytes).toString('base64'));
});
it('refuses historical unknown namespaces rather than adopting the current account', async () => {
  const { handle } = await fixture();
  const original = input();
  const unknown = {
    ...original,
    namespace: {
      namespaceId: uuidv7(),
      scopeKind: 'organization_observation' as const,
      serverUrl: 'https://example.test',
      orgId: 'original organization',
      accountId: null,
      originalNamespaceHash: digest('https://example.test|original organization'),
      originalLocatorHash: null,
    },
  };
  const before = rows(handle);
  await expect(publishProjectSourcePlanRecord(handle, unknown, options)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(rows(handle)).toEqual(before);
});
it('rolls back original rows, namespace and receipt together when selection insertion fails', async () => {
  const { db, handle } = await fixture();
  const original = input();
  db.exec(
    "CREATE TRIGGER refuse_source_selection BEFORE INSERT ON source_plan_approved BEGIN SELECT RAISE(ABORT,'fixture selection refusal'); END"
  );
  const before = rows(handle);
  await expect(publishProjectSourcePlanRecord(handle, original, options)).rejects.toMatchObject({
    code: 'TRANSACTION_FAILED',
    reason: 'constraint',
  });
  expect(rows(handle)).toEqual(before);
  db.exec('DROP TRIGGER refuse_source_selection');
  expect((await publishProjectSourcePlanRecord(handle, original, options)).value.recordId).toBe(
    original.recordId
  );
});
it('refuses stale locator expectation and changed same-operation bytes', async () => {
  const { handle } = await fixture();
  const plan = input();
  await publishProjectSourcePlanRecord(handle, plan, options);
  const original = locator(plan, 'upload');
  await publishProjectSourcePlanLocator(handle, original, options);
  const before = rows(handle);
  await expect(
    publishProjectSourcePlanLocator(
      handle,
      { ...original, operationId: uuidv7(), revisionId: uuidv7() },
      options
    )
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  const bytes = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(original.recordBytes).toString('utf8')),
      unresolved: ['changed original'],
    })
  );
  await expect(
    publishProjectSourcePlanLocator(handle, { ...original, recordBytes: bytes }, options)
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rows(handle)).toEqual(before);
});
it('refuses missing original receipt-owned rows before authored preparation or repair', async () => {
  const { db, handle } = await fixture();
  const original = input();
  await publishProjectSourcePlanRecord(handle, original, options);
  const trigger = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name='source_plan_records_no_delete'")
    .get() as { sql: string };
  db.pragma('foreign_keys=OFF');
  db.exec('DROP TRIGGER source_plan_records_no_delete');
  db.prepare('DELETE FROM source_plan_records WHERE record_id=?').run(original.recordId);
  db.exec(trigger.sql);
  db.pragma('foreign_keys=ON');
  const before = rows(handle);
  const prepare = vi.spyOn(inputs, 'prepareSourcePlanRecord');
  await expect(publishProjectSourcePlanRecord(handle, original, options)).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(rows(handle)).toEqual(before);
});
function loseSourcePlanRows(db: Database.Database, tables: string[]) {
  const triggers = (
    db.prepare("SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger'").all() as {
      name: string;
      tbl_name: string;
      sql: string;
    }[]
  ).filter((trigger) => tables.includes(trigger.tbl_name));
  db.pragma('foreign_keys=OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
    for (const table of tables) db.exec(`DELETE FROM ${table}`);
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec('COMMIT');
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  } finally {
    db.pragma('foreign_keys=ON');
  }
}
it.each(['record', 'locator'] as const)(
  'refuses new %s namespace insertion while an original namespace owner is missing',
  async (kind) => {
    const { db, handle } = await fixture();
    const original = input();
    await publishProjectSourcePlanRecord(handle, original, options);
    loseSourcePlanRows(db, ['source_plan_namespaces']);
    const before = rows(handle);
    const newNamespace = { ...original.namespace, namespaceId: uuidv7() };
    const attempt =
      kind === 'record'
        ? publishProjectSourcePlanRecord(
            handle,
            { ...changed(original, { external_id: 'new:plan' }), namespace: newNamespace },
            options
          )
        : publishProjectSourcePlanLocator(
            handle,
            { ...locator(original, 'upload'), namespace: newNamespace },
            options
          );
    await expect(attempt).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    expect(rows(handle)).toEqual(before);
  }
);
it.each(['record', 'locator'] as const)(
  'rechecks %s receipt ownership after waiting for writer admission',
  async (kind) => {
    const { db, handle, authority } = await fixture();
    const other = await openProjectDatabase({ authority, mode: 'writer' });
    handles.push(other);
    const original = input();
    if (kind === 'locator') await publishProjectSourcePlanRecord(other, original, options);
    const location = locator(original, 'upload');
    db.exec('BEGIN IMMEDIATE');
    let injected: Promise<void> | undefined;
    let before: ReturnType<typeof rows> | undefined;
    const onWait = () => {
      if (injected) return;
      db.exec('ROLLBACK');
      const winner =
        kind === 'record'
          ? publishProjectSourcePlanRecord(other, original, options)
          : publishProjectSourcePlanLocator(other, location, options);
      injected = winner.then(() => {
        loseSourcePlanRows(
          db,
          kind === 'record'
            ? ['source_plan_approved', 'source_plan_records']
            : ['source_plan_locator_current', 'source_plan_locator_revisions']
        );
        before = rows(other);
      });
    };
    const attempt =
      kind === 'record'
        ? publishProjectSourcePlanRecord(
            handle,
            { ...original, operationId: uuidv7(), recordId: uuidv7() },
            { ...options, onWait }
          )
        : publishProjectSourcePlanLocator(
            handle,
            { ...location, operationId: uuidv7(), revisionId: uuidv7() },
            { ...options, onWait }
          );
    await expect(attempt).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
    await injected;
    expect(before).toBeDefined();
    expect(rows(handle)).toEqual(before);
  }
);

it('refuses a path whose selected approval receipt names another record', async () => {
  const { handle, db } = await fixture();
  const original = input();
  await publishProjectSourcePlanRecord(handle, original, options);
  const pin = locator(original);
  await publishProjectSourcePlanLocator(handle, pin, options);
  const key = {
    namespaceId: original.namespace.namespaceId,
    kind: 'path' as const,
    realPath: pin.realPath,
  };
  expect(readProjectSourcePlanLocator(handle, key)?.record.approvedRecordId).toBe(
    original.recordId
  );
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='operations'")
    .all() as { name: string; sql: string }[];
  const row = db
    .prepare('SELECT result_json FROM operations WHERE operation_id=?')
    .get(original.operationId) as { result_json: string };
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  const result = JSON.parse(row.result_json);
  result.selection.recordId = uuidv7();
  db.prepare('UPDATE operations SET result_json=? WHERE operation_id=?').run(
    JSON.stringify(result),
    original.operationId
  );
  for (const trigger of triggers) db.exec(trigger.sql);
  const before = rows(handle);
  expect(() => readProjectSourcePlanLocator(handle, key)).toThrowError(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(rows(handle)).toEqual(before);
});
