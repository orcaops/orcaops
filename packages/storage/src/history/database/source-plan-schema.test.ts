import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import {
  prepareSourcePlanLocator,
  prepareSourcePlanNamespace,
  prepareSourcePlanRecord,
  sourcePlanLocator,
  type SourcePlanNamespace,
  sourcePlanRecord,
} from './source-plan-input.js';
import { PROJECT_SOURCE_PLAN_SCHEMA } from './source-plan-schema.js';
import { PROJECT_SOURCE_PLAN_UPLOAD_SCHEMA } from './source-plan-upload-schema.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
function database() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(
    PROJECT_DATABASE_SCHEMA.replace(PROJECT_SOURCE_PLAN_SCHEMA, '').replace(
      PROJECT_SOURCE_PLAN_UPLOAD_SCHEMA,
      ''
    )
  );
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = OFF');
  db.exec(PROJECT_SOURCE_PLAN_SCHEMA);
  return db;
}
function put(db: Database.Database, table: string, row: Record<string, unknown>) {
  return db
    .prepare(
      `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
        .map(() => '?')
        .join(',')})`
    )
    .run(...Object.values(row));
}
function namespace(db: Database.Database, accountId = 'original account') {
  const value = prepareSourcePlanNamespace(
    {
      namespaceId: uuidv7(),
      scopeKind: 'account',
      serverUrl: 'https://example.test',
      orgId: 'original org',
      accountId,
      originalNamespaceHash: null,
      originalLocatorHash: null,
    },
    []
  );
  put(db, 'source_plan_namespaces', {
    namespace_id: value.namespaceId,
    scope_kind: value.scopeKind,
    server_url: value.serverUrl,
    org_id: value.orgId,
    account_id: value.accountId,
    original_namespace_hash: value.originalNamespaceHash,
    original_locator_hash: value.originalLocatorHash,
  });
  return value;
}
function operation(db: Database.Database) {
  const id = uuidv7();
  db.prepare(
    "INSERT INTO operations VALUES (?, 'source-plan.fixture', 0, '{}', '{}', ?, 'null', '{}', 1, 0)"
  ).run(id, 'a'.repeat(64));
  return id;
}
function record(
  db: Database.Database,
  kind: 'approved' | 'candidate' | 'proposal' = 'approved',
  ns = namespace(db),
  externalId = 'original:plan'
) {
  const body = 'Original Source Plan body\n';
  const common = {
    schema_version: 1,
    external_id: externalId,
    body,
    content_hash: digest(body),
    base_url: ns.serverUrl,
    org_id: ns.orgId,
    pulled_at: 'original time',
  };
  const value =
    kind === 'approved'
      ? { ...common, slug: 'original', version_number: 3, title: 'Original plan', source_ref: null }
      : {
          ...common,
          target: kind,
          version_id: kind === 'candidate' ? 'opaque:revision' : null,
          version_number: kind === 'candidate' ? 4 : null,
          proposal_id: kind === 'proposal' ? 'opaque:proposal' : null,
          base_version_number: null,
        };
  const prepared = prepareSourcePlanRecord(
    {
      operationId: operation(db),
      recordId: uuidv7(),
      namespace: ns,
      kind,
      expectedSelection: null,
      recordBytes: Buffer.from(JSON.stringify(value, null, 2)),
    },
    []
  );
  const r = sourcePlanRecord(prepared);
  const row = {
    record_id: r.recordId,
    namespace_id: r.namespace.namespaceId,
    kind: r.kind,
    original_record_id: null,
    record_bytes: Buffer.from(r.recordBase64, 'base64'),
    publication_operation_id: r.operationId,
    import_provenance_id: null,
    record_sha256: r.recordSha256,
    external_id: r.externalId,
    approved_version: r.approvedVersion,
    version_id: r.versionId,
    version_number: r.versionNumber,
    proposal_id: r.proposalId,
    base_version_number: r.baseVersionNumber,
    content_hash: r.contentHash,
    pulled_at: r.pulledAt,
  };
  put(db, 'source_plan_records', row);
  return { row, namespace: ns, prepared };
}
function approved(db: Database.Database, ns?: SourcePlanNamespace) {
  const result = record(db, 'approved', ns);
  const { row } = result;
  put(db, 'source_plan_approved', {
    namespace_id: row.namespace_id,
    external_id: row.external_id,
    approved_version: row.approved_version,
    record_id: row.record_id,
  });
  return result;
}
function review(db: Database.Database, kind: 'candidate' | 'proposal' = 'candidate') {
  const result = record(db, kind);
  const row = {
    namespace_id: result.row.namespace_id,
    kind,
    subject_id: kind === 'candidate' ? result.row.external_id : result.row.proposal_id,
    record_id: result.row.record_id,
    version: 1,
  };
  put(db, 'source_plan_review_current', row);
  return { ...result, selection: row };
}
function locator(
  db: Database.Database,
  kind: 'path' | 'upload' = 'path',
  selected = true,
  source = approved(db)
) {
  const value =
    kind === 'path'
      ? { real_path: '/original/plan.md', external_id: source.row.external_id, version_number: 3 }
      : {
          fingerprint: 'b'.repeat(64),
          external_id: source.row.external_id,
          unresolved: ['Ada', 'Zed'],
        };
  const prepared = prepareSourcePlanLocator(
    {
      operationId: operation(db),
      revisionId: uuidv7(),
      namespace: source.namespace,
      kind,
      realPath: '/original/plan.md',
      approvedRecordId: kind === 'path' ? source.row.record_id : null,
      expectedSelection: null,
      recordBytes: Buffer.from(JSON.stringify(value, null, 2)),
    },
    []
  );
  const r = sourcePlanLocator(prepared);
  const row = {
    revision_id: r.revisionId,
    namespace_id: r.namespace.namespaceId,
    kind: r.kind,
    record_bytes: Buffer.from(r.recordBase64, 'base64'),
    original_record_id: null,
    publication_operation_id: r.operationId,
    import_provenance_id: null,
    approved_record_id: r.approvedRecordId,
    record_sha256: r.recordSha256,
    real_path: r.realPath,
    path_hash: r.pathHash,
    original_locator_hash: null,
    external_id: r.externalId,
    approved_version: r.approvedVersion,
    fingerprint: r.fingerprint,
  };
  put(db, 'source_plan_locator_revisions', row);
  const current = {
    namespace_id: row.namespace_id,
    kind,
    locator_kind: 'real_path',
    locator: r.realPath,
    revision_id: r.revisionId,
    version: 1,
  };
  if (selected) put(db, 'source_plan_locator_current', current);
  return { row, selection: current, source };
}
function unchangedFailure(db: Database.Database, run: () => void) {
  const before = db.serialize();
  db.exec('BEGIN IMMEDIATE');
  try {
    expect(() => {
      run();
      db.exec('COMMIT');
    }).toThrow();
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
  }
  expect(db.serialize().equals(before)).toBe(true);
}
it('installs only standalone tables and leaves the declared schema version unchanged', () => {
  const db = database();
  expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'source_plan_%' ORDER BY name"
      )
      .all()
  ).toEqual([
    { name: 'source_plan_approved' },
    { name: 'source_plan_locator_current' },
    { name: 'source_plan_locator_revisions' },
    { name: 'source_plan_namespaces' },
    { name: 'source_plan_records' },
    { name: 'source_plan_review_current' },
  ]);
  approved(db);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('keeps unknown organization and upload namespaces separate from live accounts', () => {
  const db = database(),
    known = namespace(db),
    other = namespace(db, 'another account');
  const historical = {
    namespace_id: uuidv7(),
    scope_kind: 'organization_observation',
    server_url: known.serverUrl,
    org_id: known.orgId,
    account_id: null,
    original_namespace_hash: digest(`${known.serverUrl}|${known.orgId}`),
    original_locator_hash: null,
  };
  put(db, 'source_plan_namespaces', historical);
  for (const hash of ['a', 'b'])
    put(db, 'source_plan_namespaces', {
      namespace_id: uuidv7(),
      scope_kind: 'unresolved_upload',
      server_url: null,
      org_id: null,
      account_id: null,
      original_namespace_hash: null,
      original_locator_hash: hash.repeat(64),
    });
  expect(db.prepare('SELECT count(*) AS n FROM source_plan_namespaces').get()).toEqual({ n: 5 });
  const original = record(db, 'approved', other);
  unchangedFailure(db, () => {
    put(db, 'source_plan_records', {
      ...original.row,
      record_id: uuidv7(),
      namespace_id: historical.namespace_id,
    });
  });
  unchangedFailure(db, () => {
    put(db, 'source_plan_namespaces', {
      ...historical,
      namespace_id: uuidv7(),
      account_id: 'inferred',
    });
  });
});
it.each([
  'source_plan_namespaces',
  'source_plan_records',
  'source_plan_approved',
  'source_plan_locator_revisions',
])('protects immutable %s with recursive triggers off', (table) => {
  const db = database();
  locator(db);
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  const row = { ...(rows[0] as Record<string, unknown>) };
  expect(() =>
    db
      .prepare(
        `INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
          .map(() => '?')
          .join(',')})`
      )
      .run(...Object.values(row))
  ).toThrow('immutable');
  expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('retained');
  const key = Object.keys(row)[0]!;
  expect(() => db.exec(`UPDATE ${table} SET ${key}=${key}`)).toThrow('immutable');
  expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
});
it('refuses conflicting approved selection through a new record ID', () => {
  const db = database(),
    a = approved(db),
    b = record(db, 'approved', a.namespace);
  expect(() =>
    put(db, 'source_plan_approved', {
      namespace_id: b.row.namespace_id,
      external_id: b.row.external_id,
      approved_version: b.row.approved_version,
      record_id: b.row.record_id,
    })
  ).toThrow('immutable');
  expect(db.prepare('SELECT record_id FROM source_plan_approved').get()).toEqual({
    record_id: a.row.record_id,
  });
});
it.each(['namespace', 'kind', 'external', 'version'])(
  'binds approved selection to exact %s ownership',
  (change) => {
    const db = database(),
      a = record(db);
    const row = {
      namespace_id: a.row.namespace_id,
      external_id: a.row.external_id,
      approved_version: 3,
      record_id: a.row.record_id,
    };
    if (change === 'namespace') row.namespace_id = namespace(db, 'different').namespaceId;
    if (change === 'kind') row.record_id = record(db, 'candidate', a.namespace).row.record_id;
    if (change === 'external') row.external_id = 'another plan';
    if (change === 'version') row.approved_version = 4;
    unchangedFailure(db, () => {
      put(db, 'source_plan_approved', row);
    });
  }
);
it.each(['candidate', 'proposal'] as const)(
  'requires original %s subject and exact next selector version',
  (kind) => {
    const db = database(),
      a = review(db, kind),
      b = record(db, kind, a.namespace);
    unchangedFailure(db, () => {
      db.prepare('UPDATE source_plan_review_current SET record_id=?,version=3').run(
        b.row.record_id
      );
    });
    unchangedFailure(db, () => {
      db.prepare('UPDATE source_plan_review_current SET record_id=?,version=2,subject_id=?').run(
        b.row.record_id,
        'retargeted'
      );
    });
    const update = db.prepare(
      'UPDATE source_plan_review_current SET record_id=?,version=version+1 WHERE record_id=? AND version=?'
    );
    expect(update.run(b.row.record_id, a.row.record_id, 1).changes).toBe(1);
    expect(update.run(a.row.record_id, a.row.record_id, 1).changes).toBe(0);
    expect(db.prepare('SELECT record_id,version FROM source_plan_review_current').get()).toEqual({
      record_id: b.row.record_id,
      version: 2,
    });
    expect(() => put(db, 'source_plan_review_current', a.selection)).toThrow();
    expect(() => db.exec('DELETE FROM source_plan_review_current')).toThrow('retained');
  }
);
it('refuses a proposal revision that changes its source plan while keeping the proposal ID', () => {
  const db = database(),
    a = review(db, 'proposal'),
    other = record(db, 'proposal', a.namespace, 'different plan');
  unchangedFailure(db, () => {
    db.prepare('UPDATE source_plan_review_current SET record_id=?,version=2').run(
      other.row.record_id
    );
  });
});
it.each(['path', 'upload'] as const)(
  'requires exact %s locator membership and CAS progression',
  (kind) => {
    const db = database(),
      a = locator(db, kind),
      b = locator(db, kind, false, a.source);
    unchangedFailure(db, () => {
      db.prepare('UPDATE source_plan_locator_current SET revision_id=?,version=2,locator=?').run(
        b.row.revision_id,
        '/retargeted'
      );
    });
    const update = db.prepare(
      'UPDATE source_plan_locator_current SET revision_id=?,version=version+1 WHERE revision_id=? AND version=?'
    );
    expect(update.run(b.row.revision_id, a.row.revision_id, 1).changes).toBe(1);
    expect(update.run(a.row.revision_id, a.row.revision_id, 1).changes).toBe(0);
    expect(() => put(db, 'source_plan_locator_current', a.selection)).toThrow();
    expect(() => db.exec('DELETE FROM source_plan_locator_current')).toThrow('retained');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  }
);
it.each(['namespace', 'external', 'approved', 'version'])(
  'refuses a path bound to different %s approval evidence at commit',
  (change) => {
    const db = database(),
      a = locator(db),
      row = { ...a.row, revision_id: uuidv7() };
    if (change === 'namespace') row.namespace_id = namespace(db, 'other').namespaceId;
    if (change === 'external') row.external_id = 'other';
    if (change === 'approved')
      row.approved_record_id = record(db, 'approved', a.source.namespace).row.record_id;
    if (change === 'version') row.approved_version = 2;
    unchangedFailure(db, () => {
      put(db, 'source_plan_locator_revisions', row);
    });
  }
);
it.each(['record', 'locator'] as const)(
  'refuses ownerless or imported %s rows before a provenance owner exists',
  (kind) => {
    const db = database(),
      a = kind === 'record' ? record(db).row : locator(db).row;
    const key = kind === 'record' ? 'record_id' : 'revision_id';
    const table = kind === 'record' ? 'source_plan_records' : 'source_plan_locator_revisions';
    for (const patch of [
      { publication_operation_id: null },
      { publication_operation_id: uuidv7() },
      { import_provenance_id: uuidv7() },
      { original_record_id: 'a'.repeat(64) },
    ]) {
      unchangedFailure(db, () => {
        put(db, table, { ...a, [key]: uuidv7(), ...patch });
      });
    }
  }
);
it('refuses cross-family revision identity reuse', () => {
  const db = database(),
    a = locator(db),
    b = record(db, 'candidate', a.source.namespace);
  expect(() => put(db, 'source_plan_records', { ...b.row, record_id: a.row.revision_id })).toThrow(
    'cannot change families'
  );
  expect(() =>
    put(db, 'source_plan_locator_revisions', { ...a.row, revision_id: b.row.record_id })
  ).toThrow('cannot change families');
});
it('retains exact prepared record and locator bytes without SQL regeneration', () => {
  const db = database(),
    a = locator(db);
  expect(db.prepare('SELECT record_bytes FROM source_plan_locator_revisions').get()).toEqual({
    record_bytes: a.row.record_bytes,
  });
  expect(db.prepare('SELECT record_bytes FROM source_plan_records').get()).toEqual({
    record_bytes: a.source.row.record_bytes,
  });
});
