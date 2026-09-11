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
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import * as inputs from './source-plan-input.js';
import { readProjectSourcePlanNamespace } from './source-plan-namespace.js';
import { publishProjectSourcePlanRecord } from './source-plan-publication.js';

const roots: string[] = [],
  handles: ProjectDatabase[] = [],
  databases: Database.Database[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  handles.splice(0).forEach((h) => h.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'source-plan-namespace-')),
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
  const scope = {
    serverUrl: 'https://example.test',
    orgId: 'organization',
    accountId: 'original account',
  };
  const namespace = {
    ...scope,
    namespaceId: uuidv7(),
    scopeKind: 'account' as const,
    originalNamespaceHash: null,
    originalLocatorHash: null,
  };
  const body = 'Original Source Plan body';
  const payload = {
    schema_version: 1,
    external_id: 'original:plan',
    slug: 'original',
    version_number: 1,
    title: 'Original plan',
    body,
    content_hash: digest(body),
    source_ref: null,
    base_url: scope.serverUrl,
    org_id: scope.orgId,
    pulled_at: 'original time',
  };
  await publishProjectSourcePlanRecord(
    handle,
    {
      operationId: uuidv7(),
      recordId: uuidv7(),
      namespace,
      kind: 'approved',
      expectedSelection: null,
      recordBytes: Buffer.from(JSON.stringify(payload)),
    },
    { secretAllow: [] }
  );
  return { handle, db, namespace, scope };
}
it('resolves the original exact account namespace through its unique index without writes', async () => {
  const { handle, db, namespace, scope } = await fixture();
  const before = db.serialize();
  const original = inputs.decodeRetainedSourcePlanNamespace;
  vi.spyOn(inputs, 'decodeRetainedSourcePlanNamespace').mockImplementation((value) => {
    expect(handle.read(() => null).value).toBeNull();
    return original(value);
  });
  expect(readProjectSourcePlanNamespace(handle, scope)).toEqual(namespace);
  expect(
    readProjectSourcePlanNamespace(handle, { ...scope, serverUrl: scope.serverUrl + '/' })
  ).toEqual(namespace);
  expect(db.serialize().equals(before)).toBe(true);
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT namespace_id FROM source_plan_namespaces WHERE scope_kind='account' AND server_url=? AND org_id=? AND account_id=?"
    )
    .all(scope.serverUrl, scope.orgId, scope.accountId) as { detail: string }[];
  expect(plan.some((row) => row.detail.includes('source_plan_account_namespace'))).toBe(true);
});
it('keeps a healthy original namespace readable when another account header is missing', async () => {
  const { handle, db, namespace, scope } = await fixture();
  const other = { ...namespace, namespaceId: uuidv7(), accountId: 'another original account' };
  const row = db.prepare('SELECT record_bytes FROM source_plan_records LIMIT 1').get() as {
    record_bytes: Buffer;
  };
  await publishProjectSourcePlanRecord(
    handle,
    {
      operationId: uuidv7(),
      recordId: uuidv7(),
      namespace: other,
      kind: 'approved',
      expectedSelection: null,
      recordBytes: row.record_bytes,
    },
    { secretAllow: [] }
  );
  const trigger = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name='source_plan_namespaces_no_delete'")
    .get() as { sql: string };
  db.pragma('foreign_keys=OFF');
  db.exec('DROP TRIGGER source_plan_namespaces_no_delete');
  db.prepare('DELETE FROM source_plan_namespaces WHERE namespace_id=?').run(namespace.namespaceId);
  db.exec(trigger.sql);
  db.pragma('foreign_keys=ON');
  const before = db.serialize();
  expect(readProjectSourcePlanNamespace(handle, { ...scope, accountId: other.accountId })).toEqual(
    other
  );
  expect(() => readProjectSourcePlanNamespace(handle, scope)).toThrowError(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(() =>
    readProjectSourcePlanNamespace(handle, { ...scope, accountId: 'unassigned account' })
  ).toThrowError(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
  expect(db.serialize().equals(before)).toBe(true);
});
it.each(['serverUrl', 'orgId', 'accountId'] as const)(
  'keeps a different %s absent instead of reusing authority',
  async (field) => {
    const { handle, db, scope } = await fixture();
    const before = db.serialize();
    expect(
      readProjectSourcePlanNamespace(handle, {
        ...scope,
        [field]: field === 'serverUrl' ? 'https://other.test' : 'other',
      })
    ).toBeNull();
    expect(db.serialize().equals(before)).toBe(true);
  }
);
it('does not adopt an organization-only historical observation', async () => {
  const { handle, db } = await fixture();
  const server = 'https://historical.test',
    org = 'historical org';
  db.prepare(
    "INSERT INTO source_plan_namespaces VALUES (?,'organization_observation',?,?,NULL,?,NULL)"
  ).run(uuidv7(), server, org, digest(server + '|' + org));
  const before = db.serialize();
  expect(
    readProjectSourcePlanNamespace(handle, {
      serverUrl: server,
      orgId: org,
      accountId: 'current account',
    })
  ).toBeNull();
  expect(db.serialize().equals(before)).toBe(true);
});
it('refuses forged handles before any supplied read method', () => {
  const read = vi.fn();
  expect(() =>
    readProjectSourcePlanNamespace({ read } as unknown as ProjectDatabase, {
      serverUrl: 'https://example.test',
      orgId: 'org',
      accountId: 'account',
    })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(read).not.toHaveBeenCalled();
});
it.each([
  'file:///original',
  'https://example.test?secret=value',
  'https://example.test#fragment',
  'not a server',
])('refuses invalid server identity %s', async (serverUrl) => {
  const { handle } = await fixture();
  expect(() =>
    readProjectSourcePlanNamespace(handle, { serverUrl, orgId: 'org', accountId: 'account' })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
