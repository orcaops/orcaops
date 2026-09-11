import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import type { SourcePlanLocatorInput, SourcePlanRecordInput } from './source-plan-input.js';
import { readProjectSourcePlanNamespace } from './source-plan-namespace.js';
import {
  publishProjectSourcePlanLocator,
  publishProjectSourcePlanRecord,
} from './source-plan-publication.js';
import {
  readProjectApprovedSourcePlan,
  readProjectSourcePlanLocator,
  readProjectSourcePlanReview,
} from './source-plan-reader.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';

const roots: string[] = [],
  handles: ProjectDatabase[] = [],
  databases: Database.Database[] = [];
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close());
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'source-plan-absence-')),
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
    orgId: 'original organization',
    accountId: 'original account',
  };
  const namespace = {
    ...scope,
    namespaceId: uuidv7(),
    scopeKind: 'account' as const,
    originalNamespaceHash: null,
    originalLocatorHash: null,
  };
  return { handle, db, namespace, scope };
}
function record(
  namespace: SourcePlanRecordInput['namespace'],
  kind: SourcePlanRecordInput['kind']
): SourcePlanRecordInput {
  const body = 'Original source plan';
  const common = {
    schema_version: 1,
    external_id: 'original:plan',
    body,
    content_hash: digest(body),
    base_url: namespace.serverUrl,
    org_id: namespace.orgId,
    pulled_at: 'original time',
  };
  const value =
    kind === 'approved'
      ? { ...common, slug: 'original', version_number: 1, title: 'Original plan', source_ref: null }
      : {
          ...common,
          target: kind,
          version_id: kind === 'candidate' ? 'original:version' : null,
          version_number: kind === 'candidate' ? 2 : null,
          proposal_id: kind === 'proposal' ? 'original:proposal' : null,
          base_version_number: null,
        };
  return {
    operationId: uuidv7(),
    recordId: uuidv7(),
    namespace,
    kind,
    expectedSelection: null,
    recordBytes: Buffer.from(JSON.stringify(value)),
  };
}
function remove(db: Database.Database, tables: string[]) {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as {
    name: string;
    sql: string;
  }[];
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
function refusesWithoutWrites(db: Database.Database, read: () => unknown) {
  const before = db.serialize();
  let error: unknown;
  try {
    read();
  } catch (cause) {
    error = cause;
  }
  expect(db.serialize().equals(before)).toBe(true);
  expect(error).toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
}
it.each(['approved', 'candidate', 'proposal'] as const)(
  'refuses missing %s rows still owned by an original publication receipt',
  async (kind) => {
    const { handle, db, namespace } = await fixture();
    const input = record(namespace, kind);
    await publishProjectSourcePlanRecord(handle, input, { secretAllow: [] });
    const read = (other = false) =>
      kind === 'approved'
        ? readProjectApprovedSourcePlan(handle, {
            namespaceId: namespace.namespaceId,
            externalId: other ? 'unseen' : 'original:plan',
            approvedVersion: 1,
          })
        : readProjectSourcePlanReview(handle, {
            namespaceId: namespace.namespaceId,
            kind,
            subjectId: other
              ? 'unseen'
              : kind === 'proposal'
                ? 'original:proposal'
                : 'original:plan',
          });
    expect(read()?.record.recordId).toBe(input.recordId);
    expect(read(true)).toBeNull();
    const receipt = db
      .prepare('SELECT * FROM operations WHERE operation_id=?')
      .get(input.operationId);
    remove(db, [
      kind === 'approved' ? 'source_plan_approved' : 'source_plan_review_current',
      'source_plan_records',
    ]);
    expect(
      db.prepare('SELECT * FROM operations WHERE operation_id=?').get(input.operationId)
    ).toEqual(receipt);
    expect(read(true)).toBeNull();
    refusesWithoutWrites(db, () => read());
  }
);
it.each(['path', 'upload'] as const)(
  'refuses missing %s locator rows still owned by an original publication receipt',
  async (kind) => {
    const { handle, db, namespace } = await fixture();
    const approved = record(namespace, 'approved');
    await publishProjectSourcePlanRecord(handle, approved, { secretAllow: [] });
    const value =
      kind === 'path'
        ? { real_path: '/original/plan.md', external_id: 'original:plan', version_number: 1 }
        : {
            fingerprint: 'a'.repeat(64),
            external_id: 'original:plan',
            unresolved: ['Original author'],
          };
    const input: SourcePlanLocatorInput = {
      operationId: uuidv7(),
      revisionId: uuidv7(),
      namespace,
      kind,
      realPath: '/original/plan.md',
      approvedRecordId: kind === 'path' ? approved.recordId : null,
      expectedSelection: null,
      recordBytes: Buffer.from(JSON.stringify(value)),
    };
    await publishProjectSourcePlanLocator(handle, input, { secretAllow: [] });
    const read = (other = false) =>
      readProjectSourcePlanLocator(handle, {
        namespaceId: namespace.namespaceId,
        kind,
        realPath: other ? '/unseen/plan.md' : input.realPath,
      });
    expect(read()?.record.revisionId).toBe(input.revisionId);
    expect(read(true)).toBeNull();
    const receipt = db
      .prepare('SELECT * FROM operations WHERE operation_id=?')
      .get(input.operationId);
    remove(db, ['source_plan_locator_current', 'source_plan_locator_revisions']);
    expect(
      db.prepare('SELECT * FROM operations WHERE operation_id=?').get(input.operationId)
    ).toEqual(receipt);
    expect(read(true)).toBeNull();
    refusesWithoutWrites(db, () => read());
  }
);
it.each(['children', 'receipt'] as const)(
  'refuses an absent namespace header with surviving %s ownership',
  async (survivor) => {
    const { handle, db, namespace, scope } = await fixture();
    const input = record(namespace, 'approved');
    await publishProjectSourcePlanRecord(handle, input, { secretAllow: [] });
    expect(readProjectSourcePlanNamespace(handle, scope)).toEqual(namespace);
    expect(
      readProjectSourcePlanNamespace(handle, { ...scope, accountId: 'unseen account' })
    ).toBeNull();
    const receipt = db
      .prepare('SELECT * FROM operations WHERE operation_id=?')
      .get(input.operationId);
    remove(
      db,
      survivor === 'children'
        ? ['source_plan_namespaces']
        : ['source_plan_approved', 'source_plan_records', 'source_plan_namespaces']
    );
    expect(
      db.prepare('SELECT * FROM operations WHERE operation_id=?').get(input.operationId)
    ).toEqual(receipt);
    refusesWithoutWrites(db, () => readProjectSourcePlanNamespace(handle, scope));
  }
);
it('keeps genuinely unused Source Plan identities absent without writes', async () => {
  const { handle, db, namespace, scope } = await fixture();
  const before = db.serialize();
  expect(readProjectSourcePlanNamespace(handle, scope)).toBeNull();
  expect(
    readProjectApprovedSourcePlan(handle, {
      namespaceId: namespace.namespaceId,
      externalId: 'unseen',
      approvedVersion: 1,
    })
  ).toBeNull();
  expect(
    readProjectSourcePlanReview(handle, {
      namespaceId: namespace.namespaceId,
      kind: 'candidate',
      subjectId: 'unseen',
    })
  ).toBeNull();
  expect(
    readProjectSourcePlanReview(handle, {
      namespaceId: namespace.namespaceId,
      kind: 'proposal',
      subjectId: 'unseen',
    })
  ).toBeNull();
  expect(
    readProjectSourcePlanLocator(handle, {
      namespaceId: namespace.namespaceId,
      kind: 'path',
      realPath: '/unseen',
    })
  ).toBeNull();
  expect(
    readProjectSourcePlanLocator(handle, {
      namespaceId: namespace.namespaceId,
      kind: 'upload',
      realPath: '/unseen',
    })
  ).toBeNull();
  expect(db.serialize().equals(before)).toBe(true);
});
